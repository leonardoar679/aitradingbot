// WHAT EACH MEASURED STRATEGY MAKES A TRADE, through the shipped engine, for the health reading.
//
// src/backtest/marketConditions.ts carries, beside the two monthly means the Market Conditions
// card prints, what each strategy made a trade: its profit factor, win rate and mean hold. Those
// are what a bot's dry run is set against (shared/strategyHealth.ts) once it has thirty closed
// trades of its own. This file is where they come from, so that they can be re-measured when a
// strategy or the engine changes.
//
// The same six symbols that took no part in choosing the strategies (DOGE, TRX, ETC, XLM, VET,
// EOS), the same 84 months research/expect.ts measures (September 2019 to August 2026), each
// strategy at the interval it ships on, read from the definition. One CONTINUOUS run a symbol, as a
// bot's dry run is, rather than research/expect.ts's independent months: a hold that spans a month
// end is one trade here, as it is on a bot. An open position at the end is not a trade.
//
//   npx esbuild research/tradeexpect.ts --bundle --platform=node --format=esm --outfile=research/.tradeexpect.mjs
//   node research/.tradeexpect.mjs
//
// 8 October 2026:
//   trend-regime-ensemble @ 4h:       322 trades, PF 4.37, win rate 24.5%, mean hold 409 h
//   short-term-channel @ 15m:        1039 trades, PF 1.80, win rate 33.5%, mean hold 106 h
//   short-term-channel-regime @ 15m:  583 trades, PF 2.34, win rate 35.2%, mean hold 114 h

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { getStrategy } from '../src/backtest/strategies'
import { MEASURED_EXPECTATIONS } from '../src/backtest/marketConditions'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const SYMBOLS = (process.env.SYMBOLS || 'DOGEUSDT,TRXUSDT,ETCUSDT,XLMUSDT,VETUSDT,EOSUSDT').split(',')
const START = Date.UTC(2019, 8, 1) / 1000
const END = Date.UTC(2026, 8, 1) / 1000

function load(symbol: string, interval: string): Candle[] {
  const rows = JSON.parse(readFileSync(join(DIR, `${symbol}-${interval}.json`), 'utf-8')) as number[][]
  return rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] })).filter((c) => c.time >= START && c.time < END)
}

console.log('WHAT EACH STRATEGY MAKES A TRADE, one continuous run a symbol, held-out symbols, at its own interval')
for (const shipped of MEASURED_EXPECTATIONS) {
  const strategy = getStrategy(shipped.strategyId)
  const interval = strategy.preferredInterval
  let wins = 0
  let gross = 0
  let loss = 0
  let hold = 0
  let count = 0
  for (const symbol of SYMBOLS) {
    const result = runBacktest(load(symbol, interval), strategy.id, { forceCloseAtEnd: false })
    for (const trade of result.trades) {
      if (trade.exitReason === 'end_of_data') continue
      if (trade.returnPct > 0) {
        wins++
        gross += trade.returnPct
      } else loss -= trade.returnPct
      hold += (trade.exitTime - trade.entryTime) / 3600
      count++
    }
  }
  const measured = { trades: count, profitFactor: loss > 0 ? gross / loss : Infinity, winRatePct: (wins / count) * 100, meanHoldHours: hold / count }
  console.log(`${strategy.id.padEnd(28)} @ ${interval.padEnd(4)} ${String(count).padStart(5)} trades, PF ${measured.profitFactor.toFixed(2)}, win rate ${measured.winRatePct.toFixed(1)}%, mean hold ${measured.meanHoldHours.toFixed(0)} h`)
  const s = shipped.trades
  const same = s.trades === count && Math.abs(s.profitFactor - measured.profitFactor) < 0.01 && Math.abs(s.winRatePct - measured.winRatePct) < 0.1 && Math.abs(s.meanHoldHours - measured.meanHoldHours) < 1
  console.log(`   shipped: ${s.trades} trades, PF ${s.profitFactor.toFixed(2)}, win rate ${s.winRatePct.toFixed(1)}%, hold ${s.meanHoldHours} h -- ${same ? 'as shipped' : 'DIFFERS: update src/backtest/marketConditions.ts'}`)
}
