import type { Candle } from '../shared/ipc'
import type { StrategyDefinition, StrategySignals } from '../src/backtest/strategies/types'
import { load, segment, run, table, padWarmup, register, SPLIT_AT, type Row } from './harness'
import { shortTermChannel, channelPosition } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import { sma } from './families'

/** Can the two shipped strategies be combined into something better than either?
 *
 * The 50/50 blend already failed -- it lands between them on return and is never best on
 * return-per-drawdown, because two long-only trend strategies on the same asset are correlated,
 * not complementary. This tests the idea the evidence actually points at instead: the FAST
 * strategy's weakness is bear-market whipsaw, and the SLOW strategy's regime vote is exactly a
 * bear detector. Combining them as a FILTER rather than as a portfolio introduces no new
 * parameter -- it is an AND of two signals that already ship. */

const DAY = 86_400
const SLOW_DAYS = [20, 30, 50, 80]
const FAST_DAYS = [2, 3, 5, 8]
const lead = (bs: number, d: number) => Math.round((d * DAY) / bs) + 2

function barSecondsOf(candles: Candle[]): number {
  const gaps: number[] = []
  for (let i = 1; i < Math.min(candles.length, 200); i++) gaps.push(candles[i].time - candles[i - 1].time)
  gaps.sort((a, b) => a - b)
  return gaps[Math.floor(gaps.length / 2)] || 900
}

/** Fraction of the slow lookbacks that currently call the trend up. This is trendRegimeEnsemble's
 * own regime measure, reused rather than reinvented. */
function slowVote(candles: Candle[], barSeconds: number): number[] {
  const closes = candles.map((c) => c.close)
  const periods = SLOW_DAYS.map((d) => Math.max(2, Math.round((d * DAY) / barSeconds)))
  const mas = periods.map((p) => sma(closes, p))
  return closes.map((c, i) => {
    let v = 0
    for (const ma of mas) if (Number.isFinite(ma[i]) && c > ma[i]) v++
    return v / periods.length
  })
}

/** The fast channel strategy, but only allowed to enter while at least `minVote` of the slow
 * lookbacks agree the trend is up. Exits are unchanged, plus a forced exit if the regime fails
 * entirely -- being in a position the regime no longer supports is the case this exists to fix. */
function fastFilteredBySlow(minVote: number, exitOnRegimeLoss: boolean): StrategyDefinition {
  return {
    id: `x-ffs-${minVote}-${exitOnRegimeLoss}`,
    name: 'fast filtered by slow regime',
    description: '',
    warmupBarsFor: (bs) => Math.round((80 * DAY) / bs) + 2,
    generateSignals(candles: Candle[]): StrategySignals {
      const bs = barSecondsOf(candles)
      const warm = Math.round((80 * DAY) / bs) + 2
      const periods = FAST_DAYS.map((d) => Math.max(2, Math.round((d * DAY) / bs)))
      const pos = channelPosition(candles, periods)
      const vote = slowVote(candles, bs)
      const n = candles.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      for (let i = warm; i < n; i++) {
        const p = pos[i]
        if (!Number.isFinite(p)) continue
        if (p >= 0.95 && vote[i] >= minVote) {
          entries[i] = true
          stopPrices[i] = candles[i].close * 0.5
        }
        if (p <= 0.25 || (exitOnRegimeLoss && vote[i] <= 0.25)) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: warm }
    }
  }
}

/** The slow strategy's entry, the fast strategy's exit -- hold only while the slow regime says
 * so, but leave the moment price falls out of its short-term channel instead of waiting for
 * three of four slow lookbacks to turn. Tests whether the slow strategy's drawdown comes from
 * exiting late. */
