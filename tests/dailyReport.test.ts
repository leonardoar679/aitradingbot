import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import { sessionReportOf, type SessionReport, type SessionReportInput } from '../shared/shadowReport'
import {
  DAILY_MODELS_SHOWN,
  DAILY_MOVERS_SHOWN,
  DAILY_NEWS_SHOWN,
  DAILY_REPORT_DAYS_BACK,
  dailyReport,
  dailyReportCsv,
  dayBounds,
  dayChangePct,
  daysBack,
  describeDailyReport,
  hourlyDayChangePct,
  hourlyReturnsAt,
  type DailyReportInput
} from '../shared/dailyReport'

// shared/dailyReport.ts: one UTC day as the records hold it, built from what is handed in. Pure;
// nothing is asked or stored.

const DAY = '2026-10-07'
const { fromSec, toSec } = dayBounds(DAY)
const NOW = toSec + 3600

/** A session report over the day with nothing in it: the shape the daily report embeds. */
function emptySession(over: Partial<SessionReportInput> = {}): SessionReport {
  return sessionReportOf({
    span: 'day',
    fromSec,
    toSec,
    appStartedSec: fromSec - 86_400,
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
    versions: null,
    ...over
  })
}

/** Hourly bars from a day before the day to its end, flat at 100 but for the day itself, which
 * rises `dayPct` percent evenly. */
function hours(dayPct: number, until = toSec): Candle[] {
  const out: Candle[] = []
  for (let time = fromSec - 86_400; time < until; time += 3600) {
    const open = time < fromSec ? 100 : 100 * (1 + (dayPct / 100) * ((time - fromSec) / 86_400))
    const close = time < fromSec ? 100 : 100 * (1 + (dayPct / 100) * ((time + 3600 - fromSec) / 86_400))
    out.push({ time, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 10 })
  }
  return out
}
const dailyBar = (dayPct: number, volume = 1000): Candle[] => [{ time: fromSec - 86_400, open: 100, high: 100, low: 100, close: 100, volume }, { time: fromSec, open: 100, high: 100, low: 100, close: 100 * (1 + dayPct / 100), volume }]

function input(over: Partial<DailyReportInput> = {}): DailyReportInput {
  return {
    day: DAY,
    nowSec: NOW,
    session: emptySession(),
    dailyBars: { SOLUSDT: dailyBar(8), ETHUSDT: dailyBar(2), ADAUSDT: dailyBar(-3), XRPUSDT: dailyBar(-6), DOGEUSDT: dailyBar(0.5), LTCUSDT: dailyBar(-1), BNBUSDT: dailyBar(1), ZEROUSDT: dailyBar(0) },
    btcHours: hours(12),
    ethHours: hours(-1),
    stories: [],
    reactions: {},
    storiesKept: true,
    modelRows: [],
    calls: [],
    pause: { watch: { paused: null }, news: { paused: null } },
    aiCapUsd: 5,
    healthPauses: 0,
    ...over
  }
}

describe('the day', () => {
  it('runs from midnight to midnight UTC, and the days offered are yesterday back thirty', () => {
    expect(dayBounds(DAY)).toEqual({ fromSec: Date.parse('2026-10-07T00:00:00Z') / 1000, toSec: Date.parse('2026-10-08T00:00:00Z') / 1000 })
    expect(() => dayBounds('yesterday')).toThrow('not a UTC day')
    const days = daysBack(Date.parse('2026-10-08T06:00:00Z') / 1000)
    expect(days).toHaveLength(DAILY_REPORT_DAYS_BACK)
    expect(days[0]).toBe('2026-10-07')
    expect(days[29]).toBe('2026-09-08')
  })
})

