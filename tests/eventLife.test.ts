import { describe, expect, it } from 'vitest'
import {
  EVENT_ACTIVE_PASSES,
  EVENT_CAUSE_NEWS_IMPACT,
  EVENT_CAUSE_NEWS_SECONDS,
  EVENT_CAUSE_ORGANIC_VOLUME,
  EVENT_CONFIRM_VOLUME_RATIO,
  EVENT_EXPIRY_SECONDS,
  EVENT_STATUSES,
  EVENT_WATCH_SCORE,
  FINGERPRINT_BUCKET_SECONDS,
  describeEventCause,
  describeEventStatus,
  eventCauseOf,
  eventFingerprint,
  nextEventLife,
  startedLife,
  type EventFollowUp,
  type EventLife
} from '../shared/marketEvent'
import { parseEventStatusLines } from '../shared/marketScanner'

// THE EVENT'S LIFE, ITS FINGERPRINT AND ITS CAUSE (shared/marketEvent.ts; the V5 document, §19-21;
// V5 Stage 4, 8 October 2026). The scanner advances each live event from its own readings
// (electron/services/marketScannerService.ts, held in tests/marketScanner.test.ts); the rules are here.

const T = 1_790_000_000 - (1_790_000_000 % 60)
const returns = { m1: 0.2, m5: 1, m15: 3, h1: 3, h4: 3 }

const pump = (over: Partial<{ time: number; price: number; type: 'pump' | 'breakout' | 'breakdown' | 'dump'; direction: 'up' | 'down'; returnsPct: typeof returns }> = {}) => ({
  time: T,
  price: 100,
  type: 'pump' as const,
  direction: 'up' as const,
  returnsPct: returns,
  ...over
})

const follow = (minutesLater: number, over: Partial<EventFollowUp> = {}): EventFollowUp => ({
  time: T + minutesLater * 60,
  price: 100,
  score: 80,
  band: 'urgent',
  direction: 'up',
  returnsPct: returns,
  volumeRatio: 5,
  breakPct: 0,
  ...over
})

describe("the event's life", () => {
  it('begins detected at the raise, and is confirmed by the next pass that reads the pair in the band the same way', () => {
    const life = startedLife(pump())
    expect(life).toEqual({ status: 'detected', passesInBand: 0, at: T })
    const next = nextEventLife(pump(), life, follow(1))
    expect(next).toEqual({ status: 'confirmed', passesInBand: 1, at: T + 60 })
  })

  it('is active after two more passes in the band, counted from the one that confirmed it', () => {
    let life = startedLife(pump())
    for (let minute = 1; minute <= 1 + EVENT_ACTIVE_PASSES; minute++) life = nextEventLife(pump(), life, follow(minute))
    expect(life).toEqual({ status: 'active', passesInBand: 3, at: T + 180 })
    expect(EVENT_ACTIVE_PASSES).toBe(2)
    // One pass short is still confirmed.
    let short = startedLife(pump())
    for (let minute = 1; minute <= EVENT_ACTIVE_PASSES; minute++) short = nextEventLife(pump(), short, follow(minute))
    expect(short.status).toBe('confirmed')
  })

  it('stays as it was on a pass that neither confirms nor weakens it, the same object back', () => {
    const life = nextEventLife(pump(), startedLife(pump()), follow(1))
    // In the watch band but no longer a candidate, the price holding: nothing new.
    const same = nextEventLife(pump(), life, follow(2, { band: 'watch', score: 65 }))
    expect(same).toBe(life)
    // A reading no later than the last changes nothing either.
    expect(nextEventLife(pump(), life, follow(1))).toBe(life)
    expect(nextEventLife(pump(), life, follow(0))).toBe(life)
  })

  it('weakens when the score falls below the watch band, or half the move is given back, and then stays weakening', () => {
    const confirmed = nextEventLife(pump(), startedLife(pump()), follow(1))
    expect(nextEventLife(pump(), confirmed, follow(2, { score: EVENT_WATCH_SCORE - 1, band: 'watch' }))).toEqual({ status: 'weakening', passesInBand: 1, at: T + 120 })
    expect(nextEventLife(pump(), confirmed, follow(2, { score: EVENT_WATCH_SCORE, band: 'watch' }))).toBe(confirmed)
    // The move was +3%: at -1.5% from the raise's price, half of it is gone.
    const halfBack = nextEventLife(pump(), confirmed, follow(2, { price: 98.5 }))
    expect(halfBack.status).toBe('weakening')
    expect(nextEventLife(pump(), confirmed, follow(2, { price: 98.6 })).status).toBe('confirmed')
    // Weakening is not confirmed again by a strong pass; only expiry follows.
    expect(nextEventLife(pump(), halfBack, follow(3))).toBe(halfBack)
    // A detected event can weaken straight away.
    expect(nextEventLife(pump(), startedLife(pump()), follow(1, { score: 10, band: 'quiet', direction: 'none' })).status).toBe('weakening')
  })

  it('expires when the whole move is given back, after an hour whatever the price did, and then stays expired', () => {
    const confirmed = nextEventLife(pump(), startedLife(pump()), follow(1))
    const allBack = nextEventLife(pump(), confirmed, follow(2, { price: 97 }))
    expect(allBack).toEqual({ status: 'expired', passesInBand: 1, at: T + 120 })
    expect(nextEventLife(pump(), confirmed, follow(2, { price: 97.1 })).status).toBe('weakening')
    const hour = nextEventLife(pump(), confirmed, follow(EVENT_EXPIRY_SECONDS / 60))
    expect(hour.status).toBe('expired')
    expect(nextEventLife(pump(), confirmed, follow(EVENT_EXPIRY_SECONDS / 60 - 1)).status).toBe('confirmed')
    expect(nextEventLife(pump(), allBack, follow(3))).toBe(allBack)
    expect(EVENT_EXPIRY_SECONDS).toBe(3600)
  })

  it('reads a fall the other way up: a dump weakens on a rise of half its size and expires on all of it', () => {
    const dump = pump({ direction: 'down', type: 'dump', returnsPct: { ...returns, m15: -4 } })
    const confirmed = nextEventLife(dump, startedLife(dump), follow(1, { direction: 'down' }))
    expect(confirmed.status).toBe('confirmed')
    expect(nextEventLife(dump, confirmed, follow(2, { direction: 'down', price: 102 })).status).toBe('weakening')
    expect(nextEventLife(dump, confirmed, follow(2, { direction: 'down', price: 104 })).status).toBe('expired')
    // A reading pointing up is not in the band for a dump.
    expect(nextEventLife(dump, confirmed, follow(2, { direction: 'up' }))).toBe(confirmed)
  })

  it('confirms a breakout by the level it holds on volume, even when the score no longer makes a candidate', () => {
    const breakout = pump({ type: 'breakout' })
    const held = follow(1, { band: 'watch', score: 65, breakPct: 0.4, volumeRatio: EVENT_CONFIRM_VOLUME_RATIO })
    expect(nextEventLife(breakout, startedLife(breakout), held).status).toBe('confirmed')
    expect(nextEventLife(breakout, startedLife(breakout), { ...held, volumeRatio: EVENT_CONFIRM_VOLUME_RATIO - 0.1 })).toEqual(startedLife(breakout))
    expect(nextEventLife(breakout, startedLife(breakout), { ...held, breakPct: -0.1 })).toEqual(startedLife(breakout))
    // A pump has no level to hold: the band alone confirms it.
    expect(nextEventLife(pump(), startedLife(pump()), held)).toEqual(startedLife(pump()))
    expect(EVENT_CONFIRM_VOLUME_RATIO).toBe(1.5)
  })

  it('has five statuses, each said in a word with a line', () => {
    expect(EVENT_STATUSES).toEqual(['detected', 'confirmed', 'active', 'weakening', 'expired'])
    expect(describeEventStatus('confirmed').word).toBe('CONFIRMED')
    expect(describeEventStatus('expired').detail).toContain('a newer event of the pair took its place')
  })
})

