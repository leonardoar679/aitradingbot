// V9-MACRO-2, MEASURED (V9 Stage 6; registered 6 November 2026 before anything was read). After a U.S. CPI, PPI or
// jobs release, and apart after an FOMC statement, does Bitcoin go on the way its first fifteen minutes went?
// For each release of research/v9-macro-calendar.json: the 15-minute bar of Bitcoin opening at the release, its close
// against its open -- under 0.2% either way, no call -- and a trade that way from the next bar's open, out at the open
// 1, 4 or 24 hours on, net of a 0.24% round trip. Two groups, each measured alone: CPI, PPI and jobs together; FOMC.
// The horizon is chosen on the DISCOVERY half (2018 to 2022) alone, by the highest t of the net; then the HELD-OUT half
// (2023 to the end of the bars) is read once, on that horizon: the share right with its one-sided 95% Wilson lower
// bound, and the mean signed net with its one-sided 95% lower bound by resampling releases (10,000 draws, seeded).
// A group passes where the share's lower bound is above 50% and the mean's is above 0; a passing group is shown as
// information after a release, never as a card.
//
//   PHASE=discovery node research/v9Macro.mjs     writes research/v9-macro-discovery.json
//   PHASE=heldout node research/v9Macro.mjs       the held-out half, once, with the horizons the discovery file names
//
// Bitcoin's 15-minute bars: E:/Code/newtradingbot/.candles/BTCUSDT-15m.json ([open time s, open, high, low, close,
// volume]). It reads files; it places nothing.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const PHASE = process.env.PHASE ?? ''
if (PHASE !== 'discovery' && PHASE !== 'heldout') throw new Error('PHASE is discovery or heldout')
const BARS = process.env.BARS ?? 'E:/Code/newtradingbot/.candles/BTCUSDT-15m.json'
const CALENDAR_FILE = 'research/v9-macro-calendar.json'
const DISCOVERY_FILE = 'research/v9-macro-discovery.json'
const HELDOUT_FILE = process.env.OUT ?? 'research/v9-macro-heldout.json'
const LINES = { signalPct: 0.2, roundTripPct: 0.24, horizonsH: [1, 4, 24], heldOutFrom: Date.UTC(2023, 0, 1) / 1000, draws: 10_000, z: 1.6448536269514722 }
const GROUPS = { releases: ['CPI', 'PPI', 'JOBS'], fomc: ['FOMC'] }

const calendarText = readFileSync(CALENDAR_FILE, 'utf-8')
const calendarSha = createHash('sha256').update(calendarText).digest('hex')
const { events } = JSON.parse(calendarText)
const bars = new Map(JSON.parse(readFileSync(BARS, 'utf-8')).map((row) => [row[0], { open: row[1], close: row[4] }]))

/** A release's reading: its first fifteen minutes, the way called, and the trade's net at each horizon. */
function readingOf(release) {
  const first = bars.get(release.at)
  const entry = bars.get(release.at + 900)
  if (first === undefined || entry === undefined || !(first.open > 0) || !(entry.open > 0)) return { ...release, missing: true }
  const firstPct = (first.close / first.open - 1) * 100
  const way = firstPct >= LINES.signalPct ? 1 : firstPct <= -LINES.signalPct ? -1 : 0
  const nets = {}
  const right = {}
  for (const hours of LINES.horizonsH) {
    const exit = bars.get(release.at + 900 + hours * 3600)
    if (way === 0 || exit === undefined || !(exit.open > 0)) {
      nets[hours] = null
      right[hours] = null
      continue
    }
    const gross = way * (exit.open / entry.open - 1) * 100
    nets[hours] = gross - LINES.roundTripPct
    right[hours] = gross > 0
  }
  return { ...release, firstPct, way, nets, right }
}

const stats = (values) => {
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / Math.max(1, n)
  const sd = n > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : Number.NaN
  return { n, mean, sd, t: n > 1 && sd > 0 ? mean / (sd / Math.sqrt(n)) : Number.NaN }
}

