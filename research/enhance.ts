// CANDIDATE ENHANCEMENTS, SWEPT UNDER A RULE FIXED BEFORE THE RESULTS WERE SEEN.
//
// Three levers, each with prior evidence, none currently switched on for any strategy:
//
//   1. REGIME GATE (Short-Term Channel only). Enter only when all four of trendRegimeEnsemble's
//      trend lookbacks agree. research/gate.ts measured this at +7 of 8 symbols. Re-derived here
//      under the same protocol as everything else rather than carried forward on trust.
//   2. GIVE-BACK EXIT. engine.ts already implements it and cites research/diag.ts: both strategies
//      bank roughly 40% of the peak gain their winners reach, and about half of their losing
//      trades had been up more than 3% before rolling over.
//   3. RE-ENTRY COOLDOWN. Also already implemented, also from diag.ts: Trend Regime's trades
//      opened within a day of the previous exit won 26% of the time against 46% for those opened
//      after ten days or more.
//
// Both diag.ts findings come from three symbols on the training window -- the sample size that has
// already forced two retractions in strategies/types.ts. Being quoted in a shipped file does not
// make them confirmed, which is the whole reason for the split below.
//
// THE PROTOCOL, DECLARED UP FRONT BECAUSE SWEEPING TEN VARIANTS ACROSS EIGHT SYMBOLS PRODUCES A
// WINNER BY CHANCE IF THE RULE IS CHOSEN AFTERWARDS.
//
//   Discovery set:    BTCUSDT ETHUSDT SOLUSDT ADAUSDT
//   Confirmation set: BNBUSDT LINKUSDT LTCUSDT XRPUSDT
//
//   A variant is a CANDIDATE only if it raises 36-month total profit on at least 3 of the 4
//   discovery symbols. A candidate is CONFIRMED only if it then does the same on at least 3 of the
//   4 confirmation symbols, which had no part in selecting it. A confirmed variant is REJECTED
//   anyway if it worsens the worst month on more than half of all eight.
//
// Everything is 36 independent $10,000 months at 15m, full fees and slippage, exactly as
// research/monthiv.ts runs them.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest, type RunBacktestOptions } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { inferBarSeconds, rollingSma, trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition, StrategySignals } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const INTERVAL = process.env.INTERVAL || '15m'
const CAPITAL = 10_000
const DISCOVERY = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT']
const CONFIRM = ['BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT']
const LOOKBACK_DAYS = [20, 30, 50, 80]
const SECONDS_PER_DAY = 86_400

function load(symbol: string): Candle[] | null {
  try {
    const raw = JSON.parse(readFileSync(join(DIR, symbol + '-' + INTERVAL + '.json'), 'utf-8')) as number[][]
    return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
  } catch {
    return null
  }
}

/** Fraction of the four trend lookbacks agreeing price is above trend, per bar. NaN while a
 * lookback is still filling, and close > NaN is false, so an unwarmed average votes no. Safe for a
 * gate but not a signal -- callers must not read it before the declared warmup. */
function regimeAgreement(candles: Candle[], barSeconds: number): number[] {
  const barsPerDay = SECONDS_PER_DAY / barSeconds
  const closes = candles.map((c) => c.close)
  const mas = LOOKBACK_DAYS.map((d) => rollingSma(closes, Math.max(2, Math.round(d * barsPerDay))))
  return closes.map((close, i) => {
    let v = 0
    for (const ma of mas) if (close > ma[i]) v++
    return v / LOOKBACK_DAYS.length
  })
}

interface Variant {
  label: string
  gate?: boolean
  opts?: RunBacktestOptions
}

const VARIANTS: Variant[] = [
  { label: 'baseline' },
  { label: 'regime gate', gate: true },
  { label: 'give-back 3/2', opts: { trailing: { armAtPct: 3, giveBackPct: 2 } } },
  { label: 'give-back 5/3', opts: { trailing: { armAtPct: 5, giveBackPct: 3 } } },
  { label: 'give-back 8/5', opts: { trailing: { armAtPct: 8, giveBackPct: 5 } } },
  { label: 'give-back 12/8', opts: { trailing: { armAtPct: 12, giveBackPct: 8 } } },
  { label: 'cooldown 24', opts: { reentryCooldown: { bars: 24 } } },
  { label: 'cooldown 96', opts: { reentryCooldown: { bars: 96 } } },
  { label: 'cooldown 24 loss', opts: { reentryCooldown: { bars: 24, afterLossOnly: true } } },
  { label: 'cooldown 96 loss', opts: { reentryCooldown: { bars: 96, afterLossOnly: true } } }
]

function months36(): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < 36; i++) {
    const y = 2023 + Math.floor((8 + i) / 12)
    const m = (8 + i) % 12
    out.push([Date.UTC(y, m, 1) / 1000, Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1) / 1000])
  }
  return out
}

interface Score {
  profit: number
  worst: number
  profitable: number
  trades: number
  months: number
}

