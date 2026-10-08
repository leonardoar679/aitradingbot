import { describe, it, expect } from 'vitest'
import { DEFAULT_LIVE_RISK_PCT, LIVE_RISK_PCT_CHOICES, clampLiveLimit, healLiveRiskPct, liveRiskPctProblem, loadedLiveLimit, describeUnusableOrderSize, describeUntrustedLossTally } from '../shared/liveLimits'

describe('clampLiveLimit', () => {
  it('keeps an ordinary value', () => {
    expect(clampLiveLimit('Max order size', 10, 25)).toBe(10)
  })

  it('clamps to the hard ceiling', () => {
    expect(clampLiveLimit('Max order size', 1000, 25)).toBe(25)
  })

  it('floors a negative at zero', () => {
    expect(clampLiveLimit('Daily cap', -5, null)).toBe(0)
  })

  it('leaves a limit with no ceiling uncapped', () => {
    expect(clampLiveLimit('Daily cap', 999999999999, null)).toBe(999999999999)
  })

  // The reason this function exists. Every gate compares with `>` or `<=`, both false against
  // NaN, so storing NaN does not misconfigure the check -- it turns it off.
  it('refuses NaN rather than storing a limit that never trips', () => {
    expect(() => clampLiveLimit('Max order size', NaN, 25)).toThrow(/must be a real number/)
  })

  it('refuses Infinity, which the Settings input can produce from "1e999"', () => {
    expect(() => clampLiveLimit('Daily cap', Infinity, null)).toThrow(/must be a real number/)
    expect(() => clampLiveLimit('Daily loss limit', -Infinity, null)).toThrow(/must be a real number/)
  })

  it('names the limit and says it was not saved', () => {
    expect(() => clampLiveLimit('Daily loss limit', NaN, null)).toThrow(/Daily loss limit/)
    expect(() => clampLiveLimit('Daily loss limit', NaN, null)).toThrow(/not been saved/)
  })

  // Math.max(0, Math.min(NaN, hardMax)) is NaN, so the old clamp could not have caught this.
  it('does not let NaN slip past the hard ceiling', () => {
    expect(() => clampLiveLimit('Max order size', NaN, 25)).toThrow()
  })
})

describe('loadedLiveLimit', () => {
  it('keeps a good stored value', () => {
    expect(loadedLiveLimit(10, 99, 25)).toBe(10)
  })

  it('clamps a stored value above the ceiling', () => {
    expect(loadedLiveLimit(1000, 10, 25)).toBe(25)
  })

  // JSON cannot represent NaN or Infinity, so a file written before the guard holds null -- and
  // object spread keeps null over a default, since it only skips undefined.
  it('falls back to the default for a stored null', () => {
    expect(loadedLiveLimit(null, 15, null)).toBe(15)
  })

  it('falls back for undefined, strings and objects', () => {
    expect(loadedLiveLimit(undefined, 50, null)).toBe(50)
    expect(loadedLiveLimit('25', 50, null)).toBe(50)
    expect(loadedLiveLimit({}, 50, null)).toBe(50)
  })

  it('falls back rather than throwing, because the app still has to start', () => {
    expect(() => loadedLiveLimit(NaN, 10, 25)).not.toThrow()
    expect(loadedLiveLimit(NaN, 10, 25)).toBe(10)
    expect(loadedLiveLimit(Infinity, 50, null)).toBe(50)
  })

  it('floors a stored negative at zero rather than defaulting', () => {
    expect(loadedLiveLimit(-3, 50, null)).toBe(0)
  })
})

describe('describeUnusableOrderSize', () => {
  it('accepts an ordinary order size', () => {
    expect(describeUnusableOrderSize(10)).toBeNull()
    expect(describeUnusableOrderSize(0.5)).toBeNull()
  })

  // Every check in canPlaceLiveOrder is a `>` comparison, and all of them are false for NaN, so
  // NaN passed the whole gate and reached a real order placement.
  it('rejects NaN, which passed every threshold check', () => {
    expect(describeUnusableOrderSize(NaN)).toContain('must be a real number')
  })

  it('rejects both infinities', () => {
    expect(describeUnusableOrderSize(Infinity)).toContain('must be a real number')
    expect(describeUnusableOrderSize(-Infinity)).toContain('must be a real number')
  })

  // Typeable straight into the executor forms, which are number inputs.
  it('rejects a negative size', () => {
    expect(describeUnusableOrderSize(-5)).toContain('greater than 0')
  })

  it('rejects a zero size', () => {
    expect(describeUnusableOrderSize(0)).toContain('greater than 0')
  })

  it('reports the offending value so the reason is not a mystery', () => {
    expect(describeUnusableOrderSize(-5)).toContain('-5')
    expect(describeUnusableOrderSize(NaN)).toContain('NaN')
  })
})

describe('describeUntrustedLossTally', () => {
  it('trusts an ordinary tally, profit or loss or flat', () => {
    expect(describeUntrustedLossTally(-17)).toBeNull()
    expect(describeUntrustedLossTally(0)).toBeNull()
    expect(describeUntrustedLossTally(42.5)).toBeNull()
  })

  it('refuses a tally that could not be totalled', () => {
    // The limit is `realizedPnlToday <= -dailyLossLimitQuote`, false for NaN -- so one unusable
    // realized event does not skew the limit, it switches it off for the rest of the day.
    const reason = describeUntrustedLossTally(NaN)
    expect(reason).not.toBeNull()
    expect(reason).toContain('daily loss limit cannot be enforced')
    expect(reason).toContain('blocked')
  })

  it('refuses an infinite tally in both directions', () => {
    // -Infinity happens to block via the `<=` test, but only by accident, and +Infinity does not
    // block at all. Neither is a number this gate should be reasoning about.
    expect(describeUntrustedLossTally(Infinity)).not.toBeNull()
    expect(describeUntrustedLossTally(-Infinity)).not.toBeNull()
  })
})

describe('the share a real order from a call risks (8 October 2026)', () => {
  it('is one of its choices, read back as one, else the default', () => {
    expect(LIVE_RISK_PCT_CHOICES).toEqual([0.1, 0.25, 0.5, 1, 2])
    expect(DEFAULT_LIVE_RISK_PCT).toBe(0.25)
    for (const choice of LIVE_RISK_PCT_CHOICES) expect(healLiveRiskPct(choice)).toBe(choice)
    for (const bad of [undefined, null, '1', 3, Number.NaN, Number.POSITIVE_INFINITY]) expect(healLiveRiskPct(bad)).toBe(0.25)
    expect(liveRiskPctProblem(1)).toBeNull()
    expect(liveRiskPctProblem(3)).toMatch(/risks 0.1, 0.25, 0.5, 1, 2% of the allocation/)
  })
})
