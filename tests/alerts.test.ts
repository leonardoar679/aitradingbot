import { describe, expect, it } from 'vitest'
import {
  BTC_CRASH_PCT,
  BTC_CRASH_REARM_PCT,
  NOTICE_REPEAT_SECONDS,
  btcHourMovePct,
  crashNotice,
  crashStep,
  healNoticeSeverity,
  noticeCoins,
  noticeSeverity,
  repeatsNotice,
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

describe('a notice told again', () => {
  const story = (title: string, coins: string[], relationship: 'DIRECT' | 'INDIRECT' = 'DIRECT') => ({ title, assets: coins.map((ticker) => ({ ticker, relationship })) })
  const told = (title: string, coins: string[], secondsAgo: number) => ({ title, coins, at: NOW - secondsAgo })
  // One Zcash ETF filing, told by three outlets in their own words over four hours (6 October 2026).
  const BLOCK = 'Winklevoss group seeks to launch Zcash ETF with 0.25% fee, proposed WINK ticker'
  const DECRYPT = "Another Zcash ETF Is Coming: Winklevoss Twins File for 'WINK'"
  const COINTELEGRAPH = 'Winklevoss-backed Zcash ETF files with SEC for Nasdaq listing'
  // Bitcoin news of 7 October 2026 that is not the news below it.
  const MICA = told('Bitcoin.de trading remains halted as German regulator rejects MiCA application', ['BTC'], 3 * 3600)
  const INFLOWS = told('Bitcoin ETFs rebound with $119M inflow as Ether extends losses', ['BTC', 'ETH'], 3600)

  it('is held back at watch when a story told in the last six hours was the same news about a coin it names', () => {
    expect(repeatsNotice(story(DECRYPT, ['ZEC']), 'watch', [told(BLOCK, ['ZEC'], 2 * 3600)], NOW)).toBe(true)
    // Less alike to the first telling than to the second, and other news beside them: one is enough.
    expect(repeatsNotice(story(COINTELEGRAPH, ['ZEC']), 'watch', [MICA, told(BLOCK, ['ZEC'], 4 * 3600 + 600), told(DECRYPT, ['ZEC'], 2 * 3600 + 600)], NOW)).toBe(true)
    expect(
      repeatsNotice(story("Prosecutors Cite Bitcoin Fog Ruling Against Roman Storm's Venue Challenge", ['BTC']), 'watch', [told('DOJ invokes Bitcoin Fog ruling in potential blow to Roman Storm acquittal bid', ['BTC'], 3 * 3600)], NOW)
    ).toBe(true)
  })

  it('is told when it is other news about the same coin', () => {
    expect(repeatsNotice(story('Live updates: Bitcoin slides under $84,000 as $550 million in bets get liquidated', ['BTC']), 'watch', [MICA, INFLOWS], NOW)).toBe(false)
    expect(repeatsNotice(story('Bitcoin’s recovery stalls just short of rescuing its last underwater cohort', ['BTC']), 'watch', [MICA, INFLOWS], NOW)).toBe(false)
    // The most alike two different pieces of news on the feeds of 7 October 2026: 0.125.
    expect(repeatsNotice(story('Bitcoin Falls Asleep, But Privacy Coins Zcash and Monero Are Waking Up', ['BTC']), 'watch', [told("The VIX of bonds is rising but bitcoin and stocks aren't hearing it yet", ['BTC'], 3600)], NOW)).toBe(false)
  })

  it('is the same news from a title this alike, and not below it', () => {
    const earlier = [told('Zcash fund filed alpha bravo charlie delta echo foxtrot golf', ['ZEC'], 60)]
    // Three words in common of twenty: 0.15.
    expect(repeatsNotice(story('Zcash fund filed hotel india juliet kilo lima mike november oscar papa quebec', ['ZEC']), 'watch', earlier, NOW)).toBe(true)
    // Two of twenty-one.
    expect(repeatsNotice(story('Zcash fund hotel india juliet kilo lima mike november oscar papa quebec romeo', ['ZEC']), 'watch', earlier, NOW)).toBe(false)
  })

  it('is held back only within six hours, and only about a coin in common named as its subject', () => {
    expect(repeatsNotice(story(DECRYPT, ['ZEC']), 'watch', [told(BLOCK, ['ZEC'], NOTICE_REPEAT_SECONDS - 1)], NOW)).toBe(true)
    expect(repeatsNotice(story(DECRYPT, ['ZEC']), 'watch', [told(BLOCK, ['ZEC'], NOTICE_REPEAT_SECONDS)], NOW)).toBe(false)
    expect(repeatsNotice(story(DECRYPT, ['ZEC']), 'watch', [told(BLOCK, ['XMR'], 60)], NOW)).toBe(false)
    expect(repeatsNotice(story(DECRYPT, ['ZEC'], 'INDIRECT'), 'watch', [told(BLOCK, ['ZEC'], 60)], NOW)).toBe(false)
    expect(repeatsNotice(story(DECRYPT, []), 'watch', [told(BLOCK, ['ZEC'], 60)], NOW)).toBe(false)
  })

  it('is told at high and critical, however much it repeats', () => {
    const earlier = [told(BLOCK, ['ZEC'], 60)]
    expect(repeatsNotice(story(BLOCK, ['ZEC']), 'high', earlier, NOW)).toBe(false)
    expect(repeatsNotice(story(BLOCK, ['ZEC']), 'critical', earlier, NOW)).toBe(false)
    expect(repeatsNotice(story(BLOCK, ['ZEC']), 'watch', earlier, NOW)).toBe(true)
  })

  it('is about the coins a story names as its subject', () => {
    expect(noticeCoins({ assets: [{ ticker: 'ZEC', relationship: 'DIRECT' }, { ticker: 'BTC', relationship: 'INDIRECT' }] })).toEqual(['ZEC'])
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
