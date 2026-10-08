import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AI_ADDITION_SCHEMAS, AI_ADDITION_SYSTEM_PROMPTS, buildAdditionMessages } from '../electron/services/aiAdditionPrompts'
import {
  AI_ADDITION_DAILY_LIMITS,
  AI_ADDITION_PROMPT_VERSIONS,
  DAILY_SUMMARY_MAX_CHARS,
  DAILY_SUMMARY_MAX_ROWS,
  dailySubjectId,
  dailySummariesOf,
  parseDailySummaryRequest,
  validateDailySummary,
  AI_ADDITION_SCHEMA_VERSIONS,
  DEFAULT_AI_ADDITIONS,
  EXIT_LINES,
  EXIT_THESIS_CHARS,
  NEWS_QUESTION_SUMMARY_CHARS,
  additionCallsToday,
  additionProblem,
  additionsModelOf,
  describeNewsReading,
  exitOrderOf,
  exitQuestionOf,
  exitSubjectId,
  exitTradeOf,
  exitTriggers,
  exitTriggersAsked,
  exitVerdictsOf,
  healAiAdditions,
  parseExitCheckRequest,
  validateExitVerdict,
  type ExitCheck,
  type ExitCheckRequest,
  type ExitTrade,
  type ExitTrigger,
  latestWhyOf,
  newsQuestionOf,
  newsReadingsOf,
  parseReviewRequest,
  reviewQuestionOf,
  reviewRefusal,
  reviewTriggers,
  reviewsOf,
  validateNewsReading,
  validateReviewVerdict,
  validateWhyConclusion,
  whyQuestionOf,
  type DailySummaryRequest,
  type ReviewCall,
  type NewsReading
} from '../shared/aiAdditions'
import type { ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import type { MoveExplanation } from '../shared/moveExplanation'
import type { ReadStory } from '../shared/newsFeed'

// shared/aiAdditions.ts: the AI additions -- on unless switched off, each held to a daily limit, the
// automatic ones to the watch being on -- and the news analyst's answer, checked; and their prompts,
// pinned beside their versions.

const T = Date.parse('2026-10-06T12:00:00Z') / 1000
const DAY = 86_400

const READING: NewsReading = { ticker: 'SOL', relationship: 'DIRECT', direction: 'up', impact: 72, horizon: '4h', confidence: 0.7, pricedIn: false, reasons: 'A large listing.' }

describe('the setting', () => {
  it('is on unless switched off, each, and only false switches one off', () => {
    expect(DEFAULT_AI_ADDITIONS).toEqual({ news: true, why: true, exit: true, review: true, daily: true })
    expect(healAiAdditions(undefined)).toEqual({ news: true, why: true, exit: true, review: true, daily: true })
    expect(healAiAdditions({ news: false })).toEqual({ news: false, why: true, exit: true, review: true, daily: true })
    expect(healAiAdditions({ news: 'no', why: false, exit: false, review: false, daily: false })).toEqual({ news: true, why: false, exit: false, review: false, daily: false })
    expect(healAiAdditions([false])).toEqual({ news: true, why: true, exit: true, review: true, daily: true })
    // A setting saved before the exit check existed reads with it on: the user chose all four on.
    expect(healAiAdditions({ news: true, why: false, review: true })).toEqual({ news: true, why: false, exit: true, review: true, daily: true })
    expect(AI_ADDITION_DAILY_LIMITS).toEqual({ news: 40, why: 20, exit: 30, review: 20, daily: 1 })
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
      additionProblem({ kind: 'news', additions: { news: true, why: true, exit: true, review: true, daily: true }, watchOn: true, automatic: true, callsToday: 0, ...over })
    expect(ask()).toBeNull()
    expect(ask({ additions: { news: false, why: true, exit: true, review: true } })).toBe('The news analyst is switched off under Settings › AI.')
    expect(ask({ kind: 'exit', additions: { news: true, why: true, exit: false, review: true } })).toBe('The exit check is switched off under Settings › AI.')
    expect(ask({ kind: 'exit', callsToday: 29 })).toBeNull()
    expect(ask({ kind: 'exit', callsToday: 30 })).toBe('The exit check has made its 30 calls today.')
    expect(ask({ kind: 'exit', watchOn: false })).toBe('The exit check asks by itself only while the watch is on.')
    expect(ask({ kind: 'review', callsToday: 20 })).toBe('The reviewer has made its 20 calls today.')
    expect(ask({ kind: 'why', callsToday: 20 })).toBe('The "why did it move?" conclusion has made its 20 calls today.')
    expect(ask({ kind: 'daily', callsToday: 1 })).toBe('The daily summary has made its one call today.')
    expect(ask({ kind: 'daily', callsToday: 0 })).toBeNull()
    expect(ask({ kind: 'why', callsToday: 19 })).toBeNull()
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

describe('the conclusion to "Why did it move?"', () => {
  const explanation = (over: Partial<MoveExplanation> = {}): MoveExplanation => ({
    symbol: 'SOLUSDT',
    windowMinutes: 60,
    movePct: 2.456,
    volumeRatio: 3.14159,
    btcMovePct: 0.4049,
    marketShare: 0.16,
    label: 'PROBABLE',
    causes: [
      { kind: 'news', text: 'Binance lists SOL futures (CoinDesk, 11:10 UTC)', relevance: 60, storyId: 'coindesk:1', url: 'https://www.coindesk.com/x' },
      { kind: 'volume', text: 'Volume 3.1 times its usual over those minutes.', relevance: 60 }
    ],
    summary: '',
    ...over
  })
  const question = whyQuestionOf(explanation(), 0.5)

  it('is asked the move as measured, rounded, and the evidence the rules found, each by an id', () => {
    expect(question).toEqual({
      pair: 'SOLUSDT',
      windowMinutes: 60,
      movePct: 2.46,
      volumeRatio: 3.14,
      btcMovePct: 0.4,
      label: 'PROBABLE',
      evidence: [
        { id: 'story:coindesk:1', kind: 'news', text: 'Binance lists SOL futures (CoinDesk, 11:10 UTC)' },
        { id: 'volume', kind: 'volume', text: 'Volume 3.1 times its usual over those minutes.' }
      ]
    })
  })

  it('is not asked with nothing to conclude: a move not read, under half a percent, or with no evidence', () => {
    expect(whyQuestionOf(explanation({ movePct: null }), 0.5)).toBeNull()
    expect(whyQuestionOf(explanation({ movePct: -0.49 }), 0.5)).toBeNull()
    expect(whyQuestionOf(explanation({ movePct: -0.5 }), 0.5)).not.toBeNull()
    expect(whyQuestionOf(explanation({ causes: [] }), 0.5)).toBeNull()
  })

  it('is taken only citing the evidence listed, at least one item, in a sensible length', () => {
    const evidence = question?.evidence ?? []
    const check = (value: Record<string, unknown>): string => {
      const verdict = validateWhyConclusion({ conclusion: 'The listing moved it.', cites: ['story:coindesk:1'], confidence: 0.6, ...value }, { evidence })
      return verdict.ok ? 'taken' : verdict.reason
    }
    expect(validateWhyConclusion({ conclusion: '  The listing moved it, on volume.  ', cites: ['story:coindesk:1', 'volume', 'volume'], confidence: 0.6 }, { evidence })).toEqual({
      ok: true,
      conclusion: { conclusion: 'The listing moved it, on volume.', cites: ['story:coindesk:1', 'volume'], confidence: 0.6 }
    })
    expect(check({ cites: ['market'] })).toBe('It cites "market", which is not one of the evidence listed.')
    expect(check({ cites: [] })).toBe('cites does not list 1 to 6 items.')
    expect(check({ cites: 'volume' })).toBe('cites does not list 1 to 6 items.')
    expect(check({ cites: [1] })).toBe('It cites 1, which is not one of the evidence listed.')
    expect(check({ conclusion: '   ' })).toBe('conclusion is not text of 1 to 400 characters.')
    expect(check({ conclusion: 'x'.repeat(401) })).toBe('conclusion is not text of 1 to 400 characters.')
    expect(check({ confidence: -0.1 })).toBe('confidence is not from 0 to 1.')
    expect(validateWhyConclusion(null, { evidence })).toEqual({ ok: false, reason: 'The answer was not an object.' })
  })

  it('reads back the newest conclusion on file for a pair, answered rows only', () => {
    const row = (at: number, over: Record<string, unknown> = {}): Parameters<typeof latestWhyOf>[0][number] => ({
      promptVersion: AI_ADDITION_PROMPT_VERSIONS.why,
      status: 'ok',
      symbol: 'SOLUSDT',
      at,
      model: 'm',
      additionAnswer: { conclusion: `said at ${at}`, cites: ['volume'], confidence: 0.5 },
      ...over
    })
    expect(latestWhyOf([row(T - 60), row(T), row(T + 60, { status: 'rejected' }), row(T + 120, { symbol: 'XRPUSDT' }), row(T + 180, { promptVersion: 'news-analyst-v1' })], 'SOLUSDT')).toEqual({
      at: T,
      model: 'm',
      conclusion: { conclusion: `said at ${T}`, cites: ['volume'], confidence: 0.5 }
    })
    expect(latestWhyOf([], 'SOLUSDT')).toBeNull()
  })
})

describe('the reviewer', () => {
  const EVENT: MarketEvent = {
    id: `binance:SOLUSDT:${T}`,
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    time: T,
    type: 'breakout',
    direction: 'up',
    band: 'urgent',
    score: 91,
    components: { price: 90, volume: 95, volatility: 85, pressure: 90, breakout: 95 },
    price: 100,
    returnsPct: { m1: 0.4, m5: 1.5, m15: 3, h1: 3.2, h4: 2.5 },
    moveSigmas: 6,
    volumeRatio: 4.7,
    rangeRatio: 3,
    live: { detectedAt: T + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 }
  }
  const story = (over: Partial<ReadStory> = {}): ReadStory =>
    ({ id: 's', title: 'Solana bridge hacked', sourceName: 'CoinDesk', eventType: 'HACK', impact: 77, assets: [{ ticker: 'SOL', relationship: 'DIRECT' }], publishedAt: T - 600, stale: false, ...over }) as ReadStory
  const triggers = (over: { event?: Partial<MarketEvent>; side?: 'long' | 'short'; others?: { side: 'long' | 'short' | null }[]; stories?: ReadStory[] } = {}): string[] =>
    reviewTriggers({ event: { ...EVENT, ...over.event }, side: over.side ?? 'long', others: over.others ?? [], stories: over.stories ?? [], nowSec: T + 30 })

  it('takes a second look only when something about the trade stands out', () => {
    expect(triggers()).toEqual([])
    // Another model on the other side; one that would not trade is no disagreement.
    expect(triggers({ others: [{ side: 'short' }] })).toEqual(['models_disagree'])
    expect(triggers({ others: [{ side: null }, { side: 'long' }] })).toEqual([])
    // A move of 5% in fifteen minutes, or of eight of its usual moves, either way.
    expect(triggers({ event: { returnsPct: { ...EVENT.returnsPct, m15: -5 } } })).toEqual(['large_move'])
    expect(triggers({ event: { returnsPct: { ...EVENT.returnsPct, m15: 4.99 } } })).toEqual([])
    expect(triggers({ event: { moveSigmas: -8 } })).toEqual(['large_move'])
    // A story of impact 70 or more on the coin in the three hours before, or an announcement.
    expect(triggers({ stories: [story()] })).toEqual(['major_news'])
    expect(triggers({ stories: [story({ impact: 69 }), story({ stale: true }), story({ publishedAt: T - 3 * 3600 - 1 }), story({ assets: [{ ticker: 'XRP', relationship: 'DIRECT' }] })] })).toEqual([])
    expect(triggers({ event: { news: { articleId: 1, title: 'Binance Will Delist SOL', releaseSec: T } } })).toEqual(['major_news'])
    // Under $5M a day, or quoted wider than 0.05%.
    expect(triggers({ event: { live: { ...(EVENT.live as NonNullable<MarketEvent['live']>), quoteVolume24h: 4_999_999 } } })).toEqual(['thin_pair'])
    expect(triggers({ event: { live: { ...(EVENT.live as NonNullable<MarketEvent['live']>), spreadPct: 0.051 } } })).toEqual(['thin_pair'])
    expect(triggers({ event: { live: null } })).toEqual([])
  })

  const DECISION = { model: 'm', recommendation: 'sell', confidence: 0.8, rationale: 'Fading the spike.', detail: { entry: { min: 99.8, max: 100.2, validMinutes: 15 }, stopLoss: 101.5, takeProfit: 97 } }

  it('reads a request over the bridge as an event and a call, or not at all', () => {
    const parsed = parseReviewRequest({ event: EVENT, decision: DECISION })
    expect(parsed?.call).toEqual({ model: 'm', side: 'short', confidence: 0.8, entryMin: 99.8, entryMax: 100.2, stopLoss: 101.5, takeProfit: 97, rationale: 'Fading the spike.' })
    expect(parsed?.event).toMatchObject({ id: EVENT.id, symbol: 'SOLUSDT', moveSigmas: 6, live: EVENT.live })
    expect(parseReviewRequest(null)).toBeNull()
    expect(parseReviewRequest({ event: EVENT })).toBeNull()
    expect(parseReviewRequest({ event: { ...EVENT, symbol: 'sol/usdt' }, decision: DECISION })).toBeNull()
    expect(parseReviewRequest({ event: { ...EVENT, moveSigmas: 'big' }, decision: DECISION })).toBeNull()
    expect(parseReviewRequest({ event: EVENT, decision: { ...DECISION, recommendation: 'hold' } })).toBeNull()
    expect(parseReviewRequest({ event: EVENT, decision: { ...DECISION, detail: { ...DECISION.detail, entry: null } } })).toBeNull()
    expect(parseReviewRequest({ event: EVENT, decision: { ...DECISION, detail: { ...DECISION.detail, stopLoss: 'x' } } })).toBeNull()
  })

  it('is asked the event, the call, the other calls, the major news and why', () => {
    const call = parseReviewRequest({ event: EVENT, decision: DECISION })?.call as ReviewCall
    const question = reviewQuestionOf({
      event: EVENT,
      call,
      others: [
        { model: 'a', side: 'long', confidence: 0.7, refused: false },
        { model: 'b', side: null, confidence: 0.5, refused: false },
        { model: 'c', side: null, confidence: 0, refused: true }
      ],
      stories: [story(), story({ id: 'quiet', impact: 20 })],
      triggers: ['models_disagree', 'major_news'],
      nowSec: T + 30
    })
    expect(question).toEqual({
      event: { pair: 'SOLUSDT', kind: 'breakout', direction: 'up', score: 91, movePct15m: 3, moveSigmas: 6, volumeRatio: 4.7, quoteVolume24h: 80_000_000, spreadPct: 0.01, announcement: null },
      call,
      others: [
        { model: 'a', call: 'BUY', confidence: 0.7 },
        { model: 'b', call: 'NO TRADE', confidence: 0.5 },
        { model: 'c', call: 'REFUSED', confidence: 0 }
      ],
      news: [{ title: 'Solana bridge hacked', source: 'CoinDesk', kind: 'HACK', impact: 77 }],
      triggers: ['models_disagree', 'major_news']
    })
  })

  it('is taken as APPROVE or REJECT with a reason, and only a REJECT given refuses the trade', () => {
    expect(validateReviewVerdict({ verdict: 'REJECT', confidence: 0.7, reason: ' Chasing a spike. ' })).toEqual({ ok: true, verdict: { verdict: 'REJECT', confidence: 0.7, reason: 'Chasing a spike.' } })
    expect(validateReviewVerdict({ verdict: 'MAYBE', confidence: 0.7, reason: 'x' })).toEqual({ ok: false, reason: 'verdict is not one of APPROVE, REJECT.' })
    expect(validateReviewVerdict({ verdict: 'APPROVE', confidence: 2, reason: 'x' })).toEqual({ ok: false, reason: 'confidence is not from 0 to 1.' })
    expect(validateReviewVerdict({ verdict: 'APPROVE', confidence: 0.5, reason: '' })).toEqual({ ok: false, reason: 'reason is not text of 1 to 300 characters.' })
    const answered = (verdict: 'APPROVE' | 'REJECT') => ({ asked: true, triggers: ['large_move' as const], outcome: { status: 'answered' as const, answer: { verdict, confidence: 0.6, reason: 'Overextended.' }, cached: false, model: 'm' } })
    expect(reviewRefusal(answered('REJECT'))).toBe('The reviewer rejected it (the move is unusually large): Overextended.')
    expect(reviewRefusal(answered('APPROVE'))).toBeNull()
    expect(reviewRefusal({ asked: false, triggers: [], outcome: null })).toBeNull()
    expect(reviewRefusal({ asked: true, triggers: ['large_move'], outcome: { status: 'failed', reason: 'down' } })).toBeNull()
    expect(reviewRefusal(null)).toBeNull()
  })

  it("reads the reviewer's verdicts back from the ledger, by event", () => {
    const rows = [
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.review, status: 'ok' as const, subjectId: 'e1', additionAnswer: { verdict: 'REJECT', confidence: 0.6, reason: 'r' } },
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.review, status: 'rejected' as const, subjectId: 'e2', additionAnswer: { verdict: 'REJECT', confidence: 0.6, reason: 'r' } },
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, status: 'ok' as const, subjectId: 'e3', additionAnswer: { verdict: 'REJECT', confidence: 0.6, reason: 'r' } }
    ]
    expect(reviewsOf(rows)).toEqual({ e1: { verdict: 'REJECT', confidence: 0.6, reason: 'r' } })
  })
})

describe('the exit check', () => {
  const OPENED = T - 3600
  const ENTERED = OPENED + 60 - (OPENED % 60)
  const base: ExecutorConfig = {
    id: 'w1',
    name: 'Watch: BUY SOLUSDT',
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: OPENED,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    watch: { eventId: 'binance:SOLUSDT:1', eventTime: OPENED - 20, model: 'openai/gpt-5-mini', confidence: 0.8 },
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: { side: 'buy', entryPrice: null, amountQuote: 100, takeProfitPct: 4, stopLossPct: 2, timeLimitSec: 7200, trailingStop: null } satisfies PositionExecutorParams
  }
  const executor = (over: Partial<ExecutorConfig> = {}, params: Partial<PositionExecutorParams> = {}): ExecutorConfig => ({
    ...base,
    ...over,
    params: { ...(base.params as PositionExecutorParams), ...params }
  })
  const short: ExecutorConfig = executor(
    { id: 'n1', name: 'Delisting short · ABCUSDT', symbol: 'ABCUSDT', baseAsset: 'ABC', watch: undefined, newsRule: { articleId: 7, ticker: 'ABC', releaseSec: OPENED - 30, title: 'Binance Will Delist ABC', category: 'DELISTING' } },
    { side: 'sell', takeProfitPct: null, stopLossPct: null, timeLimitSec: 14_400 }
  )
  const request = (over: Partial<ExitCheckRequest> = {}): ExitCheckRequest => ({
    executorId: 'w1',
    entryPrice: 100,
    enteredAt: ENTERED,
    priceTime: T - 60,
    price: 100,
    move15mPct: 0.2,
    regimeAtEntry: 'bull',
    regimeNow: 'bull',
    ...over
  })
  const read = (value: ExecutorConfig): ExitTrade => {
    const found = exitTradeOf(value)
    if (!found.ok) throw new Error(found.reason)
    return found.trade
  }
  const story = (over: Partial<ReadStory> = {}): ReadStory =>
    ({ id: 's', sourceName: 'CoinDesk', title: 'Solana bridge hacked', eventType: 'HACK', impact: 80, publishedAt: T - 600, stale: false, assets: [{ ticker: 'SOL', relationship: 'DIRECT' }], ...over }) as ReadStory

  it("looks only at the app's own open paper positions with a time limit it has not closed already", () => {
    expect(read(executor())).toEqual({
      id: 'w1',
      symbol: 'SOLUSDT',
      baseAsset: 'SOL',
      side: 'buy',
      createdAt: OPENED,
      stopLossPct: 2,
      takeProfitPct: 4,
      timeLimitSec: 7200,
      origin: { kind: 'watch', eventId: 'binance:SOLUSDT:1', eventTime: OPENED - 20, model: 'openai/gpt-5-mini' }
    })
    expect(read(short)).toMatchObject({ side: 'sell', stopLossPct: null, takeProfitPct: null, origin: { kind: 'news', category: 'DELISTING', title: 'Binance Will Delist ABC' } })
    const refused = (value: ExecutorConfig): string => {
      const found = exitTradeOf(value)
      return found.ok ? 'taken' : found.reason
    }
    // Whatever it carries, a live executor is never one.
    expect(refused(executor({ mode: 'live' }))).toBe('it is not a paper position.')
    expect(refused(executor({ type: 'order' }))).toBe('it is not a paper position.')
    expect(refused(executor({ watch: undefined }))).toBe('it was not opened by the watch or a news rule.')
    expect(refused(executor({ status: 'stopped' }))).toBe('it has been stopped.')
    const closing = { at: T, closeAt: T + 60, enteredAt: ENTERED, planTimeLimitSec: 7200, model: 'm', triggers: ['near_stop'], confidence: 0.6, reason: 'r' }
    expect(refused(executor({ watch: { ...(base.watch as NonNullable<ExecutorConfig['watch']>), aiExit: closing } }))).toBe('the exit check has closed it already.')
    expect(refused({ ...short, newsRule: { ...(short.newsRule as NonNullable<ExecutorConfig['newsRule']>), aiExit: closing } })).toBe('the exit check has closed it already.')
    expect(refused(executor({}, { timeLimitSec: null }))).toBe('it has no time limit for an EXIT to bring forward.')
  })

  it('reads a request over the bridge only in its shape', () => {
    expect(parseExitCheckRequest(request())).toEqual(request())
    expect(parseExitCheckRequest(request({ move15mPct: null, regimeAtEntry: null, regimeNow: 'panic' }))).toEqual(request({ move15mPct: null, regimeAtEntry: null, regimeNow: 'panic' }))
    for (const bad of [
      null,
      'w1',
      [],
      request({ executorId: 'w1:near_stop' }),
      request({ executorId: '' }),
      request({ entryPrice: 0 }),
      request({ price: -1 }),
      request({ price: Number.NaN }),
      request({ enteredAt: ENTERED + 30 }),
      request({ priceTime: T - 59 }),
      request({ enteredAt: T, priceTime: T - 60 }),
      request({ move15mPct: undefined as unknown as number }),
      request({ regimeNow: 'calm' as never })
    ]) {
      expect(parseExitCheckRequest(bad), JSON.stringify(bad)).toBeNull()
    }
  })

  it('is asked near the target or the stop, three quarters of the way there, either side', () => {
    const triggers = (trade: ExitTrade, price: number): ExitTrigger[] => exitTriggers({ trade, request: request({ price, move15mPct: null }), stories: [], nowSec: T })
    const long = read(executor())
    expect(triggers(long, 103)).toEqual(['near_target'])
    expect(triggers(long, 102.9)).toEqual([])
    expect(triggers(long, 98.4)).toEqual(['near_stop'])
    expect(triggers(long, 98.6)).toEqual([])
    const sold = read(executor({}, { side: 'sell' }))
    expect(triggers(sold, 96.9)).toEqual(['near_target'])
    expect(triggers(sold, 97.1)).toEqual([])
    expect(triggers(sold, 101.6)).toEqual(['near_stop'])
    expect(triggers(sold, 101.4)).toEqual([])
    // With no target and no stop, neither is near.
    expect(triggers(read(short), 50)).toEqual([])
    expect(EXIT_LINES.nearShare).toBe(0.75)
  })

  it('is asked on a story of high impact naming the coin since the trade was opened', () => {
    const news = (stories: ReadStory[]): ExitTrigger[] => exitTriggers({ trade: read(executor()), request: request(), stories, nowSec: T })
    expect(news([story()])).toEqual(['news'])
    expect(news([story({ impact: 70 })])).toEqual(['news'])
    expect(news([story({ impact: 69 })])).toEqual([])
    expect(news([story({ publishedAt: OPENED })])).toEqual([])
    expect(news([story({ publishedAt: T + 60 })])).toEqual([])
    expect(news([story({ stale: true })])).toEqual([])
    expect(news([story({ assets: [{ ticker: 'SOLV', relationship: 'DIRECT' }] })])).toEqual([])
    expect(news([story({ assets: [{ ticker: 'SOL', relationship: 'INDIRECT' }] })])).toEqual(['news'])
  })

  it("is asked when the market's regime has changed since the entry, and on a sharp move against the trade", () => {
    const trade = read(executor())
    const asked = (over: Partial<ExitCheckRequest>, side: ExitTrade = trade): ExitTrigger[] => exitTriggers({ trade: side, request: request(over), stories: [], nowSec: T })
    expect(asked({ regimeAtEntry: 'bull', regimeNow: 'sideways' })).toEqual(['regime_change'])
    expect(asked({ regimeAtEntry: null, regimeNow: 'panic' })).toEqual([])
    expect(asked({ regimeAtEntry: 'bear', regimeNow: null })).toEqual([])
    expect(asked({ move15mPct: -2 })).toEqual(['opposite_move'])
    expect(asked({ move15mPct: -1.9 })).toEqual([])
    expect(asked({ move15mPct: 3 })).toEqual([])
    const sold = read(executor({}, { side: 'sell' }))
    expect(asked({ move15mPct: 2 }, sold)).toEqual(['opposite_move'])
    expect(asked({ move15mPct: -3 }, sold)).toEqual([])
    // All that apply, in a fixed order.
    expect(exitTriggers({ trade, request: request({ price: 98.4, move15mPct: -2.5, regimeNow: 'bear' }), stories: [story()], nowSec: T })).toEqual(['near_stop', 'news', 'regime_change', 'opposite_move'])
  })

  it('is asked once a trade and a reason, whatever came of it, read from what the ledger holds', () => {
    expect(exitSubjectId('w1', ['near_stop', 'news'])).toBe('w1:near_stop+news')
    const rows = [
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.exit, subjectId: 'w1:near_stop+news' },
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.exit, subjectId: 'w1:regime_change' },
      // Another trade whose id begins with this one's.
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.exit, subjectId: 'w10:near_target+opposite_move' },
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.exit, subjectId: 'w1:nonsense' },
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.review, subjectId: 'w1:opposite_move' },
      { promptVersion: AI_ADDITION_PROMPT_VERSIONS.exit }
    ]
    expect([...exitTriggersAsked(rows, 'w1')].sort()).toEqual(['near_stop', 'news', 'regime_change'])
    expect([...exitTriggersAsked(rows, 'w10')]).toEqual(['near_target', 'opposite_move'])
  })

  it('is asked the trade, where it stands, the news since it was opened, and why', () => {
    const question = exitQuestionOf({
      trade: read(executor()),
      request: request({ price: 98.4, move15mPct: -1.23456789, regimeNow: 'sideways' }),
      thesis: 't'.repeat(400),
      stories: [story(), story({ id: 'old', publishedAt: OPENED - 60 }), ...Array.from({ length: 6 }, (_, k) => story({ id: `more${k}`, title: `More ${k}` }))],
      triggers: ['near_stop', 'news'],
      nowSec: T
    })
    expect(question).toEqual({
      trade: {
        pair: 'SOLUSDT',
        side: 'long',
        openedBy: "the watch, following openai/gpt-5-mini's call on a market event",
        thesis: 't'.repeat(EXIT_THESIS_CHARS),
        entryPrice: 100,
        minutesOpen: Math.round((T - ENTERED) / 60),
        stopPct: 2,
        targetPct: 4,
        minutesLeft: Math.round((ENTERED + 7200 - T) / 60)
      },
      now: { price: 98.4, gainPct: -1.6, move15mPct: -1.23457, regimeAtEntry: 'bull', regimeNow: 'sideways' },
      news: [
        { title: 'Solana bridge hacked', source: 'CoinDesk', kind: 'HACK', impact: 80, minutesAgo: 10 },
        ...Array.from({ length: 4 }, (_, k) => ({ title: `More ${k}`, source: 'CoinDesk', kind: 'HACK', impact: 80, minutesAgo: 10 }))
      ],
      triggers: ['near_stop', 'news']
    })
    const shorted = exitQuestionOf({ trade: read(short), request: request({ executorId: 'n1', price: 90 }), thesis: 'Delisted.', stories: [], triggers: ['news'], nowSec: T })
    expect(shorted.trade).toMatchObject({ side: 'short', openedBy: "the delisting rule, on Binance's announcement", stopPct: null, targetPct: null })
    expect(shorted.now.gainPct).toBe(10)
    // A trade past its time does not have minutes left below none.
    expect(exitQuestionOf({ trade: read(executor({}, { timeLimitSec: 60 })), request: request(), thesis: '', stories: [], triggers: [], nowSec: T }).trade.minutesLeft).toBe(0)
  })

  it('is taken as KEEP, REDUCE or EXIT with a reason, and only an EXIT given is acted on', () => {
    expect(validateExitVerdict({ verdict: 'EXIT', confidence: 0.7, reason: ' Hacked. ' })).toEqual({ ok: true, verdict: { verdict: 'EXIT', confidence: 0.7, reason: 'Hacked.' } })
    expect(validateExitVerdict({ verdict: 'REDUCE', confidence: 0, reason: 'x' }).ok).toBe(true)
    expect(validateExitVerdict({ verdict: 'SELL', confidence: 0.7, reason: 'x' })).toEqual({ ok: false, reason: 'verdict is not one of KEEP, REDUCE, EXIT.' })
    expect(validateExitVerdict({ verdict: 'KEEP', confidence: -0.1, reason: 'x' })).toEqual({ ok: false, reason: 'confidence is not from 0 to 1.' })
    expect(validateExitVerdict({ verdict: 'KEEP', confidence: 0.5, reason: ' ' })).toEqual({ ok: false, reason: 'reason is not text of 1 to 300 characters.' })
    expect(validateExitVerdict({ verdict: 'KEEP', confidence: 0.5, reason: 'x'.repeat(301) })).toEqual({ ok: false, reason: 'reason is not text of 1 to 300 characters.' })
    expect(validateExitVerdict(['EXIT'])).toEqual({ ok: false, reason: 'The answer was not an object.' })
    const answered = (verdict: 'KEEP' | 'REDUCE' | 'EXIT'): ExitCheck => ({ asked: true, triggers: ['near_stop'], outcome: { status: 'answered', answer: { verdict, confidence: 0.6, reason: 'Broke its level.' }, cached: false, model: 'm' } })
    expect(exitOrderOf(answered('EXIT'))).toEqual({ model: 'm', triggers: ['near_stop'], confidence: 0.6, reason: 'Broke its level.' })
    expect(exitOrderOf(answered('KEEP'))).toBeNull()
    expect(exitOrderOf(answered('REDUCE'))).toBeNull()
    expect(exitOrderOf({ asked: true, triggers: ['near_stop'], outcome: { status: 'refused', reason: 'r', cached: false, model: 'm' } })).toBeNull()
    expect(exitOrderOf({ asked: true, triggers: ['near_stop'], outcome: { status: 'failed', reason: 'down' } })).toBeNull()
    expect(exitOrderOf({ asked: true, triggers: ['near_stop'], outcome: { status: 'skipped', reason: 'limit' } })).toBeNull()
    expect(exitOrderOf({ asked: false, triggers: [], outcome: null })).toBeNull()
    expect(exitOrderOf(null)).toBeNull()
  })

  it("reads the check's answers back from the ledger, with the trade each was about", () => {
    const answer = { verdict: 'REDUCE', confidence: 0.5, reason: 'r' }
    const rows = [
      { at: T, promptVersion: AI_ADDITION_PROMPT_VERSIONS.exit, status: 'ok' as const, subjectId: 'w1:near_stop+news', additionAnswer: answer },
      { at: T, promptVersion: AI_ADDITION_PROMPT_VERSIONS.exit, status: 'rejected' as const, subjectId: 'w2:news', additionAnswer: answer },
      { at: T, promptVersion: AI_ADDITION_PROMPT_VERSIONS.exit, status: 'ok' as const, subjectId: 'w3:news', additionAnswer: { ...answer, verdict: 'HOLD' } },
      { at: T, promptVersion: AI_ADDITION_PROMPT_VERSIONS.review, status: 'ok' as const, subjectId: 'w4:news', additionAnswer: answer }
    ]
    expect(exitVerdictsOf(rows)).toEqual([{ executorId: 'w1', at: T, verdict: answer }])
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

  it("pins the conclusion's prompt and schema", () => {
    expect([AI_ADDITION_PROMPT_VERSIONS.why, sha(AI_ADDITION_SYSTEM_PROMPTS.why)]).toEqual(['why-conclusion-v1', '59f48f9f330a3be495e77589229d471a3b1ea028c2c4f609a6928c48d2eccaed'])
    expect([AI_ADDITION_SCHEMA_VERSIONS.why, sha(JSON.stringify(AI_ADDITION_SCHEMAS.why))]).toEqual(['why-conclusion-v1', '6e757e1aed2f7e2028861b6e123096b3c848b5c4182b38a283bed0a342bed54b'])
  })

  it("pins the exit check's prompt and schema", () => {
    expect([AI_ADDITION_PROMPT_VERSIONS.exit, sha(AI_ADDITION_SYSTEM_PROMPTS.exit)]).toEqual(['exit-check-v1', '6daec4807f8503492beea3a8f0d1824a9e6bb98bf1cf6ba868e4f1a352b1b6ed'])
    expect([AI_ADDITION_SCHEMA_VERSIONS.exit, sha(JSON.stringify(AI_ADDITION_SCHEMAS.exit))]).toEqual(['exit-verdict-v1', '3a3e4041fb04e7049b040d66138c49a29ef3ff84e1280a9d75d7120b8b56b57d'])
  })

  it("pins the reviewer's prompt and schema", () => {
    expect([AI_ADDITION_PROMPT_VERSIONS.review, sha(AI_ADDITION_SYSTEM_PROMPTS.review)]).toEqual(['reviewer-v1', '7eb73834d0258e57f927de802d2a85dd28704dc7645e4ae4e3726f7e328efd47'])
    expect([AI_ADDITION_SCHEMA_VERSIONS.review, sha(JSON.stringify(AI_ADDITION_SCHEMAS.review))]).toEqual(['review-verdict-v1', '528ba216008a938b4b7bfae4942e6c0ce786e57f841b0fd34b6942418dca0e10'])
  })
})

