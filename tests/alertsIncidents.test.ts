import { describe, expect, it } from 'vitest'
import {
  SHOCK_ATTACH_SECONDS,
  btcHourMovePct,
  btcMovePct,
  incidentLines,
  incidentSeverity,
  repeatsLoudIncident,
  shockAttachLine,
  shockNotice,
  shockStarts,
  storyNotice,
  storySeverity,
  sumWords
} from '../shared/alerts'
import { INCIDENT_LINES, incidentKeys } from '../shared/incidents'
import type { Candle } from '../shared/ipc'
import type { ReadStory, StoryIncident } from '../shared/newsFeed'
import { i18nFor } from '../shared/i18n/translate'

// shared/alerts.ts since V9 Stage 2 (6 November 2026): a hack told by its incident (shared/incidents.ts), one loud
// notice per victim a day, and the market's shock told before the news.

const NOW = Date.parse('2026-10-29T21:40:00Z') / 1000

const first = (over: Partial<StoryIncident> = {}): StoryIncident => ({ report: 'first', why: null, victim: 'Binance', victimToken: 'BNB', topExchange: true, amountUsd: 5.5e9, ...over })

const story = (incident: StoryIncident | null, over: Partial<ReadStory> = {}): Pick<ReadStory, 'impact' | 'eventType' | 'assets' | 'stale' | 'title' | 'summary' | 'incident'> => ({
  impact: 40,
  eventType: 'HACK',
  assets: incident?.victimToken ? [{ ticker: incident.victimToken, relationship: 'DIRECT' }] : [],
  stale: false,
  title: 'Binance Drained of $5.5 Billion in Suspected Hack',
  summary: '',
  incident,
  ...over
})

describe('a hack told by its incident', () => {
  it("is CRITICAL as the first report of a victim whose token is held, HIGH where the token trades, a top exchange's or $100 million", () => {
    expect(storySeverity(story(first()), new Set(['BNB']))).toBe('critical')
    expect(storySeverity(story(first()), new Set(['BTC']))).toBe('high')
    expect(storySeverity(story(first({ victim: 'Initia', victimToken: 'INIT', topExchange: false, amountUsd: null })), new Set())).toBe('high')
    expect(storySeverity(story(first({ victim: 'Coinbase', victimToken: null, topExchange: true, amountUsd: null })), new Set())).toBe('high')
    expect(storySeverity(story(first({ victim: null, victimToken: null, topExchange: false, amountUsd: INCIDENT_LINES.highUsd })), new Set())).toBe('high')
    expect(storySeverity(story(first({ victim: null, victimToken: null, topExchange: false, amountUsd: INCIDENT_LINES.highUsd - 1 })), new Set())).toBe('watch')
  })

  it('is WATCH as any other first report about crypto, and INFO as one about nothing of crypto', () => {
    expect(storySeverity(story(first({ victim: 'Mercado Bitcoin', victimToken: null, topExchange: false, amountUsd: 40e6 })), new Set(['BTC']))).toBe('watch')
    expect(
      storySeverity(story(first({ victim: null, victimToken: null, topExchange: false, amountUsd: null }), { title: 'Qubic freezes chain after attacker drains 1.4K wallets with weak seeds' }), new Set())
    ).toBe('watch')
    expect(
      storySeverity(story(first({ victim: null, victimToken: null, topExchange: false, amountUsd: null }), { title: 'Hackers Publish Work Details of 41,000 Homeland Security Employees', summary: 'A hacktivist group says it took names.' }), new Set())
    ).toBe('info')
  })

  it('is INFO as a follow-up, as a story that reports no theft, and as old news, held or not', () => {
    expect(storySeverity(story(first({ report: 'follow-up', why: 'told before' })), new Set(['BNB']))).toBe('info')
    expect(storySeverity(story(null, { assets: [{ ticker: 'BNB', relationship: 'DIRECT' }], impact: 90 }), new Set(['BNB']))).toBe('info')
    expect(storySeverity(story(first(), { stale: true }), new Set(['BNB']))).toBe('info')
  })

  it('keeps the rules before it for a story not read for an incident, and for every other kind', () => {
    expect(storySeverity({ impact: 20, eventType: 'HACK', assets: [{ ticker: 'SOL', relationship: 'DIRECT' }], stale: false }, new Set(['SOL']))).toBe('critical')
    expect(storySeverity({ impact: 75, eventType: 'LISTING', assets: [], stale: false, incident: null }, new Set())).toBe('high')
    expect(incidentSeverity({ title: '', summary: '', assets: [] }, new Set())).toBe('info')
  })

  it('names its victim and token in the title, and says who lost what, the token, and that the way is not measured', () => {
    const told = storyNotice({ ...story(first()), sourceName: 'Decrypt' }, 'high')
    expect(told.title).toBe('HIGH: Binance (BNB) · Hack')
    expect(told.body).toBe(
      "Binance Drained of $5.5 Billion in Suspected Hack (Decrypt; impact 40). First report of a theft from Binance. The sum named: $5.5B. The victim's own token: BNB. Which way: unknown. What prices do after a hack is not measured yet. Nothing was placed or sold."
    )
    const unnamed = storyNotice({ ...story(first({ victim: null, victimToken: null, topExchange: false, amountUsd: 106e6 })), title: 'EU entity suspected of losing $106 million', sourceName: 'CoinDesk' }, 'high')
    expect(unnamed.title).toBe('HIGH: Hack')
    expect(unnamed.body).toContain('First report of a theft; who lost the funds is not named. The sum named: $106M.')
    // A follow-up says nothing of an incident, and is titled by its coins as before.
    expect(incidentLines(first({ report: 'follow-up', why: 'laundering' }))).toEqual([])
    expect(storyNotice({ ...story(first({ report: 'follow-up', why: 'laundering' })), sourceName: 'Decrypt' }, 'info').title).toBe('News: BNB · Hack')
  })

  it('says its sum short, in the language', () => {
    expect(sumWords(5.5e9)).toBe('$5.5B')
    expect(sumWords(106e6)).toBe('$106M')
    expect(sumWords(727_000)).toBe('$727K')
    expect(sumWords(223e6)).toBe('$223M')
    expect(sumWords(106e6, i18nFor('ja'))).toMatch(/1\.1億|億/)
  })
})

