// DOES THE TREND REGIME FILTER RESCUE SHORT-TERM CHANNEL?
//
// The 36-month run says Short-Term Channel loses money in precisely the months Trend Regime
// refuses to trade: mean -4.7% / -3.1% / -9.3% on BTC/ETH/SOL across those months, against
// +3.8% / +5.4% / +8.4% in the months Trend Regime is active. The two are positively correlated,
// so running them side by side concentrates risk. The interesting direction is the other one --
// let Trend Regime's regime vote decide whether Short-Term Channel is allowed to hold at all.
//
// WHY THE MONTH-LEVEL VERSION OF THIS TEST DOES NOT COUNT. Zeroing the months where Trend Regime
// happened to take no trades uses a fact known only after the month ends, and it moves a month's
// whole return rather than individual trades. It reported +55% / +33% / +36% more total profit,
// which is a ceiling, not a result. This runs the gate BAR BY BAR off trailing closes only.
//
// THE GATE IS THE SAME VOTE trendRegimeEnsemble USES: close against SMAs of 20, 30, 50 and 80
// days, agreement = votes / 4. Trend Regime itself enters only at 4/4 and exits at <=1/4. A
// looser threshold here is the whole point -- Short-Term Channel should keep the trades it makes
// in ordinary conditions and lose only the ones taken into a falling market.
//
// WARMUP IS THE SLOWER OF THE TWO, always. The gate reads an 80-day average, so a gated run needs
// Trend Regime's lead (7,680 bars at 15m) even though Short-Term Channel alone needs 769. Using
// Short-Term Channel's would leave the first 6,900 bars gated by a NaN-poisoned vote, which
// compares false and would silently read as "regime off" -- a flat start dressed as a signal.

import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import {
  inferBarSeconds,
  rollingSma,
  trendRegimeEnsemble
} from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategySignals } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const CAPITAL = 10_000
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',')
const INTERVAL = process.env.INTERVAL || '15m'
const GATE_OUT = process.env.GATE_OUT || ''
const LOOKBACK_DAYS = [20, 30, 50, 80]
const SECONDS_PER_DAY = 86_400

function load(symbol: string): Candle[] | null {
  try {
    const raw = JSON.parse(readFileSync(join(DIR, `${symbol}-${INTERVAL}.json`), 'utf-8')) as number[][]
    return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
  } catch {
    return null
  }
}

/** Fraction of the four trend lookbacks that agree price is above trend, per bar.
 *
 * NaN while a lookback is still filling, and `close > NaN` is false, so an unwarmed average votes
 * no rather than yes. That is the safe direction for a gate but NOT a usable signal, which is why
 * callers must not read this before trendRegimeEnsemble's declared warmup. */
function regimeAgreement(candles: Candle[], barSeconds: number): number[] {
  const barsPerDay = SECONDS_PER_DAY / barSeconds
  const closes = candles.map((c) => c.close)
  const averages = LOOKBACK_DAYS.map((d) => rollingSma(closes, Math.max(2, Math.round(d * barsPerDay))))
  return closes.map((close, i) => {
    let votes = 0
    for (const ma of averages) if (close > ma[i]) votes++
    return votes / LOOKBACK_DAYS.length
  })
}

interface Variant {
  label: string
  /** null = ungated baseline. */
  minVotes: number | null
  /** Also force an exit when the regime falls below the threshold mid-position. */
  exitOnFall: boolean
}

const VARIANTS: Variant[] = [
  { label: 'baseline', minVotes: null, exitOnFall: false },
  { label: 'entry >=2/4', minVotes: 2, exitOnFall: false },
  { label: 'entry >=3/4', minVotes: 3, exitOnFall: false },
  { label: 'entry >=4/4', minVotes: 4, exitOnFall: false },
  { label: 'both  >=2/4', minVotes: 2, exitOnFall: true },
  { label: 'both  >=3/4', minVotes: 3, exitOnFall: true },
  { label: 'both  >=4/4', minVotes: 4, exitOnFall: true }
]

function gate(base: StrategySignals, agree: number[], v: Variant, warmup: number): StrategySignals {
  if (v.minVotes === null) return { ...base, warmupBars: Math.max(base.warmupBars, warmup) }
  const need = v.minVotes / LOOKBACK_DAYS.length
  const entries = base.entries.map((e, i) => e && agree[i] >= need)
  const exits = v.exitOnFall ? base.exits.map((x, i) => x || agree[i] < need) : [...base.exits]
  return { entries, exits, stopPrices: [...base.stopPrices], warmupBars: Math.max(base.warmupBars, warmup) }
}

