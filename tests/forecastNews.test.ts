import { describe, expect, it } from 'vitest'
import { AI_ADDITION_PROMPT_VERSIONS, newsReadingsAt } from '../shared/aiAdditions'
import { HORIZON_BARS } from '../shared/forecast/features'
import { FORECAST_MODELS, type ForecastModelId } from '../shared/forecast/models'
import { NEWS_EFFECT_LINES, medianPathAt, newsEffectOf, newsSkillOf, storyEffect, type AnalystReadingInput, type KindReactions, type NewsStoryInput } from '../shared/forecast/newsEffect'
import { errorsOf } from '../shared/forecast/outcome'
import { makePrediction, type PredictionInput } from '../shared/forecast/prediction'
import { buildRunCalibration } from '../shared/forecast/runCalibration'
import { promoted, recordOf, scaled } from './forecastRecords'

// THE NEWS IN THE FORECAST (shared/forecast/newsEffect.ts and its place in prediction.ts and
// outcome.ts; the V6 document, §18-24, §43, §49, §54-55 and §58): what a story still has to do, from
// its kind's median path; scaled by impact, novelty and whether it was priced in; widened by its
// kind's spread or, without a library, by a share; the analyst's reading in place of the rules'; and
// only what was seen and answered by the forecast's moment.

const T = Date.parse('2026-10-13T15:00:00Z') / 1000
const LISTING: KindReactions = {
  eventType: 'LISTING',
  enough: true,
  medianPct: { m1: 0.2, m5: 1.1, m15: 2.2, h1: 3.4, h4: 3.0 },
  excursions: { best1hPct: 5, worst1hPct: -1, best4hPct: 7, worst4hPct: -3 }
}
const THIN: KindReactions = { eventType: 'AIRDROP', enough: false, medianPct: null, excursions: null }

const story = (patch: Partial<NewsStoryInput> = {}): NewsStoryInput => ({
  id: 's1',
  title: 'Binance will list SOLX',
  source: 'Binance',
  kind: 'LISTING',
  impact: 80,
  publishedAt: T - 600,
  seenAt: T - 590,
  stale: false,
  repeat: false,
  relationship: 'DIRECT',
  pricedIn: false,
  ...patch
})

const effect = (patch: Partial<NewsStoryInput> = {}, variant: 'v3' | 'v4' = 'v3', reading: AnalystReadingInput | null = null, horizon: keyof typeof HORIZON_BARS = 'hour1') =>
  storyEffect({ variant, story: story(patch), ticker: 'SOLX', horizon, nowSec: T, library: [LISTING, THIN], reading })

describe("a kind's median path", () => {
  it('runs straight between the library\'s points from nothing at publication, flat beyond four hours', () => {
    const median = LISTING.medianPct!
    expect(medianPathAt(median, 0)).toBe(0)
    expect(medianPathAt(median, -5)).toBe(0)
    expect(medianPathAt(median, 60)).toBeCloseTo(0.2, 12)
    expect(medianPathAt(median, 180)).toBeCloseTo(0.65, 12)
    expect(medianPathAt(median, 3600)).toBeCloseTo(3.4, 12)
    expect(medianPathAt(median, 9000)).toBeCloseTo(3.4 + (3.0 - 3.4) * (5400 / 10_800), 12)
    expect(medianPathAt(median, 86_400)).toBeCloseTo(3.0, 12)
    // A point the library does not have is passed over.
    expect(medianPathAt({ m5: 1, m15: null, h1: 3, h4: 3 }, 900)).toBeCloseTo(1 + (2 * 600) / 3300, 12)
  })
})