describe('one loud notice per victim a day', () => {
  const told = [{ keys: incidentKeys(first()), at: NOW - 3600, severity: 'high' as const }]

  it('holds back a second loud report of the same victim or sum within the day, and nothing quieter', () => {
    expect(repeatsLoudIncident(story(first({ amountUsd: 6.3e9 })), 'high', told, NOW)).toBe(true)
    expect(repeatsLoudIncident(story(first({ victim: null, victimToken: null, amountUsd: 5.5e9 })), 'high', told, NOW)).toBe(true)
    expect(repeatsLoudIncident(story(first()), 'watch', told, NOW)).toBe(false)
    expect(repeatsLoudIncident(story(first({ victim: 'Bybit', victimToken: null, amountUsd: 1.5e9 })), 'high', told, NOW)).toBe(false)
    // Another victim named, of the same sum: another theft.
    expect(repeatsLoudIncident(story(first({ victim: 'Bybit', victimToken: null, amountUsd: 5.5e9 })), 'high', told, NOW)).toBe(false)
    expect(repeatsLoudIncident(story(first()), 'high', told, NOW - 3600 + INCIDENT_LINES.loudOnceSeconds)).toBe(false)
  })

  it('still tells a CRITICAL one where only a HIGH one was told: a coin held is not hidden behind it', () => {
    expect(repeatsLoudIncident(story(first()), 'critical', told, NOW)).toBe(false)
    expect(repeatsLoudIncident(story(first()), 'critical', [{ ...told[0], severity: 'critical' }], NOW)).toBe(true)
  })
})

describe('the market before the news', () => {
  it('opens a shock when the state enters one of the three sharp states from none', () => {
    expect(shockStarts('NORMAL', 'LIQUIDATION_SHOCK')).toBe(true)
    expect(shockStarts(null, 'POST_EVENT_SHOCK')).toBe(true)
    expect(shockStarts('RECOVERY', 'TRENDING_SHOCK')).toBe(true)
    expect(shockStarts('POST_EVENT_SHOCK', 'TRENDING_SHOCK')).toBe(false)
    expect(shockStarts('LIQUIDATION_SHOCK', 'RECOVERY')).toBe(false)
    expect(shockStarts('NORMAL', 'PRE_EVENT')).toBe(false)
    expect(shockStarts('NORMAL', null)).toBe(false)
  })

  it('tells the shock with its fifteen minutes in percent where known, and in its usual moves', () => {
    expect(shockNotice({ stateWord: 'in a liquidation cascade', btc15: -3.14, movePct: -1.87 })).toEqual({
      title: 'HIGH: market shock · in a liquidation cascade',
      body: 'Bitcoin moved -1.87% in fifteen minutes, 3.1 times its usual fifteen minutes. No story on file explains it yet; a loud story in the next two hours is told with it. Nothing was placed or sold.'
    })
    expect(shockNotice({ stateWord: 'x', btc15: 2.6, movePct: null }).body).toMatch(/^Bitcoin's last fifteen minutes moved 2\.6 times its usual fifteen minutes\./)
  })

  it('tells a loud story within two hours after the shock how long after it came, and nothing outside them', () => {
    const shock = Date.parse('2026-10-29T19:45:00Z') / 1000
    expect(shockAttachLine({ publishedAt: Date.parse('2026-10-29T21:36:00Z') / 1000 }, shock)).toBe('It came 111 minutes after the market shock told at 19:45 UTC.')
    expect(shockAttachLine({ publishedAt: shock + SHOCK_ATTACH_SECONDS + 60 }, shock)).toBeNull()
    expect(shockAttachLine({ publishedAt: shock - 60 }, shock)).toBeNull()
    expect(shockAttachLine({ publishedAt: shock }, null)).toBeNull()
  })

  it("reads Bitcoin's last fifteen closed minutes, and its hour as before", () => {
    const bars: Candle[] = Array.from({ length: 70 }, (_, index) => ({ time: NOW - 70 * 60 + index * 60, open: 100, high: 100, low: 100, close: 100 + index, volume: 1 }))
    const closed = bars.filter((bar) => bar.time + 60 <= NOW)
    const last = closed[closed.length - 1].close
    expect(btcMovePct(bars, NOW, 15)).toBeCloseTo((last / closed[closed.length - 16].close - 1) * 100, 10)
    expect(btcHourMovePct(bars, NOW)).toBeCloseTo((last / closed[closed.length - 61].close - 1) * 100, 10)
    expect(btcMovePct(bars.slice(-10), NOW, 15)).toBeNull()
  })
})
