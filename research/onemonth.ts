// WHAT ONE MONTH ACTUALLY LOOKS LIKE.
//
// The stated goal is short-term profit, judged a month at a time. Every other file here reports
// totals and means over 36 or 48 months, and a mean is a poor description of a distribution this
// skewed: these strategies have a median month of roughly zero and an average carried by a minority
// of large months. Someone deploying $10,000 for ONE month is not going to receive the mean.
//
// So this prints the distribution instead -- percentiles, and the share of months falling into the
// three outcomes an operator actually cares about: a bad loss, nothing at all, and a real gain.
//
// Pooled across both eras (2019-09 to 2023-08 and 2023-09 to 2026-08) and all eight symbols, which
// is ~660 independent symbol-months per strategy. Pooling is legitimate here because nothing is
// being selected: this is a description of results already produced, not a rule being fitted.
//
//   npx esbuild research/onemonth.ts --bundle --platform=node --format=esm --outfile=research/.onemonth.mjs
//   node research/.onemonth.mjs

import { readFileSync } from 'fs'

const DUMPS = (process.env.DUMPS || 'research/.eight.json,research/.early.json').split(',')
const INTERVAL = process.env.INTERVAL || '15m'
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,ADAUSDT,BNBUSDT,LINKUSDT,LTCUSDT,XRPUSDT').split(',')
const STRATS = [
  ['trend-regime-ensemble', 'Trend Regime'],
  ['short-term-channel', 'Short-Term Channel'],
  ['short-term-channel-regime', 'Channel + Regime']
] as const

interface MonthResult { month: string; trades: number; finalBalance: number; returnPct: number }

const loaded = DUMPS.map((f) => {
  try { return JSON.parse(readFileSync(f.trim(), 'utf-8')) as Record<string, MonthResult[]> } catch { return null }
}).filter((x): x is Record<string, MonthResult[]> => x !== null)

if (!loaded.length) {
  console.log('no dumps found -- run research/monthiv.ts first')
  process.exit(1)
}

/** Nearest-rank percentile. No interpolation: with a few hundred points the interpolated value is
 * a number that never occurred, and every figure here is meant to be a month that really happened. */
function pct(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))]
}

const f = (v: number): string => ((v >= 0 ? '+' : '') + v.toFixed(1) + '%').padStart(8)

console.log('ONE INDEPENDENT MONTH, $10,000, at ' + INTERVAL)
console.log(SYMBOLS.length + ' symbols across ' + loaded.length + ' era(s)\n')
console.log('strategy'.padEnd(20) + 'n'.padStart(5) + 'p5'.padStart(8) + 'p25'.padStart(8) +
  'median'.padStart(8) + 'p75'.padStart(8) + 'p95'.padStart(8) + 'mean'.padStart(8) +
  '   lose>10%'.padStart(11) + 'flat'.padStart(7) + 'gain>10%'.padStart(10))
console.log('-'.repeat(101))

for (const [id, name] of STRATS) {
  const rets: number[] = []
  for (const sym of SYMBOLS) {
    for (const d of loaded) {
      const r = d[sym + '|' + id + '|' + INTERVAL]
      if (r) for (const m of r) rets.push(m.returnPct)
    }
  }
  if (!rets.length) continue
  const s = [...rets].sort((a, b) => a - b)
  const share = (n: number): string => (Math.round((n / rets.length) * 100) + '%').padStart(7)
  console.log(
    name.padEnd(20) + String(rets.length).padStart(5) +
    f(pct(s, 0.05)) + f(pct(s, 0.25)) + f(pct(s, 0.5)) + f(pct(s, 0.75)) + f(pct(s, 0.95)) +
    f(rets.reduce((a, b) => a + b, 0) / rets.length) +
    share(rets.filter((x) => x < -10).length).padStart(11) +
    share(rets.filter((x) => Math.abs(x) < 1).length) +
    share(rets.filter((x) => x > 10).length).padStart(10)
  )
}

console.log('\n"flat" is a month that finished within 1% of where it started -- usually no trades at all.')
console.log('Read the median, not the mean: half of all months land below it, and it is roughly zero.')
console.log('The mean is positive because the good months are much larger than the bad ones, not')
console.log('because most months are good. A single month is close to a coin flip with a long right')
console.log('tail; the edge only appears over many of them.')
