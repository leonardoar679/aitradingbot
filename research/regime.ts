// WHERE THE BEAR-MARKET LOSS ACTUALLY COMES FROM, measured before anything is changed.
//
// Both shipped strategies are long-only trend followers, so "loses money in a bear market" is
// half tautology and half real defect, and the two have completely different fixes. The
// tautological half: a long-only strategy in a downtrend can at best sit in cash, so its ceiling
// is 0% and any positive expectation has to come from somewhere else entirely. The real half: it
// does not sit in cash, it gets whipsawed -- price pops above the moving averages on a
// bear-market rally, the strategy buys, the rally dies, it pays the round trip and the give-back.
//
// This measures the split. If the loss is mostly the tautology, the answer is shorting (an engine
// change) and no entry filter will help. If it is mostly whipsaw, the answer is a filter that
// declines to buy bounces inside a downtrend, which is cheap and expressible today.
//
// Regime is defined per symbol from ITS OWN price, by drawdown from the running peak close -- not
// from a calendar label and not from BTC, because a strategy trading SOLUSDT faces SOL's
// drawdown. The thresholds are conventional and are deliberately NOT swept: this file classifies,
// it does not tune.
//
// Attribution is MARK-TO-MARKET per bar, not per closed trade. A trade opened in a bull and
// closed in a bear belongs to both in the proportion the equity actually moved -- the same reason
// the engine's own monthly table stopped attributing whole trades to their exit month.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble, rollingSma, inferBarSeconds } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '../.candles'
const CAPITAL = 10_000
const DAY = 86_400

const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,LINKUSDT,LTCUSDT').split(',')
const INTERVAL = process.env.INTERVAL || '4h'

const cache = new Map<string, Candle[]>()
function load(symbol: string, interval: string): Candle[] {
  const key = symbol + interval
  const hit = cache.get(key)
  if (hit) return hit
  const rows = JSON.parse(readFileSync(join(DIR, symbol + '-' + interval + '.json'), 'utf-8')) as number[][]
  const out: Candle[] = rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
  cache.set(key, out)
  return out
}

function register(def: StrategyDefinition): string {
  const i = STRATEGIES.findIndex((s) => s.id === def.id)
  if (i >= 0) STRATEGIES[i] = def
  else STRATEGIES.push(def)
  return def.id
}

// ------------------------------------------------------------------------------------- regimes

type Regime = 'bull' | 'chop' | 'bear'

/** Drawdown from the running peak close, classified with conventional thresholds.
 *
 * Uses only data up to bar i -- a RUNNING maximum, never the whole series' maximum -- so the
 * label at bar i is one a live system could also have computed at bar i. A regime defined from
 * the eventual peak would mark the top of a bull run as "bear" in hindsight and quietly grade
 * every strategy on information it did not have. */
function regimes(candles: Candle[]): Regime[] {
  let peak = -Infinity
  return candles.map((c) => {
    if (c.close > peak) peak = c.close
    const dd = (c.close - peak) / peak
    return dd > -0.1 ? 'bull' : dd > -0.35 ? 'chop' : 'bear'
  })
}

// ------------------------------------------------------------- the two candidate entry filters

/** Only enter when every average over the strategy's own timescale is RISING.
 *
 * The hypothesis: price crossing above a FALLING average is a bear-market bounce, and price
 * crossing above a RISING one is a trend. The shipped rule cannot tell those apart -- it asks
 * only "is close above the line", which is true in both cases. Slope is the cheapest thing that
 * separates them and needs no new lookback, only the derivative of one already computed.
 *
 * Exits are left exactly alone. A filter that also blocked exits would trap the position inside
 * the downtrend the filter exists to avoid. */
function withRisingFilter(base: StrategyDefinition, lookbackDays: number[], slopeDays: number): StrategyDefinition {
  return {
    ...base,
    id: base.id + '-rising' + slopeDays,
    generateSignals(candles: Candle[]) {
      const s = base.generateSignals(candles)
      const barSeconds = inferBarSeconds(candles)
      if (barSeconds <= 0) return s
      const perDay = DAY / barSeconds
      const closes = candles.map((c) => c.close)
      const back = Math.max(1, Math.round(slopeDays * perDay))
      const mas = lookbackDays.map((d) => rollingSma(closes, Math.max(2, Math.round(d * perDay))))
      const entries = s.entries.map((e, i) => {
        if (!e || i < back) return false
        return mas.every((ma) => Number.isFinite(ma[i]) && Number.isFinite(ma[i - back]) && ma[i] > ma[i - back])
      })
      return { ...s, entries }
    }
  }
}

/** Only enter when close is above a slow average -- the classic bull-market gate. */
function withGate(base: StrategyDefinition, gateDays: number): StrategyDefinition {
  return {
    ...base,
    id: base.id + '-gate' + gateDays,
    generateSignals(candles: Candle[]) {
      const s = base.generateSignals(candles)
      const barSeconds = inferBarSeconds(candles)
      if (barSeconds <= 0) return s
      const period = Math.max(2, Math.round(gateDays * (DAY / barSeconds)))
      const ma = rollingSma(candles.map((c) => c.close), period)
      // The gate needs its own history. Without lifting warmup the first `period` bars have a NaN
      // average, every comparison against it is false, and the filter would read as "declines to
      // trade" over a stretch where it really just cannot see yet.
      const warmupBars = Math.max(s.warmupBars, period)
      const entries = s.entries.map((e, i) => e && i >= warmupBars && Number.isFinite(ma[i]) && candles[i].close > ma[i])
      return { ...s, entries, warmupBars }
    }
  }
}

