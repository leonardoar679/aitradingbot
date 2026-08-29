// THE TWO NUMBERS THE MARKET CONDITIONS CARD PRINTS, RECOMPUTED THROUGH THE SHIPPED CODE.
//
// src/backtest/marketConditions.ts hard-codes a baseline mean and a quiet-month mean per strategy.
// Those came out of research/gonogo.ts, which has its OWN Wilder ADX. Two implementations of the
// same indicator sitting either side of a 20 boundary is exactly the setup where a silent
// disagreement changes what a user is told without changing any test -- so this file computes the
// expectations using `readMarketConditions` itself, the function the card calls, and then checks
// that the research ADX agrees with it bar for bar.
//
// It also exists because the interval moved. The shipped numbers were measured at 15m; Trend Regime
// now defaults to 4h (research/INTERVAL.md), and quoting a 15m expectation beside a 4h backtest
// would be a mismatch this change introduced. Each strategy is measured at ITS OWN interval here.
//
// Six symbols that took no part in finding the rule: DOGE, TRX, ETC, XLM, VET, EOS.
//
//   npx esbuild research/expect.ts --bundle --platform=node --format=esm --outfile=research/.expect.mjs
//   node research/.expect.mjs

import { readFileSync } from 'fs'
import { join } from 'path'
import { ADX_PERIOD, ADX_QUIET, MEASURED_EXPECTATIONS, readMarketConditions } from '../src/backtest/marketConditions'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const SYMBOLS = (process.env.SYMBOLS || 'DOGEUSDT,TRXUSDT,ETCUSDT,XLMUSDT,VETUSDT,EOSUSDT').split(',')
const FIRST_YEAR = 2019
const FIRST_MONTH0 = 8
const COUNT = 84

/** Each strategy at the interval it is actually shipped to run on, and the dump that holds it. */
const AT: Array<[string, string, string[]]> = [
  ['trend-regime-ensemble', '4h', ['research/.adx4h.json']],
  ['short-term-channel', '15m', ['research/.new-early.json', 'research/.new-late.json']],
  ['short-term-channel-regime', '15m', ['research/.new-early.json', 'research/.new-late.json']]
]

interface MonthResult { month: string; returnPct: number; finalBalance: number }

const daily = new Map<string, Candle[]>()
function load(s: string): Candle[] | null {
  const hit = daily.get(s)
  if (hit) return hit
  try {
    const rows = JSON.parse(readFileSync(join(DIR, s + '-1d.json'), 'utf-8')) as number[][]
    const out = rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
    daily.set(s, out)
    return out
  } catch {
    return null
  }
}

/** research/gonogo.ts's own ADX, copied verbatim so the two can be compared rather than trusted. */
function researchAdx(c: Candle[], end: number, n: number): number {
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
  return dxs.length >= n ? dxs.slice(-n).reduce((a, b) => a + b, 0) / n : NaN
}

function monthStarts(): Array<[string, number]> {
  const out: Array<[string, number]> = []
  for (let i = 0; i < COUNT; i++) {
    const y = FIRST_YEAR + Math.floor((FIRST_MONTH0 + i) / 12)
    const m = (FIRST_MONTH0 + i) % 12
    out.push([`${y}-${String(m + 1).padStart(2, '0')}`, Date.UTC(y, m, 1) / 1000])
  }
  return out
}

const MONTHS = monthStarts()
const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN)

let compared = 0
let worstDelta = 0

console.log('EXPECTATIONS FOR THE MARKET CONDITIONS CARD, EACH STRATEGY AT ITS OWN INTERVAL')
console.log(SYMBOLS.length + ' held-out symbols, ' + COUNT + ' months from ' +
  FIRST_YEAR + '-' + String(FIRST_MONTH0 + 1).padStart(2, '0') + ', ADX(' + ADX_PERIOD + ') <= ' + ADX_QUIET + '\n')
console.log('strategy'.padEnd(28) + 'iv'.padStart(5) + 'months'.padStart(8) + 'baseline'.padStart(10) +
  'quiet n'.padStart(9) + 'quiet mean'.padStart(12) + 'losses base'.padStart(14) + 'losses quiet'.padStart(14) +
  'win base'.padStart(10) + 'win quiet'.padStart(11))
console.log('-'.repeat(121))

