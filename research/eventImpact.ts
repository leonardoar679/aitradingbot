// THE EVENT IMPACT HISTORY (V7.1 Stage 12, 16 October 2026): what Bitcoin did after each scheduled release
// of the macro calendar (shared/calendar/macro.ts) that falls inside a profile's bars on file -- the move
// from the close before the release at five minutes, fifteen, an hour and four, in percent and in its usual
// moves (its five-minute moves of the day before, grown by the square root of the bars); the highest and
// lowest the path went within four hours; when the path first touched one usual hourly move up and down;
// and the market's regime at the moment (shared/marketResearch.ts). Then by kind: the median of each figure,
// how often the fifteen minutes after were a shock (past 2.5 usual moves, the forecast's line), and the
// regimes seen. Shipped as data (shared/calendar/event-impact-2026.json) and shown on the Forecast Lab; a
// kind with fewer than thirty releases is shown with that said, and the forecast reads nothing from it.
//
//   npx esbuild research/eventImpact.ts --bundle --platform=node --format=esm --outfile=research/.eventImpact.mjs
//   PROFILE=<a scratch profile with ninety days of bars> node research/.eventImpact.mjs
//   OUT=shared/calendar/event-impact-2026.json ... to write the shipped file (printed otherwise)
//
// It reads the profile's forecastData/BTCUSDT-*.jsonl; it writes one file where asked and asks nothing.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MACRO_EVENTS, MACRO_KINDS, type MacroKind } from '../shared/calendar/macro'
import { EVENT_IMPACT_LINES, EVENT_IMPACT_VERSION, type EventImpactFile, type EventImpactRow, type ImpactWindow } from '../shared/calendar/eventImpact'
import { SHOCK_LINES } from '../shared/forecast/shock'
import { marketRegimeOf } from '../shared/marketResearch'

const PROFILE = process.env.PROFILE ?? ''
if (PROFILE === '') throw new Error('PROFILE is the scratch profile to read')
const OUT = process.env.OUT ?? ''
const BAR = 300
const DAY_BARS = 288
const WINDOWS: Record<ImpactWindow, number> = { m5: 1, m15: 3, h1: 12, h4: 48 }

interface Bar {
  time: number
  high: number
  low: number
  close: number
}

function barsOf(pair: string): Bar[] {
  const dir = join(PROFILE, 'forecastData')
  const out: Bar[] = []
  for (const name of readdirSync(dir).filter((entry) => entry.startsWith(`${pair}-`) && entry.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, name), 'utf-8').split('\n')) {
      if (line.trim() === '') continue
      try {
        const bar = JSON.parse(line) as number[]
        out.push({ time: bar[0], high: bar[2], low: bar[3], close: bar[4] })
      } catch {
        // a torn line
      }
    }
  }
  const byTime = new Map(out.map((bar) => [bar.time, bar]))
  return [...byTime.values()].sort((a, b) => a.time - b.time)
}

/** The index of the last bar closed at or before `tSec`; -1 where none. */
function closedBefore(bars: readonly Bar[], tSec: number): number {
  let low = 0
  let high = bars.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (bars[middle].time + BAR <= tSec) low = middle + 1
    else high = middle
  }
  return low - 1
}

