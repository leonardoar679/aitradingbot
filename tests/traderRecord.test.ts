import { describe, expect, it } from 'vitest'
import { traderRefOf, traderRefOfKey } from '../shared/traders/traderRef'
import {
  accountValueAt,
  hyperliquidAccountValuesOf,
  hyperliquidFillOf,
  hyperliquidFundingOf,
  hyperliquidLedgerOf,
  hyperliquidStateOf,
  isSpotCoin,
  perpCandidatesOf
} from '../shared/traders/hyperliquid'

// A PASTED TRADER AND THEIR HYPERLIQUID RECORD, READ (shared/traders/traderRef.ts, hyperliquid.ts; V8 Stage 6): a paste
// names a trader the app can read or is refused with why, and never fetched; the venue's answers are read field by
// field, anything out of its shape dropped.

const ADDRESS = '0x0B4B6beaca45fce66ca818fbd867ec3761ed2143'

describe('a pasted trader', () => {
  it('reads a Hyperliquid address, bare or in a link of the app or its explorers, kept in lower case', () => {
    const want = { ok: true, ref: { venue: 'hyperliquid', id: ADDRESS.toLowerCase(), key: `hyperliquid-${ADDRESS.toLowerCase()}` } }
    expect(traderRefOf(`  ${ADDRESS}  `)).toEqual(want)
    expect(traderRefOf(`https://app.hyperliquid.xyz/explorer/address/${ADDRESS}`)).toEqual(want)
    expect(traderRefOf(`https://hypurrscan.io/address/${ADDRESS}#fills`)).toEqual(want)
    expect(traderRefOf(`https://hyperdash.info/trader/${ADDRESS}`)).toEqual(want)
    expect(traderRefOf(`https://app.hyperliquid.xyz/portfolio?address=${ADDRESS}`)).toEqual(want)
    expect(traderRefOf('https://app.hyperliquid.xyz/trade/BTC')).toEqual({ ok: false, reason: 'That Hyperliquid link names no address (0x and forty letters and digits).' })
    // Thirty-nine or forty-one letters and digits are not an address.
    expect(traderRefOf(ADDRESS.slice(0, -1)).ok).toBe(false)
    expect(traderRefOf(`${ADDRESS}0`).ok).toBe(false)
  })

  it("reads an OKX lead trader's code, bare or in a profile link", () => {
    expect(traderRefOf('https://www.okx.com/copy-trading/account/AB12CD34EF56GH78?tab=swap')).toEqual({ ok: true, ref: { venue: 'okx', id: 'AB12CD34EF56GH78', key: 'okx-AB12CD34EF56GH78' } })
    expect(traderRefOf('https://okx.com/copy-trading/account/123456789012345678')).toEqual({ ok: true, ref: { venue: 'okx', id: '123456789012345678', key: 'okx-123456789012345678' } })
    expect(traderRefOf('AB12CD34EF56GH78')).toEqual({ ok: true, ref: { venue: 'okx', id: 'AB12CD34EF56GH78', key: 'okx-AB12CD34EF56GH78' } })
    expect(traderRefOf('https://www.okx.com/trade-spot/btc-usdt').ok).toBe(false)
  })

  it('refuses a Bitget, Binance or Bybit trader, a post, and anything else, each with why', () => {
    const reason = (raw: string): string => {
      const read = traderRefOf(raw)
      return read.ok ? 'read' : read.reason
    }
    expect(reason('https://www.bitget.com/copy-trading/trader/b1b8457485b13a5aaa94/futures')).toMatch(/^Bitget publishes no lead trader's trades without your own key/)
    expect(reason('https://www.binance.com/en/copy-trading/lead-details/4321')).toMatch(/^Binance publishes no trader's positions/)
    expect(reason('https://www.bybit.com/copyTrade/trade-center/detail?leaderMark=abc')).toMatch(/^Bybit publishes no trader's positions/)
    expect(reason('https://x.com/someone/status/1')).toMatch(/^A post is not a trader's record/)
    expect(reason('https://example.com/0x0b4b6beaca45fce66ca818fbd867ec3761ed2143')).toMatch(/^Traders are read from Hyperliquid and OKX only/)
    expect(reason('')).toMatch(/^Paste a Hyperliquid address/)
    expect(reason('x'.repeat(501))).toBe('That is too long to be an address or a link.')
    expect(reason('ftp://app.hyperliquid.xyz/0x0b4b6beaca45fce66ca818fbd867ec3761ed2143')).toBe('Only a web link is read.')
    expect(reason('not a link')).toMatch(/^Not a Hyperliquid address/)
  })

  it('reads a key back from a folder name, and nothing that is not one', () => {
    expect(traderRefOfKey(`hyperliquid-${ADDRESS.toLowerCase()}`)).toEqual({ venue: 'hyperliquid', id: ADDRESS.toLowerCase(), key: `hyperliquid-${ADDRESS.toLowerCase()}` })
    expect(traderRefOfKey('okx-AB12CD34EF56GH78')?.venue).toBe('okx')
    for (const key of [`hyperliquid-${ADDRESS}`, 'hyperliquid-0x12', 'okx-short', 'bitget-0x0b4b6beaca45fce66ca818fbd867ec3761ed2143', 'nokey', '../x']) expect(traderRefOfKey(key), key).toBeNull()
  })
})

const FILL = {
  coin: 'ETH',
  px: '2320.6',
  sz: '0.0069',
  side: 'A',
  time: 1793066573484,
  startPosition: '0.0069',
  dir: 'Close Long',
  closedPnl: '-0.00069',
  hash: '0x25b8',
  oid: 586839590456,
  crossed: true,
  fee: '0.006917',
  tid: 145470789837243,
  feeToken: 'USDC',
  twapId: null
}

describe("Hyperliquid's answers", () => {
  it('read a fill field by field, and drop one out of its shape', () => {
    expect(hyperliquidFillOf(FILL)).toEqual({
      coin: 'ETH',
      timeMs: 1793066573484,
      side: 'sell',
      px: 2320.6,
      sz: 0.0069,
      startPosition: 0.0069,
      dir: 'Close Long',
      closedPnl: -0.00069,
      fee: 0.006917,
      feeToken: 'USDC',
      crossed: true,
      tid: 145470789837243,
      oid: 586839590456,
      label: 'VERIFIED'
    })
    expect(hyperliquidFillOf({ ...FILL, side: 'B' })?.side).toBe('buy')
    expect(hyperliquidFillOf({ ...FILL, fee: '-0.001' })?.fee).toBe(-0.001)
    for (const over of [{ side: 'X' }, { px: '0' }, { sz: '-1' }, { time: 'soon' }, { coin: '' }, { startPosition: null }, { closedPnl: undefined }, { tid: 'x' }]) {
      expect(hyperliquidFillOf({ ...FILL, ...over }), JSON.stringify(over)).toBeNull()
    }
    expect(hyperliquidFillOf('fill')).toBeNull()
  })

  it('read a funding payment, and nothing else as one', () => {
    const payment = { time: 1786924800000, hash: '0x0', delta: { type: 'funding', coin: 'HYPE', usdc: '-0.000133', szi: '0.18', fundingRate: '0.0000125', nSamples: 1 } }
    expect(hyperliquidFundingOf(payment)).toEqual({ timeMs: 1786924800000, coin: 'HYPE', usdc: -0.000133, szi: 0.18, rate: 0.0000125 })
    expect(hyperliquidFundingOf({ ...payment, delta: { ...payment.delta, type: 'deposit' } })).toBeNull()
    expect(hyperliquidFundingOf({ ...payment, delta: { ...payment.delta, usdc: 'x' } })).toBeNull()
  })

  it('read money in as positive and out as negative, any other movement as the record gives it', () => {
    const update = (type: string, usdc: unknown): unknown => ({ time: 1, hash: '0x', delta: { type, usdc } })
    expect(hyperliquidLedgerOf(update('deposit', '18.0'))).toEqual({ timeMs: 1, type: 'deposit', usdc: 18 })
    expect(hyperliquidLedgerOf(update('withdraw', '5'))?.usdc).toBe(-5)
    expect(hyperliquidLedgerOf(update('vaultDeposit', '7'))?.usdc).toBe(-7)
    expect(hyperliquidLedgerOf(update('vaultWithdraw', '-7'))?.usdc).toBe(7)
    expect(hyperliquidLedgerOf(update('accountClassTransfer', '-3'))?.usdc).toBe(-3)
    expect(hyperliquidLedgerOf(update('spotGenesis', undefined))?.usdc).toBeNull()
    expect(hyperliquidLedgerOf({ time: 'x', delta: { type: 'deposit' } })).toBeNull()
  })

  it("read the account's open positions and value, an empty position left out", () => {
    const position = (coin: string, szi: string): unknown => ({
      type: 'oneWay',
      position: { coin, szi, leverage: { type: 'cross', value: 20 }, entryPx: '80032.0', positionValue: '199.3', unrealizedPnl: '0.027', returnOnEquity: '0.0027', liquidationPx: '65232.5', marginUsed: '9.96', maxLeverage: 40, cumFunding: { allTime: '0.0', sinceOpen: '-0.5', sinceChange: '0.0' } }
    })
    const state = hyperliquidStateOf({ marginSummary: { accountValue: '23.7', totalNtlPos: '210.4' }, assetPositions: [position('BTC', '0.00249'), position('ETH', '0.0')], time: 1793066820805 })
    expect(state).toEqual({
      atMs: 1793066820805,
      accountValue: 23.7,
      positions: [{ coin: 'BTC', size: 0.00249, entryPx: 80032, positionValue: 199.3, unrealizedPnl: 0.027, leverage: { type: 'cross', value: 20 }, liquidationPx: 65232.5, marginUsed: 9.96, fundingSinceOpen: -0.5 }]
    })
    expect(hyperliquidStateOf({ assetPositions: [] })).toBeNull()
  })

  it("merge every period of the account's value, the perpetuals' own left out, oldest first", () => {
    const values = hyperliquidAccountValuesOf([
      ['day', { accountValueHistory: [[300, '3'], [400, '4']], pnlHistory: [], vlm: '0' }],
      ['allTime', { accountValueHistory: [[100, '1'], [300, '3']], pnlHistory: [], vlm: '0' }],
      ['perpAllTime', { accountValueHistory: [[200, '99']], pnlHistory: [], vlm: '0' }],
      'noise'
    ])
    expect(values).toEqual([
      { timeMs: 100, value: 1 },
      { timeMs: 300, value: 3 },
      { timeMs: 400, value: 4 }
    ])
    expect(accountValueAt(values, 99)).toBeNull()
    expect(accountValueAt(values, 100)).toBe(1)
    expect(accountValueAt(values, 350)).toBe(3)
    expect(accountValueAt(values, 10_000)).toBe(4)
    expect(hyperliquidAccountValuesOf('x')).toEqual([])
  })

  it("names a spot pair as such, and a coin's perpetuals on the venues as they write them", () => {
    expect(isSpotCoin('@107')).toBe(true)
    expect(isSpotCoin('PURR/USDC')).toBe(true)
    expect(isSpotCoin('BTC')).toBe(false)
    expect(perpCandidatesOf('BTC')).toEqual(['BTCUSDT', '1000BTCUSDT'])
    expect(perpCandidatesOf('kPEPE')).toEqual(['1000PEPEUSDT', 'PEPEUSDT', '1000000PEPEUSDT'])
    expect(perpCandidatesOf('KAITO')).toEqual(['KAITOUSDT', '1000KAITOUSDT'])
    for (const coin of ['@107', 'PURR/USDC', 'xyz:META', 'A-B']) expect(perpCandidatesOf(coin), coin).toEqual([])
  })
})
