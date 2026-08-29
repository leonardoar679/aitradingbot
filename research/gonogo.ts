// SHOULD THIS STRATEGY BE RUNNING THIS MONTH? -- evaluated as an operator would have to.
//
// research/season.ts found that four independent, published indicators agree on a direction that is
// the OPPOSITE of the textbook expectation. A quiet, choppy, weakly-trending prior month predicts a
// GOOD month for these strategies; a strong, efficient, high-ADX prior month predicts a poor one.
// Efficiency Ratio spread -11.8/-12.1/-9.9, Choppiness +9.4/+9.5/+8.9, ADX -9.4/-12.7/-9.1 and the
// strategy's own prior return -9.2/-8.8/-10.7, consistently across all three strategies.
//
// That is not as strange as it first reads. A breakout strategy earns its money when a NEW move
// starts. High ADX means a move is already well underway, so a breakout bought there is bought late;
// low ADX means the market is coiling, which is the classic pre-expansion setup (Crabel's narrow
// range work, Bollinger's squeeze, Minervini's volatility contraction). The finding is that these
// strategies are consolidation-breakout strategies whether or not they were designed as such.
//
// WHY A BLANKET SKIP IS PROBABLY WRONG, STATED BEFORE MEASURING IT. On discovery symbols the
// high-ADX months still average +1.5%. Positive is positive: skipping them removes profit as well as
// risk, so "do not run" is only correct if those months are net NEGATIVE, and the mean says they are
// not. What this file has to establish is whether the mean is honest -- a +1.5% average made of many
// small losses and one enormous winner is a different proposition from a steady +1.5%, and only the
// first would justify sitting out.
//
// NO LOOKAHEAD. Every rule reads only daily bars closing strictly before the month opens. Thresholds
// are the indicators' own published boundaries (Wilder's 20/25 for ADX, Dreiss's 38.2/61.8 for
// Choppiness), never a cut fitted to this sample -- with one exception, marked, which uses an
// EXPANDING median of the symbol's own history so it is computable live and still not fitted.
//
// DISCOVERY FIRST. Running with SET=confirm scores the held-out four instead, and is meant to be run
// ONCE, after a rule has been fixed in writing.

import { readFileSync } from 'fs'
import { join } from 'path'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const DUMP = process.env.IN || 'research/.eight.json'
const INTERVAL = process.env.INTERVAL || '15m'
const SET = process.env.SET || 'discovery'
const CAPITAL = 10_000
const DISCOVERY = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT']
const CONFIRM = ['BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT']
const SYMBOLS = SET === 'confirm' ? CONFIRM : SET === 'all' ? [...DISCOVERY, ...CONFIRM] : DISCOVERY
const STRATS = [
  ['trend-regime-ensemble', 'Trend Regime'],
  ['short-term-channel', 'Short-Term Channel'],
  ['short-term-channel-regime', 'Channel + Regime']
] as const

interface MonthResult { month: string; trades: number; finalBalance: number; returnPct: number }

const load = (s: string): Candle[] =>
  (JSON.parse(readFileSync(join(DIR, s + '-1d.json'), 'utf-8')) as number[][])
    .map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))

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
const median = (v: number[]): number => {
  if (!v.length) return NaN
  const s = [...v].sort((a, b) => a - b)
  const i = s.length >> 1
  return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2
}

function choppiness(c: Candle[], end: number, n: number): number {
  if (end - n < 0) return NaN
  let atr = 0
  let hi = -Infinity
  let lo = Infinity
  for (let i = end - n + 1; i <= end; i++) {
    atr += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    hi = Math.max(hi, c[i].high)
    lo = Math.min(lo, c[i].low)
  }
  return hi - lo <= 0 || atr <= 0 ? NaN : (100 * Math.log10(atr / (hi - lo))) / Math.log10(n)
}

function adx(c: Candle[], end: number, n: number): number {
  const need = 2 * n + 1
  if (end - need < 0) return NaN
  let trS = 0, pdmS = 0, ndmS = 0
  const dxs: number[] = []
  for (let i = end - need + 1; i <= end; i++) {
    const up = c[i].high - c[i - 1].high
    const dn = c[i - 1].low - c[i].low
    const pdm = up > dn && up > 0 ? up : 0
    const ndm = dn > up && dn > 0 ? dn : 0
    trS = trS - trS / n + Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close))
    pdmS = pdmS - pdmS / n + pdm
    ndmS = ndmS - ndmS / n + ndm
    if (trS > 0) {
      const pdi = (100 * pdmS) / trS
      const ndi = (100 * ndmS) / trS
      if (pdi + ndi > 0) dxs.push((100 * Math.abs(pdi - ndi)) / (pdi + ndi))
    }
  }
  return dxs.length >= n ? mean(dxs.slice(-n)) : NaN
}

function efficiency(closes: number[], end: number, n: number): number {
  if (end - n < 0) return NaN
  let path = 0
  for (let i = end - n + 1; i <= end; i++) path += Math.abs(closes[i] - closes[i - 1])
  return path === 0 ? 0 : Math.abs(closes[end] - closes[end - n]) / path
}

