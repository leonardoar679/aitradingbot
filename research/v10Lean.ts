// V10-LEAN (V10 Stage 1, 19 November 2026): does the forecast's lean come from its calibration, and does a calibration
// that does not move the centre keep its ranges as well? Each walk forward's record of rows forecast out of sample is
// calibrated three ways, week by week, from the weeks before (shared/forecast/runCalibration.ts fit, the shown variant's
// members and weights) and then stepped in time order as the live app steps it, each outcome taken in when it is due:
//   V0  the calibration that ships: each level moved by its own error (the median by the median error), every level's
//       reading stepped by aciUpdate once a quarter-hour moment at every horizon;
//   V1  a band calibration centred at no move (shared/forecast/calibration.ts calibrateBand 'zero'), each range's miss
//       stepped by aciBandUpdate at aciGammaFor(horizon);
//   V2  the same centred at the models' own middle ('models').
// Figures per horizon: the 80% range's coverage, the shares below P10 and above P90, the mean pinball over the five
// levels in usual moves -- pooled, in rising and in falling months (Bitcoin's calendar month, last close over first
// open) and in rising and falling weeks -- and each band variant's regime-balanced pinball ratio against V0 (the mean of
// its rising months' ratio and its falling months'), with a 90% interval by hour blocks (bootstrapOverHours).
//
//   npx esbuild research/v10Lean.ts --bundle --platform=node --format=esm --outfile=research/.v10Lean.mjs
//   RECORDS=<run folder>;<run folder>... TRAINING=<training-YYYY-MM.jsonl>;... BTC_DAILY=<BTCUSDT daily bars .json>
//   OUT=<figures .json> [HORIZONS=hour1,hours24] [FOLDS_FROM=<unix seconds>] node --max-old-space-size=8192 research/.v10Lean.mjs
//
// A record set's folder holds oos-<horizon>.bin (forecast-oos); its promotions are read from the training line of its run
// (electron/forecast training-YYYY-MM.jsonl, or the long walk forward's own). BTC_DAILY is [[openSec, o, h, l, c, v], ...].
// It reads and writes only OUT.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BAND_MISSES, CALIBRATION_LINES, aciBandUpdate, aciGammaFor, buildBandCell, calibrate, calibrateBand, aciUpdate, type BandCell, type BandCentre } from '../shared/forecast/calibration'
import { ENSEMBLE_LINES, combine } from '../shared/forecast/ensemble'
import { HORIZONS, type Horizon, type PairClass } from '../shared/forecast/features'
import type { ForecastModelId } from '../shared/forecast/models'
import { QUANTILE_LEVELS, meanPinball } from '../shared/forecast/ml/quantile'
import { decodeOos } from '../shared/forecast/oosRecord'
import { fit, rowsOf, type Fitted, type Row } from '../shared/forecast/runCalibration'
import { BLOCK_HOURS, UNCERTAINTY_LINES, bootstrapOverHours, hourOf, type HourSample } from '../shared/forecast/uncertainty'
import { HORIZON_STEP_SEC, horizonSeconds } from '../shared/forecast/walkForward'

const RECORDS = (process.env.RECORDS ?? '').split(';').filter((entry) => entry.trim() !== '')
const TRAINING = (process.env.TRAINING ?? '').split(';').filter((entry) => entry.trim() !== '')
const BTC_DAILY = process.env.BTC_DAILY ?? ''
const OUT = process.env.OUT ?? ''
if (RECORDS.length === 0 || BTC_DAILY === '' || OUT === '') throw new Error('RECORDS, BTC_DAILY and OUT are needed')
const ONLY = process.env.HORIZONS === undefined ? HORIZONS : (process.env.HORIZONS.split(',') as Horizon[])
/** Only rows forecast at or after this moment are scored (the held-out folds); 0 scores every tested week. */
const FOLDS_FROM = Number(process.env.FOLDS_FROM ?? 0)

const VARIANTS = ['V0', 'V1', 'V2'] as const
type Variant = (typeof VARIANTS)[number]
const CENTRE: Record<Exclude<Variant, 'V0'>, BandCentre> = { V1: 'zero', V2: 'models' }

