// ARE THE ODDS OF A MOVE THAT CLEARS ITS COSTS HONEST? (V7.2-R Stage 3, 20 October 2026; V72R-S3-ODDS.)
//
// A forecast's record keeps, for every horizon it was made at, the five shown levels (P10 to P90 in percent)
// and, since V7.1 Stage 3, the path's likely highs and lows; each outcome keeps the move a horizon on and the
// path's best and worst. So the chances shared/forecast/moveOdds.ts reads off a forecast -- the close at least
// t% up or down, the path touching t% up or down -- can be set against what happened on every forecast already
// recorded, before any card shows them. For each record named, each horizon, kind (close or touch), move and
// side:
//   n, the mean stated chance, the observed share with its 95% interval by hour blocks as long as the horizon
//   (the app's blocks, widened as the app widens them for overlapping outcomes and for few blocks, here
//   analytically: the blocks' spread about the share), the Brier score, and a base rate's Brier score -- the
//   base rate read for each outcome on the record's other UTC days, so that no outcome's own day informs it;
//   then by tenth of stated chance (0-10%, ... 90-100%), each tenth holding 100 outcomes or more: its mean
//   stated chance against its observed share and interval.
// The registered line: a horizon, move and kind passes on a record where, on both sides, every such tenth has
// its mean stated chance inside the interval and the Brier score is under the base rate's; it is shown where it
// passes on every record.
//
//   npx esbuild research/moveOdds.ts --bundle --platform=node --format=esm --outfile=research/.moveOdds.mjs
//   PROFILES=<profile>[,<profile>...] [OUT=<file.json>] node research/.moveOdds.mjs
//
// It reads each profile's forecasts/predictions-*.jsonl and outcomes-*.jsonl; it writes nothing but OUT, reads no
// key and asks nothing.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HORIZON_BARS, type Horizon } from '../shared/forecast/features'
import { MOVE_ODDS_LINES, closeOdds, touchOdds } from '../shared/forecast/moveOdds'
import { BLOCK_HOURS, dependenceFactor, smallSampleFactor } from '../shared/forecast/uncertainty'

const PROFILES = (process.env.PROFILES ?? '').split(',').map((path) => path.trim()).filter((path) => path !== '')
if (PROFILES.length === 0) throw new Error('PROFILES names the profiles whose forecasts/ to read, comma-separated')
const OUT = process.env.OUT ?? ''

/** The horizons judged, and the one read beside them. */
const JUDGED: Horizon[] = ['hour1', 'hours4', 'hours24']
const EXPLORED: Horizon[] = ['minutes15']
const MIN_TENTH = 100
const Z = 1.959964

type Kind = 'close' | 'touch'
type Side = 'up' | 'down'

interface Sample {
  /** The forecast's close, in seconds. */
  t: number
  stated: number
  hit: 0 | 1
  tail: boolean
}

interface Share {
  value: number
  low: number | null
  high: number | null
  blocks: number
}

/** A share's point and 95% interval from rows of (seconds, hit), by hour blocks as long as the horizon. */
function shareOf(rows: readonly { t: number; hit: number }[], horizon: Horizon): Share | null {
  const n = rows.length
  if (n === 0) return null
  const blockSec = BLOCK_HOURS[horizon] * 3600
  const blocks = new Map<number, { k: number; m: number }>()
  let hits = 0
  for (const row of rows) {
    const key = Math.floor(row.t / blockSec)
    const cell = blocks.get(key) ?? { k: 0, m: 0 }
    cell.k += row.hit
    cell.m += 1
    blocks.set(key, cell)
    hits += row.hit
  }
  const p = hits / n
  if (blocks.size < 2) return { value: p, low: null, high: null, blocks: blocks.size }
  let spread = 0
  for (const { k, m } of blocks.values()) spread += (k - p * m) ** 2
  const overlapHours = (HORIZON_BARS[horizon] * 300) / 3600
  const se = (Math.sqrt(spread) / n) * dependenceFactor(overlapHours, BLOCK_HOURS[horizon]) * smallSampleFactor(blocks.size)
  return { value: p, low: Math.max(0, p - Z * se), high: Math.min(1, p + Z * se), blocks: blocks.size }
}

interface Cell {
  horizon: Horizon
  kind: Kind
  pct: number
  side: Side
  n: number
  meanStated: number
  observed: Share | null
  brier: number
  baseBrier: number | null
  tailShare: number
  tenths: { from: number; n: number; meanStated: number; observed: Share | null; inside: boolean | null }[]
  /** The registered line on this side: every tenth with MIN_TENTH outcomes inside, and the Brier score under the base rate's. */
  holds: boolean
}

const dayOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10)

