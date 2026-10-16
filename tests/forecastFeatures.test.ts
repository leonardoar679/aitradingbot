import { describe, expect, it } from 'vitest'
import { FORECAST_BAR_SECONDS, coarseBars, type ForecastBar } from '../shared/forecast/bars'
import {
  CLASS_LINES,
  FEATURE_COUNT,
  FEATURE_NAMES,
  NEED,
  PEG_RANGE,
  PRICE_FEATURES,
  crossSectionAt,
  featuresAt,
  isPegged,
  pairClasses,
  quickAt,
  type PairQuick,
  type PairSeries
} from '../shared/forecast/features'
import { outcomeAt, usualMove } from '../shared/forecast/targets'
import { marketRegimeOf } from '../shared/marketResearch'

// WHAT THE FORECAST READS AT A MOMENT (shared/forecast/features.ts; the V6 document, §15-17 and §53),
// and what happened after it (shared/forecast/targets.ts). The rows are read from a made-up market:
// six pairs, thirty days of five-minute bars each, a random walk whose step size wanders, so every
// figure has something to read.

const T0 = Date.parse('2026-09-01T00:00:00Z') / 1000
const DAYS = 30
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT']

function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

function walk(symbol: string, seed: number): ForecastBar[] {
  const next = lcg(seed)
  const gauss = (): number => Math.sqrt(-2 * Math.log(next() + 1e-12)) * Math.cos(2 * Math.PI * next())
  const bars: ForecastBar[] = []
  let price = symbol === 'BTCUSDT' ? 60_000 : symbol === 'ETHUSDT' ? 2_500 : 1 + seed % 50
  let sigma = 0.0015
  for (let index = 0; index < DAYS * 288; index++) {
    sigma = Math.min(0.01, Math.max(0.0005, sigma * Math.exp(0.05 * gauss())))
    const open = price
    price = price * Math.exp(sigma * gauss())
    const high = Math.max(open, price) * (1 + sigma * next())
    const low = Math.min(open, price) * (1 - sigma * next())
    const volume = 100 + 900 * next()
    bars.push({ time: T0 + index * FORECAST_BAR_SECONDS, open, high, low, close: price, volume, quoteVolume: volume * price, takerBuyVolume: volume * next(), trades: 1 + Math.floor(200 * next()) })
  }
  return bars
}

function seriesOf(m5: ForecastBar[]): PairSeries {
  return { m5, h1: coarseBars(m5, '1h', Number.POSITIVE_INFINITY) }
}

const MARKET = new Map(SYMBOLS.map((symbol, index) => [symbol, seriesOf(walk(symbol, 1000 + index * 77))]))

/** The row at T for one pair, read as the forecast reads it: every pair's quick reads, the
 * cross-section from them, and the pair's row. */
function rowAt(market: ReadonlyMap<string, PairSeries>, symbol: string, tSec: number): Float64Array | null {
  const quick = new Map<string, PairQuick>()
  for (const [pair, series] of market) {
    const read = quickAt(series, tSec)
    if (read !== null) quick.set(pair, read)
  }
  const cross = crossSectionAt(quick)
  if (cross === null) return null
  return featuresAt({ symbol, series: market.get(symbol)!, btcH1: market.get('BTCUSDT')!.h1, cross, tSec })
}

const bytes = (row: Float64Array | null): Buffer | null => (row === null ? null : Buffer.from(row.buffer))

