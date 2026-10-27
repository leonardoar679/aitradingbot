import type { Candle } from '../ipc'
import type { CloneResult } from './clone'
import type { DelayResult } from './delay'
import { perpCandidatesOf } from './hyperliquid'
import type { OkxOpen, OkxPnlPoint, OkxStats } from './okx'
import type { TraderRef } from './traderRef'
import type { CloseSeries, SkillResult } from './skill'
import type { TraderFigures } from './traderFigures'

// A TRADER'S ANALYSIS, ON FILE (V8 Stage 6, 26 October 2026): one line each time a trader is analysed, in
// traders/<key>/analyses-YYYY-MM.jsonl -- the record it was made from, the figures, which of the trader's coins a
// venue's perpetual was found for, the two tests' results and what could not be read -- with the engine's and the
// configuration's versions, so that any figure can be traced to the lines it was made under. And the pure helpers the
// main process's analysis uses to make it: bars into close series, the minutes a delay test reads, a coin's perpetual.

export const TRADER_ANALYSIS_VERSION = 'trader-analysis-v2'

/** The tests read every completed trip of the record, on every coin a venue's perpetual covers, as their registrations
 * say (V8-S6-SKILL, V8-S6-DELAY): nothing here narrows them. These lines are what the analysis fetches to that end. */
export const TRADER_ANALYSIS_LINES = {
  version: TRADER_ANALYSIS_VERSION,
  /** A delay test reads a trip's minutes from its own time to this many minutes after: the latest delay, 15 minutes,
   * and the two minutes within which a bar's open is the price. */
  delayWindowMin: 17
} as const

/** What is kept of a trader, as read back (traders/<key>/meta.json). */
export interface TraderMeta {
  v: typeof TRADER_STORE_VERSION
  ref: TraderRef
  /** When the record was last read, in seconds. */
  importedAt: number
  /** What the record is made of, and how far it can be trusted: Hyperliquid's fills (VERIFIED), OKX's reported positions
   * (REPORTED, the app's figures ESTIMATED beside them), or a file a person brought (UNVERIFIABLE). */
  source: 'hyperliquid' | 'okx' | 'file'
  label: 'VERIFIED' | 'REPORTED' | 'UNVERIFIABLE'
  /** Fills, positions or a file's rows on file, and what they span. */
  records: number
  firstMs: number | null
  lastMs: number | null
  /** The venue gives more than was read: Hyperliquid's most recent 10,000 fills, OKX's three months of positions. */
  capped: boolean
  /** A file's name as it was opened, what its rows are, and its rows refused with why, the first few; null for a
   * venue's record. */
  name: string | null
  fileKind: 'fills' | 'trips' | null
  fileRefused: { count: number; reasons: string[] } | null
}

export const TRADER_STORE_VERSION = 'trader-store-v2'

/** A kept meta.json read back; null for one this version does not know. */
export function readTraderMeta(value: unknown): TraderMeta | null {
  const meta = value as Partial<TraderMeta> | null
  if (meta === null || typeof meta !== 'object' || meta.v !== TRADER_STORE_VERSION || typeof meta.records !== 'number' || typeof meta.ref?.key !== 'string') return null
  return meta as TraderMeta
}

/** OKX's own figures beside the app's estimate, for a trader read from OKX. */
export interface OkxSummary {
  positions: number
  /** Positions the app could not price: no contract value for their instrument. */
  notPriced: number
  /** OKX's own profit over the positions (REPORTED), and the app's estimate of the same positions (ESTIMATED). */
  reportedPnl: number
  estimate: { gross: number; fees: number; funding: number; net: number; fundingUnknown: number }
  open: OkxOpen | null
  series: OkxPnlPoint[]
  stats: OkxStats | null
}

/** What a trader's page is told as an import or an analysis goes: the step it is at. */
export interface TraderProgress {
  key: string
  step: string
  done: boolean
}

/** The traders on file with their last analysis, and how many have been analysed. */
export interface TraderList {
  traders: { meta: TraderMeta; latest: TraderAnalysis | null }[]
  analysed: number
}

export interface BitgetCopiedTrader {
  id: string
  name: string | null
}

