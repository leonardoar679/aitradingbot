import { describe, expect, it, vi } from 'vitest'
import type { PortfolioSnapshotData } from '../src/portfolio/computePortfolioSnapshot'

// The Portfolio page is the app's landing page, so this status is what a user meets first on
// every launch. "Nothing computed yet" and "computed, and you hold nothing" both produce an
// empty snapshot list but must never produce the same display — the first pass needs a candle
// replay per executor and a 600-candle dry run per bot, so it is seconds long in practice
// (6.1s measured on a two-position profile), and rendering a placeholder $0.00 through all of
// it tells someone with open positions that their portfolio is empty.

const SAMPLE: PortfolioSnapshotData = {
  totalValue: 640.68,
  holdings: [{ baseAsset: 'BTC', quoteAsset: 'USDT', value: 640.68, isLive: false }],
  activeExecutorCount: 0,
  botsAggregatePct: null
}

// Module-level state, so every test needs its own copy of the module.
async function freshStore(): Promise<typeof import('../src/portfolio/portfolioStore')> {
  vi.resetModules()
  return import('../src/portfolio/portfolioStore')
}

describe('portfolioStore status', () => {
  it('starts loading rather than ready-with-nothing', async () => {
    const store = await freshStore()

    expect(store.getPortfolioStatus()).toBe('loading')
    expect(store.getPortfolioSnapshots()).toHaveLength(0)
  })

  it('becomes ready once the first snapshot lands', async () => {
    const store = await freshStore()
    store.pushPortfolioSnapshot(SAMPLE)

    expect(store.getPortfolioStatus()).toBe('ready')
    expect(store.getPortfolioSnapshots()[0].totalValue).toBe(640.68)
  })

  it('is ready — not loading — for a real portfolio that is genuinely empty', async () => {
    const store = await freshStore()
    store.pushPortfolioSnapshot({ ...SAMPLE, totalValue: 0, holdings: [] })

    // This is the case that must still display "$0.00", because now it is a fact.
    expect(store.getPortfolioStatus()).toBe('ready')
    expect(store.getPortfolioSnapshots()[0].totalValue).toBe(0)
  })

  it('surfaces a first-pass failure as an error instead of loading forever', async () => {
    const store = await freshStore()
    store.setPortfolioError('exchange unreachable')

    expect(store.getPortfolioStatus()).toBe('error')
    expect(store.getPortfolioErrorMessage()).toBe('exchange unreachable')
  })

  it('keeps showing the last real figures when a later poll fails', async () => {
    const store = await freshStore()
    store.pushPortfolioSnapshot(SAMPLE)
    store.setPortfolioError('exchange timed out')

    // Stale-but-real beats blanking a portfolio the user was just looking at.
    expect(store.getPortfolioStatus()).toBe('ready')
    expect(store.getPortfolioSnapshots()[0].totalValue).toBe(640.68)
  })

  it('clears a previous error once a poll succeeds again', async () => {
    const store = await freshStore()
    store.setPortfolioError('exchange unreachable')
    store.pushPortfolioSnapshot(SAMPLE)

    expect(store.getPortfolioStatus()).toBe('ready')
    expect(store.getPortfolioErrorMessage()).toBeNull()
  })

  it('notifies subscribers on both snapshots and errors', async () => {
    const store = await freshStore()
    let notified = 0
    // usePortfolioStatus is useSyncExternalStore over this same subscribe/getter pair, so a
    // mutation that does not emit would leave the page frozen on "Loading…" forever.
    const seen: string[] = []
    const record = (): void => {
      notified += 1
      seen.push(store.getPortfolioStatus())
    }
    const unsubscribe = store.subscribeToPortfolio(record)
    store.pushPortfolioSnapshot(SAMPLE)
    store.setPortfolioError('later failure')
    unsubscribe()
    store.pushPortfolioSnapshot(SAMPLE)

    expect(notified).toBe(2)
    expect(seen).toEqual(['ready', 'ready'])
  })

  it('keeps snapshots oldest-first so the evolution chart plots them directly', async () => {
    const store = await freshStore()
    store.pushPortfolioSnapshot({ ...SAMPLE, totalValue: 100 })
    store.pushPortfolioSnapshot({ ...SAMPLE, totalValue: 200 })
    store.pushPortfolioSnapshot({ ...SAMPLE, totalValue: 300 })

    expect(store.getPortfolioSnapshots().map((s) => s.totalValue)).toEqual([100, 200, 300])
  })
})
