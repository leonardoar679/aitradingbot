// WHEN DO THESE STRATEGIES LOSE, AND CAN IT BE KNOWN BEFORE THE MONTH STARTS?
//
// Everything gated so far has been a BAR-level filter: a rule inside the strategy deciding whether
// to take one entry. This asks a different question, the one an operator actually has -- given what
// the market looked like on the 1st, should this strategy be running at all this month?
//
// That distinction matters because research/chop.ts already rejected the bar-level version of
// several of these ideas (a drawdown-from-peak gate at 10/20/35%, a volatility gate, a rising-
// averages requirement). A month-level go/no-go is not the same object: it never interrupts a trade
// in flight, it is evaluated 36 times per symbol rather than tens of thousands, and it is allowed to
// say "sit this one out" rather than "skip this entry".
//
// NO LOOKAHEAD, AND THIS IS THE WHOLE DESIGN CONSTRAINT. Every feature is computed from daily bars
// strictly BEFORE the month begins -- the last daily close on or before the 1st, looking backwards
// only. A feature that peeks at the month it is predicting would produce a beautiful table and a
// rule that cannot be run. The month's realised return is read from the per-month dump that
// research/monthiv.ts writes, so the returns come from the shipped strategies via the real engine.
//
// THE FEATURES ARE ALL BORROWED, DELIBERATELY. Inventing an indicator and then discovering it works
// on the data used to invent it is the failure this directory keeps recording. These are standard,
// published, and each has a specific reason to bear on trend/breakout strategies:
//
//   above200      Price above its 200-day average. Faber's tactical rule, the canonical "is this a
//                 market worth being long in" filter.
//   trend100      Distance from the 100-day average, as a continuous version of the same idea.
//   ddFromPeak    Drawdown from the trailing 1-year high. README's own diagnosis says the damage is
//                 concentrated 10-35% below the running peak -- the band where tops form.
//   er30          Kaufman's Efficiency Ratio: net move divided by total path length. Low means the
//                 market travelled a long way to get nowhere, which is the textbook condition under
//                 which trend following bleeds.
//   chop30        Dreiss's Choppiness Index, built for exactly this question. High = choppy.
//   adx14         Wilder's ADX, trend strength. Low ADX is the classic "do not trend-follow" signal.
//   vol30         Realised volatility, 30 daily returns annualised.
//   volRatio      vol30 / vol180. Volatility clustering is one of the most robust facts in finance,
//                 so a vol regime SHIFT is more informative than its level.
//   breadth       Fraction of all eight symbols above their own 100-day average. Cross-sectional,
//                 and the closest thing here to "what season is the market in" rather than "what is
//                 this coin doing".
//   prevRet       The strategy's own previous month. Tests whether good and bad months cluster at
//                 all, which is the precondition for any of this working.
//
// DISCOVERY ONLY. The quintile tables below are printed for BTC/ETH/SOL/ADA. BNB/LINK/LTC/XRP are
// loaded (breadth needs them) but their returns are never shown, so a rule chosen by reading this
// output has still never seen them. research/gonogo.ts is where a rule gets tested against them.

import { readFileSync } from 'fs'
import { join } from 'path'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const DUMP = process.env.IN || 'research/.eight.json'
const INTERVAL = process.env.INTERVAL || '15m'
const DISCOVERY = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT']
const CONFIRM = ['BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT']
const ALL = [...DISCOVERY, ...CONFIRM]
const STRATS = [
  ['trend-regime-ensemble', 'Trend Regime'],
  ['short-term-channel', 'Short-Term Channel'],
  ['short-term-channel-regime', 'Channel + Regime']
] as const

interface MonthResult { month: string; trades: number; finalBalance: number; returnPct: number }

function daily(symbol: string): Candle[] {
  const raw = JSON.parse(readFileSync(join(DIR, symbol + '-1d.json'), 'utf-8')) as number[][]
  return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
}

function months(): Array<[string, number]> {
  const out: Array<[string, number]> = []
  for (let i = 0; i < 36; i++) {
    const y = 2023 + Math.floor((8 + i) / 12)
    const m = (8 + i) % 12
    out.push([`${y}-${String(m + 1).padStart(2, '0')}`, Date.UTC(y, m, 1) / 1000])
  }
  return out
}

const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN)
const sd = (v: number[]): number => {
  if (v.length < 2) return NaN
  const m = mean(v)
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1))
}
const median = (v: number[]): number => {
  if (!v.length) return NaN
  const s = [...v].sort((a, b) => a - b)
  const i = s.length >> 1
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}

// ------------------------------------------------------------------ indicators, on DAILY bars
/** Kaufman Efficiency Ratio: how much of the path actually went somewhere. 1 = a straight line,
 * near 0 = a lot of motion and no progress. */