const median = (values: number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const pct = (logMove: number): number => (Math.exp(logMove) - 1) * 100

/** One release's row from the bars, or null without a day before and four hours after it. */
export function impactOf(bars: readonly Bar[], event: { kind: MacroKind; at: number; date: string }): EventImpactRow | null {
  const at = closedBefore(bars, event.at)
  if (at < DAY_BARS || at + WINDOWS.h4 >= bars.length) return null
  // The bar before the release must have closed within the five minutes before it, and the day before be whole.
  if (bars[at].time + BAR < event.at - BAR || bars[at - DAY_BARS].time !== bars[at].time - DAY_BARS * BAR) return null
  const close0 = bars[at].close
  const moves: number[] = []
  for (let index = at - DAY_BARS + 1; index <= at; index++) moves.push(Math.log(bars[index].close / bars[index - 1].close))
  const mean = moves.reduce((sum, value) => sum + value, 0) / moves.length
  const sigma5 = Math.sqrt(moves.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (moves.length - 1))
  if (!(sigma5 > 0)) return null
  const usual = (barCount: number): number => sigma5 * Math.sqrt(barCount)
  const movePct = {} as Record<ImpactWindow, number>
  const z = {} as Record<ImpactWindow, number>
  for (const [window, barCount] of Object.entries(WINDOWS) as [ImpactWindow, number][]) {
    const logMove = Math.log(bars[at + barCount].close / close0)
    movePct[window] = pct(logMove)
    z[window] = logMove / usual(barCount)
  }
  let high = -Infinity
  let low = Infinity
  let touchUpMin: number | null = null
  let touchDownMin: number | null = null
  const upLevel = close0 * Math.exp(usual(12))
  const downLevel = close0 * Math.exp(-usual(12))
  for (let index = at + 1; index <= at + WINDOWS.h4; index++) {
    const bar = bars[index]
    high = Math.max(high, bar.high)
    low = Math.min(low, bar.low)
    if (touchUpMin === null && bar.high >= upLevel) touchUpMin = (bar.time + BAR - event.at) / 60
    if (touchDownMin === null && bar.low <= downLevel) touchDownMin = (bar.time + BAR - event.at) / 60
  }
  const closeAgo = (barCount: number): number => bars[at - barCount].close
  const regime = marketRegimeOf({ h1: pct(Math.log(close0 / closeAgo(12))), h4: pct(Math.log(close0 / closeAgo(48))), h24: pct(Math.log(close0 / closeAgo(288))) }) ?? 'sideways'
  return { kind: event.kind, at: event.at, date: event.date, regime, movePct, z, maxUpPct: pct(Math.log(high / close0)), maxDownPct: pct(Math.log(low / close0)), touchUpMin, touchDownMin, shockAfter: Math.abs(z.m15) >= SHOCK_LINES.line }
}

/** The history by kind from its rows. */
export function impactFileOf(rows: readonly EventImpactRow[], source: EventImpactFile['source'], madeAt: string): EventImpactFile {
  const kinds = {} as EventImpactFile['kinds']
  for (const kind of MACRO_KINDS) {
    const mine = rows.filter((row) => row.kind === kind)
    const byRegime: Record<string, number> = {}
    for (const row of mine) byRegime[row.regime] = (byRegime[row.regime] ?? 0) + 1
    const windowed = (pick: (row: EventImpactRow) => number): Record<ImpactWindow, number | null> =>
      Object.fromEntries((Object.keys(WINDOWS) as ImpactWindow[]).map((window) => [window, median(mine.map((row) => Math.abs(pick(row))))])) as Record<ImpactWindow, number | null>
    void windowed
    kinds[kind] = {
      n: mine.length,
      enough: mine.length >= EVENT_IMPACT_LINES.minSamples,
      medianAbsPct: Object.fromEntries((Object.keys(WINDOWS) as ImpactWindow[]).map((window) => [window, median(mine.map((row) => Math.abs(row.movePct[window])))])) as Record<ImpactWindow, number | null>,
      medianAbsZ: Object.fromEntries((Object.keys(WINDOWS) as ImpactWindow[]).map((window) => [window, median(mine.map((row) => Math.abs(row.z[window])))])) as Record<ImpactWindow, number | null>,
      medianMaxUpPct: median(mine.map((row) => row.maxUpPct)),
      medianMaxDownPct: median(mine.map((row) => row.maxDownPct)),
      shockAfterShare: mine.length === 0 ? null : mine.filter((row) => row.shockAfter).length / mine.length,
      touchedWithin4hShare: mine.length === 0 ? null : mine.filter((row) => row.touchUpMin !== null || row.touchDownMin !== null).length / mine.length,
      medianTouchMin: median(mine.flatMap((row) => [row.touchUpMin, row.touchDownMin].filter((value): value is number => value !== null))),
      byRegime
    }
  }
  return { version: EVENT_IMPACT_VERSION, madeAt, source, minSamples: EVENT_IMPACT_LINES.minSamples, kinds, events: [...rows].sort((a, b) => a.at - b.at) }
}

const bars = barsOf('BTCUSDT')
if (bars.length === 0) throw new Error(`no Bitcoin bars in ${PROFILE}`)
const rows: EventImpactRow[] = []
for (const event of MACRO_EVENTS) {
  const row = impactOf(bars, event)
  if (row !== null) rows.push(row)
}
const file = impactFileOf(rows, { pair: 'BTCUSDT', fromSec: bars[0].time, toSec: bars[bars.length - 1].time + BAR, bars: bars.length }, new Date().toISOString().slice(0, 10))
console.log(`${rows.length} releases inside ${bars.length} Bitcoin bars (${new Date(bars[0].time * 1000).toISOString().slice(0, 10)} to ${new Date(bars[bars.length - 1].time * 1000).toISOString().slice(0, 10)})`)
for (const row of file.events) {
  const minutes = (value: number | null): string => (value === null ? 'not in 4h' : `${value} min`)
  console.log(`  ${row.kind.padEnd(4)} ${row.date} ${row.regime.padEnd(9)} 5m ${row.movePct.m5.toFixed(2)}% (${row.z.m5.toFixed(1)}) 15m ${row.movePct.m15.toFixed(2)}% (${row.z.m15.toFixed(1)}) 1h ${row.movePct.h1.toFixed(2)}% (${row.z.h1.toFixed(1)}) 4h ${row.movePct.h4.toFixed(2)}% (${row.z.h4.toFixed(1)}); high ${row.maxUpPct.toFixed(2)}% low ${row.maxDownPct.toFixed(2)}%; a usual hour up ${minutes(row.touchUpMin)}, down ${minutes(row.touchDownMin)}${row.shockAfter ? '; a shock after' : ''}`)
}
for (const kind of MACRO_KINDS) {
  const entry = file.kinds[kind]
  const figure = (value: number | null, digits = 2): string => (value === null ? '-' : value.toFixed(digits))
  console.log(`${kind}: n ${entry.n}${entry.enough ? '' : ` (under ${file.minSamples}: shown, not used)`}; median |move| 5m ${figure(entry.medianAbsPct.m5)}% 15m ${figure(entry.medianAbsPct.m15)}% 1h ${figure(entry.medianAbsPct.h1)}% 4h ${figure(entry.medianAbsPct.h4)}%; in usual moves 15m ${figure(entry.medianAbsZ.m15, 1)} 1h ${figure(entry.medianAbsZ.h1, 1)}; a shock after ${entry.shockAfterShare === null ? '-' : `${Math.round(entry.shockAfterShare * 100)}%`}; touched a usual hour within 4h ${entry.touchedWithin4hShare === null ? '-' : `${Math.round(entry.touchedWithin4hShare * 100)}%`}, typically at ${figure(entry.medianTouchMin, 0)} min; regimes ${JSON.stringify(entry.byRegime)}`)
}
if (OUT !== '') {
  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`)
  console.log(`written to ${OUT}`)
}
