// WHAT THE THREE STRATEGIES DO AS THEY SHIP, AND WHAT SIMPLY HOLDING DOES OVER THE SAME MONTHS.
//
// Every other table in this repository compares strategies to each other, or one strategy to itself
// at a different bar size. Both are useful and neither answers the question a person deploying
// $10,000 actually has, which is whether running any of this beats buying the coin and waiting.
// This file asks that, at the intervals the strategies now ship on rather than at one interval
// chosen to make them comparable:
//
//   Trend Regime Ensemble        -> 4h   (moved there by research/interval.ts)
//   Short-Term Channel           -> 15m
//   Short-Term Channel + Regime  -> 15m
//
// THE INTERVALS ARE READ FROM THE STRATEGY DEFINITIONS, not written down here. A constant copied
// into a research script is a constant that goes stale the day someone edits the strategy, and this
// script would then keep printing confident numbers for a configuration that no longer ships.
//
// The buy-and-hold anchor is the one research/monthiv.ts recorded per month: first close to last
// close over THE SAME BARS the strategy traded that month. So it is not the coin's calendar-month
// return from some other source -- it is the alternative that was genuinely available inside each
// run, which is the only version of the comparison that means anything.
//
//   npx esbuild research/shipped.ts --bundle --platform=node --format=esm --outfile=research/.shipped.mjs
//   node research/.shipped.mjs

import { readFileSync } from 'fs'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { shortTermChannelRegime } from '../src/backtest/strategies/shortTermChannelRegime'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition } from '../src/backtest/strategies/types'

const SELECT = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT']
const CONFIRM = ['BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT']
const SYMBOLS = [...SELECT, ...CONFIRM]

/** The two strongest columns in the by-symbol table. Named as a fixed pair rather than computed as
 *  "whichever two are best", which would guarantee a large drop on any set of numbers at all. */
const TOP2 = ['SOLUSDT', 'XRPUSDT']

const DEFS: StrategyDefinition[] = [trendRegimeEnsemble, shortTermChannel, shortTermChannelRegime]

interface MonthResult {
  month: string
  trades: number
  finalBalance: number
  returnPct: number
  maxDrawdownPct: number
  fees: number
  bhPct: number
}

const dumps = new Map<string, Record<string, MonthResult[]>>()
function dump(iv: string): Record<string, MonthResult[]> {
  const hit = dumps.get(iv)
  if (hit) return hit
  const d = JSON.parse(readFileSync('research/.ivdec-' + iv + '.json', 'utf-8')) as Record<string, MonthResult[]>
  dumps.set(iv, d)
  return d
}

function rows(def: StrategyDefinition, symbols: string[]): MonthResult[] {
  const iv = def.preferredInterval
  if (!iv) throw new Error(def.id + ' declares no preferredInterval; there is no shipped bar size to score')
  const d = dump(iv)
  const out: MonthResult[] = []
  for (const s of symbols) {
    const r = d[s + '|' + def.id + '|' + iv]
    if (!r) throw new Error('no months for ' + s + '|' + def.id + '|' + iv + ' -- rerun research/monthiv.ts')
    out.push(...r)
  }
  return out
}

const avg = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length
/** Population sd, matching research/interval.ts: these months are the whole set being described,
 *  not a sample of a larger one. The two files get cross-checked against each other, so the choice
 *  has to be the same in both. */
const sdev = (v: number[]): number => {
  const m = avg(v)
  return Math.sqrt(avg(v.map((x) => (x - m) ** 2)))
}
function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  const h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

interface Stats {
  n: number
  mean: number
  median: number
  sd: number
  ratio: number
  worst: number
  best: number
  profit: number
  losses: number
  lose10: number
  flat: number
}

function stats(r: MonthResult[]): Stats {
  const ret = r.map((m) => m.returnPct)
  const gain = r.map((m) => m.finalBalance - 10_000)
  const s = sdev(ret)
  return {
    n: r.length,
    mean: avg(ret),
    median: median(ret),
    sd: s,
    ratio: avg(ret) / s,
    worst: Math.min(...ret),
    best: Math.max(...ret),
    profit: gain.reduce((a, b) => a + b, 0),
    losses: gain.filter((g) => g < 0).reduce((a, b) => a + b, 0),
    lose10: (ret.filter((x) => x < -10).length / ret.length) * 100,
    flat: (r.filter((m) => m.trades === 0).length / r.length) * 100
  }
}

