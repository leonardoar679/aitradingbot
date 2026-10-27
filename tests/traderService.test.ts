import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../shared/ipc'
import { traderFileOf } from '../shared/traders/traderFile'
import { traderTestsOf, type TraderTestsInput } from '../shared/traders/traderTests'

// COPY TRADERS (electron/services/traderService.ts; V8 Stages 6-7): a trader read and kept -- each new line added, none
// twice -- from Hyperliquid (VERIFIED), from OKX (REPORTED, the app's estimate beside OKX's figure) or from a file
// (UNVERIFIABLE), and analysed: round trips, figures, each coin's perpetual, the three tests on the worker, one line of
// it all kept with its versions; the traders on file with their last analysis; what could not be read said. Every
// venue faked here.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../electron/services/taskWorkerService', () => ({ runInWorker: async () => ({ ok: false, reason: 'error', message: 'no worker in a test' }) }))
vi.mock('../electron/services/effectiveConfigService', () => ({ getEffectiveConfig: async () => ({ engineVersion: 'engine-test', configVersion: 'config-test' }) }))

const ADDRESS = '0x0b4b6beaca45fce66ca818fbd867ec3761ed2143'
const KEY = `hyperliquid-${ADDRESS}`
const CODE = 'AB12CD34EF56GH78'
const OKX_KEY = `okx-${CODE}`
const DAY_MS = 86_400_000
const NOW_MS = Date.UTC(2026, 9, 27, 12)

/** Forty days of one trip a day on a coin, opened at 01:00 and closed at 05:00, alternately long and short. */
function rawFills(days = 40, coin = 'BTC', firstTid = 1): unknown[] {
  const out: unknown[] = []
  let tid = firstTid
  for (let d = 0; d < days; d++) {
    const open = NOW_MS - (days - d) * DAY_MS + 3_600_000
    const long = d % 2 === 0
    out.push({ coin, px: '100', sz: '1', side: long ? 'B' : 'A', time: open, startPosition: '0', dir: long ? 'Open Long' : 'Open Short', closedPnl: '0', fee: '0.05', tid: tid++, oid: 1, crossed: true, feeToken: 'USDC' })
    out.push({ coin, px: long ? '101' : '99', sz: '1', side: long ? 'A' : 'B', time: open + 4 * 3_600_000, startPosition: long ? '1' : '-1', dir: long ? 'Close Long' : 'Close Short', closedPnl: '1', fee: '0.05', tid: tid++, oid: 2, crossed: true, feeToken: 'USDC' })
  }
  return out
}

/** An OKX lead trader's forty closed longs on BTC-USDT-SWAP, one a day from 06:00 to 10:00 -- across a funding time --
 * 100 contracts of 0.01 BTC from 100 to 101 at 10x, OKX reporting 0.9 USDT each; and one on an inverse swap the app
 * does not read. */
function okxAnswers(): Record<string, unknown> {
  const history: unknown[] = Array.from({ length: 40 }, (_, d) => {
    const open = NOW_MS - (40 - d) * DAY_MS - 6 * 3_600_000
    return { subPosId: `p${d}`, instId: 'BTC-USDT-SWAP', posSide: 'long', lever: '1E+1', mgnMode: 'cross', openAvgPx: '100', openTime: String(open), closeAvgPx: '101', closeTime: String(open + 4 * 3_600_000), subPos: '100', margin: '10', pnl: '0.9', pnlRatio: '0.09' }
  })
  history.push({ subPosId: 'inverse', instId: 'BTC-USD-SWAP', posSide: 'long', lever: '5', openAvgPx: '100', openTime: String(NOW_MS - DAY_MS), closeAvgPx: '101', closeTime: String(NOW_MS - DAY_MS + 3_600_000), subPos: '1', pnl: '0.01' })
  const rates = Array.from({ length: 3 * 45 }, (_, k) => ({ instId: 'BTC-USDT-SWAP', fundingTime: String(NOW_MS - 12 * 3_600_000 - k * 8 * 3_600_000), fundingRate: '0.0001', realizedRate: '0.0001' }))
  return {
    history,
    current: [
      { instId: 'BTC-USDT-SWAP', subPos: '50', openAvgPx: '100', markPx: '101', posSide: 'long', lever: '5', upl: '0.5', mgnMode: 'cross', margin: '10' },
      { instId: '', subPos: '', openAvgPx: '', posSide: 'long', upl: '-0.25' }
    ],
    pnl: [
      { beginTs: String(NOW_MS - 2 * DAY_MS), pnl: '10', pnlRatio: '0.1' },
      { beginTs: String(NOW_MS - DAY_MS), pnl: '12', pnlRatio: '0.12' }
    ],
    stats: [{ winRatio: '0.6', profitDays: '20', lossDays: '10', investAmt: '1000', avgSubPosNotional: '100', curCopyTraderPnl: '5' }],
    instruments: [{ instId: 'BTC-USDT-SWAP', ctVal: '0.01', ctType: 'linear', settleCcy: 'USDT' }],
    funding: { 'BTC-USDT-SWAP': rates },
    capped: false
  }
}