/** The read-only Bitget copy-trading check (electron/services/exchanges/bitgetCopyRead.ts). */
export interface BitgetCopyCheck {
  /** When it was asked, in seconds. */
  at: number
  /** No key on Connections: nothing was asked. */
  configured: boolean
  /** The account's mode as Bitget gives it: unified ('uta'), Classic, or not known; null where it could not be read. */
  accountMode: 'uta' | 'classic' | 'unknown' | null
  modeProblem: string | null
  /** The follower read: the traders copied, or Bitget's refusal -- its code and words, the key's permission among them. */
  followerRead: { ok: true; endpoint: string; traders: BitgetCopiedTrader[] } | { ok: false; endpoint: string; code: string | null; message: string } | null
}

export interface CoinVenue {
  coin: string
  venue: 'binance' | 'bitget'
  symbol: string
}

export interface TraderAnalysis {
  v: typeof TRADER_ANALYSIS_VERSION
  key: string
  ref: TraderRef
  /** When it was made, in seconds. */
  at: number
  versions: { engine: string; config: string }
  record: Pick<TraderMeta, 'source' | 'label' | 'records' | 'firstMs' | 'lastMs' | 'capped' | 'importedAt' | 'name' | 'fileKind' | 'fileRefused'>
  figures: TraderFigures
  /** OKX's own figures beside the app's estimate; null for another source. */
  okx: OkxSummary | null
  /** The coins a venue's perpetual was found for, and those none was: their trips are without bars in the tests. */
  mapping: CoinVenue[]
  unmapped: string[]
  skill: SkillResult | null
  delay: DelayResult | null
  /** V8-S7-CLONE: can a rule of the market's state do what the trader does? */
  clone: CloneResult | null
  /** What could not be read, in words. */
  problems: string[]
}

/** A stored line read as an analysis; null for one this version does not know. */
export function readTraderAnalysis(value: unknown): TraderAnalysis | null {
  const line = value as Partial<TraderAnalysis> | null
  if (line === null || typeof line !== 'object' || line.v !== TRADER_ANALYSIS_VERSION || typeof line.key !== 'string' || typeof line.at !== 'number' || typeof line.figures !== 'object') return null
  return line as TraderAnalysis
}

/** A coin's perpetual: Binance's first, Bitget's where Binance lists none; null where neither does. */
export function coinVenueOf(coin: string, binance: ReadonlySet<string>, bitget: ReadonlySet<string>): CoinVenue | null {
  const candidates = perpCandidatesOf(coin)
  const onBinance = candidates.find((symbol) => binance.has(symbol))
  if (onBinance !== undefined) return { coin, venue: 'binance', symbol: onBinance }
  const onBitget = candidates.find((symbol) => bitget.has(symbol))
  return onBitget === undefined ? null : { coin, venue: 'bitget', symbol: onBitget }
}

/** Bars as a close series at their step from the first bar on, a missing bar taking the close before it. */
export function seriesOf(candles: readonly Candle[], stepSec: number): CloseSeries | null {
  const sorted = [...candles].filter((candle) => candle.close > 0).sort((a, b) => a.time - b.time)
  if (sorted.length === 0) return null
  const start = sorted[0].time
  const count = Math.floor((sorted[sorted.length - 1].time - start) / stepSec) + 1
  const closes = new Float64Array(count)
  let at = 0
  let last = sorted[0].close
  for (let k = 0; k < count; k++) {
    const time = start + k * stepSec
    while (at < sorted.length && sorted[at].time < time) at++
    if (at < sorted.length && sorted[at].time === time) last = sorted[at].close
    closes[k] = last
  }
  return { startSec: start, stepSec, closes }
}

/** The spans of minutes a delay test reads, each moment's window joined with its neighbours where they overlap or
 * nearly meet, no span longer than a page of bars: what to fetch, in as few requests as it takes. */
export function minuteSpansOf(moments: readonly number[], windowMin: number = TRADER_ANALYSIS_LINES.delayWindowMin, maxBars = 1500): { fromSec: number; toSec: number }[] {
  const starts = [...new Set(moments.map((sec) => Math.floor(sec / 60) * 60))].sort((a, b) => a - b)
  const spans: { fromSec: number; toSec: number }[] = []
  for (const start of starts) {
    const end = start + (windowMin + 1) * 60
    const last = spans[spans.length - 1]
    if (last !== undefined && start <= last.toSec + 60 * 60 && end - last.fromSec <= maxBars * 60) last.toSec = Math.max(last.toSec, end)
    else spans.push({ fromSec: start, toSec: end })
  }
  return spans
}
