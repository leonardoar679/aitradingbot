// What actually costs these two strategies money -- measured before anything is changed.
//
// TRAIN ONLY. Everything here reads 2023-09 -> 2025-08. The final twelve months are not looked at,
// not plotted, and not summarised, because a diagnosis that has seen the holdout is a diagnosis
// fitted to it. This file's whole purpose is to make the redesign answer a measurement instead of
// a backtest score.
//
// Four questions, chosen because each one has a different fix if the answer is yes:
//
//   1. Is the damage whipsaw? If a trade entered soon after the last exit does worse than one
//      entered after a long flat spell, the strategy is re-entering into chop and the fix is a
//      cooldown, not a different threshold.
//   2. How much of each winner is given back before the exit fires? A trend follower that reaches
//      +20% and exits at +8% is losing most of what it caught, and the fix is the exit rule.
//   3. Where is the loss concentrated -- many small losers, or a few large ones? Small ones are a
//      cost of doing business; large ones mean the stop is in the wrong place.
//   4. How lopsided is the profit? If three trades carry everything, no change to the average
//      trade matters much and the honest answer is that the sample is too small to tune on.

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
const TRAIN_FROM = Date.parse('2023-09-01T00:00:00Z') / 1000
const TRAIN_TO = Date.parse('2025-09-01T00:00:00Z') / 1000
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']

const STRATS: Array<{ def: StrategyDefinition; name: string }> = [
  { def: trendRegimeEnsemble, name: 'Trend Regime' },
  { def: shortTermChannel, name: 'Short-Term Channel' }
]

function load(symbol: string): Candle[] {
  const raw = JSON.parse(readFileSync(join(DIR, `${symbol}-15m.json`), 'utf-8')) as number[][]
  return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
}

function windowed(all: Candle[], def: StrategyDefinition): Candle[] {
  const warmup = def.warmupBarsFor ? def.warmupBarsFor(BAR) : 0
  const first = all.findIndex((c) => c.time >= TRAIN_FROM)
  const last = all.findIndex((c) => c.time >= TRAIN_TO)
  return all.slice(Math.max(0, first - warmup), last < 0 ? all.length : last)
}

interface Row {
  symbol: string
  returnPct: number
  holdBars: number
  gapBars: number
  /** Best unrealised gain reached during the hold, as a percent of entry. */
  mfe: number
  /** Worst unrealised loss reached during the hold. */
  mae: number
  exitReason: string
}

function analyse(symbol: string, def: StrategyDefinition): Row[] {
  const candles = windowed(load(symbol), def)
  const result = runBacktest(candles, def.id, { startingBalance: CAPITAL })
  const index = new Map<number, number>()
  candles.forEach((c, i) => index.set(c.time, i))

  const rows: Row[] = []
  let prevExitIdx: number | null = null
  for (const t of result.trades) {
    const a = index.get(t.entryTime)
    const b = index.get(t.exitTime)
    if (a === undefined || b === undefined) continue
    let hi = -Infinity
    let lo = Infinity
    for (let i = a; i <= b; i++) {
      hi = Math.max(hi, candles[i].high)
      lo = Math.min(lo, candles[i].low)
    }
    rows.push({
      symbol,
      returnPct: t.returnPct,
      holdBars: b - a,
      gapBars: prevExitIdx === null ? Infinity : a - prevExitIdx,
      mfe: ((hi - t.entryPrice) / t.entryPrice) * 100,
      mae: ((lo - t.entryPrice) / t.entryPrice) * 100,
      exitReason: t.exitReason
    })
    prevExitIdx = b
  }
  return rows
}

