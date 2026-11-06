import type { CoinConsensus } from './topTraders'
import { refOf } from './traderRef'

// TRADERS FOUND BY THE APP (V9 Stage 3, 6 November 2026). The user asked the app to find good, famous traders online
// itself, analyse them and refer to them. Two public rankings name traders with their results, keyless:
//   - OKX's lead-trader ranking (GET /api/v5/copytrading/public-lead-traders, documented): about 220 leaders of 90 days
//     or more, each with their profit since they began leading, their return through the last ninety days, the days
//     they have led, their copiers and the assets those copiers put behind them;
//   - Hyperliquid's leaderboard (https://stats-data.hyperliquid.xyz/Mainnet/leaderboard): every account's value and its
//     profit and volume over a day, a week, a month and all time, 48,234 of them on 6 November 2026 in 39 MB, read in
//     29 seconds. It is the site's own data, read by open-source libraries, and not in Hyperliquid's API documents: said
//     so wherever it is shown.
// Once a day both are read and a FIXED RULE (V9-COPY-FORWARD's, registered 6 November 2026) picks the candidates:
// profit above 0 all time and over the last thirty days; an account of $50,000 or more; thirty days' volume at most a
// hundred times the account, which leaves out market makers; on OKX, ninety days or more leading. OKX publishes neither
// the leader's own account nor their volume, so there the account is the assets their copiers put behind them and the
// volume rule is not read; its thirty days' result is its return then, read from the ninety days' series. Among those
// who pass, those with a public name come first, then the larger all-time profit; at most ten new a day, the venues
// taken in turn, so that one venue's largest accounts do not fill every day. Each candidate is then read and analysed by
// the app's own tests (electron/services/discoveryService.ts), one at a time and half an hour apart.
//
// WHAT A FOUND TRADER'S TESTS MEAN. They were picked for their past profit, so testing that same record for skill
// proves nothing: among thousands, the luckiest pass at any line. Their verdicts here are a description. The claim is
// the forward record of following them on paper from the day they were found, judged pooled (V9-COPY-FORWARD).
//
// IT READS. Nothing here follows, copies, places or holds a key: following a found trader on paper is the user's click.

export const DISCOVERY_LINES = {
  version: 'discovery-v1',
  minAccountUsd: 50_000,
  maxVolumeToAccount: 100,
  minOkxLeadDays: 90,
  /** New candidates a day, at most. */
  newPerDay: 10,
  /** The rankings are read once a day: again this long after the last read. */
  readEverySeconds: 20 * 3600,
  /** After a read that found neither ranking, it is tried again this long after. */
  retrySeconds: 3600,
  /** One analysis at a time, at least this long after the last ended. */
  analysisGapSeconds: 30 * 60,
  /** OKX's thirty days: the point of its return series nearest this many days before its newest. */
  okxMonthDays: 30,
  /** OKX's ranking pages read, at most (about eleven of twenty). */
  okxMaxPages: 15,
  /** A found trader whose reading or analysis failed this many times in a session is left until the next. */
  maxAttempts: 3,
  /** Found traders the page lists, newest first. */
  shownDays: 60
} as const

export const HYPERLIQUID_BOARD_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'
export const OKX_LEADERS_PATH = '/api/v5/copytrading/public-lead-traders'

export type BoardVenue = 'hyperliquid' | 'okx'

/** A trader as a public ranking gives them. */
export interface BoardRow {
  venue: BoardVenue
  /** The address (Hyperliquid, lower case) or the lead trader's code (OKX). */
  id: string
  /** The public name, where there is one. */
  name: string | null
  /** The account's value; on OKX, which publishes none of the leader's own, the assets their copiers put behind them. */
  accountUsd: number
  /** Profit all time; on OKX since they began leading. */
  pnlAllTime: number
  /** The last thirty days: profit in dollars on Hyperliquid; on OKX the return over them, as a ratio. */
  last30d: number
  /** Thirty days' traded volume (Hyperliquid); null on OKX, which publishes none. */
  volume30d: number | null
  leadDays: number | null
  copiers: number | null
  winRatio: number | null
}

const num = (value: unknown): number => (typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN)
const named = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 80) : null)

