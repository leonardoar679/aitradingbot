// Would several positions at once beat one all-in position? Swept on TRAIN ONLY: 2023-09 -> 2025-08.
//
// conc.ts measured the opportunity: counting RISING EDGES of the entry condition, Trend Regime
// fires 686 distinct entries on the training window and the engine can only take 59 of them,
// because it holds one all-in position at a time. Short-Term Channel reaches 151 of 2,178.
//
// The engine is NOT changed to answer this. A slot simulator lives here instead, and it is checked
// against the real engine at N = 1 before any of its other answers are believed -- if the two
// disagree on the one setting where they must agree, nothing else it prints means anything.
//
// THE COST THIS IS BUILT TO EXPOSE. Splitting capital N ways to reach more signals is not free in
// either direction. Each trade now earns a fraction of what it used to, and the money reserved for
// slots that never fill earns nothing at all. conc.ts already showed the blocked opportunities are
// WORSE on average than the taken ones (+6.87% against +11.17% for Trend Regime), so the sweep has
// to show that reaching more of them beats concentrating on fewer, not merely that they exist.

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
const SLOTS = [1, 2, 3, 4, 6, 8]

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

interface Slot {
  entryPrice: number
  entryIndex: number
  qty: number
  margin: number
  entryFee: number
  stopPrice: number
}

interface SlotResult {
  finishing: number
  netPct: number
  trades: number
  wins: number
  maxDrawdownPct: number
  fees: number
  /** Mean fraction of the account actually invested, sampled every bar. The drag this design pays
   * for holding slots open: money reserved for a signal that has not come earns nothing. */
  deployedPct: number
}

/** The engine's single-position rules, generalised to `slots` concurrent positions.
 *
 * Deliberately mirrors src/backtest/engine.ts bar for bar -- stop before signal exit, no entry on
 * a bar something stopped out, warmup gating, force-close at the end -- because the N = 1 case has
 * to reproduce it exactly. Spot only: no leverage, no funding, no liquidation, which is what every
 * study in this directory runs at.
 *
 * SIZING. A new position takes cash / (slots - open), so the first of N takes a 1/N share and the
 * last takes everything left: N positions end up equal, and the account is fully invested once all
 * N are on. The reserved cash sitting idle before that is the cost being measured, not an oversight.
 *
 * ENTRY. With nothing open the rule is the engine's -- any bar the condition holds. A SECOND
 * position needs a rising edge, because the condition is a regime state that stays true for days;
 * without that, N slots would all fill within N bars of the same signal and this would be measuring
 * leverage rather than concurrency. */
function runSlots(candles: Candle[], def: StrategyDefinition, slots: number): SlotResult {
  const s = def.generateSignals(candles)
  let cash = CAPITAL
  const open: Slot[] = []
  let fees = 0
  let trades = 0
  let wins = 0
  let peak = -Infinity
  let maxDrawdownPct = 0
  let deployedSum = 0
  let deployedBars = 0

  const equityAt = (price: number): number =>
    cash + open.reduce((a, p) => a + p.margin - p.entryFee + p.qty * (price - p.entryPrice), 0)

  function close(p: Slot, referencePrice: number, slipped: boolean): void {
    const price = slipped ? referencePrice : sellFillPrice(referencePrice)
    const exitFee = p.qty * price * FEE_RATE
    fees += exitFee
    const pnl = Math.max(p.qty * (price - p.entryPrice) - p.entryFee - exitFee, -p.margin)
    cash += p.margin + pnl
    trades++
    if (pnl > 0) wins++
    open.splice(open.indexOf(p), 1)
  }

  for (let i = 0; i < candles.length; i++) {
    const { open: barOpen, low, close: c } = candles[i]
    let justStoppedOut = false

    if (i >= s.warmupBars) {
      for (const p of [...open]) {
        if (low <= p.stopPrice) {
          close(p, sellFillPrice(Math.min(barOpen, p.stopPrice)), true)
          justStoppedOut = true
        } else if (s.exits[i]) {
          close(p, c, false)
        }
      }

      const risingEdge = i === 0 || !s.entries[i - 1]
      if (
        open.length < slots &&
        !justStoppedOut &&
        s.entries[i] &&
        s.stopPrices[i] !== null &&
        (open.length === 0 || risingEdge) &&
        cash > 0
      ) {
        const margin = cash / (slots - open.length)
        const fill = buyFillPrice(c)
        const fee = margin * FEE_RATE
        fees += fee
        open.push({
          entryPrice: fill,
          entryIndex: i,
          qty: (margin - fee) / fill,
          margin,
          entryFee: fee,
          stopPrice: s.stopPrices[i] as number
        })
        cash -= margin
      }
    }

    const equity = equityAt(c)
    peak = Math.max(peak, equity)
    if (peak > 0) maxDrawdownPct = Math.min(maxDrawdownPct, ((equity - peak) / peak) * 100)
    if (i >= s.warmupBars) {
      deployedSum += equity > 0 ? (equity - cash) / equity : 0
      deployedBars++
    }
  }

  const last = candles[candles.length - 1]
  for (const p of [...open]) close(p, last.close, false)

  return {
    finishing: cash,
    netPct: ((cash - CAPITAL) / CAPITAL) * 100,
    trades,
    wins,
    maxDrawdownPct,
    fees,
    deployedPct: deployedBars > 0 ? (deployedSum / deployedBars) * 100 : 0
  }
}

