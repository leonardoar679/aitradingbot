// Does sitting out for a while after an exit help? Swept on TRAIN ONLY: 2023-09 -> 2025-08.
//
// diag.ts measured the problem: both strategies keep about 40% of the peak gain their winners
// reach, and roughly half their losing trades had been up more than 3% before rolling over. This
// sweeps the obvious response -- exit when a won gain drains away -- across the two parameters
// that define it, and it is set up so that a good-looking cell is not enough to adopt.
//
// THE TRAP THIS IS BUILT TO AVOID. diag.ts also measured that profit is brutally concentrated:
// for Trend Regime the best 3 trades out of 59 are 53% of gross profit. A give-back rule that
// clips one of those three ruins the strategy no matter how many small round trips it rescues. So
// the grid reports the return AND the trade count AND how the worst symbol did, and the pick has
// to hold up across all three symbols rather than winning on average.
//
// The 2025-09 -> 2026-08 holdout is not read here. It is scored once, afterwards, by oostrail.ts.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
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

const BARS = [0, 24, 48, 96, 192, 288, 480, 960]
const DAY = 96

const STRATS: Array<{ def: StrategyDefinition; name: string }> = [
  { def: trendRegimeEnsemble, name: 'Trend Regime' },
  { def: shortTermChannel, name: 'Short-Term Channel' }
]

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

interface Cell {
  mean: number
  worst: number
  trades: number
  perSymbol: number[]
}

function score(def: StrategyDefinition, bars: number, afterLossOnly: boolean): Cell {
  const nets: number[] = []
  let trades = 0
  for (const symbol of SYMBOLS) {
    const r = runBacktest(windowed(symbol, def), def.id, {
      startingBalance: CAPITAL,
      reentryCooldown: bars > 0 ? { bars, afterLossOnly } : undefined
    })
    nets.push(r.stats.totalNetProfitPct)
    trades += r.stats.totalClosedTrades
  }
  return { mean: nets.reduce((a, b) => a + b, 0) / nets.length, worst: Math.min(...nets), trades, perSymbol: nets }
}

const n = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`

for (const { def, name } of STRATS) {
  console.log(`

########## ${name} — re-entry cooldown — TRAIN 2023-09 → 2025-08, 15m ##########
`)
  console.log(
    'cooldown'.padEnd(14) + 'after any exit'.padStart(30) + 'after a LOSING exit only'.padStart(34)
  )
  console.log(
    ''.padEnd(14) + 'mean'.padStart(9) + 'worst'.padStart(9) + 'trades'.padStart(8) +
      'mean'.padStart(13) + 'worst'.padStart(9) + 'trades'.padStart(8)
  )
  console.log('-'.repeat(78))
  for (const bars of BARS) {
    const any = score(def, bars, false)
    const loss = score(def, bars, true)
    const label = bars === 0 ? 'none (base)' : bars < DAY ? `${(bars / 4).toFixed(0)}h` : `${(bars / DAY).toFixed(0)} days`
    console.log(
      label.padEnd(14) + n(any.mean).padStart(9) + n(any.worst).padStart(9) + String(any.trades).padStart(8) +
        n(loss.mean).padStart(13) + n(loss.worst).padStart(9) + String(loss.trades).padStart(8)
    )
  }
  const base = score(def, 0, false)
  console.log(`
per symbol at baseline: ${SYMBOLS.map((s, i) => `${s.replace('USDT', '')} ${n(base.perSymbol[i])}`).join('   ')}`)
}