/** Hyperliquid's leaderboard read into rows: every row with an address and an account value. */
export function hyperliquidBoardOf(json: unknown): BoardRow[] {
  const rows = (json as { leaderboardRows?: unknown } | null)?.leaderboardRows
  if (!Array.isArray(rows)) return []
  const out: BoardRow[] = []
  for (const raw of rows) {
    const row = raw as { ethAddress?: unknown; accountValue?: unknown; displayName?: unknown; windowPerformances?: unknown } | null
    if (row === null || typeof row !== 'object' || typeof row.ethAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(row.ethAddress)) continue
    const windows = new Map<string, { pnl?: unknown; vlm?: unknown }>()
    if (Array.isArray(row.windowPerformances)) {
      for (const entry of row.windowPerformances) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'object' && entry[1] !== null) windows.set(entry[0], entry[1] as { pnl?: unknown; vlm?: unknown })
    }
    const accountUsd = num(row.accountValue)
    if (!Number.isFinite(accountUsd)) continue
    out.push({
      venue: 'hyperliquid',
      id: row.ethAddress.toLowerCase(),
      name: named(row.displayName),
      accountUsd,
      pnlAllTime: num(windows.get('allTime')?.pnl),
      last30d: num(windows.get('month')?.pnl),
      volume30d: num(windows.get('month')?.vlm),
      leadDays: null,
      copiers: null,
      winRatio: null
    })
  }
  return out
}

/** One page of OKX's ranking read into rows, and how many pages it has. */
export function okxBoardOf(data: readonly unknown[]): { rows: BoardRow[]; totalPages: number } {
  const page = data[0] as { ranks?: unknown; totalPage?: unknown } | undefined
  const ranks = Array.isArray(page?.ranks) ? page.ranks : []
  const rows: BoardRow[] = []
  for (const raw of ranks) {
    const rank = raw as { uniqueCode?: unknown; nickName?: unknown; aum?: unknown; pnl?: unknown; pnlRatios?: unknown; leadDays?: unknown; copyTraderNum?: unknown; winRatio?: unknown } | null
    if (rank === null || typeof rank !== 'object' || typeof rank.uniqueCode !== 'string' || !/^(?:[0-9A-Za-z]{16}|\d{18})$/.test(rank.uniqueCode)) continue
    rows.push({
      venue: 'okx',
      id: rank.uniqueCode,
      name: named(rank.nickName),
      accountUsd: num(rank.aum),
      pnlAllTime: num(rank.pnl),
      last30d: okxMonthReturnOf(rank.pnlRatios),
      volume30d: null,
      leadDays: num(rank.leadDays),
      copiers: num(rank.copyTraderNum),
      winRatio: num(rank.winRatio)
    })
  }
  const totalPages = num(page?.totalPage)
  return { rows, totalPages: Number.isFinite(totalPages) && totalPages > 0 ? Math.floor(totalPages) : 1 }
}

/** OKX's return over about the last thirty days: its cumulative return now less its return at the point nearest thirty
 * days before; NaN where the series does not reach back that far. */
export function okxMonthReturnOf(series: unknown, days: number = DISCOVERY_LINES.okxMonthDays): number {
  if (!Array.isArray(series)) return Number.NaN
  const points = series
    .map((entry) => ({ at: num((entry as { beginTs?: unknown } | null)?.beginTs), ratio: num((entry as { pnlRatio?: unknown } | null)?.pnlRatio) }))
    .filter((point) => Number.isFinite(point.at) && Number.isFinite(point.ratio))
    .sort((a, b) => b.at - a.at)
  if (points.length < 2) return Number.NaN
  const newest = points[0]
  const target = newest.at - days * 86_400_000
  if (points[points.length - 1].at > target + 5 * 86_400_000) return Number.NaN
  const before = points.reduce((best, point) => (Math.abs(point.at - target) < Math.abs(best.at - target) ? point : best), points[1])
  return newest.ratio - before.ratio
}

/** Whether a ranking's trader passes the rule. */
export function passesRule(row: BoardRow, lines: typeof DISCOVERY_LINES = DISCOVERY_LINES): boolean {
  if (!(row.pnlAllTime > 0) || !(row.last30d > 0) || !(row.accountUsd >= lines.minAccountUsd)) return false
  if (row.volume30d !== null && !(row.volume30d <= lines.maxVolumeToAccount * row.accountUsd)) return false
  if (row.venue === 'okx' && !((row.leadDays ?? 0) >= lines.minOkxLeadDays)) return false
  return true
}

