import type { Candle } from '../shared/ipc'
import { GPT_LOOKBACK_BARS, GPT_PROMPT_VERSION, type AiSignalTape } from '../shared/aiSignal'
import { generateGptIntradaySignals } from '../src/backtest/strategies/gptIntraday'
import { runBacktest } from '../src/backtest/engine'
import { register } from './harness'
import { load } from './harness'
import type { StrategyDefinition } from '../src/backtest/strategies/types'

// HOW GOOD WOULD GPT HAVE TO BE?
//
// The paid backtest cannot answer this cheaply: 672 decisions is seven days, which is far too
// short a sample to separate a real edge from noise, and it costs money to find that out. This
// answers the prior question for free -- what accuracy and what selectivity would ANY 15-minute
// signal source need before this strategy makes money at all?
//
// It is the section 1 argument from STRATEGIES.md applied to GPT Intraday: a round trip costs
// 0.24%, so a signal is only worth acting on if p*W exceeds (1-p)*L by more than that, and asking
// more often multiplies the fee without changing the per-trade expectancy.
//
// The signal is synthetic, deliberately. A tape is built with two knobs:
//
//   ACCURACY   how often the emitted action agrees with what actually happened next
//   ACT RATE   how often it emits anything at all rather than hold
//
// and everything downstream is the REAL machinery -- the shipped generateGptIntradaySignals, the
// shipped engine, the shipped fees and the shipped 1.5x ATR stop. So the numbers below are what
// this strategy would do given a signal of that quality, not what some other model would do.
//
// Accuracy 0.50 is a coin flip and must lose roughly the fee bill. Anything the sweep shows above
// zero is the bar GPT has to clear.

const HORIZON_BARS = 16 // 4 hours: the window an intraday call is implicitly predicting
const CONFIDENCE = 0.9 // above GPT_MIN_CONFIDENCE, so acting decisions act

/** Deterministic RNG. A sweep that reshuffles between cells is comparing noise, not settings. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** What a perfect call at bar `i` would have been, long-only: buy if the next HORIZON_BARS rise. */
function oracleAction(candles: Candle[], i: number): 'buy' | 'sell' {
  const end = Math.min(candles.length - 1, i + HORIZON_BARS)
  return candles[end].close > candles[i].close ? 'buy' : 'sell'
}

function syntheticTape(candles: Candle[], accuracy: number, actRate: number, seed: number): AiSignalTape {
  const rng = mulberry32(seed)
  const decisions: AiSignalTape['decisions'] = []
  for (let i = GPT_LOOKBACK_BARS; i < candles.length; i++) {
    let recommendation: 'buy' | 'sell' | 'hold' = 'hold'
    if (rng() < actRate) {
      const truth = oracleAction(candles, i)
      const right = rng() < accuracy
      recommendation = right ? truth : truth === 'buy' ? 'sell' : 'buy'
    }
    decisions.push({
      candleTime: candles[i].time,
      recommendation,
      confidence: CONFIDENCE,
      rationale: '',
      model: 'synthetic',
      cached: false,
      error: null
    })
  }
  return {
    promptVersion: GPT_PROMPT_VERSION,
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: '15m',
    decisions,
    cachedCount: 0,
    generatedCount: decisions.length,
    errorCount: 0
  }
}

const candles = load('BTCUSDT', '15m').slice(-105_216) // ~3 years of 15m bars
const ACCURACIES = [0.5, 0.55, 0.6, 0.65, 0.7, 0.8, 1.0]
const ACT_RATES = [0.02, 0.05, 0.1, 0.25]

console.log('WHAT SIGNAL QUALITY WOULD GPT INTRADAY NEED?')
console.log(`BTCUSDT 15m, ${candles.length.toLocaleString()} bars (~3 years), real engine, real 0.24% round trip`)
console.log(`accuracy = how often the call matches the next ${HORIZON_BARS} bars; act rate = how often it is not "hold"`)
console.log('')
console.log('net % over the window, and trades taken')
console.log('')
process.stdout.write('accuracy'.padEnd(10))
for (const a of ACT_RATES) process.stdout.write(`act ${(a * 100).toFixed(0)}%`.padStart(20))
console.log('')
console.log('-'.repeat(10 + ACT_RATES.length * 20))

for (const acc of ACCURACIES) {
  process.stdout.write(`${(acc * 100).toFixed(0)}%`.padEnd(10))
  for (const rate of ACT_RATES) {
    const tape = syntheticTape(candles, acc, rate, 12345)
    const signals = generateGptIntradaySignals(candles, tape)
    const def: StrategyDefinition = {
      id: `x-gptneed-${acc}-${rate}`,
      name: 'gptneed',
      description: '',
      preferredInterval: '15m',
      warmupBarsFor: () => GPT_LOOKBACK_BARS,
      generateSignals: () => signals
    }
    const id = register(def)
    const r = runBacktest(candles, id, { startingBalance: 10_000 })
    const cell = `${r.stats.totalNetProfitPct >= 0 ? '+' : ''}${r.stats.totalNetProfitPct.toFixed(1)}% / ${r.stats.totalClosedTrades}`
    process.stdout.write(cell.padStart(20))
  }
  console.log('')
}