describe('the daily summary', () => {
  const question: DailySummaryRequest['question'] = {
    day: '2026-10-07',
    market: { regime: 'bull', btcDayPct: 2.1, ethDayPct: -0.4, breadthPct: 61, pairsRead: 60, moversUp: [{ pair: 'SOLUSDT', dayPct: 8 }], moversDown: [{ pair: 'XRPUSDT', dayPct: -6 }] },
    news: [{ title: 'Binance lists SOL futures', source: 'CoinDesk', impact: 80, tickers: ['SOL'], hourAfterPct: 1.2 }],
    newsKept: true,
    trades: { opened: 3, ended: 2, openNow: 1, net: [{ asset: 'USDT', amount: 1.4 }], r: 0.6, rTrades: 2, bestPct: 2.1, worstPct: -1.2, refused: [{ reason: 'The paper account has no funds for it', count: 2 }] },
    calls: { made: 12, answered: 12, valid: 11, costUsd: 0.09 },
    answers: { buy: 4, sell: 1, hold: 5, noTrade: 2 },
    models: [{ model: 'openai/gpt-5-mini', closed: 40, netPctATrade: 0.2, profitFactor: 1.3 }],
    risk: { pausedWatch: false, pausedNews: false, aiSpentUsd: 0.31, aiCapUsd: 5, healthPauses: 0, highAlerts: 3 }
  }

  it('is a paragraph of a sensible length with a confidence in range, or it is refused', () => {
    expect(DAILY_SUMMARY_MAX_CHARS).toBe(900)
    expect(validateDailySummary({ summary: '  Bitcoin rose two percent on the day.  ', confidence: 0.5 })).toEqual({ ok: true, summary: { summary: 'Bitcoin rose two percent on the day.', confidence: 0.5 } })
    expect(validateDailySummary({ summary: 'Too short.', confidence: 0.5 })).toEqual({ ok: false, reason: 'summary is missing or too short' })
    expect(validateDailySummary({ summary: 'x'.repeat(901), confidence: 0.5 })).toEqual({ ok: false, reason: 'summary is longer than 900 characters' })
    expect(validateDailySummary({ summary: 'A paragraph of a sensible length.', confidence: 1.5 })).toEqual({ ok: false, reason: 'confidence is missing or out of range' })
    expect(validateDailySummary(null).ok).toBe(false)
  })

  it('reads a request over the bridge only in its shape, rebuilt so that nothing else passes', () => {
    const parsed = parseDailySummaryRequest({ day: '2026-10-07', question: { ...question, extra: 'dropped' }, more: 1 })
    expect(parsed).toEqual({ day: '2026-10-07', question })
    expect(parseDailySummaryRequest({ day: 'yesterday', question })).toBeNull()
    expect(parseDailySummaryRequest({ day: '2026-13-40', question })).toBeNull()
    expect(parseDailySummaryRequest({ day: '2026-10-06', question })).toBeNull()
    expect(parseDailySummaryRequest({ day: '2026-10-07', question: { ...question, market: { ...question.market, btcDayPct: 'up' } } })).toBeNull()
    expect(parseDailySummaryRequest({ day: '2026-10-07', question: { ...question, news: Array.from({ length: DAILY_SUMMARY_MAX_ROWS.news + 1 }, () => question.news[0]) } })).toBeNull()
    expect(parseDailySummaryRequest({ day: '2026-10-07', question: { ...question, news: [{ ...question.news[0], title: 'x'.repeat(201) }] } })).toBeNull()
    expect(parseDailySummaryRequest({ day: '2026-10-07', question: { ...question, models: [{ ...question.models[0], closed: null }] } })).toBeNull()
    expect(parseDailySummaryRequest({ day: '2026-10-07', question: { ...question, risk: { ...question.risk, pausedWatch: 'no' } } })).toBeNull()
    expect(parseDailySummaryRequest({ day: '2026-10-07', question: { ...question, newsKept: 'yes' } })).toBeNull()
    expect(parseDailySummaryRequest({ day: '2026-10-07', question: { ...question, market: { ...question.market, regime: null, btcDayPct: null } } })).not.toBeNull()
    expect(parseDailySummaryRequest(null)).toBeNull()
  })

  it('is filed under its day, and read back from the ledger by the day, the newest answered row for each', () => {
    expect(dailySubjectId('2026-10-07')).toBe('day:2026-10-07')
    const row = (at: number, subjectId: string, over: Record<string, unknown> = {}): Parameters<typeof dailySummariesOf>[0][number] =>
      ({ promptVersion: 'daily-summary-v1', status: 'ok', subjectId, at, model: 'm', additionAnswer: { summary: 'A paragraph about the day of a sensible length.', confidence: 0.4 }, ...over }) as Parameters<typeof dailySummariesOf>[0][number]
    const on = dailySummariesOf([
      row(10, 'day:2026-10-07'),
      row(20, 'day:2026-10-07', { additionAnswer: { summary: 'The newer paragraph about the day, long enough.', confidence: 0.6 } }),
      row(30, 'day:2026-10-06', { status: 'rejected' }),
      row(40, 'day:2026-10-05', { promptVersion: 'exit-check-v1' }),
      row(50, 'e-1'),
      row(60, 'day:2026-10-04', { additionAnswer: { summary: 'short', confidence: 0.4 } })
    ])
    expect(Object.keys(on)).toEqual(['2026-10-07'])
    expect(on['2026-10-07']).toEqual({ day: '2026-10-07', summary: { summary: 'The newer paragraph about the day, long enough.', confidence: 0.6 }, at: 20, model: 'm' })
  })
})

describe('the daily summary, pinned', () => {
  const sha = (text: string): string => createHash('sha256').update(text).digest('hex')
  it("pins the daily summary's prompt and schema", () => {
    expect([AI_ADDITION_PROMPT_VERSIONS.daily, sha(AI_ADDITION_SYSTEM_PROMPTS.daily)]).toEqual(['daily-summary-v1', 'd8764b69089d6cbc838e4b3a64703572e69215fedafb26ef7b170d1e44ee8fcc'])
    expect([AI_ADDITION_SCHEMA_VERSIONS.daily, sha(JSON.stringify(AI_ADDITION_SCHEMAS.daily))]).toEqual(['daily-summary-v1', 'd55f4a9a99f22f57b7d00e9c02816ba5b2c4e00824097f8da7359ec5438c67d8'])
    expect(AI_ADDITION_SCHEMAS.daily.name).toBe('daily_summary')
  })
})
