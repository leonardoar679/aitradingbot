import { describe, expect, it } from 'vitest'
import {
  ROUND_TRIP_FEE_PCT,
  STARTER_PACKS,
  STARTER_PRESETS,
  buildPresetExecutor,
  buildStarterPack,
  findPreset
} from '../src/presets/starterPresets'
import { runExecutorSimulation } from '../src/executors/engine'
import { describeGridBoundsProblem } from '../src/executors/gridBounds'
import type { Candle, DcaExecutorParams, GridExecutorParams, MarketMakingExecutorParams, PositionExecutorParams } from '../shared/ipc'

// These presets exist so someone who has never configured a bot is not handed a blank form. That
// makes them the one place in the app where a bad default reaches a beginner directly, with no
// step in between where they would have had to type the number themselves.
//
// The checks below are therefore about the presets being SAFE and COHERENT, not about them being
// profitable -- nothing here can promise that. Mostly they enforce the one thing a newcomer
// cannot be expected to work out: that a target below the round-trip fee is a guaranteed loss
// dressed up as a small win.

const T = 1_700_000_000
const REF = 50_000
const opts = { referencePrice: REF, now: T }

const candle = (i: number, open: number, high: number, low: number, close: number): Candle => ({
  time: T + i * 60, open, high, low, close, volume: 1
})

// Enough candles for a TWAP to reach its slices and a grid to cycle a level.
const SERIES: Candle[] = Array.from({ length: 800 }, (_, i) => {
  const drift = Math.sin(i / 40) * 0.03
  const mid = REF * (1 + drift)
  return candle(i, mid, mid * 1.004, mid * 0.996, mid)
})

describe('every preset clears the fee floor', () => {
  it('charges a round trip at twice the per-side rate', () => {
    // If this ever changes, every profit target below has to be revisited.
    expect(ROUND_TRIP_FEE_PCT).toBeCloseTo(0.2, 10)
  })

  it('sets the DCA take-profit above the cost of the round trip', () => {
    const dca = findPreset('dca-dip-ladder')!.buildParams(REF) as DcaExecutorParams
    expect(dca.takeProfitPct).toBeGreaterThan(ROUND_TRIP_FEE_PCT)
  })

  it('sets the grid take-profit above the cost of the round trip', () => {
    // A grid cycles the same level repeatedly, so it pays this fee on EVERY cycle -- the margin
    // here matters more than anywhere else in the app.
    const grid = findPreset('grid-range')!.buildParams(REF) as GridExecutorParams
    expect(grid.takeProfitPct).toBeGreaterThan(ROUND_TRIP_FEE_PCT)
  })

  it('sets the position target above the cost of the round trip', () => {
    const pos = findPreset('position-triple-barrier')!.buildParams(REF) as PositionExecutorParams
    expect(pos.takeProfitPct as number).toBeGreaterThan(ROUND_TRIP_FEE_PCT)
  })

  it('quotes a market-making spread wider than a round trip', () => {
    // spreadPct is the full bid-to-ask distance, so a completed round trip captures it once.
    const mm = findPreset('pure-market-making')!.buildParams(REF) as MarketMakingExecutorParams
    expect(mm.spreadPct).toBeGreaterThan(ROUND_TRIP_FEE_PCT)
  })

  it('requires both spread strategies to clear the cost of BOTH legs', () => {
    for (const id of ['xemm-korea', 'arbitrage-korea']) {
      const params = findPreset(id)!.buildParams(REF) as { minProfitabilityPct: number }
      expect(params.minProfitabilityPct).toBeGreaterThan(ROUND_TRIP_FEE_PCT)
    }
  })
})

describe('every preset limits its downside', () => {
  it('gives the DCA ladder a stop loss', () => {
    // The app's own DCA default leaves stopLossPct null, which is an unbounded hold. That is a
    // defensible choice for someone who understands it and the wrong one to hand a beginner.
    const dca = findPreset('dca-dip-ladder')!.buildParams(REF) as DcaExecutorParams
    expect(dca.stopLossPct).not.toBeNull()
  })

  it('gives the grid a stop below its own band', () => {
    const grid = findPreset('grid-range')!.buildParams(REF) as GridExecutorParams
    expect(grid.limitPrice).not.toBeNull()
    expect(grid.limitPrice as number).toBeLessThan(grid.startPrice)
  })

  it('gives the position all four barriers', () => {
    const pos = findPreset('position-triple-barrier')!.buildParams(REF) as PositionExecutorParams
    expect(pos.takeProfitPct).not.toBeNull()
    expect(pos.stopLossPct).not.toBeNull()
    expect(pos.timeLimitSec).not.toBeNull()
    expect(pos.trailingStop).not.toBeNull()
  })

  it('arms the trailing stop only after the trade is actually ahead', () => {
    // Activating at or below the trail distance would let it fire while still underwater.
    const pos = findPreset('position-triple-barrier')!.buildParams(REF) as PositionExecutorParams
    const trail = pos.trailingStop!
    expect(trail.activationPct).toBeGreaterThan(trail.trailPct)
  })
})

