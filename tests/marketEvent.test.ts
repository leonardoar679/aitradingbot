import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import { T0, quiet, thenFlat, withMove } from './eventCandles'
import {
  EVENT_CANDIDATE_SCORE,
  EVENT_COOLDOWN_SECONDS,
  EVENT_DETECTOR_VERSION,
  MARKET_MOVE_BTC_PCT,
  MARKET_MOVE_MIN_EVENTS,
  MARKET_MOVE_SHARE,
  marketMoveOf,
  EVENT_LOOKBACK_BARS,
  EVENT_URGENT_SCORE,
  EVENT_WATCH_SCORE,
  candidateScore,
  detectEvents,
  eventBand,
  eventReasons,
  isScannablePair,
  marketEventId,
  raisesEvent,
  rankCandidates,
  readEventAt,
  toMarketEvent,
  type EventReading
} from '../shared/marketEvent'

function reading(bars: Candle[], index = bars.length - 1): EventReading {
  const result = readEventAt(bars, index)
  if (result === null) throw new Error('expected a reading')
  return result
}

describe('readEventAt', () => {
  it('needs twelve unbroken hours of bars ending where it reads', () => {
    const bars = quiet(EVENT_LOOKBACK_BARS + 5)
    expect(readEventAt(bars, EVENT_LOOKBACK_BARS - 2)).toBeNull()
    expect(readEventAt(bars, EVENT_LOOKBACK_BARS - 1)).not.toBeNull()
    expect(readEventAt(bars, bars.length)).toBeNull()
    // A missing minute anywhere in the window: every "n bars ago" would mean something else.
    const holed = bars.filter((_, i) => i !== 300)
    expect(readEventAt(holed, holed.length - 1)).toBeNull()
  })

  it('says a call on it executes on the next bar', () => {
    const bars = quiet(EVENT_LOOKBACK_BARS)
    const result = reading(bars)
    expect(result.barTime).toBe(bars[bars.length - 1].time)
    expect(result.time).toBe(bars[bars.length - 1].time + 60)
    expect(result.price).toBe(bars[bars.length - 1].close)
  })

  it('reads nothing at or after the bar a call executes on', () => {
    const bars = withMove({ pct: 2, volume: 6 })
    const index = bars.length - 1
    const before = reading(bars, index)
    const later = [...bars, ...quiet(30, 99).map((bar, i) => ({ ...bar, time: bars[index].time + (i + 1) * 60, close: bar.close * 3, high: bar.high * 3, volume: 9e9 }))]
    expect(reading(later, index)).toEqual(before)
  })

  it('does not depend on how much history came before the twelve hours', () => {
    const short = withMove({ pct: 2, volume: 6 }, EVENT_LOOKBACK_BARS)
    const long = withMove({ pct: 2, volume: 6 }, EVENT_LOOKBACK_BARS)
    // The same twelve hours, with a thousand unrelated bars in front of them.
    const lead = quiet(1000, 3).map((bar, i) => ({ ...bar, time: short[0].time - (1000 - i) * 60, close: bar.close * 5 }))
    expect(reading([...lead, ...long])).toEqual(reading(short.slice(short.length - EVENT_LOOKBACK_BARS)))
  })

  it('calls a quiet market quiet', () => {
    const result = reading(quiet(EVENT_LOOKBACK_BARS + 50))
    expect(result.type).toBeNull()
    expect(result.band).toBe('quiet')
    expect(result.score).toBeLessThan(EVENT_WATCH_SCORE)
  })

  it('does not let a move set its own yardstick', () => {
    const small = reading(withMove({ pct: 1 }))
    const large = reading(withMove({ pct: 4 }))
    // The usual size of a move is measured before either began, so it is the same for both...
    expect(large.sigma15Pct).toBeCloseTo(small.sigma15Pct, 12)
    // ...and the larger move is larger in those units, never smaller.
    expect(large.moveSigmas).toBeGreaterThan(small.moveSigmas * 3.5)
    expect(large.components.price).toBeGreaterThanOrEqual(small.components.price)
  })

  it('scores volume on a log scale: the usual volume is nothing, eight times is everything', () => {
    // Not exactly nothing: volume is counted in the quote asset, and the price has risen 1%.
    expect(reading(withMove({ pct: 1, volume: 1 })).components.volume).toBeLessThan(1)
    expect(reading(withMove({ pct: 1, volume: 2 })).components.volume).toBeCloseTo(100 / 3, 0)
    expect(reading(withMove({ pct: 1, volume: 8 })).components.volume).toBeCloseTo(100, 0)
    expect(reading(withMove({ pct: 1, volume: 50 })).components.volume).toBe(100)
    expect(reading(withMove({ pct: 1, volume: 8 })).volumeRatio).toBeCloseTo(8, 0)
  })

  it('counts pressure only in the direction of the move', () => {
    // A rise whose bars close at their highs, and the same rise closing a fifth of the way up.
    const lifted = reading(withMove({ pct: 2, closeAt: 1 }))
    const sold = reading(withMove({ pct: 2, closeAt: 0.2 }))
    expect(lifted.components.pressure).toBeCloseTo(100, 0)
    expect(sold.components.pressure).toBe(0)
    expect(sold.pressure).toBeLessThan(0)
    // A fall closing at its lows is pressure in ITS direction.
    expect(reading(withMove({ pct: -2, closeAt: 1 })).components.pressure).toBeCloseTo(100, 0)
  })

  it('names a rise that clears the prior four hours a breakout, and one that does not a pump', () => {
    const clears = reading(withMove({ pct: 2, volume: 8 }))
    expect(clears.type).toBe('breakout')
    expect(clears.breakPct).toBeGreaterThan(0)
    expect(clears.direction).toBe('up')

    // The same rise under a high printed two hours earlier.
    const bars = withMove({ pct: 2, volume: 8 })
    const capped = bars.map((bar, i) => (i === bars.length - 120 ? { ...bar, high: bar.high * 1.05 } : bar))
    const under = reading(capped)
    expect(under.type).toBe('pump')
    expect(under.breakPct).toBe(0)
    expect(under.components.breakout).toBe(0)
    expect(under.score).toBeLessThan(clears.score)
  })

  it('mirrors both for a fall', () => {
    const falls = reading(withMove({ pct: -2, volume: 8 }))
    expect(falls.type).toBe('breakdown')
    expect(falls.direction).toBe('down')
    expect(falls.breakPct).toBeLessThan(0)
    expect(falls.components.breakout).toBeGreaterThan(0)

    const bars = withMove({ pct: -2, volume: 8 })
    const floored = bars.map((bar, i) => (i === bars.length - 120 ? { ...bar, low: bar.low * 0.95 } : bar))
    expect(reading(floored).type).toBe('dump')
  })

  it('scores a rise and the same fall alike', () => {
    const up = reading(withMove({ pct: 3, volume: 8 }))
    const down = reading(withMove({ pct: -3, volume: 8 }))
    expect(down.score).toBeCloseTo(up.score, 0)
    expect(down.band).toBe(up.band)
  })

  it('knows a volume spike with no direction, scored on volume and range alone', () => {
    // Five minutes of heavy two-way trade that ends where it began.
    const churn = (volume: number): Candle[] => {
      const bars = quiet(EVENT_LOOKBACK_BARS + 20)
      const base = bars[bars.length - 1]
      for (let i = 1; i <= 15; i++) {
        const wide = i > 10
        bars.push({
          time: base.time + i * 60,
          open: base.close,
          high: base.close * (wide ? 1.004 : 1.0001),
          low: base.close * (wide ? 0.996 : 0.9999),
          close: base.close,
          volume: wide ? 1000 * volume : 1000
        })
      }
      return bars
    }
    const spike = reading(churn(10))
    expect(spike.direction).toBe('none')
    expect(spike.type).toBe('volume_spike')
    expect(spike.components.pressure).toBe(0)
    expect(spike.score).toBeCloseTo((spike.components.volume + spike.components.volatility) / 2, 10)
    expect(spike.score).toBeGreaterThanOrEqual(EVENT_WATCH_SCORE)
    // Less than a spike, and going nowhere, is nothing.
    expect(reading(churn(3)).type).toBeNull()
  })

  it('counts no break for a market with no direction, however new its high', () => {
    // A slow, steady climb: every minute a little higher than the last, so the close is always
    // above everything before it -- and the last fifteen minutes are an ordinary fifteen minutes.
    const bars: Candle[] = []
    let price = 100
    for (let i = 0; i < EVENT_LOOKBACK_BARS + 5; i++) {
      const open = price
      price = open * 1.00002
      bars.push({ time: 1_790_000_000 + i * 60, open, high: price, low: open, close: price, volume: 1000 })
    }
    const drift = reading(bars)
    expect(drift.direction).toBe('none')
    expect(drift.breakPct).toBeGreaterThan(0)
    expect(drift.components.breakout).toBe(0)
    expect(drift.type).toBeNull()
  })

  it('does not name a move too small to be watched', () => {
    const small = reading(withMove({ pct: 0.1 }))
    expect(small.direction).toBe('up')
    expect(small.band).toBe('quiet')
    expect(small.type).toBeNull()
  })

  it('reaches the candidate band for a large move on heavy volume, and not for a small one', () => {
    expect(reading(withMove({ pct: 3, volume: 8 })).score).toBeGreaterThanOrEqual(EVENT_CANDIDATE_SCORE)
    expect(reading(withMove({ pct: 0.05, volume: 1.5 })).score).toBeLessThan(EVENT_WATCH_SCORE)
  })
})