const PORTFOLIO = [['allTime', { accountValueHistory: [[NOW_MS - 400 * DAY_MS, '1000']] }]]

let dir = ''
let answers = { fills: rawFills(), funding: [] as unknown[], ledger: [] as unknown[], portfolio: PORTFOLIO as unknown, fillsCapped: false }
let okx = okxAnswers()
let binanceListed = ['BTCUSDT']
let barsFail = false

/** Bars of a flat-then-rising coin at any step: what the tests read. */
function bars(fromSec: number, toSec: number, stepSec: number): Candle[] {
  const out: Candle[] = []
  for (let t = Math.ceil(fromSec / stepSec) * stepSec; t < toSec; t += stepSec) {
    const close = 100 * (1 + 0.00001 * ((t / stepSec) % 50))
    out.push({ time: t, open: close, high: close, low: close, close, volume: 1 })
  }
  return out
}

async function service() {
  vi.resetModules()
  const module = await import('../electron/services/traderService')
  module.resetTraders()
  Object.assign(module.traderSeam, {
    dir: () => dir,
    nowMs: () => NOW_MS,
    hyperliquid: async () => ({
      state: { marginSummary: { accountValue: '1000' }, assetPositions: [], time: NOW_MS },
      portfolio: answers.portfolio,
      fills: answers.fills,
      funding: answers.funding,
      ledger: answers.ledger,
      fillsCapped: answers.fillsCapped
    }),
    okx: async () => okx,
    symbols: async (venue: string) => new Set(venue === 'binance' ? binanceListed : []),
    bars: async (_venue: string, _symbol: string, interval: string, fromSec: number, toSec: number) => {
      if (barsFail) throw new Error('the venue answered 418')
      return bars(fromSec, toSec, interval === '1m' ? 60 : interval === '15m' ? 900 : 3600)
    },
    funding: async () => [],
    impact: async () => 0.03,
    runTests: async (input: TraderTestsInput) => traderTestsOf(input),
    readFile: async (text: string, nowMs: number) => traderFileOf(text, nowMs)
  })
  return module
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traders-'))
  answers = { fills: rawFills(), funding: [], ledger: [], portfolio: PORTFOLIO, fillsCapped: false }
  okx = okxAnswers()
  binanceListed = ['BTCUSDT']
  barsFail = false
})

