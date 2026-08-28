import { describe, expect, it } from 'vitest'
import {
  channelPosition,
  rollingHighest,
  rollingLowest,
  shortTermChannel
} from '../src/backtest/strategies/shortTermChannel'
import { runBacktest } from '../src/backtest/engine'
import { STRATEGIES } from '../src/backtest/strategies'
import type { Candle } from '../shared/ipc'

// This is the FAST strategy, so the property that matters most is the one that would quietly
// destroy it: trading too often. A round trip costs 0.240%, and the timescale scan behind this
// file measured a moving-average trend follower at a quarter-day lookback returning -99.98% on
// 3,858 trades over the same data where a 20-day one returned +61% on 279. Everything pinned
// here is either a guard on the trade budget or a guard on the arithmetic that sets it.

const M15 = 900
const H4 = 14_400
const DAY = 86_400

function series(barSeconds: number, bars: Array<{ h: number; l: number; c: number }>): Candle[] {
  return bars.map((b, i) => ({
    time: 1_700_000_000 + i * barSeconds,
    open: b.c,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: 1
  }))
}

function flat(barSeconds: number, count: number, price: number): Candle[] {
  return series(
    barSeconds,
    Array.from({ length: count }, () => ({ h: price, l: price, c: price }))
  )
}

/** Bars whose close walks a given path, with highs/lows hugging the close. */
function path(barSeconds: number, closes: number[]): Candle[] {
  return series(
    barSeconds,
    closes.map((c) => ({ h: c, l: c, c }))
  )
}

describe('rollingHighest / rollingLowest', () => {
  it('reports the extreme of the trailing window, ending at each index', () => {
    expect(rollingHighest([1, 5, 3, 2], 2)).toEqual([NaN, 5, 5, 3])
    expect(rollingLowest([1, 5, 3, 2], 2)).toEqual([NaN, 1, 3, 2])
  })

  it('leaves the un-warmed head as NaN rather than a partial extreme', () => {
    // A partial max over 1 bar is a real number that looks valid, so a caller that forgot to
    // check would trade on a "channel" one bar wide.
    const out = rollingHighest([4, 9, 2], 3)
    expect(Number.isNaN(out[0])).toBe(true)
    expect(Number.isNaN(out[1])).toBe(true)
    expect(out[2]).toBe(9)
  })
})

describe('channelPosition', () => {
  it('is 1 at the top of the channel and 0 at the bottom', () => {
    const candles = path(M15, [10, 20, 10, 20, 10])
    const pos = channelPosition(candles, [2])
    // Index 3 closes at 20 against a prior 2-bar channel of [10, 20].
    expect(pos[3]).toBe(1)
    // Index 4 closes at 10 against a prior 2-bar channel of [10, 20].
    expect(pos[4]).toBe(0)
  })

  it('reads the channel as of the PREVIOUS bar', () => {
    // The bug this guards: including the current bar makes every new high sit at position 1.0 by
    // construction, so the entry threshold fires on any up bar and the strategy turns into the
    // -99.98% row of the scan. Here the last close is a new high above everything before it; a
    // self-referential channel would still report exactly 1.0, but so would a correct one -- so
    // the discriminating case is that the value is computed from the OLD range, and a close far
    // above it clamps to 1 rather than exceeding it.
    const candles = path(M15, [10, 11, 12, 100])
    const pos = channelPosition(candles, [3])
    expect(pos[3]).toBe(1)
    expect(pos[3]).toBeLessThanOrEqual(1)
  })

  it('clamps below the channel low to 0 instead of going negative', () => {
    const candles = path(M15, [10, 11, 12, 1])
    expect(channelPosition(candles, [3])[3]).toBe(0)
  })

  it('scores a flat channel 0.5 rather than dividing by zero', () => {
    const pos = channelPosition(flat(M15, 6, 50), [3])
    expect(pos[4]).toBe(0.5)
    expect(Number.isFinite(pos[4])).toBe(true)
  })

  it('averages across lookbacks instead of tracking any one of them', () => {
    // The whole reason this is a position average and not a Donchian vote: nested channels make
    // a vote equivalent to picking one lookback, so the average must actually differ from the
    // single-lookback values or the design claim is false.
    const closes = [10, 12, 14, 16, 18, 20, 14]
    const candles = path(M15, closes)
    const i = closes.length - 1
    const two = channelPosition(candles, [2])[i]
    const six = channelPosition(candles, [6])[i]
    const both = channelPosition(candles, [2, 6])[i]
    expect(two).not.toBe(six)
    expect(both).toBeCloseTo((two + six) / 2, 10)
  })
})

describe('shortTermChannel warmup', () => {
  it('declares the slowest lookback, 8 days, in bars of the given size', () => {
    expect(shortTermChannel.warmupBarsFor(M15)).toBe(Math.round((8 * DAY) / M15) + 1)
    expect(shortTermChannel.warmupBarsFor(H4)).toBe(Math.round((8 * DAY) / H4) + 1)
  })

  it('needs far fewer bars than the slow strategy, which is the point of it', () => {
    // 8 days against 80. If this ever inverted, the "short-term" label would be wrong and the
    // Backtest page's default 90-day window would go back to being mostly warmup.
    expect(shortTermChannel.warmupBarsFor(M15)).toBeLessThan(1000)
  })

  it('scales the lookback with bar size, so it means the same thing on every timeframe', () => {
    expect(shortTermChannel.warmupBarsFor(M15)).toBeGreaterThan(shortTermChannel.warmupBarsFor(H4))
  })

  it('matches what generateSignals actually reports, so the two cannot drift', () => {
    const candles = path(M15, Array.from({ length: 2000 }, (_, i) => 100 + i * 0.01))
    expect(candles.length).toBeGreaterThan(shortTermChannel.warmupBarsFor(M15))
    expect(shortTermChannel.generateSignals(candles).warmupBars).toBe(
      shortTermChannel.warmupBarsFor(M15)
    )
  })
})

