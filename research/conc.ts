// The last untested lever: the engine holds ONE all-in position at a time.
//
// Every strategy here is a long-only signal stream, and the engine takes an entry only when it is
// flat. Every other entry the strategy fires is silently discarded. Before changing the engine to
// allow several positions at once, this measures whether the discarded signals were worth taking.
//
// TRAIN ONLY: 2023-09 -> 2025-08. The holdout is not read here.
//
// The counterfactual is built to be pessimistic in the two places it could flatter itself:
//   - the hypothetical entry pays the same buy-side slippage and fee a real one would,
//   - it exits on the FIRST of the strategy's own exit signal or its own stop, so a suppressed
//     entry cannot be credited with holding through an exit the strategy had already called.
// What it does NOT model is capital: each hypothetical trade is sized as if the money were free.
// That is the whole question the sweep after this has to answer, and it is why this file reports
// an opportunity rather than a return.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import { buyFillPrice, sellFillPrice, FEE_RATE } from '../shared/fees'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR as string
const BAR = 900
const CAPITAL = 10_000
const FROM = Date.parse('2023-09-01T00:00:00Z') / 1000
const TO = Date.parse('2025-09-01T00:00:00Z') / 1000
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']
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

interface Shot {
  taken: boolean
  returnPct: number
  holdBars: number
  /** How many bars after the position it was blocked by opened. 0 for a taken entry. */
  lateBy: number
}

/** What a long opened at bar `i` would have returned, closed at the first of the strategy's exit
 * signal or its own stop. Same fees and slippage the engine charges. */
function roundTrip(candles: Candle[], exits: boolean[], i: number, stop: number): { returnPct: number; bars: number } {
  const entry = buyFillPrice(candles[i].close)
  const net = (fill: number): number => ((fill * (1 - FEE_RATE)) / (entry * (1 + FEE_RATE)) - 1) * 100
  for (let j = i + 1; j < candles.length; j++) {
    if (candles[j].low <= stop) return { returnPct: net(sellFillPrice(Math.min(candles[j].open, stop))), bars: j - i }
    if (exits[j]) return { returnPct: net(sellFillPrice(candles[j].close)), bars: j - i }
  }
  const last = candles.length - 1
  return { returnPct: net(sellFillPrice(candles[last].close)), bars: last - i }
}

function shots(symbol: string, def: StrategyDefinition): Shot[] {
  const candles = windowed(symbol, def)
  const s = def.generateSignals(candles)
  const result = runBacktest(candles, def.id, { startingBalance: CAPITAL })

  // Bar index -> the real trade holding at that bar, so a signal can be classified as taken,
  // blocked by an open position, or blocked by nothing (which would be a bug in this reader).
  const idx = new Map<number, number>()
  candles.forEach((c, i) => idx.set(c.time, i))
  const heldBy = new Array<number>(candles.length).fill(-1)
  const openedAt: number[] = []
  result.trades.forEach((t, n) => {
    const a = idx.get(t.entryTime)
    const b = idx.get(t.exitTime)
    if (a === undefined || b === undefined) return
    openedAt[n] = a
    for (let i = a; i <= b; i++) heldBy[i] = n
  })
  const entryBars = new Set(openedAt)

  // ONLY RISING EDGES COUNT AS OPPORTUNITIES. `entries` is a regime state, not an event: Trend
  // Regime's is true on 45% of all bars, so counting every true bar reports 95,651 "signals" for a
  // strategy that takes 59 trades, and every one of them is the same uptrend asserting itself
  // again. A second position opened on the next bar is not a second opportunity, it is leverage on
  // the first. An edge -- false on the previous bar, true on this one -- is a distinct event.
  const out: Shot[] = []
  for (let i = s.warmupBars; i < candles.length; i++) {
    if (!s.entries[i] || s.stopPrices[i] === null) continue
    const taken = entryBars.has(i)
    if (!taken && s.entries[i - 1]) continue

    const holder = heldBy[i]
    if (!taken && holder < 0) continue // flat and not taken: a stop-out bar, not this question
    const rt = roundTrip(candles, s.exits, i, s.stopPrices[i] as number)
    out.push({ taken, returnPct: rt.returnPct, holdBars: rt.bars, lateBy: taken ? 0 : i - openedAt[holder] })
  }
  return out
}

const mean = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)
const pct = (v: number, d = 2): string => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`
const rate = (v: Shot[]): string => `${((v.filter((x) => x.returnPct > 0).length / Math.max(1, v.length)) * 100).toFixed(0)}%`

for (const { def, name } of STRATS) {
  const all = SYMBOLS.flatMap((s) => shots(s, def))
  const taken = all.filter((s) => s.taken)
  const blocked = all.filter((s) => !s.taken)
  console.log('')
  console.log('')
  console.log(`########## ${name} - TRAIN 2023-09 to 2025-08, 3 symbols, 15m ##########`)
  console.log('')
  console.log(`entry signals fired: ${all.length}   taken: ${taken.length}   blocked by an open position: ${blocked.length}`)
  console.log(`reachable share: ${((taken.length / all.length) * 100).toFixed(1)}%`)
  console.log('')
  console.log('signal'.padEnd(22) + 'count'.padStart(8) + 'mean'.padStart(10) + 'win rate'.padStart(10) + 'median hold'.padStart(13))
  console.log('-'.repeat(63))
  for (const [label, rows] of [['taken', taken], ['blocked', blocked]] as Array<[string, Shot[]]>) {
    if (rows.length === 0) continue
    const holds = rows.map((r) => r.holdBars).sort((a, b) => a - b)
    console.log(
      label.padEnd(22) + String(rows.length).padStart(8) + pct(mean(rows.map((r) => r.returnPct))).padStart(10) +
        rate(rows).padStart(10) + `${(holds[Math.floor(holds.length / 2)] / DAY).toFixed(1)}d`.padStart(13)
    )
  }

  // A blocked signal that fires one bar after the entry is the same idea again at a slightly worse
  // price; one that fires days later is a genuinely separate opportunity. If only the first kind
  // is profitable, concurrency is just leverage on the trade already held.
  console.log('')
  console.log('blocked opportunities by how long after the held position opened:')
  console.log('')
  console.log('fired'.padEnd(22) + 'count'.padStart(8) + 'mean'.padStart(10) + 'win rate'.padStart(10) + 'sum if all taken'.padStart(20))
  console.log('-'.repeat(70))
  const buckets: Array<[string, (b: number) => boolean]> = [
    ['same day', (b) => b < DAY],
    ['1 - 3 days later', (b) => b >= DAY && b < DAY * 3],
    ['3 - 10 days later', (b) => b >= DAY * 3 && b < DAY * 10],
    ['over 10 days later', (b) => b >= DAY * 10]
  ]
  for (const [label, test] of buckets) {
    const rows = blocked.filter((r) => test(r.lateBy))
    if (rows.length === 0) continue
    console.log(
      label.padEnd(22) + String(rows.length).padStart(8) + pct(mean(rows.map((r) => r.returnPct))).padStart(10) +
        rate(rows).padStart(10) + pct(rows.reduce((a, r) => a + r.returnPct, 0), 0).padStart(20)
    )
  }
}