describe("a story's effect on the forecast (V3)", () => {
  it('moves the median by what its kind still has to do over the horizon, scaled by its impact', () => {
    const moved = effect()!
    const toCome = medianPathAt(LISTING.medianPct!, 600 + 3600) - medianPathAt(LISTING.medianPct!, 600)
    expect(moved.shiftPct).toBeCloseTo(toCome * 0.8, 12)
    expect(moved).toMatchObject({ variant: 'v3', fromLibrary: true, novelty: 1, pricedIn: false, impact: 80, ageSec: 600, widenShare: 0 })
    // Widened by its kind's spread within an hour, at the horizon's share of it, scaled the same.
    expect(moved.widenPct).toBeCloseTo(((5 - -1) / 2) * 0.8, 12)
    expect(effect({}, 'v3', null, 'minutes15')!.widenPct).toBeCloseTo(3 * Math.sqrt(900 / 3600) * 0.8, 12)
    expect(effect({}, 'v3', null, 'hours24')!.widenPct).toBeCloseTo(((7 - -3) / 2) * 0.8, 12)
  })

  it('counts a story carried again half, and old news, or one already priced in, not at all', () => {
    expect(effect({ repeat: true })!.shiftPct).toBeCloseTo(effect()!.shiftPct / 2, 12)
    expect(effect({ stale: true })).toBeNull()
    const priced = effect({ pricedIn: true })!
    expect(priced.shiftPct).toBe(0)
    expect(priced.widenPct).toBeCloseTo(effect()!.widenPct, 12)
  })

  it('only widens where its kind has no library, by up to half the forecast\'s spread', () => {
    const thin = effect({ kind: 'AIRDROP' })!
    expect(thin).toMatchObject({ fromLibrary: false, shiftPct: 0, widenPct: 0 })
    expect(thin.widenShare).toBeCloseTo(NEWS_EFFECT_LINES.noHistoryWiden * 0.8, 12)
  })

  it('counts only the coin\'s own stories, seen by the forecast\'s moment and within four hours of it', () => {
    expect(effect({ relationship: 'INDIRECT' })).toBeNull()
    // Seen after the forecast's moment: not known then.
    expect(effect({ seenAt: T + 1 })).toBeNull()
    expect(effect({ seenAt: T - NEWS_EFFECT_LINES.windowSec - 1 })).toBeNull()
    expect(effect({ seenAt: T - NEWS_EFFECT_LINES.windowSec })).not.toBeNull()
    // By when it was seen, not when it was published: an old story seen just now counts, its path read
    // from its publication.
    const late = effect({ publishedAt: T - 5 * 3600, seenAt: T - 60 })!
    expect(late.ageSec).toBe(5 * 3600)
    expect(late.shiftPct).toBeCloseTo((medianPathAt(LISTING.medianPct!, 5 * 3600 + 3600) - medianPathAt(LISTING.medianPct!, 5 * 3600)) * 0.8, 12)
  })

  it('is the story that moves it most, then the one that widens it most', () => {
    const stories = [story({ id: 'a', impact: 40 }), story({ id: 'b', impact: 90 }), story({ id: 'c', kind: 'AIRDROP', impact: 100 })]
    expect(newsEffectOf({ variant: 'v3', stories, ticker: 'SOLX', horizon: 'hour1', nowSec: T, library: [LISTING, THIN] })!.storyId).toBe('b')
    const unmoved = [story({ id: 'd', kind: 'AIRDROP', impact: 30 }), story({ id: 'e', kind: 'AIRDROP', impact: 60 })]
    expect(newsEffectOf({ variant: 'v3', stories: unmoved, ticker: 'SOLX', horizon: 'hour1', nowSec: T, library: [LISTING, THIN] })!.storyId).toBe('e')
    expect(newsEffectOf({ variant: 'v3', stories: [], ticker: 'SOLX', horizon: 'hour1', nowSec: T, library: [LISTING] })).toBeNull()
  })
})

