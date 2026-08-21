import { describe, it, expect } from 'vitest'
import { simulateDca, dcaLevelPrice } from '../src/executors/engine'
import { roundTripFee } from '../shared/fees'
import type { Candle, DcaExecutorParams } from '../shared/ipc'

const c = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 0 })

const base = 100
const params: DcaExecutorParams = {
  side: 'buy',
  levels: [
    { priceOffsetPct: 1, amountQuote: 100 },  // 99
    { priceOffsetPct: 2, amountQuote: 200 }   // 98
  ],
  takeProfitPct: 10,
  stopLossPct: null,
  timeLimitSec: null
}

describe('dcaLevelPrice', () => {
  it('places buy levels below the base and sell levels above', () => {
    expect(dcaLevelPrice(100, { priceOffsetPct: 2, amountQuote: 1 }, 'buy')).toBeCloseTo(98, 9)
    expect(dcaLevelPrice(100, { priceOffsetPct: 2, amountQuote: 1 }, 'sell')).toBeCloseTo(102, 9)
  })
})

describe('simulateDca', () => {
  it('reports nothing filled while price stays above every level', () => {
    const s = simulateDca([c(1, 100, 101, 99.5, 100)], params, base)
    expect(s.fills).toHaveLength(0)
    expect(s.avgEntryPrice).toBeNull()
    expect(s.status).toBe('accumulating')
  })

  it('fills only the levels price actually reaches', () => {
    const s = simulateDca([c(1, 100, 100, 98.8, 99)], params, base)
    expect(s.fills).toHaveLength(1)
    expect(s.fills[0].price).toBeCloseTo(99, 9)
  })

  it('weights the average entry by quote amount, not level count', () => {
    const s = simulateDca([c(1, 100, 100, 97.5, 98)], params, base)
    expect(s.fills).toHaveLength(2)
    // 100 quote at 99 and 200 quote at 98 -> 300 / (100/99 + 200/98)
    const expected = 300 / (100 / 99 + 200 / 98)
    expect(s.avgEntryPrice).toBeCloseTo(expected, 9)
    expect(s.totalFilledQuote).toBe(300)
  })

  it('closes on take-profit from the average, net of fees', () => {
    const s = simulateDca([c(1, 100, 100, 97.5, 98), c(2, 98, 130, 98, 128)], params, base)
    expect(s.status).toBe('closed')
    const avg = 300 / (100 / 99 + 200 / 98)
    const exit = avg * 1.1
    const qty = 100 / 99 + 200 / 98
    expect(s.closePrice).toBeCloseTo(exit, 6)
    expect(s.realizedPnl).toBeCloseTo(qty * (exit - avg) - roundTripFee(qty, avg, exit), 6)
  })

  it('closes on stop-loss when configured', () => {
    const withStop: DcaExecutorParams = { ...params, stopLossPct: 5 }
    const s = simulateDca([c(1, 100, 100, 98.8, 99), c(2, 99, 99, 90, 92)], withStop, base)
    expect(s.status).toBe('closed')
    expect(s.realizedPnl!).toBeLessThan(0)
  })

  it('closes on a time limit even with no barrier hit', () => {
    const timed: DcaExecutorParams = { ...params, timeLimitSec: 10 }
    const s = simulateDca([c(1, 100, 100, 98.8, 99), c(100, 99, 99.5, 98.9, 99.2)], timed, base)
    expect(s.status).toBe('closed')
    expect(s.closedAt).toBe(100)
  })
})
