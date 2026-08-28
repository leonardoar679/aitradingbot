// WOULD A SHORT LEG ACTUALLY PAY? The only way a long-only strategy can PROFIT in a downtrend
// rather than merely avoid it is to sell it, so this measures that before any engine work.
//
// research/bear.ts established the shape of the problem: on daily data across eight symbols, both
// strategies are positive in every symbol's bull bars, roughly break-even in the deep-bear bars
// (Trend Regime's median contribution there is +8.5% while buy & hold's is around -90%), and lose
// in the CHOP band -- a median of -56.8%, negative on 6 of 8 symbols. In calendar terms that is
// 2022 at -32.5% median with all eight symbols losing, and 2025 at -7.1% with six of eight.
//
// THE SHORT RULE ADDS NO NEW CONSTANTS. It is each strategy's own entry and exit thresholds
// reflected through the middle, and nothing else:
//
//   Trend Regime      long while 4 of 4 averages agree, out at 1 of 4
//                     short while 0 of 4 agree,        cover at 3 of 4
//   Short-Term Channel long at channel position >= 0.95, out at <= 0.25
//                     short at <= 0.05,                 cover at >= 0.75
//
// That matters for what the result is worth. There is no parameter here that could have been
// fitted to the answer, so this can be read on all of history without burning a holdout -- there
// was never a choice to overfit. Anything that DID need a constant would have to be designed on
// 2017-2021 and scored once on 2022-2026, and is not in this file.
//
// WHAT IT COSTS, all charged pessimistically:
//   - both legs pay the 0.1% fee and 2bps of slippage, entry and exit, exactly as a long does;
//   - the short pays funding at ASSUMED_FUNDING_RATE as a COST. On a real perp a short usually
//     RECEIVES funding when the rate is positive, which is most of the time, so this is the wrong
//     sign on purpose -- it stands in for the borrow cost of a margin short and keeps the answer
//     from depending on a funding assumption that flatters it;
//   - the short carries the mirror of the strategy's own disaster stop, because an unstopped
//     short has unbounded loss and no honest backtest can offer one.
//
// VALIDATION FIRST. With the short leg disabled this simulator must reproduce runBacktest to the
// cent on every series, or nothing below is evidence. It prints the worst disagreement and stops
// if it is not zero.

import { readFileSync } from 'fs'
import { join } from 'path'
import { runBacktest } from '../src/backtest/engine'
import { shortTermChannel, channelPosition } from '../src/backtest/strategies/shortTermChannel'
import { trendRegimeEnsemble, rollingSma, inferBarSeconds } from '../src/backtest/strategies/trendRegimeEnsemble'
import { computeAtr } from '../src/backtest/strategies/emaCrossAtrStop'
import { buyFillPrice, sellFillPrice, FEE_RATE } from '../shared/fees'
import { ASSUMED_FUNDING_RATE, fundingPeriodsBetween } from '../shared/perp'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const CAPITAL = 10_000
const DAY = 86_400
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,LINKUSDT,LTCUSDT').split(',')
const INTERVAL = process.env.INTERVAL || '1d'

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

// ------------------------------------------------------------------------------- mirror signals

interface TwoSided {
  longEntry: boolean[]
  longExit: boolean[]
  longStop: (number | null)[]
  shortEntry: boolean[]
  shortExit: boolean[]
  shortStop: (number | null)[]
  warmupBars: number
}

const TR_LOOKBACKS = [20, 30, 50, 80]
const TR_ATR_PERIOD = 14
const TR_ATR_MULT = 10

function trendRegimeTwoSided(candles: Candle[]): TwoSided {
  const n = candles.length
  const blank = (): boolean[] => new Array<boolean>(n).fill(false)
  const nulls = (): (number | null)[] => new Array<number | null>(n).fill(null)
  const out: TwoSided = {
    longEntry: blank(), longExit: blank(), longStop: nulls(),
    shortEntry: blank(), shortExit: blank(), shortStop: nulls(),
    warmupBars: n
  }
  const barSeconds = inferBarSeconds(candles)
  if (barSeconds <= 0) return out

  const perDay = DAY / barSeconds
  const periods = TR_LOOKBACKS.map((d) => Math.max(2, Math.round(d * perDay)))
  const warmupBars = Math.max(...periods)
  const closes = candles.map((c) => c.close)
  const averages = periods.map((p) => rollingSma(closes, p))
  const atr = computeAtr(candles, TR_ATR_PERIOD)
  out.warmupBars = warmupBars

  for (let i = warmupBars; i < n; i++) {
    let votes = 0
    for (const ma of averages) if (closes[i] > ma[i]) votes++
    const agreement = votes / periods.length

    if (agreement >= 1) {
      out.longEntry[i] = true
      const stop = closes[i] - atr[i] * TR_ATR_MULT
      out.longStop[i] = Number.isFinite(stop) && stop > 0 ? stop : null
    }
    if (agreement <= 0.25) out.longExit[i] = true

    // The reflection: unanimity the other way opens a short, and three of four agreeing that the
    // trend is back up covers it.
    if (agreement <= 0) {
      out.shortEntry[i] = true
      const stop = closes[i] + atr[i] * TR_ATR_MULT
      out.shortStop[i] = Number.isFinite(stop) && stop > 0 ? stop : null
    }
    if (agreement >= 0.75) out.shortExit[i] = true
  }
  return out
}

