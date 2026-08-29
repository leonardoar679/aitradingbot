// THE TWO CELLS OF THE 2x2 NOBODY HAS RUN.
//
// Trend Regime and Short-Term Channel each pair their own entry rule with their own exit rule, and
// shortTermChannelRegime pairs the channel's entry (plus the regime as a gate) with the channel's
// exit. Written as a grid, one cell is empty and one is half-filled:
//
//                          | exit: regime falls below 3 of 4 | exit: channel bottom quarter
//   enter: 4 of 4 agree    | Trend Regime Ensemble           | *** NOT TESTED ***
//   enter: channel break   | *** NOT TESTED ***              | Short-Term Channel
//   enter: both            | --                              | Short-Term Channel + Regime (shipped)
//
// WHY THE EMPTY CELLS ARE WORTH THE COMPUTE, rather than being combinatorics for its own sake.
// research/shape.ts established that Trend Regime earns more money ($97,443 against $82,527 over
// 36 independent months on 8 symbols) while the gated channel loses less (worst month better on 8
// of 8, median in-month drawdown -6.8% against -9.1%). The gated channel differs from Trend Regime
// in BOTH halves at once -- it demands a breakout on top of the regime AND leaves on the channel
// rather than on the regime -- so which half buys the risk reduction is currently unknown.
//
// Splitting them answers that, and cell 1 is the interesting one on its face: Trend Regime's entry
// is what captures the upside, and the channel's exit is what appears to cut the downside. If the
// exit is doing the work, this cell should keep most of Trend Regime's money at most of the gated
// channel's risk. If the entry gate is doing the work, it should not.
//
// NO NEW CONSTANTS. Every rule below already exists in a shipped strategy and is imported rather
// than re-derived. The disaster stop follows the ENTRY strategy, because a stop is set at entry
// and sizing it off a rule the position was not opened on would be a third free choice.
//
// THE RULE, FIXED BEFORE RUNNING, and it is deliberately harsh: two more variants after seventeen
// already swept is exactly where a winner appears by chance. A cell ships only if it beats BOTH
// parents on total profit on at least 3 of the 4 discovery symbols AND at least 3 of the 4
// confirmation symbols, and does not worsen the median worst month across all eight. Beating one
// parent is not enough -- both already exist, so a variant that loses to either is not a reason to
// add a fourth strategy to the registry.
//
//   Discovery:    BTCUSDT ETHUSDT SOLUSDT ADAUSDT
//   Confirmation: BNBUSDT LINKUSDT LTCUSDT XRPUSDT
//
//   npx esbuild research/cross.ts --bundle --platform=node --format=esm --outfile=research/.cross.mjs
//   CANDLE_DIR=.candles node --max-old-space-size=6144 research/.cross.mjs

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { shortTermChannelRegime } from '../src/backtest/strategies/shortTermChannelRegime'
import { inferBarSeconds, trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition, StrategySignals } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const INTERVAL = process.env.INTERVAL || '15m'
const CAPITAL = 10_000
const DISCOVERY = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT']
const CONFIRM = ['BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT']
const ALL = [...DISCOVERY, ...CONFIRM]

function load(symbol: string): Candle[] | null {
  try {
    const raw = JSON.parse(readFileSync(join(DIR, symbol + '-' + INTERVAL + '.json'), 'utf-8')) as number[][]
    return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
  } catch {
    return null
  }
}

function months36(): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < 36; i++) {
    const y = 2023 + Math.floor((8 + i) / 12)
    const m = (8 + i) % 12
    out.push([Date.UTC(y, m, 1) / 1000, Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1) / 1000])
  }
  return out
}

/** Entry rules from one strategy, exit and stop from another. The warm-up is the slower of the two,
 * always: a mixed strategy is not warm until BOTH halves are, and declaring the faster one would
 * report bars gated off by an unfilled average as a decision the rule made. */
function cross(entryFrom: StrategyDefinition, exitFrom: StrategyDefinition, name: string, id: string): {
  id: string
  name: string
  signals: (c: Candle[], barSeconds: number) => StrategySignals
  warmup: (barSeconds: number) => number
} {
  return {
    id,
    name,
    warmup: (barSeconds) => Math.max(entryFrom.warmupBarsFor(barSeconds), exitFrom.warmupBarsFor(barSeconds)),
    signals: (candles, barSeconds) => {
      const a = entryFrom.generateSignals(candles)
      const b = exitFrom.generateSignals(candles)
      return {
        entries: a.entries,
        exits: b.exits,
        // The stop belongs to the entry rule: it is set when the position opens, and Trend Regime's
        // ATR(14)x10 disaster stop means something different from the channel's close x 0.5.
        stopPrices: a.stopPrices,
        warmupBars: Math.max(entryFrom.warmupBarsFor(barSeconds), exitFrom.warmupBarsFor(barSeconds))
      }
    }
  }
}

interface Variant {
  id: string
  name: string
  signals: (c: Candle[], barSeconds: number) => StrategySignals
  warmup: (barSeconds: number) => number
}

const plain = (def: StrategyDefinition): Variant => ({
  id: def.id,
  name: def.name,
  warmup: (b) => def.warmupBarsFor(b),
  signals: (c) => def.generateSignals(c)
})

