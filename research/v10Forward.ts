// V10-FORWARD and V10-AI-FORWARD, read once (V10 Stage 9): the 30-day forward run's records, judged on the lines their
// registrations hold (research/preregistered.jsonl). From the run's clock start (its first segment's start, once the
// forecast was ready) to its end (its last segment's end), on the UTC days the app was up -- a day is up where the forecast
// recorded at least 90% of its quarter-hour closes within the run -- per horizon of 1 hour, 4 hours and 24 hours:
//   (1) the share of forecasts whose shown middle (P50) is above nought, one at nought a half;
//   (2) the 80% range's coverage and its shares under P10 and over P90, pooled and by the class of the forecast's moment
//       (Bitcoin's move over the 24 hours before it, from binance.com's public hourly bars: risen or fallen);
//   (3) the real moves' sizes over the sizes expected, as a ratio of their sums;
// each with a 95% interval by whole UTC days drawn (10,000 draws, seeded). Then the daily forecast (written on the up days;
// its predictions due a day before the run's end judged), the accuracy board against the records, recounted, and the
// daily direction test's calls (V10-AI-FORWARD): balanced accuracy over the run's first 30 UTC days asked, by days drawn.
//
//   npx esbuild research/v10Forward.ts --bundle --platform=node --format=esm --outfile=research/.v10Forward.mjs
//   PROFILE=<run>-profile OUT=<run>-out node --max-old-space-size=8192 research/.v10Forward.mjs
//
// Writes RESULT (research/v10-forward.json by default). Reads the run's files and Binance's public bars; writes nothing else.
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { addToTally, boardDayOf, emptyTally, type BoardTally } from '../shared/evaluation/accuracyBoard'
import { parseDailyOutcome, parseDailyPrediction } from '../shared/forecast/daily/dailyRecord'
import { DAILY_HORIZON_DAYS, type DailyHorizon } from '../shared/forecast/daily/dailySize'
import { isMissing, parseOutcomeLine, parsePredictionLine, type OutcomeLine } from '../shared/forecast/forecastRecord'
import type { Horizon } from '../shared/forecast/features'

const PROFILE = process.env.PROFILE ?? ''
const OUT = process.env.OUT ?? ''
if (PROFILE === '' || OUT === '') throw new Error('PROFILE and OUT are needed')
const RESULT = process.env.RESULT ?? join('research', 'v10-forward.json')
const DAY = 86_400
const DRAWS = 10_000
const SEED = 20261119
const JUDGED: readonly Horizon[] = ['hour1', 'hours4', 'hours24']
const UP_SHARE = 0.9
const AI_SOURCE = 'ai-daily'
const AI_DAYS = 30
const AI_MIN_DAYS = 20
const FORECASTS = join(PROFILE, 'forecasts')
const LEDGER = join(PROFILE, 'predictions')
const dayOf = (sec: number): number => Math.floor(sec / DAY) * DAY
const iso = (sec: number): string => new Date(sec * 1000).toISOString()
const round = (value: number | null): number | null => (value === null || !Number.isFinite(value) ? null : Math.round(value * 1e4) / 1e4)

async function eachLine(path: string, take: (value: unknown) => void): Promise<void> {
  if (!existsSync(path)) return
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf-8' }), crlfDelay: Infinity })
  for await (const raw of reader) {
    if (raw.trim() === '') continue
    try {
      take(JSON.parse(raw))
    } catch {
      // A torn line.
    }
  }
}
const filesOf = (dir: string, pattern: RegExp): string[] => (existsSync(dir) ? readdirSync(dir).filter((name) => pattern.test(name)).sort().map((name) => join(dir, name)) : [])

