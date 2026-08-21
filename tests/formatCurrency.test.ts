import { describe, it, expect } from 'vitest'
import { formatQuotePrice, isUsdLikeQuote } from '../src/utils/formatCurrency'

describe('formatQuotePrice', () => {
  it('keeps real precision for sub-cent coins instead of collapsing to $0.00', () => {
    expect(formatQuotePrice(0.00004321, 'USDT')).toBe('$0.00004321')
    expect(formatQuotePrice(0.001234, 'USDT')).toBe('$0.001234')
    expect(formatQuotePrice(0.0000012, 'USDT')).not.toBe('$0.00')
  })

  it('is unchanged at or above a cent', () => {
    expect(formatQuotePrice(0.01, 'USDT')).toBe('$0.01')
    expect(formatQuotePrice(1.2345, 'USDT')).toBe('$1.23')
    expect(formatQuotePrice(64346.65, 'USDT')).toBe('$64,346.65')
  })

  it('respects currencies that are not decimal', () => {
    expect(formatQuotePrice(94500000, 'KRW')).toBe('₩94,500,000')
  })

  it('suffixes crypto quotes rather than prefixing a symbol', () => {
    expect(formatQuotePrice(0.03, 'BTC')).toBe('0.03000000 BTC')
  })

  it('treats the dollar family as summable and others not', () => {
    expect(['USD', 'USDT', 'USDC'].every(isUsdLikeQuote)).toBe(true)
    expect(isUsdLikeQuote('KRW')).toBe(false)
  })
})
