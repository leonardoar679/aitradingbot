import { describe, it, expect } from 'vitest'
import { commissionInQuote, observedFeeRate, describeFeeRateMismatch, FEE_RATE_TOLERANCE } from '../shared/observedFee'
import { FEE_RATE } from '../shared/fees'

describe('commissionInQuote', () => {
  it('takes a quote-asset commission at face value', () => {
    expect(commissionInQuote({ USDT: 0.75 }, 'BTC', 'USDT', 75000)).toBe(0.75)
  })

  // A buy is charged in the base asset, so it has to be valued at the fill price.
  it('converts a base-asset commission at the fill price', () => {
    expect(commissionInQuote({ BTC: 0.00001 }, 'BTC', 'USDT', 75000)).toBeCloseTo(0.75, 10)
  })

  it('sums a commission split across both assets', () => {
    expect(commissionInQuote({ USDT: 0.5, BTC: 0.00001 }, 'BTC', 'USDT', 75000)).toBeCloseTo(1.25, 10)
  })

  // A BNB commission needs a BNB/quote rate the app has no table for. Guessing would understate
  // the fee while looking exact.
  it('refuses a commission taken in an asset it cannot value', () => {
    expect(commissionInQuote({ BNB: 0.002 }, 'BTC', 'USDT', 75000)).toBeNull()
  })

  it('refuses the whole total when only part of it is unconvertible', () => {
    expect(commissionInQuote({ USDT: 0.5, BNB: 0.002 }, 'BTC', 'USDT', 75000)).toBeNull()
  })

  it('ignores a zero entry in an asset it could not otherwise value', () => {
    expect(commissionInQuote({ USDT: 0.5, BNB: 0 }, 'BTC', 'USDT', 75000)).toBe(0.5)
  })

  it('is zero when no commission was charged at all', () => {
    expect(commissionInQuote({}, 'BTC', 'USDT', 75000)).toBe(0)
  })

  it('refuses a base commission with no usable price', () => {
    expect(commissionInQuote({ BTC: 0.00001 }, 'BTC', 'USDT', 0)).toBeNull()
  })

  it('refuses negative or non-finite amounts', () => {
    expect(commissionInQuote({ USDT: -1 }, 'BTC', 'USDT', 75000)).toBeNull()
    expect(commissionInQuote({ USDT: NaN }, 'BTC', 'USDT', 75000)).toBeNull()
  })
})

describe('observedFeeRate', () => {
  it('is commission over notional', () => {
    expect(observedFeeRate(0.75, 750)).toBeCloseTo(0.001, 10)
  })

  it('reports the BNB-discounted tier correctly', () => {
    expect(observedFeeRate(0.5625, 750)).toBeCloseTo(0.00075, 10)
  })

  it('refuses a zero or missing notional rather than dividing by it', () => {
    expect(observedFeeRate(0.75, 0)).toBeNull()
    expect(observedFeeRate(0.75, -10)).toBeNull()
  })
})

describe('describeFeeRateMismatch', () => {
  it('says nothing when the model matches what was charged', () => {
    expect(describeFeeRateMismatch(FEE_RATE)).toBeNull()
  })

  it('says nothing when nothing has been observed yet', () => {
    expect(describeFeeRateMismatch(null)).toBeNull()
  })

  it('tolerates rounding noise on a small fill', () => {
    expect(describeFeeRateMismatch(FEE_RATE + FEE_RATE_TOLERANCE / 2)).toBeNull()
  })

  // 0.1% modelled vs 0.075% actually charged is the standard-versus-BNB-discount case.
  it('reports a discounted tier, and which way the numbers are wrong', () => {
    const msg = describeFeeRateMismatch(0.00075, 0.001)
    expect(msg).toContain('0.075%')
    expect(msg).toContain('0.1%')
    expect(msg).toContain('less')
    expect(msg).toContain('worse')
    expect(msg).toContain('FEE_RATE')
  })

  it('reports a higher real fee as flattering the figures on screen', () => {
    const msg = describeFeeRateMismatch(0.002, 0.001)
    expect(msg).toContain('more')
    expect(msg).toContain('better')
  })

  // The point of saying anything: this constant moves a real safety threshold, not just a label.
  it('names the daily loss limit, not only the P&L display', () => {
    expect(describeFeeRateMismatch(0.00075, 0.001)).toContain('daily loss limit')
  })
})
