// V10'S DIRECTION STUDIES AT ONE TO SEVEN DAYS (V10 Stage 5, 19 November 2026; registered as V10-TSMOM, V10-XSMOM and
// V10-EXPL before any of this was read). Every direction source tried before was read at five minutes to a day, and
// none held. This reads the ones never tried, on Binance's daily archive with each month's universe chosen by the month
// before's volume, delisted coins included:
//   V10-TSMOM  (confirmatory) a coin's own trend over L days calls its way over h days: twelve (L, h), one chosen on the
//              discovery half (2018 to 2023), that one judged once on the held-out half (2024 to October 2026);
//   V10-XSMOM  (exploratory) the week's top fifth by L-day return beats the week's median move, the bottom fifth trails;
//   V10-EXPL   (exploratory) Fear and Greed, the stablecoins' growth, DVOL jumping and the funding's extremes against
//              Bitcoin's way over three and seven days.
// Scored the way a market going one way cannot fool: balanced accuracy, the mean of the share right on the moves that
// rose and on those that fell, which a constant side scores at 50%; intervals by drawing whole calendar weeks.
//
//   PHASE=discovery DAILY=<archive-daily> EXTRAS=<daily-extras> node research/v10Direction.mjs
//   PHASE=heldout   DAILY=<archive-daily> EXTRAS=<daily-extras> node research/v10Direction.mjs
//
// The discovery writes research/v10-direction-discovery.json with the SHA-256 of every input; the held-out read refuses
// inputs that changed, and a discovery not committed.
import { createHash } from 'crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const DAILY = process.env.DAILY
const EXTRAS = process.env.EXTRAS
const PHASE = process.env.PHASE
if (!DAILY || !EXTRAS || (PHASE !== 'discovery' && PHASE !== 'heldout')) throw new Error('DAILY, EXTRAS and PHASE=discovery|heldout are needed')
const DISCOVERY_FILE = 'research/v10-direction-discovery.json'
const HELDOUT_FILE = 'research/v10-direction-heldout.json'

const DAY = 86_400
const at = (y, m, d) => Date.UTC(y, m - 1, d) / 1000
const HALVES = { discovery: [at(2018, 1, 1), at(2024, 1, 1)], heldout: [at(2024, 1, 1), at(2026, 11, 1)] }
const LOOKBACKS = [7, 14, 28, 56]
const XS_LOOKBACKS = [7, 14, 28]
const HORIZONS = [1, 3, 7]
const COST_PCT = 0.24
const DRAWS = 10_000
const SEED = 20261119
const REGIME_DAYS = 140
const MIN_MINORITY = 0.25
const MIN_CALLS = 200

// ---------------------------------------------------------------------------------------------
// The inputs, locked.

const dailyDir = join(DAILY, 'daily')
const dailyFiles = readdirSync(dailyDir).filter((name) => /^[A-Z0-9]+-\d{4}-\d{2}\.jsonl$/.test(name)).sort()
const extraFiles = ['fng.json', 'stablecoins.json', 'dvol-btc.json', 'funding-btc.json']
function lockOf() {
  const hash = createHash('sha256')
  for (const name of dailyFiles) {
    hash.update(name)
    hash.update(readFileSync(join(dailyDir, name)))
  }
  hash.update(readFileSync(join(DAILY, 'universe.json')))
  for (const name of extraFiles) hash.update(readFileSync(join(EXTRAS, name)))
  return hash.digest('hex')
}
const lock = lockOf()

// Each pair's daily bars by day: [open, high, low, close].
const bars = new Map()
for (const name of dailyFiles) {
  const pair = name.replace(/-\d{4}-\d{2}\.jsonl$/, '')
  let mine = bars.get(pair)
  if (mine === undefined) bars.set(pair, (mine = new Map()))
  for (const line of readFileSync(join(dailyDir, name), 'utf-8').split('\n')) {
    if (line.trim() === '') continue
    const row = JSON.parse(line)
    mine.set(Math.floor(row[0] / DAY) * DAY, [row[1], row[2], row[3], row[4]])
  }
}
const universe = JSON.parse(readFileSync(join(DAILY, 'universe.json'), 'utf-8')).months
const monthOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 7)
const btc = bars.get('BTCUSDT')
if (btc === undefined) throw new Error('no Bitcoin in the daily archive')
console.log(`${bars.size} pairs, ${dailyFiles.length} month files, ${Object.keys(universe).length} universe months; lock ${lock.slice(0, 16)}`)

