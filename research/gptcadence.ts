import type { Candle } from '../shared/ipc'
import { GPT_DECISION_EVERY_BARS, GPT_LOOKBACK_BARS, GPT_PROMPT_VERSION, describeGptCadence, isDecisionCandle, type AiSignalTape } from '../shared/aiSignal'
import { generateGptIntradaySignals } from '../src/backtest/strategies/gptIntraday'
import { runBacktest } from '../src/backtest/engine'
import { load, register } from './harness'

// DOES ASKING LESS OFTEN LOWER THE BAR?
//
// gptneed.ts measured what a signal asked on EVERY 15-minute candle needs before GPT Intraday
// makes money: roughly 72-75% of its calls right at a four-hour horizon. The app can now ask a
// model every hour or every four hours instead (shared/aiSignal.ts, GPT_DECISION_EVERY_BARS),
// which makes a paid backtest sixteen times longer for the same money. This asks the prior
// question again for those cadences, for free: is the accuracy a model needs any different when
// it is asked less often?
//
// Same method, same machinery. The signal is synthetic, with two knobs -- how often its call
// matches what the next four hours actually did, and how often it says anything but hold -- and
// everything downstream is the shipped code: generateGptIntradaySignals, the engine, the fees and
// the 1.5x ATR stop. The only thing that changes between tables is which candles carry a decision,
// chosen by the same isDecisionCandle the app uses.
//
// At a slower cadence a position can only be closed by a "sell" on a decision candle or by its
// stop, so it is held for at least one cadence unless stopped. That is the whole mechanical
// difference, and it is what these tables measure.

const HORIZON_BARS = 16
const CONFIDENCE = 0.9
const SEEDS = [12345, 777, 20260]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function oracleAction(candles: Candle[], i: number): 'buy' | 'sell' {
  const end = Math.min(candles.length - 1, i + HORIZON_BARS)
  return candles[end].close > candles[i].close ? 'buy' : 'sell'
}

function syntheticTape(candles: Candle[], everyBars: number, accuracy: number, actRate: number, seed: number): AiSignalTape {
  const rng = mulberry32(seed)
  const decisions: AiSignalTape['decisions'] = []
  for (let i = GPT_LOOKBACK_BARS; i < candles.length; i++) {
    if (!isDecisionCandle(candles[i].time, everyBars, '15m')) continue
    let recommendation: 'buy' | 'sell' | 'hold' = 'hold'
    if (rng() < actRate) {
      const truth = oracleAction(candles, i)
      const right = rng() < accuracy
      recommendation = right ? truth : truth === 'buy' ? 'sell' : 'buy'
    }
    decisions.push({ candleTime: candles[i].time, recommendation, confidence: CONFIDENCE, rationale: '', model: 'synthetic', cached: false, error: null })
  }
  return {
    promptVersion: GPT_PROMPT_VERSION,
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: '15m',
    model: 'synthetic',
    decisions,
    cachedCount: 0,
    generatedCount: decisions.length,
    callCount: decisions.length,
    errorCount: 0,
    rejectedCount: 0,
    costUsd: 0
  }
}

interface Outcome {
  netPct: number
  trades: number
  winPct: number
}

let runCount = 0
function runOnce(candles: Candle[], everyBars: number, accuracy: number, actRate: number, seed: number): Outcome {
  const signals = generateGptIntradaySignals(candles, syntheticTape(candles, everyBars, accuracy, actRate, seed))
  const id = register({
    id: `x-gptcadence-${runCount++}`,
    name: 'gptcadence',
    description: '',
    preferredInterval: '15m',
    warmupBarsFor: () => GPT_LOOKBACK_BARS,
    generateSignals: () => signals
  })
  const r = runBacktest(candles, id, { startingBalance: 10_000 })
  return { netPct: r.stats.totalNetProfitPct, trades: r.stats.totalClosedTrades, winPct: r.stats.winRatePct }
}

/** The mean over a few seeds: one seed's crossing moves by a point or two with the draw. */
function averaged(candles: Candle[], everyBars: number, accuracy: number, actRate: number): Outcome {
  const runs = SEEDS.map((seed) => runOnce(candles, everyBars, accuracy, actRate, seed))
  const mean = (pick: (o: Outcome) => number): number => runs.reduce((sum, o) => sum + pick(o), 0) / runs.length
  return { netPct: mean((o) => o.netPct), trades: Math.round(mean((o) => o.trades)), winPct: mean((o) => o.winPct) }
}

