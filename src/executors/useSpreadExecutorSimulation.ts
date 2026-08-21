import { useEffect, useState } from 'react'
import type { ExecutorConfig, XemmExecutorParams, ArbitrageExecutorParams } from '../../shared/ipc'
import { alignByTime, simulateXemm, simulateArbitrage, type AlignedPoint } from './spreadEngine'
import type { SpreadExecutorState } from './types'

const POLL_MS = 60_000
// See useExecutorSimulation's WAITING_POLL_MS -- same rationale, same first-minute wait.
const WAITING_POLL_MS = 15_000

export type SpreadSimStatus = 'loading' | 'running' | 'error'

export interface SpreadSimResult {
  status: SpreadSimStatus
  error: string | null
  state: SpreadExecutorState | null
  aligned: AlignedPoint[]
  /** True only for the specific "too new to have a closed 1m candle yet" case, so the UI can say
   * that plainly instead of showing an indefinite generic loading message. */
  waitingForFirstCandle: boolean
}

const IDLE: SpreadSimResult = { status: 'loading', error: null, state: null, aligned: [], waitingForFirstCandle: true }

/** Mirrors useExecutorSimulation, but for xemm/arbitrage's two-market case: fetches both markets'
 * candle history from the executor's creation time to now, aligns them by timestamp, and replays
 * through the spread engine every poll — same deterministic-replay honesty as every other executor. */
export function useSpreadExecutorSimulation(config: ExecutorConfig): SpreadSimResult {
  const [result, setResult] = useState<SpreadSimResult>(IDLE)

  useEffect(() => {
    if (config.status !== 'active') {
      setResult(IDLE)
      return
    }
    if (config.type !== 'xemm' && config.type !== 'arbitrage') {
      setResult({ status: 'error', error: `${config.type} is not a spread executor`, state: null, aligned: [], waitingForFirstCandle: false })
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const params = config.params as XemmExecutorParams | ArbitrageExecutorParams

    async function poll(): Promise<void> {
      let nextPollMs = POLL_MS
      try {
        const endSec = Math.floor(Date.now() / 1000)
        const [resultA, resultB] = await Promise.all([
          window.api.market.fetchHistoricalRange(params.buyingMarket.exchange, params.buyingMarket.symbol, '1m', config.createdAt, endSec),
          window.api.market.fetchHistoricalRange(params.sellingMarket.exchange, params.sellingMarket.symbol, '1m', config.createdAt, endSec)
        ])
        if (cancelled) return

        const aligned = alignByTime(resultA.candles, resultB.candles)
        if (aligned.length === 0) {
          const tooYoung = endSec - config.createdAt < 90
          if (tooYoung) nextPollMs = WAITING_POLL_MS
          setResult({
            status: tooYoung ? 'loading' : 'error',
            error: tooYoung ? null : 'No overlapping candle data between the two markets',
            state: null,
            aligned: [],
            waitingForFirstCandle: tooYoung
          })
        } else {
          const state = config.type === 'xemm' ? simulateXemm(aligned, params as XemmExecutorParams) : simulateArbitrage(aligned, params as ArbitrageExecutorParams)
          setResult({ status: 'running', error: null, state, aligned, waitingForFirstCandle: false })
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          setResult((prev) => ({ ...prev, status: 'error', error: message, waitingForFirstCandle: false }))
        }
      } finally {
        if (!cancelled) timer = setTimeout(poll, nextPollMs)
      }
    }

    void poll()

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.id, config.status])

  return result
}