const STC_LOOKBACKS = [2, 3, 5, 8]

function shortTermChannelTwoSided(candles: Candle[]): TwoSided {
  const n = candles.length
  const blank = (): boolean[] => new Array<boolean>(n).fill(false)
  const nulls = (): (number | null)[] => new Array<number | null>(n).fill(null)
  const out: TwoSided = {
    longEntry: blank(), longExit: blank(), longStop: nulls(),
    shortEntry: blank(), shortExit: blank(), shortStop: nulls(),
    warmupBars: n
  }
  const barSeconds = inferBarSeconds(candles)
  if (barSeconds <= 0) return out

  const perDay = DAY / barSeconds
  const periods = STC_LOOKBACKS.map((d) => Math.max(2, Math.round(d * perDay)))
  const warmupBars = Math.max(...periods) + 1
  const pos = channelPosition(candles, periods)
  out.warmupBars = warmupBars

  for (let i = warmupBars; i < n; i++) {
    const p = pos[i]
    if (!Number.isFinite(p)) continue
    if (p >= 0.95) {
      out.longEntry[i] = true
      out.longStop[i] = candles[i].close * 0.5
    }
    if (p <= 0.25) out.longExit[i] = true
    if (p <= 0.05) {
      out.shortEntry[i] = true
      // The mirror of "half the entry price": a 50% move against the short.
      out.shortStop[i] = candles[i].close * 1.5
    }
    if (p >= 0.75) out.shortExit[i] = true
  }
  return out
}

// ---------------------------------------------------------------------------------- simulator

interface Pos {
  dir: 1 | -1
  entryPrice: number
  entryTime: number
  qty: number
  cashBefore: number
  entryFee: number
  stopPrice: number
}

interface SimResult {
  finishing: number
  netPct: number
  curve: Array<{ time: number; value: number }>
  longTrades: number
  shortTrades: number
  shortPnl: number
  longPnl: number
  maxDdPct: number
  fees: number
}

/** Mirrors runBacktest at 1x with no trailing and no cooldown, plus an optional short leg.
 *
 * The exit ORDER is the engine's and is load-bearing: stop first, then the signal exit, then a
 * wiped-out equity. Reordering these changes which reason a bar exits for and therefore the fill
 * price it gets. */
