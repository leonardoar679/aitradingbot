import { describe, expect, it } from 'vitest'
import { LIQUIDITY_LINES, depthWithin, liquidityVerdictOf } from '../shared/liquidityGate'

// THE GATE ON A MOVE THAT IS LARGE ONLY BECAUSE ITS BOOK IS THIN (shared/liquidityGate.ts; V8 Stage 2): no book,
// an old book, a book that cannot hold the stake, a thin book, or a crossing that costs more than half the move,
// each refused with its reason; a deep book and a move worth crossing it for, passed with its round trip.

/** A book around 100: `levels` each side, each `size` units, a tick apart. */
function book(levels: number, size: number, tick = 0.01, mid = 100): { bids: [number, number][]; asks: [number, number][] } {
  const half = tick / 2
  return {
    bids: Array.from({ length: levels }, (_, k) => [mid - half - k * tick, size] as [number, number]),
    asks: Array.from({ length: levels }, (_, k) => [mid + half + k * tick, size] as [number, number])
  }
}

const base = { venue: 'binance' as const, feePct: 0.1, side: 'BUY' as const, stakeQuote: 1000, bookAgeMs: 1000, predictedMovePct: 3 }

describe('the liquidity gate', () => {
  it('passes a deep book and a move worth crossing it for, with its round trip', () => {
    const verdict = liquidityVerdictOf({ ...base, levels: book(50, 100) })
    expect(verdict.ok).toBe(true)
    if (verdict.ok) {
      expect(verdict.trip.basis).toBe('book')
      expect(verdict.trip.totalPct).toBeCloseTo(0.2 + 0.01, 3)
      expect(verdict.depthQuote).toBeGreaterThan(5 * 1000)
    }
  })

  it('recommends nothing without a book: the cost is not measured', () => {
    expect(liquidityVerdictOf({ ...base, levels: null })).toMatchObject({ ok: false, code: 'no-book' })
    expect(liquidityVerdictOf({ ...base, levels: { bids: [], asks: [[100, 1]] } })).toMatchObject({ ok: false, code: 'no-book' })
  })

  it('reads no book older than half a minute, nor one of unknown age', () => {
    expect(liquidityVerdictOf({ ...base, levels: book(50, 100), bookAgeMs: LIQUIDITY_LINES.maxBookAgeMs })).toMatchObject({ ok: true })
    expect(liquidityVerdictOf({ ...base, levels: book(50, 100), bookAgeMs: LIQUIDITY_LINES.maxBookAgeMs + 1 })).toMatchObject({ ok: false, code: 'stale-book' })
    expect(liquidityVerdictOf({ ...base, levels: book(50, 100), bookAgeMs: null })).toMatchObject({ ok: false, code: 'stale-book' })
  })

  it('refuses a book whose levels do not hold the stake, never costing it at the flat slippage', () => {
    // Ten levels of 0.5 units at 100: 500 a side, under the stake of 1,000.
    expect(liquidityVerdictOf({ ...base, levels: book(10, 0.5) })).toMatchObject({ ok: false, code: 'cannot-hold' })
  })

  it('refuses a book that holds the stake but under five stakes near the mid', () => {
    // 40 levels of 1 unit: the stake fits, but within half a percent (50 levels of a cent) there is 4,000.
    const verdict = liquidityVerdictOf({ ...base, levels: book(40, 1) })
    expect(verdict).toMatchObject({ ok: false, code: 'thin' })
    // Forty levels of a unit from 100.005 up: 4,008 in all.
    expect(depthWithin(book(40, 1), 'BUY', 0.5)).toBeCloseTo(4008, 6)
    // Levels beyond the band do not count.
    expect(depthWithin(book(200, 10), 'BUY', 0.05)).toBeCloseTo(5 * 10 * 100, -2)
  })

  it('refuses a move that the crossing would mostly eat, and passes it where the move is larger', () => {
    // A wide book: a dollar a tick, its first level holding the stake, so crossing it costs its 1% spread.
    const wide = book(60, 200, 1)
    // Half of a 2% move is 1%: not more than it, so passed; half of 1.5% is under the spread, so refused.
    expect(liquidityVerdictOf({ ...base, levels: wide, predictedMovePct: 2 })).toMatchObject({ ok: true })
    const small = liquidityVerdictOf({ ...base, levels: wide, predictedMovePct: 1.5 })
    expect(small).toMatchObject({ ok: false, code: 'cost-share' })
    if (!small.ok) expect(small.reason).toMatch(/the move is large mostly because the pair is thin/)
    expect(liquidityVerdictOf({ ...base, levels: wide, predictedMovePct: 4 })).toMatchObject({ ok: true })
    // A size call alone has no move to weigh it against.
    expect(liquidityVerdictOf({ ...base, levels: wide, predictedMovePct: null })).toMatchObject({ ok: true })
  })

  it('reads the side a trade takes: a sell against the bids', () => {
    const lopsided = { bids: book(50, 100).bids, asks: book(3, 0.1).asks }
    expect(liquidityVerdictOf({ ...base, side: 'SELL', levels: lopsided })).toMatchObject({ ok: false, code: 'cannot-hold' })
    expect(depthWithin(lopsided, 'SELL', 0.5)).toBeGreaterThan(5000)
  })
})
