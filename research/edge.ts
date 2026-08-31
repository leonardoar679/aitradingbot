// WHERE THE MONEY ACTUALLY COMES FROM, TERM BY TERM.
//
// Every other script in this folder scores a MONTH. This one scores a TRADE, because the monthly
// figures answer "did it work" and this one answers "why", and a reader who cannot see the second
// has no way to judge whether the first will keep happening.
//
// The whole claim of a trend follower fits in one identity. Over N round trips with win rate p,
// mean winning return W and mean losing return L (both as a percentage of the capital the trade
// started with, both AFTER costs):
//
//     expectancy per trade  =  p * W  -  (1 - p) * L
//
// It is profitable when p*W > (1-p)*L, which rearranges to a break-even win rate:
//
//     p*  =  L / (W + L)
//
// That is the number to look at. These strategies win WELL UNDER HALF their trades, and it does
// not matter, because a stop-less trend exit cuts L short and lets W run. A rule that wins 30% of
// the time with W/L = 3 has p* = 25% and clears it; the same rule with W/L = 1.2 has p* = 45% and
// does not. Nothing else in this repository changes that arithmetic -- the lookbacks, the vote,
// the hysteresis band and the bar size are all just ways of moving p, W, L and N.
//
// COSTS ENTER AS N, WHICH IS WHY N IS A DESIGN CONSTRAINT AND NOT AN OUTCOME. A round trip pays
// 0.1% per side (shared/fees.ts FEE_RATE) plus 2bps per fill of slippage, so 0.24% leaves the
// account every time the rule changes its mind. Expectancy is per trade but the fee is per trade
// too, so the fee does not shrink by trading less -- what shrinks is the TOTAL, N * 0.24%. The
// column below that matters most is therefore the gross-to-net gap: how much of what the rule
// found was handed straight back.
//
// SLIPPAGE IS NOT RECOVERABLE FROM A CLOSED TRADE and is not broken out here. The engine applies
// it to the fill PRICES (buyFillPrice/sellFillPrice), so by the time a Trade exists it is already
// inside entryPrice and exitPrice and cannot be added back. The fee can, because it is charged on
// the notional separately. So "gross" below means before fees and after slippage, which is stated
// rather than rounded off, and the real gross is a further ~0.04% per trade above it.
//
// Same window, same symbols and same per-strategy intervals as research/shipped.ts, so the two
// scripts describe the same runs from two directions -- shipped.ts by month, this one by trade.
// The one deliberate difference: shipped.ts scores 65 INDEPENDENT months, this one runs the
// window continuously, because a trade cut in half by a month boundary is not a trade.
//
//   npx esbuild research/edge.ts --bundle --platform=node --format=esm --outfile=research/.edge.mjs
//   node research/.edge.mjs

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import type { Trade } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { shortTermChannelRegime } from '../src/backtest/strategies/shortTermChannelRegime'
import { trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import type { StrategyDefinition } from '../src/backtest/strategies/types'
import { FEE_RATE } from '../shared/fees'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT']
const DEFS: StrategyDefinition[] = [trendRegimeEnsemble, shortTermChannel, shortTermChannelRegime]

const FROM = Date.UTC(2021, 3, 1) / 1000
const TO = Date.UTC(2026, 7, 1) / 1000

const IV_SECONDS: Record<string, number> = { '15m': 900, '1h': 3600, '4h': 14_400, '1d': 86_400 }

function load(symbol: string, interval: string): Candle[] {
  const raw = JSON.parse(readFileSync(join(DIR, symbol + '-' + interval + '.json'), 'utf-8')) as number[][]
  return raw.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
}

/** The window, plus exactly the lead the strategy declares it needs. A window sliced without the
 * lead spends its first 80 days flat and reports that as the strategy finding nothing. */
function window(candles: Candle[], lead: number): Candle[] {
  const start = candles.findIndex((c) => c.time >= FROM)
  if (start < 0) return []
  const end = candles.findIndex((c) => c.time >= TO)
  return candles.slice(Math.max(0, start - lead), end < 0 ? candles.length : end)
}

/** Capital the trade opened with, reconstructed from the position rather than from pnl/returnPct.
 * At 1x spot the account bought qty at entryPrice and paid the entry fee out of the same cash, so
 * this is exact -- and dividing pnl by returnPct, the obvious alternative, is a division by
 * roughly zero on any trade that finished flat. */
const cashBefore = (t: Trade): number => t.qty * t.entryPrice * (1 + FEE_RATE)

/** Round-trip fee as a percentage of that capital. Recoverable because the fee is charged on the
 * notional; slippage is not, being already inside the two prices. */
const feePct = (t: Trade): number => ((t.qty * t.entryPrice + t.qty * t.exitPrice) * FEE_RATE * 100) / cashBefore(t)

const sum = (v: number[]): number => v.reduce((a, b) => a + b, 0)
const avg = (v: number[]): number => (v.length ? sum(v) / v.length : NaN)

interface Edge {
  trades: number
  winRate: number
  avgWin: number
  avgLoss: number
  payoff: number
  expectancy: number
  breakEven: number
  grossExpectancy: number
  feeDrag: number
  medianHoldDays: number
  timeInMarket: number
  /** Share of all gross gains contributed by the five largest winners, pooled across symbols. */
  topFiveShare: number
  stopped: number
}

function edge(trades: Trade[], barsHeld: number, barsTotal: number): Edge {
  const wins = trades.filter((t) => t.returnPct > 0).map((t) => t.returnPct)
  const losses = trades.filter((t) => t.returnPct <= 0).map((t) => -t.returnPct)
  const W = avg(wins)
  const L = avg(losses)
  const p = wins.length / trades.length
  const gains = [...wins].sort((a, b) => b - a)
  return {
    trades: trades.length,
    winRate: p * 100,
    avgWin: W,
    avgLoss: L,
    payoff: W / L,
    expectancy: p * W - (1 - p) * L,
    breakEven: (L / (W + L)) * 100,
    grossExpectancy: avg(trades.map((t) => t.returnPct + feePct(t))),
    feeDrag: avg(trades.map(feePct)),
    medianHoldDays: median(trades.map((t) => (t.exitTime - t.entryTime) / 86_400)),
    timeInMarket: (barsHeld / barsTotal) * 100,
    topFiveShare: (sum(gains.slice(0, 5)) / sum(gains)) * 100,
    stopped: trades.filter((t) => t.exitReason === 'stop_loss').length
  }
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  const h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

const pc = (v: number, d = 2): string => (v >= 0 ? '+' : '') + v.toFixed(d) + '%'

console.log('THE PROFIT EQUATION, MEASURED PER TRADE')
console.log('expectancy = p*W - (1-p)*L, break-even win rate p* = L / (W + L)')
console.log(SYMBOLS.map((s) => s.replace('USDT', '')).join(' ') + ', 2021-04 -> 2026-08, run continuously')
console.log('W and L are net of fees; "gross" adds the fee back but NOT the slippage already in the prices\n')

const rows: Array<[StrategyDefinition, Edge]> = []

for (const def of DEFS) {
  const iv = def.preferredInterval
  const barSeconds = IV_SECONDS[iv]
  const lead = def.warmupBarsFor(barSeconds)
  const all: Trade[] = []
  let held = 0
  let total = 0

  for (const sym of SYMBOLS) {
    const candles = window(load(sym, iv), lead)
    if (candles.length <= lead) continue
    const r = runBacktest(candles, def.id, { startingBalance: 10_000 })
    all.push(...r.trades)
    // Bars a position was actually open, counted from the trades themselves rather than from the
    // equity curve, so a strategy that is flat and a strategy that is warming up are not summed
    // into the same "not trading" number.
    held += sum(r.trades.map((t) => (t.exitTime - t.entryTime) / barSeconds))
    total += candles.length - lead
  }

  rows.push([def, edge(all, held, total)])
}

const H = 'strategy'.padEnd(40) + 'N'.padStart(6) + 'p'.padStart(8) + 'W'.padStart(9) + 'L'.padStart(8) +
  'W/L'.padStart(7) + 'p*'.padStart(8) + 'E[trade]'.padStart(10) + 'gross E'.padStart(10) + 'fee'.padStart(8)
console.log(H)
console.log('-'.repeat(H.length))
for (const [def, e] of rows) {
  console.log(
    (def.name + ' (' + def.preferredInterval + ')').padEnd(40) +
    String(e.trades).padStart(6) + (e.winRate.toFixed(1) + '%').padStart(8) +
    pc(e.avgWin, 1).padStart(9) + ('-' + e.avgLoss.toFixed(1) + '%').padStart(8) +
    e.payoff.toFixed(2).padStart(7) + (e.breakEven.toFixed(1) + '%').padStart(8) +
    pc(e.expectancy, 2).padStart(10) + pc(e.grossExpectancy, 2).padStart(10) +
    ('-' + e.feeDrag.toFixed(2) + '%').padStart(8)
  )
}

console.log('\nWHAT THE EDGE DEPENDS ON')
const H2 = 'strategy'.padEnd(40) + 'trades/yr'.padStart(11) + 'median hold'.padStart(13) +
  'in market'.padStart(11) + 'top 5 wins'.padStart(12) + 'stopped out'.padStart(13)
console.log(H2)
console.log('-'.repeat(H2.length))
const YEARS = (TO - FROM) / (365.25 * 86_400)
for (const [def, e] of rows) {
  console.log(
    (def.name + ' (' + def.preferredInterval + ')').padEnd(40) +
    (e.trades / SYMBOLS.length / YEARS).toFixed(1).padStart(11) +
    (e.medianHoldDays.toFixed(1) + ' d').padStart(13) +
    (e.timeInMarket.toFixed(0) + '%').padStart(11) +
    (e.topFiveShare.toFixed(0) + '%').padStart(12) +
    String(e.stopped).padStart(13)
  )
}

// The sentence a reader will quote, printed by the code so it cannot drift from the table.
console.log('')
for (const [def, e] of rows) {
  console.log(
    def.name + ': wins ' + e.winRate.toFixed(0) + '% of trades and needs ' + e.breakEven.toFixed(0) +
    '% to break even, so the margin is ' + (e.winRate - e.breakEven).toFixed(0) +
    ' points of win rate, bought with a ' + e.payoff.toFixed(1) + ':1 payoff.'
  )
}
console.log('')
console.log('The fee column is per trade. Multiply it by trades/yr to see the annual drag, which is the')
console.log('number the trade budget exists to hold down: the same edge taken twice as often earns the')
console.log('same expectancy per trade and pays twice the fee.')