// Bitcoin's months and weeks: rising where the last close is above the first open.
const btc = (JSON.parse(readFileSync(BTC_DAILY, 'utf-8')) as number[][]).filter((bar) => bar.length >= 5).sort((a, b) => a[0] - b[0])
function regimeBy(keyOf: (sec: number) => string): Map<string, 1 | 0> {
  const spans = new Map<string, { open: number; close: number }>()
  for (const bar of btc) {
    const key = keyOf(bar[0])
    const span = spans.get(key)
    if (span === undefined) spans.set(key, { open: bar[1], close: bar[4] })
    else span.close = bar[4]
  }
  return new Map([...spans].map(([key, span]) => [key, span.close > span.open ? 1 : 0]))
}
const monthOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 7)
const weekOf = (sec: number): string => String(Math.floor((sec - 4 * 86_400) / (7 * 86_400)))
const MONTHS = regimeBy(monthOf)
const WEEKS = regimeBy(weekOf)

// Promotions by run, from the training lines.
const promotionsByRun = new Map<string, { horizon: Horizon; model: ForecastModelId; promoted: boolean }[]>()
for (const file of TRAINING) {
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    if (!line.trim().startsWith('{')) continue
    const entry = JSON.parse(line) as { runId?: string; promotions?: { horizon: Horizon; model: ForecastModelId; promoted: boolean }[] }
    if (typeof entry.runId === 'string' && Array.isArray(entry.promotions)) promotionsByRun.set(entry.runId, entry.promotions)
  }
}

/** One scored row: when, its regimes, and each variant's figures [in80, below P10, above P90, pinball]. */
interface Scored {
  t: number
  month: 1 | 0 | -1
  week: 1 | 0 | -1
  figures: Record<Variant, [number, number, number, number]>
}

const P10 = 0
const P90 = 4

function figuresOf(quantiles: readonly number[], z: number): [number, number, number, number] {
  return [z >= quantiles[P10] && z <= quantiles[P90] ? 1 : 0, z < quantiles[P10] ? 1 : 0, z > quantiles[P90] ? 1 : 0, meanPinball(z, quantiles)]
}

/** Band cells by class (where a class has the rows a cell needs) and pooled. */
function bandCellsOf(rows: readonly { cls: PairClass; quantiles: number[]; z: number }[], centre: BandCentre): { pooled: BandCell; byClass: Partial<Record<PairClass, BandCell>> } {
  const byClass: Partial<Record<PairClass, BandCell>> = {}
  const classes = new Map<PairClass, { quantiles: number[]; z: number }[]>()
  for (const row of rows) {
    const mine = classes.get(row.cls)
    if (mine === undefined) classes.set(row.cls, [row])
    else mine.push(row)
  }
  for (const [cls, mine] of classes) if (mine.length >= ENSEMBLE_LINES.minCellRows) byClass[cls] = buildBandCell(mine, centre)
  return { pooled: buildBandCell(rows, centre), byClass }
}

const combinedOf = (fitted: Fitted, row: Row): number[] => combine(row.quantiles, fitted.weights.byClass[row.cls] ?? fitted.weights.pooled).quantiles