const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)
const pct = (v: number, d = 2): string => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`

const DAY = 96 // 15m bars in a day

for (const { def, name } of STRATS) {
  const rows = SYMBOLS.flatMap((s) => analyse(s, def))
  console.log(`\n\n########## ${name} — TRAIN 2023-09 → 2025-08, 3 symbols, 15m ##########`)
  console.log(`${rows.length} trades   mean ${pct(mean(rows.map((r) => r.returnPct)))}   ` +
    `win rate ${((rows.filter((r) => r.returnPct > 0).length / rows.length) * 100).toFixed(1)}%`)

  // 1. WHIPSAW -----------------------------------------------------------------
  console.log('\n1. Does re-entering soon after an exit do worse?\n')
  console.log('gap since last exit'.padEnd(24) + 'trades'.padStart(8) + 'mean'.padStart(10) + 'win rate'.padStart(10) + 'total'.padStart(10))
  console.log('-'.repeat(62))
  const buckets: Array<[string, (g: number) => boolean]> = [
    ['under 6h', (g) => g < DAY / 4],
    ['6h - 1 day', (g) => g >= DAY / 4 && g < DAY],
    ['1 - 3 days', (g) => g >= DAY && g < DAY * 3],
    ['3 - 10 days', (g) => g >= DAY * 3 && g < DAY * 10],
    ['over 10 days', (g) => g >= DAY * 10 && Number.isFinite(g)],
    ['first of the run', (g) => !Number.isFinite(g)]
  ]
  for (const [label, test] of buckets) {
    const b = rows.filter((r) => test(r.gapBars))
    if (b.length === 0) continue
    const compounded = (b.reduce((m, r) => m * (1 + r.returnPct / 100), 1) - 1) * 100
    console.log(
      label.padEnd(24) + String(b.length).padStart(8) + pct(mean(b.map((r) => r.returnPct))).padStart(10) +
        `${((b.filter((r) => r.returnPct > 0).length / b.length) * 100).toFixed(0)}%`.padStart(10) +
        pct(compounded, 0).padStart(10)
    )
  }

  // 2. EXIT EFFICIENCY ---------------------------------------------------------
  console.log('\n2. How much of the move does each winner keep?\n')
  const winners = rows.filter((r) => r.returnPct > 0)
  const keeps = winners.filter((r) => r.mfe > 0.5).map((r) => r.returnPct / r.mfe)
  console.log(`winners: ${winners.length}   mean peak gain reached ${pct(mean(winners.map((r) => r.mfe)))}   ` +
    `mean kept ${pct(mean(winners.map((r) => r.returnPct)))}`)
  console.log(`fraction of the peak actually banked: ${(mean(keeps) * 100).toFixed(0)}%`)
  const bigGiveback = winners.filter((r) => r.mfe > 5 && r.returnPct < r.mfe * 0.5).length
  console.log(`winners that reached over +5% and kept less than half of it: ${bigGiveback} of ${winners.filter((r) => r.mfe > 5).length}`)
  const losersThatWere = rows.filter((r) => r.returnPct <= 0 && r.mfe > 3)
  console.log(`losing trades that had been up more than 3% at some point: ${losersThatWere.length} of ${rows.filter((r) => r.returnPct <= 0).length}`)

  // 3. LOSS SHAPE --------------------------------------------------------------
  console.log('\n3. Are the losses many small ones or a few big ones?\n')
  const losers = rows.filter((r) => r.returnPct <= 0).sort((a, b) => a.returnPct - b.returnPct)
  const grossLoss = losers.reduce((a, r) => a + r.returnPct, 0)
  console.log(`${losers.length} losing trades, mean ${pct(mean(losers.map((r) => r.returnPct)))}, worst ${pct(losers[0]?.returnPct ?? 0)}`)
  for (const k of [1, 3, 5, 10]) {
    if (losers.length < k) continue
    const share = (losers.slice(0, k).reduce((a, r) => a + r.returnPct, 0) / grossLoss) * 100
    console.log(`  worst ${String(k).padStart(2)} account for ${share.toFixed(0)}% of all losses`)
  }
  const byStop = rows.filter((r) => r.exitReason === 'stop_loss')
  console.log(`exits by stop: ${byStop.length}   by signal: ${rows.filter((r) => r.exitReason === 'signal').length}`)
  console.log(`worst drawdown suffered inside a trade (mean MAE): ${pct(mean(rows.map((r) => r.mae)))}`)

  // 4. PROFIT CONCENTRATION ----------------------------------------------------
  console.log('\n4. How much of the profit rests on how few trades?\n')
  const wins = winners.map((r) => r.returnPct).sort((a, b) => b - a)
  const grossWin = wins.reduce((a, b) => a + b, 0)
  for (const k of [1, 3, 5, 10]) {
    if (wins.length < k) continue
    console.log(`  best ${String(k).padStart(2)} contribute ${((wins.slice(0, k).reduce((a, b) => a + b, 0) / grossWin) * 100).toFixed(0)}% of gross profit`)
  }
  console.log(`\nmean hold ${(mean(rows.map((r) => r.holdBars)) / DAY).toFixed(1)} days   ` +
    `median gap between trades ${(rows.filter((r) => Number.isFinite(r.gapBars)).map((r) => r.gapBars).sort((a, b) => a - b)[Math.floor(rows.length / 2)] / DAY).toFixed(1)} days`)
}
