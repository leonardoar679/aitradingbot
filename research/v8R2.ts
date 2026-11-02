// V8-R2-WIDTH, V8-R2-ANALOG AND V8-R2-TAIL, MEASURED (V8 Stage 11, 2 November 2026; registered 26 October 2026,
// research/preregistered.jsonl; the rules and the bar are shared/forecast/r2.ts, the records' reading
// research/v8Records.ts). Each hypothesis's calls at an hour and four hours (confirmatory) and a day (exploratory),
// judged by the direction bar:
//   YEAR=current  discovery on the long walk forward's saved records (March to September 2026): WIDTH, ANALOG and
//                 TAIL's CONTINUATION, the precision's lower bound at 95%; a cell that passes is a candidate. TAIL's
//                 REVERSAL is not read here: the registration judges it on the second year alone.
//   YEAR=second   confirmation on October 2024 to September 2025's own walk forward: every cell, REVERSAL too, the
//                 precision's lower bound at 1 - 0.05/m; with DISCOVERY=<the current year's figures>, each cell's
//                 verdict -- a candidate that passes again, or a REVERSAL cell that passes, is a direction source; every
//                 other confirmatory cell is "not shown", with the smallest effect the year could detect.
//
//   npx esbuild research/v8R2.ts --bundle --platform=node --format=esm --outfile=research/.v8R2.mjs
//   ARCHIVE=<archive> YEAR=current|second [DISCOVERY=<figures.json>] [CELLS=width,analog,tail] [OUT=<figures.json>]
//     node --max-old-space-size=8192 research/.v8R2.mjs
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { OosRecord } from '../shared/forecast/oosRecord'
import { R2_CONFIRM_LEVEL, R2_LINES, analogCallsOf, r2FiguresOf, tailCallsOf, widthCallsOf, type R2Call, type R2Figures, type R2Row, type TailKind } from '../shared/forecast/r2'
import { HORIZON_SEC, V8_HORIZONS, baseUpByFold, loadBars, promotionsFrom, readRecord, shownRowsOf, type V8Horizon } from './v8Records'

const ARCHIVE = process.env.ARCHIVE ?? ''
if (ARCHIVE === '') throw new Error('ARCHIVE is the folder the year was fetched and walked forward in')
const YEAR = process.env.YEAR
if (YEAR !== 'current' && YEAR !== 'second') throw new Error('YEAR is current (discovery) or second (confirmation)')
const CELLS = new Set((process.env.CELLS ?? 'width,analog,tail').split(','))
const OUT = process.env.OUT ?? ''
const DISCOVERY = process.env.DISCOVERY ?? ''
/** The halves of the year: March to May and June to September 2026; October 2024 to March 2025 and April to September. */
const SPLIT = YEAR === 'current' ? Date.UTC(2026, 5, 1) / 1000 : Date.UTC(2025, 3, 1) / 1000
const LEVEL = YEAR === 'current' ? 0.95 : R2_CONFIRM_LEVEL
const started = Date.now()
const elapsed = (): string => `${((Date.now() - started) / 60_000).toFixed(1)} min`

const records = new Map<V8Horizon, OosRecord>()
for (const horizon of V8_HORIZONS) {
  const record = readRecord(ARCHIVE, horizon)
  if (record === null) throw new Error(`no record at ${horizon} in ${ARCHIVE}`)
  records.set(horizon, record)
}
const promotions = promotionsFrom(records)

/** A horizon's rows as the rules read them. */
function r2RowsOf(horizon: V8Horizon): R2Row[] {
  const record = records.get(horizon)!
  const bases = baseUpByFold(record)
  const zAt = new Map<string, number>()
  for (let row = 0; row < record.rows; row++) if (Number.isFinite(record.z[row])) zAt.set(`${record.symbols[record.pair[row]]}:${record.time[row]}`, record.z[row])
  return shownRowsOf(record, promotions).map((row) => ({
    t: row.t,
    pair: row.pair,
    fold: row.fold,
    z: row.z,
    movePct: row.movePct,
    prevZ: zAt.get(`${row.pair}:${row.t - HORIZON_SEC[horizon]}`) ?? null,
    rv24h: record.rv24h[row.at],
    btc15: record.btc15?.[row.at] ?? Number.NaN,
    state: record.state?.[row.at] ?? 255,
    cls: record.cls[row.at],
    shownZ: row.shownZ,
    shownPct: row.shownPct,
    pUp: row.pUp,
    baseUp: bases.get(row.fold) ?? null
  }))
}