function simulate(candles: Candle[], sig: TwoSided, allowShort: boolean): SimResult {
  let cash = CAPITAL
  let pos: Pos | null = null
  let totalFees = 0
  let longTrades = 0
  let shortTrades = 0
  let longPnl = 0
  let shortPnl = 0
  const curve: Array<{ time: number; value: number }> = []

  // SHORTS ONLY. The engine charges no funding at 1x because spot has none, and a long here is
  // the same spot long it simulates -- charging it would make this disagree with the engine on
  // the one leg where they must be identical. A short is not spot: it borrows, so it pays. The
  // validation gate below caught exactly this, as a uniform ~28% shortfall against the engine on
  // all sixteen series.
  const fundingSoFar = (p: Pos, time: number): number =>
    p.dir === -1 ? p.qty * p.entryPrice * ASSUMED_FUNDING_RATE * fundingPeriodsBetween(p.entryTime, time) : 0

  const equityAt = (price: number, time: number): number => {
    if (!pos) return cash
    return pos.cashBefore - pos.entryFee + pos.dir * pos.qty * (price - pos.entryPrice) - fundingSoFar(pos, time)
  }

  function close(time: number, referencePrice: number, isStop: boolean): void {
    if (!pos) return
    // A stop fill arrives already slipped, exactly as the engine does it, so the spread is never
    // charged twice on one exit.
    const price = isStop ? referencePrice : pos.dir === 1 ? sellFillPrice(referencePrice) : buyFillPrice(referencePrice)
    const exitFee = pos.qty * price * FEE_RATE
    totalFees += exitFee
    const raw = pos.dir * pos.qty * (price - pos.entryPrice) - pos.entryFee - exitFee - fundingSoFar(pos, time)
    const pnl = Math.max(raw, -pos.cashBefore)
    if (pos.dir === 1) {
      longTrades++
      longPnl += pnl
    } else {
      shortTrades++
      shortPnl += pnl
    }
    cash = pos.cashBefore + pnl
    pos = null
  }

  function open(dir: 1 | -1, time: number, price: number, stopPrice: number): void {
    if (cash <= 0) return
    const fill = dir === 1 ? buyFillPrice(price) : sellFillPrice(price)
    const fee = cash * FEE_RATE
    totalFees += fee
    pos = { dir, entryPrice: fill, entryTime: time, qty: (cash - fee) / fill, cashBefore: cash, entryFee: fee, stopPrice }
    cash = 0
  }

  for (let i = 0; i < candles.length; i++) {
    const { time, open: o, high, low, close: c } = candles[i]
    let justStoppedOut = false

    if (i >= sig.warmupBars) {
      if (pos) {
        const hit = pos.dir === 1 ? low <= pos.stopPrice : high >= pos.stopPrice
        if (hit) {
          const raw = pos.dir === 1 ? Math.min(o, pos.stopPrice) : Math.max(o, pos.stopPrice)
          close(time, pos.dir === 1 ? sellFillPrice(raw) : buyFillPrice(raw), true)
          justStoppedOut = true
        } else if (pos.dir === 1 ? sig.longExit[i] : sig.shortExit[i]) {
          close(time, c, false)
        } else if (equityAt(c, time) <= 0) {
          close(time, c, false)
          justStoppedOut = true
        }
      }

      if (!pos && !justStoppedOut) {
        if (sig.longEntry[i] && sig.longStop[i] !== null) {
          open(1, time, c, sig.longStop[i] as number)
        } else if (allowShort && sig.shortEntry[i] && sig.shortStop[i] !== null) {
          open(-1, time, c, sig.shortStop[i] as number)
        }
      }
    }
    curve.push({ time, value: equityAt(c, time) })
  }

  // Force-close, as the engine does, so the two are comparable at the final bar.
  if (pos && candles.length > 0) {
    const last = candles[candles.length - 1]
    close(last.time, last.close, false)
    curve[curve.length - 1] = { time: last.time, value: cash }
  }

  let peak = -Infinity
  let worst = 0
  for (const p of curve) {
    if (p.value > peak) peak = p.value
    const dd = ((p.value - peak) / peak) * 100
    if (dd < worst) worst = dd
  }

  return {
    finishing: cash,
    netPct: ((cash - CAPITAL) / CAPITAL) * 100,
    curve,
    longTrades,
    shortTrades,
    longPnl,
    shortPnl,
    maxDdPct: worst,
    fees: totalFees
  }
}

// --------------------------------------------------------------------------------- validation

const STRATS: Array<[string, string, (c: Candle[]) => TwoSided]> = [
  [trendRegimeEnsemble.id, trendRegimeEnsemble.name, trendRegimeTwoSided],
  [shortTermChannel.id, shortTermChannel.name, shortTermChannelTwoSided]
]

console.log('Validating the simulator against the engine with the short leg OFF.')
console.log('Any disagreement here and nothing below this line is evidence.\n')

let worstGap = 0
for (const [id, name, build] of STRATS) {
  for (const symbol of SYMBOLS) {
    const candles = load(symbol, INTERVAL)
    if (!candles) continue
    const engine = runBacktest(candles, id, { startingBalance: CAPITAL })
    const mine = simulate(candles, build(candles), false)
    const gap = Math.abs(engine.stats.finishingBalance - mine.finishing)
    if (gap > worstGap) worstGap = gap
    if (gap > 0.01) console.log('  MISMATCH ' + name + ' ' + symbol + ': engine ' + engine.stats.finishingBalance.toFixed(2) + ' vs sim ' + mine.finishing.toFixed(2))
  }
}
console.log('worst disagreement: $' + worstGap.toFixed(6) + ' on $' + CAPITAL.toLocaleString())
if (worstGap > 0.01) {
  console.log('\nSTOP. The simulator does not reproduce the engine with shorts off, so nothing below is evidence.')
  process.exit(1)
}