describe('a pasted trader', () => {
  it('is refused with why where a paste names no trader the app reads', async () => {
    const traders = await service()
    expect(await traders.importTrader('https://www.bitget.com/copy-trading/trader/x')).toEqual({ refused: expect.stringMatching(/^Bitget publishes no lead trader's trades/) })
    expect(await traders.importTrader(42)).toEqual({ refused: expect.stringMatching(/^Paste a Hyperliquid address/) })
  })

  it('is read from Hyperliquid and kept: its fills by month, its account, its value through time, and each new fill added once', async () => {
    const traders = await service()
    const steps: string[] = []
    traders.onTraderProgress((progress) => steps.push(progress.step))
    const meta = await traders.importTrader(`https://app.hyperliquid.xyz/explorer/address/${ADDRESS.toUpperCase().replace('0X', '0x')}`)
    if ('refused' in meta) throw new Error(meta.refused)
    expect(meta).toMatchObject({ v: 'trader-store-v2', ref: { venue: 'hyperliquid', id: ADDRESS, key: KEY }, source: 'hyperliquid', label: 'VERIFIED', records: 80, capped: false, name: null, fileKind: null, fileRefused: null })
    expect(steps[0]).toBe('reading Hyperliquid')
    expect(steps.at(-1)).toBe('kept')
    const files = readdirSync(join(dir, KEY)).sort()
    expect(files).toEqual(expect.arrayContaining(['meta.json', 'state.json', 'values.json']))
    expect(files.filter((name) => name.startsWith('trades-')).length).toBeGreaterThan(0)
    // Read again with ten more fills: the 80 kept are not written twice.
    answers.fills = [...rawFills(), ...rawFills(45).slice(80)]
    const again = await traders.importTrader(ADDRESS)
    if ('refused' in again) throw new Error(again.refused)
    expect(again.records).toBe(90)
    const lines = files.filter((name) => name.startsWith('trades-')).flatMap((name) => readFileSync(join(dir, KEY, name), 'utf-8').trim().split('\n'))
    expect(lines.length).toBeGreaterThan(0)
    const record = await traders.readTraderRecord(KEY)
    expect(record.fills).toHaveLength(90)
    expect(new Set(record.fills.map((fill) => fill.tid)).size).toBe(90)
  })

  it("keeps what an earlier read found: the account's earlier values, and that its fills ran past what Hyperliquid gives", async () => {
    const traders = await service()
    answers.fillsCapped = true
    await traders.importTrader(ADDRESS)
    // Read again: the venue's history now starts later, and the fills read fit within the cap -- the older ones are
    // still not on file.
    answers.fillsCapped = false
    answers.portfolio = [['allTime', { accountValueHistory: [[NOW_MS - DAY_MS, '1200']] }]]
    const again = await traders.importTrader(ADDRESS)
    if ('refused' in again) throw new Error(again.refused)
    expect(again.capped).toBe(true)
    expect((await traders.readTraderRecord(KEY)).values).toEqual([
      { timeMs: NOW_MS - 400 * DAY_MS, value: 1000 },
      { timeMs: NOW_MS - DAY_MS, value: 1200 }
    ])
  })
})

describe('an OKX lead trader', () => {
  it("is read from OKX and kept: its positions REPORTED with the app's estimate beside them, each once, and what OKX says of the year", async () => {
    const traders = await service()
    const meta = await traders.importTrader(`https://www.okx.com/copy-trading/account/${CODE}?tab=swap`)
    if ('refused' in meta) throw new Error(meta.refused)
    expect(meta).toMatchObject({ v: 'trader-store-v2', ref: { venue: 'okx', id: CODE, key: OKX_KEY }, source: 'okx', label: 'REPORTED', records: 40, capped: false })
    const record = await traders.readTraderRecord(OKX_KEY)
    expect(record.positions).toHaveLength(40)
    // 1 BTC from 100 to 101: 1.00 moved, 0.05% of 100 and of 101 in fees, 0.01% of 100 at the 08:00 funding.
    expect(record.positions[0].estimate?.grossUsdt).toBeCloseTo(1, 9)
    expect(record.positions[0].estimate?.feesUsdt).toBeCloseTo(0.1005, 9)
    expect(record.positions[0].estimate?.fundingUsdt).toBeCloseTo(-0.01, 9)
    expect(record.okx).toMatchObject({ notRead: 1, open: { hidden: 1, unrealized: 0.25 }, stats: { winRatio: 0.6 } })
    expect(record.okx?.series).toHaveLength(2)
    // Read again: nothing written twice.
    const again = await traders.importTrader(CODE)
    if ('refused' in again) throw new Error(again.refused)
    expect(again.records).toBe(40)
    expect((await traders.readTraderRecord(OKX_KEY)).positions).toHaveLength(40)
  })

  it("is analysed on the app's estimate, OKX's own figure beside it, the leverage OKX reports, and what is open or hidden", async () => {
    const traders = await service()
    await traders.importTrader(CODE)
    const analysis = await traders.analyzeTrader(OKX_KEY)
    expect(analysis.record).toMatchObject({ source: 'okx', label: 'REPORTED', records: 40 })
    expect(analysis.figures.trips).toBe(40)
    expect(analysis.figures.money.net).toBeCloseTo(40 * (1 - 0.1005 - 0.01), 9)
    expect(analysis.figures.reportedLeverage).toEqual({ median: 10, max: 10, trips: 40 })
    expect(analysis.figures.open.positions).toHaveLength(1)
    expect(analysis.okx).toMatchObject({ positions: 40, notPriced: 1, open: { hidden: 1 } })
    expect(analysis.okx?.reportedPnl).toBeCloseTo(36, 9)
    expect(analysis.okx?.estimate.net).toBeCloseTo(40 * 0.8895, 9)
    expect(analysis.skill?.trips).toBe(40)
    expect(analysis.clone).not.toBeNull()
  })

  it('is refused where OKX has nothing of the code, or says it knows no such trader', async () => {
    const traders = await service()
    okx = { ...okxAnswers(), history: [], pnl: [] }
    expect(await traders.importTrader(CODE)).toEqual({ refused: 'OKX has no lead trader with that code, or none with a perpetual position in the last three months.' })
    traders.traderSeam.okx = async () => {
      throw new Error("OKX answered 60004: Trader doesn't exist")
    }
    expect(await traders.importTrader(CODE)).toEqual({ refused: 'OKX has no lead trader with that code: they may have stopped leading.' })
    // Any other failure is said as it is.
    traders.traderSeam.okx = async () => {
      throw new Error('OKX could not be read: OKX answered 503')
    }
    await expect(traders.importTrader(CODE)).rejects.toThrow('OKX could not be read: OKX answered 503')
  })
})

describe('a file of trades', () => {
  const fillsCsv = (): string => {
    const rows = ['Date(UTC),Symbol,Side,Price,Quantity,Fee,Realized Profit']
    for (let d = 0; d < 40; d++) {
      const open = new Date(NOW_MS - (40 - d) * DAY_MS + 3_600_000).toISOString().slice(0, 19).replace('T', ' ')
      const close = new Date(NOW_MS - (40 - d) * DAY_MS + 5 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ')
      rows.push(`${open},BTCUSDT,BUY,100,1,0.05 USDT,0`, `${close},BTCUSDT,SELL,101,1,0.05 USDT,1`)
    }
    rows.push('2026-10-26 00:00:00,BTCUSDT,HOLD,100,1,0,0')
    return rows.join('\n')
  }

  it('is read as fills, UNVERIFIABLE, its key its contents\' hash, its refused rows counted, and kept once however often it is opened', async () => {
    const traders = await service()
    const bytes = new TextEncoder().encode(fillsCsv())
    const key = `file-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`
    const meta = await traders.importTraderFile({ name: 'my-trades.csv', bytes })
    if ('refused' in meta) throw new Error(meta.refused)
    expect(meta).toMatchObject({ ref: { venue: 'file', key }, source: 'file', label: 'UNVERIFIABLE', records: 80, name: 'my-trades.csv', fileKind: 'fills', fileRefused: { count: 1, reasons: ['line 82: a side that is not buy or sell'] } })
    await traders.importTraderFile({ name: 'my-trades (copy).csv', bytes })
    expect((await traders.readTraderRecord(key)).fills).toHaveLength(80)
    const analysis = await traders.analyzeTrader(key)
    expect(analysis.record).toMatchObject({ source: 'file', label: 'UNVERIFIABLE' })
    expect(analysis.figures.trips).toBe(40)
    expect(analysis.figures.money.net).toBeCloseTo(40 * (1 - 0.1), 9)
    expect(analysis.skill?.trips).toBe(40)
    expect((await traders.listTraders()).traders.map((entry) => entry.meta.ref.key)).toEqual([key])
  })

  it('is read as round trips where it gives openings and closings', async () => {
    const traders = await service()
    const trips = Array.from({ length: 12 }, (_, d) => ({ openTime: new Date(NOW_MS - (12 - d) * DAY_MS).toISOString(), closeTime: new Date(NOW_MS - (12 - d) * DAY_MS + 7_200_000).toISOString(), symbol: 'BTC-USDT-SWAP', side: 'short', entryPrice: 101, exitPrice: 100, size: 2 }))
    const meta = await traders.importTraderFile({ name: 'trips.json', bytes: new TextEncoder().encode(JSON.stringify({ trades: trips })) })
    if ('refused' in meta) throw new Error(meta.refused)
    expect(meta).toMatchObject({ records: 12, fileKind: 'trips', fileRefused: { count: 0, reasons: [] } })
    const analysis = await traders.analyzeTrader(meta.ref.key)
    expect(analysis.figures.trips).toBe(12)
    expect(analysis.figures.money.realized).toBeCloseTo(24, 9)
    expect(analysis.skill?.verdict).toBe('TOO FEW')
  })

  it('is refused where it holds no trades in a shape the app reads, or is over 5 MB', async () => {
    const traders = await service()
    expect(await traders.importTraderFile({ name: 'notes.csv', bytes: new TextEncoder().encode('Name,Colour\nAda,green') })).toEqual({ refused: expect.stringMatching(/^The file needs, for each trade/) })
    expect(await traders.importTraderFile({ name: 'big.csv', bytes: new Uint8Array(5 * 1024 * 1024 + 1) })).toEqual({ refused: 'The file is larger than 5 MB.' })
    expect(readdirSync(dir)).toEqual([])
  })
})

describe('an analysis', () => {
  it("rebuilds the trips, finds each coin's perpetual, runs the three tests and keeps one line of it with its versions", async () => {
    const traders = await service()
    await traders.importTrader(ADDRESS)
    let asked: TraderTestsInput | null = null
    traders.traderSeam.runTests = async (input) => {
      asked = input
      return traderTestsOf(input)
    }
    const analysis = await traders.analyzeTrader(KEY)
    // The clone pays the taker fee of the coin's venue and the book's impact the delay test read.
    expect((asked as TraderTestsInput | null)?.clone.costs.get('BTC')).toEqual({ takerFeePct: 0.05, impactPct: 0.03 })
    expect(analysis).toMatchObject({ v: 'trader-analysis-v2', key: KEY, versions: { engine: 'engine-test', config: 'config-test' }, mapping: [{ coin: 'BTC', venue: 'binance', symbol: 'BTCUSDT' }], unmapped: [], okx: null, problems: [] })
    expect(analysis.record).toMatchObject({ source: 'hyperliquid', label: 'VERIFIED', records: 80 })
    expect(analysis.figures.trips).toBe(40)
    expect(analysis.figures.money.net).toBeCloseTo(40 * (1 - 0.1), 9)
    expect(analysis.skill?.trips).toBe(40)
    expect(['SKILL', 'MARKET OR LUCK', 'TOO FEW']).toContain(analysis.skill?.verdict)
    // The delay test reads the last 90 days' trips: all forty.
    expect(analysis.delay?.trips).toBe(40)
    expect(analysis.delay?.rows).toHaveLength(6)
    // The clone reads the same trips: forty entries, every feature read.
    expect(analysis.clone).toMatchObject({ entries: 40, withoutFeatures: 0 })
    const kept = readdirSync(join(dir, KEY)).filter((name) => name.startsWith('analyses-'))
    expect(kept).toHaveLength(1)
    const listed = await traders.listTraders()
    expect(listed.analysed).toBe(1)
    expect(listed.traders[0].latest?.at).toBe(analysis.at)
  })

  it('says what could not be read, and still keeps the figures', async () => {
    const traders = await service()
    await traders.importTrader(ADDRESS)
    barsFail = true
    const analysis = await traders.analyzeTrader(KEY)
    expect(analysis.figures.trips).toBe(40)
    expect(analysis.problems.some((problem) => problem.startsWith("Bitcoin's hourly bars could not be read"))).toBe(true)
    expect(analysis.problems.some((problem) => problem.startsWith("BTC's bars could not be read"))).toBe(true)
    // With no bars, the skill test has no trip it can measure: TOO FEW.
    expect(analysis.skill?.withoutBars).toBe(40)
  })

  it('reads every trip of the record on every coin a venue covers, and counts the trips of a coin none does as without bars', async () => {
    const coins = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'NEAR', 'APT', 'ZZZ']
    // Forty trips on each of thirteen listed coins; thirty on ZZZ, which no venue lists.
    answers.fills = coins.flatMap((coin, c) => rawFills(coin === 'ZZZ' ? 30 : 40, coin, 1 + c * 1000))
    binanceListed = coins.filter((coin) => coin !== 'ZZZ').map((coin) => `${coin}USDT`)
    const traders = await service()
    await traders.importTrader(ADDRESS)
    const analysis = await traders.analyzeTrader(KEY)
    expect(analysis.mapping).toHaveLength(13)
    expect(analysis.unmapped).toEqual(['ZZZ'])
    expect(analysis.figures.trips).toBe(550)
    expect(analysis.skill).toMatchObject({ trips: 520, withoutBars: 30 })
    // The delay test takes the most recent 500 trips of the last 90 days, ZZZ's thirty among them, on no venue.
    expect(analysis.delay).toMatchObject({ trips: 470, noVenue: 30 })
    expect(analysis.clone).toMatchObject({ entries: 520, withoutFeatures: 30 })
    // A record of 420 days: its tests read it whole.
    answers.fills = rawFills(420)
    binanceListed = ['BTCUSDT']
    const long = await service()
    dir = mkdtempSync(join(tmpdir(), 'traders-'))
    await long.importTrader(ADDRESS)
    const read = await long.analyzeTrader(KEY)
    expect(read.figures.trips).toBe(420)
    expect(read.skill?.trips).toBe(420)
  })

  it('lists a trader with their newest analysis', async () => {
    const traders = await service()
    await traders.importTrader(ADDRESS)
    const first = await traders.analyzeTrader(KEY)
    traders.traderSeam.nowMs = () => NOW_MS + 3_600_000
    const second = await traders.analyzeTrader(KEY)
    expect(second.at).toBe(first.at + 3600)
    const listed = await traders.listTraders()
    expect(listed.traders[0].latest?.at).toBe(second.at)
    expect(listed.analysed).toBe(1)
  })

  it('analyses one at a time: one asked meanwhile starts once the first is kept', async () => {
    const traders = await service()
    await traders.importTrader(ADDRESS)
    let release = (): void => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    let reached = (): void => undefined
    const firstReached = new Promise<void>((resolve) => (reached = resolve))
    let started = 0
    traders.traderSeam.runTests = async (input) => {
      started++
      if (started === 1) {
        reached()
        await held
      }
      return traderTestsOf(input)
    }
    const one = traders.analyzeTrader(KEY)
    const two = traders.analyzeTrader(KEY)
    await firstReached
    for (let waited = 0; waited < 500 && started < 2; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(started).toBe(1)
    release()
    await Promise.all([one, two])
    expect(started).toBe(2)
  })

  it('refuses a key that names no trader, and one not on file', async () => {
    const traders = await service()
    await expect(traders.analyzeTrader('../etc')).rejects.toThrow('A trader on file is named by its key.')
    await expect(traders.analyzeTrader(KEY)).rejects.toThrow('That trader is not on file: read them first.')
  })

  it('lists no trader where none is on file, and none whose meta is of another version', async () => {
    const traders = await service()
    await traders.importTrader(ADDRESS)
    const metaPath = join(dir, KEY, 'meta.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(metaPath, JSON.stringify({ ...JSON.parse(readFileSync(metaPath, 'utf-8')), v: 'trader-store-v1' }))
    expect(await traders.listTraders()).toEqual({ traders: [], analysed: 0 })
    dir = join(dir, 'missing')
    expect(await traders.listTraders()).toEqual({ traders: [], analysed: 0 })
  })
})