describe('every preset is buildable and runnable', () => {
  it('never creates anything in live mode', () => {
    // The strongest guarantee here. A preset is a suggestion the user did not write, so it must
    // not be able to reach real money on their behalf.
    for (const preset of STARTER_PRESETS) {
      expect(buildPresetExecutor(preset, opts).mode).toBe('paper')
    }
  })

  it('produces a runnable executor for every single-market preset', () => {
    for (const preset of STARTER_PRESETS) {
      // xemm/arbitrage are simulated through spreadEngine against two aligned markets instead.
      if (preset.type === 'xemm' || preset.type === 'arbitrage') continue
      const executor = buildPresetExecutor(preset, opts)
      const state = runExecutorSimulation(SERIES, executor, SERIES[0].close)
      expect(state.kind).toBe(preset.type)
    }
  })

  it('lays the grid band around the current price rather than away from it', () => {
    const executor = buildPresetExecutor(findPreset('grid-range')!, opts)
    const grid = executor.params as GridExecutorParams
    // The same check the New Executor form runs, so a preset cannot ship a config the form
    // would have refused to create by hand.
    const problem = describeGridBoundsProblem({ startPrice: grid.startPrice, endPrice: grid.endPrice, lastPrice: REF })
    expect(problem.blocking).toBeNull()
    expect(problem.warning).toBeNull()
  })

  it('actually fills grid levels at the reference price it was built for', () => {
    // A band built around the wrong price would still typecheck and still simulate -- it would
    // just silently never trade.
    const executor = buildPresetExecutor(findPreset('grid-range')!, opts)
    const state = runExecutorSimulation(SERIES, executor, SERIES[0].close)
    if (state.kind !== 'grid') throw new Error('expected a grid')
    expect(state.closedLevels + state.filledCount).toBeGreaterThan(0)
  })
})

describe('starter packs wire their controller to their own executors', () => {
  it('references only presets that exist', () => {
    for (const pack of STARTER_PACKS) {
      for (const id of pack.presetIds) {
        expect(findPreset(id), `pack ${pack.id} references missing preset ${id}`).toBeDefined()
      }
    }
  })

  it('attaches every executor it just created, and nothing else', () => {
    for (const pack of STARTER_PACKS) {
      const { executors, controller } = buildStarterPack(pack, opts)
      expect(executors).toHaveLength(pack.presetIds.length)
      // The point of a pack: the group arrives supervised, not as loose executors the user has
      // to remember to attach by hand.
      expect(controller.executorIds).toEqual(executors.map((e) => e.id))
    }
  })

  it('gives every pack a complete set of risk controls', () => {
    for (const pack of STARTER_PACKS) {
      expect(pack.riskControls.globalStopLossPct).not.toBeNull()
      expect(pack.riskControls.globalTakeProfitPct).not.toBeNull()
      expect(pack.riskControls.maxDrawdownPct).not.toBeNull()
    }
  })

  it('keeps the drawdown limit inside the stop it sits with', () => {
    // A max-drawdown above the stop loss can never fire first, which makes it decoration.
    for (const pack of STARTER_PACKS) {
      expect(pack.riskControls.maxDrawdownPct as number).toBeGreaterThan(pack.riskControls.globalStopLossPct as number)
      expect(pack.riskControls.maxDrawdownPct as number).toBeLessThan(pack.riskControls.globalTakeProfitPct as number)
    }
  })

  it('gives each preset a unique id', () => {
    expect(new Set(STARTER_PRESETS.map((p) => p.id)).size).toBe(STARTER_PRESETS.length)
  })

  it('marks exactly the types that cannot go live as paper-only', () => {
    // Mirrors the live-capability split enforced in ExecutorsPage: order/position/dca/twap/grid.
    for (const preset of STARTER_PRESETS) {
      const canBeLive = ['order', 'position', 'dca', 'twap', 'grid'].includes(preset.type)
      expect(preset.paperOnly, `${preset.id} paperOnly flag disagrees with its type`).toBe(!canBeLive)
    }
  })

  it('explains its own failure mode', () => {
    // A preset that only advertises upside is the thing this whole module is trying not to be.
    for (const preset of STARTER_PRESETS) {
      expect(preset.whenItLosesMoney.length, `${preset.id} has no failure mode`).toBeGreaterThan(60)
      expect(preset.hummingbot.length).toBeGreaterThan(0)
    }
  })
})

describe('a preset refuses to build a dud', () => {
  it('throws rather than laying a grid at a price of zero', () => {
    // Silently building bounds of 0 would produce an executor that looks like it is patiently
    // waiting for a fill it can never get.
    const grid = findPreset('grid-range')!
    expect(() => buildPresetExecutor(grid, { referencePrice: 0, now: T })).toThrow(/needs the current/)
    expect(() => buildPresetExecutor(grid, { referencePrice: Number.NaN, now: T })).toThrow(/needs the current/)
  })

  it('still builds the presets that do not depend on a price', () => {
    for (const preset of STARTER_PRESETS) {
      if (preset.needsReferencePrice) continue
      expect(() => buildPresetExecutor(preset, { referencePrice: 0, now: T })).not.toThrow()
    }
  })
})
