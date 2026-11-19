import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import {
  DISCOVERY_LINES,
  EMPTY_DISCOVERY,
  HYPERLIQUID_BOARD_URL,
  OKX_LEADERS_PATH,
  boardKeyOf,
  foundTradersOf,
  okxBoardOf,
  passesRule,
  pickCandidates,
  queueOf,
  readDiscoveryLine,
  shortRecordOf,
  skillBeyondChance,
  type BoardRow,
  type BoardsSource,
  type DiscoveryLine,
  type DiscoveryState,
  type FoundAnalysis,
  type HoldingsLine,
  type HyperliquidBoardRead
} from '../../shared/traders/discovery'
import type { SourcePrediction } from '../../shared/evaluation/predictionRecord'
import { DELAY_LINES } from '../../shared/traders/delay'
import type { PricePrediction } from '../../shared/forecast/prediction'
import { hyperliquidStateOf, type OpenPosition } from '../../shared/traders/hyperliquid'
import { TOP_TRADERS_LINES, consensusOf, holdingsOf, okxSidesOf, topTraderPredictionsOf, type TraderHolding } from '../../shared/traders/topTraders'
import type { TraderAnalysis, TraderList } from '../../shared/traders/traderAnalysis'
import { getEffectiveConfig } from './effectiveConfigService'
import { latestForecasts } from './forecastService'
import { inBackground } from './httpPacing'
import { hyperliquidInfo } from './hyperliquidClient'
import { appendJsonLines, listMonthFiles } from './jsonlStore'
import { OKX_PATHS, okxGet } from './okxClient'
import { recordTopTraderCalls } from './predictionLedgerService'
import { getSettings, setSettings } from './settingsService'
import { runInWorker } from './taskWorkerService'
import { analyzeTrader, importTrader, listTraders } from './traderService'

/** The delay test's row an OKX trader's follower is read at: OKX's public positions come about five minutes late. */
const OKX_FOLLOWER_DELAY_MIN = 5

// TRADERS FOUND BY THE APP (V9 Stage 3; the rule is shared/traders/discovery.ts). Once a day OKX's lead-trader ranking
// (through okxGet, its budget) and Hyperliquid's leaderboard (one GET of a 39 MB file, read in the worker) are read, the
// rule picks at most ten traders not on file yet, and each is kept as found in discovery/discovery-YYYY-MM.jsonl. Then,
// one at a time and at least half an hour after the last ended, each found trader is read and analysed as a pasted one
// is (traderService.ts importTrader and analyzeTrader); one whose analysis lost reads, to an outage or a stalled page,
// is analysed again from the record on file six hours on, twice at most (V9 Stage 9, 19 November 2026: in v9-7d 26 of
// 63 analyses lost reads, and nothing read them again). Everything here runs in the background lane of the request
// budgets (httpPacing.ts inBackground): a paper follow's reads go first. Switched off (settings `discovery.enabled`
// false), it reads nothing. It reads public data and keeps what it read: no key, no model, no order, no one followed.
//
// And once a day (V9 Stage 4; shared/traders/topTraders.ts), at the first turn of the UTC day's first two hours, what the analysed found
// traders hold now: each one's open positions, counted coin by coin over the forecast's universe; where at least three
// hold a coin and two thirds of them one way, that way is recorded as a call of the source 'top-traders' for the next
// day (predictionLedgerService.ts), to be judged after sixty days as V9-TOP-TRADERS-2 says. Shown on Copy Traders as
// context only: never on Home, never a card's side.

const FILE = /^discovery-(\d{4}-\d{2})\.jsonl$/
const TICK_MS = 5 * 60_000
const FIRST_TICK_MS = 2 * 60_000