/** Buy-and-hold over the identical months, from the per-month anchor the run recorded. */
function hold(r: MonthResult[]): { mean: number; sd: number; ratio: number; worst: number } {
  const bh = r.map((m) => m.bhPct)
  const s = sdev(bh)
  return { mean: avg(bh), sd: s, ratio: avg(bh) / s, worst: Math.min(...bh) }
}

const pc = (v: number, d = 2): string => (v >= 0 ? '+' : '') + v.toFixed(d) + '%'
const dl = (v: number): string => (v < 0 ? '-$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US')
const nm = (d: StrategyDefinition): string => d.name + ' (' + d.preferredInterval + ')'

const ALL = DEFS.map((d) => ({ def: d, r: rows(d, SYMBOLS) }))

console.log('THE SHIPPED CONFIGURATION, EACH STRATEGY AT ITS OWN BAR SIZE')
console.log('65 independent $10,000 months x 8 symbols, 2021-04 -> 2026-08')
console.log(
  'intervals read from the strategy definitions: ' +
    DEFS.map((d) => d.id + '=' + d.preferredInterval).join(', ')
)

console.log('\nTHE MONTH DISTRIBUTION')
console.log(
  'strategy'.padEnd(40) +
    'months'.padStart(7) +
    'mean'.padStart(9) +
    'median'.padStart(9) +
    'sd'.padStart(8) +
    'mean/sd'.padStart(9) +
    'worst'.padStart(9) +
    'best'.padStart(10) +
    'profit'.padStart(12) +
    'losses'.padStart(12) +
    'lose>10%'.padStart(10) +
    'flat'.padStart(7)
)
console.log('-'.repeat(142))
for (const { def, r } of ALL) {
  const s = stats(r)
  console.log(
    nm(def).padEnd(40) +
      String(s.n).padStart(7) +
      pc(s.mean).padStart(9) +
      pc(s.median).padStart(9) +
      s.sd.toFixed(1).padStart(8) +
      s.ratio.toFixed(3).padStart(9) +
      pc(s.worst, 1).padStart(9) +
      pc(s.best, 1).padStart(10) +
      dl(s.profit).padStart(12) +
      dl(s.losses).padStart(12) +
      (s.lose10.toFixed(0) + '%').padStart(10) +
      (s.flat.toFixed(0) + '%').padStart(7)
  )
}

// The comparison the rest of the repository does not make, and the least flattering one here.
console.log('\nAGAINST SIMPLY HOLDING THE SAME COIN OVER THE SAME MONTHS')
console.log(
  'strategy'.padEnd(40) +
    'mean'.padStart(9) +
    'bh mean'.padStart(9) +
    'sd'.padStart(8) +
    'bh sd'.padStart(8) +
    'mean/sd'.padStart(9) +
    'bh m/sd'.padStart(9) +
    'worst'.padStart(9) +
    'bh worst'.padStart(10) +
    'beats bh on'.padStart(13)
)
console.log('-'.repeat(124))
for (const { def, r } of ALL) {
  const s = stats(r)
  const h = hold(r)
  const beats = SYMBOLS.filter((sym) => {
    const one = rows(def, [sym])
    return avg(one.map((m) => m.returnPct)) > avg(one.map((m) => m.bhPct))
  }).length
  console.log(
    nm(def).padEnd(40) +
      pc(s.mean).padStart(9) +
      pc(h.mean).padStart(9) +
      s.sd.toFixed(1).padStart(8) +
      h.sd.toFixed(1).padStart(8) +
      s.ratio.toFixed(3).padStart(9) +
      h.ratio.toFixed(3).padStart(9) +
      pc(s.worst, 1).padStart(9) +
      pc(h.worst, 1).padStart(10) +
      (beats + ' of 8').padStart(13)
  )
}

