// WHICH CANDLE INTERVAL, SCORED AGAINST THE RULE IN research/INTERVAL.md.
//
// Reads the four dumps written by research/monthiv.ts, one per interval, each covering the SAME
// 65 calendar months (2021-04 -> 2026-08) on the SAME eight symbols. That identity is the whole
// point: comparing an interval measured over one window against an interval measured over another
// compares the windows, not the intervals, and gives the slower bar a different buy-and-hold anchor.
//
// The criterion was fixed before any of this was scored, and is repeated here so the code and the
// pre-registration cannot drift apart:
//
//   rank on MEAN MONTH / SD OF MONTHS, pooled over the four SELECTION symbols and all three
//   strategies; an interval is adopted only if it also finishes top-two on the four CONFIRMATION
//   symbols, which took no part in choosing it. Otherwise 15m stands.
//
// Mean/sd rather than total profit because the ask was "more profit AND less loss", and a total
// answers only the first half -- an interval can win a total while carrying a much fatter tail.
// It is also the column research/gen.mjs already ranks on, so it is not a metric picked to suit
// this result.
//
//   npx esbuild research/interval.ts --bundle --platform=node --format=esm --outfile=research/.interval.mjs
//   node research/.interval.mjs

import { readFileSync } from 'fs'

const IVS = (process.env.IVS || '3m,15m,1h,4h').split(',')
const SELECT = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT']
const CONFIRM = ['BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT']
const STRATS = [
  ['trend-regime-ensemble', 'Trend Regime'],
  ['short-term-channel', 'Short-Term Channel'],
  ['short-term-channel-regime', 'Channel + Regime']
] as const

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
for (const iv of IVS) {
  try {
    dumps.set(iv, JSON.parse(readFileSync('research/.ivdec-' + iv + '.json', 'utf-8')))
  } catch {
    // An interval whose run has not finished is left out rather than scored on partial data.
  }
}
const HAVE = IVS.filter((iv) => dumps.has(iv))
if (!HAVE.length) {
  console.log('no interval dumps found -- run research/monthiv.ts with OUT=research/.ivdec-<iv>.json')
  process.exit(1)
}

function rows(iv: string, symbols: string[], sids: string[]): MonthResult[] {
  const d = dumps.get(iv)
  if (!d) return []
  const out: MonthResult[] = []
  for (const s of symbols) for (const sid of sids) {
    const r = d[s + '|' + sid + '|' + iv]
    if (r) out.push(...r)
  }
  return out
}

interface Stats {
  n: number
  mean: number
  sd: number
  ratio: number
  worst: number
  losses: number
  profit: number
  fees: number
  trades: number
  flat: number
}

function stats(r: MonthResult[]): Stats {
  if (!r.length) return { n: 0, mean: NaN, sd: NaN, ratio: NaN, worst: NaN, losses: 0, profit: 0, fees: 0, trades: NaN, flat: NaN }
  const ret = r.map((m) => m.returnPct)
  const mean = ret.reduce((a, b) => a + b, 0) / ret.length
  // Population sd, not sample: these 260 months are the whole set being described, not a draw
  // from a larger one. With n this large the difference is invisible, but the choice should be
  // deliberate rather than whatever the first formula written happened to be.
  const sd = Math.sqrt(ret.reduce((a, b) => a + (b - mean) ** 2, 0) / ret.length)
  const profits = r.map((m) => m.finalBalance - 10_000)
  return {
    n: r.length,
    mean,
    sd,
    ratio: mean / sd,
    worst: Math.min(...ret),
    losses: profits.filter((p) => p < 0).reduce((a, b) => a + b, 0),
    profit: profits.reduce((a, b) => a + b, 0),
    fees: r.reduce((a, m) => a + m.fees, 0),
    trades: r.reduce((a, m) => a + m.trades, 0) / r.length,
    flat: (r.filter((m) => m.trades === 0).length / r.length) * 100
  }
}

const pc = (v: number): string => (Number.isFinite(v) ? (v >= 0 ? '+' : '') + v.toFixed(2) + '%' : '--')
const dl = (v: number): string => (v < 0 ? '-$' : '$') + Math.round(Math.abs(v)).toLocaleString('en-US')

const ALL_SIDS = STRATS.map((s) => s[0])

function table(title: string, symbols: string[]): void {
  console.log('\n' + title + '  (' + symbols.map((s) => s.replace('USDT', '')).join(' ') + ')')
  console.log(
    'interval'.padEnd(9) + 'months'.padStart(7) + 'mean'.padStart(9) + 'sd'.padStart(9) +
    'mean/sd'.padStart(9) + 'worst'.padStart(9) + 'losses'.padStart(12) + 'profit'.padStart(12) +
    'fees'.padStart(10) + 'trades/mo'.padStart(11) + 'no-trade'.padStart(10)
  )
  console.log('-'.repeat(107))
  for (const iv of HAVE) {
    const s = stats(rows(iv, symbols, ALL_SIDS))
    console.log(
      iv.padEnd(9) + String(s.n).padStart(7) + pc(s.mean).padStart(9) + s.sd.toFixed(2).padStart(9) +
      s.ratio.toFixed(3).padStart(9) + pc(s.worst).padStart(9) + dl(s.losses).padStart(12) +
      dl(s.profit).padStart(12) + dl(s.fees).padStart(10) + s.trades.toFixed(2).padStart(11) +
      (s.flat.toFixed(0) + '%').padStart(10)
    )
  }
}