function score(candles: Candle[], def: StrategyDefinition, v: Variant): Score | null {
  const barSeconds = inferBarSeconds(candles)
  if (barSeconds <= 0) return null
  const base = def.generateSignals(candles)
  // A gated run reads an 80-day average, so it needs Trend Regime's lead even though Short-Term
  // Channel alone needs 8 days. Using the shorter one would leave thousands of bars gated by a NaN
  // vote, which compares false and reads as "regime off" -- a flat start dressed as a signal.
  const warmup = v.gate
    ? Math.max(base.warmupBars, trendRegimeEnsemble.warmupBarsFor(barSeconds))
    : base.warmupBars
  let sig: StrategySignals = { ...base, warmupBars: warmup }
  if (v.gate) {
    const agree = regimeAgreement(candles, barSeconds)
    sig = { ...sig, entries: base.entries.map((e, i) => e && agree[i] >= 1) }
  }

  let profit = 0
  let worst = 0
  let profitable = 0
  let trades = 0
  let months = 0
  for (const [start, end] of months36()) {
    const first = candles.findIndex((c) => c.time >= start)
    const lastIdx = candles.findIndex((c) => c.time >= end)
    if (first < 0) continue
    const lo = first - warmup
    if (lo < 0) continue
    const hi = lastIdx < 0 ? candles.length : lastIdx
    if (hi - first < 10) continue
    const r = runBacktest(candles.slice(lo, hi), def.id, {
      startingBalance: CAPITAL,
      ...(v.opts ?? {}),
      signals: {
        entries: sig.entries.slice(lo, hi),
        exits: sig.exits.slice(lo, hi),
        stopPrices: sig.stopPrices.slice(lo, hi),
        warmupBars: warmup
      }
    })
    const ret = r.stats.totalNetProfitPct
    profit += r.stats.finishingBalance - CAPITAL
    worst = Math.min(worst, ret)
    if (ret > 0) profitable++
    trades += r.trades.length
    months++
  }
  return months ? { profit, worst, profitable, trades, months } : null
}

const usd = (v: number): string => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US')
const ALL = [...DISCOVERY, ...CONFIRM]
const STRATS: StrategyDefinition[] = [trendRegimeEnsemble, shortTermChannel]

for (const def of STRATS) {
  console.log('\n\n################################ ' + def.name + ' ################################')
  const rows = new Map<string, Map<string, Score>>()
  for (const symbol of ALL) {
    const candles = load(symbol)
    if (!candles) { console.log('  ' + symbol + ': no data'); continue }
    for (const v of VARIANTS) {
      // The regime gate is a Short-Term Channel proposal; Trend Regime already IS the regime.
      if (v.gate && def.id !== shortTermChannel.id) continue
      const s = score(candles, def, v)
      if (!s) continue
      if (!rows.has(v.label)) rows.set(v.label, new Map())
      const bucket = rows.get(v.label)
      if (bucket) bucket.set(symbol, s)
    }
  }

  const baseRow = rows.get('baseline')
  if (!baseRow) { console.log('  no baseline'); continue }

  const beats = (m: Map<string, Score>, set: string[]): number =>
    set.filter((s) => {
      const a = m.get(s)
      const b = baseRow.get(s)
      return a !== undefined && b !== undefined && a.profit > b.profit
    }).length

  const worseOn = (m: Map<string, Score>): number =>
    ALL.filter((s) => {
      const a = m.get(s)
      const b = baseRow.get(s)
      return a !== undefined && b !== undefined && a.worst < b.worst - 0.05
    }).length

  console.log('\ntotal profit over 36 independent months, $10,000 each')
  console.log('variant'.padEnd(18) + ALL.map((s) => s.replace('USDT', '').padStart(9)).join('') + '   disc  conf')
  console.log('-'.repeat(18 + 9 * ALL.length + 13))
  for (const [label, m] of rows) {
    console.log(
      label.padEnd(18) +
        ALL.map((s) => {
          const cell = m.get(s)
          return (cell ? usd(cell.profit) : '--').padStart(9)
        }).join('') +
        (label === 'baseline'
          ? '     --    --'
          : (beats(m, DISCOVERY) + '/4').padStart(7) + (beats(m, CONFIRM) + '/4').padStart(6))
    )
  }

  console.log('\nworst single month')
  console.log('variant'.padEnd(18) + ALL.map((s) => s.replace('USDT', '').padStart(9)).join('') + '   worse-on')
  console.log('-'.repeat(18 + 9 * ALL.length + 12))
  for (const [label, m] of rows) {
    console.log(
      label.padEnd(18) +
        ALL.map((s) => {
          const cell = m.get(s)
          return (cell ? cell.worst.toFixed(1) + '%' : '--').padStart(9)
        }).join('') +
        (label === 'baseline' ? '        --' : (worseOn(m) + '/8').padStart(10))
    )
  }

  console.log('\nVERDICT (>=3/4 discovery, then >=3/4 confirmation, and not worse on >4 of 8)')
  for (const [label, m] of rows) {
    if (label === 'baseline') continue
    const d = beats(m, DISCOVERY)
    const c = beats(m, CONFIRM)
    const w = worseOn(m)
    const verdict =
      d < 3
        ? 'rejected at discovery (' + d + '/4)'
        : c < 3
          ? 'FAILED CONFIRMATION -- selected on discovery (' + d + '/4), held only ' + c + '/4'
          : w > 4
            ? 'rejected: worse worst-month on ' + w + ' of 8'
            : '*** CONFIRMED *** discovery ' + d + '/4, confirmation ' + c + '/4'
    console.log('  ' + label.padEnd(18) + verdict)
  }
}
