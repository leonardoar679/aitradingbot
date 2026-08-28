import { useEffect, useState } from 'react'
import { INTERVAL_SECONDS, type Candle, type Exchange, type Interval } from '../../shared/ipc'
import { runBacktest, type BacktestResult, type Trade, type OpenPositionSnapshot } from '../backtest/engine'
import { getStrategy } from '../backtest/strategies'

// The dry run polls the interval the bot's OWN strategy was measured on, which is the only way
// its signals can match what was actually backtested for it.
//
// This used to be a hardcoded 4h for every strategy, justified as "the same 4h interval every
// backtest strategy is validated on". That was not true even when it was written -- the Backtest
// page opened on 15m -- so a bot created from a 15m backtest was paper-traded on 4h candles, and
// the run that justified the bot was a run of a different thing. It is measurably the wrong bar
// for both trend strategies as well: on BTCUSDT 2021-2026, Trend Regime returns +408% at its 1h
// against +345% at 4h, and Short-Term Channel +130% at its 15m against +86% (research/ivfair.ts).
//
// EXISTING BOTS WILL MOVE. A bot on either trend strategy now polls a finer bar than it did, so
// its displayed paper P&L is recomputed against different candles and will not match what it
// showed before. That is the point -- the old number described a strategy nobody was running --
// but it is a visible change to a figure users have been watching, not a silent internal one.
function dryRunIntervalFor(strategyId: string): Interval {
  return getStrategy(strategyId).preferredInterval
}
const LOOKBACK_CANDLES = 600
// Extra candles fetched before enabledAt so the strategy's indicators are warmed up by the time
// the bot's own paper-trading window starts, rather than right at its first visible candle.
//
// Asked of the strategy rather than fixed at 220, which was really a claim that no strategy would
// ever need more. Trend Regime Ensemble needs 80 days -- 480 bars of 4h -- and under the old
// constant a bot running longer than about three months fetched from `enabledAt - 220 bars`,
// spent the first 43 days of its OWN life inside the strategy's warm-up, and silently dropped
// every trade it made in that period. Padded by a little, because a strategy that can only just
// warm up has no bars left to trade on.
const WARMUP_SLACK_CANDLES = 20

function warmupCandlesFor(strategyId: string): number {
  return getStrategy(strategyId).warmupBarsFor(INTERVAL_SECONDS[dryRunIntervalFor(strategyId)]) + WARMUP_SLACK_CANDLES
}
const POLL_MS = 60_000

export type DryRunStatus = 'loading' | 'running' | 'error'

export interface DryRunState {
  status: DryRunStatus
  error: string | null
  result: BacktestResult | null
  candles: Candle[]
  latestCandle: Candle | null
}

const IDLE_STATE: DryRunState = { status: 'loading', error: null, result: null, candles: [], latestCandle: null }

/** Imperative counterpart to the hook below, for call sites outside a component's render
 * lifecycle (e.g. the Portfolio page aggregating every enabled bot at once) — same fetch window
 * and warmup padding, just a one-shot call instead of a poll/subscribe cycle. Returns null if no
 * candles were returned (a brand-new symbol/range) rather than throwing, since "nothing to show
 * yet" isn't really an error. */
export async function fetchBotDryRunResult(bot: {
  exchange: Exchange
  symbol: string
  enabledAt: number | null
  strategyId: string
}): Promise<{ result: BacktestResult; candles: Candle[] } | null> {
  const endSec = Math.floor(Date.now() / 1000)
  const interval = dryRunIntervalFor(bot.strategyId)
  const barSec = INTERVAL_SECONDS[interval]
  const warmup = warmupCandlesFor(bot.strategyId)
  // The default lookback has to clear the warm-up too, or a freshly-enabled bot on a slow
  // strategy fetches a window that is entirely warm-up and can never show a trade.
  const defaultStartSec = endSec - Math.max(LOOKBACK_CANDLES, warmup + 120) * barSec
  const startSec =
    bot.enabledAt !== null
      ? Math.min(defaultStartSec, bot.enabledAt - warmup * barSec)
      : defaultStartSec
  const { candles } = await window.api.market.fetchHistoricalRange(bot.exchange, bot.symbol, interval, startSec, endSec)
  if (candles.length === 0) return null
  // Engine default, like RoutineScheduler and for the same reason: a dry run is re-computed on
  // every poll, and a bot's displayed P&L must not move because an unrelated strategy started or
  // stopped somewhere else in the app.
  return { result: runBacktest(candles, bot.strategyId, { forceCloseAtEnd: false }), candles }
}