describe("the analyst's reading in the forecast (V4)", () => {
  const reading = (patch: Partial<AnalystReadingInput> = {}): AnalystReadingInput => ({ ticker: 'SOLX', relationship: 'DIRECT', direction: 'down', impact: 50, pricedIn: false, at: T - 300, ...patch })

  it("stands for the rules': its direction for the library's sign, its impact and its priced-in", () => {
    const rules = effect()!
    const read = effect({}, 'v4', reading())!
    expect(read.variant).toBe('v4')
    expect(read.impact).toBe(50)
    expect(read.shiftPct).toBeCloseTo((-rules.shiftPct / 0.8) * 0.5, 12)
    expect(effect({}, 'v4', reading({ direction: 'up' }))!.shiftPct).toBeCloseTo((rules.shiftPct / 0.8) * 0.5, 12)
    expect(effect({}, 'v4', reading({ direction: 'none' }))!.shiftPct).toBe(0)
    expect(effect({}, 'v4', reading({ pricedIn: true }))!.shiftPct).toBe(0)
  })

  it('moves nothing where it read the story as not about this coin, and is not used before it was answered', () => {
    expect(effect({}, 'v4', reading({ relationship: 'NONE' }))).toBeNull()
    expect(effect({}, 'v4', reading({ ticker: 'BTC' }))).toBeNull()
    // Answered after the forecast's moment: the rules' reading stands.
    expect(effect({}, 'v4', reading({ at: T + 1 }))!.shiftPct).toBeCloseTo(effect()!.shiftPct, 12)
    // V3 never reads it.
    expect(effect({}, 'v3', reading())!.shiftPct).toBeCloseTo(effect()!.shiftPct, 12)
  })

  it('is read from the ledger with when it was answered, the first answer for a story kept', () => {
    const answer = { ticker: 'SOLX', relationship: 'DIRECT', direction: 'up', impact: 70, horizon: '1h', confidence: 0.7, pricedIn: false, reasons: 'A listing.' }
    const row = (at: number, patch: Record<string, unknown> = {}) => ({ promptVersion: AI_ADDITION_PROMPT_VERSIONS.news, status: 'ok' as const, subjectId: 's1', additionAnswer: answer, at, ...patch })
    const read = newsReadingsAt([row(T - 100), row(T - 200), row(T - 50, { status: 'refused' }), row(T, { subjectId: 's2', additionAnswer: { nonsense: true } })] as never)
    expect(Object.keys(read)).toEqual(['s1'])
    expect(read.s1).toMatchObject({ direction: 'up', impact: 70, at: T - 200 })
  })
})

describe("the news's own skill", () => {
  it('is measured from two hundred of its outcomes in thirty days, against the better of an even chance and their base rate', () => {
    const rows = (n: number, pUp: number, upEvery: number, due = T) => Array.from({ length: n }, (_, k) => ({ h: 'hour1' as const, due, pUp, up: k % upEvery === 0 }))
    expect(newsSkillOf(rows(199, 0.7, 2), T).hour1).toBeNull()
    // P(up) 0.7 for outcomes that went up half the time: worse than an even chance.
    expect(newsSkillOf(rows(200, 0.7, 2), T).hour1).toBeCloseTo(1 - 0.29 / 0.25, 12)
    // Outcomes long past are not counted.
    expect(newsSkillOf(rows(200, 0.7, 2, T - 31 * 86_400), T).hour1).toBeNull()
    expect(newsSkillOf(rows(200, 0.7, 2), T).minutes5).toBeNull()
    // A quarter went up: their base rate (Brier 0.1875) scored better than an even chance, and is the
    // one to beat; P(up) 0.25 matched it and knew nothing more.
    expect(newsSkillOf(rows(200, 0.25, 4), T).hour1).toBeCloseTo(0, 12)
  })
})

describe('the kinds of error a story made', () => {
  const hour = { horizon: 'hour1' as const, quantilesPct: [-2, -1, 0.5, 2, 3], pUp: 0.5, direction: 'NEUTRAL' as const, width80Pct: 5, usualWidth80Pct: 4 }
  it('is NEWS_MISREAD where its story moved the median one way and the close went the other, and a wrong call without one MARKET_MISREAD', () => {
    expect(errorsOf({ ...hour, newsShiftPct: 0.8 }, -0.5, 0.1, -0.6)).toContain('NEWS_MISREAD')
    expect(errorsOf({ ...hour, newsShiftPct: 0.8 }, 0.5, 0.6, 0)).not.toContain('NEWS_MISREAD')
    expect(errorsOf({ ...hour, newsShiftPct: -0.8 }, 0.5, 0.6, 0)).toContain('NEWS_MISREAD')
    expect(errorsOf({ ...hour, newsShiftPct: 0.8 }, 0, 0, 0)).not.toContain('NEWS_MISREAD')
    expect(errorsOf({ ...hour, direction: 'BULLISH' }, -0.5, 0.1, -0.6)).toContain('MARKET_MISREAD')
    expect(errorsOf({ ...hour, direction: 'BULLISH', newsShiftPct: 0.8 }, -0.5, 0.1, -0.6)).not.toContain('MARKET_MISREAD')
    expect(errorsOf({ ...hour, direction: 'BULLISH' }, 0.5, 0.6, 0)).not.toContain('MARKET_MISREAD')
  })
})

