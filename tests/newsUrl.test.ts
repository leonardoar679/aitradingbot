import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import { NEWS_URL_LINES, URL_RECORD_VERSION, archiveNote, archiveStampSec, closeBefore, foldUrlRecords, reactionOf, readUrlRecord, urlRecordId } from '../shared/newsUrl'

// A PASTED NEWS LINK'S PRICE AND RECORD (shared/newsUrl.ts; V8 Stage 4): the price at a moment is the close of the
// last one-minute bar before it, no more than five minutes stale; the reaction from a day before publication to each
// mark after it, final only once four hours and two minutes have passed and the fourth hour is read; a record's lines
// folded to its last.

const PUBLISHED = 1_793_030_400
const bar = (time: number, close: number): Candle => ({ time, open: close, high: close, low: close, close, volume: 1 })

describe('the price at a moment', () => {
  it('is the close of the last bar that closed before it, if no more than five minutes stale', () => {
    const bars = [bar(PUBLISHED - 600, 9), bar(PUBLISHED - 120, 10), bar(PUBLISHED - 60, 11)]
    expect(closeBefore(bars, PUBLISHED)).toBe(11)
    expect(closeBefore(bars, PUBLISHED - 60)).toBe(10)
    // At a minute before, the last bar had not closed, and the one before it closed nine minutes earlier.
    expect(closeBefore(bars, PUBLISHED - 61)).toBeNull()
    // The last bar before closed six minutes before the moment: not its price.
    expect(closeBefore([bar(PUBLISHED - 420, 10)], PUBLISHED)).toBeNull()
    expect(closeBefore([bar(PUBLISHED - 360, 10)], PUBLISHED)).toBe(10)
    expect(closeBefore([], PUBLISHED)).toBeNull()
    expect(closeBefore([bar(PUBLISHED - 60, 0)], PUBLISHED)).toBeNull()
  })
})

describe('the reaction', () => {
  const series = (toSec: number): Candle[] => {
    const out: Candle[] = []
    for (let t = PUBLISHED - 86_400 - 120; t + 60 <= toSec; t += 60) out.push(bar(t, t + 60 <= PUBLISHED ? (t < PUBLISHED - 86_400 ? 4 : 5) : 6))
    return out
  }
  it('measures from the last close before publication, a day back and to each mark after', () => {
    const now = PUBLISHED + 3600
    const reaction = reactionOf('ABCUSDT', PUBLISHED, series(now), now)
    expect(reaction).toMatchObject({ pair: 'ABCUSDT', refPrice: 5, afterPct: { h4: null }, final: false })
    expect(reaction.beforePct).toBeCloseTo(25, 9)
    for (const value of [reaction.afterPct.m5, reaction.afterPct.m15, reaction.afterPct.h1]) expect(value).toBeCloseTo(20, 9)
  })
  it('is final only once four hours and two minutes have passed and the fourth hour is read', () => {
    const end = PUBLISHED + NEWS_URL_LINES.afterSec
    const early = reactionOf('ABCUSDT', PUBLISHED, series(end + 60), end + 60)
    expect(early.afterPct.h4).toBeCloseTo(20, 9)
    expect(early.final).toBe(false)
    const late = reactionOf('ABCUSDT', PUBLISHED, series(end + NEWS_URL_LINES.finalGraceSec), end + NEWS_URL_LINES.finalGraceSec)
    expect(late.afterPct.h4).toBeCloseTo(20, 9)
    expect(late.final).toBe(true)
    // Bars that stop before the fourth hour: never final, however late.
    expect(reactionOf('ABCUSDT', PUBLISHED, series(end - 3600), end + 3600)).toMatchObject({ afterPct: { h4: null }, final: false })
  })
  it('has no reference where no close came within five minutes before publication', () => {
    expect(reactionOf('ABCUSDT', PUBLISHED, [bar(PUBLISHED - 1200, 5), bar(PUBLISHED + 300, 6)], PUBLISHED + 3600)).toMatchObject({ refPrice: null, beforePct: null, afterPct: { m5: null, h1: null } })
  })
})

describe('the record', () => {
  it('is one a link, its last line its state, newest first', () => {
    const id = urlRecordId('https://a.example/x', () => 'f'.repeat(64))
    expect(id).toBe('f'.repeat(16))
    const record = (over: Record<string, unknown>): Record<string, unknown> => ({ v: URL_RECORD_VERSION, id: 'a', url: 'https://a.example/x', at: 1, trail: [], ...over })
    const folded = foldUrlRecords([record({ title: 'first' }), record({ id: 'b', at: 5 }), record({ title: 'second' }), { v: 'url-record-v0', id: 'c', url: 'u', trail: [] }, null])
    expect(folded.map((entry) => [entry.id, entry.title])).toEqual([
      ['b', undefined],
      ['a', 'second']
    ])
    expect(readUrlRecord(record({ trail: 'none' }))).toBeNull()
  })
})

describe("the Internet Archive's first capture (V8 Stage 5)", () => {
  it('reads its timestamp as a moment in UTC, and nothing else', () => {
    expect(archiveStampSec('20261026221700')).toBe(Date.parse('2026-10-26T22:17:00Z') / 1000)
    expect(archiveStampSec('2026102622170')).toBeNull()
    expect(archiveStampSec('2026-10-26T22:17')).toBeNull()
  })
  it('says the page was there before the time it states only an hour or more before it', () => {
    expect(archiveNote(PUBLISHED - 3601, PUBLISHED)).toMatch(/before the time it states/)
    expect(archiveNote(PUBLISHED - 3600, PUBLISHED)).toBeNull()
    expect(archiveNote(PUBLISHED + 600, PUBLISHED)).toBeNull()
    expect(archiveNote(null, PUBLISHED)).toBeNull()
    expect(archiveNote(PUBLISHED, null)).toBeNull()
  })
})