function rngOf(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = state
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** A statistic over day vectors summed, with its 95% interval by whole days drawn with replacement. */
function byDays(days: readonly Float64Array[], statistic: (sum: Float64Array) => number): { value: number | null; ci: [number, number] | null; days: number } {
  if (days.length === 0) return { value: null, ci: null, days: 0 }
  const width = days[0].length
  const total = new Float64Array(width)
  for (const day of days) for (let k = 0; k < width; k++) total[k] += day[k]
  const value = statistic(total)
  const random = rngOf(SEED)
  const draws: number[] = []
  const sum = new Float64Array(width)
  for (let draw = 0; draw < DRAWS; draw++) {
    sum.fill(0)
    for (let i = 0; i < days.length; i++) {
      const day = days[Math.floor(random() * days.length)]
      for (let k = 0; k < width; k++) sum[k] += day[k]
    }
    const read = statistic(sum)
    if (Number.isFinite(read)) draws.push(read)
  }
  draws.sort((a, b) => a - b)
  const ci: [number, number] | null = draws.length === 0 ? null : [draws[Math.floor(0.025 * (draws.length - 1))], draws[Math.ceil(0.975 * (draws.length - 1))]]
  return { value: Number.isFinite(value) ? value : null, ci, days: days.length }
}
const figure = (read: ReturnType<typeof byDays>): { value: number | null; ci: [number | null, number | null] | null; days: number } => ({ value: round(read.value), ci: read.ci === null ? null : [round(read.ci[0]), round(read.ci[1])], days: read.days })
const within = (value: number | null, low: number, high: number): boolean => value !== null && value >= low && value <= high

// --- the run's window, and the days it was up ---------------------------------------------------------------------
const segments = JSON.parse(readFileSync(join(OUT, 'segments.json'), 'utf-8')) as { n: number; startedAt: number; endedAt?: number }[]
const START = Math.floor(segments[0].startedAt / 1000)
const last = segments[segments.length - 1]
const END = Math.floor((last.endedAt ?? Date.now()) / 1000)
const ended = typeof last.endedAt === 'number'

const passes = new Map<number, number>()
for (const path of filesOf(FORECASTS, /^passes-\d{4}-\d{2}\.jsonl$/)) {
  await eachLine(path, (value) => {
    const t = (value as { t?: unknown }).t
    if (typeof t !== 'number' || t < START || t >= END || t % 900 !== 0) return
    passes.set(dayOf(t), (passes.get(dayOf(t)) ?? 0) + 1)
  })
}
const runDays: { day: number; closes: number; passes: number; up: boolean }[] = []
for (let day = dayOf(START); day < END; day += DAY) {
  const from = Math.max(day, START)
  const to = Math.min(day + DAY, END)
  const closes = Math.floor((to - 1) / 900) - Math.ceil(from / 900) + 1
  if (closes <= 0) continue
  const recorded = passes.get(day) ?? 0
  runDays.push({ day, closes, passes: recorded, up: recorded >= UP_SHARE * closes })
}
const UP = new Set(runDays.filter((entry) => entry.up).map((entry) => entry.day))
const inRun = (t: number): boolean => t >= START && t < END && UP.has(dayOf(t))

// --- Bitcoin's move over the 24 hours before each moment -----------------------------------------------------------
const btcClose = new Map<number, number>()
for (let from = (dayOf(START) - 2 * DAY) * 1000; from < (END + 3600) * 1000; ) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1h&startTime=${from}&limit=1000`
  const rows = (await (await fetch(url)).json()) as [number, string, string, string, string][]
  if (!Array.isArray(rows) || rows.length === 0) break
  for (const row of rows) btcClose.set(row[0] / 1000 + 3600, Number(row[4]))
  from = rows[rows.length - 1][0] + 3_600_000
}
/** Risen or fallen over the 24 hours before `t`, by the hourly closes known at `t`; null where unread. */
function classOf(t: number): 'rose' | 'fell' | null {
  const now = btcClose.get(Math.floor(t / 3600) * 3600)
  const before = btcClose.get(Math.floor(t / 3600) * 3600 - DAY)
  if (now === undefined || before === undefined || now === before) return null
  return now > before ? 'rose' : 'fell'
}

// --- (1) the shown middle, (2) the ranges, (3) the size ----------------------------------------------------------
type DayVectors = Map<number, Float64Array>
const add = (map: DayVectors, day: number, width: number, values: readonly number[]): void => {
  let vector = map.get(day)
  if (vector === undefined) map.set(day, (vector = new Float64Array(width)))
  for (let k = 0; k < values.length; k++) vector[k] += values[k]
}
const middles = new Map<Horizon, DayVectors>(JUDGED.map((h) => [h, new Map()]))
for (const path of filesOf(FORECASTS, /^predictions-\d{4}-\d{2}\.jsonl$/)) {
  await eachLine(path, (value) => {
    const line = parsePredictionLine(value)
    if (line === null || !inRun(line.t)) return
    for (const h of JUDGED) {
      const mid = line.h[h]?.q[2]
      if (typeof mid !== 'number' || !Number.isFinite(mid)) continue
      add(middles.get(h)!, dayOf(line.t), 2, [1, mid > 0 ? 1 : mid === 0 ? 0.5 : 0])
    }
  })
}
// [n, in80, under P10, over P90, sized, size sum, |move| sum]
const WIDTH = 7
const ranges = new Map<string, DayVectors>()
const rangeKey = (h: Horizon, cls: 'all' | 'rose' | 'fell'): string => `${h}/${cls}`
for (const path of filesOf(FORECASTS, /^outcomes-\d{4}-\d{2}\.jsonl$/)) {
  await eachLine(path, (value) => {
    const line = parseOutcomeLine(value)
    if (line === null || isMissing(line) || !JUDGED.includes(line.h) || !inRun(line.t)) return
    const sized = typeof line.size === 'number' && Number.isFinite(line.size) && line.size > 0
    const vector = [1, line.in80 ? 1 : 0, line.below[0] === '1' ? 1 : 0, line.below[4] === '0' ? 1 : 0, sized ? 1 : 0, sized ? line.size! : 0, sized ? Math.abs(line.move) : 0]
    const cls = classOf(line.t)
    for (const key of [rangeKey(line.h, 'all'), ...(cls === null ? [] : [rangeKey(line.h, cls)])]) {
      let map = ranges.get(key)
      if (map === undefined) ranges.set(key, (map = new Map()))
      add(map, dayOf(line.t), WIDTH, vector)
    }
  })
}
const rangeFigures = (h: Horizon, cls: 'all' | 'rose' | 'fell'): Record<string, unknown> & { days: number; in80: ReturnType<typeof figure>; under: ReturnType<typeof figure>; over: ReturnType<typeof figure>; size: ReturnType<typeof figure>; n: number } => {
  const days = [...(ranges.get(rangeKey(h, cls))?.values() ?? [])]
  const n = days.reduce((sum, day) => sum + day[0], 0)
  return {
    n,
    days: days.length,
    in80: figure(byDays(days, (s) => s[1] / s[0])),
    under: figure(byDays(days, (s) => s[2] / s[0])),
    over: figure(byDays(days, (s) => s[3] / s[0])),
    size: figure(byDays(days, (s) => s[6] / s[5]))
  }
}
const horizons = JUDGED.map((h) => {
  const middle = figure(byDays([...middles.get(h)!.values()], (s) => s[1] / s[0]))
  const forecasts = [...middles.get(h)!.values()].reduce((sum, day) => sum + day[0], 0)
  const all = rangeFigures(h, 'all')
  const rose = rangeFigures(h, 'rose')
  const fell = rangeFigures(h, 'fell')
  const classLine = (entry: typeof rose): boolean | 'too few days' => (entry.days < 5 ? 'too few days' : within(entry.under.value, 0.07, 0.13) && within(entry.over.value, 0.07, 0.13))
  const lines = {
    middle: within(middle.value, 0.45, 0.55),
    coverage: within(all.in80.value, 0.75, 0.85),
    tails: within(all.under.value, 0.07, 0.13) && within(all.over.value, 0.07, 0.13),
    afterRise: classLine(rose),
    afterFall: classLine(fell),
    size: within(all.size.value, 0.85, 1.15)
  }
  const holds = Object.values(lines).every((line) => line === true || line === 'too few days')
  return { h, forecasts, middleAboveNought: middle, pooled: all, afterRise: rose, afterFall: fell, lines, holds }
})

// --- (4) the daily forecast ---------------------------------------------------------------------------------------
const dailyDays = new Set<number>()
const due: string[] = []
for (const path of filesOf(FORECASTS, /^daily-predictions-\d{4}\.jsonl$/)) {
  await eachLine(path, (value) => {
    const line = parseDailyPrediction(value)
    if (line === null || line.day < dayOf(START) || line.day >= END) return
    dailyDays.add(line.day)
    for (const h of Object.keys(line.h) as DailyHorizon[]) if (line.day + DAILY_HORIZON_DAYS[h] * DAY <= END - DAY) due.push(`${line.id}/${h}`)
  })
}
const dailySettled = new Set<string>()
const dailyOutcomes: ReturnType<typeof parseDailyOutcome>[] = []
for (const path of filesOf(FORECASTS, /^daily-outcomes-\d{4}\.jsonl$/)) {
  await eachLine(path, (value) => {
    const line = parseDailyOutcome(value)
    if (line === null) return
    dailySettled.add(`${line.id}/${line.h}`)
    dailyOutcomes.push(line)
  })
}
const upDays = [...UP]
const writtenShare = upDays.length === 0 ? null : upDays.filter((day) => dailyDays.has(day)).length / upDays.length
const judgedShare = due.length === 0 ? null : due.filter((key) => dailySettled.has(key)).length / due.length
const daily = {
  upDays: upDays.length,
  daysWritten: upDays.filter((day) => dailyDays.has(day)).length,
  writtenShare: round(writtenShare),
  due: due.length,
  judged: due.filter((key) => dailySettled.has(key)).length,
  judgedShare: round(judgedShare),
  holds: within(writtenShare, 0.9, 1) && within(judgedShare, 0.95, 1)
}

// --- (5) the board against the records ----------------------------------------------------------------------------
const recount = new Map<string, BoardTally>()
const tallyOf = (day: number, h: string): BoardTally => {
  const key = `${day}/${h}`
  let tally = recount.get(key)
  if (tally === undefined) recount.set(key, (tally = emptyTally()))
  return tally
}
const boardPath = join(FORECASTS, 'accuracy-board.json')
const board = existsSync(boardPath) ? (JSON.parse(readFileSync(boardPath, 'utf-8')) as { updatedAt: number | null; countedTo?: number | null; dailyCountedTo?: number | null; days: { day: number; h: string; tally: BoardTally }[] }) : null
// Read while the run goes on, the board's file is written a minute after each close's outcomes: the records are then
// recounted up to its last count alone. Once the run has ended (the app writes the board as it quits), all of them.
const upTo = ended ? Infinity : (board?.countedTo ?? Infinity)
const dailyUpTo = ended ? Infinity : (board?.dailyCountedTo ?? Infinity)
for (const path of filesOf(FORECASTS, /^outcomes-\d{4}-\d{2}\.jsonl$/)) {
  await eachLine(path, (value) => {
    const line = parseOutcomeLine(value)
    if (line === null || isMissing(line) || (line.at ?? line.due) > upTo) return
    addToTally(tallyOf(boardDayOf(line), line.h), line as OutcomeLine)
  })
}
for (const line of dailyOutcomes) if (line !== null && line.at <= dailyUpTo) addToTally(tallyOf(boardDayOf(line), line.h), { ...line, dir: 'NEUTRAL' })
const mismatches: { day: string; h: string; field: string; board: number; records: number }[] = []
let compared = 0
if (board !== null && board.days.length > 0) {
  const first = Math.min(...board.days.map((entry) => entry.day))
  const kept = new Map(board.days.map((entry) => [`${entry.day}/${entry.h}`, entry.tally]))
  const keys = new Set([...kept.keys(), ...[...recount.keys()].filter((key) => Number(key.split('/')[0]) >= first)])
  for (const key of keys) {
    const [day, h] = key.split('/')
    const mine = kept.get(key) ?? emptyTally()
    const theirs = recount.get(key) ?? emptyTally()
    compared++
    for (const field of Object.keys(theirs) as (keyof BoardTally)[]) {
      const a = mine[field]
      const b = theirs[field]
      const same = field === 'sizeSum' || field === 'moveSum' ? Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)) : a === b
      if (!same) mismatches.push({ day: iso(Number(day)).slice(0, 10), h, field, board: a, records: b })
    }
  }
}
const boardLine = { kept: board !== null, dayHorizonsCompared: compared, mismatches: mismatches.slice(0, 50), mismatchCount: mismatches.length, holds: board !== null && compared > 0 && mismatches.length === 0 }

// --- V10-AI-FORWARD -----------------------------------------------------------------------------------------------
interface Call { id: string; madeAt: number; side: 'up' | 'down' | null; confidence: number | null; pair: string }
const calls = new Map<string, Call>()
for (const path of filesOf(LEDGER, /^sources-\d{4}-\d{2}\.jsonl$/)) {
  await eachLine(path, (value) => {
    const row = value as { id?: string; source?: string; madeAt?: number; side?: 'up' | 'down' | null; dist?: { pRight?: number | null }; pair?: string }
    if (row.source !== AI_SOURCE || typeof row.id !== 'string' || typeof row.madeAt !== 'number') return
    calls.set(row.id, { id: row.id, madeAt: row.madeAt, side: row.side ?? null, confidence: row.dist?.pRight ?? null, pair: row.pair ?? '' })
  })
}
const results = new Map<string, { status: string; movePct: number | null; right: boolean | null; netPct: number | null }>()
for (const path of filesOf(LEDGER, /^source-outcomes-\d{4}-\d{2}\.jsonl$/)) {
  await eachLine(path, (value) => {
    const row = value as { id?: string; status?: string; movePct?: number | null; right?: boolean | null; netPct?: number | null }
    if (typeof row.id === 'string' && calls.has(row.id)) results.set(row.id, { status: row.status ?? '', movePct: row.movePct ?? null, right: row.right ?? null, netPct: row.netPct ?? null })
  })
}
const askedDays = [...new Set([...calls.values()].map((call) => dayOf(call.madeAt)))].sort((a, b) => a - b).slice(0, AI_DAYS)
const judgedDays = new Set(askedDays)
// [rose, rose and right, fell, fell and right, scored, right, called up, confidence sum, net sum, net n]
const aiDays = new Map<number, Float64Array>()
let unscored = 0
for (const call of calls.values()) {
  const day = dayOf(call.madeAt)
  if (!judgedDays.has(day)) continue
  const result = results.get(call.id)
  if (result === undefined || result.status === 'missing' || result.right === null || result.movePct === null || result.movePct === 0) {
    unscored++
    continue
  }
  const rose = result.movePct > 0 ? 1 : 0
  const right = result.right ? 1 : 0
  add(aiDays, day, 10, [rose, rose * right, 1 - rose, (1 - rose) * right, 1, right, call.side === 'up' ? 1 : 0, call.confidence ?? 0, result.netPct ?? 0, result.netPct === null ? 0 : 1])
}
const aiVectors = [...aiDays.values()]
const balanced = figure(byDays(aiVectors, (s) => (s[1] / s[0] + s[3] / s[2]) / 2))
const scored = aiVectors.reduce((sum, day) => sum + day[4], 0)
const calledUp = aiVectors.reduce((sum, day) => sum + day[6], 0)
const upShare = scored === 0 ? null : calledUp / scored
const aiVerdict = aiVectors.length < AI_MIN_DAYS ? 'not measured' : balanced.value !== null && balanced.value > 0.5 && balanced.ci !== null && (balanced.ci[0] ?? 0) > 0.5 && upShare !== null && upShare >= 0.25 && upShare <= 0.75 ? 'held' : 'failed'
const ai = {
  daysAsked: askedDays.length,
  firstDay: askedDays.length === 0 ? null : iso(askedDays[0]).slice(0, 10),
  daysAnsweredAndSettled: aiVectors.length,
  calls: [...calls.values()].filter((call) => judgedDays.has(dayOf(call.madeAt))).length,
  scored,
  unscored,
  balanced,
  rightOnRising: figure(byDays(aiVectors, (s) => s[1] / s[0])),
  rightOnFalling: figure(byDays(aiVectors, (s) => s[3] / s[2])),
  plainRight: figure(byDays(aiVectors, (s) => s[5] / s[4])),
  calledUpShare: round(upShare),
  meanConfidence: round(scored === 0 ? null : aiVectors.reduce((sum, day) => sum + day[7], 0) / scored),
  meanNetPct: figure(byDays(aiVectors, (s) => s[8] / s[9])),
  verdict: aiVerdict
}

const forwardHolds = horizons.every((entry) => entry.holds) && daily.holds && boardLine.holds
const result = {
  readAt: new Date().toISOString(),
  run: { start: iso(START), end: iso(END), ended, segments: segments.length, days: runDays.map((entry) => ({ day: iso(entry.day).slice(0, 10), closes: entry.closes, passes: entry.passes, up: entry.up })) },
  daysDown: runDays.filter((entry) => !entry.up).map((entry) => iso(entry.day).slice(0, 10)),
  btcHoursRead: btcClose.size,
  forward: { horizons, daily, board: boardLine, verdict: ended ? (forwardHolds ? 'held' : 'failed') : 'not measured (the run has not ended)' },
  aiForward: ai
}
writeFileSync(RESULT, JSON.stringify(result, null, 2))
console.log(JSON.stringify({ verdict: result.forward.verdict, ai: ai.verdict, horizons: horizons.map((entry) => ({ h: entry.h, holds: entry.holds, lines: entry.lines })), daily, board: { compared, mismatches: mismatches.length } }, null, 1))
