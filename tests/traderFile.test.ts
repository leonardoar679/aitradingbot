import { describe, expect, it } from 'vitest'
import { roundTripsOf } from '../shared/traders/roundTrips'
import { TRADER_FILE_LINES, csvRowsOf, fileCoinOf, fileNumberOf, fileTimeOf, traderFileOf } from '../shared/traders/traderFile'

// A FILE OF A TRADER'S TRADES (shared/traders/traderFile.ts; V8 Stage 7): CSV or JSON, at most 5 MB, UNVERIFIABLE; read
// as fills -- each coin's position taken as flat where the file starts -- or as round trips; every row checked, a row out
// of its shape refused and counted, the first few with why; a time without a zone read as UTC.

const NOW = Date.UTC(2026, 9, 27, 12)

describe('the pieces of a row', () => {
  it("reads a CSV's rows, its separator the header's, quoted fields holding separators, quotes and line breaks", () => {
    expect(csvRowsOf('a,b,c\r\n1,"x, y",3\n\n4,"say ""hi""","multi\nline"\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', '3'],
      ['4', 'say "hi"', 'multi\nline']
    ])
    expect(csvRowsOf('a;b\n1,5;2')).toEqual([
      ['a', 'b'],
      ['1,5', '2']
    ])
    expect(csvRowsOf('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
  })

  it('reads numbers as exports write them, with separators and units', () => {
    expect(fileNumberOf('1,234.5')).toBe(1234.5)
    expect(fileNumberOf(' -0.5 USDT ')).toBe(-0.5)
    expect(fileNumberOf('3e-4')).toBe(0.0003)
    expect(fileNumberOf(42)).toBe(42)
    expect(fileNumberOf('12,34')).toBeNull()
    expect(fileNumberOf('abc')).toBeNull()
    expect(fileNumberOf('')).toBeNull()
    expect(fileNumberOf(Number.NaN)).toBeNull()
  })

  it('reads times in epoch seconds or milliseconds, ISO 8601 with its zone, and a date and time without one as UTC', () => {
    const t = Date.UTC(2026, 9, 26, 13, 5, 7)
    expect(fileTimeOf(t)).toBe(t)
    expect(fileTimeOf(t / 1000)).toBe(t)
    expect(fileTimeOf(String(t))).toBe(t)
    expect(fileTimeOf(String(t / 1000))).toBe(t)
    expect(fileTimeOf('2026-10-26 13:05:07')).toBe(t)
    expect(fileTimeOf('2026-10-26T13:05:07.250Z')).toBe(t + 250)
    expect(fileTimeOf('2026-10-26T15:05:07+02:00')).toBe(t)
    expect(fileTimeOf('2026-10-26T08:05:07-0500')).toBe(t)
    expect(fileTimeOf('2026-10-26 13:05')).toBe(t - 7000)
    expect(fileTimeOf('2026-02-30 10:00:00')).toBeNull()
    expect(fileTimeOf('2026-13-01 10:00:00')).toBeNull()
    expect(fileTimeOf('10/26/2026 13:05')).toBeNull()
    expect(fileTimeOf(12345)).toBeNull()
  })

  it("reads a symbol's coin however a venue writes it", () => {
    expect(['BTCUSDT', 'BTC-USDT-SWAP', 'BTC/USDT:USDT', 'btc_usdt', 'BTC-PERP', 'BTC', 'BTCUSD'].map(fileCoinOf)).toEqual(['BTC', 'BTC', 'BTC', 'BTC', 'BTC', 'BTC', 'BTC'])
    expect(fileCoinOf('1000PEPEUSDT')).toBe('1000PEPE')
    expect(fileCoinOf('Bitcoin / Dollar')).toBeNull()
    expect(fileCoinOf(5)).toBeNull()
  })
})

describe('a file', () => {
  it("is read as fills, each coin flat where the file starts, its refused rows counted with the first few reasons", () => {
    const csv = [
      'Date(UTC),Symbol,Side,Price,Quantity,Fee,Realized Profit',
      '2026-10-01 01:00:00,BTCUSDT,BUY,100,2,0.1 USDT,0',
      '2026-10-01 02:00:00,ETHUSDT,SELL,2000,1,1,0',
      '2026-10-01 03:00:00,BTCUSDT,SELL,110,2,0.11,20',
      '2026-10-01 04:00:00,ETHUSDT,BUY,1900,1,0.95,100',
      '2026-10-01 05:00:00,BTCUSDT,HOLD,1,1,0,0',
      'yesterday,BTCUSDT,BUY,1,1,0,0',
      '2026-10-01 06:00:00,?,BUY,1,1,0,0',
      '2026-10-01 07:00:00,BTCUSDT,BUY,0,1,0,0',
      '2031-01-01 00:00:00,BTCUSDT,BUY,1,1,0,0',
      '2026-10-01 08:00:00,BTCUSDT,BUY,1,0,0,0',
      '1000000000,BTCUSDT,BUY,1,1,0,0'
    ].join('\n')
    const read = traderFileOf(csv, NOW)
    if ('refused' in read && typeof read.refused === 'string') throw new Error(read.refused)
    if (!('kind' in read)) throw new Error('no read')
    expect(read).toMatchObject({ kind: 'fills', rows: 11, refusedRows: 7, columns: ['Date(UTC)', 'Symbol', 'Side', 'Price', 'Quantity', 'Fee', 'Realized Profit'] })
    // Each named by its line in the file, the header the first.
    expect(read.reasons).toEqual([
      'line 6: a side that is not buy or sell',
      'line 7: a time it cannot read (ISO 8601, YYYY-MM-DD hh:mm:ss in UTC, or epoch seconds or milliseconds), or out of range',
      'line 8: a symbol it cannot read',
      'line 9: a price or a quantity that is not a positive number',
      'line 10: a time it cannot read (ISO 8601, YYYY-MM-DD hh:mm:ss in UTC, or epoch seconds or milliseconds), or out of range'
    ])
    expect(read.fills.map((fill) => [fill.coin, fill.side, fill.startPosition, fill.fee, fill.label])).toEqual([
      ['BTC', 'buy', 0, 0.1, 'UNVERIFIABLE'],
      ['ETH', 'sell', 0, 1, 'UNVERIFIABLE'],
      ['BTC', 'sell', 2, 0.11, 'UNVERIFIABLE'],
      ['ETH', 'buy', -1, 0.95, 'UNVERIFIABLE']
    ])
    // The fills make the round trips any record's fills make.
    const trips = roundTripsOf(read.fills)
    expect(trips.trips.map((trip) => [trip.coin, trip.side, trip.realizedPnl])).toEqual([
      ['BTC', 'long', 20],
      ['ETH', 'short', 100]
    ])
  })

  it('is read as round trips where it gives openings and closings, a profit worked out from the prices where none is given', () => {
    const json = JSON.stringify({
      trades: [
        { open_time: '2026-10-01T00:00:00Z', close_time: '2026-10-01T04:00:00Z', symbol: 'SOL/USDT:USDT', side: 'Short', entry_price: '150', exit_price: '140', qty: '3' },
        { open_time: '2026-10-02T00:00:00Z', close_time: '2026-10-02T04:00:00Z', symbol: 'SOLUSDT', side: 'long', entry_price: 140, exit_price: 147, pnl: 6.5, fee: -0.2 },
        { open_time: '2026-10-03T00:00:00Z', close_time: '2026-10-02T23:00:00Z', symbol: 'SOLUSDT', side: 'long', entry_price: 1, exit_price: 2 }
      ]
    })
    const read = traderFileOf(json, NOW)
    if (!('kind' in read)) throw new Error(read.refused)
    // A JSON list's rows named by their place in it.
    expect(read).toMatchObject({ kind: 'trips', rows: 3, refusedRows: 1, reasons: ['item 3: closed before it opened'] })
    expect(read.trips.map((trip) => [trip.coin, trip.side, trip.maxSize, trip.realizedPnl, trip.fees, trip.net])).toEqual([
      ['SOL', 'short', 3, 30, 0, 30],
      ['SOL', 'long', 0, 6.5, 0.2, 6.3]
    ])
    expect(read.trips[0].movePct).toBeCloseTo((1 - 140 / 150) * 100, 9)
  })

  it('is refused where it holds no trades in a shape the app reads, nothing readable, or too much', () => {
    expect(traderFileOf('Name,Colour\nAda,green', NOW)).toEqual({ refused: 'The file needs, for each trade, opening and closing times, a symbol, a side and entry and exit prices -- or, for each fill, a time, a symbol, a side, a price and a quantity. Its columns: Name, Colour.' })
    expect(traderFileOf('time,symbol,side,price,qty\nnever,BTCUSDT,BUY,1,1', NOW)).toEqual({
      refused: 'No row of the file could be read -- line 2: a time it cannot read (ISO 8601, YYYY-MM-DD hh:mm:ss in UTC, or epoch seconds or milliseconds), or out of range.'
    })
    expect(traderFileOf('{"notes": "none"}', NOW)).toEqual({ refused: 'The JSON holds no list of trades: an array, or one under "trades", "fills", "positions" or "data".' })
    expect(traderFileOf('[1, 2', NOW)).toEqual({ refused: 'The file is not JSON this app can read.' })
    expect(traderFileOf('time,symbol', NOW)).toEqual({ refused: 'The file holds no row of trades under a header.' })
    const rows = Array.from({ length: TRADER_FILE_LINES.maxRows + 1 }, () => '1')
    expect(traderFileOf(['time', ...rows].join('\n'), NOW)).toEqual({ refused: 'The file holds 100,001 rows, over 100,000.' })
  })
})
