import { describe, expect, it } from 'vitest'
import { classifyPaperOrder, paperOrderStatusNote } from '../src/trade/paperOrderStatus'

// The Trade page is manual paper trading, so its only value is telling the truth about what
// would have happened. A fill it cannot confirm is worse than no answer at all.

describe('classifyPaperOrder', () => {
  it('fills a market order', () => {
    expect(classifyPaperOrder('market', 'buy', 100, 100)).toBe('filled')
    expect(classifyPaperOrder('market', 'sell', 100, 100)).toBe('filled')
  })

  it('fills a buy limit at or above the live price', () => {
    expect(classifyPaperOrder('limit', 'buy', 101, 100)).toBe('filled')
    expect(classifyPaperOrder('limit', 'buy', 100, 100)).toBe('filled')
  })

  it('rests a buy limit below the live price', () => {
    expect(classifyPaperOrder('limit', 'buy', 99, 100)).toBe('resting')
  })

  it('fills a sell limit at or below the live price', () => {
    expect(classifyPaperOrder('limit', 'sell', 99, 100)).toBe('filled')
    expect(classifyPaperOrder('limit', 'sell', 100, 100)).toBe('filled')
  })

  it('rests a sell limit above the live price', () => {
    expect(classifyPaperOrder('limit', 'sell', 101, 100)).toBe('resting')
  })

  it('reports a limit order submitted with no live price as unpriced, not filled', () => {
    // Reachable on a thin pair or a stalled feed, where no trade has arrived to price against.
    // This used to fall through to 'filled' — inventing a fill nothing had confirmed, and
    // contradicting the rule the page itself documents.
    expect(classifyPaperOrder('limit', 'buy', 100, null)).toBe('unpriced')
    expect(classifyPaperOrder('limit', 'sell', 100, null)).toBe('unpriced')
  })
})

describe('paperOrderStatusNote', () => {
  it('says nothing extra for a fill', () => {
    expect(paperOrderStatusNote('filled')).toBeNull()
  })

  it('explains resting and unpriced differently', () => {
    const resting = paperOrderStatusNote('resting')
    const unpriced = paperOrderStatusNote('unpriced')

    expect(resting).toContain('would not have filled')
    // An unpriced order must not claim it would not have filled either — that is equally unknown.
    expect(unpriced).toContain('unknown')
    expect(unpriced).not.toBe(resting)
  })
})