/** What the service reads the world through: a test hands in its own. */
export const discoverySeam = {
  dir: (): string => join(app.getPath('userData'), 'discovery'),
  nowMs: (): number => Date.now(),
  enabled: async (): Promise<boolean> => (await getSettings()).discovery?.enabled !== false,
  setEnabled: async (on: boolean): Promise<void> => {
    await setSettings({ discovery: { enabled: on } })
  },
  okxPage: (page: number): Promise<unknown[]> => okxGet(OKX_LEADERS_PATH, { instType: 'SWAP', sortType: 'pnl', minLeadDays: '3', page: String(page), limit: '20' }),
  boardText: async (): Promise<string> => {
    const response = await fetch(HYPERLIQUID_BOARD_URL, { signal: AbortSignal.timeout(180_000), headers: { 'User-Agent': 'Mozilla/5.0 (TraderSpider trader finder)' } })
    if (!response.ok) throw new Error(`it answered ${response.status}`)
    return response.text()
  },
  readBoard: async (text: string): Promise<HyperliquidBoardRead> => {
    const outcome = await runInWorker('traderBoard', { text }, { timeoutMs: 60_000, maxOldGenerationSizeMb: 512 })
    if (!outcome.ok) throw new Error(outcome.reason === 'timeout' ? 'its leaderboard took too long to read' : outcome.reason === 'memory' ? 'its leaderboard is too large to read' : outcome.message)
    return outcome.result as HyperliquidBoardRead
  },
  list: (): Promise<TraderList> => listTraders(),
  read: (id: string): ReturnType<typeof importTrader> => importTrader(id),
  analyze: (key: string): Promise<TraderAnalysis> => analyzeTrader(key),
  /** A found trader's open positions now: Hyperliquid's account state, or OKX's current positions. */
  positions: async (venue: 'hyperliquid' | 'okx', id: string): Promise<Pick<OpenPosition, 'coin' | 'size'>[]> => {
    if (venue === 'okx') return okxSidesOf(await okxGet(OKX_PATHS.current, { instType: 'SWAP', uniqueCode: id, limit: '100' }))
    const state = hyperliquidStateOf(await hyperliquidInfo<unknown>('clearinghouseState', { user: id }))
    if (state === null) throw new Error('Hyperliquid gave no account state')
    return state.positions
  },
  forecasts: (): PricePrediction[] => latestForecasts(),
  versions: async (): Promise<{ engine: string; config: string }> => {
    const config = await getEffectiveConfig()
    return { engine: config.engineVersion, config: config.configVersion }
  },
  record: (predictions: readonly SourcePrediction[]): Promise<number> => recordTopTraderCalls(predictions)
}

let lines: DiscoveryLine[] = []
let loaded = false
let state: DiscoveryState = EMPTY_DISCOVERY
let analysing: string | null = null
let lastAnalysisEndMs: number | null = null
let lastAttemptMs: number | null = null
const attempts = new Map<string, number>()
const listeners = new Set<(state: DiscoveryState) => void>()
let timer: ReturnType<typeof setInterval> | null = null
let busy = false

const monthKey = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 7)
const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export function onDiscovery(listener: (state: DiscoveryState) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function discoveryState(): DiscoveryState {
  return state
}

async function load(): Promise<void> {
  if (loaded) return
  loaded = true
  for (const { name } of await listMonthFiles(discoverySeam.dir(), FILE)) {
    let text = ''
    try {
      text = await readFile(join(discoverySeam.dir(), name), 'utf-8')
    } catch {
      continue
    }
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue
      try {
        const line = readDiscoveryLine(JSON.parse(raw) as unknown)
        if (line !== null) lines.push(line)
      } catch {
        // A torn line is left out.
      }
    }
  }
}

async function keep(rows: DiscoveryLine[]): Promise<void> {
  if (rows.length === 0) return
  lines.push(...rows)
  const byMonth = new Map<string, DiscoveryLine[]>()
  for (const row of rows) byMonth.set(monthKey(row.at), [...(byMonth.get(monthKey(row.at)) ?? []), row])
  for (const [month, monthRows] of byMonth) await appendJsonLines(join(discoverySeam.dir(), `discovery-${month}.jsonl`), monthRows)
}

/** An analysis as the page shows it: its trips, net, verdicts, and a follower's net at the delay test's shortest delay
 * (two minutes; until 9 November it looked for a one-minute row the test never makes, so the page showed none). */