// Bitcoin above or below its 140-day mean at the close before a call: 1, 0, or -1 where not read.
function regimeAt(day) {
  let sum = 0
  for (let k = 1; k <= REGIME_DAYS; k++) {
    const bar = btc.get(day - k * DAY)
    if (bar === undefined) return -1
    sum += bar[3]
  }
  const last = btc.get(day - DAY)
  return last[3] > sum / REGIME_DAYS ? 1 : 0
}

const closeAt = (series, day) => series.get(day)?.[3]
/** A coin's return over L days to the close before `day`, and its move from `day`'s open to the close h days on. */
function lookbackOf(series, day, lookback) {
  const now = closeAt(series, day - DAY)
  const then = closeAt(series, day - (lookback + 1) * DAY)
  return now === undefined || then === undefined || !(then > 0) ? null : now / then - 1
}
function moveOf(series, day, h) {
  const open = series.get(day)?.[0]
  for (let k = 0; k < h; k++) if (!series.has(day + k * DAY)) return null
  const close = closeAt(series, day + (h - 1) * DAY)
  return open === undefined || close === undefined || !(open > 0) ? null : (close / open - 1) * 100
}
/** The call days of a horizon in a half: every day, every third day, each Monday; its horizon ended within the half. */
function callDays(h, [from, to]) {
  const out = []
  for (let day = from; day + h * DAY <= to; day += DAY) {
    if (h === 3 && (day / DAY) % 3 !== 0) continue
    if (h === 7 && new Date(day * 1000).getUTCDay() !== 1) continue
    out.push(day)
  }
  return out
}
const MONDAY0 = at(2017, 12, 4)
const weekOf = (day) => Math.floor((day - MONDAY0) / (7 * DAY))

// ---------------------------------------------------------------------------------------------
// The figures: each call a vector summed by week; whole weeks drawn.

// [rose, rose and right, fell, fell and right, up calls, down calls, net, calls, then the same four above Bitcoin's mean, four below]
const WIDTH = 16
function vectorOf(side, move, regime) {
  const v = new Float64Array(WIDTH)
  if (move === 0) return null
  const rose = move > 0 ? 1 : 0
  const right = (side > 0) === rose > 0 ? 1 : 0
  v[0] = rose
  v[1] = rose * right
  v[2] = 1 - rose
  v[3] = (1 - rose) * right
  v[4] = side > 0 ? 1 : 0
  v[5] = side > 0 ? 0 : 1
  v[6] = side * move - COST_PCT
  v[7] = 1
  if (regime >= 0) {
    const base = regime === 1 ? 8 : 12
    v[base] = v[0]
    v[base + 1] = v[1]
    v[base + 2] = v[2]
    v[base + 3] = v[3]
  }
  return v
}
const balancedOf = (s, k = 0) => (s[k] > 0 && s[k + 2] > 0 ? (s[k + 1] / s[k] + s[k + 3] / s[k + 2]) / 2 : Number.NaN)
const STATISTICS = {
  balanced: (s) => balancedOf(s),
  rightOnRising: (s) => (s[0] > 0 ? s[1] / s[0] : Number.NaN),
  rightOnFalling: (s) => (s[2] > 0 ? s[3] / s[2] : Number.NaN),
  minority: (s) => Math.min(s[4], s[5]) / (s[4] + s[5]),
  netMean: (s) => s[6] / s[7],
  balancedAbove: (s) => balancedOf(s, 8),
  balancedBelow: (s) => balancedOf(s, 12)
}

