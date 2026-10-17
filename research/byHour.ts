// THE CLOCK AS A DIAGNOSTIC (V7.2 Stage 4, 17 October 2026): the forecast shown by the UTC hour it was made
// at, from a profile's walk forward -- shared/forecast/byHour.ts's report printed, with what the bars add: the
// median five-minute range by hour of the day against the day's median, and the share of the quote volume
// each hour carries. A band is FAILING only where its cross-fitted 80% coverage is under 70% or over 90% in
// all four halves (the pairs' two halves by the first weeks and the last) with at least 500 outcomes each
// (the registered line V72-S4-CLOCK). The weekday is reported and never acted on. The live record's spread by
// hour is not here: the record keeps no spread, which Stage 5's tape will.
//
//   npx esbuild research/byHour.ts --bundle --platform=node --format=esm --outfile=research/.byHour.mjs
//   PROFILE=<a scratch profile with a walk forward> [RUN=<run>] node research/.byHour.mjs
//
// It reads the profile's forecastModels/<run>/oos-*.bin and forecastData/*.jsonl; it writes nothing and asks nothing.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { barFromLine, mergeBars, type ForecastBar } from '../shared/forecast/bars'
import { BY_HOUR_LINES, byHourOf, hourOfDay, type HourCell } from '../shared/forecast/byHour'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import { decodeOos, oosState } from '../shared/forecast/oosRecord'
import { rowsOf, scoreOutOfSample } from '../shared/forecast/runCalibration'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const MODELS = join(PROFILE, 'forecastModels')
const RUN = process.env.RUN ?? (JSON.parse(readFileSync(join(MODELS, 'current.json'), 'utf-8')) as { foldsRunId?: string; runId: string }).foldsRunId ?? ''
if (RUN === '') throw new Error('no walk forward in current.json; name one with RUN')

const pct = (value: number | null | undefined, digits = 1): string => (value === null || value === undefined || !Number.isFinite(value) ? '-' : `${(100 * value).toFixed(digits)}%`)
const cell = (made: HourCell | null): string => (made === null ? '-'.padStart(5) : `${pct(made.coverage80, 0).padStart(4)}/${String(made.n).padStart(4)}`)

/** The bars on file, by pair. */
function loadBars(): Map<string, ForecastBar[]> {
  const dir = join(PROFILE, 'forecastData')
  const byPair = new Map<string, ForecastBar[]>()
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return byPair
  }
  for (const name of names.sort()) {
    const symbol = /^([A-Z0-9]+)-\d{4}-\d{2}\.jsonl$/.exec(name)?.[1]
    if (symbol === undefined) continue
    const read: ForecastBar[] = []
    for (const line of readFileSync(join(dir, name), 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const bar = barFromLine(JSON.parse(line))
        if (bar !== null) read.push(bar)
      } catch {
        // A torn line: skipped.
      }
    }
    byPair.set(symbol, mergeBars(byPair.get(symbol) ?? [], read))
  }
  return byPair
}

const median = (values: number[]): number => {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

// What the bars say of each hour: the median five-minute range against the day's median, and the quote volume's share.
const bars = loadBars()
const rangesByHour = Array.from({ length: 24 }, () => [] as number[])
const quoteByHour = new Array<number>(24).fill(0)
for (const series of bars.values()) {
  for (const bar of series) {
    if (!(bar.close > 0)) continue
    const hour = hourOfDay(bar.time)
    rangesByHour[hour].push((bar.high - bar.low) / bar.close)
    quoteByHour[hour] += bar.quoteVolume
  }
}
const dayRange = median(rangesByHour.flat())
const quoteTotal = quoteByHour.reduce((a, b) => a + b, 0)

console.log(`walk forward ${RUN} of ${PROFILE}: the forecast shown by the UTC hour it was made at; a band fails under ${BY_HOUR_LINES.low * 100}% or over ${BY_HOUR_LINES.high * 100}% in all four halves with ${BY_HOUR_LINES.minCell} outcomes each; ${bars.size} pairs' bars read`)
for (const horizon of HORIZONS as Horizon[]) {
  let bytes: Buffer
  try {
    bytes = readFileSync(join(MODELS, RUN, `oos-${horizon}.bin`))
  } catch {
    continue
  }
  const record = decodeOos(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  if (record === null) continue
  const rows = rowsOf(record)
  const shown = scoreOutOfSample(rows, 'v2', new Set(record.models))
  const report = byHourOf(shown, horizon, (entry) => (entry.at === undefined ? undefined : oosState(record, entry.at)))
  const coverages = report.hours.map((band) => band.pooled.coverage80).filter(Number.isFinite)
  console.log(`\n${horizon}: ${report.rows} rows (${report.preEventOut} before a release left out); weeks ${report.firstWeeks.join(',')} against the rest; 80% held by hour from ${pct(Math.min(...coverages))} to ${pct(Math.max(...coverages))}; failing bands: ${report.failing.length === 0 ? 'none' : report.failing.join(', ')}`)
  console.log('  hour   n     80%     50%   pinball  dispersion  misses in shock | halves (80%/n): A-first A-last B-first B-last | bars: 5-min range vs day  quote share')
  for (const band of report.hours) {
    const p = band.pooled
    const range = rangesByHour[band.hour].length === 0 ? '-' : (median(rangesByHour[band.hour]) / dayRange).toFixed(2)
    console.log(`  ${String(band.hour).padStart(2)}  ${String(p.n).padStart(5)}  ${pct(p.coverage80).padStart(6)}  ${pct(p.coverage50).padStart(6)}  ${Number.isFinite(p.pinball) ? p.pinball.toFixed(4) : '-'}  ${Number.isFinite(p.dispersion) ? p.dispersion.toFixed(2).padStart(10) : '-'.padStart(10)}  ${pct(p.missesInShock, 0).padStart(15)} | ${band.halves.map(cell).join(' ')} |${band.failing ? ' FAILING' : ''}  ${range.padStart(12)}  ${quoteTotal > 0 ? pct(quoteByHour[band.hour] / quoteTotal) : '-'}`)
  }
  console.log(`  weekdays (0 Sunday): ${report.weekdays.map((entry) => `${entry.day}: ${pct(entry.pooled.coverage80)} of ${entry.pooled.n}`).join('; ')}`)
}
