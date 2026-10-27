import { app } from 'electron'
import { mkdir, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { Candle } from '../../shared/ipc'
import { DELAY_LINES, type DelayCosts, type FundingRate } from '../../shared/traders/delay'
import {
  hyperliquidAccountValuesOf,
  hyperliquidFillOf,
  hyperliquidFundingOf,
  hyperliquidLedgerOf,
  hyperliquidStateOf,
  type AccountState,
  type AccountValuePoint,
  type FundingPayment,
  type LedgerUpdate,
  type TraderFill
} from '../../shared/traders/hyperliquid'
import { roundTripsOf } from '../../shared/traders/roundTrips'
import { SKILL_LINES, type CloseSeries } from '../../shared/traders/skill'
import { TRADER_ANALYSIS_VERSION, coinVenueOf, minuteSpansOf, readTraderAnalysis, seriesOf, type CoinVenue, type TraderAnalysis, type TraderList, type TraderMeta, type TraderProgress } from '../../shared/traders/traderAnalysis'
import { traderFiguresOf } from '../../shared/traders/traderFigures'
import { traderRefOf, traderRefOfKey } from '../../shared/traders/traderRef'
import type { TraderTestsInput, TraderTestsResult } from '../../shared/traders/traderTests'
import { PERP_FEES } from '../../shared/venueCosts'
import { writeJsonAtomic } from './atomicWrite'
import { getEffectiveConfig } from './effectiveConfigService'
import { fetchHyperliquidRecord } from './hyperliquidClient'
import { appendJsonLines, listMonthFiles } from './jsonlStore'
import { perpBars, perpBookImpact, perpFunding, perpSymbols, type PerpVenue } from './perpMarketService'
import { runInWorker } from './taskWorkerService'

// COPY TRADERS (V8 Stage 6, 26 October 2026): a pasted trader read, kept and judged. The paste is read and never
// fetched (shared/traders/traderRef.ts); a Hyperliquid address's record is read from Hyperliquid's public info API
// (hyperliquidClient.ts) and kept in traders/<key>/ -- its fills (trades-YYYY-MM.jsonl, VERIFIED), funding, ledger,
// its account now and its value through time -- each new line added, none twice. An analysis rebuilds the round
// trips, works out the figures, finds each coin's perpetual on Binance or Bitget, reads the bars, funding and books
// the two tests need (perpMarketService.ts) and runs V8-S6-SKILL and V8-S6-DELAY on the worker, then keeps one line
// of what it found (analyses-YYYY-MM.jsonl). Public data only: no key, no model, no order, and nothing followed.

export const TRADER_STORE_VERSION = 'trader-store-v1' as const

/** What the service reads the world through: a test hands in its own. */
export const traderSeam = {
  dir: (): string => join(app.getPath('userData'), 'traders'),
  nowMs: (): number => Date.now(),
  hyperliquid: fetchHyperliquidRecord,
  symbols: (venue: PerpVenue): Promise<Set<string>> => perpSymbols(venue),
  bars: perpBars,
  funding: perpFunding,
  impact: perpBookImpact,
  versions: async (): Promise<{ engine: string; config: string }> => {
    const config = await getEffectiveConfig()
    return { engine: config.engineVersion, config: config.configVersion }
  },
  runTests: async (input: TraderTestsInput): Promise<TraderTestsResult> => {
    const outcome = await runInWorker('traderTests', input, { timeoutMs: 180_000, maxOldGenerationSizeMb: 768 })
    if (!outcome.ok) throw new Error(outcome.reason === 'timeout' ? 'the tests took too long' : outcome.reason === 'memory' ? 'the tests ran out of memory' : outcome.message)
    return outcome.result as TraderTestsResult
  }
}

const listeners = new Set<(progress: TraderProgress) => void>()

export function onTraderProgress(listener: (progress: TraderProgress) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

const tell = (progress: TraderProgress): void => {
  for (const listener of listeners) {
    try {
      listener(progress)
    } catch (error) {
      console.error('A trader listener failed:', error)
    }
  }
}

const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)
const folderOf = (key: string): string => join(traderSeam.dir(), key)

async function readLines(dir: string, pattern: RegExp): Promise<unknown[]> {
  const out: unknown[] = []
  for (const { name } of await listMonthFiles(dir, pattern).catch(() => [])) {
    let text = ''
    try {
      text = await readFile(join(dir, name), 'utf-8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // A torn last line is skipped.
      }
    }
  }
  return out
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as T
  } catch {
    return null
  }
}

