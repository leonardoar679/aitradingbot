import { describe, expect, it, vi } from 'vitest'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import type { FittedHorizon } from '../shared/forecast/models'
import { LAB_RISK } from '../shared/forecast/labTrader'
import { runReplay, type ReplayTrade } from '../shared/forecast/replay'
import type { TradeDecision } from '../shared/forecast/tradeDecision'
import { CALIBRATION, HOUR, MARKET, tinyFitted } from './forecastServiceFixture'

// THE LABORATORY ON THE REPLAY, UNDER ITS CAPS (shared/forecast/replay.ts; V7.2-R Stage 5). No fixture model calls a
// way, so here every forecast's decision is made again as a day's BUY with nothing holding it back: the hybrid, told
// Trend Regime 4h stands long, takes each up -- one trade at a time on a pair, at most three open -- and they are
// filled as the paper engine fills a Position.

vi.mock('../shared/forecast/tradeDecision', async (importOriginal) => {
  const real = await importOriginal<typeof import('../shared/forecast/tradeDecision')>()
  return {
    ...real,
    heldBackByPrice: (): boolean => true,
    decideOnBook: (decision: TradeDecision): TradeDecision => ({ ...decision, side: 'BUY', decision: 'TRADE', reasons: [], horizon: 'hours24' })
  }
})

const MODELS = new Map<Horizon, FittedHorizon>(HORIZONS.map((horizon) => [horizon, tinyFitted(horizon)]))

describe("the laboratory's replayed trades", () => {
  const trades: ReplayTrade[] = []
  const summary = runReplay(
    { bars: MARKET, segments: [{ sample: 'out', label: 'six hours', from: HOUR, to: HOUR + 6 * 3600, models: MODELS, calibration: CALIBRATION, runId: 'run-a/fold-1' }], quantSide: () => 'long' },
    { trade: (trade) => void trades.push(trade) }
  )
  const lab = trades.filter((trade) => trade.cell.startsWith('lab:'))

  it('are taken up under the first strategy they qualify for, a day long, filled on the bars', () => {
    expect(lab.length).toBeGreaterThan(3)
    expect(lab.every((trade) => trade.cell === 'lab:hybrid' && trade.strategy === 'hybrid' && trade.side === 'BUY' && trade.horizon === 'hours24' && trade.sample === 'out')).toBe(true)
    expect(lab.every((trade) => trade.exit !== 'unfilled' && trade.filledAt !== null && Number.isFinite(trade.netPct) && trade.baselinePct === null)).toBe(true)
    expect(summary.cells.find((cell) => cell.cell === 'lab:hybrid')!.trades).toBe(lab.length)
  })

  it('keep one open on a pair, and at most three open at once', () => {
    for (const trade of lab) {
      const open = lab.filter((other) => other.t <= trade.t && trade.t < other.endedAt)
      expect(open.length).toBeLessThanOrEqual(LAB_RISK.maxOpen)
      expect(open.filter((other) => other.pair === trade.pair)).toEqual([trade])
    }
    // The cap binds: four pairs, three at a time.
    const most = Math.max(...lab.map((trade) => lab.filter((other) => other.t <= trade.t && trade.t < other.endedAt).length))
    expect(most).toBe(LAB_RISK.maxOpen)
  })
})