function slowEntryFastExit(): StrategyDefinition {
  return {
    id: 'x-sefe',
    name: 'slow entry, fast exit',
    description: '',
    warmupBarsFor: (bs) => Math.round((80 * DAY) / bs) + 2,
    generateSignals(candles: Candle[]): StrategySignals {
      const bs = barSecondsOf(candles)
      const warm = Math.round((80 * DAY) / bs) + 2
      const periods = FAST_DAYS.map((d) => Math.max(2, Math.round((d * DAY) / bs)))
      const pos = channelPosition(candles, periods)
      const vote = slowVote(candles, bs)
      const n = candles.length
      const entries = new Array<boolean>(n).fill(false)
      const exits = new Array<boolean>(n).fill(false)
      const stopPrices = new Array<number | null>(n).fill(null)
      for (let i = warm; i < n; i++) {
        if (vote[i] >= 1) { entries[i] = true; stopPrices[i] = candles[i].close * 0.5 }
        if (Number.isFinite(pos[i]) && pos[i] <= 0.25) exits[i] = true
      }
      return { entries, exits, stopPrices, warmupBars: warm }
    }
  }
}

const CANDIDATES: Array<[string, StrategyDefinition]> = [
  ['slow (shipped)      ', trendRegimeEnsemble],
  ['fast (shipped)      ', shortTermChannel],
  ['fast + regime>=0.50 ', fastFilteredBySlow(0.5, false)],
  ['fast + regime>=0.75 ', fastFilteredBySlow(0.75, false)],
  ['fast + regime=1.00  ', fastFilteredBySlow(1, false)],
  ['fast + rg>=.75 +exit', fastFilteredBySlow(0.75, true)],
  ['slow entry fast exit', slowEntryFastExit()]
]

function scoreAll(all: Candle[], bs: number, label: string, from?: number, to?: number): Row[] {
  const L = lead(bs, 81)
  const cs = from !== undefined && to !== undefined ? segment(all, from, to, L) : all
  if (cs.length < L * 3) return []
  const rows: Row[] = []
  for (const [name, def] of CANDIDATES) {
    rows.push(run(cs, register(padWarmup(def, L)), `${name} ${label}`))
  }
  return rows
}

const TRAIN_FROM = Date.parse('2023-08-27T00:00:00Z') / 1000
const OOS_FROM = Date.parse('2017-08-17T00:00:00Z') / 1000
const OOS_TO = Date.parse('2023-08-27T00:00:00Z') / 1000
const END = Date.parse('2026-08-27T00:00:00Z') / 1000

console.log('########## TRAINING WINDOW 2023-08 > 2025-08 (where any choice is allowed) ##########')
for (const [sym, tf, bs] of [['BTCUSDT', '4h', 14_400], ['ETHUSDT', '4h', 14_400], ['SOLUSDT', '4h', 14_400]] as Array<[string, string, number]>) {
  const rows = scoreAll(load(sym, tf), bs, '', TRAIN_FROM, SPLIT_AT)
  if (rows.length) { console.log(`\n--- ${sym} ${tf} ---`); table(rows) }
}

console.log('\n\n########## HELD-OUT YEAR 2025-08 > 2026-08 ##########')
for (const [sym, tf, bs] of [['BTCUSDT', '4h', 14_400], ['ETHUSDT', '4h', 14_400], ['SOLUSDT', '4h', 14_400]] as Array<[string, string, number]>) {
  const rows = scoreAll(load(sym, tf), bs, '', SPLIT_AT, END)
  if (rows.length) { console.log(`\n--- ${sym} ${tf} ---`); table(rows) }
}

console.log('\n\n########## TRUE OUT-OF-SAMPLE 2017-08 > 2023-08 ##########')
for (const [sym, tf, bs] of [['BTCUSDT', '4h', 14_400], ['ETHUSDT', '4h', 14_400], ['BTCUSDT', '1h', 3600], ['ETHUSDT', '1h', 3600]] as Array<[string, string, number]>) {
  const rows = scoreAll(load(sym, tf), bs, '', OOS_FROM, OOS_TO)
  if (rows.length) { console.log(`\n--- ${sym} ${tf} ---`); table(rows) }
}