interface Cell {
  id: string
  hypothesis: 'WIDTH' | 'ANALOG' | 'TAIL'
  horizon: V8Horizon
  confirmatory: boolean
  kind?: TailKind
  movePct?: number
  calls: R2Call[]
  note?: string
}
const cells: Cell[] = []
const confirmatory = (horizon: V8Horizon): boolean => horizon !== 'hours24'
for (const horizon of V8_HORIZONS) {
  const rows = r2RowsOf(horizon)
  console.log(`${horizon}: ${rows.length} scored coin-hours, ${new Set(rows.map((row) => row.pair)).size} pairs (${elapsed()})`)
  if (CELLS.has('width')) cells.push({ id: `WIDTH:${horizon}`, hypothesis: 'WIDTH', horizon, confirmatory: confirmatory(horizon), calls: widthCallsOf(rows, HORIZON_SEC[horizon]) })
  if (CELLS.has('analog')) {
    const made = analogCallsOf(rows, HORIZON_SEC[horizon])
    cells.push({ id: `ANALOG:${horizon}`, hypothesis: 'ANALOG', horizon, confirmatory: confirmatory(horizon), calls: made.calls, note: `${made.asked} coin-hours asked` })
    console.log(`  ANALOG asked ${made.asked} coin-hours, ${made.calls.length} calls (${elapsed()})`)
  }
  if (CELLS.has('tail')) {
    const kinds: TailKind[] = YEAR === 'current' ? ['continuation'] : ['continuation', 'reversal']
    const byPair = new Map<string, R2Row[]>()
    for (const row of rows) {
      const mine = byPair.get(row.pair)
      if (mine === undefined) byPair.set(row.pair, [row])
      else mine.push(row)
    }
    const made = new Map<string, { calls: R2Call[]; missing: number }>()
    for (const [pair, mine] of byPair) {
      const bars = loadBars(ARCHIVE, pair)
      for (const kind of kinds) {
        for (const movePct of R2_LINES.tailMovesPct) {
          const key = `${kind}:${movePct}`
          const read = tailCallsOf(mine, () => bars, HORIZON_SEC[horizon], movePct, kind)
          const into = made.get(key) ?? { calls: [], missing: 0 }
          into.calls.push(...read.calls)
          into.missing += read.missing
          made.set(key, into)
        }
      }
    }
    for (const kind of kinds) {
      for (const movePct of R2_LINES.tailMovesPct) {
        const read = made.get(`${kind}:${movePct}`)!
        cells.push({ id: `TAIL-${kind.toUpperCase()}-${movePct}:${horizon}`, hypothesis: 'TAIL', horizon, confirmatory: confirmatory(horizon), kind, movePct, calls: read.calls, note: `${read.missing} calls left out, their bars not all on file` })
      }
    }
    console.log(`  TAIL read (${elapsed()})`)
  }
}

const discovered = new Map<string, boolean>()
if (DISCOVERY !== '' && existsSync(DISCOVERY)) for (const cell of (JSON.parse(readFileSync(DISCOVERY, 'utf-8')) as { cells: { id: string; passed: boolean }[] }).cells) discovered.set(cell.id, cell.passed)
const pct = (value: number | null | undefined, digits = 2): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${(value * 100).toFixed(digits)}%`)
const out: (Omit<Cell, 'calls'> & R2Figures & { candidate: boolean | null; verdict: string | null })[] = []
console.log(`\n${YEAR === 'current' ? 'Discovery on March to September 2026' : 'Confirmation on October 2024 to September 2025'}; the precision's lower bound at ${(LEVEL * 100).toFixed(2)}%`)
for (const cell of cells) {
  const figures = r2FiguresOf(cell.calls, { split: SPLIT, precisionLevel: LEVEL, byHour: cell.hypothesis === 'TAIL' })
  // The verdict, on the second year: a candidate of the current year, or a REVERSAL cell, that passes again.
  const candidate = YEAR === 'second' ? (cell.kind === 'reversal' ? true : (discovered.get(cell.id) ?? null)) : null
  const verdict = YEAR !== 'second' || !cell.confirmatory ? null : candidate === true && figures.passed ? 'a direction source' : `not shown${figures.detectable === null ? '' : `; the smallest skill the year could detect ${pct(figures.detectable)}`}`
  const { calls: _calls, ...rest } = cell
  out.push({ ...rest, ...figures, candidate, verdict })
  console.log(`  ${cell.id}${cell.confirmatory ? '' : ' (exploratory)'}: ${figures.passed ? 'PASSES' : 'does not pass'}${verdict === null ? '' : ` -- ${verdict}`}${cell.note === undefined ? '' : ` (${cell.note})`}`)
  for (const line of figures.lines) console.log(`      ${line.ok === true ? 'ok ' : line.ok === false ? 'NO ' : '-- '}${line.text}`)
}
if (OUT !== '') writeFileSync(OUT, JSON.stringify({ version: R2_LINES.version, year: YEAR, archive: ARCHIVE, split: SPLIT, level: LEVEL, cells: out }, null, 1))
console.log(`\n${elapsed()}`)