function rngOf(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let x = state
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** The figures of calls {week, vector}, each with its 95% interval and one-sided 95% lower bound by a circular block
 * bootstrap of the calendar weeks (every week from the first to the last, an empty one adding nothing). */
function figuresOf(calls, blockWeeks) {
  if (calls.length === 0) return { calls: 0 }
  // Folded, not spread: a spread of a hundred thousand calls overflows the stack.
  const first = calls.reduce((least, call) => Math.min(least, call.week), Infinity)
  const last = calls.reduce((most, call) => Math.max(most, call.week), -Infinity)
  const weeks = Array.from({ length: last - first + 1 }, () => new Float64Array(WIDTH))
  const total = new Float64Array(WIDTH)
  for (const call of calls) {
    for (let k = 0; k < WIDTH; k++) {
      weeks[call.week - first][k] += call.vector[k]
      total[k] += call.vector[k]
    }
  }
  const names = Object.keys(STATISTICS)
  const draws = Object.fromEntries(names.map((name) => [name, []]))
  const random = rngOf(SEED)
  const m = weeks.length
  const sums = new Float64Array(WIDTH)
  for (let draw = 0; draw < DRAWS; draw++) {
    sums.fill(0)
    for (let taken = 0; taken < m; ) {
      const start = Math.floor(random() * m)
      for (let j = 0; j < blockWeeks && taken < m; j++, taken++) {
        const week = weeks[(start + j) % m]
        for (let k = 0; k < WIDTH; k++) sums[k] += week[k]
      }
    }
    for (const name of names) {
      const value = STATISTICS[name](sums)
      if (Number.isFinite(value)) draws[name].push(value)
    }
  }
  const out = { calls: calls.length, weeks: m }
  for (const name of names) {
    const value = STATISTICS[name](total)
    const sorted = draws[name].sort((a, b) => a - b)
    const pick = (p) => (sorted.length === 0 ? null : round(sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]))
    out[name] = Number.isFinite(value) ? { value: round(value), low: pick(0.025), high: pick(0.975), lower95: pick(0.05) } : null
  }
  return out
}
const round = (value) => Math.round(value * 1e5) / 1e5

// ---------------------------------------------------------------------------------------------
// V10-TSMOM.

function tsmomCalls(lookback, h, half) {
  const calls = []
  for (const day of callDays(h, half)) {
    const pairs = universe[monthOf(day)]?.pairs ?? []
    const regime = regimeAt(day)
    for (const pair of pairs) {
      const series = bars.get(pair)
      if (series === undefined) continue
      const trend = lookbackOf(series, day, lookback)
      const move = moveOf(series, day, h)
      if (trend === null || move === null || trend === 0) continue
      const vector = vectorOf(trend > 0 ? 1 : -1, move, regime)
      if (vector !== null) calls.push({ week: weekOf(day), vector })
    }
  }
  return calls
}
const blockOf = (h) => (h === 7 ? 2 : 1)

// ---------------------------------------------------------------------------------------------
// V10-XSMOM: each Monday's top and bottom fifth against the week's median move.

function xsmomCalls(lookback, half) {
  const calls = []
  for (const day of callDays(7, half)) {
    const rows = []
    for (const pair of universe[monthOf(day)]?.pairs ?? []) {
      const series = bars.get(pair)
      if (series === undefined) continue
      const trend = lookbackOf(series, day, lookback)
      const move = moveOf(series, day, 7)
      if (trend !== null && move !== null) rows.push({ trend, move })
    }
    if (rows.length < 10) continue
    const moves = rows.map((row) => row.move).sort((a, b) => a - b)
    const median = moves.length % 2 === 1 ? moves[(moves.length - 1) / 2] : (moves[moves.length / 2 - 1] + moves[moves.length / 2]) / 2
    rows.sort((a, b) => b.trend - a.trend)
    const fifth = Math.ceil(rows.length / 5)
    // Scored as V10-TSMOM's vector against the median: "rose" is a move above the week's median.
    for (const row of rows.slice(0, fifth)) {
      const vector = vectorOf(1, row.move - median, -1)
      if (vector !== null) calls.push({ week: weekOf(day), vector })
    }
    for (const row of rows.slice(-fifth)) {
      const vector = vectorOf(-1, row.move - median, -1)
      if (vector !== null) calls.push({ week: weekOf(day), vector })
    }
  }
  return calls
}

// ---------------------------------------------------------------------------------------------
// V10-EXPL: Bitcoin's way against four market-wide readings.