describe('the fingerprint', () => {
  const event = (over: Partial<{ symbol: string; type: 'pump' | 'breakout'; time: number; returnsPct: typeof returns; volumeRatio: number | null }> = {}) => ({
    exchange: 'binance' as const,
    symbol: 'SOLUSDT',
    type: 'pump' as const,
    time: T,
    returnsPct: returns,
    volumeRatio: 5,
    ...over
  })

  it('is the pair, the kind, the quarter-hour, the move to the step below and the volume to the nearest multiple', () => {
    const bucket = Math.floor(T / FINGERPRINT_BUCKET_SECONDS)
    expect(eventFingerprint(event())).toBe(`binance:SOLUSDT:pump:${bucket}:m2:v5`)
    expect(eventFingerprint(event({ returnsPct: { ...returns, m15: 3.9 } }))).toBe(eventFingerprint(event()))
    expect(eventFingerprint(event({ returnsPct: { ...returns, m15: 4 } }))).not.toBe(eventFingerprint(event()))
    expect(eventFingerprint(event({ returnsPct: { ...returns, m15: -3 } }))).toBe(eventFingerprint(event()))
    expect(eventFingerprint(event({ volumeRatio: 5.4 }))).toBe(eventFingerprint(event()))
    expect(eventFingerprint(event({ volumeRatio: 5.6 }))).not.toBe(eventFingerprint(event()))
    expect(eventFingerprint(event({ volumeRatio: null }))).toBe(`binance:SOLUSDT:pump:${bucket}:m2:v?`)
    expect(eventFingerprint(event({ volumeRatio: 0.2 }))).toContain(':v1')
  })

  it('is one for one move raised twice inside a quarter-hour, and two across the quarter-hour, the kind or the pair', () => {
    const start = T - (T % FINGERPRINT_BUCKET_SECONDS)
    expect(eventFingerprint(event({ time: start }))).toBe(eventFingerprint(event({ time: start + FINGERPRINT_BUCKET_SECONDS - 60 })))
    expect(eventFingerprint(event({ time: start }))).not.toBe(eventFingerprint(event({ time: start + FINGERPRINT_BUCKET_SECONDS })))
    expect(eventFingerprint(event({ type: 'breakout' }))).not.toBe(eventFingerprint(event()))
    expect(eventFingerprint(event({ symbol: 'ETHUSDT' }))).not.toBe(eventFingerprint(event()))
  })
})

