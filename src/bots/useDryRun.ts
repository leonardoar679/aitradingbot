import { useEffect, useState } from 'react'
import type { Candle, Exchange } from '../../shared/ipc'
import { runBacktest, type BacktestResult } from '../backtest/engine'

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
        const endSec = Math.floor(Date.now() / 1000)
        const defaultStartSec = endSec - LOOKBACK_CANDLES * DRY_RUN_INTERVAL_SEC
        const startSec =
          enabledAt !== null
            ? Math.min(defaultStartSec, enabledAt - WARMUP_CANDLES * DRY_RUN_INTERVAL_SEC)
            : defaultStartSec
        const { candles } = await window.api.market.fetchHistoricalRange(exchange, symbol, '4h', startSec, endSec)
        if (cancelled) return
        if (candles.length === 0) {
          setState({ status: 'error', error: 'No candle data returned', result: null, candles: [], latestCandle: null })
        } else {
          const result = runBacktest(candles, strategyId, { forceCloseAtEnd: false })
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