function efficiencyRatio(closes: number[], end: number, n: number): number {
  if (end - n < 0) return NaN
  let path = 0
  for (let i = end - n + 1; i <= end; i++) path += Math.abs(closes[i] - closes[i - 1])
  return path === 0 ? 0 : Math.abs(closes[end] - closes[end - n]) / path
}

/** Dreiss's Choppiness Index, 0-100. Above ~61 is conventionally "choppy", below ~38 "trending". */
function choppiness(c: Candle[], end: number, n: number): number {
  if (end - n < 0) return NaN
  let atrSum = 0
  let hi = -Infinity
  let lo = Infinity
  for (let i = end - n + 1; i <= end; i++) {
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    atrSum += tr
    hi = Math.max(hi, c[i].high)
    lo = Math.min(lo, c[i].low)
  }
  const range = hi - lo
  if (range <= 0 || atrSum <= 0) return NaN
  return (100 * Math.log10(atrSum / range)) / Math.log10(n)
}

/** Wilder's ADX. Smoothing is Wilder's own (alpha = 1/n), not an EMA -- using an EMA here is a
 * common and silent mis-implementation that shifts every value. */
function adx(c: Candle[], end: number, n: number): number {
  const need = 2 * n + 1
  if (end - need < 0) return NaN
  let trS = 0
  let pdmS = 0
  let ndmS = 0
  const dxs: number[] = []
  for (let i = end - need + 1; i <= end; i++) {
    const up = c[i].high - c[i - 1].high
    const dn = c[i - 1].low - c[i].low
    const pdm = up > dn && up > 0 ? up : 0
    const ndm = dn > up && dn > 0 ? dn : 0
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    trS = trS - trS / n + tr
    pdmS = pdmS - pdmS / n + pdm
    ndmS = ndmS - ndmS / n + ndm
    if (trS > 0) {
      const pdi = (100 * pdmS) / trS
      const ndi = (100 * ndmS) / trS
      const sum = pdi + ndi
      if (sum > 0) dxs.push((100 * Math.abs(pdi - ndi)) / sum)
    }
  }
  return dxs.length >= n ? mean(dxs.slice(-n)) : NaN
}

const smaAt = (v: number[], end: number, n: number): number => {
  if (end - n + 1 < 0) return NaN
  let s = 0
  for (let i = end - n + 1; i <= end; i++) s += v[i]
  return s / n
}

function realisedVol(closes: number[], end: number, n: number): number {
  if (end - n < 0) return NaN
  const rs: number[] = []
  for (let i = end - n + 1; i <= end; i++) rs.push(Math.log(closes[i] / closes[i - 1]))
  return sd(rs) * Math.sqrt(365) * 100
}

// ------------------------------------------------------------------------------- assemble rows
interface Row {
  symbol: string
  month: string
  ret: number
  trades: number
  f: Record<string, number>
}

const bars = new Map<string, Candle[]>()
for (const s of ALL) {
  try { bars.set(s, daily(s)) } catch { console.log('  no daily data for ' + s) }
}

/** Index of the last daily bar strictly before the month opens. Everything is computed from here
 * backwards; nothing at or after this index is ever read. */
function priorIndex(c: Candle[], startSec: number): number {
  let lo = -1
  for (let i = 0; i < c.length; i++) {
    if (c[i].time < startSec) lo = i
    else break
  }
  return lo
}

/** Share of symbols trading above their own 100-day average on the given date. The market's season
 * rather than one coin's -- computed over whichever symbols have history by then, so early months
 * are not silently scored against a smaller universe without saying so. */
function breadthAt(startSec: number): number {
  let above = 0
  let total = 0
  for (const s of ALL) {
    const c = bars.get(s)
    if (!c) continue
    const i = priorIndex(c, startSec)
    if (i < 100) continue
    const closes = c.map((x) => x.close)
    const ma = smaAt(closes, i, 100)
    if (!Number.isFinite(ma)) continue
    total++
    if (closes[i] > ma) above++
  }
  return total ? above / total : NaN
}

const dump = JSON.parse(readFileSync(DUMP, 'utf-8')) as Record<string, MonthResult[]>
const MONTHS = months()