const series = (name) => new Map(JSON.parse(readFileSync(join(EXTRAS, name), 'utf-8')).map((row) => [row[0], row[1]]))
const fng = series('fng.json')
const stable = series('stablecoins.json')
const dvol = series('dvol-btc.json')
const fundingRows = JSON.parse(readFileSync(join(EXTRAS, 'funding-btc.json'), 'utf-8'))
/** The funding's mean over the seven days before a day. */
function fundingWeek(day) {
  const mine = fundingRows.filter((row) => row[0] >= day - 7 * DAY && row[0] < day)
  return mine.length < 15 ? null : mine.reduce((sum, row) => sum + row[1], 0) / mine.length
}
const fundingByDay = new Map()
/** Where `value` falls in the trailing year of a daily reading: its share of the year's readings under it. */
function rankInYear(read, day, value) {
  const past = []
  for (let k = 1; k <= 365; k++) {
    const x = read(day - k * DAY)
    if (x !== null && x !== undefined && Number.isFinite(x)) past.push(x)
  }
  if (past.length < 300) return null
  return past.filter((x) => x < value).length / past.length
}
const stableGrowth = (day) => {
  const now = stable.get(day - DAY)
  const then = stable.get(day - 31 * DAY)
  return now === undefined || then === undefined || !(then > 0) ? null : now / then - 1
}
const funding7 = (day) => {
  if (!fundingByDay.has(day)) fundingByDay.set(day, fundingWeek(day))
  return fundingByDay.get(day)
}
const READINGS = {
  fearAndGreed: (day) => {
    const value = fng.get(day - DAY)
    if (value === undefined) return 0
    return value <= 20 ? 1 : value >= 80 ? -1 : 0
  },
  stablecoinGrowth: (day) => {
    const growth = stableGrowth(day)
    if (growth === null) return 0
    const rank = rankInYear(stableGrowth, day, growth)
    return rank === null ? 0 : rank >= 0.8 ? 1 : rank <= 0.2 ? -1 : 0
  },
  dvolJump: (day) => {
    const values = []
    for (let k = 1; k <= 30; k++) {
      const x = dvol.get(day - k * DAY)
      if (x !== undefined) values.push(x)
    }
    const now = dvol.get(day - DAY)
    if (values.length < 25 || now === undefined) return 0
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1))
    if (!(sd > 0) || (now - mean) / sd <= 2) return 0
    const week = lookbackOf(btc, day, 7)
    return week === null || week === 0 ? 0 : week > 0 ? -1 : 1
  },
  fundingExtreme: (day) => {
    const value = funding7(day)
    if (value === null) return 0
    const rank = rankInYear(funding7, day, value)
    return rank === null ? 0 : rank >= 0.9 ? -1 : rank <= 0.1 ? 1 : 0
  }
}
function explCalls(read, h, half) {
  const calls = []
  for (const day of callDays(h, half)) {
    const side = read(day)
    if (side === 0) continue
    const move = moveOf(btc, day, h)
    if (move === null) continue
    const vector = vectorOf(side, move, regimeAt(day))
    if (vector !== null) calls.push({ week: weekOf(day), vector })
  }
  return calls
}

// ---------------------------------------------------------------------------------------------

const started = Date.now()
const elapsed = () => `${((Date.now() - started) / 60_000).toFixed(1)} min`
const line = (name, f) => `${name}: ${f.calls} calls${f.balanced ? `, balanced ${(f.balanced.value * 100).toFixed(1)}% [${(f.balanced.low * 100).toFixed(1)}, ${(f.balanced.high * 100).toFixed(1)}] lower95 ${(f.balanced.lower95 * 100).toFixed(1)}%, rises ${(f.rightOnRising.value * 100).toFixed(1)}%, falls ${(f.rightOnFalling.value * 100).toFixed(1)}%, minority ${(f.minority.value * 100).toFixed(1)}%, net ${f.netMean.value.toFixed(3)}%` : ''}`

