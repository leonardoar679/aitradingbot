import { load, register, padWarmup, segment, SPLIT_AT, run, table, type Row } from './harness'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'

const def = STRATEGIES.find((s) => s.id === 'trend-regime-ensemble')!

function monthly(sym: string, interval: string, barsPerDay: number): void {
  const lead = 80 * barsPerDay
  const id = register(padWarmup(def, lead))
  const all = load(sym, interval)
  const r = runBacktest(all, id, { startingBalance: 10_000, forceCloseAtEnd: false })
  const bh = new Map<string, { first: number; last: number }>()
  for (const p of r.benchmarkCurve) {
    const m = new Date(p.time * 1000).toISOString().slice(0, 7)
    const e = bh.get(m)
    if (!e) bh.set(m, { first: p.value, last: p.value })
    else e.last = p.value
  }
  let up = 0, down = 0, flat = 0, beatBh = 0
  const lines: string[] = []
  for (const row of r.monthlyBreakdown) {
    const b = bh.get(row.month)
    const bhPct = b ? ((b.last - b.first) / b.first) * 100 : NaN
    if (Math.abs(row.returnPct) < 0.05) flat++
    else if (row.returnPct > 0) up++
    else down++
    if (row.returnPct > bhPct) beatBh++
    lines.push(
      row.month.padEnd(9) + String(row.trades).padStart(4) +
      row.returnPct.toFixed(2).padStart(10) + '%' + bhPct.toFixed(2).padStart(9) + '%' +
      (row.returnPct > bhPct ? '   +' : '    ')
    )
  }
  console.log(`\n===== ${sym} ${interval} =====`)
  console.log('month     trd   strategy      b&h   beat?')
  for (const l of lines) console.log(l)
  console.log(`up ${up}  down ${down}  flat/cash ${flat}  |  beat b&h in ${beatBh}/${r.monthlyBreakdown.length} months`)
  console.log(`NET ${r.stats.totalNetProfitPct.toFixed(2)}%   maxDD ${r.stats.maxDrawdownPct.toFixed(1)}%   worst losing streak ${r.stats.maxConsecutiveLosingMonths} months`)
  console.log(`position now: ${r.openPositionAtEnd ? 'LONG from ' + (r.openPositionAtEnd as { entryPrice: number }).entryPrice : 'in cash'}`)
}

monthly('BTCUSDT', '15m', 96)
monthly('ETHUSDT', '15m', 96)
monthly('SOLUSDT', '15m', 96)

console.log('\n\n===== HOLDOUT RESCORE (second look -- see caveat) =====')
const rows: Row[] = []
for (const [sym, iv, bpd] of [['BTCUSDT', '15m', 96], ['ETHUSDT', '15m', 96], ['SOLUSDT', '15m', 96], ['BTCUSDT', '3m', 480], ['ETHUSDT', '3m', 480]] as [string, string, number][]) {
  const lead = 80 * bpd
  const id = register(padWarmup(def, lead))
  const all = load(sym, iv)
  rows.push(run(segment(all, SPLIT_AT, Infinity, lead), id, `HOLDOUT ${sym} ${iv}`))
  rows.push(run(all, id, `3 YEARS ${sym} ${iv}`))
}
table(rows)
