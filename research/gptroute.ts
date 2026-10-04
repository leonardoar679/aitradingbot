import type { Candle } from '../shared/ipc'
import {
  GPT_FLAT,
  GPT_LOOKBACK_BARS,
  GPT_PROMPT_VERSION,
  describeGptCadence,
  gptActionFor,
  gptApplyStop,
  gptAtrSeries,
  gptStopFor,
  isDecisionCandle,
  type AiSignalDecision,
  type AiSignalTape
} from '../shared/aiSignal'
import { escalates, routedDecision } from '../shared/aiRoute'
import { generateGptIntradaySignals } from '../src/backtest/strategies/gptIntraday'
import { runBacktest } from '../src/backtest/engine'
import { load, register } from './harness'

// WHAT DOES A SECOND OPINION BUY?
//
// The app can now pass a decision on to a second model when the first wants to open or close a
// position (shared/aiRoute.ts), and act only on the second model's answer. That is an AND: a trade
// happens when two models want it. gptneed.ts and gptcadence.ts measured the accuracy ONE signal
// needs before GPT Intraday stops losing money; this asks, for free, what two of them need -- and
// what decides whether the second one helps at all.
//
// Same method, same machinery. Both signals are synthetic: each calls the next four hours right
// with a known probability. What is new is one knob, how alike the two are -- the share of
// decisions on which the second model simply makes the first one's call, right or wrong. At 0 they
// err independently; at 1 they are one opinion asked twice. Everything downstream is the shipped
// code: the same `escalates` and `routedDecision` the tape uses, walked through the same position
// machine, then generateGptIntradaySignals, the engine, the fees and the 1.5x ATR stop.
//
// The rule that passes on what the first model is UNSURE of is not measured here. It turns on how
// a model's stated confidence relates to its being right, and a synthetic signal has no honest
// answer to that; a real benchmark does (the Benchmark tab's route table).

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

function said(candleTime: number, recommendation: 'buy' | 'sell' | 'hold', model: string): AiSignalDecision {
  return { candleTime, recommendation, confidence: CONFIDENCE, rationale: '', model, cached: false, error: null }
}

interface Setup {
  everyBars: number
  /** How often each model's call matches what the next four hours did. */
  accuracy: number
  /** How often the first model says anything but hold. */
  actRate: number
  /** Null for the first model alone. Otherwise the share of passed-on decisions on which the
   * second model makes the first one's call; on the rest it makes its own, equally accurate. */
  alike: number | null
}

interface Routed {
  tape: AiSignalTape
  decisions: number
  passedOn: number
}

/** The tape a route produces, walked exactly as the main process walks it: the stop on every
 * candle, the first model on every decision candle, the second only where the rule passes the
 * decision on, and the position moved by whichever answer counted. */
function routedTape(candles: Candle[], setup: Setup, seed: number): Routed {
  // Two streams, so the first model says the same things whatever the second one is like.
  const first = mulberry32(seed)
  const second = mulberry32(seed ^ 0x9e3779b9)
  const atr = gptAtrSeries(candles)
  const decisions: AiSignalDecision[] = []
  let position = GPT_FLAT
  let passedOn = 0
  for (let i = GPT_LOOKBACK_BARS; i < candles.length; i++) {
    position = gptApplyStop(position, candles[i])
    if (!isDecisionCandle(candles[i].time, setup.everyBars, '15m')) continue
    const truth = oracleAction(candles, i)
    const wrong = truth === 'buy' ? 'sell' : 'buy'
    const acts = first() < setup.actRate
    const firstRight = first() < setup.accuracy
    let decision = said(candles[i].time, acts ? (firstRight ? truth : wrong) : 'hold', 'first')
    if (setup.alike !== null && escalates(decision, position, 'acting')) {
      const copies = second() < setup.alike
      const ownRight = second() < setup.accuracy
      const secondRight = copies ? firstRight : ownRight
      decision = routedDecision(decision, said(candles[i].time, secondRight ? truth : wrong, 'second'))
      passedOn++
    }
    decisions.push(decision)
    const action = gptActionFor(decision, position)
    if (action === 'enter') position = { long: true, stop: gptStopFor(candles, atr, i) }
    else if (action === 'exit') position = GPT_FLAT
  }
  return {
    decisions: decisions.length,
    passedOn,
    tape: {
      promptVersion: GPT_PROMPT_VERSION,
      exchange: 'binance',
      symbol: 'BTCUSDT',
      interval: '15m',
      model: 'first',
      decisions,
      cachedCount: 0,
      generatedCount: decisions.length,
      callCount: decisions.length + passedOn,
      errorCount: 0,
      rejectedCount: 0,
      costUsd: 0
    }
  }
}

interface Outcome {
  netPct: number
  trades: number
  winPct: number
  /** Model calls per decision: one, plus the share that was passed on. */
  callsPerDecision: number
}

let runCount = 0
function runOnce(candles: Candle[], setup: Setup, seed: number): Outcome {
  const routed = routedTape(candles, setup, seed)
  const signals = generateGptIntradaySignals(candles, routed.tape)
  const id = register({
    id: `x-gptroute-${runCount++}`,
    name: 'gptroute',
    description: '',
    preferredInterval: '15m',
    warmupBarsFor: () => GPT_LOOKBACK_BARS,
    generateSignals: () => signals
  })
  const r = runBacktest(candles, id, { startingBalance: 10_000 })
  return {
    netPct: r.stats.totalNetProfitPct,
    trades: r.stats.totalClosedTrades,
    winPct: r.stats.winRatePct,
    callsPerDecision: routed.decisions > 0 ? 1 + routed.passedOn / routed.decisions : 1
  }
}