console.log('')
console.log('Read the 50% row first: that is a coin flip, and it is what paying the fee with no edge')
console.log('looks like. Every other row has to be judged against it, not against zero.')

// Where does it actually cross? The coarse grid puts it between 70% and 80%, which is a wide
// enough band to matter: 72% and 78% are very different claims about what a model can do.
console.log('')
console.log('THE CROSSING, FINER  (net % / trades / win rate / avg win : avg loss)')
console.log('')
process.stdout.write('accuracy'.padEnd(10))
for (const a of [0.02, 0.05]) process.stdout.write(`act ${(a * 100).toFixed(0)}%`.padStart(34))
console.log('')
console.log('-'.repeat(10 + 2 * 34))
for (const acc of [0.7, 0.72, 0.74, 0.76, 0.78, 0.8]) {
  process.stdout.write(`${(acc * 100).toFixed(0)}%`.padEnd(10))
  for (const rate of [0.02, 0.05]) {
    const tape = syntheticTape(candles, acc, rate, 12345)
    const signals = generateGptIntradaySignals(candles, tape)
    const id = register({
      id: `x-gptfine-${acc}-${rate}`,
      name: 'gptfine',
      description: '',
      preferredInterval: '15m',
      warmupBarsFor: () => GPT_LOOKBACK_BARS,
      generateSignals: () => signals
    })
    const r = runBacktest(candles, id, { startingBalance: 10_000 })
    const st = r.stats
    const ratio = st.avgLoss !== 0 ? Math.abs(st.avgWin / st.avgLoss) : 0
    const cell =
      `${st.totalNetProfitPct >= 0 ? '+' : ''}${st.totalNetProfitPct.toFixed(1)}% / ${st.totalClosedTrades} / ` +
      `${st.winRatePct.toFixed(0)}% / ${ratio.toFixed(2)}`
    process.stdout.write(cell.padStart(34))
  }
  console.log('')
}
// How many round trips does a real seven-day run even produce? That decides whether the paid
// backtest could tell any of these rows apart, and the answer is no.
const SEVEN_DAY_BARS = 672
for (const rate of [0.02, 0.05]) {
  const tape = syntheticTape(candles.slice(0, GPT_LOOKBACK_BARS + SEVEN_DAY_BARS), 0.75, rate, 12345)
  const window = candles.slice(0, GPT_LOOKBACK_BARS + SEVEN_DAY_BARS)
  const signals = generateGptIntradaySignals(window, tape)
  const id = register({
    id: `x-gptweek-${rate}`,
    name: 'gptweek',
    description: '',
    preferredInterval: '15m',
    warmupBarsFor: () => GPT_LOOKBACK_BARS,
    generateSignals: () => signals
  })
  const r = runBacktest(window, id, { startingBalance: 10_000 })
  console.log(
    `one seven-day run at 75% accuracy, act ${(rate * 100).toFixed(0)}%: ` +
      `${r.stats.totalClosedTrades} closed trades`
  )
}

console.log('')
console.log('WHAT THIS SAYS')
console.log('  Break-even sits near 75% accuracy at a 2% act rate and near 72% at 5%. Below that the')
console.log('  fee bill wins: a coin flip loses 89% to 100% of the account depending on how often it')
console.log('  trades, which is the cost floor doing exactly what section 1 of STRATEGIES.md says.')
console.log('')
console.log('  Trading more is not a way out. At a 25% act rate even 80% accuracy ends at -99.2%;')
console.log('  only perfect foresight survives that frequency. Expectancy per trade does not improve')
console.log('  with frequency, and the fee is charged every time.')
console.log('')
console.log('  The payoff ratio sits at 2.1-2.4 in every cell, because the 1.5x ATR stop caps the')
console.log('  losers and the sell signal caps the winners. By p* = L/(W+L) that needs a ~31% win')
console.log('  rate, and 31% is what the crossing rows measure. So this strategy cannot buy its')
console.log('  margin with payoff the way Trend Regime does at 6.5:1 -- it has to buy it with being')
console.log('  right, and ~72-75% directional accuracy on a 4-hour horizon is the price.')
console.log('')
console.log('  None of this says what GPT actually scores. It says what the target is, and that a')
console.log('  seven-day run produces too few round trips to locate a model anywhere on this table.')