const VARIANTS: Variant[] = [
  plain(trendRegimeEnsemble),
  plain(shortTermChannel),
  plain(shortTermChannelRegime),
  cross(trendRegimeEnsemble, shortTermChannel, 'regime entry -> channel exit', 'x-regime-channel'),
  cross(shortTermChannel, trendRegimeEnsemble, 'channel entry -> regime exit', 'x-channel-regime')
]

interface Score { profit: number; worst: number; trades: number; months: number }

function score(candles: Candle[], v: Variant): Score | null {
  const barSeconds = inferBarSeconds(candles)
  if (barSeconds <= 0) return null
  const warmup = v.warmup(barSeconds)
  const sig = v.signals(candles, barSeconds)

  let profit = 0
  let worst = 0
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
    // Engine id is only used to look up signals when none are injected; these are always injected,
    // so the id below never selects behaviour. Passing a real one keeps it from ever mattering.
    const r = runBacktest(candles.slice(lo, hi), trendRegimeEnsemble.id, {
      startingBalance: CAPITAL,
      signals: {
        entries: sig.entries.slice(lo, hi),
        exits: sig.exits.slice(lo, hi),
        stopPrices: sig.stopPrices.slice(lo, hi),
        warmupBars: warmup
      }
    })
    profit += r.stats.finishingBalance - CAPITAL
    worst = Math.min(worst, r.stats.totalNetProfitPct)
    trades += r.trades.length
    months++
  }
  return months ? { profit, worst, trades, months } : null
}

const usd = (v: number): string => (v < 0 ? '-' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US')
const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const results = new Map<string, Map<string, Score>>()
for (const symbol of ALL) {
  const candles = load(symbol)
  if (!candles) { console.log('  ' + symbol + ': no ' + INTERVAL + ' data'); continue }
  for (const v of VARIANTS) {
    const s = score(candles, v)
    if (!s) continue
    if (!results.has(v.id)) results.set(v.id, new Map())
    results.get(v.id)?.set(symbol, s)
  }
}

console.log('\n36 independent $' + CAPITAL.toLocaleString('en-US') + ' months at ' + INTERVAL + ', eight symbols\n')
console.log('total profit')
console.log('variant'.padEnd(32) + ALL.map((s) => s.replace('USDT', '').padStart(9)).join(''))
console.log('-'.repeat(32 + 9 * ALL.length))
for (const v of VARIANTS) {
  const m = results.get(v.id)
  if (!m) continue
  console.log(v.name.padEnd(32) + ALL.map((s) => {
    const c = m.get(s)
    return (c ? usd(c.profit) : '--').padStart(9)
  }).join(''))
}

console.log('\nworst single month')
console.log('variant'.padEnd(32) + ALL.map((s) => s.replace('USDT', '').padStart(9)).join('') + '    median')
console.log('-'.repeat(32 + 9 * ALL.length + 10))
for (const v of VARIANTS) {
  const m = results.get(v.id)
  if (!m) continue
  const worsts = ALL.map((s) => m.get(s)?.worst).filter((x): x is number => x !== undefined)
  console.log(v.name.padEnd(32) + ALL.map((s) => {
    const c = m.get(s)
    return (c ? c.worst.toFixed(1) + '%' : '--').padStart(9)
  }).join('') + (median(worsts).toFixed(1) + '%').padStart(10))
}

// ------------------------------------------------------------------ the pre-registered verdict
const parents = [trendRegimeEnsemble.id, shortTermChannel.id, shortTermChannelRegime.id]
const parentWorsts = median(
  ALL.map((s) => results.get(shortTermChannelRegime.id)?.get(s)?.worst).filter((x): x is number => x !== undefined)
)
console.log('\nVERDICT -- beats BOTH parents on >=3 of 4 discovery AND >=3 of 4 confirmation,')
console.log('and does not worsen the median worst month against the best existing strategy (' +
  parentWorsts.toFixed(1) + '%)')
for (const v of VARIANTS) {
  if (parents.includes(v.id)) continue
  const m = results.get(v.id)
  if (!m) continue
  const beatsBoth = (set: string[]): number =>
    set.filter((s) => {
      const mine = m.get(s)?.profit
      const a = results.get(trendRegimeEnsemble.id)?.get(s)?.profit
      const b = results.get(shortTermChannel.id)?.get(s)?.profit
      return mine !== undefined && a !== undefined && b !== undefined && mine > a && mine > b
    }).length
  const d = beatsBoth(DISCOVERY)
  const c = beatsBoth(CONFIRM)
  const worsts = median(ALL.map((s) => m.get(s)?.worst).filter((x): x is number => x !== undefined))
  const verdict =
    d < 3 ? 'rejected at discovery (beats both parents on ' + d + '/4)'
      : c < 3 ? 'FAILED CONFIRMATION -- ' + d + '/4 discovery, only ' + c + '/4 confirmation'
        : worsts < parentWorsts - 0.05 ? 'rejected: median worst month ' + worsts.toFixed(1) + '% against ' + parentWorsts.toFixed(1) + '%'
          : '*** SURVIVES *** ' + d + '/4 discovery, ' + c + '/4 confirmation'
  console.log('  ' + v.name.padEnd(32) + verdict)
}