/** The order the rule takes those who pass in: a public name first, then the larger all-time profit. */
export function ruleOrder(a: BoardRow, b: BoardRow): number {
  return Number(b.name !== null) - Number(a.name !== null) || b.pnlAllTime - a.pnlAllTime || a.id.localeCompare(b.id)
}

/** The key a found trader is kept under, as a pasted one is (shared/traders/traderRef.ts). */
export const boardKeyOf = (row: Pick<BoardRow, 'venue' | 'id'>): string => refOf(row.venue, row.id).key

/** The day's candidates: those who pass the rule and are not known already, each venue in the rule's order, the venues
 * taken in turn, at most `count`. */
export function pickCandidates(rows: readonly BoardRow[], known: ReadonlySet<string>, count: number = DISCOVERY_LINES.newPerDay): BoardRow[] {
  const fresh = (venue: BoardVenue): BoardRow[] => rows.filter((row) => row.venue === venue && passesRule(row) && !known.has(boardKeyOf(row))).sort(ruleOrder)
  const lists = [fresh('hyperliquid'), fresh('okx')]
  const picked: BoardRow[] = []
  const seen = new Set<string>()
  for (let index = 0; picked.length < count && lists.some((list) => index < list.length); index++) {
    for (const list of lists) {
      const row = list[index]
      if (row === undefined || picked.length >= count || seen.has(boardKeyOf(row))) continue
      seen.add(boardKeyOf(row))
      picked.push(row)
    }
  }
  return picked
}

/** What the worker hands back of Hyperliquid's leaderboard: how many rows it held, and those who pass the rule. */
export interface HyperliquidBoardRead {
  total: number
  passed: BoardRow[]
}

/** Hyperliquid's leaderboard text read in the worker (shared/tasks.ts traderBoard): parsed, and the rows that pass. */
export function hyperliquidBoardRead(text: string): HyperliquidBoardRead {
  const rows = hyperliquidBoardOf(JSON.parse(text) as unknown)
  return { total: rows.length, passed: rows.filter((row) => passesRule(row)) }
}

// ---------------------------------------------------------------------------------------------
// The record of what was found: discovery/discovery-YYYY-MM.jsonl, one line a read, a find or a skip.

export interface BoardsSource {
  venue: BoardVenue
  ok: boolean
  rows: number
  passed: number
  error: string | null
}

/** A day's read of the rankings, and the keys it picked. */
export interface BoardsLine {
  kind: 'boards'
  version: typeof DISCOVERY_LINES.version
  at: number
  sources: BoardsSource[]
  picked: string[]
}

/** A trader found: the ranking's figures on the day, and their place among the day's picks. */
export interface FoundLine {
  kind: 'found'
  version: typeof DISCOVERY_LINES.version
  at: number
  key: string
  rank: number
  board: BoardRow
}

/** A found trader the app could not read or analyse, and why: left until it is found again. */
export interface SkipLine {
  kind: 'skipped'
  at: number
  key: string
  why: string
}

/** A day's read of what the analysed found traders hold (V9 Stage 4; shared/traders/topTraders.ts): how many were read
 * and how many could not be, each coin of the forecast's universe they hold, and how many calls it made. */
export interface HoldingsLine {
  kind: 'holdings'
  at: number
  /** The UTC day it is the read of, in seconds. */
  day: number
  traders: number
  failed: number
  consensus: CoinConsensus[]
  calls: number
}

export type DiscoveryLine = BoardsLine | FoundLine | SkipLine | HoldingsLine

const isRow = (value: unknown): value is BoardRow => {
  const row = value as Partial<BoardRow> | null
  return typeof row === 'object' && row !== null && (row.venue === 'okx' || row.venue === 'hyperliquid') && typeof row.id === 'string' && typeof row.accountUsd === 'number' && typeof row.pnlAllTime === 'number'
}

