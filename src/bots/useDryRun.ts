import { useEffect, useState } from 'react'
import { INTERVAL_SECONDS, type Candle, type Exchange, type Interval } from '../../shared/ipc'
import { runBacktest, type BacktestResult, type Trade, type OpenPositionSnapshot } from '../backtest/engine'
import { getStrategy } from '../backtest/strategies'
import { fetchRangeCached } from './candleCache'
import {
  confirmsEntries,
  costsMoneyToRun,
  gptCadenceOf,
  latestBotAiCall,
  type AiCallCount,
  type BotAiCall,
  type ConfirmBotEstimate
} from './types'
import { describeError } from '../utils/ipcError'
import { generateGptIntradaySignals } from '../backtest/strategies/gptIntraday'
import {
  confirmableSignals,
  confirmationCounts,
  entryConfirmRequest,
  openedAt,
  resolveConfirmedRun
} from '../backtest/aiConfirmation'
import { isBarSettled } from '../../shared/aiConfirm'
import type { AiRoute } from '../../shared/aiRoute'
import {
  GPT_INTRADAY_STRATEGY_ID,
  GPT_LOOKBACK_BARS,
  GPT_MAX_DECISIONS,
  type AiSignalEstimate,
  type AiSignalTapeRequest
} from '../../shared/aiSignal'

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

function warmupCandlesFor(bot: Pick<DryRunBot, 'strategyId' | 'aiConfirm'>): number {
  const own = getStrategy(bot.strategyId).warmupBarsFor(INTERVAL_SECONDS[dryRunIntervalFor(bot.strategyId)])
  // A reviewed entry needs the review's lookback behind it as well as the strategy's own (see
  // confirmableSignals), so a bot whose entries are reviewed reaches back by the longer of the two.
  return (confirmsEntries(bot) ? Math.max(own, GPT_LOOKBACK_BARS) : own) + WARMUP_SLACK_CANDLES
}
const POLL_MS = 60_000

export type DryRunStatus = 'loading' | 'running' | 'error' | 'idle'

export interface DryRunState {
  status: DryRunStatus
  error: string | null
  result: BacktestResult | null
  candles: Candle[]
  latestCandle: Candle | null
  /** What the last refresh cost in AI calls, or null for a strategy that never makes one. */
  aiCalls: AiCallCount | null
  /** A GPT Intraday bot's newest decision, or null for every other strategy and before it has
   * made one. Kept so a call to buy can be turned into an order form while its candle is open. */
  aiCall: BotAiCall | null
}

const LOADING_STATE: DryRunState = { status: 'loading', error: null, result: null, candles: [], latestCandle: null, aiCalls: null, aiCall: null }
/** Fetched nothing, and nothing is coming -- distinct from 'loading', which promises a result. */
const IDLE_STATE: DryRunState = { status: 'idle', error: null, result: null, candles: [], latestCandle: null, aiCalls: null, aiCall: null }

interface DryRunBot {
  exchange: Exchange
  symbol: string
  enabledAt: number | null
  strategyId: string
  /** The model a paid bot was enabled with. See Bot.aiModel. */
  aiModel?: string
  /** Whether a model reviews this bot's entries. See Bot.aiConfirm. */
  aiConfirm?: boolean
  /** How often a GPT Intraday bot asks its model. See Bot.aiEveryBars. */
  aiEveryBars?: number
  /** The second model a GPT Intraday bot was switched on with. See Bot.aiRoute. */
  aiRoute?: AiRoute
}

/** The stretch a GPT Intraday bot replays at once, in bars: the decision ceiling at its cadence.
 * Seven days when it is asked on every candle, 112 when it is asked every four hours. */
function gptSegmentBars(bot: Pick<DryRunBot, 'strategyId' | 'aiEveryBars'>): number {
  return GPT_MAX_DECISIONS * Math.max(1, gptCadenceOf(bot))
}

/** The candles a bot's dry run replays, and the bar size they are on.
 *
 * One function, because two callers must fetch the identical window: the dry run itself, and the
 * cost estimate shown before a paid bot is switched on. An estimate computed over a different
 * window would be an estimate of a different run. */
async function fetchBotCandles(bot: DryRunBot): Promise<{ candles: Candle[]; interval: Interval }> {
  const endSec = Math.floor(Date.now() / 1000)
  const interval = dryRunIntervalFor(bot.strategyId)
  const barSec = INTERVAL_SECONDS[interval]
  const warmup = warmupCandlesFor(bot)
  // The default lookback has to clear the warm-up too, or a freshly-enabled bot on a slow
  // strategy fetches a window that is entirely warm-up and can never show a trade.
  const defaultStartSec = endSec - Math.max(LOOKBACK_CANDLES, warmup + 120) * barSec
  const startSec =
    bot.strategyId === GPT_INTRADAY_STRATEGY_ID
      ? ((): number => {
          const enabled = bot.enabledAt ?? endSec
          const segmentSeconds = gptSegmentBars(bot) * barSec
          const segmentStart = enabled + Math.floor(Math.max(0, endSec - enabled) / segmentSeconds) * segmentSeconds
          return segmentStart - GPT_LOOKBACK_BARS * barSec
        })()
      : bot.enabledAt !== null
      ? Math.min(defaultStartSec, bot.enabledAt - warmup * barSec)
      : defaultStartSec
  // Cached: a poll re-fetches only the tail, not the whole 80-day warm-up window every minute.
  // See candleCache.ts -- the saving is roughly a hundredfold per bot, and several bots on the
  // same symbol and interval share one series.
  const candles = await fetchRangeCached(
    (ex, sym, iv, from, to) => window.api.market.fetchHistoricalRange(ex, sym, iv, from, to),
    bot.exchange,
    bot.symbol,
    interval,
    startSec,
    endSec
  )
  return { candles, interval }
}