describe('a row', () => {
  const t = T0 + 28 * 86_400

  it('is every figure, named, finite, the PRICE set first', () => {
    const row = rowAt(MARKET, 'SOLUSDT', t)
    expect(row).not.toBeNull()
    expect(row!.length).toBe(FEATURE_COUNT)
    expect(FEATURE_NAMES.length).toBe(new Set(FEATURE_NAMES).size)
    expect(row!.every(Number.isFinite)).toBe(true)
    expect(FEATURE_NAMES.slice(0, PRICE_FEATURES)).toEqual(['r_5m', 'r_15m', 'r_30m', 'r_1h', 'r_4h', 'r_24h', 'r_7d', 'rv_1h', 'rv_4h', 'rv_24h', 'rv_ratio', 'z_15m', 'z_1h', 'z_4h', 'z_24h'])
  })

  it('reads its moves from the close that ended at T', () => {
    const m5 = MARKET.get('SOLUSDT')!.m5
    const index = (t - T0) / FORECAST_BAR_SECONDS - 1
    const row = rowAt(MARKET, 'SOLUSDT', t)!
    const at = (name: string): number => row[FEATURE_NAMES.indexOf(name as (typeof FEATURE_NAMES)[number])]
    expect(at('r_5m')).toBeCloseTo(Math.log(m5[index].close / m5[index - 1].close), 12)
    expect(at('r_1h')).toBeCloseTo(Math.log(m5[index].close / m5[index - 12].close), 12)
    expect(at('r_24h')).toBeCloseTo(Math.log(m5[index].close / m5[index - 288].close), 12)
    let squares = 0
    for (let k = index - 287; k <= index; k++) squares += Math.log(m5[k].close / m5[k - 1].close) ** 2
    expect(at('rv_24h')).toBeCloseTo(Math.sqrt(squares), 12)
    expect(at('z_1h')).toBeCloseTo(at('r_1h') / usualMove(Math.sqrt(squares), 12), 10)
    expect(at('z_15m')).toBeCloseTo(at('r_15m') / usualMove(Math.sqrt(squares), 3), 10)
    expect(at('z_24h')).toBeCloseTo(at('r_24h') / usualMove(Math.sqrt(squares), 288), 10)
    expect(at('pos_24h')).toBeGreaterThanOrEqual(0)
    expect(at('pos_24h')).toBeLessThanOrEqual(1)
    // One regime word and one class, each a one.
    expect(FEATURE_NAMES.filter((name) => name.startsWith('regime_')).reduce((sum, name) => sum + at(name), 0)).toBe(1)
    expect(FEATURE_NAMES.filter((name) => name.startsWith('class_')).reduce((sum, name) => sum + at(name), 0)).toBe(1)
  })

  it('is the same to the byte when any bar after T is changed or added (§53)', () => {
    const next = lcg(5)
    for (let k = 0; k < 12; k++) {
      const tSec = T0 + (26 + Math.floor(next() * 3)) * 86_400 + Math.floor(next() * 288) * FORECAST_BAR_SECONDS
      const before = rowAt(MARKET, 'XRPUSDT', tSec)
      expect(before).not.toBeNull()
      // Every bar that had not closed by T, of every pair, made something else; and a day more.
      const altered = new Map(
        [...MARKET.entries()].map(([symbol, series]) => {
          const m5 = series.m5.map((bar) => (bar.time + FORECAST_BAR_SECONDS > tSec ? { ...bar, open: bar.open * 1.3, high: bar.high * 1.4, low: bar.low * 1.2, close: bar.close * 1.3, volume: bar.volume * 7, takerBuyVolume: bar.takerBuyVolume * 7 } : bar))
          const last = m5[m5.length - 1]
          for (let more = 1; more <= 288; more++) m5.push({ ...last, time: last.time + more * FORECAST_BAR_SECONDS })
          return [symbol, seriesOf(m5)]
        })
      )
      expect(bytes(rowAt(altered, 'XRPUSDT', tSec))).toEqual(bytes(before))
    }
  })

  it('is the same to the byte from the days the app holds as from the whole history', () => {
    // Live: three days of five-minute bars, and hours built from every bar on file -- here only a day
    // more than the longest window needs, against the whole thirty days.
    const tSec = T0 + 29 * 86_400 + 7 * FORECAST_BAR_SECONDS
    const held = new Map(
      [...MARKET.entries()].map(([symbol, series]) => [
        symbol,
        { m5: series.m5.filter((bar) => bar.time >= tSec - 3 * 86_400), h1: series.h1.filter((bar) => bar.time >= tSec - (NEED.h1 + 24) * 3600 && bar.time < tSec) }
      ])
    )
    expect(held.get('BTCUSDT')!.h1.length).toBeLessThan(MARKET.get('BTCUSDT')!.h1.filter((bar) => bar.time < tSec).length - 24)
    for (const symbol of SYMBOLS) expect(bytes(rowAt(held, symbol, tSec)), symbol).toEqual(bytes(rowAt(MARKET, symbol, tSec)))
  })

  it('reads the week, the taker, the volume, and the clock as defined', () => {
    const series = MARKET.get('DOGEUSDT')!
    const m5 = series.m5
    const index = (t - T0) / FORECAST_BAR_SECONDS - 1
    const row = rowAt(MARKET, 'DOGEUSDT', t)!
    const at = (name: string): number => row[FEATURE_NAMES.indexOf(name as (typeof FEATURE_NAMES)[number])]
    const hours = series.h1.filter((bar) => bar.time + 3600 <= t)
    expect(at('r_7d')).toBeCloseTo(Math.log(m5[index].close / hours[hours.length - 169].close), 12)
    const lastHour = m5.slice(index - 11, index + 1)
    const volume = lastHour.reduce((sum, bar) => sum + bar.volume, 0)
    expect(at('taker_1h')).toBeCloseTo(lastHour.reduce((sum, bar) => sum + bar.takerBuyVolume, 0) / volume - 0.5, 12)
    const day = m5.slice(index - 287, index + 1).reduce((sum, bar) => sum + bar.volume, 0)
    expect(at('vol_ratio_1h')).toBeCloseTo(volume / (day / 24), 10)
    // At twenty-five to eight: a time of day the clock's figures tell apart.
    const later = t + 7 * 3600 + 35 * 60
    const clock = rowAt(MARKET, 'DOGEUSDT', later)!
    const hour = 7 + 35 / 60
    expect(clock[FEATURE_NAMES.indexOf('hour_sin')]).toBeCloseTo(Math.sin((2 * Math.PI * hour) / 24), 12)
    expect(clock[FEATURE_NAMES.indexOf('hour_cos')]).toBeCloseTo(Math.cos((2 * Math.PI * hour) / 24), 12)
    const weekday = new Date(later * 1000).getUTCDay()
    expect(clock[FEATURE_NAMES.indexOf('dow_sin')]).toBeCloseTo(Math.sin((2 * Math.PI * weekday) / 7), 12)
    // Bitcoin against itself: a beta of one, and nothing of its own beside it.
    const btc = rowAt(MARKET, 'BTCUSDT', t)!
    expect(btc[FEATURE_NAMES.indexOf('beta_btc')]).toBe(1)
    expect(btc[FEATURE_NAMES.indexOf('idio_1h')]).toBe(0)
    expect(btc[FEATURE_NAMES.indexOf('class_btc')]).toBe(1)
    // The market's last fifteen minutes on every row (V7.1 Stage 11): Bitcoin's own r_15m is the market's
    // btc_r_15m, on its row and on any other's; the breadth a share; the volume against a ninety-sixth of
    // the market's day.
    expect(btc[FEATURE_NAMES.indexOf('btc_r_15m')]).toBe(btc[FEATURE_NAMES.indexOf('r_15m')])
    expect(row[FEATURE_NAMES.indexOf('btc_r_15m')]).toBe(btc[FEATURE_NAMES.indexOf('r_15m')])
    const btcBars = MARKET.get('BTCUSDT')!.m5
    expect(btc[FEATURE_NAMES.indexOf('btc_acc_15m')]).toBeCloseTo(Math.log(btcBars[index].close / btcBars[index - 3].close) - Math.log(btcBars[index - 3].close / btcBars[index - 6].close), 12)
    expect(row[FEATURE_NAMES.indexOf('eth_r_15m')]).toBe(rowAt(MARKET, 'ETHUSDT', t)![FEATURE_NAMES.indexOf('r_15m')])
    const breadth = row[FEATURE_NAMES.indexOf('breadth_15m')]
    expect(breadth * SYMBOLS.length).toBeCloseTo(Math.round(breadth * SYMBOLS.length), 12)
    let market15 = 0
    let marketDay = 0
    for (const symbol of SYMBOLS) {
      const bars = MARKET.get(symbol)!.m5
      for (let k = index - 287; k <= index; k++) {
        marketDay += bars[k].quoteVolume
        if (k > index - 3) market15 += bars[k].quoteVolume
      }
    }
    expect(row[FEATURE_NAMES.indexOf('market_vol_acc')]).toBeCloseTo(market15 / (marketDay / 96), 10)
  })

  it('needs the day before T whole, and bears a gap further back', () => {
    const tSec = T0 + 28 * 86_400
    const withGap = (from: number, bars: number): Map<string, PairSeries> => {
      const market = new Map(MARKET)
      const sol = MARKET.get('SOLUSDT')!
      market.set('SOLUSDT', seriesOf(sol.m5.filter((bar) => bar.time < from || bar.time >= from + bars * FORECAST_BAR_SECONDS)))
      return market
    }
    // An hour missing six hours back: no row, and no quick read for the cross-section either.
    const recent = withGap(tSec - 6 * 3600, 12)
    expect(rowAt(recent, 'SOLUSDT', tSec)).toBeNull()
    expect(quickAt(recent.get('SOLUSDT')!, tSec)).toBeNull()
    // The same hour missing a day and a half back: the row is read.
    const older = withGap(tSec - 36 * 3600, 12)
    expect(rowAt(older, 'SOLUSDT', tSec)).not.toBeNull()
    expect(quickAt(older.get('SOLUSDT')!, tSec)).not.toBeNull()
    // Half the two days missing: the quarter-hourly readings have too little.
    expect(rowAt(withGap(tSec - 47 * 3600, 22 * 12), 'SOLUSDT', tSec)).toBeNull()
    // And a row is not read across the gap even with a cross-section that names the pair: the row
    // asks for the pair's own read at T itself.
    const cross = crossSectionAt(new Map([...MARKET.entries()].map(([symbol, series]) => [symbol, quickAt(series, tSec)!])))!
    expect(cross.classes.has('SOLUSDT')).toBe(true)
    expect(featuresAt({ symbol: 'SOLUSDT', series: recent.get('SOLUSDT')!, btcH1: MARKET.get('BTCUSDT')!.h1, cross, tSec })).toBeNull()
    expect(featuresAt({ symbol: 'SOLUSDT', series: MARKET.get('SOLUSDT')!, btcH1: MARKET.get('BTCUSDT')!.h1, cross, tSec })).not.toBeNull()
  })

  it('is none for a coin pegged to something, which has no part in the market either', () => {
    const tSec = T0 + 28 * 86_400
    // A dollar stablecoin: within a tenth of a percent of 1 the whole month.
    const next = lcg(9)
    const pegged: ForecastBar[] = MARKET.get('ADAUSDT')!.m5.map((bar) => {
      const close = 1 + (next() - 0.5) * 0.002
      return { ...bar, open: close, high: close * 1.0002, low: close * 0.9998, close }
    })
    const market = new Map(MARKET)
    market.set('ADAUSDT', seriesOf(pegged))
    expect(isPegged(market.get('ADAUSDT')!, tSec)).toBe(true)
    expect(isPegged(MARKET.get('ADAUSDT')!, tSec)).toBe(false)
    expect(quickAt(market.get('ADAUSDT')!, tSec)).toBeNull()
    expect(rowAt(market, 'ADAUSDT', tSec)).toBeNull()
    // A week within one percent is pegged; one that reached past it is not.
    expect(PEG_RANGE).toBe(0.01)
    const flat = pegged.map((bar) => ({ ...bar, open: 1, high: 1, low: 1, close: 1 }))
    const reach = (high: number): ForecastBar[] => flat.map((bar) => (bar.time === tSec - 3 * 3600 ? { ...bar, high } : bar))
    expect(isPegged(seriesOf(reach(1.0099)), tSec)).toBe(true)
    expect(isPegged(seriesOf(reach(1.0101)), tSec)).toBe(false)
    // A reach older than the week does not count.
    expect(isPegged(seriesOf(flat.map((bar) => (bar.time === tSec - 8 * 86_400 ? { ...bar, high: 1.05 } : bar))), tSec)).toBe(true)
  })

  it('is none for a day without a move', () => {
    const tSec = T0 + 28 * 86_400
    const sol = MARKET.get('SOLUSDT')!
    const flat = sol.m5.map((bar) => (bar.time + FORECAST_BAR_SECONDS > tSec - 86_400 ? { ...bar, open: 5, high: 5, low: 5, close: 5 } : bar))
    const market = new Map(MARKET)
    market.set('SOLUSDT', seriesOf(flat))
    expect(rowAt(market, 'SOLUSDT', tSec)).toBeNull()
  })

  it('is none without the history its longest window needs, or when the bar at T is missing', () => {
    expect(NEED.h1).toBe(601)
    // Twenty-five days of hours, less one.
    expect(rowAt(MARKET, 'SOLUSDT', T0 + (NEED.h1 - 1) * 3600)).toBeNull()
    expect(rowAt(MARKET, 'SOLUSDT', T0 + 28 * 86_400)).not.toBeNull()
    // The bar that closed at T is missing: no row at T.
    const tSec = T0 + 28 * 86_400
    const gapped = new Map(MARKET)
    const sol = MARKET.get('SOLUSDT')!
    gapped.set('SOLUSDT', seriesOf(sol.m5.filter((bar) => bar.time !== tSec - FORECAST_BAR_SECONDS)))
    expect(rowAt(gapped, 'SOLUSDT', tSec)).toBeNull()
    // Not between bars: T is a close.
    expect(rowAt(MARKET, 'SOLUSDT', tSec + 60)).toBeNull()
    expect(quickAt(MARKET.get('SOLUSDT')!, tSec + 60)).toBeNull()
    expect(quickAt(gapped.get('SOLUSDT')!, tSec)).toBeNull()
    expect(quickAt(MARKET.get('SOLUSDT')!, tSec)).not.toBeNull()
  })
})

