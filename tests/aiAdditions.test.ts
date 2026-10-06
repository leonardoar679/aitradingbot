import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AI_ADDITION_SCHEMAS, AI_ADDITION_SYSTEM_PROMPTS, buildAdditionMessages } from '../electron/services/aiAdditionPrompts'
import {
  AI_ADDITION_DAILY_LIMITS,
  AI_ADDITION_PROMPT_VERSIONS,
  AI_ADDITION_SCHEMA_VERSIONS,
  DEFAULT_AI_ADDITIONS,
  NEWS_QUESTION_SUMMARY_CHARS,
  additionCallsToday,
  additionProblem,
  additionsModelOf,
  describeNewsReading,
  healAiAdditions,
  newsQuestionOf,
  newsReadingsOf,
  validateNewsReading,
  type NewsReading
} from '../shared/aiAdditions'
import type { ReadStory } from '../shared/newsFeed'

// shared/aiAdditions.ts: the AI additions -- on unless switched off, each held to a daily limit, the
// automatic ones to the watch being on -- and the news analyst's answer, checked; and their prompts,
// pinned beside their versions.

const T = Date.parse('2026-10-06T12:00:00Z') / 1000
const DAY = 86_400

const READING: NewsReading = { ticker: 'SOL', relationship: 'DIRECT', direction: 'up', impact: 72, horizon: '4h', confidence: 0.7, pricedIn: false, reasons: 'A large listing.' }

describe('the setting', () => {
  it('is on unless switched off, each, and only false switches one off', () => {
    expect(DEFAULT_AI_ADDITIONS).toEqual({ news: true })
    expect(healAiAdditions(undefined)).toEqual({ news: true })
    expect(healAiAdditions({ news: false })).toEqual({ news: false })
    expect(healAiAdditions({ news: 'no' })).toEqual({ news: true })
    expect(healAiAdditions([false])).toEqual({ news: true })
  })

  it("asks the watch's own model: the one its paper trades follow, else the first it asks, else the default", () => {
    const base = { defaultModel: 'd', watch: { models: ['w1', 'w2'] }, watchPaper: { model: 'w2' } } as Parameters<typeof additionsModelOf>[0]
    expect(additionsModelOf(base)).toBe('w2')
    expect(additionsModelOf({ ...base, watchPaper: { ...base.watchPaper, model: null } })).toBe('w1')
    expect(additionsModelOf({ ...base, watch: { ...base.watch, models: [] }, watchPaper: { ...base.watchPaper, model: null } })).toBe('d')
  })

  it('counts every call an addition made today, answered or not, and nothing of yesterday or of other prompts', () => {
    const midnight = Math.floor(T / DAY) * DAY
    const rows = [
      { at: midnight, promptVersion: AI_ADDITION_PROMPT_VERSIONS.news },
      { at: T, promptVersion: AI_ADDITION_PROMPT_VERSIONS.news },
      { at: midnight - 1, promptVersion: AI_ADDITION_PROMPT_VERSIONS.news },
      { at: T, promptVersion: 'opportunity-v1' }
    ]
    expect(additionCallsToday(rows, 'news', T)).toBe(2)
  })

  it('refuses a call when switched off, when it would ask by itself with the watch off, or at its daily limit', () => {
    const ask = (over: Partial<Parameters<typeof additionProblem>[0]> = {}): string | null =>
      additionProblem({ kind: 'news', additions: { news: true }, watchOn: true, automatic: true, callsToday: 0, ...over })
    expect(ask()).toBeNull()
    expect(ask({ additions: { news: false } })).toBe('The news analyst is switched off under Settings › AI.')
    expect(ask({ watchOn: false })).toBe('The news analyst asks by itself only while the watch is on.')
    // Asked for by a person, the watch does not matter.
    expect(ask({ watchOn: false, automatic: false })).toBeNull()
    expect(AI_ADDITION_DAILY_LIMITS.news).toBe(40)
    expect(ask({ callsToday: 39 })).toBeNull()
    expect(ask({ callsToday: 40 })).toBe('The news analyst has made its 40 calls today.')
  })
})

