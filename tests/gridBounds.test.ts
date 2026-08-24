import { describe, it, expect } from 'vitest'
import { describeGridBoundsProblem } from '../src/executors/gridBounds'

const at = (startPrice: number, endPrice: number, lastPrice: number | null = null) =>
  describeGridBoundsProblem({ startPrice, endPrice, lastPrice })

describe('describeGridBoundsProblem', () => {
  it('accepts a range that brackets the current price', () => {
    expect(at(73522, 81261, 77400)).toEqual({ blocking: null, warning: null })
  })

  it('blocks an empty range, which is what unseeded defaults now look like', () => {
    // Previously `price ?? 100` filled these in with 95/105 on any pair, so a BTCUSDT grid that
    // could never fill was indistinguishable from one the user meant.
    expect(at(0, 0, 77400).blocking).toContain('Enter a start and end price')
    expect(at(0, 81261, 77400).blocking).not.toBeNull()
  })

  it('blocks a negative or non-finite bound', () => {
    expect(at(-5, 100, 50).blocking).not.toBeNull()
    expect(at(NaN, 100, 50).blocking).not.toBeNull()
    expect(at(100, Infinity, 50).blocking).not.toBeNull()
  })

  it('blocks a range with no width', () => {
    expect(at(77400, 77400, 77400).blocking).toContain('no range')
  })

  it('warns, but does not block, a grid placed below the market', () => {
    // A real strategy: park a grid under the price waiting for a dip. It must not be refused.
    const { blocking, warning } = at(60000, 65000, 77400)
    expect(blocking).toBeNull()
    expect(warning).toContain('below')
    expect(warning).toContain('77400')
  })

  it('warns about a grid placed above the market', () => {
    expect(at(90000, 95000, 77400).warning).toContain('above')
  })

  it('says nothing about position when no price is known yet', () => {
    // The bounds are usable; the app just cannot judge where they sit, and must not guess.
    expect(at(95, 105, null)).toEqual({ blocking: null, warning: null })
  })

  it('accepts bounds given in either order', () => {
    expect(at(81261, 73522, 77400)).toEqual({ blocking: null, warning: null })
  })
})
