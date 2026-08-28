import { load, run, table, segment, SPLIT_AT, register, padWarmup, type Row } from './harness'
import { STRATEGIES } from '../src/backtest/strategies'

const IDS = ['ema-cross-atr-stop', 'rsi-reversion', 'bollinger-breakout', 'trend-regime-ensemble']
const SHORT: Record<string, string> = {
  'ema-cross-atr-stop': 'EMA cross',
  'rsi-reversion': 'RSI reversion',
  'bollinger-breakout': 'Bollinger',
  'trend-regime-ensemble': 'TREND REGIME ENSEMBLE'
}

/** Every strategy padded to the same 80-day warmup, so all of them trade the identical window
 * and are scored against the identical buy & hold. */
function padded(id: string, barsPerDay: number): string {
  const def = STRATEGIES.find((s) => s.id === id)
  if (!def) throw new Error(id)
  return register(padWarmup(def, Math.round(80 * barsPerDay)))
}

function block(title: string, sym: string, interval: string, barsPerDay: number): void {
  const all = load(sym, interval)
  const lead = Math.round(80 * barsPerDay)
  console.log(`\n===== ${title} =====`)
  const rows: Row[] = []
  for (const id of IDS) rows.push(run(segment(all, 0, SPLIT_AT, 0), padded(id, barsPerDay), `TRAIN   ${SHORT[id]}`))
  for (const id of IDS) rows.push(run(segment(all, SPLIT_AT, Infinity, lead), padded(id, barsPerDay), `HOLDOUT ${SHORT[id]}`))
  for (const id of IDS) rows.push(run(all, padded(id, barsPerDay), `3 YEARS ${SHORT[id]}`))
  table(rows)
}

block('BTCUSDT 15m', 'BTCUSDT', '15m', 96)
block('ETHUSDT 15m', 'ETHUSDT', '15m', 96)
block('SOLUSDT 15m', 'SOLUSDT', '15m', 96)
block('BTCUSDT 3m', 'BTCUSDT', '3m', 480)