/** Bots have no dollar allocation anywhere in this app — this is the only real per-bot
 * performance figure that exists, a compounded % across only the trades entered after the bot
 * was actually turned on (see the comment on DryRunPanel in BotCard.tsx for why the lookback's
 * own historical trades are excluded). Shared by BotCard's display and the Portfolio aggregator
 * so the two can never drift apart. */
export function summarizePaperTrades(
  trades: Trade[],
  enabledAt: number | null
): { paperTrades: Trade[]; paperWins: number; paperNetPct: number } {
  const paperTrades = enabledAt !== null ? trades.filter((t) => t.entryTime >= enabledAt) : []
  const paperWins = paperTrades.filter((t) => t.pnl > 0).length
  const paperNetPct =
    paperTrades.length > 0 ? (paperTrades.reduce((acc, t) => acc * (1 + t.returnPct / 100), 1) - 1) * 100 : 0
  return { paperTrades, paperWins, paperNetPct }
}

export type BotOpenPosition =
  | { kind: 'none' }
  | { kind: 'bot'; position: OpenPositionSnapshot }
  | { kind: 'preexisting'; position: OpenPositionSnapshot }

/** The open-position counterpart to summarizePaperTrades, and it exists for the same reason.
 *
 * The dry run replays the strategy over a lookback window that reaches back well before the bot
 * was enabled, so the replay can be holding a position the bot itself never entered. Closed trades
 * were already filtered by enabledAt; the open one was not, so a bot switched on today could
 * report "Long since Aug 18 (+19.63%)" for an entry three days older than the bot -- credited with
 * a gain it had no part in. Observed on a real run, which is what prompted this.
 *
 * A pre-existing position is still worth naming rather than hiding: the strategy really is in the
 * market, so the next thing that happens will be an exit rather than an entry, and that exit will
 * (correctly) not count as one of the bot's trades either. Callers show it, but never attribute
 * its entry price or P&L to the bot. */
export function classifyBotOpenPosition(
  openPosition: OpenPositionSnapshot | null,
  enabledAt: number | null
): BotOpenPosition {
  if (openPosition === null) return { kind: 'none' }
  if (enabledAt === null) return { kind: 'preexisting', position: openPosition }
  return openPosition.entryTime >= enabledAt
    ? { kind: 'bot', position: openPosition }
    : { kind: 'preexisting', position: openPosition }
}

// Polls the exchange every minute for the newest closed 4h candles (only while this component
// stays mounted — i.e. only while the app is open) and replays the full backtest engine over
// the fetched window each time. Re-running the whole engine rather than hand-rolling a
// stateful "step" keeps this 1:1 consistent with the validated backtest — no separate live
// logic to drift out of sync. forceCloseAtEnd is off so an open position is reported as-is
// instead of showing up as a synthetic closed trade.
//
// The fetch window always reaches back to enabledAt (plus warmup padding), not just a fixed
// default lookback — otherwise a bot left running longer than the default window would quietly
// drop its own older paper trades once they scrolled outside a fixed-size fetch.
export function useDryRun(
  exchange: Exchange,
  symbol: string,
  enabled: boolean,
  enabledAt: number | null,
  strategyId: string
): DryRunState {
  const [state, setState] = useState<DryRunState>(IDLE_STATE)

  useEffect(() => {
    if (!enabled) {
      setState(IDLE_STATE)
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll(): Promise<void> {
      try {
        const fetched = await fetchBotDryRunResult({ exchange, symbol, enabledAt, strategyId })
        if (cancelled) return
        if (fetched === null) {
          setState({ status: 'error', error: 'No candle data returned', result: null, candles: [], latestCandle: null })
        } else {
          const { result, candles } = fetched
          setState({ status: 'running', error: null, result, candles, latestCandle: candles[candles.length - 1] })
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          setState((prev) => ({ ...prev, status: 'error', error: message }))
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS)
      }
    }

    void poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [exchange, symbol, enabled, enabledAt, strategyId])

  return state
}