/** Lines appended by month, only those whose key is not on file yet. */
async function appendNew<T>(dir: string, prefix: string, rows: readonly T[], keyOf: (row: T) => string, timeOf: (row: T) => number, held: ReadonlySet<string>): Promise<number> {
  const fresh = rows.filter((row) => !held.has(keyOf(row)))
  const byMonth = new Map<string, T[]>()
  for (const row of fresh) {
    const month = monthOf(timeOf(row))
    byMonth.set(month, [...(byMonth.get(month) ?? []), row])
  }
  for (const [month, lines] of byMonth) await appendJsonLines(join(dir, `${prefix}-${month}.jsonl`), lines)
  return fresh.length
}

/** A trader's record as kept. */
export interface TraderRecord {
  meta: TraderMeta | null
  fills: TraderFill[]
  funding: FundingPayment[]
  ledger: LedgerUpdate[]
  state: AccountState | null
  values: AccountValuePoint[]
}

const fillKey = (fill: TraderFill): string => String(fill.tid)
const fundingKey = (payment: FundingPayment): string => `${payment.timeMs}:${payment.coin}`
const ledgerKey = (update: LedgerUpdate): string => `${update.timeMs}:${update.type}:${update.usdc}`

export async function readTraderRecord(key: string): Promise<TraderRecord> {
  const dir = folderOf(key)
  const fills = (await readLines(dir, /^trades-(\d{4}-\d{2})\.jsonl$/)).map(hyperliquidFillLine).filter((fill): fill is TraderFill => fill !== null)
  const funding = (await readLines(dir, /^funding-(\d{4}-\d{2})\.jsonl$/)) as FundingPayment[]
  const ledger = (await readLines(dir, /^ledger-(\d{4}-\d{2})\.jsonl$/)) as LedgerUpdate[]
  return {
    meta: await readJson<TraderMeta>(join(dir, 'meta.json')),
    fills,
    funding,
    ledger,
    state: await readJson<AccountState>(join(dir, 'state.json')),
    values: (await readJson<AccountValuePoint[]>(join(dir, 'values.json'))) ?? []
  }
}

/** A kept fill read back: the app's own shape, its label checked. */
function hyperliquidFillLine(value: unknown): TraderFill | null {
  const fill = value as Partial<TraderFill> | null
  return fill !== null && typeof fill === 'object' && fill.label === 'VERIFIED' && typeof fill.coin === 'string' && typeof fill.tid === 'number' && typeof fill.timeMs === 'number' ? (fill as TraderFill) : null
}

/** Reads a pasted trader's record from its venue and keeps it: the paste's refusal, or what is now on file. */
export async function importTrader(raw: unknown): Promise<{ refused: string } | TraderMeta> {
  const read = traderRefOf(typeof raw === 'string' ? raw : '')
  if (!read.ok) return { refused: read.reason }
  const ref = read.ref
  if (ref.venue !== 'hyperliquid') return { refused: "An OKX lead trader's record is not read yet." }
  tell({ key: ref.key, step: 'reading Hyperliquid', done: false })
  const answers = await traderSeam.hyperliquid(ref.id, (step) => tell({ key: ref.key, step: `reading Hyperliquid: ${step}`, done: false }))
  const fills = answers.fills.map(hyperliquidFillOf).filter((fill): fill is TraderFill => fill !== null)
  const funding = answers.funding.map(hyperliquidFundingOf).filter((payment): payment is FundingPayment => payment !== null)
  const ledger = answers.ledger.map(hyperliquidLedgerOf).filter((update): update is LedgerUpdate => update !== null)
  const state = hyperliquidStateOf(answers.state)
  const values = hyperliquidAccountValuesOf(answers.portfolio)
  const dir = folderOf(ref.key)
  await mkdir(dir, { recursive: true })
  const held = await readTraderRecord(ref.key)
  await appendNew(dir, 'trades', fills, fillKey, (fill) => fill.timeMs, new Set(held.fills.map(fillKey)))
  await appendNew(dir, 'funding', funding, fundingKey, (payment) => payment.timeMs, new Set(held.funding.map(fundingKey)))
  await appendNew(dir, 'ledger', ledger, ledgerKey, (update) => update.timeMs, new Set(held.ledger.map(ledgerKey)))
  if (state !== null) await writeJsonAtomic(join(dir, 'state.json'), state)
  // The account's value through time, the points kept before and the points read now merged.
  const points = new Map<number, number>([...held.values.map((point) => [point.timeMs, point.value] as const), ...values.map((point) => [point.timeMs, point.value] as const)])
  await writeJsonAtomic(join(dir, 'values.json'), [...points.entries()].map(([timeMs, value]) => ({ timeMs, value })).sort((a, b) => a.timeMs - b.timeMs))
  const all = new Map<string, TraderFill>([...held.fills, ...fills].map((fill) => [fillKey(fill), fill]))
  const times = [...all.values()].map((fill) => fill.timeMs)
  const meta: TraderMeta = {
    v: TRADER_STORE_VERSION,
    ref,
    importedAt: Math.floor(traderSeam.nowMs() / 1000),
    fills: all.size,
    firstMs: times.length === 0 ? null : Math.min(...times),
    lastMs: times.length === 0 ? null : Math.max(...times),
    fillsCapped: answers.fillsCapped || (held.meta?.fillsCapped ?? false)
  }
  await writeJsonAtomic(join(dir, 'meta.json'), meta)
  tell({ key: ref.key, step: 'kept', done: true })
  return meta
}

