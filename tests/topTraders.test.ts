import { describe, expect, it } from 'vitest'
import { readSourcePrediction } from '../shared/evaluation/predictionRecord'
import { TOP_TRADERS_LINES, baseOfCoin, consensusOf, holdingsOf, okxSidesOf, topTraderPredictionsOf, type TraderHolding } from '../shared/traders/topTraders'

// WHAT THE FOUND TRADERS HOLD (shared/traders/topTraders.ts; V9 Stage 4, V9-TOP-TRADERS-2): each found trader's net
// side on each coin, the coins of the forecast's universe at least three hold, the way at least two thirds of them
// hold called, and the calls as the source 'top-traders' over a day, scored net of a 0.24% round trip.

const MADE = Date.UTC(2026, 10, 7, 0, 3) / 1000

describe('a trader’s holdings', () => {
  it('are one side a coin, by the net size, the venue’s thousands read as the coin', () => {
    expect(baseOfCoin('kPEPE')).toBe('PEPE')
    expect(baseOfCoin('BTC')).toBe('BTC')
    expect(baseOfCoin('k')).toBe('K')
    expect(
      holdingsOf('hyperliquid-0x1', [
        { coin: 'BTC', size: 0.5 },
        { coin: 'ETH', size: -2 },
        { coin: 'kPEPE', size: 1000 },
        { coin: 'SOL', size: 3 },
        { coin: 'SOL', size: -3 },
        { coin: 'XRP', size: 0 }
      ])
    ).toEqual([
      { traderKey: 'hyperliquid-0x1', coin: 'BTC', side: 'long' },
      { traderKey: 'hyperliquid-0x1', coin: 'ETH', side: 'short' },
      { traderKey: 'hyperliquid-0x1', coin: 'PEPE', side: 'long' }
    ])
  })

  it('read from OKX by its position side, or its own sign in net mode, its perpetuals only', () => {
    expect(
      okxSidesOf([
        { instId: 'BTC-USDT-SWAP', subPos: '10', posSide: 'long' },
        { instId: 'ETH-USDT-SWAP', subPos: '5', posSide: 'short' },
        { instId: 'SOL-USDT-SWAP', subPos: '-4', posSide: 'net' },
        { instId: 'BTC-USD-SWAP', subPos: '1', posSide: 'long' },
        { instId: 'DOGE-USDT-SWAP', subPos: '0', posSide: 'long' },
        null
      ])
    ).toEqual([
      { coin: 'BTC', size: 1 },
      { coin: 'ETH', size: -1 },
      { coin: 'SOL', size: -1 }
    ])
  })
})

describe('the found traders’ consensus', () => {
  const held = (key: string, coin: string, side: 'long' | 'short'): TraderHolding => ({ traderKey: key, coin, side })

  it('calls a way where at least three hold the coin and two thirds of them hold it that way, each trader once', () => {
    const holdings = [
      held('a', 'BTC', 'long'),
      held('b', 'BTC', 'long'),
      held('c', 'BTC', 'short'),
      held('d', 'ETH', 'short'),
      held('e', 'ETH', 'short'),
      held('f', 'ETH', 'short'),
      held('g', 'ETH', 'long'),
      held('h', 'SOL', 'long'),
      held('i', 'SOL', 'long'),
      held('j', 'XRP', 'long'),
      held('k', 'XRP', 'short'),
      held('l', 'XRP', 'long'),
      held('m', 'XRP', 'short'),
      // A trader read twice on a coin counts once, as last read.
      held('d', 'ETH', 'long'),
      held('z', 'NOTINUSE', 'long'),
      held('y', 'NOTINUSE', 'long'),
      held('x', 'NOTINUSE', 'long')
    ]
    const universe = new Set(['BTC', 'ETH', 'SOL', 'XRP'])
    expect(consensusOf(holdings, universe)).toEqual([
      { coin: 'ETH', longs: 2, shorts: 2, holders: 4, side: null },
      { coin: 'XRP', longs: 2, shorts: 2, holders: 4, side: null },
      { coin: 'BTC', longs: 2, shorts: 1, holders: 3, side: 'up' },
      { coin: 'SOL', longs: 2, shorts: 0, holders: 2, side: null }
    ])
    expect(consensusOf(holdings, null).find((entry) => entry.coin === 'NOTINUSE')).toMatchObject({ holders: 3, side: 'up' })
    expect(consensusOf([held('a', 'BTC', 'short'), held('b', 'BTC', 'short'), held('c', 'BTC', 'long')])).toEqual([{ coin: 'BTC', longs: 1, shorts: 2, holders: 3, side: 'down' }])
    expect(TOP_TRADERS_LINES).toMatchObject({ minHolders: 3, minShare: 2 / 3, horizonSec: 86_400, roundTripPct: 0.24, readWindowSec: 7200 })
  })

  it("is recorded as a day's direction calls of the source 'top-traders', each a line the record reads back", () => {
    const consensus = [
      { coin: 'BTC', longs: 5, shorts: 1, holders: 6, side: 'up' as const },
      { coin: 'ETH', longs: 1, shorts: 3, holders: 4, side: 'down' as const },
      { coin: 'SOL', longs: 2, shorts: 2, holders: 4, side: null },
      { coin: 'NOPRICE', longs: 3, shorts: 0, holders: 3, side: 'up' as const }
    ]
    const made = topTraderPredictionsOf(consensus, MADE, new Map([['BTCUSDT', 70_000], ['ETHUSDT', 2_500], ['SOLUSDT', 150]]), 9, { engine: 'e', config: 'c' })
    expect(made.map((line) => [line.id, line.pair, line.side, line.horizonSec, line.refPrice])).toEqual([
      [`top-traders:BTCUSDT:${MADE}:1`, 'BTCUSDT', 'up', 86_400, 70_000],
      [`top-traders:ETHUSDT:${MADE}:2`, 'ETHUSDT', 'down', 86_400, 2_500]
    ])
    expect(made[0]).toMatchObject({ source: 'top-traders', sourceVersion: 'top-traders-v1', kind: 'direction', venue: 'binance', cost: { roundTripPct: 0.24 }, unit: Math.floor(MADE / 86_400) })
    expect(made[0].reason).toBe('5 of the 6 found traders holding BTC hold it long (9 found traders read)')
    expect(made[1].reason).toBe('3 of the 4 found traders holding ETH hold it short (9 found traders read)')
    for (const line of made) expect(readSourcePrediction(line), line.id).not.toBeNull()
  })
})