const pct = (v: number, d = 1): string => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`

for (const symbol of SYMBOLS) {
  const candles = load(symbol)
  if (!candles || candles.length < 1000) { console.log(`${symbol}: no ${INTERVAL} data`); continue }
  const barSeconds = inferBarSeconds(candles)
  const warmup = trendRegimeEnsemble.warmupBarsFor(barSeconds)
  const agree = regimeAgreement(candles, barSeconds)
  const base = shortTermChannel.generateSignals(candles)

  const from = new Date(candles[0].time * 1000).toISOString().slice(0, 10)
  const to = new Date(candles[candles.length - 1].time * 1000).toISOString().slice(0, 10)
  console.log(`\n######## ${symbol} ${INTERVAL}  ${from} -> ${to}  (${candles.length.toLocaleString('en-US')} bars) ########`)
  console.log('variant'.padEnd(13) + 'net'.padStart(11) + 'sharpe'.padStart(9) + 'maxDD'.padStart(9) +
    'trades'.padStart(8) + 'win%'.padStart(8) + 'fees'.padStart(10) + 'vs base'.padStart(10))
  console.log('-'.repeat(78))

  let baseNet = 0
  for (const v of VARIANTS) {
    const r = runBacktest(candles, shortTermChannel.id, {
      startingBalance: CAPITAL,
      signals: gate(base, agree, v, warmup)
    })
    const net = r.stats.totalNetProfitPct
    if (v.minVotes === null) baseNet = net
    console.log(
      v.label.padEnd(13) + pct(net).padStart(11) +
      r.stats.sharpeRatio.toFixed(2).padStart(9) +
      pct(r.stats.maxDrawdownPct).padStart(9) +
      String(r.trades.length).padStart(8) +
      (r.stats.winRatePct.toFixed(0) + '%').padStart(8) +
      ('$' + Math.round(r.stats.totalPaidFees).toLocaleString('en-US')).padStart(10) +
      (v.minVotes === null ? '--' : pct(net - baseNet, 0)).padStart(10)
    )
  }
}

// ---------------------------------------------------------------------------------------------
// THE SAME QUESTION WITHOUT COMPOUNDING.
//
// The table above runs one account across nine years, so a variant that differs by a single early
// trade diverges by thousands of percent afterwards -- ETH's 'both >=2/4' reads +5,519% against
// baseline and that number is compounding, not edge. Re-run as 36 independent $10,000 months so
// each month scores on its own and the variants are actually comparable.
// ---------------------------------------------------------------------------------------------

function months36(): Array<[string, number, number]> {
  const out: Array<[string, number, number]> = []
  for (let i = 0; i < 36; i++) {
    const y = 2023 + Math.floor((8 + i) / 12)
    const m = (8 + i) % 12
    out.push([`${y}-${String(m + 1).padStart(2, '0')}`, Date.UTC(y, m, 1) / 1000,
      Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1) / 1000])
  }
  return out
}

const median = (v: number[]): number => {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b), m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

console.log('\n\n=================== 36 INDEPENDENT MONTHS, $10,000 EACH ===================')
const gateDump: Record<string, { rets: number[]; profit: number; trades: number }> = {}
for (const symbol of SYMBOLS) {
  const candles = load(symbol)
  if (!candles || candles.length < 1000) continue
  const barSeconds = inferBarSeconds(candles)
  const warmup = trendRegimeEnsemble.warmupBarsFor(barSeconds)
  const agree = regimeAgreement(candles, barSeconds)
  const base = shortTermChannel.generateSignals(candles)

  console.log(`\n######## ${symbol} ${INTERVAL} ########`)
  console.log('variant'.padEnd(13) + 'prof/36'.padStart(9) + 'median'.padStart(9) + 'mean'.padStart(9) +
    'best'.padStart(9) + 'worst'.padStart(9) + 'total $'.padStart(11) + 'trades/mo'.padStart(11))
  console.log('-'.repeat(80))
  for (const v of VARIANTS) {
    const g = gate(base, agree, v, warmup)
    const rets: number[] = []
    let profit = 0, trades = 0
    for (const [, start, end] of months36()) {
      const first = candles.findIndex((c) => c.time >= start)
      const lastIdx = candles.findIndex((c) => c.time >= end)
      if (first < 0) continue
      const lo = first - g.warmupBars
      if (lo < 0) continue
      const hi = lastIdx < 0 ? candles.length : lastIdx
      if (hi - first < 10) continue
      const r = runBacktest(candles.slice(lo, hi), shortTermChannel.id, {
        startingBalance: CAPITAL,
        signals: {
          entries: g.entries.slice(lo, hi),
          exits: g.exits.slice(lo, hi),
          stopPrices: g.stopPrices.slice(lo, hi),
          warmupBars: g.warmupBars
        }
      })
      rets.push(r.stats.totalNetProfitPct)
      profit += r.stats.finishingBalance - CAPITAL
      trades += r.trades.length
    }
    if (!rets.length) { console.log(v.label.padEnd(13) + '  no months'); continue }
    gateDump[`${symbol}|${v.label}`] = { rets, profit, trades }
    console.log(v.label.padEnd(13) +
      `${rets.filter((x) => x > 0).length}/${rets.length}`.padStart(9) +
      pct(median(rets)).padStart(9) +
      pct(rets.reduce((a, b) => a + b, 0) / rets.length).padStart(9) +
      pct(Math.max(...rets)).padStart(9) + pct(Math.min(...rets)).padStart(9) +
      ('$' + Math.round(profit).toLocaleString('en-US')).padStart(11) +
      (trades / rets.length).toFixed(1).padStart(11))
  }
}

if (GATE_OUT) {
  writeFileSync(GATE_OUT, JSON.stringify(gateDump))
  console.log(`\nper-variant month detail written to ${GATE_OUT}`)
}