function cellOf(horizon: Horizon, kind: Kind, pct: number, side: Side, samples: readonly Sample[]): Cell {
  const n = samples.length
  const meanStated = samples.reduce((sum, sample) => sum + sample.stated, 0) / Math.max(1, n)
  const brier = samples.reduce((sum, sample) => sum + (sample.stated - sample.hit) ** 2, 0) / Math.max(1, n)
  // The base rate for each outcome: the share of the record's other UTC days.
  const byDay = new Map<string, { k: number; m: number }>()
  for (const sample of samples) {
    const day = dayOf(sample.t)
    const cell = byDay.get(day) ?? { k: 0, m: 0 }
    cell.k += sample.hit
    cell.m += 1
    byDay.set(day, cell)
  }
  const totalK = samples.reduce((sum, sample) => sum + sample.hit, 0)
  let baseSum = 0
  let baseN = 0
  for (const sample of samples) {
    const own = byDay.get(dayOf(sample.t))!
    const others = n - own.m
    if (others === 0) continue
    const base = (totalK - own.k) / others
    baseSum += (base - sample.hit) ** 2
    baseN++
  }
  const baseBrier = baseN === 0 ? null : baseSum / baseN
  const tenths: Cell['tenths'] = []
  for (let tenth = 0; tenth < 10; tenth++) {
    const inside = samples.filter((sample) => Math.min(9, Math.floor(sample.stated * 10)) === tenth)
    if (inside.length === 0) continue
    const mean = inside.reduce((sum, sample) => sum + sample.stated, 0) / inside.length
    const observed = shareOf(inside, horizon)
    const judged = inside.length >= MIN_TENTH && observed !== null && observed.low !== null && observed.high !== null
    tenths.push({ from: tenth / 10, n: inside.length, meanStated: mean, observed, inside: judged ? mean >= observed!.low! && mean <= observed!.high! : null })
  }
  const holds = n > 0 && tenths.every((tenth) => tenth.inside !== false) && baseBrier !== null && brier < baseBrier
  return { horizon, kind, pct, side, n, meanStated, observed: shareOf(samples, horizon), brier, baseBrier, tailShare: samples.filter((sample) => sample.tail).length / Math.max(1, n), tenths, holds }
}

interface Line {
  id: string
  pair: string
  t: number
  h?: Partial<Record<Horizon, { q?: number[]; ex?: number[] }>>
}
interface Outcome {
  id: string
  h: Horizon
  t: number
  move?: number
  best?: number
  worst?: number
  missing?: string
}

function linesOf<T>(dir: string, pattern: RegExp): T[] {
  const out: T[] = []
  for (const name of readdirSync(dir).filter((file) => pattern.test(file)).sort()) {
    for (const raw of readFileSync(join(dir, name), 'utf-8').split('\n')) {
      if (raw.trim() === '') continue
      try {
        out.push(JSON.parse(raw) as T)
      } catch {
        // A torn last line.
      }
    }
  }
  return out
}