function rowsFor(stratId: string, symbols: string[]): Row[] {
  const out: Row[] = []
  for (const symbol of symbols) {
    const c = bars.get(symbol)
    const res = dump[symbol + '|' + stratId + '|' + INTERVAL]
    if (!c || !res) continue
    const byMonth = new Map(res.map((r) => [r.month, r]))
    const closes = c.map((x) => x.close)
    for (const [label, startSec] of MONTHS) {
      const r = byMonth.get(label)
      if (!r) continue
      const i = priorIndex(c, startSec)
      if (i < 380) continue // needs a year of peak history plus the longest average
      const peak = Math.max(...closes.slice(Math.max(0, i - 364), i + 1))
      const prev = byMonth.get(MONTHS[MONTHS.findIndex((m) => m[0] === label) - 1]?.[0] ?? '')
      out.push({
        symbol,
        month: label,
        ret: r.returnPct,
        trades: r.trades,
        f: {
          above200: closes[i] > smaAt(closes, i, 200) ? 1 : 0,
          trend100: (closes[i] / smaAt(closes, i, 100) - 1) * 100,
          ddFromPeak: (closes[i] / peak - 1) * 100,
          er30: efficiencyRatio(closes, i, 30),
          chop30: choppiness(c, i, 30),
          adx14: adx(c, i, 14),
          vol30: realisedVol(closes, i, 30),
          volRatio: realisedVol(closes, i, 30) / realisedVol(closes, i, 180),
          breadth: breadthAt(startSec),
          prevRet: prev ? prev.returnPct : NaN
        }
      })
    }
  }
  return out
}

const FEATURES = ['above200', 'trend100', 'ddFromPeak', 'er30', 'chop30', 'adx14', 'vol30', 'volRatio', 'breadth', 'prevRet']
const pct = (v: number, d = 1): string => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) + '%' : '--')

console.log('WHEN THESE STRATEGIES LOSE -- discovery symbols only (' + DISCOVERY.join(', ') + ')')
console.log('Features are computed from daily bars strictly before each month opens.\n')

for (const [id, name] of STRATS) {
  const rows = rowsFor(id, DISCOVERY)
  if (!rows.length) { console.log('## ' + name + ': no rows\n'); continue }
  const rets = rows.map((r) => r.ret)
  console.log('## ' + name + '  (' + rows.length + ' symbol-months, mean ' + pct(mean(rets)) +
    ', median ' + pct(median(rets)) + ', ' + rets.filter((x) => x > 0).length + ' profitable)')

  for (const key of FEATURES) {
    const usable = rows.filter((r) => Number.isFinite(r.f[key]))
    if (usable.length < 20) continue
    // A 0/1 feature has two buckets, not five.
    const distinct = new Set(usable.map((r) => r.f[key]))
    const nb = distinct.size <= 2 ? 2 : 5
    const sorted = [...usable].sort((a, b) => a.f[key] - b.f[key])
    const size = Math.floor(sorted.length / nb)
    const parts: string[] = []
    for (let b = 0; b < nb; b++) {
      const slice = sorted.slice(b * size, b === nb - 1 ? sorted.length : (b + 1) * size)
      const rs = slice.map((x) => x.ret)
      parts.push((pct(mean(rs)) + ' (' + Math.round((rs.filter((x) => x > 0).length / rs.length) * 100) + '%)').padStart(15))
    }
    const lo = mean(sorted.slice(0, size).map((x) => x.ret))
    const hi = mean(sorted.slice(sorted.length - size).map((x) => x.ret))
    console.log('  ' + key.padEnd(11) + parts.join('') + '   spread ' + pct(hi - lo))
  }
  console.log('')
}

console.log('Each cell is the mean month return for that bucket, with the share of profitable months.')
console.log('Buckets run low to high in the feature. "spread" is top bucket minus bottom bucket --')
console.log('a large positive spread means the feature is high when the strategy does well.')
console.log('\nCONFIRMATION SYMBOLS (' + CONFIRM.join(', ') + ') ARE DELIBERATELY NOT SHOWN.')

// ------------------------------------------------------------------ distribution of the two
// indicators that carry published, non-fitted thresholds. Printed so a rule can be written against
// the literature's boundary rather than one fitted to this sample -- and so it is visible whether
// that boundary actually splits the months or just clips a handful.
console.log('\nDISTRIBUTION at the standard thresholds (discovery symbols)')
const probe = rowsFor(STRATS[1][0], DISCOVERY)
for (const [key, label, lo, hi] of [
  ['chop30', 'Choppiness Index', 38.2, 61.8],
  ['adx14', 'ADX(14)', 20, 25]
] as Array<[string, string, number, number]>) {
  const vals = probe.map((r) => r.f[key]).filter(Number.isFinite)
  const below = probe.filter((r) => r.f[key] < lo)
  const above = probe.filter((r) => r.f[key] > hi)
  console.log('  ' + label.padEnd(18) +
    'min ' + Math.min(...vals).toFixed(1) + '  median ' + median(vals).toFixed(1) + '  max ' + Math.max(...vals).toFixed(1))
  console.log('    < ' + lo + ':  ' + String(below.length).padStart(3) + ' months, mean ' + pct(mean(below.map((r) => r.ret))))
  console.log('    > ' + hi + ':  ' + String(above.length).padStart(3) + ' months, mean ' + pct(mean(above.map((r) => r.ret))))
}