// -------------------------------------------------------------------------------- attribution

interface Split {
  net: number
  byRegime: Record<Regime, number>
  barsByRegime: Record<Regime, number>
  investedByRegime: Record<Regime, number>
  trades: number
  maxDd: number
}

function attribute(candles: Candle[], id: string): Split {
  const r = runBacktest(candles, id, { startingBalance: CAPITAL })
  const reg = regimes(candles)
  const curve = r.equityCurve
  const at = new Map<number, number>()
  candles.forEach((c, i) => at.set(c.time, i))

  const byRegime: Record<Regime, number> = { bull: 0, chop: 0, bear: 0 }
  const barsByRegime: Record<Regime, number> = { bull: 0, chop: 0, bear: 0 }
  const investedByRegime: Record<Regime, number> = { bull: 0, chop: 0, bear: 0 }

  // A bar counts as invested when the equity curve moved on a bar where price moved. Reading the
  // trade list would be exact, but this needs no lookup and cannot disagree with the very curve
  // the P&L is being read off.
  for (let k = 1; k < curve.length; k++) {
    const i = at.get(curve[k].time)
    if (i === undefined || i === 0) continue
    const g = reg[i]
    byRegime[g] += curve[k].value - curve[k - 1].value
    barsByRegime[g]++
    if (candles[i].close !== candles[i - 1].close && curve[k].value !== curve[k - 1].value) investedByRegime[g]++
  }
  return {
    net: r.stats.totalNetProfitPct,
    byRegime,
    barsByRegime,
    investedByRegime,
    trades: r.stats.totalClosedTrades,
    maxDd: r.stats.maxDrawdownPct
  }
}

// ------------------------------------------------------------------------------------- report

const money = (v: number): string => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(0)
const pc = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'

const VARIANTS: Array<[string, (base: StrategyDefinition, days: number[]) => StrategyDefinition | null]> = [
  ['ships today', () => null],
  ['+ rising averages (5d slope)', (b, d) => withRisingFilter(b, d, 5)],
  ['+ rising averages (20d slope)', (b, d) => withRisingFilter(b, d, 20)],
  ['+ above 200d average', (b) => withGate(b, 200)]
]

const STRATS: Array<[StrategyDefinition, number[]]> = [
  [trendRegimeEnsemble, [20, 30, 50, 80]],
  [shortTermChannel, [2, 3, 5, 8]]
]

for (const [base, lookbacks] of STRATS) {
  console.log('\n\n############ ' + base.name + ' -- ' + INTERVAL + ', full history, $10,000 ############')

  for (const [vlabel, make] of VARIANTS) {
    const built = make(base, lookbacks)
    const id = built ? register(built) : base.id
    console.log('\n--- ' + vlabel + ' ---')
    console.log(
      'symbol'.padEnd(9) + 'net%'.padStart(11) + 'trades'.padStart(8) + 'maxDD'.padStart(9) +
        'P&L bull'.padStart(11) + 'P&L chop'.padStart(11) + 'P&L bear'.padStart(11) + 'in mkt bear'.padStart(13)
    )
    console.log('-'.repeat(83))
    const totals = { bull: 0, chop: 0, bear: 0 }
    let netSum = 0
    let counted = 0
    let worst = Infinity
    for (const symbol of SYMBOLS) {
      let candles: Candle[]
      try {
        candles = load(symbol, INTERVAL)
      } catch {
        continue
      }
      const s = attribute(candles, id)
      totals.bull += s.byRegime.bull
      totals.chop += s.byRegime.chop
      totals.bear += s.byRegime.bear
      netSum += s.net
      counted++
      if (s.net < worst) worst = s.net
      const bearShare = s.barsByRegime.bear > 0 ? (s.investedByRegime.bear / s.barsByRegime.bear) * 100 : 0
      console.log(
        symbol.replace('USDT', '').padEnd(9) +
          pc(s.net).padStart(11) + String(s.trades).padStart(8) + pc(s.maxDd).padStart(9) +
          money(s.byRegime.bull).padStart(11) + money(s.byRegime.chop).padStart(11) +
          money(s.byRegime.bear).padStart(11) + (bearShare.toFixed(0) + '%').padStart(13)
      )
    }
    console.log('-'.repeat(83))
    console.log(
      'mean/sum'.padEnd(9) + pc(netSum / Math.max(1, counted)).padStart(11) + ''.padStart(8) + ''.padStart(9) +
        money(totals.bull).padStart(11) + money(totals.chop).padStart(11) + money(totals.bear).padStart(11) +
        ('worst ' + pc(worst)).padStart(13)
    )
  }
}
