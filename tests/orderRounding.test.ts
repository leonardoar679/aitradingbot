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
