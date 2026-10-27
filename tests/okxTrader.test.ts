import { describe, expect, it } from 'vitest'
import {
  OKX_LINES,
  okxCoinOf,
  okxEstimateOf,
  okxFundingOf,
  okxInstrumentsOf,
  okxOpenOf,
  okxPnlSeriesOf,
  okxPositionOf,
  okxStatsOf,
  okxTripOf
} from '../shared/traders/okx'

// AN OKX LEAD TRADER'S RECORD, READ (shared/traders/okx.ts; V8 Stage 7): USDT-margined perpetuals only; each closed
// position read field by field, OKX's profit kept as REPORTED and the app's own estimate beside it -- its move on its
// size, OKX's taker fee each way, and the funding OKX published over its hold, known only where the history reaches it;
// the positions open now, those a trader hides counted; the year's profit and figures.

const H = 3_600_000
const T0 = Date.UTC(2026, 9, 1, 6)
const INSTRUMENTS = okxInstrumentsOf([
  { instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctType: 'linear', settleCcy: 'USDT' },
  { instId: 'ETH-USDT-SWAP', ctVal: '0.1', ctType: 'linear', settleCcy: 'USDT' },
  { instId: 'BTC-USD-SWAP', ctVal: '100', ctType: 'inverse', settleCcy: 'BTC' },
  { instId: 'SOL-USDT-SWAP', ctVal: '0', ctType: 'linear', settleCcy: 'USDT' }
])
const position = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  subPosId: 's1',
  instId: 'BTC-USDT-SWAP',
  posSide: 'long',
  lever: '1E+1',
  mgnMode: 'cross',
  openAvgPx: '100',
  openTime: String(T0),
  closeAvgPx: '110',
  closeTime: String(T0 + 4 * H),
  subPos: '200',
  margin: '20',
  pnl: '19.5',
  pnlRatio: '0.975',
  ...over
})
// A rate at 08:00 -- within the 06:00 to 10:00 hold -- and at 00:00 and 16:00 outside it.
const RATES = okxFundingOf([
  { fundingTime: String(T0 - 6 * H), fundingRate: '0.0001', realizedRate: '0.0001' },
  { fundingTime: String(T0 + 2 * H), fundingRate: '0.0003', realizedRate: '0.0002' },
  { fundingTime: String(T0 + 2 * H), fundingRate: '0.0003', realizedRate: '0.0002' },
  { fundingTime: String(T0 + 10 * H), fundingRate: '0.0001' }
])

describe("OKX's instruments and funding", () => {
  it('reads only USDT-margined perpetuals with a contract value, and each funding time once, the rate realized where given', () => {
    expect(okxCoinOf('BTC-USDT-SWAP')).toBe('BTC')
    expect(okxCoinOf('1000PEPE-USDT-SWAP')).toBe('1000PEPE')
    expect(okxCoinOf('BTC-USD-SWAP')).toBeNull()
    expect(okxCoinOf('BTC-USDT-261225')).toBeNull()
    expect(okxCoinOf(7)).toBeNull()
    expect([...INSTRUMENTS.keys()]).toEqual(['BTC-USDT-SWAP', 'ETH-USDT-SWAP'])
    expect(INSTRUMENTS.get('ETH-USDT-SWAP')?.ctVal).toBe(0.1)
    expect(RATES.map((rate) => [rate.timeSec * 1000 - T0, rate.rate])).toEqual([
      [-6 * H, 0.0001],
      [2 * H, 0.0002],
      [10 * H, 0.0001]
    ])
  })
})