interface Ctx { adx14: number; chop30: number; er30: number; erMedianToDate: number; prevRet: number }

const RULES: Array<[string, (x: Ctx) => boolean]> = [
  ['baseline (always run)', () => true],
  ['ADX <= 25  (Wilder)', (x) => x.adx14 <= 25],
  ['ADX <= 20  (Wilder)', (x) => x.adx14 <= 20],
  ['Chop >= 38.2 (Dreiss)', (x) => x.chop30 >= 38.2],
  ['ER below own median', (x) => x.er30 <= x.erMedianToDate],
  ['prev month <= 0', (x) => x.prevRet <= 0],
  ['ADX<=25 AND prev<=0', (x) => x.adx14 <= 25 && x.prevRet <= 0],
  ['ADX<=25 OR prev<=0', (x) => x.adx14 <= 25 || x.prevRet <= 0]
]

const dump = JSON.parse(readFileSync(DUMP, 'utf-8')) as Record<string, MonthResult[]>
const MONTHS = months()

interface Scored { ret: number; profit: number; ctx: Ctx }

function scored(stratId: string): Scored[] {
  const out: Scored[] = []
  for (const symbol of SYMBOLS) {
    let bars: Candle[]
    try { bars = load(symbol) } catch { continue }
    const res = dump[symbol + '|' + stratId + '|' + INTERVAL]
    if (!res) continue
    const byMonth = new Map(res.map((r) => [r.month, r]))
    const closes = bars.map((x) => x.close)
    // Expanding history of the symbol's own ER, so "below its own median" is computable on the day
    // and never uses a value from the future.
    const erHistory: number[] = []
    for (let mi = 0; mi < MONTHS.length; mi++) {
      const [label, startSec] = MONTHS[mi]
      const r = byMonth.get(label)
      if (!r) continue
      let i = -1
      for (let k = 0; k < bars.length; k++) { if (bars[k].time < startSec) i = k; else break }
      if (i < 380) continue
      const er = efficiency(closes, i, 30)
      const erMed = erHistory.length >= 6 ? median(erHistory) : NaN
      erHistory.push(er)
      const prev = byMonth.get(MONTHS[mi - 1]?.[0] ?? '')
      out.push({
        ret: r.returnPct,
        profit: r.finalBalance - CAPITAL,
        ctx: { adx14: adx(bars, i, 14), chop30: choppiness(bars, i, 30), er30: er, erMedianToDate: erMed, prevRet: prev ? prev.returnPct : 0 }
      })
    }
  }
  return out
}

const pct = (v: number, d = 1): string => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(d) + '%' : '--')
const usd = (v: number): string => (v < 0 ? '-' : '+') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US')

console.log('GO / NO-GO, ' + SET.toUpperCase() + ' symbols (' + SYMBOLS.join(', ') + ') at ' + INTERVAL)
console.log('A skipped month contributes exactly $0 -- no position, no fees, no risk.\n')

for (const [id, name] of STRATS) {
  const all = scored(id)
  if (!all.length) continue
  const baseProfit = all.reduce((a, x) => a + x.profit, 0)
  console.log('## ' + name + '   ' + all.length + ' symbol-months')
  console.log('  ' + 'rule'.padEnd(24) + 'run'.padStart(5) + 'total'.padStart(11) + 'vs base'.padStart(10) +
    'mean'.padStart(8) + 'median'.padStart(8) + 'win%'.padStart(6) + 'worst'.padStart(8) + 'sum of losses'.padStart(15))
  console.log('  ' + '-'.repeat(95))
  for (const [label, fn] of RULES) {
    const kept = all.filter((x) => {
      // A rule that cannot be evaluated (an indicator still warming up) must not silently pass.
      try { const v = fn(x.ctx); return typeof v === 'boolean' ? v : false } catch { return false }
    }).filter((x) => Number.isFinite(x.ctx.adx14))
    if (!kept.length) { console.log('  ' + label.padEnd(24) + '   0'); continue }
    const rets = kept.map((x) => x.ret)
    const profit = kept.reduce((a, x) => a + x.profit, 0)
    const losses = kept.filter((x) => x.profit < 0).reduce((a, x) => a + x.profit, 0)
    console.log('  ' + label.padEnd(24) + String(kept.length).padStart(5) +
      usd(profit).padStart(11) + usd(profit - baseProfit).padStart(10) +
      pct(mean(rets)).padStart(8) + pct(median(rets)).padStart(8) +
      (Math.round((rets.filter((x) => x > 0).length / rets.length) * 100) + '%').padStart(6) +
      pct(Math.min(...rets)).padStart(8) + usd(losses).padStart(15))
  }
  console.log('')
}

console.log('"sum of losses" adds up only the losing months -- the number a skip rule is trying to cut.')
console.log('A rule earns its place only if it removes more loss than profit.')