const fresh: Array<[string, number, number]> = []

for (const [sid, iv, files] of AT) {
  const dumps = files.map((f) => {
    try { return JSON.parse(readFileSync(f, 'utf-8')) as Record<string, MonthResult[]> } catch { return null }
  }).filter((x): x is Record<string, MonthResult[]> => x !== null)
  if (!dumps.length) { console.log(sid.padEnd(28) + '  no dump'); continue }

  const all: number[] = []
  const quiet: number[] = []
  const allP: number[] = []
  const quietP: number[] = []

  for (const sym of SYMBOLS) {
    const bars = load(sym)
    if (!bars) continue
    const rows = new Map<string, MonthResult>()
    for (const d of dumps) for (const r of d[sym + '|' + sid + '|' + iv] ?? []) rows.set(r.month, r)

    for (const [label, startSec] of MONTHS) {
      const r = rows.get(label)
      if (!r) continue
      // Strictly before the 1st: the last daily bar that had closed when the decision was made.
      let end = -1
      for (let i = 0; i < bars.length; i++) { if (bars[i].time < startSec) end = i; else break }
      if (end < 0) continue

      const shipped = readMarketConditions(bars.slice(0, end + 1), sid).adx
      const research = researchAdx(bars, end, ADX_PERIOD)
      if (Number.isFinite(shipped) && Number.isFinite(research)) {
        compared++
        worstDelta = Math.max(worstDelta, Math.abs(shipped - research))
      }

      // A month with no ADX reading is one the card cannot speak about either way, so it belongs
      // in NEITHER group. Counting it in the baseline but not in the quiet subset would compare
      // two different populations and shift the baseline by whatever those early months did.
      if (!Number.isFinite(shipped)) continue
      all.push(r.returnPct)
      allP.push(r.finalBalance - 10_000)
      if (shipped <= ADX_QUIET) {
        quiet.push(r.returnPct)
        quietP.push(r.finalBalance - 10_000)
      }
    }
  }

  const lossOf = (p: number[]): number => p.filter((x) => x < 0).reduce((a, b) => a + b, 0)
  const winOf = (v: number[]): number => (v.filter((x) => x > 0).length / v.length) * 100
  const b = mean(all)
  const q = mean(quiet)
  fresh.push([sid, b, q])
  console.log(
    sid.padEnd(28) + iv.padStart(5) + String(all.length).padStart(8) +
    ('+' + b.toFixed(2) + '%').padStart(10) + String(quiet.length).padStart(9) +
    ('+' + q.toFixed(2) + '%').padStart(12) +
    ('-$' + Math.round(-lossOf(allP)).toLocaleString('en-US')).padStart(14) +
    ('-$' + Math.round(-lossOf(quietP)).toLocaleString('en-US')).padStart(14) +
    (winOf(all).toFixed(0) + '%').padStart(10) + (winOf(quiet).toFixed(0) + '%').padStart(11)
  )
}

console.log('\nADX AGREEMENT: shipped readMarketConditions vs research/gonogo.ts')
console.log('  ' + compared.toLocaleString('en-US') + ' month-decisions compared, worst absolute difference ' + worstDelta.toExponential(2))
console.log(worstDelta < 1e-9
  ? '  => identical. The card computes the same number the research selected on.'
  : '  => THEY DISAGREE. The card is not showing what was measured; fix before shipping.')

console.log('\nAGAINST WHAT IS CURRENTLY SHIPPED in src/backtest/marketConditions.ts')
for (const [sid, b, q] of fresh) {
  const cur = MEASURED_EXPECTATIONS.find((e) => e.strategyId === sid)
  if (!cur) { console.log('  ' + sid + ': not in MEASURED_EXPECTATIONS'); continue }
  const same = Math.abs(cur.baselineMeanPct - Number(b.toFixed(2))) < 0.005 &&
    Math.abs(cur.quietMeanPct - Number(q.toFixed(2))) < 0.005
  console.log('  ' + sid.padEnd(28) + 'shipped ' + cur.baselineMeanPct.toFixed(2) + ' / ' + cur.quietMeanPct.toFixed(2) +
    '   measured ' + b.toFixed(2) + ' / ' + q.toFixed(2) + (same ? '   ok' : '   NEEDS UPDATE'))
}
