import type { Candle } from '../shared/ipc'
import type { StrategyDefinition, StrategySignals } from '../src/backtest/strategies/types'
import { load, register, run, table } from './harness'
import { regimeAgreement, REGIME_VOTE } from '../src/backtest/strategies/trendRegimeEnsemble'

// What the hysteresis band in Trend Regime is actually worth.
//
// STRATEGIES.md section 2 claimed "closing Trend Regime's gap -- entering AND exiting at half the
// votes -- drops it from +150% to +24% and multiplies the fee bill by five". That claim had no
// script behind it anywhere in this folder: it could not be reproduced, only believed. This is the
// missing measurement, and it disagreed with the sentence it was written to check.
//
// The variant reads regimeAgreement() -- the SAME vote the shipped strategy acts on, exported for
// exactly this reason -- and only changes where the two thresholds sit. So the difference measured
// here is the band and nothing else: same lookbacks, same data, same engine, same disaster stop.

const SECONDS_PER_DAY = 86_400

/** Trend Regime with the two vote thresholds moved. At enter === exit the band is closed and every
 * wobble across the line is a round trip; that is the case this file exists to price. */
function voteAt(enterAt: number, exitAt: number, barSeconds: number): StrategyDefinition {
  const barsPerDay = SECONDS_PER_DAY / barSeconds
  const warm = Math.max(...REGIME_VOTE.lookbackDays.map((d) => Math.max(2, Math.round(d * barsPerDay))))
  return {
    id: `x-gap-${enterAt}-${exitAt}-${barSeconds}`,
    name: 'gap',
    description: '',
    preferredInterval: '4h',
    warmupBarsFor: () => warm,
    generateSignals(candles: Candle[]): StrategySignals {
      const agree = regimeAgreement(candles, barSeconds)
      const n = candles.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      for (let i = warm; i < n; i++) {
        // Same 50% disaster stop the shipped file uses: the regime exit controls risk, and the
        // engine refuses to open a position with a null stop price.
        if (agree[i] >= enterAt) { entries[i] = true; stopPrices[i] = candles[i].close * 0.5 }
        if (agree[i] <= exitAt) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: warm }
    }
  }
}

const BAR = 4 * 3600
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']

console.log('CLOSING THE VOTE GAP, BTCUSDT/ETHUSDT/SOLUSDT 4h, full history')
console.log(`shipped band: enter at ${REGIME_VOTE.enterAt} of the vote, exit at ${REGIME_VOTE.exitAt}`)
console.log('closed band:  enter and exit both at half the votes\n')

for (const sym of SYMBOLS) {
  const candles = load(sym, '4h')
  const shipped = register(voteAt(REGIME_VOTE.enterAt, REGIME_VOTE.exitAt, BAR))
  const closed = register(voteAt(0.5, 0.5, BAR))
  table([
    run(candles, shipped, `${sym} 4h  shipped band (${REGIME_VOTE.enterAt}/${REGIME_VOTE.exitAt})`),
    run(candles, closed, `${sym} 4h  closed band (0.5/0.5)`)
  ])
  console.log('')
}

console.log('The band is not a tuning parameter. Closing it leaves the same signal on the same')
console.log('data and only removes the requirement that price travel the whole width of the band')
console.log('before the decision can reverse -- so every wobble across the line becomes a round')
console.log('trip, and the fee column is where that lands.')