describe('the market', () => {
  it("reads a pair's day from its daily bar, and Bitcoin's regime from its hours at the day's end", () => {
    expect(dayChangePct(dailyBar(8), fromSec)).toBeCloseTo(8, 10)
    expect(dayChangePct(dailyBar(8), fromSec - 86_400)).toBe(0)
    expect(dayChangePct([], fromSec)).toBeNull()
    expect(hourlyDayChangePct(hours(2), fromSec, toSec)).toBeCloseTo(2, 6)
    // Hours that stop short of the day's end, or begin after its start, say nothing of the day.
    expect(hourlyDayChangePct(hours(2, toSec - 3600), fromSec, toSec)).toBeNull()
    expect(hourlyDayChangePct(hours(2).filter((bar) => bar.time !== fromSec), fromSec, toSec)).toBeNull()
    const returns = hourlyReturnsAt(hours(12), toSec)
    expect(returns).not.toBeNull()
    expect(returns?.h24).toBeCloseTo(12, 6)
    expect(returns?.h4).toBeCloseTo(100 * (1.12 / (1 + 0.12 * (20 / 24)) - 1), 6)
    expect(hourlyReturnsAt(hours(2, toSec - 3600), toSec)).toBeNull()
    expect(hourlyReturnsAt([], toSec)).toBeNull()
  })

  it('ranks the movers up and down, counts the breadth, and names the regime', () => {
    const report = dailyReport(input())
    expect(report.market.moversUp.map((mover) => [mover.symbol, mover.dayPct])).toEqual([
      ['SOLUSDT', 8],
      ['ETHUSDT', 2],
      ['BNBUSDT', 1],
      ['DOGEUSDT', 0.5]
    ])
    expect(report.market.moversDown.map((mover) => [mover.symbol, mover.dayPct])).toEqual([
      ['XRPUSDT', -6],
      ['ADAUSDT', -3],
      ['LTCUSDT', -1]
    ])
    expect(report.market.moversUp[0].quoteVolume).toBe(108_000)
    // A 12% day: four hours of it are 2%, over Bitcoin's regime line; the day is up, so bull.
    // A pair that closed where it opened is read, and is neither a riser nor a faller: four of eight rose.
    expect(report.market).toMatchObject({ pairsRead: 8, breadthPct: 50, btcDayPct: 12, ethDayPct: -1, regime: 'bull' })
    expect(DAILY_MOVERS_SHOWN).toBe(5)
    // Eleven risers: five shown. A pair without the day's bar is not read.
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, k) => [`P${k}USDT`, dailyBar(k + 1)]))
    const wide = dailyReport(input({ dailyBars: { ...many, NOBAR: [] } }))
    expect(wide.market.moversUp).toHaveLength(5)
    expect(wide.market.moversUp[0].symbol).toBe('P10USDT')
    expect(wide.market.pairsRead).toBe(11)
    // Without Bitcoin's hours: no regime, no day change, and the rest stands.
    const blind = dailyReport(input({ btcHours: [], ethHours: [] }))
    expect(blind.market).toMatchObject({ regime: null, btcDayPct: null, ethDayPct: null, pairsRead: 8 })
    expect(dailyReport(input({ dailyBars: {} })).market.breadthPct).toBeNull()
  })
})

describe('the news', () => {
  const story = (id: string, impact: number, publishedAt: number, title = `Story ${id}`): DailyReportInput['stories'][number] => ({
    id,
    title,
    sourceName: 'CoinDesk',
    impact,
    assets: [{ ticker: 'SOL', relationship: 'DIRECT' }],
    publishedAt,
    url: `https://www.coindesk.com/${id}`
  })

  it('keeps the major stories of the day, strongest first, with the hour that followed each', () => {
    // Seventy is major; sixty-nine is not. A story the second before the day, or at its end, is not the day's.
    const stories = [story('a', 80, fromSec + 3600), story('b', 90, fromSec + 7200), story('c', 69, fromSec + 100), story('d', 75, fromSec - 1), story('e', 95, toSec), story('g', 70, fromSec + 200)]
    const report = dailyReport(input({ stories, reactions: { b: { after: { m5: 0.1, m15: 0.4, h1: 1.234, h4: 2 } } } }))
    expect(report.news.major.map((entry) => [entry.id, entry.impact, entry.reactionH1Pct])).toEqual([
      ['b', 90, 1.23],
      ['a', 80, null],
      ['g', 70, null]
    ])
    expect(report.news.major[0]).toMatchObject({ title: 'Story b', source: 'CoinDesk', tickers: ['SOL'], url: 'https://www.coindesk.com/b' })
    expect(report.news).toMatchObject({ storiesRead: 4, kept: true })
    expect(DAILY_NEWS_SHOWN).toBe(8)
    const flood = Array.from({ length: 12 }, (_, k) => story(`f${k}`, 70 + k, fromSec + k * 60))
    expect(dailyReport(input({ stories: flood })).news.major).toHaveLength(8)
    expect(dailyReport(input({ stories: flood, storiesKept: false })).news.kept).toBe(false)
  })
})