/** The one-sided lower bound of a share by Wilson's interval at z. */
function wilsonLower(hits, n, z = LINES.z) {
  if (n === 0) return Number.NaN
  const p = hits / n
  const centre = p + (z * z) / (2 * n)
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return (centre - spread) / (1 + (z * z) / n)
}

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** The one-sided 95% lower bound of a mean, by resampling its values (10,000 draws, seeded). */
function bootstrapLower(values, draws = LINES.draws, seed = 20261106) {
  const next = rng(seed)
  const means = []
  for (let k = 0; k < draws; k++) {
    let sum = 0
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(next() * values.length)]
    means.push(sum / values.length)
  }
  means.sort((a, b) => a - b)
  return means[Math.floor(0.05 * draws)]
}

const half = (release) => (release.at < LINES.heldOutFrom ? 'discovery' : 'heldout')
const readings = events.filter((release) => half(release) === PHASE).map(readingOf)
const missing = readings.filter((reading) => reading.missing).length

const groupRows = (kinds) => readings.filter((reading) => !reading.missing && kinds.includes(reading.kind))

if (PHASE === 'discovery') {
  const groups = {}
  for (const [group, kinds] of Object.entries(GROUPS)) {
    const rows = groupRows(kinds)
    const called = rows.filter((row) => row.way !== 0)
    const byHorizon = LINES.horizonsH.map((hours) => {
      const nets = called.map((row) => row.nets[hours]).filter((value) => value !== null)
      const s = stats(nets)
      return { hours, n: s.n, mean: s.mean, t: s.t, shareRight: nets.length === 0 ? null : called.filter((row) => row.right[hours] === true).length / nets.length }
    })
    const chosen = [...byHorizon].sort((a, b) => (Number.isNaN(b.t) ? -Infinity : b.t) - (Number.isNaN(a.t) ? -Infinity : a.t))[0]
    groups[group] = { releases: rows.length, called: called.length, byHorizon, chosenHours: chosen.hours }
  }
  writeFileSync(DISCOVERY_FILE, `${JSON.stringify({ version: 'v9-macro-discovery-v1', phase: PHASE, calendarSha256: calendarSha, lines: LINES, missing, groups }, null, 1)}\n`)
  for (const [group, entry] of Object.entries(groups)) console.log(`${group}: ${entry.releases} releases, ${entry.called} called; ${entry.byHorizon.map((h) => `${h.hours}h mean ${h.mean.toFixed(3)}% t ${h.t.toFixed(2)} right ${(h.shareRight * 100).toFixed(1)}%`).join('; ')}; chosen ${entry.chosenHours}h`)
} else {
  const discovery = JSON.parse(readFileSync(DISCOVERY_FILE, 'utf-8'))
  if (discovery.calendarSha256 !== calendarSha) throw new Error('the calendar is not the one the discovery half read')
  const groups = {}
  for (const [group, kinds] of Object.entries(GROUPS)) {
    const hours = discovery.groups[group].chosenHours
    const rows = groupRows(kinds)
    const called = rows.filter((row) => row.way !== 0 && row.nets[hours] !== null)
    const nets = called.map((row) => row.nets[hours])
    const hits = called.filter((row) => row.right[hours] === true).length
    const s = stats(nets)
    const shareLower = wilsonLower(hits, called.length)
    const meanLower = called.length > 1 ? bootstrapLower(nets) : Number.NaN
    groups[group] = {
      hours,
      releases: rows.length,
      called: called.length,
      shareRight: called.length === 0 ? null : hits / called.length,
      shareLower95: shareLower,
      meanNet: s.mean,
      meanLower95: meanLower,
      t: s.t,
      verdict: called.length === 0 ? 'not measured' : shareLower > 0.5 && meanLower > 0 ? 'held' : 'failed',
      rows: called.map((row) => ({ kind: row.kind, date: row.date, firstPct: row.firstPct, way: row.way, net: row.nets[hours] }))
    }
  }
  writeFileSync(HELDOUT_FILE, `${JSON.stringify({ version: 'v9-macro-heldout-v1', phase: PHASE, calendarSha256: calendarSha, missing, groups }, null, 1)}\n`)
  for (const [group, entry] of Object.entries(groups)) console.log(`${group} at ${entry.hours}h: ${entry.called} of ${entry.releases} called; right ${(entry.shareRight * 100).toFixed(1)}% (lower ${(entry.shareLower95 * 100).toFixed(1)}%), mean net ${entry.meanNet.toFixed(3)}% (lower ${entry.meanLower95.toFixed(3)}%), t ${entry.t.toFixed(2)}: ${entry.verdict}`)
}