describe('eventBand', () => {
  it('uses the three thresholds', () => {
    expect(eventBand(EVENT_WATCH_SCORE - 0.01)).toBe('quiet')
    expect(eventBand(EVENT_WATCH_SCORE)).toBe('watch')
    expect(eventBand(EVENT_CANDIDATE_SCORE)).toBe('candidate')
    expect(eventBand(EVENT_URGENT_SCORE)).toBe('urgent')
  })
})

describe('raisesEvent', () => {
  const at = (time: number, band: EventReading['band'], type: EventReading['type'] = 'pump'): EventReading =>
    ({ ...reading(withMove({ pct: 3, volume: 8 })), time, band, type }) as EventReading

  it('raises one event for one pump, and another only when it climbs a band', () => {
    expect(raisesEvent(at(1000, 'candidate'), [])).toBe(true)
    expect(raisesEvent(at(1300, 'candidate'), [{ time: 1000, band: 'candidate' }])).toBe(false)
    expect(raisesEvent(at(1300, 'urgent'), [{ time: 1000, band: 'candidate' }])).toBe(true)
    expect(raisesEvent(at(1300, 'candidate'), [{ time: 1000, band: 'urgent' }])).toBe(false)
  })

  it('raises again once the cooldown has passed', () => {
    const earlier = [{ time: 1000, band: 'urgent' as const }]
    expect(raisesEvent(at(1000 + EVENT_COOLDOWN_SECONDS - 60, 'candidate'), earlier)).toBe(false)
    expect(raisesEvent(at(1000 + EVENT_COOLDOWN_SECONDS, 'candidate'), earlier)).toBe(true)
  })

  it('never raises a volume spike, which has no direction to act on', () => {
    const spike = { ...at(1000, 'urgent', 'volume_spike'), direction: 'none' } as EventReading
    expect(raisesEvent(spike, [])).toBe(false)
    expect(raisesEvent(spike, [], 'watch')).toBe(false)
  })

  it('raises nothing below the floor, and nothing that is not an event', () => {
    expect(raisesEvent(at(1000, 'watch'), [])).toBe(false)
    expect(raisesEvent(at(1000, 'watch'), [], 'watch')).toBe(true)
    expect(raisesEvent(at(1000, 'urgent', null), [])).toBe(false)
  })
})

