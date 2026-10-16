import { useEffect, useState } from 'react'
import { onExchange, type Candle, type ExecutorConfig } from '../../shared/ipc'
import { runExecutorSimulation } from './engine'
import type { SingleMarketExecutorState } from './types'

const POLL_MS = 60_000
// A just-created executor has no closed 1m candle to replay yet. Re-check more often while that
// is the case instead of waiting out a full poll cycle -- otherwise the card can sit on its
// waiting state for up to ~2 minutes (the candle closes right after a poll, and nothing re-reads
// it until the next one), which reads as a hung app rather than a normal first-minute wait. Kept
// well above a few seconds so the extra polls do not pile pressure on the exchange API.
const WAITING_POLL_MS = 15_000

export type ExecutorSimStatus = 'loading' | 'running' | 'error'

export interface ExecutorSimResult {
  status: ExecutorSimStatus
  error: string | null
  state: SingleMarketExecutorState | null
  latestCandle: Candle | null
  candles: Candle[]
  /** True only for the specific "too new to have a closed 1m candle yet" case, so the UI can say
   * that plainly instead of showing an indefinite generic loading message. */
  waitingForFirstCandle: boolean
}

const IDLE: ExecutorSimResult = {
  status: 'loading',
  error: null,
  state: null,
  latestCandle: null,
  candles: [],
  waitingForFirstCandle: true
}

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
      let nextPollMs = POLL_MS
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
          if (tooYoung) nextPollMs = WAITING_POLL_MS
          setResult({
            status: tooYoung ? 'loading' : 'error',
            error: tooYoung ? null : 'No candle data returned',
            state: null,
            latestCandle: null,
            candles: [],
            waitingForFirstCandle: tooYoung
          })
        } else if (onExchange(config.mode)) {
          // Live and demo executors never get a simulated state -- the real outcome already happened
          // (or, for a resting limit order / watched position, is really in progress on the
          // exchange) and lives on the executor's own liveOrder/liveWatcherId/liveExitResult fields,
          // not a paper replay of these same candles. Candles are still fetched so the chart has real
          // market context to draw against.
          setResult({
            status: 'running',
            error: null,
            state: null,
            latestCandle: candles[candles.length - 1],
            candles,
            waitingForFirstCandle: false
          })
        } else {
          const basePrice = candles[0].close
          const state = runExecutorSimulation(candles, config, basePrice)
          setResult({
            status: 'running',
            error: null,
            state,
            latestCandle: candles[candles.length - 1],
            candles,
            waitingForFirstCandle: false
          })
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

    return (): void => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
    // config.params never changes after an executor is created — id + status is the real
    // identity/trigger here, avoiding needless refetches if the parent array is re-rendered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.id, config.status])

  return result
}