describe("the news analyst's answer", () => {
  it('is taken whole when every field is in its shape and range', () => {
    expect(validateNewsReading(READING)).toEqual({ ok: true, reading: READING })
    expect(validateNewsReading({ ...READING, ticker: null, relationship: 'NONE', direction: 'none' }).ok).toBe(true)
  })

  it('is refused for any field out of its shape or range', () => {
    const refused = (over: Record<string, unknown>): string => {
      const verdict = validateNewsReading({ ...READING, ...over })
      return verdict.ok ? 'taken' : verdict.reason
    }
    expect(validateNewsReading('text')).toEqual({ ok: false, reason: 'The answer was not an object.' })
    expect(refused({ ticker: 'sol' })).toMatch(/^ticker is not a coin/)
    expect(refused({ ticker: 'A' })).toMatch(/^ticker is not a coin/)
    expect(refused({ relationship: 'MAIN' })).toMatch(/^relationship is not one of/)
    expect(refused({ ticker: null })).toBe('A coin is named with a relationship to it, and none with NONE.')
    expect(refused({ relationship: 'NONE' })).toBe('A coin is named with a relationship to it, and none with NONE.')
    expect(refused({ direction: 'sideways' })).toMatch(/^direction is not one of/)
    expect(refused({ impact: 72.5 })).toBe('impact is not a whole number from 0 to 100.')
    expect(refused({ impact: 101 })).toBe('impact is not a whole number from 0 to 100.')
    expect(refused({ impact: -1 })).toBe('impact is not a whole number from 0 to 100.')
    expect(refused({ horizon: '1w' })).toMatch(/^horizon is not one of/)
    expect(refused({ confidence: 1.2 })).toBe('confidence is not from 0 to 1.')
    expect(refused({ confidence: Number.NaN })).toBe('confidence is not from 0 to 1.')
    expect(refused({ pricedIn: 'no' })).toBe('pricedIn is not true or false.')
    expect(refused({ reasons: 'x'.repeat(301) })).toBe('reasons is not text of at most 300 characters.')
  })

  it('is read back from the ledger, answered rows of its own prompt only, each checked again', () => {
    const rows = [
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, status: 'ok' as const, subjectId: 'a', additionAnswer: READING },
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, status: 'rejected' as const, subjectId: 'b', additionAnswer: READING },
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, status: 'ok' as const, subjectId: 'c', additionAnswer: { ...READING, impact: 900 } },
      { promptVersion: 'opportunity-v1', status: 'ok' as const, subjectId: 'd', additionAnswer: READING },
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, status: 'ok' as const, additionAnswer: READING }
    ]
    expect(newsReadingsOf(rows)).toEqual({ a: READING })
  })

  it('says itself in a line', () => {
    expect(describeNewsReading(READING)).toBe('SOL (the subject), up, impact 72 over 4h, 70%')
    expect(describeNewsReading({ ...READING, ticker: null, relationship: 'NONE', direction: 'none', pricedIn: true })).toBe('no coin, no direction, impact 72 over 4h, 70%, already priced in')
  })

  it('is asked the story as it was read, its summary cut, and what the rules made of it', () => {
    const story = { id: 'coindesk:1', sourceName: 'CoinDesk', title: 'Solana listed', summary: 's'.repeat(900), publishedAt: T, eventType: 'LISTING', assets: [{ ticker: 'SOL', relationship: 'DIRECT' }] } as unknown as ReadStory
    const question = newsQuestionOf(story)
    expect(question.story.summary).toHaveLength(NEWS_QUESTION_SUMMARY_CHARS)
    expect(question).toMatchObject({ story: { id: 'coindesk:1', source: 'CoinDesk', title: 'Solana listed', publishedAt: T, kind: 'LISTING', coins: [{ ticker: 'SOL', relationship: 'DIRECT' }] } })
    expect(buildAdditionMessages('news', question)).toEqual([
      { role: 'system', content: AI_ADDITION_SYSTEM_PROMPTS.news },
      { role: 'user', content: JSON.stringify(question) }
    ])
  })
})

describe('a prompt and its version move together', () => {
  // As tests/aiPromptVersions.test.ts holds every other prompt: edit a text and bump its version, or
  // this fails.
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
  it("pins the news analyst's prompt and schema", () => {
    expect([AI_ADDITION_PROMPT_VERSIONS.news, sha(AI_ADDITION_SYSTEM_PROMPTS.news)]).toEqual(['news-analyst-v1', '430f9a33959df3c5a2e2c27477208b40d5a2efefaa64919a354a4a99014d5fff'])
    expect([AI_ADDITION_SCHEMA_VERSIONS.news, sha(JSON.stringify(AI_ADDITION_SCHEMAS.news))]).toEqual(['news-reading-v1', '0da05131a9b31f550188361608f4befe585526bc79032e870c1baddc94072f68'])
  })
})
