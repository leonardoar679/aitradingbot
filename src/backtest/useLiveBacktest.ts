import { useEffect, useState } from 'react'
import { INTERVAL_SECONDS, type Candle, type Exchange, type Interval } from '../../shared/ipc'
import { runBacktest, type BacktestResult } from './engine'
import { STRATEGIES, getStrategy } from './strategies'
import type { StrategyDefinition } from './strategies'
import { fetchRangeCached } from '../bots/candleCache'
import { GPT_INTRADAY_STRATEGY_ID } from '../../shared/aiSignal'

// A backtest that keeps running: same engine, same strategy, re-evaluated against candles fetched
// up to the present minute.
//
// WHY IT RE-RUNS THE WHOLE ENGINE instead of stepping one bar forward. A stateful "advance by one
// candle" implementation would be faster and would be a second implementation of execution --
// position tracking, fees, stop handling, the equity curve -- free to disagree with the backtest
// that justified the strategy. Re-running runBacktest() over the whole window every poll is
// deliberately wasteful and is the only version that cannot drift. useDryRun made the same call
// for the same reason.
//
// forceCloseAtEnd is off, so a position that is still open is reported as open rather than as a
// synthetic closed trade that never happened.
const POLL_MS = 60_000
const LOOKBACK_CANDLES = 600
const WARMUP_SLACK_CANDLES = 20

/** Above this the monitor declines the route instead of fetching it.
 *
 * The lookbacks are in DAYS, so the candle count needed to warm one up explodes as the bar gets
 * finer. Measured across the registry, this is the whole range of what a live route can ask for:
 *
 *     strategy                    1m        15m      1h     4h
 *     trend-regime-ensemble    115,340    7,820   2,060    620
 *     short-term-channel-regime 115,340    7,820   2,060    620
 *     short-term-channel        11,661      909     600    600
 *
 * 7,820 loads fine and is observed working; 115,340 is about 116 paginated requests, kicked off
 * automatically the moment the tab is opened rather than on a Start button the user pressed. The
 * historical Backtest page does the same arithmetic, but there it is one deliberate run.
 *
 * 20,000 sits above every case that works today (the largest is 11,661) and well under the one
 * that does not, so it declines the impractical pairing without second-guessing a working one. */
const MAX_LIVE_FETCH_CANDLES = 20_000

/** Candles the monitor would fetch for this pairing, warm-up included.
 *
 * Pure and exported so the cap can be tested against the real registry rather than asserted from a
 * comment. The hook uses this exact function, so a test of it is a test of what runs. */
export function liveFetchCandles(strategy: StrategyDefinition, interval: Interval): number {
  const warmup = strategy.warmupBarsFor(INTERVAL_SECONDS[interval]) + WARMUP_SLACK_CANDLES
  return Math.max(LOOKBACK_CANDLES, warmup + 120)
}

/** False when the pairing would fetch more than the monitor is willing to pull automatically. */
export function isLiveMonitorable(strategy: StrategyDefinition, interval: Interval): boolean {
  return liveFetchCandles(strategy, interval) <= MAX_LIVE_FETCH_CANDLES
}

export type LiveStatus = 'idle' | 'loading' | 'running' | 'error' | 'unsupported'

export interface LiveBacktestState {
  status: LiveStatus
  error: string | null
  result: BacktestResult | null
  candles: Candle[]
  /** Wall-clock ms of the last successful poll, for the "updated Ns ago" line. */
  updatedAt: number | null
  /** Bars the strategy needs before it can trade at all, at this interval. */
  warmupBars: number
  /** True while the fetched window is too short for the strategy to have warmed up. */
  warmingUp: boolean
}

const IDLE: LiveBacktestState = {
  status: 'idle',
  error: null,
  result: null,
  candles: [],
  updatedAt: null,
  warmupBars: 0,
  warmingUp: false
}

