// WHEN DO THESE STRATEGIES LOSE? WHEN THE MARKET DOES NOT RISE. THAT IS THE WHOLE ANSWER.
//
// research/season.ts, gonogo.ts, PRIORMONTH.md and ADX.md all tried to predict a bad month from
// market-condition indicators measured before it started, and all of them failed out of sample.
// This file explains why they were always going to.
//
// Bucketing every independent month by what BUY AND HOLD did in that same month makes the structure
// obvious: these strategies are long-only trend and breakout systems, they are 0.80-0.89 correlated
// with simply holding the coin, and their monthly result is very nearly a function of the market's
// direction that month. Predicting when they lose therefore requires predicting next month's market
// direction -- which is not a strategy-tuning problem, it is the hardest open problem in the field,
// and no arrangement of ADX and the Choppiness Index is going to solve it.
//
// TWO NUMBERS ARE WORTH MORE THAN THE REST.
//
// Trend Regime was profitable in ONE of the 323 months where buy and hold was negative. Not a
// tendency -- essentially never. It does not make money in falling markets; it loses less, which is
// a different and much smaller claim than the strategy's own README used to imply.
//
// And all three lose money on average even when the market rises between 0% and 10%. They need a
// STRONG up-month, not merely a positive one: the mean is carried by the months holding gained more
// than 20%, which is 141 of 658.
//
// WHAT THAT MAKES THEM. Not all-weather systems, and not market-neutral. They are long crypto with
// the shape changed: roughly half the upside, roughly a third of the downside. The capture ratio is
// the honest measure of whether that trade is worth making, and it is where the gated strategy is
// clearly best -- 36% up against 21% down, a ratio of 1.7, against Trend Regime's 1.4.
//
//   npx esbuild research/beta.ts --bundle --platform=node --format=esm --outfile=research/.beta.mjs
//   node research/.beta.mjs

import { readFileSync } from 'fs'

const DUMPS = (process.env.DUMPS || 'research/.eight.json,research/.early.json').split(',')
const INTERVAL = process.env.INTERVAL || '15m'
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,ADAUSDT,BNBUSDT,LINKUSDT,LTCUSDT,XRPUSDT').split(',')
const STRATS = [
  ['trend-regime-ensemble', 'Trend Regime'],
  ['short-term-channel', 'Short-Term Channel'],
  ['short-term-channel-regime', 'Channel + Regime']
] as const

/** bhPct is the same calendar month held in spot, measured over the identical bars the strategy
 * traded -- written by research/monthiv.ts alongside the strategy's own result, so the two can
 * never be misaligned by a different window. */
interface MonthResult { month: string; trades: number; finalBalance: number; returnPct: number; bhPct: number }

const dumps = DUMPS.map((f) => {
  try { return JSON.parse(readFileSync(f.trim(), 'utf-8')) as Record<string, MonthResult[]> } catch { return null }
}).filter((x): x is Record<string, MonthResult[]> => x !== null)

if (!dumps.length) { console.log('no dumps found -- run research/monthiv.ts first'); process.exit(1) }

const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN)
const pctOf = (v: number): string => ((v >= 0 ? '+' : '') + v.toFixed(1) + '%')

function rowsFor(id: string): MonthResult[] {
  const out: MonthResult[] = []
  for (const s of SYMBOLS) for (const d of dumps) {
    const r = d[s + '|' + id + '|' + INTERVAL]
    if (r) out.push(...r)
  }
  return out.filter((r) => Number.isFinite(r.bhPct))
}

const BUCKETS: Array<[string, number, number]> = [
  ['bh < -20%', -Infinity, -20],
  ['-20..-10', -20, -10],
  ['-10..0', -10, 0],
  ['0..+10', 0, 10],
  ['+10..+20', 10, 20],
  ['bh > +20%', 20, Infinity]
]

console.log('STRATEGY MONTH, BUCKETED BY WHAT HOLDING THE COIN DID THAT MONTH')
console.log(SYMBOLS.length + ' symbols, ' + dumps.length + ' era(s), independent $10,000 months at ' + INTERVAL + '\n')
console.log('strategy'.padEnd(19) + BUCKETS.map((b) => b[0].padStart(13)).join(''))
console.log('-'.repeat(19 + 13 * BUCKETS.length))
for (const [id, name] of STRATS) {
  const rows = rowsFor(id)
  if (!rows.length) continue
  console.log(name.padEnd(19) + BUCKETS.map(([, lo, hi]) => {
    const g = rows.filter((r) => r.bhPct > lo && r.bhPct <= hi)
    return (g.length ? pctOf(mean(g.map((r) => r.returnPct))) + ' (' + g.length + ')' : '--').padStart(13)
  }).join(''))
}

console.log('\nCORRELATION AND CAPTURE')
console.log('strategy'.padEnd(19) + 'corr'.padStart(6) + 'up capture'.padStart(12) +
  'down capture'.padStart(14) + 'ratio'.padStart(8) + '   profitable when bh < 0')
console.log('-'.repeat(19 + 6 + 12 + 14 + 8 + 26))
for (const [id, name] of STRATS) {
  const rows = rowsFor(id)
  if (!rows.length) continue
  const x = rows.map((r) => r.bhPct)
  const y = rows.map((r) => r.returnPct)
  const mx = mean(x)
  const my = mean(y)
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < x.length; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2 }
  const up = rows.filter((r) => r.bhPct > 0)
  const dn = rows.filter((r) => r.bhPct < 0)
  const upCap = (mean(up.map((r) => r.returnPct)) / mean(up.map((r) => r.bhPct))) * 100
  const dnCap = (mean(dn.map((r) => r.returnPct)) / mean(dn.map((r) => r.bhPct))) * 100
  const wins = dn.filter((r) => r.returnPct > 0).length
  console.log(
    name.padEnd(19) + (num / Math.sqrt(dx * dy)).toFixed(2).padStart(6) +
    (upCap.toFixed(0) + '%').padStart(12) + (dnCap.toFixed(0) + '%').padStart(14) +
    (upCap / dnCap).toFixed(2).padStart(8) +
    ('   ' + wins + ' of ' + dn.length + '  (' + Math.round((wins / dn.length) * 100) + '%)').padStart(26)
  )
}

console.log('\nup/down capture is the mean strategy month divided by the mean buy-and-hold month,')
console.log('taken over rising and falling months separately. The RATIO is the point: above 1.0 means')
console.log('the strategy keeps more of the upside than it does of the downside, which is the only')
console.log('reason to run it instead of simply holding.')
console.log('\n"profitable when bh < 0" is how often the strategy made money in a falling month.')
console.log('For Trend Regime this is essentially never. It does not profit from falling markets --')
console.log('it sits out of them, which is a much smaller claim and the correct one.')