/** A record's tested weeks, calibrated three ways and stepped in time order. */
function scoreRecord(rows: readonly Row[], horizon: Horizon, promoted: ReadonlySet<ForecastModelId>): Scored[] {
  const out: Scored[] = []
  const horizonSec = horizonSeconds(horizon)
  // How many live quarter-hour moments one of the record's moments stands for.
  const moments = HORIZON_STEP_SEC[horizon] / 900
  const weeks = [...new Set(rows.map((row) => row.fold))].sort((a, b) => a - b)
  for (const week of weeks.slice(1)) {
    const before = rows.filter((row) => row.fold < week)
    if (before.length < ENSEMBLE_LINES.minCellRows) continue
    const fitted = fit(before, 'v2', promoted)
    const trained = before.map((row) => ({ cls: row.cls, quantiles: combinedOf(fitted, row), z: row.z }))
    const bands = { V1: bandCellsOf(trained, CENTRE.V1), V2: bandCellsOf(trained, CENTRE.V2) }
    const tested = rows.filter((row) => row.fold === week && row.t !== undefined).sort((a, b) => a.t! - b.t!)
    // Each calibration starts its readings at the nominal levels, as a new walk forward's does.
    const levels = new Map<string, number[]>()
    const misses = { V1: new Map<string, number[]>(), V2: new Map<string, number[]>() }
    const owed: { due: number; key: string; below: boolean[]; outside: Record<'V1' | 'V2', number[]>; keys: Record<'V1' | 'V2', string> }[] = []
    let next = 0
    const moments_ = [...new Set(tested.map((row) => row.t!))]
    for (const at of moments_) {
      // The outcomes due by this moment step the readings, one step a moment due.
      const due = owed.filter((entry) => entry.due <= at)
      if (due.length > 0) {
        for (const dueAt of [...new Set(due.map((entry) => entry.due))].sort((a, b) => a - b)) {
          const group = due.filter((entry) => entry.due === dueAt)
          for (const key of new Set(group.map((entry) => entry.key))) {
            const mine = group.filter((entry) => entry.key === key)
            const share = QUANTILE_LEVELS.map((_, level) => mine.filter((entry) => entry.below[level]).length / mine.length)
            levels.set(key, aciUpdate(levels.get(key) ?? [...QUANTILE_LEVELS], share, CALIBRATION_LINES.aciGamma * moments))
          }
          for (const variant of ['V1', 'V2'] as const) {
            for (const key of new Set(group.map((entry) => entry.keys[variant]))) {
              const mine = group.filter((entry) => entry.keys[variant] === key)
              const outside = BAND_MISSES.map((_, range) => mine.filter((entry) => entry.outside[variant][range] === 1).length / mine.length)
              misses[variant].set(key, aciBandUpdate(misses[variant].get(key) ?? [...BAND_MISSES], outside, aciGammaFor(horizonSec) * moments))
            }
          }
        }
        for (const entry of due) owed.splice(owed.indexOf(entry), 1)
      }
      while (next < tested.length && tested[next].t === at) {
        const row = tested[next++]
        const combined = combinedOf(fitted, row)
        const v0Key = fitted.cells.byClass[row.cls] !== undefined ? row.cls : 'pooled'
        const v0 = calibrate(combined, fitted.cells.byClass[row.cls] ?? fitted.cells.pooled, levels.get(v0Key) ?? QUANTILE_LEVELS)
        const keys = { V1: bands.V1.byClass[row.cls] !== undefined ? row.cls : 'pooled', V2: bands.V2.byClass[row.cls] !== undefined ? row.cls : 'pooled' }
        const v1 = calibrateBand(combined, bands.V1.byClass[row.cls] ?? bands.V1.pooled, CENTRE.V1, misses.V1.get(keys.V1) ?? BAND_MISSES)
        const v2 = calibrateBand(combined, bands.V2.byClass[row.cls] ?? bands.V2.pooled, CENTRE.V2, misses.V2.get(keys.V2) ?? BAND_MISSES)
        const outsideOf = (q: number[]): number[] => [row.z < q[1] || row.z > q[3] ? 1 : 0, row.z < q[0] || row.z > q[4] ? 1 : 0]
        owed.push({ due: at + horizonSec, key: v0Key, below: v0.map((q) => row.z <= q), outside: { V1: outsideOf(v1), V2: outsideOf(v2) }, keys })
        if (at >= FOLDS_FROM) {
          out.push({ t: at, month: MONTHS.get(monthOf(at)) ?? -1, week: WEEKS.get(weekOf(at)) ?? -1, figures: { V0: figuresOf(v0, row.z), V1: figuresOf(v1, row.z), V2: figuresOf(v2, row.z) } })
        }
      }
    }
  }
  return out
}

const share = (entries: readonly Scored[], variant: Variant, figure: number): number => (entries.length === 0 ? Number.NaN : entries.reduce((sum, entry) => sum + entry.figures[variant][figure], 0) / entries.length)
const round = (value: number, digits = 4): number => Number(value.toFixed(digits))

function summary(entries: readonly Scored[], regime: 'month' | 'week'): Record<string, unknown> {
  const rising = entries.filter((entry) => entry[regime] === 1)
  const falling = entries.filter((entry) => entry[regime] === 0)
  const of = (set: readonly Scored[]): Record<Variant, { n: number; in80: number; belowP10: number; aboveP90: number; pinball: number }> =>
    Object.fromEntries(VARIANTS.map((variant) => [variant, { n: set.length, in80: round(share(set, variant, 0)), belowP10: round(share(set, variant, 1)), aboveP90: round(share(set, variant, 2)), pinball: round(share(set, variant, 3), 5) }])) as never
  return { rows: entries.length, pooled: of(entries), rising: of(rising), falling: of(falling) }
}