const DAY_MS = 86_400_000

async function seriesFor(venue: PerpVenue, symbol: string, stepSec: number, fromSec: number, toSec: number): Promise<CloseSeries | null> {
  const interval = stepSec === 60 ? '1m' : stepSec === 900 ? '15m' : '1h'
  return seriesOf(await traderSeam.bars(venue, symbol, interval, fromSec, toSec), stepSec)
}

let analysing: Promise<unknown> = Promise.resolve()

/** Analyses a trader on file, one analysis at a time: the figures, each coin's perpetual, the two tests, and one line
 * kept of it all. */
export function analyzeTrader(key: unknown): Promise<TraderAnalysis> {
  const run = analysing.then(() => analyze(key))
  analysing = run.catch(() => undefined)
  return run
}

async function analyze(rawKey: unknown): Promise<TraderAnalysis> {
  const ref = typeof rawKey === 'string' ? traderRefOfKey(rawKey) : null
  if (ref === null) throw new Error('A trader on file is named by its key.')
  const record = await readTraderRecord(ref.key)
  if (record.meta === null) throw new Error('That trader is not on file: read them first.')
  const step = (text: string): void => tell({ key: ref.key, step: text, done: false })
  step('rebuilding round trips')
  const roundTrips = roundTripsOf(record.fills, record.funding)
  const figures = traderFiguresOf({ roundTrips, values: record.values, ledger: record.ledger, state: record.state })
  const problems: string[] = []

  // Each coin's perpetual: Binance's, else Bitget's. A coin neither lists has its trips without bars in the tests.
  step('finding the coins on the venues')
  const listed = { binance: new Set<string>(), bitget: new Set<string>() }
  for (const venue of ['binance', 'bitget'] as const) {
    try {
      listed[venue] = await traderSeam.symbols(venue)
    } catch (error) {
      problems.push(`${venue === 'binance' ? 'Binance' : 'Bitget'}'s perpetuals could not be listed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const mapping: CoinVenue[] = []
  const unmapped: string[] = []
  for (const { coin } of figures.coins) {
    const found = coinVenueOf(coin, listed.binance, listed.bitget)
    if (found === null) unmapped.push(coin)
    else mapping.push(found)
  }
  // The tests read every completed trip, as their registrations say.
  const trips = roundTrips.trips
  const nowMs = traderSeam.nowMs()

  let tests: TraderTestsResult | null = null
  if (trips.length > 0) {
    // The skill test's bars: each coin's fifteen-minute closes over the whole record -- null A moves every trip anywhere
    // within it -- and its longest hold past it, and hourly closes from 31 days before it for the betas, Bitcoin's under
    // "BTC".
    const fromSec = Math.floor(trips.reduce((least, trip) => Math.min(least, trip.openedAtMs), Infinity) / 1000)
    const toSec = Math.ceil(trips.reduce((most, trip) => Math.max(most, trip.closedAtMs), -Infinity) / 1000)
    const longest = trips.reduce((most, trip) => Math.max(most, (trip.closedAtMs - trip.openedAtMs) / 1000), 0)
    const bars = new Map<string, CloseSeries>()
    const hourly = new Map<string, CloseSeries>()
    const btcVenue = listed.binance.has('BTCUSDT') ? { venue: 'binance' as const, symbol: 'BTCUSDT' } : { venue: 'bitget' as const, symbol: 'BTCUSDT' }
    try {
      step('reading Bitcoin')
      const btc = await seriesFor(btcVenue.venue, btcVenue.symbol, 3600, fromSec - 31 * 86_400, toSec + 86_400)
      if (btc !== null) hourly.set('BTC', btc)
    } catch (error) {
      problems.push(`Bitcoin's hourly bars could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    for (const entry of mapping) {
      step(`reading ${entry.coin}`)
      try {
        const fine = await seriesFor(entry.venue, entry.symbol, SKILL_LINES.nullBarMinutes * 60, fromSec - 900, toSec + longest + 900)
        if (fine !== null) bars.set(entry.coin, fine)
        // Bitcoin's own hourly closes are read above, under its name.
        if (entry.coin !== 'BTC') {
          const coarse = await seriesFor(entry.venue, entry.symbol, 3600, fromSec - 31 * 86_400, toSec + 86_400)
          if (coarse !== null) hourly.set(entry.coin, coarse)
        }
      } catch (error) {
        problems.push(`${entry.coin}'s bars could not be read: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    // The delay test's minutes, funding and books, for the trips it copies as it takes them -- the most recent 500
    // closed in its last 90 days -- on the coins a venue covers.
    const since = nowMs - DELAY_LINES.lookbackDays * DAY_MS
    const recent = trips.filter((trip) => trip.closedAtMs >= since).sort((a, b) => b.closedAtMs - a.closedAtMs).slice(0, DELAY_LINES.maxTrips)
    const minuteBars = new Map<string, Candle[]>()
    const fundingRates = new Map<string, FundingRate[]>()
    const costs = new Map<string, DelayCosts>()
    for (const entry of mapping) {
      const mine = recent.filter((trip) => trip.coin === entry.coin)
      if (mine.length === 0) continue
      step(`reading ${entry.coin}'s minutes`)
      try {
        // From each trip's own opening and close to the latest delay's minute and its gap after them.
        const spans = minuteSpansOf(mine.flatMap((trip) => [trip.openedAtMs / 1000, trip.closedAtMs / 1000]))
        const candles: Candle[] = []
        for (const span of spans) candles.push(...(await traderSeam.bars(entry.venue, entry.symbol, '1m', span.fromSec, span.toSec)))
        minuteBars.set(entry.coin, candles.sort((a, b) => a.time - b.time))
        const first = mine.reduce((least, trip) => Math.min(least, trip.openedAtMs), Infinity) / 1000
        fundingRates.set(entry.coin, await traderSeam.funding(entry.venue, entry.symbol, first - 8 * 3600, Math.ceil(nowMs / 1000)))
        let impactPct: number | null = null
        try {
          impactPct = await traderSeam.impact(entry.venue, entry.symbol, DELAY_LINES.stakeQuote)
        } catch {
          impactPct = null
        }
        costs.set(entry.coin, { venue: entry.venue, symbol: entry.symbol, takerFeePct: PERP_FEES[entry.venue].takerPct, impactPct })
      } catch (error) {
        problems.push(`${entry.coin}'s minutes could not be read: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    step('running the tests')
    try {
      tests = await traderSeam.runTests({ skill: { trips, bars, hourly, key: ref.key }, delay: { trips, costs, bars: minuteBars, funding: fundingRates, nowMs } })
    } catch (error) {
      problems.push(`The tests could not be run: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const analysis: TraderAnalysis = {
    v: TRADER_ANALYSIS_VERSION,
    key: ref.key,
    ref,
    at: Math.floor(nowMs / 1000),
    versions: await traderSeam.versions().catch(() => ({ engine: 'unknown', config: 'unknown' })),
    record: { fills: record.fills.length, firstMs: record.meta.firstMs, lastMs: record.meta.lastMs, fillsCapped: record.meta.fillsCapped, importedAt: record.meta.importedAt },
    figures,
    mapping,
    unmapped,
    skill: tests?.skill ?? null,
    delay: tests?.delay ?? null,
    problems
  }
  await appendJsonLines(join(folderOf(ref.key), `analyses-${monthOf(nowMs)}.jsonl`), [analysis])
  tell({ key: ref.key, step: 'analysed', done: true })
  return analysis
}

/** Every trader on file, with their last analysis; and how many have been analysed, which a verdict is read beside. */
export async function listTraders(): Promise<TraderList> {
  let names: string[] = []
  try {
    names = await readdir(traderSeam.dir())
  } catch {
    return { traders: [], analysed: 0 }
  }
  const traders: { meta: TraderMeta; latest: TraderAnalysis | null }[] = []
  for (const name of names) {
    if (traderRefOfKey(name) === null) continue
    const meta = await readJson<TraderMeta>(join(folderOf(name), 'meta.json'))
    if (meta === null) continue
    const analyses = (await readLines(folderOf(name), /^analyses-(\d{4}-\d{2})\.jsonl$/)).map(readTraderAnalysis).filter((line): line is TraderAnalysis => line !== null)
    traders.push({ meta, latest: analyses.sort((a, b) => b.at - a.at)[0] ?? null })
  }
  traders.sort((a, b) => (b.latest?.at ?? b.meta.importedAt) - (a.latest?.at ?? a.meta.importedAt))
  return { traders, analysed: traders.filter((entry) => entry.latest !== null).length }
}

/** Test seam. */
export function resetTraders(): void {
  listeners.clear()
  analysing = Promise.resolve()
}