describe('the cross-section (§16)', () => {
  const quick = (r1h: number, r24h: number, quoteVolume24h = 1e8, rv24h = 0.03, r4h = r1h, r15m = r1h / 4, quoteVolume15m = quoteVolume24h / 96): PairQuick => ({ close: 1, r15m, r15mBefore: r15m / 2, r1h, r4h, r24h, quoteVolume15m, quoteVolume24h, rv24h })

  it('reads the breadth, the alts against Bitcoin, and the regime by the research rule', () => {
    const market = new Map<string, PairQuick>([
      // Bitcoin rising over four hours on a day up (BULL); ether falling (it would read BEAR).
      ['BTCUSDT', quick(0.001, 0.01, 1e8, 0.03, 0.02)],
      ['ETHUSDT', quick(-0.002, 0.02, 1e8, 0.03, -0.03)],
      ['SOLUSDT', quick(0.003, 0.05)],
      ['XRPUSDT', quick(-0.001, -0.01)],
      // Up over the hour, down over its last fifteen minutes.
      ['ADAUSDT', quick(0.002, 0.03, 1e8, 0.03, 0.002, -0.001)]
    ])
    const cross = crossSectionAt(market)!
    expect(cross.breadth1h).toBeCloseTo(3 / 5)
    expect(cross.breadth24h).toBeCloseTo(4 / 5)
    // The median alt day (0.03) less Bitcoin's (0.01).
    expect(cross.altStrength).toBeCloseTo(0.02)
    const pct = (value: number): number => (Math.exp(value) - 1) * 100
    expect(cross.regime).toBe(marketRegimeOf({ h1: pct(0.001), h4: pct(0.02), h24: pct(0.01) }))
    expect(cross.regime).toBe('bull')
    expect(crossSectionAt(new Map([['SOLUSDT', quick(0, 0)]]))).toBeNull()
    // The market's last fifteen minutes (V7.1 Stage 11): Bitcoin's and ether's, Bitcoin's against the
    // fifteen before, the breadth, and the market's volume against a ninety-sixth of its day.
    expect(cross.btc.r15m).toBeCloseTo(0.001 / 4, 12)
    expect(cross.btc.acc15m).toBeCloseTo(0.001 / 4 - 0.001 / 8, 12)
    expect(cross.eth.r15m).toBeCloseTo(-0.002 / 4, 12)
    expect(cross.breadth15m).toBeCloseTo(2 / 5)
    expect(cross.volAcc15m).toBeCloseTo(1, 12)
    const busy = new Map(market)
    busy.set('SOLUSDT', quick(0.003, 0.05, 1e8, 0.03, 0.003, 0.001, (1e8 / 96) * 11))
    // One pair's fifteen minutes at eleven times its usual among five: the market's at three times.
    expect(crossSectionAt(busy)!.volAcc15m).toBeCloseTo(3, 12)
  })

  it('classes the pairs by their day\'s volume and their volatility, Bitcoin and ether their own (§100)', () => {
    const market = new Map<string, PairQuick>([
      ['BTCUSDT', quick(0, 0, 9e9, 0.02)],
      ['ETHUSDT', quick(0, 0, 8e9, 0.02)]
    ])
    // Forty alts, the higher the volume the lower the volatility; one wild one among the large.
    for (let rank = 0; rank < 40; rank++) market.set(`A${rank}USDT`, quick(0, 0, 1e9 - rank * 1e7, rank === 3 ? 0.5 : 0.01 + rank * 0.001))
    const classes = pairClasses(market)
    expect(classes.get('BTCUSDT')).toBe('btc')
    expect(classes.get('ETHUSDT')).toBe('eth')
    expect(classes.get('A3USDT')).toBe('high-vol')
    expect(classes.get('A0USDT')).toBe('large')
    expect(classes.get('A9USDT')).toBe('large')
    expect(classes.get('A10USDT')).toBe('mid')
    expect(classes.get('A20USDT')).toBe('mid')
    // The top fifth by volatility: eight of the forty -- the wild one and the seven most volatile.
    expect([...classes.values()].filter((cls) => cls === 'high-vol')).toHaveLength(Math.floor(40 * CLASS_LINES.highVolShare))
    expect(classes.get('A39USDT')).toBe('high-vol')
    expect(classes.get('A31USDT')).toBe('other')
  })
})