export function foundAnalysisOf(analysis: TraderAnalysis): FoundAnalysis {
  // OKX shows a lead trader's positions about five minutes after they trade: its follower is read at five minutes.
  const delayMin = analysis.record?.source === 'okx' ? OKX_FOLLOWER_DELAY_MIN : DELAY_LINES.delaysMin[0]
  const late = analysis.delay?.rows.find((row) => row.delayMin === delayMin && row.costMultiplier === 1) ?? null
  return {
    at: analysis.at,
    trips: analysis.figures.trips,
    netUsd: analysis.figures.money.net,
    skill: analysis.skill?.verdict ?? null,
    clone: analysis.clone?.verdict ?? null,
    followerNetPct: late?.meanNetPct ?? null,
    followerDelayMin: late === null ? null : delayMin,
    pSkill: typeof analysis.skill?.pShift === 'number' && typeof analysis.skill.pFlip === 'number' ? Math.max(analysis.skill.pShift, analysis.skill.pFlip) : null,
    unread: Array.isArray(analysis.problems) ? analysis.problems.length : 0
  }
}

async function publish(): Promise<void> {
  const nowSec = Math.floor(discoverySeam.nowMs() / 1000)
  const list = await discoverySeam.list().catch((): TraderList => ({ traders: [], analysed: 0 }))
  const analyses = new Map<string, FoundAnalysis>()
  for (const entry of list.traders) if (entry.latest !== null) analyses.set(entry.meta.ref.key, foundAnalysisOf(entry.latest))
  const found = foundTradersOf(lines, analyses, analysing, nowSec)
  const everFound = new Set(lines.filter((line) => line.kind === 'found').map((line) => (line.kind === 'found' ? line.key : '')))
  const last = [...lines].reverse().find((line) => line.kind === 'boards')
  const held = [...lines].reverse().find((line): line is HoldingsLine => line.kind === 'holdings') ?? null
  const nextAnalysisAt = lastAnalysisEndMs === null ? null : Math.floor(lastAnalysisEndMs / 1000) + DISCOVERY_LINES.analysisGapSeconds
  state = {
    enabled: await discoverySeam.enabled().catch(() => true),
    lastReadAt: last?.at ?? null,
    sources: last?.kind === 'boards' ? last.sources : [],
    found,
    analysed: [...everFound].filter((key) => analyses.has(key)).length,
    // Over the found traders alone: a trader pasted by hand was not picked by the rule.
    beyondChance: skillBeyondChance([...everFound].flatMap((key) => analyses.get(key) ?? [])),
    queued: queueOf(found, attempts, nowSec).length,
    analysing,
    nextAnalysisAt,
    holdings: held
  }
  for (const listener of listeners) {
    try {
      listener(state)
    } catch (error) {
      console.error('A discovery listener failed:', error)
    }
  }
}

/** Reads the two rankings and keeps the day's picks. */
async function readBoards(): Promise<void> {
  const nowMs = discoverySeam.nowMs()
  lastAttemptMs = nowMs
  const sources: BoardsSource[] = []
  const rows: BoardRow[] = []
  // OKX: its ranking page by page, as many as it says it has, up to the line.
  try {
    const okxRows: BoardRow[] = []
    let pages = 1
    for (let page = 1; page <= Math.min(pages, DISCOVERY_LINES.okxMaxPages); page++) {
      const read = okxBoardOf(await discoverySeam.okxPage(page))
      pages = read.totalPages
      okxRows.push(...read.rows)
    }
    rows.push(...okxRows)
    sources.push({ venue: 'okx', ok: true, rows: okxRows.length, passed: okxRows.filter((row) => passesRule(row)).length, error: null })
  } catch (error) {
    sources.push({ venue: 'okx', ok: false, rows: 0, passed: 0, error: `OKX's ranking could not be read: ${describe(error)}` })
  }
  // Hyperliquid: one file of every account, read in the worker, which hands back those who pass the rule.
  try {
    const read = await discoverySeam.readBoard(await discoverySeam.boardText())
    rows.push(...read.passed)
    sources.push({ venue: 'hyperliquid', ok: true, rows: read.total, passed: read.passed.length, error: null })
  } catch (error) {
    sources.push({ venue: 'hyperliquid', ok: false, rows: 0, passed: 0, error: `Hyperliquid's leaderboard could not be read: ${describe(error)}` })
  }
  const atSec = Math.floor(nowMs / 1000)
  if (!sources.some((source) => source.ok)) {
    await keep([{ kind: 'boards', version: DISCOVERY_LINES.version, at: atSec, sources, picked: [] }])
    return
  }
  // Known: every trader on file, pasted or found, and every one found before.
  const list = await discoverySeam.list().catch((): TraderList => ({ traders: [], analysed: 0 }))
  const known = new Set<string>([...list.traders.map((entry) => entry.meta.ref.key), ...lines.flatMap((line) => (line.kind === 'found' ? [line.key] : []))])
  const picked = pickCandidates(rows, known)
  await keep([
    { kind: 'boards', version: DISCOVERY_LINES.version, at: atSec, sources, picked: picked.map(boardKeyOf) },
    ...picked.map((board, index) => ({ kind: 'found' as const, version: DISCOVERY_LINES.version, at: atSec, key: boardKeyOf(board), rank: index + 1, board }))
  ])
}

