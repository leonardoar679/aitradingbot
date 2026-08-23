import { describe, it, expect } from 'vitest'
import { controllerDrawdownPct } from '../src/controllers/riskMath'

const ALLOCATED = 1000

describe('controllerDrawdownPct', () => {
  it('is zero at a fresh session with no P&L', () => {
    expect(controllerDrawdownPct([], 0, ALLOCATED)).toBe(0)
  })

  it('is zero while at a new high', () => {
    expect(controllerDrawdownPct([50, 100], 100, ALLOCATED)).toBe(0)
  })

  // The old formula divided by peak P&L, so a $1 profit falling to $0 read as a 100% drawdown
  // and stopped every attached executor over a tenth of a percent of capital.
  it('treats a tiny profit given back as tiny, not total', () => {
    const dd = controllerDrawdownPct([0.5, 1], 0, ALLOCATED)
    expect(dd).toBeCloseTo(0.0999, 3)
    expect(dd).toBeLessThan(1)
  })

  // The mirror failure: `peak > 0` was false for a controller never in profit, so the deeper the
  // loss the more certain the control was to stay silent.
  it('fires for a controller that has never been in profit', () => {
    expect(controllerDrawdownPct([-10, -50], -400, ALLOCATED)).toBeCloseTo(40, 6)
    expect(controllerDrawdownPct([-50, -100], -200, ALLOCATED)).toBeCloseTo(20, 6)
  })

  it('measures a real give-back against equity, not against the profit', () => {
    // $1200 of equity back to $1100 is 8.33% of the peak equity.
    expect(controllerDrawdownPct([100, 200], 100, ALLOCATED)).toBeCloseTo(8.3333, 3)
  })

  it('counts the starting point as a peak, so a straight loss still draws down', () => {
    expect(controllerDrawdownPct([], -100, ALLOCATED)).toBeCloseTo(10, 6)
  })

  it('scales with capital rather than with the size of the P&L', () => {
    const small = controllerDrawdownPct([100], 0, 1000)
    const large = controllerDrawdownPct([1000], 0, 10000)
    expect(small).toBeCloseTo(large, 6)
  })

  // Guaranteed by how the peak is built rather than by a clamp -- see riskMath.ts.
  it('never reports a negative drawdown', () => {
    expect(controllerDrawdownPct([-100], 500, ALLOCATED)).toBe(0)
  })

  it('returns zero rather than dividing when there is no capital behind it', () => {
    expect(controllerDrawdownPct([100], 50, 0)).toBeCloseTo(50, 6)
    expect(controllerDrawdownPct([], -50, 0)).toBe(0)
  })

  it('uses the deepest peak in the history, not just the latest', () => {
    expect(controllerDrawdownPct([200, 50], 50, ALLOCATED)).toBeCloseTo(12.5, 3)
  })
})