describe('a closed position', () => {
  it("keeps OKX's profit as REPORTED and estimates its own: the move on its size, the taker fee each way, the funding over its hold", () => {
    const read = okxPositionOf(position(), INSTRUMENTS, new Map([['BTC-USDT-SWAP', RATES]])) as NonNullable<ReturnType<typeof okxPositionOf>>
    expect(read).toMatchObject({ subPosId: 's1', coin: 'BTC', side: 'long', lever: 10, contracts: 200, qty: 2, pnl: 19.5, pnlRatio: 0.975, label: 'REPORTED' })
    // 2 BTC from 100 to 110: 20 moved; 0.05% of 200 and of 220; 0.02% of 200 paid at 08:00.
    expect(read.estimate?.grossUsdt).toBeCloseTo(20, 9)
    expect(read.estimate?.feesUsdt).toBeCloseTo((OKX_LINES.fees.takerPct / 100) * 420, 9)
    expect(read.estimate?.fundingUsdt).toBeCloseTo(-0.04, 9)
    expect(read.estimate?.netUsdt).toBeCloseTo(20 - 0.21 - 0.04, 9)
    const trip = okxTripOf(read)
    expect(trip).toMatchObject({ coin: 'BTC', side: 'long', entryPx: 100, exitPx: 110, maxSize: 2, entryNotional: 200, reportedPnl: 19.5, lever: 10, fills: 2 })
    expect(trip?.movePct).toBeCloseTo(10, 9)
    expect(trip?.net).toBeCloseTo(20 - 0.21 - 0.04, 9)
  })

  it('reads a short, and a net-mode position by the sign of its size; a short is paid a positive rate', () => {
    const short = okxPositionOf(position({ posSide: 'short', closeAvgPx: '90' }), INSTRUMENTS, new Map([['BTC-USDT-SWAP', RATES]]))
    expect(short?.side).toBe('short')
    expect(short?.estimate?.grossUsdt).toBeCloseTo(20, 9)
    expect(short?.estimate?.fundingUsdt).toBeCloseTo(0.04, 9)
    expect(okxTripOf(short as NonNullable<typeof short>)?.movePct).toBeCloseTo(10, 9)
    expect(okxPositionOf(position({ posSide: 'net', subPos: '-200' }), INSTRUMENTS, new Map())).toMatchObject({ side: 'short', contracts: 200 })
    expect(okxPositionOf(position({ posSide: 'net', subPos: '200' }), INSTRUMENTS, new Map())).toMatchObject({ side: 'long' })
  })

  it('knows no funding where the history does not reach the hold, and no estimate without a contract value', () => {
    const late = okxFundingOf([{ fundingTime: String(T0 + 9 * H), fundingRate: '0.0001' }])
    expect(okxPositionOf(position(), INSTRUMENTS, new Map([['BTC-USDT-SWAP', late]]))?.estimate).toMatchObject({ fundingUsdt: null })
    expect(okxPositionOf(position(), INSTRUMENTS, new Map())?.estimate?.fundingUsdt).toBeNull()
    expect(okxEstimateOf({ side: 'long', openAvgPx: 100, closeAvgPx: 101, openTimeMs: T0, closeTimeMs: T0 + H }, 1, undefined).netUsdt).toBeCloseTo(1 - 0.1005, 9)
    // An instrument without a contract value: the position is read, its estimate is not made, and it is no trip.
    const unpriced = okxPositionOf(position({ instId: 'DOGE-USDT-SWAP' }), INSTRUMENTS, new Map()) as NonNullable<ReturnType<typeof okxPositionOf>>
    expect(unpriced).toMatchObject({ coin: 'DOGE', qty: null, estimate: null })
    expect(okxTripOf(unpriced)).toBeNull()
  })

  it('refuses a position out of its shape, or on an instrument the app does not read', () => {
    for (const over of [
      { instId: 'BTC-USD-SWAP' },
      { subPosId: '' },
      { openAvgPx: '0' },
      { closeAvgPx: 'x' },
      { closeTime: String(T0 - 1) },
      { subPos: '0' },
      { pnl: '' },
      { posSide: 'both' }
    ]) {
      expect(okxPositionOf(position(over), INSTRUMENTS, new Map()), JSON.stringify(over)).toBeNull()
    }
    expect(okxPositionOf(null, INSTRUMENTS, new Map())).toBeNull()
  })
})

describe('what is open, and the year', () => {
  it('reads the positions OKX shows and counts those the trader hides, their unrealized result in all', () => {
    const open = okxOpenOf(
      [
        { instId: 'ETH-USDT-SWAP', subPos: '30', openAvgPx: '2000', markPx: '2100', posSide: 'short', lever: '3', upl: '-300', mgnMode: 'isolated', margin: '2000' },
        { instId: '', subPos: '', openAvgPx: '', posSide: 'long', upl: '12.5' },
        { instId: 'DOGE-USDT-SWAP', subPos: '10', openAvgPx: '0.2', posSide: 'long', upl: '1' }
      ],
      INSTRUMENTS,
      T0
    )
    expect(open).toMatchObject({ atMs: T0, hidden: 2, unrealized: -286.5 })
    expect(open.positions).toEqual([{ coin: 'ETH', size: -3, entryPx: 2000, positionValue: 6300, unrealizedPnl: -300, leverage: { type: 'isolated', value: 3 }, liquidationPx: null, marginUsed: 2000, fundingSinceOpen: null }])
  })

  it("reads the year's daily profit oldest first and its figures, each where given", () => {
    expect(okxPnlSeriesOf([{ beginTs: '2000', pnl: '5', pnlRatio: '0.5' }, { beginTs: '1000', pnl: '-1' }, { beginTs: 'x', pnl: '1' }])).toEqual([
      { timeMs: 1000, pnl: -1, pnlRatio: null },
      { timeMs: 2000, pnl: 5, pnlRatio: 0.5 }
    ])
    expect(okxStatsOf([{ winRatio: '0.618', profitDays: '55', lossDays: '34', investAmt: '9234.86', avgSubPosNotional: '', curCopyTraderPnl: '31333.99' }])).toEqual({
      winRatio: 0.618,
      profitDays: 55,
      lossDays: 34,
      investAmt: 9234.86,
      avgSubPosNotional: null,
      curCopyTraderPnl: 31333.99
    })
    expect(okxStatsOf([])).toBeNull()
  })
})
