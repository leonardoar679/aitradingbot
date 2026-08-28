import { load, run, table, segment, SPLIT_AT, type Row } from './harness'

const LEAD = 250
const rows: Row[] = []
for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']) {
  const all = load(sym, '15m')
  for (const id of ['ema-cross-atr-stop', 'rsi-reversion', 'bollinger-breakout']) {
    rows.push(run(all, id, `${sym} 15m  ${id}`))
  }
  rows.push({ label: '', netPct: NaN, bhPct: NaN, trades: 0, winPct: NaN, maxDdPct: NaN, sharpe: NaN, profitFactor: NaN, feesPaid: NaN })
}
table(rows.filter((r) => r.label !== ''))
console.log('\n--- train (2023-08 -> 2025-08) vs holdout (2025-08 -> 2026-08), BTCUSDT 15m ---')
const btc = load('BTCUSDT', '15m')
const trainRows: Row[] = []
for (const id of ['ema-cross-atr-stop', 'rsi-reversion', 'bollinger-breakout']) {
  trainRows.push(run(segment(btc, 0, SPLIT_AT, 0), id, `TRAIN  ${id}`))
  trainRows.push(run(segment(btc, SPLIT_AT, Infinity, LEAD), id, `HOLD   ${id}`))
}
table(trainRows)