describe('the prediction with the news', () => {
  const CALIBRATION = buildRunCalibration(new Map([['hour1', recordOf({ rows: 12_000, seed: 61, horizon: 'hour1' })]]), promoted('hour1', ['persistence', 'gbt']), 'run-news')
  const models = Object.fromEntries(FORECAST_MODELS.map((model) => [model, model === 'gbt' ? scaled(1) : scaled(1.25)])) as Record<ForecastModelId, number[]>
  const input = (patch: Partial<PredictionInput> = {}): PredictionInput => ({
    pair: 'SOLXUSDT',
    pairClass: 'mid',
    regime: 'sideways',
    barTime: T,
    price: 100,
    generatedAt: T * 1000,
    rv24h: 0.04,
    rvRatio: 1,
    models: { hour1: models },
    calibration: CALIBRATION,
    runId: 'run-x',
    foldsRunId: 'run-news',
    ...patch
  })

  it('is V2 where no story moves it', () => {
    const plain = makePrediction(input())!.horizons.hour1!
    expect(plain.news).toEqual({ v3: null, v4: null })
    expect(plain.newsShiftLogPct).toBeCloseTo(0, 12)
    expect(plain.variants.v4).toEqual(plain.variants.v2)
    const noStory = makePrediction(input({ news: { ticker: 'SOLX', stories: [], library: [LISTING] } }))!.horizons.hour1!
    expect(noStory.quantilesPct).toEqual(plain.quantilesPct)
  })

  it('shows V4: its median moved by the story, its range widened, the parts still adding up, the story named', () => {
    const plain = makePrediction(input())!.horizons.hour1!
    const read: Record<string, AnalystReadingInput> = { s1: { ticker: 'SOLX', relationship: 'DIRECT', direction: 'up', impact: 90, pricedIn: false, at: T - 300 } }
    const prediction = makePrediction(input({ news: { ticker: 'SOLX', stories: [story()], library: [LISTING], readings: read } }))!
    const hour = prediction.horizons.hour1!
    expect(hour.news.v3!.storyId).toBe('s1')
    expect(hour.news.v4!.impact).toBe(90)
    expect(hour.variants.v3!.medianPct).toBeGreaterThan(plain.medianPct!)
    // Moved by exactly the story's shift, as a move on top of the forecast's: widening leaves a median be.
    expect(hour.variants.v3!.medianPct).toBeCloseTo(((1 + plain.medianPct! / 100) * (1 + hour.news.v3!.shiftPct / 100) - 1) * 100, 9)
    expect(hour.variants.v4!.medianPct).toBeGreaterThan(hour.variants.v3!.medianPct)
    expect(hour.quantilesPct).toEqual(hour.variants.v4!.quantilesPct)
    expect(hour.width80Pct).toBeGreaterThan(plain.width80Pct)
    expect(hour.newsShiftLogPct).toBeGreaterThan(0)
    const total = hour.contributions.reduce((sum, member) => sum + member.weight * member.medianLogPct, 0) + hour.calibrationShiftLogPct + hour.newsShiftLogPct
    expect(total).toBeCloseTo(Math.log(1 + hour.medianPct! / 100) * 100, 9)
    expect(prediction).toMatchObject({ mainCatalyst: 'Binance will list SOLX', newsImpact: 90 })
    // Without the news's own skill, the story moves the range and not the P(up), and calls no way.
    expect(hour.pUp).toBe(plain.pUp)
    expect(hour.direction).toBe('NEUTRAL')
  })

  it("reads the news-moved P(up) once its own outcomes showed it knew more than an even chance", () => {
    const news = { ticker: 'SOLX', stories: [story({ impact: 100 })], library: [LISTING] }
    const unproven = makePrediction(input({ news: { ...news, skill: { hour1: 0.009 } } }))!.horizons.hour1!
    expect(unproven.pUp).not.toBe(unproven.pUpMapped)
    const proven = makePrediction(input({ news: { ...news, skill: { hour1: 0.05 } } }))!.horizons.hour1!
    expect(proven.pUp).toBe(proven.pUpMapped)
    expect(proven.directionSkill).toBe(0.05)
  })
})