function botTapeRequest(bot: DryRunBot, candles: Candle[], interval: Interval): AiSignalTapeRequest {
  return {
    requestId: crypto.randomUUID(),
    exchange: bot.exchange,
    symbol: bot.symbol,
    interval,
    candles,
    startIndex: Math.max(GPT_LOOKBACK_BARS, candles.length - gptSegmentBars(bot)),
    maxDecisions: GPT_MAX_DECISIONS,
    decideEveryBars: gptCadenceOf(bot),
    model: bot.aiModel,
    // The bot's own pin or nothing. Never the setting on the Models tab: that one is copied onto a
    // bot when it is switched on, after the confirmation has said so.
    route: bot.aiRoute ?? null,
    source: 'bot'
  }
}

/** What switching a paid bot on would ask of a model, and roughly what that costs. Spends
 * nothing: it fetches candles and reads the cache and a price list. Scored as though the bot were
 * enabled this instant, which is the run the confirmation is about. */
export async function estimatePaidBot(bot: Omit<DryRunBot, 'enabledAt'>): Promise<AiSignalEstimate | null> {
  const enabledNow = { ...bot, enabledAt: Math.floor(Date.now() / 1000) }
  const { candles, interval } = await fetchBotCandles(enabledNow)
  if (candles.length === 0) return null
  return window.api.ai.estimateSignalTape(botTapeRequest(enabledNow, candles, interval))
}

/** What switching on a bot with AI-confirmed entries would ask of a model. Spends nothing: it
 * fetches candles and reads the cache, the ledger and a price list.
 *
 * Priced from the newest closed candle, whether or not the strategy signalled on it. One review is
 * the same size as another, and a bot being switched on has no entry of its own to price yet. */
export async function estimateConfirmBot(bot: Omit<DryRunBot, 'enabledAt'>): Promise<ConfirmBotEstimate | null> {
  const nowSec = Math.floor(Date.now() / 1000)
  const { candles, interval } = await fetchBotCandles({ ...bot, enabledAt: nowSec })
  let newest = candles.length - 1
  while (newest >= 0 && !isBarSettled(candles[newest].time, interval, nowSec)) newest--
  if (newest < GPT_LOOKBACK_BARS - 1) return null

  const strategy = getStrategy(bot.strategyId)
  const signals = confirmableSignals(strategy, candles)
  const market = { exchange: bot.exchange, symbol: bot.symbol, interval, source: 'bot' as const }
  // Unpinned, like the GPT estimate: switching on re-pins to whatever the default is now.
  const quote = await window.api.ai.peekEntryConfirmation(entryConfirmRequest(market, strategy, candles, signals, newest))
  const replay = runBacktest(candles, bot.strategyId, { forceCloseAtEnd: false, signals })
  const indexByTime = new Map(candles.map((candle, index) => [candle.time, index]))
  const tradableBars = Math.max(0, candles.length - signals.warmupBars)
  return {
    quote,
    recentEntries: openedAt(replay, indexByTime).length,
    recentDays: Math.round((tradableBars * INTERVAL_SECONDS[interval]) / 86_400)
  }
}

/** Imperative counterpart to the hook below, for call sites outside a component's render
 * lifecycle (e.g. the Portfolio page aggregating every enabled bot at once) — same fetch window
 * and warmup padding, just a one-shot call instead of a poll/subscribe cycle. Returns null if no
 * candles were returned (a brand-new symbol/range) rather than throwing, since "nothing to show
 * yet" isn't really an error. */