/** What the analysed found traders hold, read once a UTC day: each one's positions, the coins of the forecast's universe
 * counted, the rule's calls recorded, and the day's line kept. A trader who cannot be read is counted as failed. Where
 * none could be read and a turn is still to come inside the day's window, nothing is kept and the next turn reads again
 * (v9-7d, 15 November 2026: every one of 44 failed in a network outage at 00:03, and the day had no read). */
async function readHoldings(): Promise<void> {
  const nowSec = Math.floor(discoverySeam.nowMs() / 1000)
  const day = Math.floor(nowSec / 86_400) * 86_400
  if (nowSec - day >= TOP_TRADERS_LINES.readWindowSec || lines.some((line) => line.kind === 'holdings' && line.day === day)) return
  const analysed = state.found.filter((entry) => entry.latest !== null)
  if (analysed.length === 0) return
  const holdings: TraderHolding[] = []
  let failed = 0
  for (const entry of analysed) {
    try {
      holdings.push(...holdingsOf(entry.key, await discoverySeam.positions(entry.board.venue, entry.board.id)))
    } catch (error) {
      failed++
      console.warn(`Discovery: what ${entry.key} holds could not be read:`, describe(error))
    }
  }
  if (failed === analysed.length && Math.floor(discoverySeam.nowMs() / 1000) + TICK_MS / 1000 < day + TOP_TRADERS_LINES.readWindowSec) {
    console.warn(`Discovery: none of the ${failed} found traders' holdings could be read; read again at the next turn.`)
    return
  }
  const forecasts = discoverySeam.forecasts()
  const universe = new Set(forecasts.map((prediction) => prediction.pair.replace(/USDT$/, '')))
  const prices = new Map(forecasts.map((prediction) => [prediction.pair, prediction.currentPrice] as const))
  const consensus = consensusOf(holdings, universe)
  const calls = topTraderPredictionsOf(consensus, nowSec, prices, analysed.length - failed, await discoverySeam.versions())
  const recorded = calls.length === 0 ? 0 : await discoverySeam.record(calls)
  await keep([{ kind: 'holdings', at: nowSec, day, traders: analysed.length - failed, failed, consensus, calls: recorded }])
}

/** Reads and analyses the first found trader waiting, where the half hour since the last has passed: one never
 * analysed, else one whose last analysis lost reads, analysed again from the record on file. */
