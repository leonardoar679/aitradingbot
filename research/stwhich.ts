import type { Candle } from '../shared/ipc'
import { load, run, padWarmup, register } from './harness'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'

/** Which of the two shipped trend strategies is the right tool, per symbol.
 *
 * Both are padded to the same 81-day lead so they trade the identical window against the same
 * benchmark -- without that the faster one silently gains ~72 extra days of tradeable history and
 * a different buy & hold to be measured against, which is the windowing trap this directory has
 * fallen into twice. */

const DAY = 86_400
const SYMS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'LTCUSDT', 'LINKUSDT', 'XRPUSDT', 'SOLUSDT']

for (const [tf, bs] of [['4h', 14_400], ['1d', 86_400]] as Array<[string, number]>) {
  const L = Math.round((81 * DAY) / bs) + 2
  const shortId = register(padWarmup(shortTermChannel, L))
  const slowId = register(padWarmup(trendRegimeEnsemble, L))
  console.log(`\n===== ${tf}, full history, both on the identical window =====`)
  console.log('symbol      SHORT net%    slow net%     b&h%    SHORT dd   slow dd   winner')
  console.log('-'.repeat(78))
  let shortWins = 0
  let slowWins = 0
  for (const sym of SYMS) {
    let all: Candle[]
    try { all = load(sym, tf) } catch { continue }
    if (all.length < L * 4) continue
    const a = run(all, shortId, sym)
    const b = run(all, slowId, sym)
    const winner = a.netPct > b.netPct ? 'SHORT' : 'slow'
    if (a.netPct > b.netPct) shortWins++
    else slowWins++
    console.log(
      sym.replace('USDT', '').padEnd(8) +
        a.netPct.toFixed(0).padStart(10) +
        b.netPct.toFixed(0).padStart(13) +
        a.bhPct.toFixed(0).padStart(10) +
        a.maxDdPct.toFixed(0).padStart(11) +
        b.maxDdPct.toFixed(0).padStart(10) +
        '   ' + winner
    )
  }
  console.log(`\n  SHORT wins ${shortWins}, slow wins ${slowWins}`)
}
