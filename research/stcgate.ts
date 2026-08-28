// DOES THE SHIPPED FILE REPRODUCE THE RESULT IT WAS SHIPPED FOR?
//
// research/chop.ts measured the volatility gate as a WRAPPER around shortTermChannel: it narrowed
// `entries` and left the declared warmup alone. The shipped version cannot do that -- a strategy
// whose entry rule needs 30 days of history has to DECLARE 30 days, or every caller fetches 8,
// the gate can never see, and it silently blocks every entry (the failure mode types.ts describes
// at length). So the shipped file raises warmupBars, which means the thing that ships is not
// bit-identical to the thing that was measured.
//
// That difference has to be measured, not assumed away. A longer warmup moves the engine's buy &
// hold anchor and the first tradeable bar, and either could flatter or flatten the result.
//
// This compares the PRE-GATE strategy against the SHIPPED one on the identical window, with both
// pinned to the same warmup so neither gains days the other does not have. If the shipped file's
// numbers do not carry the same conclusion as chop.ts, the conclusion is wrong and not the file.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'
import { shortTermChannel, channelPosition } from '../src/backtest/strategies/shortTermChannel'
import { inferBarSeconds } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const CAPITAL = 10_000
const DAY = 86_400
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,LINKUSDT,LTCUSDT').split(',')
const INTERVALS = (process.env.INTERVALS || '1h,4h').split(',')

const WINDOWS: Array<[string, number, number]> = [
  ['DESIGN 2017-01 -> 2021-12', Date.parse('2017-01-01T00:00:00Z') / 1000, Date.parse('2022-01-01T00:00:00Z') / 1000],
  ['HOLDOUT 2022-01 -> 2026-08', Date.parse('2022-01-01T00:00:00Z') / 1000, Date.parse('2026-08-27T00:00:00Z') / 1000]
]

const cache = new Map<string, Candle[]>()
function load(symbol: string, interval: string): Candle[] | null {
  const key = symbol + interval
  const hit = cache.get(key)
  if (hit) return hit
  try {
    const rows = JSON.parse(readFileSync(join(DIR, symbol + '-' + interval + '.json'), 'utf-8')) as number[][]
    const out: Candle[] = rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
    cache.set(key, out)
    return out
  } catch {
    return null
  }
}

/** The strategy exactly as it was BEFORE the gate: channel position only, nothing else. Written
 * out rather than reconstructed by disabling the gate, so this is a real second opinion about
 * what the old file did and not a re-reading of the new one. */
const LEGACY_LOOKBACKS = [2, 3, 5, 8]
const legacy: StrategyDefinition = {
  id: 'stc-legacy-no-gate',
  name: 'Short-Term Channel (pre-gate)',
  description: 'The shipped strategy before the volatility gate was added.',
  warmupBarsFor: (barSeconds) =>
    barSeconds > 0 ? Math.max(...LEGACY_LOOKBACKS.map((d) => Math.max(2, Math.round(d * (DAY / barSeconds))))) + 1 : 0,
  generateSignals(candles: Candle[]) {
    const n = candles.length
    const entries = new Array<boolean>(n).fill(false)
    const exits = new Array<boolean>(n).fill(false)
    const stopPrices = new Array<number | null>(n).fill(null)
    const barSeconds = inferBarSeconds(candles)
    if (barSeconds <= 0) return { entries, exits, stopPrices, warmupBars: n }
    const perDay = DAY / barSeconds
    const periods = LEGACY_LOOKBACKS.map((d) => Math.max(2, Math.round(d * perDay)))
    const warmupBars = Math.max(...periods) + 1
    const pos = channelPosition(candles, periods)
    for (let i = warmupBars; i < n; i++) {
      const p = pos[i]
      if (!Number.isFinite(p)) continue
      if (p >= 0.95) {
        entries[i] = true
        stopPrices[i] = candles[i].close * 0.5
      }
      if (p <= 0.25) exits[i] = true
    }
    return { entries, exits, stopPrices, warmupBars }
  }
}
STRATEGIES.push(legacy)

interface Res {
  net: number
  dd: number
  trades: number
}

/** Both variants pinned to the SAME warmup -- the wider of the two -- so the comparison is one. */
function runWindow(symbol: string, interval: string, id: string, from: number, to: number): Res | null {
  const all = load(symbol, interval)
  if (!all) return null
  const barSeconds = all.length > 2 ? all[2].time - all[1].time : 0
  if (barSeconds <= 0) return null
  const warmup = Math.max(
    shortTermChannel.warmupBarsFor(barSeconds),
    legacy.warmupBarsFor(barSeconds)
  )
  const found = all.findIndex((c) => c.time >= from)
  const last = all.findIndex((c) => c.time >= to)
  if (found < 0) return null
  const start = Math.max(found, warmup)
  const slice = all.slice(start - warmup, last < 0 ? all.length : last)
  if (slice.length < warmup + 20) return null
  const r = runBacktest(slice, id, { startingBalance: CAPITAL })
  return { net: r.stats.totalNetProfitPct, dd: r.stats.maxDrawdownPct, trades: r.stats.totalClosedTrades }
}

const pc = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
const median = (v: number[]): number => {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

for (const interval of INTERVALS) {
  console.log('\n\n############ Short-Term Channel -- ' + interval + ' -- shipped file vs pre-gate ############\n')
  console.log(
    'window'.padEnd(28) + 'variant'.padEnd(12) + 'median'.padStart(11) + 'worst'.padStart(11) +
      'losers'.padStart(9) + 'median DD'.padStart(12) + 'trades'.padStart(9)
  )
  console.log('-'.repeat(92))
  for (const [wlabel, from, to] of WINDOWS) {
    for (const [vlabel, id] of [['pre-gate', legacy.id], ['SHIPPED', shortTermChannel.id]] as Array<[string, string]>) {
      const rows = SYMBOLS.map((s) => runWindow(s, interval, id, from, to)).filter((r): r is Res => r !== null)
      if (rows.length === 0) {
        console.log(wlabel.padEnd(28) + vlabel.padEnd(12) + 'no data'.padStart(11))
        continue
      }
      const nets = rows.map((r) => r.net)
      console.log(
        wlabel.padEnd(28) + vlabel.padEnd(12) +
          pc(median(nets)).padStart(11) + pc(Math.min(...nets)).padStart(11) +
          (nets.filter((n) => n < 0).length + '/' + nets.length).padStart(9) +
          pc(median(rows.map((r) => r.dd))).padStart(12) +
          median(rows.map((r) => r.trades)).toFixed(0).padStart(9)
      )
    }
    console.log('')
  }
}
