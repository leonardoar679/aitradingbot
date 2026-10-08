import { beforeEach, describe, expect, it } from 'vitest'
import type { DailySummaryRequest } from '../shared/aiAdditions'
import { dailyReport, type DailyReport } from '../shared/dailyReport'
import { sessionReportOf } from '../shared/shadowReport'
import { DAILY_SUMMARY_AFTER_SEC, DAILY_SUMMARY_LOOK_MS, lookAtDailySummary, resetDailySummaryLook, type DailySummaryDeps } from '../src/performance/dailySummary'

// src/performance/dailySummary.ts: the look that asks for the day before's paragraph by itself,
// once a day after 00:05 UTC while the watch is on. It builds, asks and remembers; it writes nothing.

const DAY = 86_400
const MIDNIGHT = Date.parse('2026-10-08T00:00:00Z') / 1000

function report(day: string): DailyReport {
  const fromSec = Date.parse(`${day}T00:00:00Z`) / 1000
  const session = sessionReportOf({
    span: 'day',
    fromSec,
    toSec: fromSec + DAY,
    appStartedSec: fromSec,
    events: [],
    calls: [],
    executors: [],
    watchPaper: { maxOpen: 3, maxSameSide: 2 },
    maxOutQuote: null,
    connection: null,
    alerts: [],
    refusals: [],
    recommendations: [],
    trades: [],
    stories: [],
    versions: null
  })
  return dailyReport({ day, nowSec: fromSec + DAY + 600, session, dailyBars: {}, btcHours: [], ethHours: [], stories: [], reactions: {}, storiesKept: true, modelRows: [], calls: [], pause: { watch: { paused: null }, news: { paused: null } }, aiCapUsd: 5, healthPauses: 0 })
}

function rig(over: Partial<DailySummaryDeps> = {}): { deps: DailySummaryDeps; built: string[]; asked: { request: DailySummaryRequest; automatic: boolean }[] } {
  const built: string[] = []
  const asked: { request: DailySummaryRequest; automatic: boolean }[] = []
  return {
    built,
    asked,
    deps: {
      watchOn: async () => true,
      askedSince: async () => false,
      report: async (day) => {
        built.push(day)
        return report(day)
      },
      summarize: async (request, automatic) => {
        asked.push({ request, automatic })
        return { asked: true, outcome: { status: 'answered', answer: { summary: 'A fake paragraph about the day, long enough to pass.', confidence: 0.5 }, cached: false, model: 'm' } }
      },
      nowSec: () => MIDNIGHT + DAILY_SUMMARY_AFTER_SEC + 60,
      ...over
    }
  }
}

beforeEach(() => resetDailySummaryLook())

describe('the look', () => {
  it('waits for 00:05 UTC, then asks about the day before, once, by itself', async () => {
    expect(DAILY_SUMMARY_AFTER_SEC).toBe(300)
    expect(DAILY_SUMMARY_LOOK_MS).toBe(5 * 60_000)
    const early = rig({ nowSec: () => MIDNIGHT + DAILY_SUMMARY_AFTER_SEC - 1 })
    expect(await lookAtDailySummary(early.deps)).toEqual({ day: null, asked: false, reason: 'It is not 00:05 UTC yet.' })
    expect(early.built).toEqual([])
    const { deps, built, asked } = rig()
    expect(await lookAtDailySummary(deps)).toEqual({ day: '2026-10-07', asked: true, reason: 'Asked.' })
    expect(built).toEqual(['2026-10-07'])
    expect(asked).toHaveLength(1)
    expect(asked[0].automatic).toBe(true)
    expect(asked[0].request.day).toBe('2026-10-07')
    expect(asked[0].request.question.day).toBe('2026-10-07')
    expect(asked[0].request.question.risk.aiCapUsd).toBe(5)
    // The next look, the same day: nothing is built or asked again.
    expect(await lookAtDailySummary(deps)).toEqual({ day: '2026-10-07', asked: false, reason: 'It was tried this session.' })
    expect(built).toHaveLength(1)
  })

  it('builds nothing with the watch off, or once the day was asked about today', async () => {
    const off = rig({ watchOn: async () => false })
    expect(await lookAtDailySummary(off.deps)).toEqual({ day: '2026-10-07', asked: false, reason: 'The watch is off.' })
    expect(off.built).toEqual([])
    // Switched on later the same session: it is looked at again.
    const done = rig({ askedSince: async (day, sinceSec) => day === '2026-10-07' && sinceSec === MIDNIGHT })
    expect(await lookAtDailySummary(done.deps)).toEqual({ day: '2026-10-07', asked: false, reason: 'It was asked today.' })
    expect(done.built).toEqual([])
    expect(await lookAtDailySummary(done.deps)).toMatchObject({ asked: false, reason: 'It was tried this session.' })
  })

  it('tries a day once a session, whatever came of it', async () => {
    const failing = rig({
      report: async () => {
        throw new Error('the candles could not be read')
      }
    })
    await expect(lookAtDailySummary(failing.deps)).rejects.toThrow('the candles could not be read')
    expect(await lookAtDailySummary(failing.deps)).toMatchObject({ asked: false, reason: 'It was tried this session.' })
    expect(failing.asked).toEqual([])
  })
})