// ------------------------------------------------------------------------------------- report

const pc = (v: number): string => (v >= 0 ? '+' : '') + v.toFixed(1) + '%'
const median = (v: number[]): number => {
  if (v.length === 0) return 0
  const s = [...v].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

for (const [, name, build] of STRATS) {
  console.log('\n\n############ ' + name + ' -- ' + INTERVAL + ', full history, long-only vs long+short ############\n')
  console.log(
    'symbol'.padEnd(8) + 'long only'.padStart(12) + 'long+short'.padStart(12) + 'change'.padStart(11) +
      'DD long'.padStart(10) + 'DD both'.padStart(10) + 'shorts'.padStart(8) + 'short P&L'.padStart(12) + 'fees'.padStart(10)
  )
  console.log('-'.repeat(93))
  const longs: number[] = []
  const boths: number[] = []
  let better = 0
  let total = 0
  for (const symbol of SYMBOLS) {
    const candles = load(symbol, INTERVAL)
    if (!candles) continue
    const sig = build(candles)
    const a = simulate(candles, sig, false)
    const b = simulate(candles, sig, true)
    longs.push(a.netPct)
    boths.push(b.netPct)
    total++
    if (b.netPct > a.netPct) better++
    console.log(
      symbol.replace('USDT', '').padEnd(8) +
        pc(a.netPct).padStart(12) + pc(b.netPct).padStart(12) + pc(b.netPct - a.netPct).padStart(11) +
        pc(a.maxDdPct).padStart(10) + pc(b.maxDdPct).padStart(10) +
        String(b.shortTrades).padStart(8) +
        ((b.shortPnl >= 0 ? '+$' : '-$') + Math.abs(b.shortPnl).toFixed(0)).padStart(12) +
        ('$' + b.fees.toFixed(0)).padStart(10)
    )
  }
  console.log('-'.repeat(93))
  console.log('median'.padEnd(8) + pc(median(longs)).padStart(12) + pc(median(boths)).padStart(12))
  console.log('worst'.padEnd(8) + pc(Math.min(...longs)).padStart(12) + pc(Math.min(...boths)).padStart(12))
  console.log('\nshorting improved ' + better + ' of ' + total + ' symbols')
}

// ------------------------------------------------- the years the short leg is supposed to save

console.log('\n\n############ THE BEAR YEARS, long-only vs long+short ############\n')

const BEAR_YEARS = [2018, 2022, 2025, 2026]

for (const [, name, build] of STRATS) {
  console.log('\n--- ' + name + ' ---')
  console.log('symbol'.padEnd(9) + BEAR_YEARS.map((y) => (String(y) + ' L').padStart(11) + (String(y) + ' L+S').padStart(11)).join(''))
  console.log('-'.repeat(9 + BEAR_YEARS.length * 22))
  const agg: Record<number, { l: number[]; s: number[] }> = {}
  for (const y of BEAR_YEARS) agg[y] = { l: [], s: [] }

  for (const symbol of SYMBOLS) {
    const all = load(symbol, INTERVAL)
    if (!all) continue
    const cells: string[] = []
    for (const y of BEAR_YEARS) {
      const from = Date.UTC(y, 0, 1) / 1000
      const to = Date.UTC(y + 1, 0, 1) / 1000
      const first = all.findIndex((c) => c.time >= from)
      const last = all.findIndex((c) => c.time >= to)
      const probe = build(all)
      const warm = probe.warmupBars
      if (first < 0 || first - warm < 0) {
        cells.push('-', '-')
        continue
      }
      const slice = all.slice(first - warm, last < 0 ? all.length : last)
      if (slice.length < warm + 5) {
        cells.push('-', '-')
        continue
      }
      const sig = build(slice)
      const a = simulate(slice, sig, false)
      const b = simulate(slice, sig, true)
      agg[y].l.push(a.netPct)
      agg[y].s.push(b.netPct)
      cells.push(pc(a.netPct), pc(b.netPct))
    }
    console.log(symbol.replace('USDT', '').padEnd(9) + cells.map((c) => c.padStart(11)).join(''))
  }
  console.log('-'.repeat(9 + BEAR_YEARS.length * 22))
  console.log('median'.padEnd(9) + BEAR_YEARS.map((y) =>
    pc(median(agg[y].l)).padStart(11) + pc(median(agg[y].s)).padStart(11)).join(''))
}
