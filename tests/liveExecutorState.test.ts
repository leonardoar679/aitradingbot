import { describe, it, expect } from 'vitest'
import { hasUnprotectedLivePosition, needsExitWatcherRetry, isFinished } from '../src/livetrading/liveExecutorState'
import type { ExecutorConfig } from '../shared/ipc'

function executor(over: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    id: 'e1',
    name: 'Ladder',
    type: 'dca',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    createdAt: 1,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'live',
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: {} as ExecutorConfig['params'],
    ...over
  } as ExecutorConfig
}

describe('hasUnprotectedLivePosition', () => {
  it('is false when the watcher armed cleanly', () => {
    expect(hasUnprotectedLivePosition(executor({ liveWatcherError: null }))).toBe(false)
  })

  it('is true when arming failed', () => {
    expect(hasUnprotectedLivePosition(executor({ liveWatcherError: 'bad signature' }))).toBe(true)
  })

  // Executors saved before the field existed read back as undefined, not null. Treating undefined
  // as "unprotected" would wedge every pre-existing executor permanently active.
  it('treats a missing field on an older saved executor as protected', () => {
    const old = executor()
    delete (old as Partial<ExecutorConfig>).liveWatcherError
    expect(hasUnprotectedLivePosition(old)).toBe(false)
  })
})

describe('isFinished', () => {
  it('is finished when nothing is resting, watched or running', () => {
    expect(isFinished(executor())).toBe(true)
  })

  it('is not finished while an order is still resting', () => {
    expect(isFinished(executor({ pendingLiveOrderIds: ['o1'] }))).toBe(false)
  })

  it('is not finished while a watcher is active', () => {
    expect(isFinished(executor({ liveWatcherId: 'w1' }))).toBe(false)
  })

  it('is not finished while a TWAP run is active', () => {
    expect(isFinished(executor({ liveTwapRunId: 't1' }))).toBe(false)
  })

  // The bug this whole change exists for: every emptiness check passes, so the executor was
  // reported as cleanly finished while holding a real position with no exit armed on it.
  it('is NOT finished when everything is empty because arming the watcher failed', () => {
    expect(isFinished(executor({ liveWatcherError: 'signature for this request is not valid' }))).toBe(false)
  })

  it('is still finished for an older saved executor with no such field', () => {
    const old = executor()
    delete (old as Partial<ExecutorConfig>).liveWatcherError
    expect(isFinished(old)).toBe(true)
  })
})

describe('needsExitWatcherRetry', () => {
  const broken = { liveWatcherError: 'boom' as string | null }

  it('retries a live DCA ladder that could not arm its watcher', () => {
    expect(needsExitWatcherRetry(executor({ ...broken, type: 'dca' }))).toBe(true)
  })

  it('retries a live Grid ladder too', () => {
    expect(needsExitWatcherRetry(executor({ ...broken, type: 'grid' }))).toBe(true)
  })

  it('never retries a paper executor', () => {
    expect(needsExitWatcherRetry(executor({ ...broken, mode: 'paper' }))).toBe(false)
  })

  it('never retries a stopped executor', () => {
    expect(needsExitWatcherRetry(executor({ ...broken, status: 'stopped' }))).toBe(false)
  })

  // Position arms its watcher synchronously at creation; Order and TWAP never use one. Retrying
  // for them would try to arm a watcher nothing ever asked for.
  it('does not retry types that do not arm a watcher lazily', () => {
    for (const type of ['order', 'position', 'twap', 'xemm', 'arbitrage', 'marketmaking'] as const) {
      expect(needsExitWatcherRetry(executor({ ...broken, type })), type).toBe(false)
    }
  })

  it('does not retry once a watcher is actually armed', () => {
    expect(needsExitWatcherRetry(executor({ ...broken, liveWatcherId: 'w1' }))).toBe(false)
  })

  it('does not retry a healthy executor', () => {
    expect(needsExitWatcherRetry(executor({ liveWatcherError: null }))).toBe(false)
  })
})