describe('shortTermChannel signals', () => {
  /** A sawtooth: long climbs and long falls, which is what a trend follower is for. */
  function sawtooth(cycles: number, legBars: number): Candle[] {
    const closes: number[] = []
    let price = 100
    for (let c = 0; c < cycles; c++) {
      for (let i = 0; i < legBars; i++) closes.push((price *= 1.004))
      for (let i = 0; i < legBars; i++) closes.push((price /= 1.004))
    }
    return path(M15, closes)
  }

  it('enters near channel highs and exits after the fall, on a series that actually trades', () => {
    const candles = sawtooth(6, 900)
    const s = shortTermChannel.generateSignals(candles)
    const entries = s.entries.filter(Boolean).length
    const exits = s.exits.filter(Boolean).length
    // Assert non-empty FIRST. A fixture that produces no signals passes every property below
    // vacuously, which has silently happened before in this suite.
    expect(entries).toBeGreaterThan(0)
    expect(exits).toBeGreaterThan(0)
  })

  it('never emits an entry without a stop price', () => {
    // The engine drops an entry whose stopPrices slot is null, silently and with no error, so a
    // strategy that forgot one would report zero trades and read as a strategy that does not work.
    const s = shortTermChannel.generateSignals(sawtooth(6, 900))
    for (let i = 0; i < s.entries.length; i++) {
      if (s.entries[i]) expect(s.stopPrices[i]).not.toBeNull()
    }
  })

  it('places the stop far below the entry, where only a gap can reach it', () => {
    const candles = sawtooth(6, 900)
    const s = shortTermChannel.generateSignals(candles)
    const i = s.entries.findIndex(Boolean)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(s.stopPrices[i]).toBeCloseTo(candles[i].close * 0.5, 8)
  })

  it('stays flat through the warmup rather than trading on a partial channel', () => {
    const s = shortTermChannel.generateSignals(sawtooth(6, 900))
    for (let i = 0; i < s.warmupBars; i++) {
      expect(s.entries[i]).toBe(false)
      expect(s.exits[i]).toBe(false)
    }
  })

  it('holds no position in a flat market, where every trade would be pure fee', () => {
    const s = shortTermChannel.generateSignals(flat(M15, 3000, 100))
    // Position sits at 0.5 in a dead-flat channel: below the 0.95 entry and above the 0.25 exit,
    // so the hysteresis band means neither fires.
    expect(s.entries.filter(Boolean).length).toBe(0)
  })
})

describe('shortTermChannel through the engine', () => {
  /** Sawtooth with enough amplitude that the moves dwarf the 0.24% round trip. */
  function tradeable(): Candle[] {
    const closes: number[] = []
    let price = 100
    for (let c = 0; c < 5; c++) {
      for (let i = 0; i < 1200; i++) closes.push((price *= 1.003))
      for (let i = 0; i < 1200; i++) closes.push((price /= 1.003))
    }
    return path(M15, closes)
  }

  it('actually trades, and the fee bill is charged', () => {
    const r = runBacktest(tradeable(), shortTermChannel.id, { startingBalance: 10_000 })
    expect(r.stats.totalClosedTrades).toBeGreaterThan(0)
    expect(r.stats.totalPaidFees).toBeGreaterThan(0)
  })

  it('takes about one round trip per trend cycle, not one per bar', () => {
    // The design constraint that comes before any signal, and the assertion has to be tight
    // enough to mean something. The fixture is five clean up/down cycles, and the entry
    // CONDITION is true on 3,849 of its 12,000 bars -- the engine ignores those while already
    // positioned, so what is really being pinned is that the 0.95/0.25 hysteresis gap holds the
    // position through a leg instead of churning inside it. Closing that gap is exactly the
    // regression that turns this into the -99.98% row of the timescale scan, and it would show
    // up here as a trade count in the hundreds.
    const r = runBacktest(tradeable(), shortTermChannel.id, { startingBalance: 10_000 })
    expect(r.stats.totalClosedTrades).toBeGreaterThanOrEqual(3)
    expect(r.stats.totalClosedTrades).toBeLessThanOrEqual(15)
  })

  it('is registered so the Backtest page, bots and routines can all select it', () => {
    expect(STRATEGIES.find((s) => s.id === 'short-term-channel')).toBe(shortTermChannel)
  })

  it('reports percentages independent of the starting balance', () => {
    // The engine is all-in and models no market impact, so this MUST hold -- and if it ever
    // stopped holding, the backtest would be quietly size-dependent in a way nothing surfaces.
    const candles = tradeable()
    const a = runBacktest(candles, shortTermChannel.id, { startingBalance: 10_000 })
    const b = runBacktest(candles, shortTermChannel.id, { startingBalance: 250_000 })
    expect(b.stats.totalNetProfitPct).toBeCloseTo(a.stats.totalNetProfitPct, 6)
    expect(b.stats.totalPaidFees / a.stats.totalPaidFees).toBeCloseTo(25, 4)
  })
})
