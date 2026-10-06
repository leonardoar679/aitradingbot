import { describe, expect, it } from 'vitest'
import {
  BTC_CRASH_PCT,
  BTC_CRASH_REARM_PCT,
  btcHourMovePct,
  crashNotice,
  crashStep,
  healNoticeSeverity,
  noticeSeverity,
  storyNotice,
  storySeverity
} from '../shared/alerts'
import type { Candle } from '../shared/ipc'
import type { ReadStory } from '../shared/newsFeed'

// shared/alerts.ts: how loud news and the market are (the second V3 document, §28-29). The handler
// that obeys it is held in tests/appNotify.test.ts; the scheduler that raises it in
// tests/aiNoLivePath.test.ts.

const NOW = Date.parse('2026-10-06T12:00:30Z') / 1000

const story = (over: Partial<Pick<ReadStory, 'impact' | 'eventType' | 'assets' | 'stale'>> = {}): Pick<ReadStory, 'impact' | 'eventType' | 'assets' | 'stale'> => ({
  impact: 50,
  eventType: 'PARTNERSHIP',
  assets: [{ ticker: 'SOL', relationship: 'DIRECT' }],
  stale: false,
  ...over
})

describe('a story', () => {
  it('is critical as a hack or a delisting of a coin held, by its subject, and only then', () => {
    expect(storySeverity(story({ eventType: 'HACK', impact: 20 }), new Set(['SOL']))).toBe('critical')
    expect(storySeverity(story({ eventType: 'DELISTING', impact: 20 }), new Set(['SOL']))).toBe('critical')
    expect(storySeverity(story({ eventType: 'HACK', impact: 20 }), new Set(['XRP']))).toBe('info')
    expect(storySeverity(story({ eventType: 'HACK', impact: 20, assets: [{ ticker: 'SOL', relationship: 'INDIRECT' }] }), new Set(['SOL']))).toBe('info')
    expect(storySeverity(story({ eventType: 'LISTING', impact: 20 }), new Set(['SOL']))).toBe('info')
  })

  it('is high from an impact of 70 or a confirmed reaction, watch from 45, and info otherwise or when old', () => {
    expect(storySeverity(story({ impact: 70 }), new Set())).toBe('high')
    expect(storySeverity(story({ impact: 69 }), new Set())).toBe('watch')
    expect(storySeverity(story({ impact: 30 }), new Set(), 'CONFIRMED')).toBe('high')
    expect(storySeverity(story({ impact: 45 }), new Set())).toBe('watch')
    expect(storySeverity(story({ impact: 44 }), new Set())).toBe('info')
    expect(storySeverity(story({ impact: 90, stale: true }), new Set())).toBe('info')
  })

  it("is told with its coins, its kind, where it is held, and that nothing was sold", () => {
    expect(storyNotice({ title: 'SOL bridge hacked', sourceName: 'CoinDesk', eventType: 'HACK', assets: [{ ticker: 'SOL', relationship: 'DIRECT' }], impact: 77 }, 'critical', ['3 SOL in the paper account'])).toEqual({
      title: 'CRITICAL: SOL · Hack or exploit',
      body: 'SOL bridge hacked (CoinDesk; impact 77). You hold it: 3 SOL in the paper account. Nothing was placed or sold.'
    })
    expect(storyNotice({ title: 'Markets wait on the Fed', sourceName: 'Decrypt', eventType: 'MACRO', assets: [], impact: 37 }, 'watch').title).toBe('News: Macro')
  })

  it('raises no notice at info, and sends only the three words the handler takes', () => {
    expect([noticeSeverity('info'), noticeSeverity('watch'), noticeSeverity('high'), noticeSeverity('critical')]).toEqual([null, 'watch', 'high', 'critical'])
    expect([healNoticeSeverity('high'), healNoticeSeverity('info'), healNoticeSeverity(3), healNoticeSeverity(undefined)]).toEqual(['high', null, null, null])
  })
})

describe("Bitcoin's fall", () => {
  /** Bitcoin's closed minutes over the last hour and a bit: at 100, then at `end` for the last one. */
  function hour(end: number, count = 70): Candle[] {
    const last = Math.floor(NOW / 60) * 60 - 60
    return Array.from({ length: count }, (_, k) => {
      const time = last - (count - 1 - k) * 60
      const close = k === count - 1 ? end : 100
      return { time, open: close, high: close, low: close, close, volume: 1 }
    })
  }

  it("reads the last hour of closed minutes, and nothing when the hour is not all there", () => {
    expect(btcHourMovePct(hour(94.5), NOW)).toBeCloseTo(-5.5, 10)
    expect(btcHourMovePct(hour(94.5, 50), NOW)).toBeNull()
    const holed = hour(94.5).filter((_, k) => k !== 30)
    expect(btcHourMovePct(holed, NOW)).toBeNull()
  })

  it('is told once, at the line, and again only after it has come back above the rearming line', () => {
    let telling = false
    const told: boolean[] = []
    for (const move of [-3, BTC_CRASH_PCT, -6, -4, BTC_CRASH_REARM_PCT, -2, -5.2, null]) {
      const step = crashStep(move, telling)
      telling = step.telling
      told.push(step.tell)
    }
    expect(told).toEqual([false, true, false, false, false, false, true, false])
    expect(crashNotice(-5.5).title).toBe('CRITICAL: Bitcoin -5.50% in an hour')
  })
})
