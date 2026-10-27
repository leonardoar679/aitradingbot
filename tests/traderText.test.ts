import { describe, expect, it } from 'vitest'
import { ENGLISH, i18nFor } from '../shared/i18n/translate'
import { durationOf, utcWhen } from '../src/traders/traderText'

// COPY TRADERS' SHARED WORDING (src/traders/traderText.ts; V8 Stage 8): a span of time from minutes, and a moment on
// the records' UTC clock, in the language's own numbers.

describe('a span of time', () => {
  it('is seconds under a minute, minutes under an hour and a half, hours under two days, then days', () => {
    expect(durationOf(ENGLISH, 0.5)).toBe('30 s')
    expect(durationOf(ENGLISH, 15)).toBe('15 min')
    expect(durationOf(ENGLISH, 89)).toBe('89 min')
    expect(durationOf(ENGLISH, 90)).toBe('1.5 h')
    expect(durationOf(ENGLISH, 1188)).toBe('19.8 h')
    expect(durationOf(ENGLISH, 2880)).toBe('2.0 days')
  })
})

describe('a moment', () => {
  it("is written on the records' UTC clock, in 24 hours, whatever the language", () => {
    const at = Date.UTC(2026, 9, 27, 18, 29)
    expect(utcWhen(ENGLISH, at)).toBe('27 Oct 18:29 UTC')
    expect(utcWhen(i18nFor('hi'), at)).toContain('18:29')
    expect(utcWhen(i18nFor('hi'), at)).not.toMatch(/am|pm/i)
  })
})