async function analyseNext(): Promise<void> {
  const nowMs = discoverySeam.nowMs()
  if (analysing !== null || (lastAnalysisEndMs !== null && nowMs - lastAnalysisEndMs < DISCOVERY_LINES.analysisGapSeconds * 1000)) return
  const key = queueOf(state.found, attempts, Math.floor(nowMs / 1000))[0]
  if (key === undefined) return
  const found = state.found.find((entry) => entry.key === key)
  if (found === undefined) return
  const lost = found.status === 'analysed' ? (found.latest?.unread ?? 0) : 0
  analysing = key
  await publish()
  try {
    if (lost > 0) {
      // Kept first: an analysis that never ends still counts against the times it may be made again.
      await keep([{ kind: 'again', at: Math.floor(nowMs / 1000), key, unread: lost }])
      await discoverySeam.analyze(key)
    } else {
      const read = await discoverySeam.read(found.board.id)
      // A venue's refusal, or a record too short for the tests (an account trading too fast for Hyperliquid's window of
      // fills), is kept as a skip with why; only a record the tests can read is analysed.
      const short = 'refused' in read ? null : shortRecordOf(read)
      if ('refused' in read) await keep([{ kind: 'skipped', at: Math.floor(discoverySeam.nowMs() / 1000), key, why: read.refused }])
      else if (short !== null) await keep([{ kind: 'skipped', at: Math.floor(discoverySeam.nowMs() / 1000), key, why: short }])
      else await discoverySeam.analyze(key)
    }
  } catch (error) {
    const tried = (attempts.get(key) ?? 0) + 1
    attempts.set(key, tried)
    console.warn(`Discovery: ${key} could not be read or analysed (try ${tried}):`, describe(error))
    if (tried >= DISCOVERY_LINES.maxAttempts) await keep([{ kind: 'skipped', at: Math.floor(discoverySeam.nowMs() / 1000), key, why: describe(error).slice(0, 300) }])
  } finally {
    analysing = null
    lastAnalysisEndMs = discoverySeam.nowMs()
  }
  await publish()
}

/** One turn: switched on, the rankings read where a day has passed since the last read (an hour after a read that found
 * neither), what the analysed found traders hold where the day's read is due, then the next analysis where it is due.
 * In the background lane, one turn at a time. An analysis is not the turn's: a long record's can read bars for an hour
 * and more, and the turns after go on meanwhile, so the day's holdings are read in its first two hours whatever is
 * being analysed (V9 Stage 8). The promise ends with the analysis the turn started. */
export async function discoveryTurn(): Promise<void> {
  if (busy) return
  busy = true
  let started: Promise<void> = Promise.resolve()
  try {
    await load()
    if (!(await discoverySeam.enabled())) {
      await publish()
      return
    }
    await inBackground(async () => {
      const nowMs = discoverySeam.nowMs()
      const last = [...lines].reverse().find((line) => line.kind === 'boards')
      const lastOk = last?.kind === 'boards' && last.sources.some((source) => source.ok)
      const dueSec = last === undefined ? 0 : last.at + (lastOk ? DISCOVERY_LINES.readEverySeconds : DISCOVERY_LINES.retrySeconds)
      if (nowMs / 1000 >= dueSec && (lastAttemptMs === null || nowMs - lastAttemptMs >= DISCOVERY_LINES.retrySeconds * 1000)) await readBoards()
      await publish()
      await readHoldings().catch((error) => console.warn("Discovery: the found traders' holdings could not be read:", describe(error)))
      started = analyseNext()
    })
    await publish()
  } catch (error) {
    console.error('Discovery failed a turn:', error)
  } finally {
    busy = false
  }
  await started.catch((error) => console.error('Discovery failed an analysis:', error))
}

/** Switches finding traders on or off, and tells the page. */
export async function setDiscovery(on: unknown): Promise<DiscoveryState> {
  await discoverySeam.setEnabled(on === true)
  await load()
  await publish()
  if (on === true) void discoveryTurn()
  return state
}

/** Loads what was found, and starts the turns: the first a little after the app starts. Called once, from main.ts. */
export function startDiscovery(): void {
  if (timer !== null) return
  setTimeout(() => void discoveryTurn(), FIRST_TICK_MS)
  timer = setInterval(() => void discoveryTurn(), TICK_MS)
}

export function stopDiscovery(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
}

/** Test seam: as a new session finds it. */
export function resetDiscovery(): void {
  lines = []
  loaded = false
  state = EMPTY_DISCOVERY
  analysing = null
  lastAnalysisEndMs = null
  lastAttemptMs = null
  attempts.clear()
  listeners.clear()
  busy = false
  stopDiscovery()
}
