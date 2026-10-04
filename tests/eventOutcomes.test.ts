import { beforeEach, describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import { EVENT_FOLLOW_MINUTES, moveAfterEvent, type MarketEvent } from '../shared/marketEvent'
import { clearSettledEventMoves, loadEventMoves } from '../src/explorer/eventOutcomes'

const T = Date.parse('2026-09-10T12:00:00Z') / 1000

/** Minute bars from `start`, each closing 0.1 above the last: bar n closes at 100.1 + 0.1n. */
function rising(start: number, count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({ time: start + i * 60, open: 100 + i * 0.1, high: 100.2 + i * 0.1, low: 100 + i * 0.1, close: 100.1 + i * 0.1, volume: 1 }))
}

function event(symbol: string, time: number, price = 100): MarketEvent {
  return {
    id: `binance:${symbol}:${time}`,
    exchange: 'binance',
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    time,
    type: 'breakout',
    direction: 'up',
    band: 'candidate',
    score: 80,
    components: { price: 80, volume: 80, volatility: 80, pressure: 80, breakout: 80 },
    price,
    returnsPct: { m1: 0, m5: 0, m15: 1, h1: 1, h4: 1 },
    moveSigmas: 5,
    volumeRatio: 8,
    rangeRatio: 4,
    live: null
  }
}

describe('moveAfterEvent', () => {
  const bars = rising(T, 300)

  it('measures from the event price to the close that many minutes after its bar opened', () => {
    // Fifteen minutes after T is the close of the bar that opened at T + 14 minutes.
    expect(moveAfterEvent({ time: T, price: 100 }, bars, 15, T + 100_000)).toBeCloseTo(((100.1 + 14 * 0.1) / 100 - 1) * 100, 10)
    expect(moveAfterEvent({ time: T, price: 100 }, bars, 240, T + 100_000)).toBeCloseTo(((100.1 + 239 * 0.1) / 100 - 1) * 100, 10)
  })

  it('is not known until that minute has closed', () => {
    const closesAt = T + 15 * 60
    expect(moveAfterEvent({ time: T, price: 100 }, bars, 15, closesAt - 1)).toBeNull()
    expect(moveAfterEvent({ time: T, price: 100 }, bars, 15, closesAt)).not.toBeNull()
  })

  it('is not known when the candle for it is missing', () => {
    const holed = bars.filter((bar) => bar.time !== T + 14 * 60)
    expect(moveAfterEvent({ time: T, price: 100 }, holed, 15, T + 100_000)).toBeNull()
    expect(moveAfterEvent({ time: T, price: 100 }, [], 15, T + 100_000)).toBeNull()
  })

  it('is not signed by the direction of the event', () => {
    const falling = bars.map((bar) => ({ ...bar, close: 200 - bar.close }))
    expect(moveAfterEvent({ time: T, price: 100 }, falling, 15, T + 100_000)).toBeLessThan(0)
  })
})

describe('loadEventMoves', () => {
  beforeEach(() => clearSettledEventMoves())

  it('asks for each pair once, from its first event to four hours past its last', async () => {
    const calls: { symbol: string; startSec: number; endSec: number }[] = []
    const now = T + 100_000
    const moves = await loadEventMoves([event('AAAUSDT', T), event('AAAUSDT', T + 3600), event('BBBUSDT', T + 600)], now, async (symbol, startSec, endSec) => {
      calls.push({ symbol, startSec, endSec })
      return rising(startSec, Math.ceil((endSec - startSec) / 60))
    })
    expect(calls.sort((a, b) => a.symbol.localeCompare(b.symbol))).toEqual([
      { symbol: 'AAAUSDT', startSec: T, endSec: T + 3600 + 240 * 60 },
      { symbol: 'BBBUSDT', startSec: T + 600, endSec: T + 600 + 240 * 60 }
    ])
    expect(moves.size).toBe(3)
    for (const result of moves.values()) {
      expect(result).toHaveLength(EVENT_FOLLOW_MINUTES.length)
      expect(result.every((move) => move !== null)).toBe(true)
    }
  })

  it('leaves a horizon that has not closed as unknown, and asks again next time', async () => {
    let calls = 0
    const fetch = async (_symbol: string, startSec: number, endSec: number): Promise<Candle[]> => {
      calls++
      return rising(startSec, Math.ceil((endSec - startSec) / 60))
    }
    // Twenty minutes after the event: fifteen minutes is known, an hour and four hours are not.
    const early = await loadEventMoves([event('AAAUSDT', T)], T + 20 * 60, fetch)
    const result = early.get(`binance:AAAUSDT:${T}`) as (number | null)[]
    expect(result[0]).not.toBeNull()
    expect(result[1]).toBeNull()
    expect(result[2]).toBeNull()
    await loadEventMoves([event('AAAUSDT', T)], T + 20 * 60, fetch)
    expect(calls).toBe(2)
  })

  it('stops asking about an event once every horizon has closed', async () => {
    let calls = 0
    const fetch = async (_symbol: string, startSec: number, endSec: number): Promise<Candle[]> => {
      calls++
      return rising(startSec, Math.ceil((endSec - startSec) / 60))
    }
    const first = await loadEventMoves([event('AAAUSDT', T)], T + 100_000, fetch)
    const second = await loadEventMoves([event('AAAUSDT', T)], T + 200_000, fetch)
    expect(calls).toBe(1)
    expect(second.get(`binance:AAAUSDT:${T}`)).toEqual(first.get(`binance:AAAUSDT:${T}`))
  })

  it('shows an event whose candles could not be fetched as unknown rather than dropping it', async () => {
    const moves = await loadEventMoves([event('AAAUSDT', T)], T + 100_000, async () => {
      throw new Error('exchange down')
    })
    expect(moves.get(`binance:AAAUSDT:${T}`)).toEqual([null, null, null])
  })
})
