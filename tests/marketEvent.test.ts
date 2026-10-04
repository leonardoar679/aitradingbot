import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import { quiet, thenFlat, withMove } from './eventCandles'
import {
  EVENT_CANDIDATE_SCORE,
  EVENT_COOLDOWN_SECONDS,
  EVENT_LOOKBACK_BARS,
  EVENT_URGENT_SCORE,
  EVENT_WATCH_SCORE,
  candidateScore,
  detectEvents,
  eventBand,
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
    // Ends in "UP" and is not a leveraged token.
    expect(isScannablePair({ baseAsset: 'JUP', quoteAsset: 'USDT' })).toBe(true)
  })
})
