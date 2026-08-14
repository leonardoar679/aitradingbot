import { useEffect, useState } from 'react'
import type { Candle, Exchange } from '../../shared/ipc'
import { runBacktest, type BacktestResult, type Trade } from '../backtest/engine'

// The dry-run polls the same 4h interval every backtest strategy is validated on, so its
// signals always match what was actually backtested for the bot's chosen strategy.
const DRY_RUN_INTERVAL_SEC = 4 * 60 * 60
const LOOKBACK_CANDLES = 600
// Extra candles fetched before enabledAt so EMA(200)/ATR(14) are warmed up by the time the
// bot's own paper-trading window starts, rather than right at its first visible candle.
const WARMUP_CANDLES = 220
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
  const defaultStartSec = endSec - LOOKBACK_CANDLES * DRY_RUN_INTERVAL_SEC
  const startSec =
    bot.enabledAt !== null
      ? Math.min(defaultStartSec, bot.enabledAt - WARMUP_CANDLES * DRY_RUN_INTERVAL_SEC)
      : defaultStartSec
  const { candles } = await window.api.market.fetchHistoricalRange(bot.exchange, bot.symbol, '4h', startSec, endSec)
  if (candles.length === 0) return null
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
