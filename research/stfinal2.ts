import { runBacktest } from '../src/backtest/engine'
import type { Candle } from '../shared/ipc'
import { load, segment, run, table, padWarmup, register, type Row } from './harness'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'

const DAY = 86_400
const TRAIN_FROM = Date.parse('2023-08-27T00:00:00Z') / 1000
const END = Date.parse('2026-08-27T00:00:00Z') / 1000
const lead = (bs: number, d: number) => Math.round((d * DAY) / bs) + 2

console.log('########## 4. TRUE OOS 2017-2023: short-term vs the shipped slow strategy ##########')
console.log('Both padded to an 81-day lead so they trade the identical window against the same b&h.\n')
for (const sym of ['BTCUSDT', 'ETHUSDT']) {
  for (const [tf, bs] of [['1h', 3600], ['4h', 14400]] as Array<[string, number]>) {
    let all: Candle[]
    try { all = load(sym, tf) } catch { continue }
    const L = lead(bs, 81)
    const shortId = register(padWarmup(shortTermChannel, L))
    const slowId = register(padWarmup(trendRegimeEnsemble, L))
    const rows: Row[] = []
    const eras: Array<[string, string, string]> = [
      ['2017-08>2019-01 bear', '2017-08-17', '2019-01-01'],
      ['2019-01>2020-03 chop', '2019-01-01', '2020-03-01'],
      ['2020-03>2021-12 bull', '2020-03-01', '2021-12-01'],
      ['2021-12>2023-08 bear', '2021-12-01', '2023-08-27'],
      ['2017-08>2023-08 ALL ', '2017-08-17', '2023-08-27']
    ]
    for (const [label, a, b] of eras) {
      const cs = segment(all, Date.parse(a + 'T00:00:00Z') / 1000, Date.parse(b + 'T00:00:00Z') / 1000, L)
      if (cs.length < L * 3) continue
      rows.push(run(cs, shortId, `${label}  SHORT`))
      rows.push(run(cs, slowId, `${label}  slow `))
    }
    if (rows.length) { console.log(`\n--- ${sym} ${tf} ---`); table(rows) }
  }
}

console.log('\n\n########## 5. MONTH BY MONTH, 3 years, BTCUSDT 15m ##########\n')
{
  const all = load('BTCUSDT', '15m')
  const L = lead(900, 9)
  const id = register(padWarmup(shortTermChannel, L))
  const cs = segment(all, TRAIN_FROM, END, L)
  const r = runBacktest(cs, id, { startingBalance: 10_000, leverage: 1 })
  let up = 0, down = 0, flat = 0
  const line: string[] = []
  for (const m of r.monthlyBreakdown) {
    if (m.trades === 0 && Math.abs(m.netProfit) < 1e-6) flat++
    else if (m.netProfit > 0) up++
    else down++
    line.push(`${m.month} ${m.returnPct >= 0 ? '+' : ''}${m.returnPct.toFixed(1)}%`)
  }
  for (let i = 0; i < line.length; i += 6) console.log('  ' + line.slice(i, i + 6).map((s) => s.padEnd(16)).join(''))
  console.log(`\n  up ${up} / down ${down} / flat ${flat}   total net ${r.stats.totalNetProfitPct.toFixed(1)}%`)
  const sorted = [...r.monthlyBreakdown].sort((a, b) => b.netProfit - a.netProfit)
  const totalProfit = sorted.filter((m) => m.netProfit > 0).reduce((s, m) => s + m.netProfit, 0)
  console.log(`  best month $${sorted[0].netProfit.toFixed(0)} (${sorted[0].month}); top 3 = ${((sorted.slice(0, 3).reduce((s, m) => s + m.netProfit, 0) / totalProfit) * 100).toFixed(0)}% of all gains`)
  console.log(`  worst month $${sorted[sorted.length - 1].netProfit.toFixed(0)} (${sorted[sorted.length - 1].month})`)
}

console.log('\n\n########## 6. VARIOUS TIMESPANS: every rolling 6-month window over 3 years ##########')
for (const [sym, tf, bs] of [['BTCUSDT', '15m', 900], ['ETHUSDT', '15m', 900], ['SOLUSDT', '15m', 900]] as Array<[string, string, number]>) {
  const all = load(sym, tf)
  const L = lead(bs, 9)
  const id = register(padWarmup(shortTermChannel, L))
  const rows: Row[] = []
  for (let m = 0; m + 6 <= 36; m += 3) {
    const a = new Date(Date.UTC(2023, 7 + m, 27)).getTime() / 1000
    const b = new Date(Date.UTC(2023, 7 + m + 6, 27)).getTime() / 1000
    const cs = segment(all, a, b, L)
    if (cs.length < L * 3) continue
    const lbl = new Date(a * 1000).toISOString().slice(0, 7) + '>' + new Date(b * 1000).toISOString().slice(0, 7)
    rows.push(run(cs, id, lbl))
  }
  const wins = rows.filter((r) => r.netPct > 0).length
  const beat = rows.filter((r) => r.netPct > r.bhPct).length
  console.log(`\n--- ${sym} ${tf}: ${wins}/${rows.length} windows profitable, ${beat}/${rows.length} beat buy & hold ---`)
  table(rows)
}

console.log('\n\n########## 7. STARTING BALANCE ##########')
{
  const all = load('BTCUSDT', '15m')
  const L = lead(900, 9)
  const id = register(padWarmup(shortTermChannel, L))
  const cs = segment(all, TRAIN_FROM, END, L)
  for (const bal of [10_000, 50_000, 100_000, 1_000_000]) {
    const r = runBacktest(cs, id, { startingBalance: bal, leverage: 1 })
    console.log(`  $${bal.toLocaleString().padStart(9)} start -> $${r.stats.finishingBalance.toFixed(0).padStart(10)}  net ${r.stats.totalNetProfitPct.toFixed(2)}%  fees $${r.stats.totalPaidFees.toFixed(0)}`)
  }
  console.log('  (identical percentages confirm no position-size effect: the engine is all-in, and')
  console.log('   market impact is not modelled -- a real $1M order would not fill like this.)')
}