describe('what happened after (targets.ts)', () => {
  it('is the move to the close a horizon on, and the best and worst on the way', () => {
    const m5 = MARKET.get('ETHUSDT')!.m5
    const index = 5000
    const outcome = outcomeAt(m5, index, 12)!
    expect(outcome.r).toBeCloseTo(Math.log(m5[index + 12].close / m5[index].close), 12)
    const highs = m5.slice(index + 1, index + 13).map((bar) => bar.high)
    const lows = m5.slice(index + 1, index + 13).map((bar) => bar.low)
    expect(outcome.best).toBeCloseTo(Math.max(0, Math.log(Math.max(...highs) / m5[index].close)), 12)
    expect(outcome.worst).toBeCloseTo(Math.min(0, Math.log(Math.min(...lows) / m5[index].close)), 12)
  })

  it('has a best of zero on a path that only fell, and a worst of zero on one that only rose', () => {
    const bar = (time: number, close: number): ForecastBar => ({ time, open: close, high: close, low: close, close, volume: 1, quoteVolume: close, takerBuyVolume: 0.5, trades: 1 })
    const falling = [100, 99, 98, 97].map((close, at) => bar(T0 + at * FORECAST_BAR_SECONDS, close))
    expect(outcomeAt(falling, 0, 3)).toEqual({ r: Math.log(0.97), best: 0, worst: Math.log(0.97) })
    const rising = [100, 101, 102, 103].map((close, at) => bar(T0 + at * FORECAST_BAR_SECONDS, close))
    expect(outcomeAt(rising, 0, 3)).toEqual({ r: Math.log(1.03), best: Math.log(1.03), worst: 0 })
  })

  it('is none past the end, or across a gap', () => {
    const m5 = MARKET.get('ETHUSDT')!.m5
    expect(outcomeAt(m5, m5.length - 12, 12)).toBeNull()
    const gapped = m5.filter((_, at) => at !== 5006)
    expect(outcomeAt(gapped, 5000, 12)).toBeNull()
    expect(outcomeAt(gapped, 5000, 5)).not.toBeNull()
  })

  it('measures a move against the square root of its time', () => {
    expect(usualMove(0.04, 288)).toBeCloseTo(0.04)
    expect(usualMove(0.04, 72)).toBeCloseTo(0.02)
  })
})