/** A stored line read as one; null for one out of shape. */
export function readDiscoveryLine(value: unknown): DiscoveryLine | null {
  const line = value as { kind?: unknown; at?: unknown; sources?: unknown; picked?: unknown; key?: unknown; rank?: unknown; board?: unknown; why?: unknown; day?: unknown; consensus?: unknown } | null
  if (typeof line !== 'object' || line === null || typeof line.at !== 'number') return null
  if (line.kind === 'boards' && Array.isArray(line.sources) && Array.isArray(line.picked)) return line as unknown as BoardsLine
  if (line.kind === 'found' && typeof line.key === 'string' && typeof line.rank === 'number' && isRow(line.board) && boardKeyOf(line.board) === line.key) return line as unknown as FoundLine
  if (line.kind === 'skipped' && typeof line.key === 'string' && typeof line.why === 'string') return line as unknown as SkipLine
  if (line.kind === 'holdings' && typeof line.day === 'number' && Array.isArray(line.consensus)) return line as unknown as HoldingsLine
  return null
}

// ---------------------------------------------------------------------------------------------
// What the page shows.

/** A found trader's last analysis, as the page needs it. */
export interface FoundAnalysis {
  at: number
  trips: number
  netUsd: number
  skill: string | null
  clone: string | null
  /** A follower a minute late, at the venue's costs: the mean net of a copied trip, in percent; null where not measured. */
  followerNetPct: number | null
}

export type FoundStatus = 'queued' | 'analysing' | 'analysed' | 'skipped'

export interface FoundTrader {
  key: string
  foundAt: number
  rank: number
  board: BoardRow
  status: FoundStatus
  why: string | null
  latest: FoundAnalysis | null
}

export interface DiscoveryState {
  enabled: boolean
  /** The last read of the rankings, and what each gave. */
  lastReadAt: number | null
  sources: BoardsSource[]
  /** Found in the last DISCOVERY_LINES.shownDays days, newest first. */
  found: FoundTrader[]
  /** Found traders analysed, all told: what their verdicts are read beside. */
  analysed: number
  /** Waiting to be analysed, and the one being analysed now. */
  queued: number
  analysing: string | null
  /** When the next analysis may start. */
  nextAnalysisAt: number | null
  /** What the analysed found traders held when last read (V9 Stage 4): context, never a call shown. */
  holdings: HoldingsLine | null
}

export const EMPTY_DISCOVERY: DiscoveryState = { enabled: true, lastReadAt: null, sources: [], found: [], analysed: 0, queued: 0, analysing: null, nextAnalysisAt: null, holdings: null }

/** The found traders waiting for an analysis, the first found first: queued, and not tried too often this session. */
export function queueOf(found: readonly FoundTrader[], attempts: ReadonlyMap<string, number>, maxAttempts: number = DISCOVERY_LINES.maxAttempts): string[] {
  return found
    .filter((entry) => entry.status === 'queued' && (attempts.get(entry.key) ?? 0) < maxAttempts)
    .sort((a, b) => a.foundAt - b.foundAt || a.rank - b.rank)
    .map((entry) => entry.key)
}

/** The found traders as the page lists them: each one's last find, its status from the skips, the one analysing and the
 * analyses on file, newest first, those of the last `shownDays`. */
export function foundTradersOf(
  lines: readonly DiscoveryLine[],
  analyses: ReadonlyMap<string, FoundAnalysis>,
  analysing: string | null,
  nowSec: number,
  shownDays: number = DISCOVERY_LINES.shownDays
): FoundTrader[] {
  const found = new Map<string, FoundLine>()
  const skipped = new Map<string, SkipLine>()
  for (const line of [...lines].sort((a, b) => a.at - b.at)) {
    if (line.kind === 'found') {
      found.set(line.key, line)
      skipped.delete(line.key)
    } else if (line.kind === 'skipped') skipped.set(line.key, line)
  }
  return [...found.values()]
    .filter((line) => nowSec - line.at <= shownDays * 86_400)
    .map((line): FoundTrader => {
      const latest = analyses.get(line.key) ?? null
      const skip = skipped.get(line.key) ?? null
      const status: FoundStatus = analysing === line.key ? 'analysing' : latest !== null ? 'analysed' : skip !== null ? 'skipped' : 'queued'
      return { key: line.key, foundAt: line.at, rank: line.rank, board: line.board, status, why: status === 'skipped' ? (skip?.why ?? null) : null, latest }
    })
    .sort((a, b) => b.foundAt - a.foundAt || a.rank - b.rank)
}