/** The same N slots, but never holding idle cash: a new entry TRIMS the positions already open
 * until all N are equal, instead of waiting on money reserved in advance.
 *
 * This exists because the reserved-capital sweep above answers a narrower question than it looks
 * like it does. Its `invested` column falls from 54% to 38% as slots are added, so most of what it
 * measures is money sitting out of the market, not concurrency.
 *
 * What is left once that is removed is worth being precise about, because on a SINGLE SYMBOL every
 * position is long the same asset: N equal fully-invested positions are economically one position
 * of the same size, except for three things. Each slot keeps its OWN stop, so the single hard stop
 * becomes a laddered one. A slot that stops out leaves the others holding. And the trimming pays
 * the fee twice on the same coins. So this measures a staged stop, and the fees it costs.
 *
 * Accounting is mark-to-market -- equity is cash plus qty x price -- which is the same arithmetic
 * the engine does in a different form: its `cashBefore - entryFee + qty x (price - entry)` reduces
 * to `qty x price` exactly, and its exit to `qty x price x (1 - fee)`. Partial sells are why the
 * simpler form is used; they have no trade record to hang a margin on. */
function runRebalanced(candles: Candle[], def: StrategyDefinition, slots: number): SlotResult {
  const s = def.generateSignals(candles)
  let cash = CAPITAL
  // `basis` is what THIS position's coins cost, carried per position rather than pooled: a trim
  // sells part of a slot and takes its share of the basis with it, and the proceeds are then spent
  // on the new slot and become part of that one's basis instead. Pooling it double-counts the trim
  // -- the money is charged once to the slot it left and again to the slot it funded -- which does
  // not touch the returns but reports almost every close as a loss.
  const open: Array<{ qty: number; basis: number; stopPrice: number }> = []
  let fees = 0
  let trades = 0
  let wins = 0
  let peak = -Infinity
  let maxDrawdownPct = 0
  let deployedSum = 0
  let deployedBars = 0

  const equityAt = (price: number): number => cash + open.reduce((a, p) => a + p.qty * price, 0)

  /** Sells `qty` at `price`, paying the fee, and returns the proceeds. */
  function sell(qty: number, price: number): number {
    const proceeds = qty * price * (1 - FEE_RATE)
    fees += qty * price * FEE_RATE
    cash += proceeds
    return proceeds
  }

  /** A full close: scored against what the position's remaining coins cost. */
  function closeOut(p: { qty: number; basis: number }, price: number): void {
    const proceeds = sell(p.qty, price)
    trades++
    if (proceeds > p.basis) wins++
    open.splice(open.indexOf(p as (typeof open)[number]), 1)
  }

  for (let i = 0; i < candles.length; i++) {
    const { open: barOpen, low, close: c } = candles[i]
    let justStoppedOut = false

    if (i >= s.warmupBars) {
      for (const p of [...open]) {
        if (low <= p.stopPrice) {
          closeOut(p, sellFillPrice(Math.min(barOpen, p.stopPrice)))
          justStoppedOut = true
        } else if (s.exits[i]) {
          closeOut(p, sellFillPrice(c))
        }
      }

      const risingEdge = i === 0 || !s.entries[i - 1]
      if (
        open.length < slots &&
        !justStoppedOut &&
        s.entries[i] &&
        s.stopPrices[i] !== null &&
        (open.length === 0 || risingEdge) &&
        equityAt(c) > 0
      ) {
        // Trim every position already open down to an equal share, then put ALL the cash to work.
        const target = equityAt(c) / (open.length + 1)
        for (const p of open) {
          const excess = p.qty - target / c
          if (excess > 0) {
            // The basis leaves with the coins, in proportion, so what stays is what the remaining
            // coins cost -- and the proceeds are about to become the new slot's basis below.
            p.basis -= p.basis * (excess / p.qty)
            p.qty -= excess
            sell(excess, sellFillPrice(c))
          }
        }
        const fill = buyFillPrice(c)
        const fee = cash * FEE_RATE
        fees += fee
        open.push({ qty: (cash - fee) / fill, basis: cash, stopPrice: s.stopPrices[i] as number })
        cash = 0
      }
    }

    const equity = equityAt(c)
    peak = Math.max(peak, equity)
    if (peak > 0) maxDrawdownPct = Math.min(maxDrawdownPct, ((equity - peak) / peak) * 100)
    if (i >= s.warmupBars) {
      deployedSum += equity > 0 ? (equity - cash) / equity : 0
      deployedBars++
    }
  }

  const last = candles[candles.length - 1]
  for (const p of [...open]) closeOut(p, sellFillPrice(last.close))

  return {
    finishing: cash,
    netPct: ((cash - CAPITAL) / CAPITAL) * 100,
    trades,
    wins,
    maxDrawdownPct,
    fees,
    deployedPct: deployedBars > 0 ? (deployedSum / deployedBars) * 100 : 0
  }
}