describe('detectEvents', () => {
  it('finds one event in a pump, at the minute it first qualifies', () => {
    // Twenty quiet minutes after the move, at its last price.
    const bars = thenFlat(withMove({ pct: 3, volume: 8 }), 20)
    const events = detectEvents(bars)
    expect(events.length).toBeGreaterThanOrEqual(1)
    expect(events.length).toBeLessThanOrEqual(2) // candidate, then perhaps urgent
    for (let i = 1; i < events.length; i++) expect(events[i].score).toBeGreaterThan(events[i - 1].score)
    // Every one is what reading that bar alone gives: the scan adds a rule, not a second definition.
    for (const event of events) {
      const index = bars.findIndex((bar) => bar.time === event.barTime)
      expect(readEventAt(bars, index)).toEqual(event)
    }
  })

  it('does not raise a pump again because the scan started in the middle of it', () => {
    const bars = withMove({ pct: 3, volume: 8 })
    const all = detectEvents(bars)
    expect(all.length).toBeGreaterThan(0)
    // Starting one minute after the first event: the pump is still on, and already raised.
    const later = detectEvents(bars, { from: all[0].time + 60 })
    expect(later.map((event) => event.time)).toEqual(all.slice(1).map((event) => event.time))
  })

  it('keeps to the window it is given', () => {
    const bars = withMove({ pct: 3, volume: 8 })
    const all = detectEvents(bars)
    expect(detectEvents(bars, { to: all[0].time })).toEqual([])
    expect(detectEvents(bars, { from: all[0].time, to: all[0].time + 60 })).toEqual([all[0]])
  })

  it('finds nothing in a quiet market', () => {
    expect(detectEvents(quiet(EVENT_LOOKBACK_BARS + 300), { floor: 'watch' })).toEqual([])
  })
})