console.log('CANDLE INTERVAL, DECIDED ON IDENTICAL MONTHS')
console.log('65 independent $10,000 months, 2021-04 -> 2026-08, three strategies pooled')
console.log('intervals present: ' + HAVE.join(', ') + (HAVE.length < IVS.length ? '   (missing: ' + IVS.filter((i) => !dumps.has(i)).join(',') + ')' : ''))

table('SELECTION', SELECT)
table('CONFIRMATION -- took no part in choosing', CONFIRM)
table('ALL EIGHT -- reported, not a criterion', [...SELECT, ...CONFIRM])

// Per strategy, because "one interval for everything" is a conclusion that has to be earned rather
// than assumed. If the three disagree, the answer is per-strategy and the report has to say so.
console.log('\nPER STRATEGY, mean/sd')
console.log('strategy'.padEnd(20) + HAVE.map((iv) => (iv + ' sel').padStart(11)).join('') + '  |' +
  HAVE.map((iv) => (iv + ' cnf').padStart(11)).join(''))
console.log('-'.repeat(20 + HAVE.length * 22 + 3))
for (const [sid, name] of STRATS) {
  const sel = HAVE.map((iv) => stats(rows(iv, SELECT, [sid])).ratio)
  const cnf = HAVE.map((iv) => stats(rows(iv, CONFIRM, [sid])).ratio)
  const mark = (v: number[], i: number): string =>
    (v[i] === Math.max(...v.filter(Number.isFinite)) ? '*' : ' ') + v[i].toFixed(3)
  console.log(
    name.padEnd(20) + sel.map((_, i) => mark(sel, i).padStart(11)).join('') + '  |' +
    cnf.map((_, i) => mark(cnf, i).padStart(11)).join('')
  )
}
console.log('* marks the best interval in each half. A row whose two halves disagree is an interval')
console.log('  that won by chance on the symbols it was chosen on.')

// The pooled table above can hide the answer rather than give it. Three strategies with opposite
// bar-size preferences average to "no difference", which is what the first run of this printed --
// so the per-strategy breakdown is not an afterthought, it is where the result actually lives.
console.log('\nPER STRATEGY IN FULL  (sel = BTC/ETH/SOL/ADA, cnf = BNB/LINK/LTC/XRP)')
for (const [sid, name] of STRATS) {
  console.log('\n' + name)
  console.log(
    '  set/iv'.padEnd(12) + 'mean'.padStart(9) + 'mean/sd'.padStart(9) + 'worst'.padStart(9) +
    'losses'.padStart(12) + 'profit'.padStart(12) + 'fees'.padStart(10) + 'trades/mo'.padStart(11)
  )
  for (const [tag, syms] of [['sel', SELECT], ['cnf', CONFIRM]] as Array<[string, string[]]>) {
    for (const iv of HAVE) {
      const s = stats(rows(iv, syms, [sid]))
      console.log(
        ('  ' + tag + ' ' + iv).padEnd(12) + pc(s.mean).padStart(9) + s.ratio.toFixed(3).padStart(9) +
        pc(s.worst).padStart(9) + dl(s.losses).padStart(12) + dl(s.profit).padStart(12) +
        dl(s.fees).padStart(10) + s.trades.toFixed(2).padStart(11)
      )
    }
  }
}

// The verdict, computed rather than eyeballed, so it cannot drift from what the numbers say.
const selRank = [...HAVE].sort((a, b) => stats(rows(b, SELECT, ALL_SIDS)).ratio - stats(rows(a, SELECT, ALL_SIDS)).ratio)
const cnfRank = [...HAVE].sort((a, b) => stats(rows(b, CONFIRM, ALL_SIDS)).ratio - stats(rows(a, CONFIRM, ALL_SIDS)).ratio)
const winner = selRank[0]
const place = cnfRank.indexOf(winner) + 1

console.log('\nVERDICT (the rule in research/INTERVAL.md, applied literally)')
console.log('  selection order:    ' + selRank.join(' > '))
console.log('  confirmation order: ' + cnfRank.join(' > '))
console.log('  winner on selection: ' + winner + ', which places ' + place + ' of ' + HAVE.length + ' on confirmation')
console.log(
  place <= 2
    ? '  => ADOPT ' + winner + (winner === '15m' ? ' (the incumbent, so nothing changes)' : ' (a change from 15m)')
    : '  => REJECT ' + winner + '; it does not repeat out of sample, so 15m stands'
)