/** Each band variant's regime-balanced pinball ratio against V0, less one, with its 90% interval by hour blocks. */
function balancedRatio(entries: readonly Scored[], horizon: Horizon, regime: 'month' | 'week'): Record<'V1' | 'V2', { value: number; low: number; high: number } | null> {
  const samples: HourSample[] = entries
    .filter((entry) => entry[regime] !== -1)
    .map((entry) => {
      const r = entry[regime] === 1 ? 1 : 0
      const f = 1 - r
      const pb = (variant: Variant): number => entry.figures[variant][3]
      return { hour: hourOf(entry.t), sample: [pb('V0') * r, pb('V1') * r, pb('V2') * r, r, pb('V0') * f, pb('V1') * f, pb('V2') * f, f] }
    })
  // Where a span holds one regime only, its ratio is that regime's (a record set's weeks may all fall in falling months).
  const ratio = (k: number) => (sums: Float64Array): number => {
    const rising = sums[3] > 0 ? sums[k] / sums[0] : Number.NaN
    const falling = sums[7] > 0 ? sums[4 + k] / sums[4] : Number.NaN
    if (Number.isFinite(rising) && Number.isFinite(falling)) return (rising + falling) / 2 - 1
    return (Number.isFinite(rising) ? rising : falling) - 1
  }
  const made = bootstrapOverHours(samples, [ratio(1), ratio(2)], BLOCK_HOURS[horizon], { ...UNCERTAINTY_LINES, level: 0.9 })
  const figure = (index: number): { value: number; low: number; high: number } | null => (made === null ? null : { value: round(made.figures[index].value), low: round(made.figures[index].low), high: round(made.figures[index].high) })
  return { V1: figure(0), V2: figure(1) }
}

const result: Record<string, unknown> = { at: new Date().toISOString(), records: RECORDS.map((dir) => basename(dir)), foldsFrom: FOLDS_FROM, horizons: {} }
const started = Date.now()
for (const horizon of ONLY) {
  const entries: Scored[] = []
  const bySet: Record<string, unknown> = {}
  for (const dir of RECORDS) {
    const file = join(dir, `oos-${horizon}.bin`)
    if (!existsSync(file)) continue
    const record = decodeOos(new Uint8Array(readFileSync(file)))
    if (record === null) throw new Error(`${file} is no record this build reads`)
    const runId = basename(dir)
    const promotions = promotionsByRun.get(runId)
    if (promotions === undefined) throw new Error(`no training line names ${runId}'s promotions`)
    const promoted = new Set(promotions.filter((entry) => entry.horizon === horizon && entry.promoted).map((entry) => entry.model))
    const scored = scoreRecord(rowsOf(record), horizon, promoted)
    entries.push(...scored)
    bySet[runId] = { rows: scored.length, pooled: (summary(scored, 'month') as { pooled: unknown }).pooled }
    console.log(`${horizon} ${runId}: ${scored.length} rows (${((Date.now() - started) / 60_000).toFixed(1)} min)`)
  }
  ;(result.horizons as Record<string, unknown>)[horizon] = {
    byMonth: summary(entries, 'month'),
    byWeek: summary(entries, 'week'),
    ratioByMonth: balancedRatio(entries, horizon, 'month'),
    ratioByWeek: balancedRatio(entries, horizon, 'week'),
    sets: bySet
  }
}
// The choice the registration names: the band variant with the lower regime-balanced pinball ratio pooled over the horizons.
const horizonsOut = result.horizons as Record<string, { ratioByMonth: Record<'V1' | 'V2', { value: number } | null> }>
const meanRatio = (variant: 'V1' | 'V2'): number => {
  const values = Object.values(horizonsOut).map((entry) => entry.ratioByMonth[variant]?.value).filter((value): value is number => typeof value === 'number')
  return values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length
}
result.choice = { V1: round(meanRatio('V1')), V2: round(meanRatio('V2')), chosen: meanRatio('V1') <= meanRatio('V2') ? 'V1' : 'V2' }
writeFileSync(OUT, JSON.stringify(result, null, 1))
console.log(JSON.stringify(result.choice))