const pctText = (value: number | null | undefined, digits = 1): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${(value * 100).toFixed(digits)}%`)
const shareText = (share: Share | null): string => (share === null ? '-' : share.low === null ? `${pctText(share.value)} (one block)` : `${pctText(share.value)} [${pctText(share.low)}, ${pctText(share.high)}]`)

interface RecordReport {
  profile: string
  forecasts: number
  outcomes: number
  from: string
  to: string
  cells: Cell[]
  /** Per horizon, move and kind: whether the line holds on both sides. */
  passes: { horizon: Horizon; kind: Kind; pct: number; passes: boolean; judged: boolean }[]
}

function reportOf(profile: string): RecordReport {
  const dir = join(profile, 'forecasts')
  const predictions = linesOf<Line>(dir, /^predictions-\d{4}-\d{2}\.jsonl$/)
  const outcomes = linesOf<Outcome>(dir, /^outcomes-\d{4}-\d{2}\.jsonl$/)
  const byId = new Map(predictions.map((line) => [line.id, line]))
  const samples = new Map<string, Sample[]>()
  const push = (key: string, sample: Sample): void => {
    const list = samples.get(key)
    if (list === undefined) samples.set(key, [sample])
    else list.push(sample)
  }
  for (const outcome of outcomes) {
    if (outcome.missing !== undefined || typeof outcome.move !== 'number') continue
    const line = byId.get(outcome.id)?.h?.[outcome.h]
    if (line === undefined || !Array.isArray(line.q)) continue
    for (const pct of MOVE_ODDS_LINES.closeMovesPct) {
      const odds = closeOdds(line.q, pct)
      if (odds === null) continue
      push(`${outcome.h}|close|${pct}|up`, { t: outcome.t, stated: odds.up, hit: outcome.move >= pct ? 1 : 0, tail: odds.upTail })
      push(`${outcome.h}|close|${pct}|down`, { t: outcome.t, stated: odds.down, hit: outcome.move <= -pct ? 1 : 0, tail: odds.downTail })
    }
    if (Array.isArray(line.ex) && line.ex.length === 6 && typeof outcome.best === 'number' && typeof outcome.worst === 'number') {
      for (const pct of MOVE_ODDS_LINES.touchMovesPct) {
        const odds = touchOdds(line.ex.slice(0, 3), line.ex.slice(3), pct)
        if (odds === null) continue
        push(`${outcome.h}|touch|${pct}|up`, { t: outcome.t, stated: odds.up, hit: outcome.best >= pct ? 1 : 0, tail: odds.upTail })
        push(`${outcome.h}|touch|${pct}|down`, { t: outcome.t, stated: odds.down, hit: outcome.worst <= -pct ? 1 : 0, tail: odds.downTail })
      }
    }
  }
  const cells: Cell[] = []
  for (const horizon of [...EXPLORED, ...JUDGED]) {
    for (const kind of ['close', 'touch'] as const) {
      for (const pct of kind === 'close' ? MOVE_ODDS_LINES.closeMovesPct : MOVE_ODDS_LINES.touchMovesPct) {
        for (const side of ['up', 'down'] as const) {
          const list = samples.get(`${horizon}|${kind}|${pct}|${side}`)
          if (list !== undefined && list.length > 0) cells.push(cellOf(horizon, kind, pct, side, list))
        }
      }
    }
  }
  const passes: RecordReport['passes'] = []
  for (const horizon of JUDGED) {
    for (const kind of ['close', 'touch'] as const) {
      for (const pct of [1, 2]) {
        const sides = cells.filter((cell) => cell.horizon === horizon && cell.kind === kind && cell.pct === pct)
        passes.push({ horizon, kind, pct, judged: sides.length === 2, passes: sides.length === 2 && sides.every((cell) => cell.holds) })
      }
    }
  }
  const times = predictions.map((line) => line.t).filter(Number.isFinite)
  return {
    profile,
    forecasts: predictions.length,
    outcomes: outcomes.length,
    from: times.length === 0 ? '-' : new Date(Math.min(...times) * 1000).toISOString().slice(0, 16),
    to: times.length === 0 ? '-' : new Date(Math.max(...times) * 1000).toISOString().slice(0, 16),
    cells,
    passes
  }
}

const reports = PROFILES.map(reportOf)
for (const report of reports) {
  console.log(`\n===== ${report.profile}: ${report.forecasts} forecasts ${report.from} to ${report.to} UTC, ${report.outcomes} outcome lines`)
  console.log(`  ${'horizon'.padEnd(10)} ${'kind'.padEnd(5)} ${'move'.padStart(5)} ${'side'.padEnd(4)} ${'n'.padStart(6)} ${'stated'.padStart(7)} ${'observed [95%]'.padStart(26)} ${'Brier'.padStart(7)} ${'base'.padStart(7)} ${'tail'.padStart(6)}  tenths (stated -> observed)`)
  for (const cell of report.cells) {
    const tenths = cell.tenths
      .filter((tenth) => tenth.n >= MIN_TENTH)
      .map((tenth) => `${pctText(tenth.meanStated, 0)}->${pctText(tenth.observed?.value, 0)}${tenth.inside === false ? '!' : ''}`)
      .join(' ')
    console.log(
      `  ${cell.horizon.padEnd(10)} ${cell.kind.padEnd(5)} ${`${cell.pct}%`.padStart(5)} ${cell.side.padEnd(4)} ${String(cell.n).padStart(6)} ${pctText(cell.meanStated).padStart(7)} ${shareText(cell.observed).padStart(26)} ${cell.brier.toFixed(4).padStart(7)} ${(cell.baseBrier === null ? '-' : cell.baseBrier.toFixed(4)).padStart(7)} ${pctText(cell.tailShare, 0).padStart(6)}  ${tenths}${cell.holds ? '' : '  (does not hold)'}`
    )
  }
  console.log('  the registered line, per horizon, move and kind (both sides):')
  for (const pass of report.passes) console.log(`    ${pass.horizon.padEnd(8)} ${pass.kind.padEnd(5)} ${pass.pct}%  ${pass.judged ? (pass.passes ? 'passes' : 'fails') : 'not judged'}`)
}

console.log('\n===== shown where it passes on every record')
for (const horizon of JUDGED) {
  for (const kind of ['close', 'touch'] as const) {
    for (const pct of [1, 2]) {
      const verdicts = reports.map((report) => report.passes.find((pass) => pass.horizon === horizon && pass.kind === kind && pass.pct === pct))
      const shown = verdicts.every((verdict) => verdict !== undefined && verdict.judged && verdict.passes)
      console.log(`  ${horizon.padEnd(8)} ${kind.padEnd(5)} ${pct}%  ${shown ? 'SHOWN' : 'base rate'}  (${verdicts.map((verdict) => (verdict === undefined || !verdict.judged ? 'not judged' : verdict.passes ? 'passes' : 'fails')).join(', ')})`)
    }
  }
}
if (OUT !== '') writeFileSync(OUT, JSON.stringify(reports, null, 2))