/** Live monitoring for one route.
 *
 * `active` exists so the poll stops when the tab is not being looked at. A monitor that keeps
 * fetching every minute behind a hidden tab is a background job the user did not ask for, and on
 * an 80-day warm-up it is not a cheap one.
 *
 * GPT Intraday is refused rather than polled. Its signals come from a paid API call per decision,
 * so a screen that silently re-requested them every sixty seconds would spend the user's money for
 * as long as the tab happened to be open. It is reported as unsupported, which is the honest
 * answer, rather than quietly showing nothing. */
export function useLiveBacktest(
  exchange: Exchange,
  symbol: string,
  interval: Interval,
  strategyId: string,
  active: boolean
): LiveBacktestState {
  const [state, setState] = useState<LiveBacktestState>(IDLE)

  useEffect(() => {
    if (!active || symbol === '') {
      setState(IDLE)
      return
    }
    if (strategyId === GPT_INTRADAY_STRATEGY_ID) {
      setState({
        ...IDLE,
        status: 'unsupported',
        error: 'GPT Intraday asks a paid model for each decision, so it is not polled live. Run it from Configuration instead, where each run is one deliberate cost.'
      })
      return
    }

    // Membership, NOT a try/catch around getStrategy(). getStrategy falls back to the default
    // strategy for an unknown id rather than throwing -- deliberately, so old saved bots and
    // routines survive a renamed id. That fallback is wrong here and was silently wrong: the
    // Backtest page's strategy list also carries "executor:<uuid>" routes, and monitoring one
    // showed a live EMA Crossover + ATR Stop run under a heading naming it, for a strategy the
    // user had not selected. Verified in the running app before this check existed.
    if (!STRATEGIES.some((s) => s.id === strategyId)) {
      setState({
        ...IDLE,
        status: 'unsupported',
        error: 'Executor replays are not live-monitorable. Pick a strategy on Configuration to monitor one.'
      })
      return
    }
    const strategy = getStrategy(strategyId)

    const barSec = INTERVAL_SECONDS[interval]
    const fetchCandles = liveFetchCandles(strategy, interval)

    // Declined rather than attempted. Naming the strategy's own measured bar makes this a
    // redirection instead of a dead end -- that interval is both cheap and the one the published
    // results describe.
    if (!isLiveMonitorable(strategy, interval)) {
      setState({
        ...IDLE,
        status: 'unsupported',
        error:
          `${strategy.name} needs ${strategy.warmupBarsFor(barSec).toLocaleString()} candles of warm-up at ${interval} ` +
          `— roughly ${Math.ceil(fetchCandles / 1000)} paged requests every time this route changes, fetched automatically. ` +
          `Monitor it at ${strategy.preferredInterval}, the bar it was measured on, or any coarser interval.`
      })
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll(): Promise<void> {
      try {
        const endSec = Math.floor(Date.now() / 1000)
        // The window must clear the warm-up with room to spare, or a slow strategy fetches a range
        // that is entirely warm-up and can never show a trade -- the failure mode that makes a
        // working strategy read as broken.
        const startSec = endSec - fetchCandles * barSec
        const candles = await fetchRangeCached(
          (ex, sym, iv, from, to) => window.api.market.fetchHistoricalRange(ex, sym, iv, from, to),
          exchange,
          symbol,
          interval,
          startSec,
          endSec
        )
        if (cancelled) return
        if (candles.length === 0) {
          setState((prev) => ({ ...prev, status: 'error', error: 'No candle data returned for this route.' }))
        } else {
          const result = runBacktest(candles, strategyId, { forceCloseAtEnd: false })
          setState({
            status: 'running',
            error: null,
            result,
            candles,
            updatedAt: Date.now(),
            warmupBars: result.stats.warmupBars,
            warmingUp: candles.length <= result.stats.warmupBars
          })
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          // Keep the last good result on screen. A monitor that blanks itself on one failed poll
          // throws away the reading the user is watching for a problem that is usually transient.
          setState((prev) => ({ ...prev, status: 'error', error: message }))
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, POLL_MS)
      }
    }

    setState((prev) => ({ ...prev, status: prev.result ? prev.status : 'loading', error: null }))
    void poll()

    return (): void => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [exchange, symbol, interval, strategyId, active])

  return state
}
