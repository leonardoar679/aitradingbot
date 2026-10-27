import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../shared/ipc'
import { traderTestsOf, type TraderTestsInput } from '../shared/traders/traderTests'

// COPY TRADERS (electron/services/traderService.ts; V8 Stage 6): a pasted trader read from Hyperliquid and kept --
// each new line added, none twice -- and analysed: round trips, figures, each coin's perpetual, the two tests on the
// worker, one line of it all kept with its versions; the traders on file with their last analysis; what could not be
// read said. Every venue faked here.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../electron/services/taskWorkerService', () => ({ runInWorker: async () => ({ ok: false, reason: 'error', message: 'no worker in a test' }) }))
vi.mock('../electron/services/effectiveConfigService', () => ({ getEffectiveConfig: async () => ({ engineVersion: 'engine-test', configVersion: 'config-test' }) }))

const ADDRESS = '0x0b4b6beaca45fce66ca818fbd867ec3761ed2143'
const KEY = `hyperliquid-${ADDRESS}`
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

const PORTFOLIO = [['allTime', { accountValueHistory: [[NOW_MS - 400 * DAY_MS, '1000']] }]]

let dir = ''
let answers = { fills: rawFills(), funding: [] as unknown[], ledger: [] as unknown[], portfolio: PORTFOLIO as unknown, fillsCapped: false }
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
    symbols: async (venue: string) => new Set(venue === 'binance' ? binanceListed : []),
    bars: async (_venue: string, _symbol: string, interval: string, fromSec: number, toSec: number) => {
      if (barsFail) throw new Error('the venue answered 418')
      return bars(fromSec, toSec, interval === '1m' ? 60 : interval === '15m' ? 900 : 3600)
    },
    funding: async () => [],
    impact: async () => 0.03,
    runTests: async (input: TraderTestsInput) => traderTestsOf(input)
  })
  return module
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traders-'))
  answers = { fills: rawFills(), funding: [], ledger: [], portfolio: PORTFOLIO, fillsCapped: false }
  binanceListed = ['BTCUSDT']
  barsFail = false
})

describe('a pasted trader', () => {
  it('is refused with why, a paste that names no trader and an OKX one not read yet', async () => {
    const traders = await service()
    expect(await traders.importTrader('https://www.bitget.com/copy-trading/trader/x')).toEqual({ refused: expect.stringMatching(/^Bitget publishes no lead trader's trades/) })
    expect(await traders.importTrader(42)).toEqual({ refused: expect.stringMatching(/^Paste a Hyperliquid address/) })
    expect(await traders.importTrader('AB12CD34EF56GH78')).toEqual({ refused: "An OKX lead trader's record is not read yet." })
  })

  it('is read from Hyperliquid and kept: its fills by month, its account, its value through time, and each new fill added once', async () => {
    const traders = await service()
    const steps: string[] = []
    traders.onTraderProgress((progress) => steps.push(progress.step))
    const meta = await traders.importTrader(`https://app.hyperliquid.xyz/explorer/address/${ADDRESS.toUpperCase().replace('0X', '0x')}`)
    if ('refused' in meta) throw new Error(meta.refused)
    expect(meta).toMatchObject({ v: 'trader-store-v1', ref: { venue: 'hyperliquid', id: ADDRESS, key: KEY }, fills: 80, fillsCapped: false })
    expect(steps[0]).toBe('reading Hyperliquid')
    expect(steps.at(-1)).toBe('kept')
    const files = readdirSync(join(dir, KEY)).sort()
    expect(files).toEqual(expect.arrayContaining(['meta.json', 'state.json', 'values.json']))
    expect(files.filter((name) => name.startsWith('trades-')).length).toBeGreaterThan(0)
    // Read again with ten more fills: the 80 kept are not written twice.
    answers.fills = [...rawFills(), ...rawFills(45).slice(80)]
    const again = await traders.importTrader(ADDRESS)
    if ('refused' in again) throw new Error(again.refused)
    expect(again.fills).toBe(90)
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
    expect(again.fillsCapped).toBe(true)
    expect((await traders.readTraderRecord(KEY)).values).toEqual([
      { timeMs: NOW_MS - 400 * DAY_MS, value: 1000 },
      { timeMs: NOW_MS - DAY_MS, value: 1200 }
    ])
  })
})

describe('an analysis', () => {
  it("rebuilds the trips, finds each coin's perpetual, runs the two tests and keeps one line of it with its versions", async () => {
    const traders = await service()
    await traders.importTrader(ADDRESS)
    const analysis = await traders.analyzeTrader(KEY)
    expect(analysis).toMatchObject({ v: 'trader-analysis-v1', key: KEY, versions: { engine: 'engine-test', config: 'config-test' }, mapping: [{ coin: 'BTC', venue: 'binance', symbol: 'BTCUSDT' }], unmapped: [], problems: [] })
    expect(analysis.figures.trips).toBe(40)
    expect(analysis.figures.money.net).toBeCloseTo(40 * (1 - 0.1), 9)
    expect(analysis.skill?.trips).toBe(40)
    expect(['SKILL', 'MARKET OR LUCK', 'TOO FEW']).toContain(analysis.skill?.verdict)
    // The delay test reads the last 90 days' trips: all forty.
    expect(analysis.delay?.trips).toBe(40)
    expect(analysis.delay?.rows).toHaveLength(6)
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

  it('lists no trader where none is on file', async () => {
    const traders = await service()
    dir = join(dir, 'missing')
    expect(await traders.listTraders()).toEqual({ traders: [], analysed: 0 })
  })
})
