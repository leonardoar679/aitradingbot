import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import { explainMove } from '../shared/moveExplanation'
import type { ReadStory } from '../shared/newsFeed'

// shared/moveExplanation.ts: "Why did it move?" (the second V3 document, §30) -- a move set against
// Bitcoin's and its usual volume, and the stories that name the coin, labelled by fixed rules and
// never with a cause it did not find.

const NOW = Date.parse('2026-10-06T12:00:30Z') / 1000
const LAST = Math.floor(NOW / 60) * 60 - 60

/** Four hours of closed minutes ending at LAST: flat at 100 until the last hour, then rising to
 * `end`, with volume 10 and `hourVolume` in the last hour. */
function minutes(end = 104.7, hourVolume = 10): Candle[] {
  const out: Candle[] = []
  for (let k = 239; k >= 0; k--) {
    const time = LAST - k * 60
    const close = k >= 60 ? 100 : 100 + ((end - 100) * (60 - k)) / 60
    out.push({ time, open: close, high: close, low: close, close, volume: k < 60 ? hourVolume : 10 })
  }
  return out
}

function story(over: Partial<ReadStory> = {}): ReadStory {
  return {
    id: 'coindesk:1',
    source: 'coindesk',
    sourceName: 'CoinDesk',
    sourceClass: 'media',
    title: 'Solana ecosystem announcement',
    url: 'https://www.coindesk.com/x',
    publishedAt: NOW - 50 * 60,
    seenAt: NOW - 49 * 60,
    summary: '',
    assets: [{ ticker: 'SOL', relationship: 'DIRECT' }],
    marketWide: false,
    eventType: 'PARTNERSHIP',
    credibility: 0.85,
    impact: 60,
    stale: false,
    alsoIn: [],
    ...over
  }
}

const explain = (stories: ReadStory[], bars = minutes(), btc = minutes(100)): ReturnType<typeof explainMove> =>
  explainMove({ symbol: 'SOLUSDT', ticker: 'SOL', bars, btcBars: btc, stories, nowSec: NOW })

