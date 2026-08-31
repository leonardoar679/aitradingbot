// THE HOLDOUT, SCORED ONCE.
//
// One change survived the training-window work: giving Short-Term Channel a stop that actually
// binds, 8% below the entry close instead of the 50% disaster stop that never fired in 151 trades.
// Two other candidates were measured and rejected on train -- a give-back trailing exit
// (research/sweeptrail.ts) and a re-entry cooldown (research/sweepcool.ts) -- and neither is here,
// because a rejected idea that gets a second look at the holdout is not rejected.
//
// Everything below reads 2025-09 -> 2026-08 for the first time. It is written to print every
// number in one pass so there is no opportunity to run it, dislike the answer, and adjust.
//
// The 36 independent months are re-run too, because that is the form the request came in.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR as string
const BAR = 900
const CAPITAL = 10_000
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
const STOP_PCT = 8

const WINDOWS: Array<[string, number, number]> = [
  ['TRAIN 2023-09 → 2025-08', Date.parse('2023-09-01T00:00:00Z') / 1000, Date.parse('2025-09-01T00:00:00Z') / 1000],
  ['HOLDOUT 2025-09 → 2026-08', Date.parse('2025-09-01T00:00:00Z') / 1000, Date.parse('2026-08-27T00:00:00Z') / 1000],
  ['ALL 36 MONTHS', Date.parse('2023-09-01T00:00:00Z') / 1000, Date.parse('2026-08-27T00:00:00Z') / 1000]
]

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

const raw = new Map<string, Candle[]>()
function load(symbol: string): Candle[] {
  const hit = raw.get(symbol)
  if (hit) return hit
  const rows = JSON.parse(readFileSync(join(DIR, `${symbol}-15m.json`), 'utf-8')) as number[][]
  const out: Candle[] = rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
  raw.set(symbol, out)
  return out
}

function slice(symbol: string, def: StrategyDefinition, from: number, to: number): Candle[] {
  const all = load(symbol)
  const warmup = def.warmupBarsFor ? def.warmupBarsFor(BAR) : 0
  const first = all.findIndex((c) => c.time >= from)
  const last = all.findIndex((c) => c.time >= to)
  return all.slice(Math.max(0, first - warmup), last < 0 ? all.length : last)
}

const n = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`
const STOPPED_ID = withStop(shortTermChannel, STOP_PCT)

// ------------------------------------------------------------------ head to head, three windows

for (const [label, from, to] of WINDOWS) {
  console.log(`\n\n########## Short-Term Channel — ${label} — 15m ##########\n`)
  console.log(
    'symbol'.padEnd(8) + 'ships (50% stop)'.padStart(18) + 'with an 8% stop'.padStart(18) +
      'change'.padStart(10) + 'DD ships'.padStart(11) + 'DD 8%'.padStart(9) +
      'worst trade'.padStart(13) + 'stopped'.padStart(9)
  )
  console.log('-'.repeat(96))
  for (const symbol of SYMBOLS) {
    const candles = slice(symbol, shortTermChannel, from, to)
    const a = runBacktest(candles, shortTermChannel.id, { startingBalance: CAPITAL })
    const b = runBacktest(candles, STOPPED_ID, { startingBalance: CAPITAL })
    const worstB = Math.min(0, ...b.trades.map((t) => t.returnPct))
    console.log(
      symbol.replace('USDT', '').padEnd(8) +
        n(a.stats.totalNetProfitPct).padStart(18) +
        n(b.stats.totalNetProfitPct).padStart(18) +
        n(b.stats.totalNetProfitPct - a.stats.totalNetProfitPct).padStart(10) +
        `${a.stats.maxDrawdownPct.toFixed(1)}%`.padStart(11) +
        `${b.stats.maxDrawdownPct.toFixed(1)}%`.padStart(9) +
        `${worstB.toFixed(1)}%`.padStart(13) +
        `${b.trades.filter((t) => t.exitReason === 'stop_loss').length}/${b.trades.length}`.padStart(9)
    )
  }
}

// ------------------------------------------------------------------ 36 independent months

console.log(`\n\n########## 36 INDEPENDENT MONTHS, BTCUSDT 15m, $10,000 each ##########\n`)

function monthList(): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = []
  for (let i = 0; i < 36; i++) {
    const y = 2023 + Math.floor((8 + i) / 12)
    const m = (8 + i) % 12
    out.push([
      `${y}-${String(m + 1).padStart(2, '0')}`,
      Date.UTC(y, m, 1) / 1000,
      Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1) / 1000
    ])
  }
  return out
}

function monthRun(symbol: string, def: StrategyDefinition, id: string, from: number, to: number): number | null {
  const all = load(symbol)
  const warmup = def.warmupBarsFor ? def.warmupBarsFor(BAR) : 0
  const first = all.findIndex((c) => c.time >= from)
  const last = all.findIndex((c) => c.time >= to)
  if (first < 0 || first - warmup < 0) return null
  const r = runBacktest(all.slice(first - warmup, last < 0 ? all.length : last), id, { startingBalance: CAPITAL })
  return r.stats.finishingBalance - CAPITAL
}

const months = monthList()
let shipsSum = 0
let stopSum = 0
let shipsWin = 0
let stopWin = 0
let improved = 0
let hurt = 0
let worstShips = { m: '', v: 0 }
let worstStop = { m: '', v: 0 }
console.log('month'.padEnd(10) + 'ships'.padStart(11) + 'with 8% stop'.padStart(14) + 'difference'.padStart(12))
console.log('-'.repeat(47))
for (const [label, from, to] of months) {
  const a = monthRun('BTCUSDT', shortTermChannel, shortTermChannel.id, from, to)
  const b = monthRun('BTCUSDT', shortTermChannel, STOPPED_ID, from, to)
  if (a === null || b === null) continue
  shipsSum += a
  stopSum += b
  if (a > 0) shipsWin++
  if (b > 0) stopWin++
  if (b > a + 1) improved++
  if (b < a - 1) hurt++
  if (a < worstShips.v) worstShips = { m: label, v: a }
  if (b < worstStop.v) worstStop = { m: label, v: b }
  const d = b - a
  console.log(
    label.padEnd(10) + `$${a.toFixed(0)}`.padStart(11) + `$${b.toFixed(0)}`.padStart(14) +
      `${d >= 0 ? '+' : ''}$${d.toFixed(0)}`.padStart(12) + (Math.abs(d) < 1 ? '' : d > 0 ? '  better' : '  worse')
  )
}
console.log('-'.repeat(47))
console.log(`sum of 36 months   ships $${shipsSum.toFixed(0)}   with 8% stop $${stopSum.toFixed(0)}`)
console.log(`profitable months  ships ${shipsWin}   with 8% stop ${stopWin}`)
console.log(`months improved ${improved}   months made worse ${hurt}`)
console.log(`worst month       ships ${worstShips.m} $${worstShips.v.toFixed(0)}   with 8% stop ${worstStop.m} $${worstStop.v.toFixed(0)}`)
