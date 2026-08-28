// Does a give-back exit actually bank more? Swept on TRAIN ONLY: 2023-09 -> 2025-08.
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

const ARM = [0, 3, 5, 8, 12, 20, 30]
const GIVE = [5, 8, 10, 12, 15, 20, 25, 30, 40]

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

function score(def: StrategyDefinition, trailing?: { armAtPct: number; giveBackPct: number }): Cell {
  const nets: number[] = []
  let trades = 0
  for (const symbol of SYMBOLS) {
    const r = runBacktest(windowed(symbol, def), def.id, { startingBalance: CAPITAL, trailing })
    nets.push(r.stats.totalNetProfitPct)
    trades += r.stats.totalClosedTrades
  }
  return { mean: nets.reduce((a, b) => a + b, 0) / nets.length, worst: Math.min(...nets), trades, perSymbol: nets }
}

const n = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`

for (const { def, name } of STRATS) {
  const base = score(def)
  console.log(`\n\n########## ${name} — TRAIN 2023-09 → 2025-08, 15m, mean of 3 symbols ##########\n`)
  console.log(`baseline (no give-back exit): mean ${n(base.mean)}   worst symbol ${n(base.worst)}   ${base.trades} trades`)
  console.log(`  per symbol: ${SYMBOLS.map((s, i) => `${s.replace('USDT', '')} ${n(base.perSymbol[i])}`).join('   ')}`)

  console.log(`\nmean net by arm threshold (rows) x give-back (columns):\n`)
  console.log('arm at'.padEnd(9) + GIVE.map((g) => `${g}%`.padStart(9)).join(''))
  console.log('-'.repeat(9 + GIVE.length * 9))
  const cells = new Map<string, Cell>()
  for (const a of ARM) {
    const row: string[] = []
    for (const g of GIVE) {
      const c = score(def, { armAtPct: a, giveBackPct: g })
      cells.set(`${a}|${g}`, c)
      row.push(n(c.mean).padStart(9))
    }
    console.log(`${a}%`.padEnd(9) + row.join(''))
  }

  console.log(`\nWORST symbol by the same grid — a cell that wins on average and breaks one symbol is not usable:\n`)
  console.log('arm at'.padEnd(9) + GIVE.map((g) => `${g}%`.padStart(9)).join(''))
  console.log('-'.repeat(9 + GIVE.length * 9))
  for (const a of ARM) {
    console.log(
      `${a}%`.padEnd(9) + GIVE.map((g) => n(cells.get(`${a}|${g}`)!.worst).padStart(9)).join('')
    )
  }

  // The plateau matters more than the peak: report the best cells with their neighbourhood, so a
  // spike surrounded by bad cells is visible as the artefact it is.
  const ranked = [...cells.entries()].sort((x, y) => y[1].mean - x[1].mean).slice(0, 6)
  console.log(`\nbest cells, with what surrounds them:\n`)
  console.log('arm/give'.padEnd(12) + 'mean'.padStart(9) + 'worst'.padStart(9) + 'trades'.padStart(8) +
    'neighbours (mean of the 8 around it)'.padStart(40))
  console.log('-'.repeat(78))
  for (const [key, c] of ranked) {
    const [a, g] = key.split('|').map(Number)
    const around: number[] = []
    for (const da of [-1, 0, 1]) {
      for (const dg of [-1, 0, 1]) {
        if (da === 0 && dg === 0) continue
        const ai = ARM.indexOf(a) + da
        const gi = GIVE.indexOf(g) + dg
        if (ai < 0 || gi < 0 || ai >= ARM.length || gi >= GIVE.length) continue
        around.push(cells.get(`${ARM[ai]}|${GIVE[gi]}`)!.mean)
      }
    }
    console.log(
      `${a}% / ${g}%`.padEnd(12) + n(c.mean).padStart(9) + n(c.worst).padStart(9) +
        String(c.trades).padStart(8) + n(around.reduce((x, y) => x + y, 0) / around.length).padStart(40)
    )
  }
}
