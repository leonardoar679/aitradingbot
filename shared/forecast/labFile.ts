import type { Direction } from './direction'
import { HORIZONS, type Horizon } from './features'
import { LAB_VERSION } from './lab'
import type { LabHorizon, ReplayRow } from './labWalkForward'

// THE LAB ON FILE (V6 Stage 11, 13 October 2026): forecastModels/<run>/lab.json, what the walk forward's
// record gave the Lab, made once a walk forward in the worker; and lab-replay-<horizon>.json, every tested
// hour's forecast in percent beside what came, which the replay reads. Figures are rounded to the fourth
// decimal, which no table shows past.

export interface LabFile {
  version: string
  runId: string
  /** Unix seconds: when it was made; the first and last tested hour. */
  madeAt: number
  span: { from: number; to: number } | null
  pairs: string[]
  horizons: Partial<Record<Horizon, LabHorizon>>
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000

/** JSON with every figure at four decimals; NaN and infinities as null. */
export function compactJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'number' ? (Number.isFinite(entry) ? round(entry) : null) : entry))
}

export function serializeLab(file: LabFile): string {
  return compactJson(file)
}

/** A Lab read back; null for one of another version or no shape of one. */
export function parseLab(text: string): LabFile | null {
  let raw: Partial<LabFile>
  try {
    raw = JSON.parse(text) as Partial<LabFile>
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || raw.version !== LAB_VERSION || typeof raw.runId !== 'string' || typeof raw.horizons !== 'object' || raw.horizons === null) return null
  if (!Array.isArray(raw.pairs) || Object.keys(raw.horizons).some((horizon) => !HORIZONS.includes(horizon as Horizon))) return null
  return raw as LabFile
}

const DIRECTIONS: Direction[] = ['NEUTRAL', 'BULLISH', 'BEARISH']

interface ReplayFile {
  version: string
  horizon: Horizon
  symbols: string[]
  /** [t, symbol, five levels, P(up) or null, the call, move, best, worst] */
  rows: (number | null)[][]
}

export function serializeReplay(horizon: Horizon, rows: readonly ReplayRow[]): string {
  const symbols = [...new Set(rows.map((row) => row.pair))].sort()
  const index = new Map(symbols.map((symbol, at) => [symbol, at]))
  const file: ReplayFile = {
    version: LAB_VERSION,
    horizon,
    symbols,
    rows: rows.map((row) => [row.t, index.get(row.pair)!, ...row.q, row.pUp, DIRECTIONS.indexOf(row.dir), row.move, row.best, row.worst])
  }
  return compactJson(file)
}

export function parseReplay(text: string): { horizon: Horizon; rows: ReplayRow[] } | null {
  let raw: Partial<ReplayFile>
  try {
    raw = JSON.parse(text) as Partial<ReplayFile>
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null || raw.version !== LAB_VERSION || !HORIZONS.includes(raw.horizon as Horizon) || !Array.isArray(raw.symbols) || !Array.isArray(raw.rows)) return null
  const symbols = raw.symbols
  const rows: ReplayRow[] = []
  for (const entry of raw.rows) {
    if (!Array.isArray(entry) || entry.length !== 12) continue
    const [t, symbol, q10, q25, q50, q75, q90, pUp, dir, move, best, worst] = entry
    const pair = typeof symbol === 'number' ? symbols[symbol] : undefined
    const figures = [t, q10, q25, q50, q75, q90, move, best, worst]
    if (pair === undefined || !figures.every((figure) => typeof figure === 'number') || typeof dir !== 'number' || DIRECTIONS[dir] === undefined) continue
    rows.push({ t: t as number, pair, q: [q10, q25, q50, q75, q90] as number[], pUp: typeof pUp === 'number' ? pUp : null, dir: DIRECTIONS[dir], move: move as number, best: best as number, worst: worst as number })
  }
  return { horizon: raw.horizon as Horizon, rows }
}