describe('the models and the risk condition', () => {
  it('ranks the models by what a trade made, and reads the pauses, the spend and the pauses by health', () => {
    const rows = [
      { name: 'a', closed: 40, meanNetPct: 0.2, profitFactor: 1.3, netAfterAiCostUsd: 12.345 },
      { name: 'b', closed: 50, meanNetPct: 0.5, profitFactor: 1.9, netAfterAiCostUsd: 30 },
      { name: 'c', closed: 10, meanNetPct: null, profitFactor: null, netAfterAiCostUsd: -1 },
      { name: 'd', closed: 20, meanNetPct: null, profitFactor: null, netAfterAiCostUsd: 0 }
    ]
    const calls = [
      { at: fromSec + 10, usage: { promptTokens: 1, completionTokens: 1, costUsd: 0.0123456, latencyMs: 1 } },
      { at: fromSec + 20, usage: { promptTokens: 1, completionTokens: 1, costUsd: null, latencyMs: 1 } },
      { at: toSec + 1, usage: { promptTokens: 1, completionTokens: 1, costUsd: 1, latencyMs: 1 } }
    ]
    const report = dailyReport(input({ modelRows: rows, calls, pause: { watch: { paused: { at: 1, r: -5, trades: 20 } }, news: { paused: null } }, healthPauses: 2 }))
    expect(report.models.rows.map((row) => row.model)).toEqual(['b', 'a', 'd', 'c'])
    expect(report.models.rows[1]).toEqual({ model: 'a', closed: 40, meanNetPct: 0.2, profitFactor: 1.3, netAfterAiCostUsd: 12.35 })
    expect(report.models.days).toBe(30)
    expect(DAILY_MODELS_SHOWN).toBe(6)
    expect(dailyReport(input({ modelRows: Array.from({ length: 9 }, (_, k) => ({ name: `m${k}`, closed: 30, meanNetPct: k, profitFactor: 1, netAfterAiCostUsd: 0 })) })).models.rows).toHaveLength(6)
    expect(report.risk).toEqual({ paused: { watch: true, news: false }, aiSpentUsd: 0.012346, aiCapUsd: 5, healthPauses: 2, alertsHigh: 0 })
  })
})

describe('the whole', () => {
  it('embeds the session report over the day, and says the day in one line', () => {
    const session = emptySession({ alerts: [{ at: fromSec + 5, severity: 'high' }, { at: fromSec + 6, severity: 'critical' }, { at: fromSec + 7, severity: 'watch' }] })
    const report = dailyReport(input({ session }))
    expect(report).toMatchObject({ version: 'daily-report-v1', day: DAY, fromSec, toSec, builtAt: NOW })
    expect(report.session).toBe(session)
    expect(report.risk.alertsHigh).toBe(2)
    expect(describeDailyReport(report)).toBe('2026-10-07: Bitcoin +12.00%, bull; 0 major stories; 0 paper trades opened, 0 ended; 2 high alerts.')
    expect(describeDailyReport(dailyReport(input({ btcHours: [] })))).toMatch(/^2026-10-07: Bitcoin unread; /)
  })

  it('saves as CSV: the day, the movers, the news, the models and the risk, then the session report', () => {
    const csv = dailyReportCsv(dailyReport(input()))
    const lines = csv.split('\n')
    expect(lines[0]).toBe('section,key,value')
    expect(lines[1]).toBe('day,day,2026-10-07')
    expect(lines).toContain('market,regime,bull')
    expect(lines).toContain('moverUp,SOLUSDT,8')
    expect(lines).toContain('moverDown,XRPUSDT,-6')
    expect(lines).toContain('risk,aiCapUsd,5')
    // A comma in a title is quoted.
    const quoted = dailyReportCsv(dailyReport(input({ stories: [{ id: 'q', title: 'Binance lists SOL, ETH futures', sourceName: 'CoinDesk', impact: 80, assets: [], publishedAt: fromSec + 1, url: 'u' }] })))
    expect(quoted).toContain('news,"CoinDesk: Binance lists SOL, ETH futures",80')
    // The session report's own CSV follows, whole.
    expect(csv).toContain('\n\n')
    expect(csv.split('\n\n')[1].length).toBeGreaterThan(100)
  })
})
