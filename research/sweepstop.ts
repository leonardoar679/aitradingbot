// Short-Term Channel has never had a working stop. Does giving it one help?
//
// diag.ts, TRAIN ONLY: of 151 trades across three symbols, ZERO exited on the stop. All 151 ran
// until the channel exit fired, and the worst of them lost 15.9% against a mean loss of 3.8%. The
// shipped stop is `close x 0.5` -- a disaster stop that exists because the engine refuses to open
// a position without one, not because anything chose that level. It is a parameter that has never
// bound, so unlike the entry and exit thresholds it has never been fitted to anything either.
//
// Trend Regime is swept alongside as a control. Its stop DOES fire (9 of 59 trades) and the
// original study found a tighter one reduced returns without improving drawdown, so if this sweep
// is measuring anything real it should reproduce that.
//
// TRAIN ONLY: 2023-09 -> 2025-08. The holdout is scored once, later, and only for whatever
// survives this.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR as string
const BAR = 900
const CAPITAL = 10_000
const FROM = Date.parse('2023-09-01T00:00:00Z') / 1000
const TO = Date.parse('2025-09-01T00:00:00Z') / 1000
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
/** Stop distance below the entry close, in percent. 50% is what ships today. */
const DROPS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 50]

/** Re-registers a strategy with its stop moved, leaving entries and exits untouched, so the sweep
 * measures the stop and nothing else. */
function withStop(base: StrategyDefinition, dropPct: number): string {
  const id = `${base.id}-stop${dropPct}`
  const def: StrategyDefinition = {
    ...base,
    id,
    generateSignals(candles: Candle[]) {
      const s = base.generateSignals(candles)
      return {
        ...s,
        stopPrices: s.stopPrices.map((p, i) => (p === null ? null : candles[i].close * (1 - dropPct / 100)))
      }
    }
  }
  const at = STRATEGIES.findIndex((x) => x.id === id)
  if (at >= 0) STRATEGIES[at] = def
  else STRATEGIES.push(def)
  return id
}

const cache = new Map<string, Candle[]>()
function windowed(symbol: string, def: StrategyDefinition): Candle[] {
  const key = `${symbol}|${def.id}`
  const hit = cache.get(key)
  if (hit) return hit
  const raw = JSON.parse(readFileSync(join(DIR, `${symbol}-15m.json`), 'utf-8')) as number[][]
  const all: Candle[] = raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
  const warmup = def.warmupBarsFor ? def.warmupBarsFor(BAR) : 0
  const first = all.findIndex((c) => c.time >= FROM)
  const last = all.findIndex((c) => c.time >= TO)
  const out = all.slice(Math.max(0, first - warmup), last < 0 ? all.length : last)
  cache.set(key, out)
  return out
}

const n = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`

for (const base of [shortTermChannel, trendRegimeEnsemble]) {
  console.log(`\n\n########## ${base.name} — stop distance — TRAIN 2023-09 → 2025-08, 15m ##########\n`)
  console.log(
    'stop below entry'.padEnd(18) + 'mean net'.padStart(10) + 'worst sym'.padStart(11) +
      'trades'.padStart(8) + 'stopped'.padStart(9) + 'worst DD'.padStart(10) + 'worst trade'.padStart(13) +
      '   ' + SYMBOLS.map((sym) => sym.replace('USDT', '').padStart(12)).join('')
  )
  // Trend Regime's real stop is ATR(14)x10, so its 50% row is a substitute rather than the
  // shipped strategy -- it is here as a control on the sweep, not as its own baseline.
  console.log('-'.repeat(79 + SYMBOLS.length * 12))
  for (const drop of DROPS) {
    const id = withStop(base, drop)
    const nets: number[] = []
    let trades = 0
    let stopped = 0
    let dd = 0
    let worstTrade = 0
    for (const symbol of SYMBOLS) {
      const r = runBacktest(windowed(symbol, base), id, { startingBalance: CAPITAL })
      nets.push(r.stats.totalNetProfitPct)
      trades += r.stats.totalClosedTrades
      stopped += r.trades.filter((t) => t.exitReason === 'stop_loss').length
      dd = Math.min(dd, r.stats.maxDrawdownPct)
      worstTrade = Math.min(worstTrade, ...r.trades.map((t) => t.returnPct))
    }
    const mean = nets.reduce((a, b) => a + b, 0) / nets.length
    console.log(
      `${drop}%${drop === 50 && base.id === shortTermChannel.id ? ' (ships)' : ''}`.padEnd(18) +
        n(mean).padStart(10) + n(Math.min(...nets)).padStart(11) +
        String(trades).padStart(8) + String(stopped).padStart(9) + `${dd.toFixed(1)}%`.padStart(10) +
        `${worstTrade.toFixed(1)}%`.padStart(13) + '   ' +
        SYMBOLS.map((sym, i) => `${sym.replace('USDT', '')} ${n(nets[i])}`.padStart(12)).join('')
    )
  }
}
