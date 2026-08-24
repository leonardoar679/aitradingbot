import { describe, it, expect } from 'vitest'
import { floorToStep, stepPrecision } from '../electron/services/exchanges/binanceTrading'

// Binance rejects any quantity that isn't an exact multiple of LOT_SIZE stepSize, and rejects
// exponential notation outright.
// Validates the decimal STRING the exchange parses, using integer maths (float modulo never
// returns an exact zero here and would give a false negative).
function isValidMultiple(out: string, step: string): boolean {
  const p = stepPrecision(step)
  const scaled = Math.round(Number(out) * Math.pow(10, p))
  const stepScaled = Math.round(Number(step) * Math.pow(10, p))
  return stepScaled > 0 && scaled % stepScaled === 0
}

const cases: [number, string][] = [
  [10 / 43217.5, '0.00001000'],  // the reported LOT_SIZE failure
  [0.0000001, '0.00000001'],     // would serialise as "1e-7"
  [1.23456789, '0.00100000'],
  [500 / 3.21, '0.10000000'],
  [0.999999, '0.00001000'],
  [43217.567, '0.01000000'],
  [7.5, '1.00000000']
]

describe('binance step/tick rounding', () => {
  it.each(cases)('%s at step %s lands on an exact multiple', (value, step) => {
    expect(isValidMultiple(floorToStep(value, step), step)).toBe(true)
  })

  it.each(cases)('%s at step %s never rounds UP', (value, step) => {
    expect(Number(floorToStep(value, step))).toBeLessThanOrEqual(value)
  })

  it.each(cases)('%s at step %s never uses exponential notation', (value, step) => {
    expect(floorToStep(value, step)).not.toContain('e')
  })

  it('reads precision from the step string', () => {
    expect(stepPrecision('0.00001000')).toBe(5)
    expect(stepPrecision('1.00000000')).toBe(0)
    expect(stepPrecision('0.01000000')).toBe(2)
  })

  it('floors a sub-step quantity to zero so the caller can refuse it', () => {
    expect(Number(floorToStep(0.000004, '0.00001000'))).toBe(0)
  })
})

describe('floorToStep with an unusable step', () => {
  // getSymbolFilters takes stepSize straight from the exchange response. A "0", an empty string
  // or anything unparseable makes `value / stepNum` NaN, and "NaN" would go out as the order
  // quantity. The guard against that used plain toFixed, which rounds -- so it produced a
  // quantity LARGER than asked for, the one direction this function promises never to go.
  for (const step of ['0', '', 'abc', 'null']) {
    it(`floors rather than rounds when the step is ${JSON.stringify(step)}`, () => {
      expect(Number(floorToStep(1.5, step))).toBeLessThanOrEqual(1.5)
      expect(Number(floorToStep(1.9, step))).toBeLessThanOrEqual(1.9)
    })

    it(`never emits NaN when the step is ${JSON.stringify(step)}`, () => {
      expect(Number.isFinite(Number(floorToStep(1.5, step)))).toBe(true)
    })
  }

  it('keeps flooring a usable step, unchanged', () => {
    expect(floorToStep(1.5009, '0.00100000')).toBe('1.500')
    expect(Number(floorToStep(1.5009, '0.00100000'))).toBeLessThanOrEqual(1.5009)
  })

  it('never exceeds the requested quantity for any step it is given', () => {
    // The property that matters when closing: selling more than is held is rejected outright,
    // leaving a position the user is trying to exit stuck open.
    for (const step of ['0.00000001', '0.001', '1.00000000', '0', '', 'abc']) {
      for (const qty of [0.9, 1.5, 1.999, 123.456]) {
        expect(Number(floorToStep(qty, step))).toBeLessThanOrEqual(qty)
      }
    }
  })
})