describe('toMarketEvent', () => {
  const market = { exchange: 'binance' as const, symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' }

  it('keeps the reading under an id that names the pair and the minute', () => {
    const source = reading(withMove({ pct: 3, volume: 8 }))
    const event = toMarketEvent(source, market)
    expect(event.id).toBe(marketEventId('binance', 'SOLUSDT', source.time))
    expect(event.id).toBe(`binance:SOLUSDT:${source.time}`)
    expect(event.detector).toBe(EVENT_DETECTOR_VERSION)
    expect(event.type).toBe(source.type)
    expect(event.live).toBeNull()
    // Survives a file: what is written is what is read back.
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
    expect(String(event.score).replace('.', '').replace(/^0+/, '').length).toBeLessThanOrEqual(6)
  })

  it('refuses a reading that is not an event', () => {
    expect(() => toMarketEvent(reading(quiet(EVENT_LOOKBACK_BARS)), market)).toThrow(/not an event/)
  })
})

describe('candidateScore', () => {
  it('is mostly the event, and partly whether the pair can be traded', () => {
    const deep = candidateScore(80, 500_000_000, 0.01)
    const thin = candidateScore(80, 800_000, 0.01)
    const wide = candidateScore(80, 500_000_000, 0.3)
    expect(deep).toBeGreaterThan(thin)
    expect(deep).toBeGreaterThan(wide)
    expect(candidateScore(90, 500_000_000, 0.01)).toBeGreaterThan(deep)
    // A strong event on an untradeable pair still loses to a weaker one on a liquid pair.
    expect(candidateScore(80, 500_000_000, 0.01)).toBeGreaterThan(candidateScore(97, 800_000, 0.3))
  })

  it('treats a number the scanner does not have as the middle, not as good or bad', () => {
    const unknown = candidateScore(80, null, null)
    expect(unknown).toBeGreaterThan(candidateScore(80, 800_000, 0.3))
    expect(unknown).toBeLessThan(candidateScore(80, 500_000_000, 0.01))
    // Each on its own: an unknown spread sits between a tight one and a wide one...
    expect(candidateScore(80, 500_000_000, null)).toBeLessThan(candidateScore(80, 500_000_000, 0.01))
    expect(candidateScore(80, 500_000_000, null)).toBeGreaterThan(candidateScore(80, 500_000_000, 0.3))
    // ...and an unknown volume between a deep market and a thin one.
    expect(candidateScore(80, null, 0.01)).toBeLessThan(candidateScore(80, 500_000_000, 0.01))
    expect(candidateScore(80, null, 0.01)).toBeGreaterThan(candidateScore(80, 800_000, 0.01))
  })
})

describe('rankCandidates', () => {
  it('orders by score and breaks a tie the same way every time', () => {
    const ranked = rankCandidates([
      { symbol: 'SOLUSDT', candidateScore: 80 },
      { symbol: 'DOGEUSDT', candidateScore: 91 },
      { symbol: 'ADAUSDT', candidateScore: 80 }
    ])
    expect(ranked.map((entry) => `${entry.rank}:${entry.symbol}`)).toEqual(['1:DOGEUSDT', '2:ADAUSDT', '3:SOLUSDT'])
  })
})

describe('isScannablePair', () => {
  it('watches pairs quoted in USDT that are not pegged to anything', () => {
    expect(isScannablePair({ baseAsset: 'SOL', quoteAsset: 'USDT' })).toBe(true)
    expect(isScannablePair({ baseAsset: 'SOL', quoteAsset: 'BTC' })).toBe(false)
    expect(isScannablePair({ baseAsset: 'USDC', quoteAsset: 'USDT' })).toBe(false)
    expect(isScannablePair({ baseAsset: 'WBTC', quoteAsset: 'USDT' })).toBe(false)
    // The dollar stablecoin found among the research's pairs on 13 October 2026 (V6 Stage 3).
    expect(isScannablePair({ baseAsset: 'U', quoteAsset: 'USDT' })).toBe(false)
    // Ends in "UP" and is not a leveraged token.
    expect(isScannablePair({ baseAsset: 'JUP', quoteAsset: 'USDT' })).toBe(true)
  })

  it('does not watch a token that tracks a stock, by what its exchange says and not by its name', () => {
    expect(isScannablePair({ baseAsset: 'SNDKB', quoteAsset: 'USDT', stockToken: true })).toBe(false)
    expect(isScannablePair({ baseAsset: 'SNDKB', quoteAsset: 'USDT' })).toBe(true)
    // Ends in "B" as every stock token does, and is a coin.
    expect(isScannablePair({ baseAsset: 'SHIB', quoteAsset: 'USDT', stockToken: false })).toBe(true)
  })
})

// THE DETECTOR AND ITS VERSION MOVE TOGETHER, OR NOT AT ALL, for the reason a prompt and its
// version do (tests/aiPromptVersions.test.ts). The version is written on every recorded experiment.
// Change a window, a scale, a band or the rule for raising an event and leave the version alone,
// and a sample drawn before the change sits beside one drawn after it as though one detector had
// found both.
//
// What the detector makes of one fixed market is held here as a hash beside the version it was
// made under. When this fails: if the change was meant, bump EVENT_DETECTOR_VERSION and put the
// new version and hash here. If it was not, the hash has just caught it.
describe('the detector and the version its events are recorded under', () => {
  /** A move of `pct` over fifteen minutes beginning at minute `at`, the last five of them on
   * `volume` times the usual. `wide` stretches those five bars: range, and no direction. */
  const MOVES: { at: number; pct: number; volume: number; wide?: number }[] = [
    { at: 900, pct: 2.4, volume: 9 },
    { at: 1500, pct: -3.1, volume: 6 },
    // A rise that stays under where the fall began, and later a fall that stays over where the
    // rise began: a pump and a dump, not a breakout and a breakdown.
    { at: 1540, pct: 2.2, volume: 8 },
    // A large move and, inside its cooldown, a smaller one that is still an event when the
    // cooldown ends: the minute it is raised at is the minute the cooldown says.
    { at: 2100, pct: 2.8, volume: 14 },
    { at: 2126, pct: 1.6, volume: 12 },
    { at: 2700, pct: -0.9, volume: 3 },
    { at: 3300, pct: 4, volume: 2 },
    { at: 3340, pct: -2.5, volume: 9 },
    { at: 3900, pct: -1.6, volume: 10 },
    // Heavy volume and wide bars going nowhere: a volume spike, read and never raised.
    { at: 4100, pct: 0.02, volume: 20, wide: 8 },
    // In the still stretch, where a move is measured against the floor on volatility.
    { at: 5700, pct: 0.6, volume: 7 }
  ]
  /** One minute with a high far above its close, 245 minutes before the first move begins: inside
   * the four hours a break is measured against for that move's first readings, outside them for
   * its last. */
  const SPIKE_AT = 655
  /** From here on the market barely moves: its usual fifteen-minute move is under the floor. */
  const STILL_FROM = 4320
  /** A minute that never traded: every window that spans it is no window at all. */
  const MISSING = 4500
  const MINUTES = 7200

  /** Five days of minutes: a seeded wander with the moves above laid over it. Nothing here is
   * random: the same bars every time. */
  function fixedMarket(): Candle[] {
    let state = 20261004
    const next = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648
      return state / 2147483648 - 0.5
    }
    const bars: Candle[] = []
    let price = 250
    for (let i = 0; i < MINUTES; i++) {
      const move = MOVES.find((entry) => i >= entry.at && i < entry.at + 15)
      const heavy = move !== undefined && i >= move.at + 10
      const open = price
      const close = open * (1 + next() * (i >= STILL_FROM ? 0.0002 : 0.0008) + (move ? move.pct / 15 / 100 : 0))
      const wick = Math.abs(next()) * 0.0004 * (heavy ? (move.wide ?? 1) : 1)
      const volume = 800 * (heavy ? move.volume : 1) * (1 + Math.abs(next()))
      if (i !== MISSING) {
        bars.push({ time: T0 + i * 60, open, high: Math.max(open, close) * (1 + wick + (i === SPIKE_AT ? 0.015 : 0)), low: Math.min(open, close) * (1 - wick), close, volume })
      }
      price = close
    }
    return bars
  }

  const market = { exchange: 'binance' as const, symbol: 'FIXEDUSDT', baseAsset: 'FIXED', quoteAsset: 'USDT' }
  const bars = fixedMarket()
  const round = (value: number | null): number | null => (value === null ? null : Number(value.toPrecision(6)))
  const minute = (time: number): number => (time - T0) / 60
  // Readings that raised nothing are part of what the detector is: one every seven minutes, and
  // every minute while a move builds and fades.
  const readAt = [
    ...Array.from({ length: Math.floor((MINUTES - 720) / 7) }, (_, i) => 720 + i * 7),
    ...MOVES.flatMap((move) => Array.from({ length: 24 }, (_, i) => move.at + 4 + i))
  ]
  const found = {
    candidates: detectEvents(bars).map((entry) => toMarketEvent(entry, market)),
    watched: detectEvents(bars, { floor: 'watch' }).map((entry) => toMarketEvent(entry, market)),
    readings: readAt
      .map((index) => readEventAt(bars, index))
      .map((entry) =>
        entry === null
          ? null
          : [entry.time, entry.band, entry.type, entry.direction, round(entry.score), round(entry.sigma15Pct), round(entry.volumeRatio), round(entry.rangeRatio), round(entry.pressure), round(entry.breakPct)]
      )
  }

  it('holds each thing the detector decides, so that a hash of it can tell when one has moved', () => {
    expect(new Set(found.watched.map((entry) => entry.type))).toEqual(new Set(['pump', 'dump', 'breakout', 'breakdown']))
    expect(new Set(found.candidates.map((entry) => entry.direction))).toEqual(new Set(['up', 'down']))
    expect(found.watched.length).toBeGreaterThan(found.candidates.length)
    expect(new Set(found.watched.map((entry) => entry.band)).size).toBe(3)

    // The cooldown: the smaller move is raised exactly thirty minutes after the larger one was
    // last raised, though it qualified before that.
    const large = found.watched.filter((entry) => minute(entry.time) >= 2100 && minute(entry.time) < 2126)
    const small = found.watched.filter((entry) => minute(entry.time) >= 2126 && minute(entry.time) < 2160)
    expect(large.length).toBeGreaterThan(0)
    expect(small.map((entry) => entry.time - large[large.length - 1].time)).toEqual([EVENT_COOLDOWN_SECONDS])
    expect(readEventAt(bars, bars.findIndex((bar) => bar.time === small[0].time - 120))?.band).not.toBe('quiet')

    // The four hours a break is measured against: the first move is under the high set 245
    // minutes before it began for as long as that high is inside them, and is raised as a
    // breakout at the first reading it is not.
    const first = found.watched.filter((entry) => minute(entry.time) >= 900 && minute(entry.time) < 930)
    expect(readEventAt(bars, SPIKE_AT + 254)).toMatchObject({ direction: 'up', breakPct: 0 })
    expect(readEventAt(bars, SPIKE_AT + 255)?.breakPct).toBeGreaterThan(0)
    expect(first[0]).toMatchObject({ type: 'breakout', time: T0 + (SPIKE_AT + 256) * 60 })

    // A volume spike with no direction is read, and raised by neither scan.
    const spike = found.readings.filter((entry) => entry !== null && entry[2] === 'volume_spike')
    expect(spike.length).toBeGreaterThan(0)
    expect(found.watched.some((entry) => entry.type === 'volume_spike')).toBe(false)

    // The floor on volatility is what the still stretch is measured against, and an event is found there.
    expect(found.readings.filter((entry) => entry !== null && entry[5] === 0.05).length).toBeGreaterThan(5)
    expect(found.watched.some((entry) => minute(entry.time) >= 5700)).toBe(true)

    // And a window with a minute missing gives no reading at all.
    expect(found.readings.filter((entry) => entry === null).length).toBeGreaterThan(3)
  })

  it('has not changed what it finds without its version being bumped', () => {
    const hash = createHash('sha256').update(JSON.stringify(found)).digest('hex')
    // events-v2 (8 October 2026) added the market-wide move, a rule over one pass's events; what the
    // detector makes of one pair's candles is unchanged. Later that day every event gained the
    // detector's version as a field (`detector`), which moved this hash and nothing it finds; and
    // with V5 Stage 4 a `fingerprint`, computed from the event's own figures, which moved it again
    // (from 6e6510eeac6d6b917f2dd56b232d09e0fef84b7537e2da378736540eb052a4f6) and finds nothing new.
    expect({ version: EVENT_DETECTOR_VERSION, hash }).toEqual({ version: 'events-v2', hash: '0ee63718239d237152745e12b13e3d563abbe0aba3f408f157226a90e51d6c2d' })
  })
})