function averaged(candles: Candle[], setup: Setup): Outcome {
  const runs = SEEDS.map((seed) => runOnce(candles, setup, seed))
  const mean = (pick: (o: Outcome) => number): number => runs.reduce((sum, o) => sum + pick(o), 0) / runs.length
  return {
    netPct: mean((o) => o.netPct),
    trades: Math.round(mean((o) => o.trades)),
    winPct: mean((o) => o.winPct),
    callsPerDecision: mean((o) => o.callsPerDecision)
  }
}

/** The lowest accuracy, to the nearest point, at which the setup stops losing money. */
function breakEven(candles: Candle[], setup: Omit<Setup, 'accuracy'>): number | null {
  if (averaged(candles, { ...setup, accuracy: 1 }).netPct < 0) return null
  let low = 0.5
  let high = 1
  while (high - low > 0.005) {
    const middle = (low + high) / 2
    if (averaged(candles, { ...setup, accuracy: middle }).netPct >= 0) high = middle
    else low = middle
  }
  return high
}

const candles = load('BTCUSDT', '15m').slice(-105_216) // ~3 years of 15m bars, as in gptneed.ts
const CADENCES = [4, 16]
const ACT_RATES = [0.25, 1]
const ACCURACIES = [0.55, 0.6, 0.65, 0.7, 0.75]
const VARIANTS: { label: string; alike: number | null }[] = [
  { label: 'first model alone', alike: null },
  { label: '+ second, independent', alike: 0 },
  { label: '+ second, half alike', alike: 0.5 },
  { label: '+ second, 90% alike', alike: 0.9 },
  { label: '+ second, same opinion', alike: 1 }
]
const pct = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`

console.log('WHAT DOES A SECOND OPINION BUY?')
console.log(`BTCUSDT 15m, ${candles.length.toLocaleString()} bars (~3 years), real engine, real 0.24% round trip, mean of ${SEEDS.length} seeds`)
console.log(`Both models call the next ${HORIZON_BARS} bars right with the same probability. The second is asked only when the first`)
console.log('wants to open or close a position, and its answer is the one acted on. "Alike" is the share of those')
console.log("decisions on which the second model makes the first one's call, right or wrong.")

// What agreement is worth on paper, before any market is involved: two calls that are each right
// with probability a, the second copying the first with probability `alike`.
console.log('')
console.log('ON PAPER  how often a trade both models wanted was the right call')
process.stdout.write('accuracy of each'.padEnd(20))
for (const variant of VARIANTS.slice(1)) process.stdout.write(variant.label.replace('+ second, ', '').padStart(18))
console.log('')
for (const a of ACCURACIES) {
  process.stdout.write(`${(a * 100).toFixed(0)}%`.padEnd(20))
  for (const variant of VARIANTS.slice(1)) {
    const alike = variant.alike as number
    const bothRight = a * (alike + (1 - alike) * a)
    const bothWrong = (1 - a) * (alike + (1 - alike) * (1 - a))
    process.stdout.write(`${((bothRight / (bothRight + bothWrong)) * 100).toFixed(0)}%`.padStart(18))
  }
  console.log('')
}

for (const everyBars of CADENCES) {
  for (const actRate of ACT_RATES) {
    console.log('')
    console.log(
      `ASKED EVERY ${describeGptCadence(everyBars).toUpperCase()}, FIRST MODEL ACTS ON ${(actRate * 100).toFixed(0)}% OF DECISIONS   net % over the window / trades / calls per decision`
    )
    process.stdout.write('accuracy'.padEnd(10))
    for (const variant of VARIANTS) process.stdout.write(variant.label.padStart(30))
    console.log('')
    console.log('-'.repeat(10 + VARIANTS.length * 30))
    for (const accuracy of ACCURACIES) {
      process.stdout.write(`${(accuracy * 100).toFixed(0)}%`.padEnd(10))
      for (const variant of VARIANTS) {
        const o = averaged(candles, { everyBars, accuracy, actRate, alike: variant.alike })
        process.stdout.write(`${pct(o.netPct)} / ${o.trades} / ${o.callsPerDecision.toFixed(2)}`.padStart(30))
      }
      console.log('')
    }
  }
}

console.log('')
console.log('BREAK-EVEN ACCURACY  (lowest accuracy of each model that does not lose money; trades and win rate there)')
for (const everyBars of CADENCES) {
  for (const actRate of ACT_RATES) {
    console.log('')
    console.log(`asked every ${describeGptCadence(everyBars)}, first model acts on ${(actRate * 100).toFixed(0)}%`)
    for (const variant of VARIANTS) {
      const at = breakEven(candles, { everyBars, actRate, alike: variant.alike })
      if (at === null) {
        console.log(`  ${variant.label.padEnd(26)} never, even at 100%`)
        continue
      }
      const o = averaged(candles, { everyBars, accuracy: at, actRate, alike: variant.alike })
      console.log(`  ${variant.label.padEnd(26)} ${(at * 100).toFixed(0)}%  (${o.trades} trades, ${o.winPct.toFixed(0)}% won, ${o.callsPerDecision.toFixed(2)} calls per decision)`)
    }
  }
}
