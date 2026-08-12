import { useEffect, useState } from 'react'
import type { Candle, ExecutorConfig } from '../../shared/ipc'
import { runExecutorSimulation } from './engine'
import type { ExecutorRuntimeState } from './types'

const POLL_MS = 60_000

export type ExecutorSimStatus = 'loading' | 'running' | 'error'

export interface ExecutorSimResult {
  status: ExecutorSimStatus
  error: string | null
  state: ExecutorRuntimeState | null
  latestCandle: Candle | null
  candles: Candle[]
}

const IDLE: ExecutorSimResult = { status: 'loading', error: null, state: null, latestCandle: null, candles: [] }

/** Mirrors useDryRun: fetches 1m candles from the executor's creation time to now and replays
 * them through the deterministic engine every poll — nothing about fills/state is persisted. */
export function useExecutorSimulation(config: ExecutorConfig): ExecutorSimResult {
  const [result, setResult] = useState<ExecutorSimResult>(IDLE)

  useEffect(() => {
    if (config.status !== 'active') {
      setResult(IDLE)
      return
    }

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    async function poll(): Promise<void> {
      try {
        const endSec = Math.floor(Date.now() / 1000)
        const { candles } = await window.api.market.fetchHistoricalRange(
          config.exchange,
          config.symbol,
          '1m',
          config.createdAt,
          endSec
        )
        if (cancelled) return
        if (candles.length === 0) {
          // A brand-new executor's window (createdAt → now) can be too young to contain even one
          // closed 1m candle yet — that's normal, not a failure, so don't show it as an error.
          const tooYoung = endSec - config.createdAt < 90
          setResult({
            status: tooYoung ? 'loading' : 'error',
            error: tooYoung ? null : 'No candle data returned',
            state: null,
            latestCandle: null,
            candles: []
          })
        } else {
          const basePrice = candles[0].close
          const state = runExecutorSimulation(candles, config, basePrice)
          setResult({ status: 'running', error: null, state, latestCandle: candles[candles.length - 1], candles })
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : String(error)
          setResult((prev) => ({ ...prev, status: 'error', error: message }))
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
    // config.params never changes after an executor is created — id + status is the real
    // identity/trigger here, avoiding needless refetches if the parent array is re-rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.id, config.status])

  return result
}
