import { describe, expect, it } from 'vitest'
import type { TimeCandidate } from '../shared/articleExtract'
import { ARTICLE_TIME_LINES, publicationTimeOf, xPostOf } from '../shared/articleTime'
import { binanceAnnouncementCodeOf, credibilityOf } from '../shared/articleCredibility'

// WHEN A PASTED ARTICLE WAS PUBLISHED, AND WHO SAYS IT (shared/articleTime.ts, shared/articleCredibility.ts; V8 Stage 4).

const READ = 1_793_030_400 // 16:00 UTC
const at = (source: TimeCandidate['source'], sec: number | null, field = source): TimeCandidate => ({ source, field, text: String(sec), sec, dateOnly: false })

describe('the publication time', () => {
  it('reads the page in its order -- structured data, Open Graph, byline, meta -- and keeps every candidate', () => {
    const time = publicationTimeOf({ candidates: [at('meta', READ - 900), at('byline', READ - 600), at('og', READ - 300), at('jsonld', READ - 200)], readAt: READ })
    expect(time).toMatchObject({ sec: READ - 200, source: 'jsonld', disagree: false, check: null })
    expect(time.candidates).toHaveLength(4)
    expect(publicationTimeOf({ candidates: [at('meta', READ - 900), at('byline', READ - 600)], readAt: READ })).toMatchObject({ sec: READ - 600, source: 'byline' })
  })
  it('refuses a time after the page was read, and says when the candidates disagree by more than an hour', () => {
    const time = publicationTimeOf({ candidates: [at('jsonld', READ + ARTICLE_TIME_LINES.futureToleranceSec + 1), at('og', READ - 7200), at('meta', READ - 60)], readAt: READ })
    expect(time).toMatchObject({ sec: READ - 7200, source: 'og', disagree: true })
    expect(time.future.map((candidate) => candidate.source)).toEqual(['jsonld'])
    expect(publicationTimeOf({ candidates: [at('jsonld', null), at('og', READ - 60)], readAt: READ })).toMatchObject({ source: 'og' })
    expect(publicationTimeOf({ candidates: [], readAt: READ })).toMatchObject({ sec: null, source: null })
  })
  it("takes a Binance announcement's release from Binance's own list, and checks the page against it", () => {
    expect(publicationTimeOf({ candidates: [at('og', READ - 100)], readAt: READ, check: { source: 'announcement', sec: READ - 60 } })).toMatchObject({
      sec: READ - 60,
      source: 'announcement',
      check: { source: 'announcement', sec: READ - 60, agrees: true }
    })
    expect(publicationTimeOf({ candidates: [at('og', READ - 9000)], readAt: READ, check: { source: 'announcement', sec: READ - 60 } }).check).toMatchObject({ agrees: false })
  })
  it("uses the feed's time only where the page gives none, and otherwise checks against it", () => {
    expect(publicationTimeOf({ candidates: [], readAt: READ, check: { source: 'feed', sec: READ - 500 } })).toMatchObject({ sec: READ - 500, source: 'feed' })
    expect(publicationTimeOf({ candidates: [at('og', READ - 100)], readAt: READ, check: { source: 'feed', sec: READ - 500 } })).toMatchObject({ sec: READ - 100, source: 'og', check: { agrees: true } })
    expect(publicationTimeOf({ candidates: [at('og', READ - 100)], readAt: READ, check: { source: 'feed', sec: READ - 4000 } }).check).toMatchObject({ agrees: false })
  })
})

describe('a post on X', () => {
  it('is read from its link alone: its handle, its id and the moment in its id', () => {
    const ms = BigInt(Date.parse('2026-10-26T12:00:00.123Z')) - 1_288_834_974_657n
    const id = String(ms << 22n)
    expect(xPostOf(`https://x.com/binance/status/${id}?s=20`)).toEqual({ handle: 'binance', id, sec: Date.parse('2026-10-26T12:00:00Z') / 1000 })
    expect(xPostOf(`https://twitter.com/cz_binance/status/${id}`)).toMatchObject({ handle: 'cz_binance' })
    expect(xPostOf('https://x.com/binance')).toBeNull()
    expect(xPostOf('https://example.com/binance/status/123456789')).toBeNull()
  })
})

describe('who says it', () => {
  it('is the host: an exchange, a regulator, an outlet, a social network, a project of a coin named, or unknown', () => {
    expect(credibilityOf('www.binance.com')).toBe('exchange')
    expect(credibilityOf('www.sec.gov')).toBe('regulator')
    expect(credibilityOf('www.coindesk.com')).toBe('outlet')
    expect(credibilityOf('x.com')).toBe('social')
    expect(credibilityOf('medium.com')).toBe('social')
    expect(credibilityOf('blog.uniswap.org', ['Uniswap', 'UNI'])).toBe('project')
    expect(credibilityOf('uniswap.org')).toBe('unknown')
    expect(credibilityOf('notbinance.com')).toBe('unknown')
    expect(credibilityOf('binance.com.evil.example')).toBe('unknown')
  })
  it("knows a Binance announcement's link only on www.binance.com", () => {
    const code = '0123456789abcdef0123456789abcdef'
    expect(binanceAnnouncementCodeOf(`https://www.binance.com/en/support/announcement/detail/${code}`)).toBe(code)
    expect(binanceAnnouncementCodeOf(`https://www.binance.com/en/support/announcement/binance-will-delist-abc-${code}`)).toBe(code)
    expect(binanceAnnouncementCodeOf(`https://www.binance.com/support/announcement/${code}`)).toBe(code)
    expect(binanceAnnouncementCodeOf(`https://www.binance.com/zh-CN/support/announcement/detail/${code}`)).toBe(code)
    expect(binanceAnnouncementCodeOf(`https://binance.com/en/support/announcement/detail/${code}`)).toBeNull()
    expect(binanceAnnouncementCodeOf(`https://www.binance.com.evil.example/en/support/announcement/detail/${code}`)).toBeNull()
    expect(binanceAnnouncementCodeOf('https://www.binance.com/en/markets')).toBeNull()
  })
})
