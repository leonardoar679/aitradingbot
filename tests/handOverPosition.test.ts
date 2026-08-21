import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutorConfig, HeldPosition } from '../shared/ipc'

// "Keep position when stopped (hand over to Inventory)" is a checkbox the user ticks, so it has
// to mean the same thing regardless of who pressed stop. It used to live inside the Executors
// page's own Stop handler, which meant a controller's risk-control breach — precisely the moment
// a still-open position most needs recording — silently discarded it instead.

const computeExecutorPosition = vi.fn()
vi.mock('../src/executors/computeSnapshot', () => ({
  computeExecutorPosition: (executor: ExecutorConfig) => computeExecutorPosition(executor)
}))

const { handOverPositionOnStop } = await import('../src/executors/handOverPosition')

const EXECUTOR: ExecutorConfig = {
  id: 'exec-1',
  name: 'DCA One',
  type: 'dca',
  exchange: 'binance',
  symbol: 'BTCUSDT',
  baseAsset: 'BTC',
  quoteAsset: 'USDT',
  createdAt: 1_700_000_000,
  status: 'stopped',
  stoppedAt: 1_700_086_400,
  keepPosition: true,
  mode: 'paper',
  liveOrder: null,
  pendingLiveOrderIds: [],
  liveWatcherId: null,
  liveExitResult: null,
  liveTwapRunId: null,
  liveTwapResult: null,
  params: { side: 'buy', levels: [{ priceOffsetPct: 0, amountQuote: 100 }], takeProfitPct: 5, stopLossPct: null, timeLimitSec: null }
} as ExecutorConfig

const POSITION = { side: 'buy' as const, entryPrice: 71_653.83, amountQuote: 100 }

let stored: { heldPositions: HeldPosition[] }
let setCalls: number

function installWindowApi(): void {
  stored = { heldPositions: [] }
  setCalls = 0
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      settings: {
        get: async () => ({ ...stored, heldPositions: [...stored.heldPositions] }),
        set: async (patch: { heldPositions: HeldPosition[] }) => {
          setCalls += 1
          stored.heldPositions = patch.heldPositions
        }
      }
    }
  }
}

describe('handOverPositionOnStop', () => {
  beforeEach(() => {
    computeExecutorPosition.mockReset()
    installWindowApi()
  })

  it('records an open paper position in Inventory', async () => {
    computeExecutorPosition.mockResolvedValue(POSITION)

    const handed = await handOverPositionOnStop(EXECUTOR)

    expect(handed).toBe(true)
    expect(stored.heldPositions).toHaveLength(1)
    expect(stored.heldPositions[0]).toMatchObject({
      sourceExecutorId: 'exec-1',
      sourceExecutorName: 'DCA One',
      exchange: 'binance',
      symbol: 'BTCUSDT',
      side: 'buy',
      entryPrice: 71_653.83,
      amountQuote: 100
    })
  })

  it('skips live executors — a live fill already has its own ledger', async () => {
    computeExecutorPosition.mockResolvedValue(POSITION)

    const handed = await handOverPositionOnStop({ ...EXECUTOR, mode: 'live' })

    expect(handed).toBe(false)
    // Must not even replay candles for a live executor, let alone write a paper Inventory row.
    expect(computeExecutorPosition).not.toHaveBeenCalled()
    expect(setCalls).toBe(0)
  })

  it('skips executors with the checkbox unticked', async () => {
    computeExecutorPosition.mockResolvedValue(POSITION)

    const handed = await handOverPositionOnStop({ ...EXECUTOR, keepPosition: false })

    expect(handed).toBe(false)
    expect(computeExecutorPosition).not.toHaveBeenCalled()
    expect(setCalls).toBe(0)
  })

  it('writes nothing when the executor holds no open position', async () => {
    computeExecutorPosition.mockResolvedValue(null)

    const handed = await handOverPositionOnStop(EXECUTOR)

    expect(handed).toBe(false)
    expect(setCalls).toBe(0)
  })

  it('appends to whatever is stored now, not to a caller-held copy', async () => {
    // settings.set replaces the whole heldPositions array, and computing the position above is a
    // network round trip — long enough for another writer to land in between. Simulate exactly
    // that: a row appears while the position is still being computed.
    computeExecutorPosition.mockImplementation(async () => {
      stored.heldPositions = [{ id: 'landed-meanwhile' } as HeldPosition]
      return POSITION
    })

    await handOverPositionOnStop(EXECUTOR)

    expect(stored.heldPositions.map((p) => p.id)).toEqual(['landed-meanwhile', expect.any(String)])
  })

  it('keeps existing Inventory rows', async () => {
    stored.heldPositions = [{ id: 'existing' } as HeldPosition]
    computeExecutorPosition.mockResolvedValue(POSITION)

    await handOverPositionOnStop(EXECUTOR)

    expect(stored.heldPositions).toHaveLength(2)
    expect(stored.heldPositions[0].id).toBe('existing')
  })
})