/** The lowest accuracy, to the nearest point, at which the strategy stops losing money. Net return
 * rises with accuracy, so this is a bisection rather than a sweep. */
function breakEven(candles: Candle[], everyBars: number, actRate: number): number | null {
  if (averaged(candles, everyBars, 1, actRate).netPct < 0) return null
  let low = 0.5
  let high = 1
  while (high - low > 0.005) {
    const middle = (low + high) / 2
    if (averaged(candles, everyBars, middle, actRate).netPct >= 0) high = middle
    else low = middle
  }
  return high
}

const candles = load('BTCUSDT', '15m').slice(-105_216) // ~3 years of 15m bars, as in gptneed.ts
const ACCURACIES = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8]
const ACT_RATES = [0.05, 0.25, 1]
const pct = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`

console.log('WHAT SIGNAL QUALITY WOULD GPT INTRADAY NEED, ASKED LESS OFTEN?')
console.log(`BTCUSDT 15m, ${candles.length.toLocaleString()} bars (~3 years), real engine, real 0.24% round trip, mean of ${SEEDS.length} seeds`)
console.log(`accuracy = how often the call matches the next ${HORIZON_BARS} bars; act rate = how often a decision is not "hold"`)

for (const everyBars of GPT_DECISION_EVERY_BARS) {
  const perDay = 96 / everyBars
  console.log('')
  console.log(`ASKED EVERY ${describeGptCadence(everyBars).toUpperCase()}  (${perDay} decisions a day)   net % over the window / trades`)
  process.stdout.write('accuracy'.padEnd(10))
  for (const rate of ACT_RATES) process.stdout.write(`act ${(rate * 100).toFixed(0)}%`.padStart(22))
  console.log('')
  console.log('-'.repeat(10 + ACT_RATES.length * 22))
  for (const accuracy of ACCURACIES) {
    process.stdout.write(`${(accuracy * 100).toFixed(0)}%`.padEnd(10))
    for (const rate of ACT_RATES) {
      const o = averaged(candles, everyBars, accuracy, rate)
      process.stdout.write(`${pct(o.netPct)} / ${o.trades}`.padStart(22))
    }
    console.log('')
  }
}

console.log('')
console.log('BREAK-EVEN ACCURACY  (lowest accuracy that does not lose money; trades and win rate there)')
process.stdout.write('asked every'.padEnd(14))
for (const rate of ACT_RATES) process.stdout.write(`act ${(rate * 100).toFixed(0)}%`.padStart(30))
console.log('')
console.log('-'.repeat(14 + ACT_RATES.length * 30))
for (const everyBars of GPT_DECISION_EVERY_BARS) {
  process.stdout.write(describeGptCadence(everyBars).padEnd(14))
  for (const rate of ACT_RATES) {
    const at = breakEven(candles, everyBars, rate)
    if (at === null) {
      process.stdout.write('never, even at 100%'.padStart(30))
      continue
    }
    const o = averaged(candles, everyBars, at, rate)
    process.stdout.write(`${(at * 100).toFixed(0)}% (${o.trades} trades, ${o.winPct.toFixed(0)}% won)`.padStart(30))
  }
  console.log('')
}

// How many round trips does one paid run produce at each cadence? The ceiling is 672 decisions
// whatever the cadence, so this is what decides whether a paid backtest can tell anything apart.
console.log('')
console.log('ONE PAID RUN  (672 decisions at 75% accuracy; closed trades in the stretch it covers)')
for (const everyBars of GPT_DECISION_EVERY_BARS) {
  const bars = 672 * everyBars
  const window = candles.slice(candles.length - GPT_LOOKBACK_BARS - bars)
  const cells = ACT_RATES.map((rate) => `act ${(rate * 100).toFixed(0)}%: ${averaged(window, everyBars, 0.75, rate).trades}`)
  console.log(`  every ${describeGptCadence(everyBars)}`.padEnd(20) + `${(bars / 96).toFixed(0)} days`.padEnd(12) + cells.join('   '))
}