describe('why a pair moved', () => {
  it('measures the move, the volume against its usual and Bitcoin over the same hour', () => {
    const result = explain([], minutes(104.7, 40))
    expect(result.movePct).toBeCloseTo(4.7, 6)
    expect(result.volumeRatio).toBeCloseTo(4, 6)
    expect(result.btcMovePct).toBeCloseTo(0, 6)
    expect(result.marketShare).toBe(0)
  })

  it("is KNOWN with Binance's own announcement about the coin", () => {
    const result = explain([story({ id: 'binance:9', source: 'binance', sourceName: 'Binance', sourceClass: 'exchange', title: 'Binance Will List SOL Futures', eventType: 'LISTING', impact: 75 })])
    expect(result.label).toBe('KNOWN')
    expect(result.summary).toMatch(/^SOLUSDT moved \+4\.70% in 60 minutes on 1\.0× its usual volume\. Known cause: Binance Will List SOL Futures \(Binance, 11:10 UTC\)\.$/)
  })

  it('is PROBABLE with a story about it, and only POSSIBLE when the story would have moved it the other way, or only mentions it', () => {
    expect(explain([story()]).label).toBe('PROBABLE')
    const against = explain([story({ eventType: 'HACK', title: 'SOL bridge hacked', impact: 77 })])
    expect(against.label).toBe('POSSIBLE')
    expect(against.causes[0].text).toMatch(/would have moved it the other way$/)
    expect(explain([story({ assets: [{ ticker: 'SOL', relationship: 'INDIRECT' }] })]).label).toBe('POSSIBLE')
  })

  it('is POSSIBLE when Bitcoin made most of the move, or the volume surged with no story, and UNKNOWN otherwise', () => {
    const withMarket = explain([], minutes(104.7), minutes(103))
    expect(withMarket.label).toBe('POSSIBLE')
    expect(withMarket.causes[0]).toMatchObject({ kind: 'market' })
    expect(withMarket.causes[0].text).toMatch(/^Bitcoin moved \+3\.00% over the same 60 minutes: about 64% of this move\.$/)
    const surge = explain([], minutes(104.7, 30))
    expect(surge.label).toBe('POSSIBLE')
    expect(surge.causes.map((cause) => cause.kind)).toEqual(['volume'])
    const nothing = explain([])
    expect(nothing.label).toBe('UNKNOWN')
    expect(nothing.causes).toEqual([])
    expect(nothing.summary).toBe('SOLUSDT moved +4.70% in 60 minutes on 1.0× its usual volume. No cause found: no story names SOL in the last 3 hours, and Bitcoin moved 0.00%.')
  })

  it('names no cause for a move under half a percent, and still lists what it found', () => {
    const quiet = explain([story()], minutes(100.3), minutes(100.2))
    expect(quiet.label).toBe('UNKNOWN')
    expect(quiet.summary).toBe('SOLUSDT moved +0.30% in 60 minutes on 1.0× its usual volume. That is under 0.5% either way: not a move to explain.')
    expect(quiet.causes.map((cause) => cause.kind)).toEqual(['news'])
    expect(quiet.marketShare).toBeNull()
    // Nothing is "0.00%", never "-0.00%".
    expect(explain([], minutes(99.999)).summary).toMatch(/^SOLUSDT moved 0\.00% in 60 minutes/)
  })

  it('names the story a PROBABLE rests on, and Bitcoin beside it when it made most of the move', () => {
    const both = explain([story({ impact: 30 })], minutes(104.7), minutes(103))
    expect(both.label).toBe('PROBABLE')
    expect(both.summary).toBe(
      'SOLUSDT moved +4.70% in 60 minutes on 1.0× its usual volume. Probable cause: Solana ecosystem announcement (CoinDesk, 11:10 UTC). Bitcoin moved +3.00% over the same 60 minutes: about 64% of this move.'
    )
  })

  it('names no story from before the window and the two hours ahead of it, or about another coin', () => {
    expect(explain([story({ publishedAt: NOW - 4 * 3600 })]).label).toBe('UNKNOWN')
    expect(explain([story({ assets: [{ ticker: 'XRP', relationship: 'DIRECT' }] })]).label).toBe('UNKNOWN')
  })

  it('says it could not read a pair without the minutes', () => {
    const result = explain([], minutes().slice(-30))
    expect(result.movePct).toBeNull()
    expect(result.summary).toMatch(/^SOLUSDT's last 60 minutes could not be read\./)
  })
})

describe('each cause\'s part, and the order things happened (8 October 2026)', () => {
  it('names a direct story before the move at 70 or more the primary catalyst, a weaker one secondary, a faint mention unknown', () => {
    const primary = explain([story({ impact: 75 })])
    expect(primary.causes[0]).toMatchObject({ kind: 'news', role: 'PRIMARY CATALYST', relevance: 75 })
    expect(explain([story({ impact: 60 })]).causes[0].role).toBe('SECONDARY')
    expect(explain([story({ impact: 75, assets: [{ ticker: 'SOL', relationship: 'INDIRECT' }] })]).causes[0].role).toBe('SECONDARY')
    expect(explain([story({ impact: 30, assets: [{ ticker: 'SOL', relationship: 'INDIRECT' }] })]).causes[0].role).toBe('UNKNOWN')
  })

  it('names a story published after the move began unrelated, and rests no label on it', () => {
    // The move is half made at the thirty-first minute of the hour (the thirtieth bar from its end); a story ten minutes later cannot be its cause.
    const base = explain([])
    expect(base.moveStartAt).toBe(LAST - 30 * 60)
    const late = explain([story({ impact: 75, publishedAt: (base.moveStartAt ?? 0) + 600 })])
    expect(late.causes[0]).toMatchObject({ role: 'UNRELATED' })
    expect(late.causes[0].text).toMatch(/ — published after the move began$/)
    expect(late.label).toBe('POSSIBLE')
    expect(explain([story({ impact: 75, publishedAt: (base.moveStartAt ?? 0) - 60 })]).label).toBe('PROBABLE')
  })

  it('names Bitcoin the market amplifier and a surge in volume secondary', () => {
    expect(explain([], minutes(104.7), minutes(103)).causes[0]).toMatchObject({ kind: 'market', role: 'MARKET AMPLIFIER' })
    expect(explain([], minutes(104.7, 30)).causes[0]).toMatchObject({ kind: 'volume', role: 'SECONDARY' })
  })

  it('tells what happened in order: the market, the story, the volume peak, the move half made, and the analyst', () => {
    const bars = minutes(104.7, 10)
    bars[bars.length - 20] = { ...bars[bars.length - 20], volume: 80 }
    const result = explainMove({
      symbol: 'SOLUSDT',
      ticker: 'SOL',
      bars,
      btcBars: minutes(101),
      stories: [story({ impact: 75, publishedAt: NOW - 50 * 60 })],
      nowSec: NOW,
      reading: { at: NOW - 120, text: 'The listing explains most of it.' }
    })
    expect(result.timeline.map((entry) => [entry.kind, entry.at])).toEqual([
      ['market', NOW - 3600],
      ['story', NOW - 50 * 60],
      ['price', LAST - 30 * 60],
      ['volume', LAST - 19 * 60],
      ['reading', NOW - 120]
    ])
    expect(result.timeline[1].text).toBe('Solana ecosystem announcement (CoinDesk): primary catalyst.')
    expect(result.timeline[2].text).toBe('The move is half made: +4.70% by 12:00 UTC.')
    expect(result.timeline[3].text).toBe('Volume peaks at 8.0× its usual minute.')
    expect(result.timeline[4].text).toBe('The analyst: The listing explains most of it.')
    // No volume peak worth telling, and no analyst: neither is on the timeline.
    expect(explain([story()]).timeline.map((entry) => entry.kind)).toEqual(['market', 'story', 'price'])
  })
})