const n = (v: number): string => `${v >= 0 ? '+' : ''}${v.toFixed(0)}%`

// ---------------------------------------------------------------- the check that licenses the rest

console.log('')
console.log('N = 1 against the real engine (the simulator is only worth reading if these agree):')
console.log('')
console.log('strategy'.padEnd(22) + 'symbol'.padEnd(8) + 'engine'.padStart(14) + 'reserved'.padStart(14) + 'rebalanced'.padStart(14) + 'worst gap'.padStart(13))
console.log('-'.repeat(85))
let worstGap = 0
for (const { def, name } of STRATS) {
  for (const symbol of SYMBOLS) {
    const candles = windowed(symbol, def)
    const a = runBacktest(candles, def.id, { startingBalance: CAPITAL }).stats.finishingBalance
    const b = runSlots(candles, def, 1).finishing
    const c = runRebalanced(candles, def, 1).finishing
    const gap = Math.max(Math.abs(a - b), Math.abs(a - c))
    worstGap = Math.max(worstGap, gap)
    console.log(
      name.padEnd(22) + symbol.replace('USDT', '').padEnd(8) + `$${a.toFixed(2)}`.padStart(14) +
        `$${b.toFixed(2)}`.padStart(14) + `$${c.toFixed(2)}`.padStart(14) + `$${gap.toFixed(6)}`.padStart(13)
    )
  }
}
console.log('-'.repeat(85))
console.log(`worst disagreement: $${worstGap.toFixed(6)} on $10,000`)
if (worstGap > 0.01) {
  console.log('')
  console.log('STOP. The simulator does not reproduce the engine at N = 1, so nothing below is evidence.')
  process.exit(1)
}

// ---------------------------------------------------------------------------------- the sweep

const RUNNERS: Array<[string, (c: Candle[], d: StrategyDefinition, k: number) => SlotResult]> = [
  ['capital reserved per slot', runSlots],
  ['always fully invested, trimming to fund each new slot', runRebalanced]
]

for (const { def, name } of STRATS) {
 for (const [how, run] of RUNNERS) {
  console.log('')
  console.log('')
  console.log(`########## ${name} - ${how} - TRAIN 2023-09 to 2025-08, 15m ##########`)
  console.log('')
  console.log(
    'slots'.padEnd(8) + 'mean net'.padStart(10) + 'worst sym'.padStart(11) + 'trades'.padStart(8) +
      'win rate'.padStart(10) + 'worst DD'.padStart(10) + 'invested'.padStart(10) + 'fees'.padStart(9) +
      '   ' + SYMBOLS.map((sym) => `${sym.replace('USDT', '')}`.padStart(12)).join('')
  )
  console.log('-'.repeat(76 + SYMBOLS.length * 12))
  for (const slots of SLOTS) {
    const nets: number[] = []
    let trades = 0
    let wins = 0
    let dd = 0
    let fees = 0
    let deployed = 0
    for (const symbol of SYMBOLS) {
      const r = run(windowed(symbol, def), def, slots)
      nets.push(r.netPct)
      trades += r.trades
      wins += r.wins
      dd = Math.min(dd, r.maxDrawdownPct)
      fees += r.fees
      deployed += r.deployedPct / SYMBOLS.length
    }
    const mean = nets.reduce((a, b) => a + b, 0) / nets.length
    console.log(
      `${slots}${slots === 1 ? ' (ships)' : ''}`.padEnd(8) +
        n(mean).padStart(10) + n(Math.min(...nets)).padStart(11) + String(trades).padStart(8) +
        `${((wins / Math.max(1, trades)) * 100).toFixed(0)}%`.padStart(10) +
        `${dd.toFixed(1)}%`.padStart(10) + `${deployed.toFixed(0)}%`.padStart(10) +
        `$${fees.toFixed(0)}`.padStart(9) + '   ' +
        SYMBOLS.map((_, k) => n(nets[k]).padStart(12)).join('')
    )
  }
 }
}