if (PHASE === 'discovery') {
  const half = HALVES.discovery
  const tsmom = {}
  for (const lookback of LOOKBACKS) {
    for (const h of HORIZONS) {
      const f = figuresOf(tsmomCalls(lookback, h, half), blockOf(h))
      tsmom[`L${lookback}h${h}`] = { lookback, h, ...f }
      console.log(`  ${line(`TSMOM L${lookback} h${h}`, f)} (${elapsed()})`)
    }
  }
  const eligible = Object.values(tsmom).filter((entry) => entry.balanced && entry.minority && entry.minority.value >= MIN_MINORITY)
  const chosen = eligible.sort((a, b) => b.balanced.value - a.balanced.value)[0] ?? null
  const xsmom = {}
  for (const lookback of XS_LOOKBACKS) {
    const f = figuresOf(xsmomCalls(lookback, half), 1)
    xsmom[`L${lookback}`] = { lookback, ...f }
    console.log(`  ${line(`XSMOM L${lookback}`, f)} (${elapsed()})`)
  }
  const xsChosen = Object.values(xsmom).filter((entry) => entry.balanced).sort((a, b) => b.balanced.value - a.balanced.value)[0] ?? null
  const expl = {}
  for (const [name, read] of Object.entries(READINGS)) {
    for (const h of [3, 7]) {
      const f = figuresOf(explCalls(read, h, half), blockOf(h))
      expl[`${name}h${h}`] = { reading: name, h, ...f }
      console.log(`  ${line(`EXPL ${name} h${h}`, f)} (${elapsed()})`)
    }
  }
  const out = { phase: 'discovery', at: new Date().toISOString(), half: half.map((sec) => new Date(sec * 1000).toISOString().slice(0, 10)), lock, inputs: { dailyFiles: dailyFiles.length, pairs: bars.size }, tsmom, chosen: chosen === null ? null : { lookback: chosen.lookback, h: chosen.h }, xsmom, xsChosen: xsChosen === null ? null : { lookback: xsChosen.lookback }, expl }
  writeFileSync(DISCOVERY_FILE, JSON.stringify(out, null, 1))
  console.log(`chosen: ${JSON.stringify(out.chosen)}; XSMOM ${JSON.stringify(out.xsChosen)} -> ${DISCOVERY_FILE}`)
} else {
  if (!existsSync(DISCOVERY_FILE)) throw new Error('no discovery: run PHASE=discovery and commit it first')
  const discovery = JSON.parse(readFileSync(DISCOVERY_FILE, 'utf-8'))
  if (discovery.lock !== lock) throw new Error(`the inputs changed since the discovery: ${lock.slice(0, 16)} against ${discovery.lock.slice(0, 16)}`)
  const half = HALVES.heldout
  const result = { phase: 'heldout', at: new Date().toISOString(), half: half.map((sec) => new Date(sec * 1000).toISOString().slice(0, 10)), lock, chosen: discovery.chosen }
  if (discovery.chosen !== null) {
    const { lookback, h } = discovery.chosen
    const f = figuresOf(tsmomCalls(lookback, h, half), blockOf(h))
    const lines = {
      enough: f.calls >= MIN_CALLS,
      lowerAbove50: f.balanced !== null && f.balanced.lower95 > 0.5,
      minority: f.minority !== null && f.minority.value >= MIN_MINORITY,
      bothRegimes: f.balancedAbove !== null && f.balancedBelow !== null && f.balancedAbove.value > 0.5 && f.balancedBelow.value > 0.5,
      net: f.netMean !== null && f.netMean.value > 0
    }
    result.tsmom = { lookback, h, ...f, lines, verdict: !lines.enough ? 'not measured' : Object.values(lines).every(Boolean) ? 'held' : 'failed' }
    console.log(`  ${line(`TSMOM L${lookback} h${h} held out`, f)}; ${result.tsmom.verdict} ${JSON.stringify(lines)}`)
  }
  if (discovery.xsChosen !== null) {
    const f = figuresOf(xsmomCalls(discovery.xsChosen.lookback, half), 1)
    result.xsmom = { lookback: discovery.xsChosen.lookback, ...f }
    console.log(`  ${line(`XSMOM L${discovery.xsChosen.lookback} held out`, f)}`)
  }
  result.expl = {}
  for (const [name, read] of Object.entries(READINGS)) {
    for (const h of [3, 7]) {
      const f = figuresOf(explCalls(read, h, half), blockOf(h))
      result.expl[`${name}h${h}`] = { reading: name, h, ...f }
      console.log(`  ${line(`EXPL ${name} h${h} held out`, f)}`)
    }
  }
  writeFileSync(HELDOUT_FILE, JSON.stringify(result, null, 1))
  console.log(`-> ${HELDOUT_FILE} (${elapsed()})`)
}