describe('the cause', () => {
  const base = { baseAsset: 'SOL', time: T, type: 'pump' as const, direction: 'up' as const, returnsPct: returns, volumeRatio: 5, live: null, news: undefined }
  const story = (over: Partial<{ publishedAt: number; impact: number; assets: { ticker: string; relationship: 'DIRECT' | 'INDIRECT' }[] }> = {}) => ({
    publishedAt: T - 600,
    impact: 70,
    assets: [{ ticker: 'SOL', relationship: 'DIRECT' as const }],
    ...over
  })

  it('reads the market first, then news on the coin, then exhaustion, then organic, else unknown', () => {
    expect(eventCauseOf({ ...base, type: 'market_move' }, [story()])).toBe('market')
    expect(eventCauseOf({ ...base, live: { detectedAt: T, quoteVolume24h: null, spreadPct: null, candidateScore: 80, rank: 2, marketMove: 'binance:BTCUSDT:1' } }, [story()])).toBe('market')
    expect(eventCauseOf(base, [story()])).toBe('news')
    expect(eventCauseOf({ ...base, news: { articleId: 1, title: 'x', releaseSec: T } }, [])).toBe('news')
    expect(eventCauseOf({ ...base, returnsPct: { ...returns, m5: -0.5 }, volumeRatio: 0.8 }, [])).toBe('exhaustion')
    expect(eventCauseOf(base, [])).toBe('organic')
    expect(eventCauseOf({ ...base, volumeRatio: EVENT_CAUSE_ORGANIC_VOLUME - 0.1 }, [])).toBe('unknown')
    expect(eventCauseOf({ ...base, volumeRatio: null }, [])).toBe('unknown')
  })

  it('takes a story as the cause only when it names the coin directly, two hours before at most, at impact 45 or more', () => {
    expect(eventCauseOf(base, [story({ assets: [{ ticker: 'SOL', relationship: 'INDIRECT' }] })])).toBe('organic')
    expect(eventCauseOf(base, [story({ assets: [{ ticker: 'ETH', relationship: 'DIRECT' }] })])).toBe('organic')
    expect(eventCauseOf(base, [story({ publishedAt: T - EVENT_CAUSE_NEWS_SECONDS })])).toBe('news')
    expect(eventCauseOf(base, [story({ publishedAt: T - EVENT_CAUSE_NEWS_SECONDS - 1 })])).toBe('organic')
    expect(eventCauseOf(base, [story({ publishedAt: T + 1 })])).toBe('organic')
    expect(eventCauseOf(base, [story({ impact: EVENT_CAUSE_NEWS_IMPACT })])).toBe('news')
    expect(eventCauseOf(base, [story({ impact: EVENT_CAUSE_NEWS_IMPACT - 1 })])).toBe('organic')
  })

  it('reads exhaustion only against the move on less than the usual volume', () => {
    expect(eventCauseOf({ ...base, returnsPct: { ...returns, m5: -0.5 }, volumeRatio: 1 }, [])).toBe('unknown')
    expect(eventCauseOf({ ...base, returnsPct: { ...returns, m5: -0.5 }, volumeRatio: 3 }, [])).toBe('organic')
    expect(eventCauseOf({ ...base, direction: 'down', returnsPct: { ...returns, m5: 0.5, m15: -3 }, volumeRatio: 0.5 }, [])).toBe('exhaustion')
    expect(eventCauseOf({ ...base, direction: 'down', returnsPct: { ...returns, m5: -0.5, m15: -3 }, volumeRatio: 0.5 }, [])).toBe('unknown')
    expect(describeEventCause('exhaustion')).toBe('exhaustion')
    expect(describeEventCause('market')).toBe('with the market')
  })
})

describe('the status file', () => {
  it('reads its lines, skips what does not parse, and takes a missing pass count as none', () => {
    const line: EventLife & { eventId: string } = { eventId: 'binance:SOLUSDT:1', status: 'confirmed', passesInBand: 1, at: T }
    const text = [
      JSON.stringify({ kind: 'status', eventId: line.eventId, status: line.status, passes: 1, at: T, score: 80, m15Pct: 3 }),
      JSON.stringify({ kind: 'status', eventId: 'binance:ETHUSDT:1', status: 'detected', at: T, score: 70, m15Pct: 2 }),
      JSON.stringify({ kind: 'status', eventId: 'x', status: 'nonsense', at: T, score: 1, m15Pct: 1 }),
      JSON.stringify({ kind: 'event', id: 'y' }),
      '{"torn'
    ].join('\n')
    expect(parseEventStatusLines(text)).toEqual([
      { kind: 'status', eventId: 'binance:SOLUSDT:1', status: 'confirmed', passes: 1, at: T, score: 80, m15Pct: 3 },
      { kind: 'status', eventId: 'binance:ETHUSDT:1', status: 'detected', passes: 0, at: T, score: 70, m15Pct: 2 }
    ])
  })
})