describe('eventReasons', () => {
  const market = { exchange: 'binance' as const, symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT' }

  it('gives each of the five components beside the reading it was made from', () => {
    const event = toMarketEvent(reading(withMove({ pct: 3, volume: 8 })), market)
    const reasons = eventReasons(event)
    expect(reasons.map((reason) => reason.component)).toEqual(['price', 'volume', 'volatility', 'pressure', 'breakout'])
    expect(reasons.map((reason) => reason.label)).toEqual(['Move', 'Volume', 'Bar size', 'Pressure', 'Break'])
    // The scores are the event's own, and their mean is its score.
    expect(reasons.map((reason) => reason.score)).toEqual([event.components.price, event.components.volume, event.components.volatility, event.components.pressure, event.components.breakout])
    expect(reasons.reduce((sum, reason) => sum + reason.score, 0) / 5).toBeCloseTo(event.score, 3)
    expect(reasons[0].fact).toBe(`+${event.returnsPct.m15.toFixed(2)}% in fifteen minutes, ${Math.abs(event.moveSigmas).toFixed(1)} times its usual size (full at 5)`)
    expect(reasons[1].fact).toBe(`the last five minutes traded ${(event.volumeRatio ?? 0).toFixed(1)} times the usual (full at 8)`)
    expect(reasons[2].fact).toBe(`bars ${(event.rangeRatio ?? 0).toFixed(1)} times their usual range (full at 5)`)
    expect(reasons[3].fact).toBe('the last five minutes closed 100% of the way up their bars, by volume')
    expect(reasons[4].fact).toBe('above the high of the four hours before the move, by 2 usual moves or more')
  })

  it('says a fall the other way up, and a move inside the range as inside it', () => {
    const down = eventReasons(toMarketEvent(reading(withMove({ pct: -3, volume: 8 })), market))
    // Fifteen falls of a fifth of a percent compound to a little under three.
    expect(down[0].fact).toMatch(/^-2\.9\d% in fifteen minutes, \d+\.\d times its usual size/)
    expect(down[3].fact).toBe('the last five minutes closed 100% of the way down their bars, by volume')
    expect(down[4].fact).toBe('below the low of the four hours before the move, by 2 usual moves or more')

    const inside = eventReasons({
      components: { price: 80, volume: 60, volatility: 40, pressure: 0, breakout: 0 },
      returnsPct: { m1: 0, m5: 0.5, m15: 1.2, h1: -2, h4: -3 },
      moveSigmas: 4,
      volumeRatio: null,
      rangeRatio: null,
      direction: 'up'
    })
    // Each score sits beside its own name, not its neighbour's.
    expect(inside.map((reason) => `${reason.label} ${reason.score}`)).toEqual(['Move 80', 'Volume 60', 'Bar size 40', 'Pressure 0', 'Break 0'])
    expect(inside[1].fact).toBe('nothing traded in the hours before to compare the last five minutes with')
    expect(inside[2].fact).toBe('no usual bar size to compare with')
    expect(inside[3].fact).toBe('the last five minutes did not close on the upper side of their bars')
    expect(inside[4].fact).toBe('inside the range of the four hours before the move')
  })

  it('says where the closes sat from the score, which is that reading on a fixed scale', () => {
    const half = eventReasons({
      components: { price: 80, volume: 60, volatility: 40, pressure: 50, breakout: 40 },
      returnsPct: { m1: 0, m5: 0.5, m15: -1.2, h1: -2, h4: -3 },
      moveSigmas: -4,
      volumeRatio: 3,
      rangeRatio: 2,
      direction: 'down'
    })
    expect(half[3].fact).toBe('the last five minutes closed 75% of the way down their bars, by volume')
    // A break short of the full two usual moves is a break, and is not called more.
    expect(half[4].fact).toBe('below the low of the four hours before the move')
  })
})

// A MARKET-WIDE MOVE (8 October 2026, the second V3 document's §17 and §43-44): one pass's events,
// most of them one way, with Bitcoin, are one event on Bitcoin's pair. The lines were written down
// before any result.
describe('marketMoveOf', () => {
  type Row = Parameters<typeof marketMoveOf>[0][number]
  const row = (symbol: string, direction: Row['direction'] = 'up', over: Partial<Row> = {}): Row => ({ symbol, direction, band: 'candidate', score: 80, returnM15Pct: direction === 'up' ? 2 : -2, volumeRatio: 3, ...over })
  const alts = (n: number, direction: Row['direction'] = 'up'): Row[] => Array.from({ length: n }, (_, i) => row(`A${i}USDT`, direction, { score: 70 + i }))
  const btc = (returnM15Pct: number): { symbol: string; returnM15Pct: number } => ({ symbol: 'BTCUSDT', returnM15Pct })

  it('is five or more events one way with Bitcoin: the members strongest first, the strongest band, Bitcoin left out', () => {
    expect(MARKET_MOVE_MIN_EVENTS).toBe(5)
    expect(MARKET_MOVE_SHARE).toBe(0.8)
    expect(MARKET_MOVE_BTC_PCT).toBe(1)
    const move = marketMoveOf([...alts(4), row('BTCUSDT', 'up', { band: 'urgent', score: 60 })], btc(1.2))
    expect(move).not.toBeNull()
    expect(move?.direction).toBe('up')
    expect(move?.band).toBe('urgent')
    expect(move?.members.map((member) => member.symbol)).toEqual(['A3USDT', 'A2USDT', 'A1USDT', 'A0USDT'])
    expect(move?.members[0]).toEqual({ symbol: 'A3USDT', direction: 'up', score: 73, returnM15Pct: 2, volumeRatio: 3 })
    // Without Bitcoin's own event, five alts are the move, all of them members.
    expect(marketMoveOf(alts(5), btc(1))?.members).toHaveLength(5)
  })

  it('is nothing under five events, under four in five one way, or with Bitcoin not moving that way', () => {
    expect(marketMoveOf(alts(4), btc(2))).toBeNull()
    expect(marketMoveOf([...alts(3), ...alts(2, 'down')], btc(2))).toBeNull()
    expect(marketMoveOf([...alts(4), ...alts(1, 'down')], btc(2))?.direction).toBe('up')
    expect(marketMoveOf(alts(5), btc(0.99))).toBeNull()
    expect(marketMoveOf(alts(5), btc(-3))).toBeNull()
    expect(marketMoveOf(alts(5), null)).toBeNull()
    // A volume spike with no direction is not an event of either way.
    expect(marketMoveOf([...alts(4), row('XUSDT', 'none')], btc(2))).toBeNull()
  })

  it('mirrors for a fall', () => {
    const move = marketMoveOf([...alts(6, 'down'), row('BTCUSDT', 'down', { band: 'candidate' })], btc(-1.5))
    expect(move).toMatchObject({ direction: 'down', band: 'candidate' })
    expect(move?.members).toHaveLength(6)
    expect(move?.members.every((member) => member.direction === 'down')).toBe(true)
  })
})