// A mean over eight symbols can be one or two good columns. Whether it is has to be measured, and
// the pair removed below has to be visibly the top pair rather than asserted to be.
console.log('\nBY SYMBOL, MEAN MONTH  (* marks the pair removed in the next table)')
console.log(
  'strategy'.padEnd(40) + SYMBOLS.map((s) => (s.replace('USDT', '') + (TOP2.includes(s) ? '*' : '')).padStart(9)).join('')
)
console.log('-'.repeat(112))
for (const { def } of ALL) {
  console.log(
    nm(def).padEnd(40) +
      SYMBOLS.map((s) => pc(stats(rows(def, [s])).mean, 1).padStart(9)).join('')
  )
}
// One holding row per interval, not one for the table. The bar sizes do not cover quite the same
// bars, so they do not hand the strategy quite the same coin to beat -- printing a single anchor
// would score the 15m strategies against the 4h months by accident.
for (const iv of [...new Set(DEFS.map((d) => d.preferredInterval))]) {
  const def = DEFS.find((d) => d.preferredInterval === iv) as StrategyDefinition
  console.log(
    ('holding, over the ' + iv + ' months').padEnd(40) +
      SYMBOLS.map((s) => pc(avg(rows(def, [s]).map((m) => m.bhPct)), 1).padStart(9)).join('')
  )
}

const REST = SYMBOLS.filter((s) => !TOP2.includes(s))
console.log(
  '\nWITH ' +
    TOP2.map((s) => s.replace('USDT', '')).join(' AND ') +
    ' REMOVED  (' +
    REST.map((s) => s.replace('USDT', '')).join(' ') +
    ')'
)
console.log(
  'strategy'.padEnd(40) +
    'mean, 8'.padStart(9) +
    'mean, 6'.padStart(9) +
    'change'.padStart(9) +
    'mean/sd'.padStart(9) +
    'profit, 8'.padStart(12) +
    'profit, 6'.padStart(12)
)
console.log('-'.repeat(100))
for (const { def, r } of ALL) {
  const all = stats(r)
  const ex = stats(rows(def, REST))
  console.log(
    nm(def).padEnd(40) +
      pc(all.mean).padStart(9) +
      pc(ex.mean).padStart(9) +
      ('-' + Math.round((1 - ex.mean / all.mean) * 100) + '%').padStart(9) +
      ex.ratio.toFixed(3).padStart(9) +
      dl(all.profit).padStart(12) +
      dl(ex.profit).padStart(12)
  )
}

// Ranking on all eight is partly in-sample: four of those symbols chose the bar size. The four that
// took no part in choosing are the only ones that can rank the three strategies against each other.
console.log(
  '\nRANKED ON THE FOUR HELD-OUT SYMBOLS  (' + CONFIRM.map((s) => s.replace('USDT', '')).join(' ') + ')'
)
console.log(
  'strategy'.padEnd(40) +
    'mean'.padStart(9) +
    'mean/sd'.padStart(9) +
    'worst'.padStart(9) +
    'profit'.padStart(12) +
    'losses'.padStart(12)
)
console.log('-'.repeat(91))
const held = ALL.map((a) => ({ def: a.def, s: stats(rows(a.def, CONFIRM)) }))
for (const h of [...held].sort((a, b) => b.s.ratio - a.s.ratio)) {
  console.log(
    nm(h.def).padEnd(40) +
      pc(h.s.mean).padStart(9) +
      h.s.ratio.toFixed(3).padStart(9) +
      pc(h.s.worst, 1).padStart(9) +
      dl(h.s.profit).padStart(12) +
      dl(h.s.losses).padStart(12)
  )
}

// Stated by the code rather than by a sentence underneath it, so the two cannot disagree later.
const mostMoney = [...held].sort((a, b) => b.s.profit - a.s.profit)[0]
const leastLoss = [...held].sort((a, b) => b.s.losses - a.s.losses)[0]
console.log('\nHELD-OUT VERDICT')
console.log('  most money:      ' + nm(mostMoney.def) + '  ' + dl(mostMoney.s.profit))
console.log('  smallest losses: ' + nm(leastLoss.def) + '  ' + dl(leastLoss.s.losses))
console.log(
  mostMoney.def.id === leastLoss.def.id
    ? '  => one strategy wins both'
    : '  => nothing wins both; the two questions have different answers'
)