export async function fetchBotDryRunResult(
  bot: DryRunBot
): Promise<{ result: BacktestResult; candles: Candle[]; aiCalls: AiCallCount | null; aiCall: BotAiCall | null } | null> {
  const { candles, interval } = await fetchBotCandles(bot)
  if (candles.length === 0) return null
  // Engine default, like RoutineScheduler and for the same reason: a dry run is re-computed on
  // every poll, and a bot's displayed P&L must not move because an unrelated strategy started or
  // stopped somewhere else in the app.
  if (bot.strategyId === GPT_INTRADAY_STRATEGY_ID) {
    const tape = await window.api.ai.generateSignalTape(botTapeRequest(bot, candles, interval))
    const signals = generateGptIntradaySignals(candles, tape)
    return {
      result: runBacktest(candles, bot.strategyId, { forceCloseAtEnd: false, signals }),
      candles,
      // The tape has always counted these and this function always dropped them on the floor.
      aiCalls: {
        total: tape.decisions.length,
        cached: tape.cachedCount,
        // Calls, not decisions: under a route one decision can be two of them.
        generated: tape.callCount,
        errors: tape.errorCount,
        ...(tape.route ? { escalated: tape.route.escalated } : {})
      },
      aiCall: latestBotAiCall(candles, tape.decisions, signals.entries, interval)
    }
  }
  // Only once the bot has been switched on. Before that there is no entry of the bot's own to
  // review -- every entry on the chart is the strategy's history -- so a stopped bot replays the
  // plain strategy and asks nothing. That is what keeps its chart free to open.
  if (confirmsEntries(bot) && bot.enabledAt !== null) {
    const run = await resolveConfirmedRun({
      candles,
      strategyId: bot.strategyId,
      exchange: bot.exchange,
      symbol: bot.symbol,
      interval,
      engine: { forceCloseAtEnd: false },
      confirmFromSec: bot.enabledAt,
      nowSec: Math.floor(Date.now() / 1000),
      model: bot.aiModel,
      source: 'bot',
      ask: (request) => window.api.ai.confirmEntry(request)
    })
    const counts = confirmationCounts(run.decisions.values())
    return {
      result: run.result,
      candles,
      aiCalls: {
        total: counts.reviewed,
        cached: counts.cached,
        generated: counts.generated,
        // An entry on a bar that has not closed yet is simply not due; only a model that could not
        // be reached is a failure.
        errors: run.unsettled?.reason === 'unanswered' ? 1 : 0,
        vetoed: counts.vetoed
      },
      aiCall: null
    }
  }
  return { result: runBacktest(candles, bot.strategyId, { forceCloseAtEnd: false }), candles, aiCalls: null, aiCall: null }
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

// Fetches the newest closed candles on the strategy's own interval and replays the full backtest
// engine over the fetched window. A running bot repeats that every minute for as long as this
// component stays mounted — i.e. only while the app is open; a stopped one does it once.
// Re-running the whole engine rather than hand-rolling a stateful "step" keeps this 1:1 consistent
// with the validated backtest — no separate live logic to drift out of sync. forceCloseAtEnd is off so an open position is reported as-is
// instead of showing up as a synthetic closed trade.
//
// The fetch window always reaches back to enabledAt (plus warmup padding), not just a fixed
// default lookback — otherwise a bot left running longer than the default window would quietly
// drop its own older paper trades once they scrolled outside a fixed-size fetch.
export function useDryRun(
  exchange: Exchange,
  symbol: string,
  running: boolean,
  enabledAt: number | null,
  strategyId: string,
  aiModel?: string,
  aiConfirm?: boolean,
  aiEveryBars?: number,
  aiRoute?: AiRoute
): DryRunState {
  const [state, setState] = useState<DryRunState>(LOADING_STATE)
  // Read as two plain values so the effect below re-runs when the route CHANGES, not every time a
  // caller hands over a new object describing the same one.
  const routeModel = aiRoute?.model
  const routeWhen = aiRoute?.when

  useEffect(() => {
    // A STOPPED BOT STILL HAS A CHART. What the strategy is doing on that symbol is a fact about
    // the symbol and the strategy, not about the switch. Refusing to fetch until the bot was
    // enabled is what made a bot you had just created impossible to look at: it is created
    // stopped, so it had no data, so the only way in was hidden, so you could not open it.
    //
    // Unless looking costs money. GPT Intraday bills the user's own credits per decision, so a
    // stopped one fetches nothing at all -- opening a bot must never spend, and only enabling it
    // (which now asks first) may.
    if (!running && costsMoneyToRun(strategyId)) {
      setState(IDLE_STATE)
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const route = routeModel !== undefined && routeWhen !== undefined ? { model: routeModel, when: routeWhen } : undefined

    async function poll(): Promise<void> {
      try {
        const fetched = await fetchBotDryRunResult({
          exchange,
          symbol,
          enabledAt,
          strategyId,
          aiModel,
          aiConfirm,
          aiEveryBars,
          aiRoute: route
        })
        if (cancelled) return
        if (fetched === null) {
          setState({ ...IDLE_STATE, status: 'error', error: 'No candle data returned' })
        } else {
          const { result, candles, aiCalls, aiCall } = fetched
          setState({ status: 'running', error: null, result, candles, latestCandle: candles[candles.length - 1], aiCalls, aiCall })
        }
      } catch (error) {
        if (!cancelled) {
          // A paid bot that cannot ask -- budget spent, key refused, model disabled -- now stops
          // with the reason rather than replaying safety holds, so this is where that reason is
          // shown. Unwrapped, it would lead with an IPC channel name.
          setState((prev) => ({ ...prev, status: 'error', error: describeError(error) }))
        }
      } finally {
        // Polling is what "running" buys. A stopped bot is fetched once so it can be looked at,
        // then left alone instead of hitting the exchange every minute for a bot nobody started.
        if (!cancelled && running) timer = setTimeout(poll, POLL_MS)
      }
    }

    void poll()

    return (): void => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [exchange, symbol, running, enabledAt, strategyId, aiModel, aiConfirm, aiEveryBars, routeModel, routeWhen])

  return state
}
