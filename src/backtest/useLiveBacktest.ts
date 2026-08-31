import { useEffect, useState } from 'react'
import { INTERVAL_SECONDS, type Candle, type Exchange, type Interval } from '../../shared/ipc'
import { runBacktest, type BacktestResult } from './engine'
import { STRATEGIES, getStrategy } from './strategies'
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
    const warmupBars = strategy.warmupBarsFor(barSec) + WARMUP_SLACK_CANDLES

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll(): Promise<void> {
      try {
        const endSec = Math.floor(Date.now() / 1000)
        // The window must clear the warm-up with room to spare, or a slow strategy fetches a range
        // that is entirely warm-up and can never show a trade -- the failure mode that makes a
        // working strategy read as broken.
        const startSec = endSec - Math.max(LOOKBACK_CANDLES, warmupBars + 120) * barSec
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

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [exchange, symbol, interval, strategyId, active])

  return state
}
