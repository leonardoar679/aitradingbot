import { describe, expect, it } from 'vitest'
import { describeControllerBreach, evaluateControllerRisk } from '../src/controllers/riskBreach'
import type { ControllerRiskControls } from '../shared/ipc'

// The decision that stops every executor a user has running lived inline in a React component,
// so none of this was reachable from a test.

function controls(overrides: Partial<ControllerRiskControls> = {}): ControllerRiskControls {
  return { globalStopLossPct: null, globalTakeProfitPct: null, maxDrawdownPct: null, ...overrides }
}

describe('checking a controller against its risk controls', () => {
  it('leaves a controller alone when nothing is configured', () => {
    expect(evaluateControllerRisk(controls(), -80, 90)).toBeNull()
  })

  it('stops on a loss that reaches the stop loss', () => {
    expect(evaluateControllerRisk(controls({ globalStopLossPct: 10 }), -10.4, 10.4)).toEqual({
      kind: 'stop-loss',
      limitPct: 10,
      actualPct: -10.4
    })
  })

  it('leaves a loss short of the stop loss running', () => {
    expect(evaluateControllerRisk(controls({ globalStopLossPct: 10 }), -9.99, 9.99)).toBeNull()
  })

  it('fires exactly at the limit, not only past it', () => {
    // A 10% stop loss is a limit of 10%, so 10% down is a breach. Every one of these comparisons
    // is non-strict live and the boundary is the only place that shows.
    expect(evaluateControllerRisk(controls({ globalStopLossPct: 10 }), -10, 10)?.kind).toBe('stop-loss')
    expect(evaluateControllerRisk(controls({ maxDrawdownPct: 15 }), 2, 15)?.kind).toBe('max-drawdown')
    expect(evaluateControllerRisk(controls({ globalTakeProfitPct: 25 }), 25, 0)?.kind).toBe('take-profit')
  })

  it('stops on a gain that reaches the take profit', () => {
    expect(evaluateControllerRisk(controls({ globalTakeProfitPct: 25 }), 25, 0)?.kind).toBe('take-profit')
  })

  it('stops on a fall from the peak that reaches the max drawdown', () => {
    expect(evaluateControllerRisk(controls({ maxDrawdownPct: 15 }), 4, 15.2)?.kind).toBe('max-drawdown')
  })

  it('reads a limit typed with a minus sign as the magnitude the user meant', () => {
    // The live comparisons already did this with Math.abs on both sides; a stop loss of -10 that
    // could never fire would be a control that looks armed and is not.
    expect(evaluateControllerRisk(controls({ globalStopLossPct: -10 }), -12, 12)?.kind).toBe('stop-loss')
    expect(evaluateControllerRisk(controls({ maxDrawdownPct: -15 }), 0, 16)?.kind).toBe('max-drawdown')
  })

  it('names the loss, not the drawdown, when both fire on the same tick', () => {
    // A loss deep enough to breach the stop loss is nearly always a drawdown breach too. "Max
    // drawdown" would be true and useless: the account is down 20%, and that is the reason.
    expect(evaluateControllerRisk(controls({ globalStopLossPct: 10, maxDrawdownPct: 5 }), -20, 20)?.kind).toBe('stop-loss')
  })

  it('names the drawdown, not the take profit, when both fire on the same tick', () => {
    // Up 30% having been up 45%: the target was reached, but the drawdown is why the run ended
    // here rather than at the peak.
    expect(evaluateControllerRisk(controls({ globalTakeProfitPct: 25, maxDrawdownPct: 10 }), 30, 10.3)?.kind).toBe('max-drawdown')
  })
})

describe('a limit of zero', () => {
  // Reachable from the form: `stopLossPct ? Number(stopLossPct) : null` keeps a typed "0",
  // because the string "0" is truthy. Every comparison is non-strict, so a zero fired on the
  // first snapshot -- stopping every attached executor before the price had moved at all.
  it('does not stop a controller that has not lost anything', () => {
    expect(evaluateControllerRisk(controls({ maxDrawdownPct: 0 }), 0, 0)).toBeNull()
    expect(evaluateControllerRisk(controls({ globalTakeProfitPct: 0 }), 0, 0)).toBeNull()
    expect(evaluateControllerRisk(controls({ globalStopLossPct: 0 }), 0, 0)).toBeNull()
  })

  it('does not stop a controller that is winning', () => {
    expect(evaluateControllerRisk(controls({ globalStopLossPct: 0, globalTakeProfitPct: 0, maxDrawdownPct: 0 }), 12, 3)).toBeNull()
  })

  it('still honours the other limits alongside it', () => {
    expect(evaluateControllerRisk(controls({ maxDrawdownPct: 0, globalStopLossPct: 8 }), -9, 9)?.kind).toBe('stop-loss')
  })
})

describe('a P&L that could not be read', () => {
  it('refuses to decide rather than reporting no breach', () => {
    // Every comparison is false against NaN, so a silent null here would DISABLE all three
    // controls at exactly the moment something has gone wrong.
    expect(() => evaluateControllerRisk(controls({ globalStopLossPct: 10 }), NaN, 0)).toThrow(/unreadable/)
    expect(() => evaluateControllerRisk(controls({ maxDrawdownPct: 10 }), 0, NaN)).toThrow(/unreadable/)
    expect(() => evaluateControllerRisk(controls({ globalStopLossPct: 10 }), -Infinity, 0)).toThrow(/unreadable/)
  })

  it('refuses even when no control is configured, because the number is still wrong', () => {
    expect(() => evaluateControllerRisk(controls(), NaN, NaN)).toThrow(/unreadable/)
  })
})

describe('saying which limit stopped everything', () => {
  it('names the limit and the number that crossed it', () => {
    expect(describeControllerBreach({ kind: 'stop-loss', limitPct: 10, actualPct: -12.5 })).toBe(
      'Stop loss hit — down 12.50% of allocated capital, limit 10%.'
    )
    expect(describeControllerBreach({ kind: 'take-profit', limitPct: 25, actualPct: 26.1 })).toBe(
      'Take profit hit — up 26.10% of allocated capital, target 25%.'
    )
    expect(describeControllerBreach({ kind: 'max-drawdown', limitPct: 15, actualPct: 15.4 })).toBe(
      'Max drawdown hit — 15.40% below the peak, limit 15%.'
    )
  })
})
