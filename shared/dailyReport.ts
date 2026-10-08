import { DAILY_SUMMARY_TEXT_CHARS, type DailySummaryQuestion } from './aiAdditions'
import type { EventBenchmarkRow } from './aiEventBenchmark'
import type { AiCallRecord } from './aiLedger'
import { HIGH_IMPACT } from './alerts'
import type { Candle, PaperPauseState } from './ipc'
import { marketRegimeOf, type MarketRegime } from './marketResearch'
import type { ReadStory, StoryReaction } from './newsFeed'
import { utcDay } from './paperDigest'
import { sessionReportCsv, type SessionReport } from './shadowReport'

// THE DAILY REPORT (the V4 document, §87): one UTC day, as the records hold it. The market's state
// at the day's end and the day's biggest movers, from public candles; the major news of the day,
// from the feed's stories (kept a week); the app's own paper trades, the calls and the alerts, from
// the session report built over the day (shared/shadowReport.ts); the models' ranking over the
// last thirty days, from the live board; and the risk condition. Yesterday, or any day back
// DAILY_REPORT_DAYS_BACK. Built when looked at and stored nowhere, like the session report; saved
// as JSON or CSV on a click. It asks nothing: the one paragraph a model writes about it is the
// fifth AI addition (shared/aiAdditions.ts), asked once a day and shown beside it.

export const DAILY_REPORT_VERSION = 'daily-report-v1'
export const DAILY_REPORT_DAYS_BACK = 30
export const DAILY_MOVERS_SHOWN = 5
export const DAILY_NEWS_SHOWN = 8
export const DAILY_MODELS_SHOWN = 6
export const DAILY_MODEL_DAYS = 30
const DAY = 86_400
const HOUR = 3600

/** The UTC day's bounds: midnight to the next midnight, in seconds. */
export function dayBounds(day: string): { fromSec: number; toSec: number } {
  const fromSec = Date.parse(`${day}T00:00:00Z`) / 1000
  if (!Number.isFinite(fromSec)) throw new Error(`${day} is not a UTC day`)
  return { fromSec, toSec: fromSec + DAY }
}

/** The days a report can be built for: yesterday first, back `count` days. */
export function daysBack(nowSec: number, count = DAILY_REPORT_DAYS_BACK): string[] {
  const today = Math.floor(nowSec / DAY) * DAY
  return Array.from({ length: count }, (_, index) => utcDay(today - (index + 1) * DAY))
}

export interface DailyMover {
  symbol: string
  dayPct: number
  quoteVolume: number | null
}

export interface DailyNews {
  id: string
  title: string
  source: string
  impact: number
  tickers: string[]
  publishedAt: number
  /** The coin's move over the hour after the story, where it was measured. */
  reactionH1Pct: number | null
  url: string
}

export interface DailyModelRow {
  model: string
  closed: number
  meanNetPct: number | null
  profitFactor: number | null
  netAfterAiCostUsd: number | null
}

export interface DailyReport {
  version: string
  day: string
  fromSec: number
  toSec: number
  builtAt: number
  market: {
    btcDayPct: number | null
    ethDayPct: number | null
    /** By Bitcoin's moves at the day's end (shared/marketResearch.ts); null without its hours. */
    regime: MarketRegime | null
    /** The share of the pairs read that rose over the day, in percent. */
    breadthPct: number | null
    moversUp: DailyMover[]
    moversDown: DailyMover[]
    pairsRead: number
  }
  news: {
    major: DailyNews[]
    storiesRead: number
    /** False when the day is older than the feed keeps stories: nothing can be said of its news. */
    kept: boolean
  }
  /** The session report over the day: its events, calls, answers, paper trades, alerts and gates. */
  session: SessionReport
  models: { days: number; rows: DailyModelRow[] }
  risk: {
    paused: { watch: boolean; news: boolean }
    aiSpentUsd: number
    aiCapUsd: number
    /** LIVE TRADING PAUSED notices in the day, by the exchange's health. */
    healthPauses: number
    alertsHigh: number
  }
}

export interface DailyReportInput {
  day: string
  nowSec: number
  session: SessionReport
  /** Each pair's daily bars, the day's among them, by symbol. */
  dailyBars: Readonly<Record<string, readonly Candle[]>>
  /** Bitcoin's and ether's hourly bars through the day, from a day before it. */
  btcHours: readonly Candle[]
  ethHours: readonly Candle[]
  stories: readonly Pick<ReadStory, 'id' | 'title' | 'sourceName' | 'impact' | 'assets' | 'publishedAt' | 'url'>[]
  reactions: Readonly<Record<string, Pick<StoryReaction, 'after'>>>
  storiesKept: boolean
  modelRows: readonly Pick<EventBenchmarkRow, 'name' | 'closed' | 'meanNetPct' | 'profitFactor' | 'netAfterAiCostUsd'>[]
  calls: readonly Pick<AiCallRecord, 'at' | 'usage'>[]
  /** The paper pause's state for each side (shared/paperPause.ts): paused since, or null. */
  pause: { watch: Pick<PaperPauseState, 'paused'>; news: Pick<PaperPauseState, 'paused'> }
  aiCapUsd: number
  healthPauses: number
}

const pct = (from: number, to: number): number | null => (from > 0 && to > 0 ? (to / from - 1) * 100 : null)
const round = (value: number | null, places = 2): number | null => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places)

/** The day's change of a pair from its daily bar that opens at the day's start. */
export function dayChangePct(bars: readonly Candle[], fromSec: number): number | null {
  const bar = bars.find((candle) => candle.time === fromSec)
  return bar === undefined ? null : pct(bar.open, bar.close)
}

/** Bitcoin's returns at the day's end from its hourly bars: the last hour of the day against the
 * hours before it. Null where the hours are not all there. */
export function hourlyReturnsAt(hours: readonly Candle[], toSec: number): { h1: number; h4: number; h24: number | null } | null {
  const closed = hours.filter((bar) => bar.time + HOUR <= toSec).sort((a, b) => a.time - b.time)
  const last = closed[closed.length - 1]
  if (last === undefined || last.time !== toSec - HOUR) return null
  const at = (back: number): Candle | undefined => closed.find((bar) => bar.time === last.time - back * HOUR)
  const h1 = at(1)
  const h4 = at(4)
  const h24 = at(24)
  if (h1 === undefined || h4 === undefined) return null
  const over = (bar: Candle): number | null => pct(bar.close, last.close)
  const one = over(h1)
  const four = over(h4)
  if (one === null || four === null) return null
  return { h1: one, h4: four, h24: h24 === undefined ? null : over(h24) }
}

/** The day's change over its hourly bars: the first hour's open against the last hour's close. */
export function hourlyDayChangePct(hours: readonly Candle[], fromSec: number, toSec: number): number | null {
  const inDay = hours.filter((bar) => bar.time >= fromSec && bar.time + HOUR <= toSec).sort((a, b) => a.time - b.time)
  const first = inDay[0]
  const last = inDay[inDay.length - 1]
  return first === undefined || last === undefined || first.time !== fromSec || last.time !== toSec - HOUR ? null : pct(first.open, last.close)
}

export function dailyReport(input: DailyReportInput): DailyReport {
  const { fromSec, toSec } = dayBounds(input.day)
  const movers: DailyMover[] = []
  for (const [symbol, bars] of Object.entries(input.dailyBars)) {
    const dayPct = dayChangePct(bars, fromSec)
    if (dayPct === null) continue
    const bar = bars.find((candle) => candle.time === fromSec)
    movers.push({ symbol, dayPct: round(dayPct) ?? 0, quoteVolume: bar === undefined ? null : round(bar.volume * bar.close, 0) })
  }
  movers.sort((a, b) => b.dayPct - a.dayPct)
  const btc = hourlyReturnsAt(input.btcHours, toSec)
  const major: DailyNews[] = input.stories
    .filter((story) => story.publishedAt >= fromSec && story.publishedAt < toSec && story.impact >= HIGH_IMPACT)
    .sort((a, b) => b.impact - a.impact || a.publishedAt - b.publishedAt)
    .slice(0, DAILY_NEWS_SHOWN)
    .map((story) => ({
      id: story.id,
      title: story.title,
      source: story.sourceName,
      impact: story.impact,
      tickers: story.assets.map((asset) => asset.ticker),
      publishedAt: story.publishedAt,
      reactionH1Pct: round(input.reactions[story.id]?.after.h1 ?? null),
      url: story.url
    }))
  const rows: DailyModelRow[] = [...input.modelRows]
    .sort((a, b) => (b.meanNetPct ?? Number.NEGATIVE_INFINITY) - (a.meanNetPct ?? Number.NEGATIVE_INFINITY) || b.closed - a.closed)
    .slice(0, DAILY_MODELS_SHOWN)
    .map((row) => ({ model: row.name, closed: row.closed, meanNetPct: round(row.meanNetPct), profitFactor: round(row.profitFactor), netAfterAiCostUsd: round(row.netAfterAiCostUsd) }))
  const aiSpentUsd = input.calls.filter((row) => row.at >= fromSec && row.at < toSec).reduce((sum, row) => sum + (row.usage.costUsd ?? 0), 0)
  return {
    version: DAILY_REPORT_VERSION,
    day: input.day,
    fromSec,
    toSec,
    builtAt: input.nowSec,
    market: {
      btcDayPct: round(hourlyDayChangePct(input.btcHours, fromSec, toSec)),
      ethDayPct: round(hourlyDayChangePct(input.ethHours, fromSec, toSec)),
      regime: btc === null ? null : marketRegimeOf(btc),
      breadthPct: movers.length === 0 ? null : round((movers.filter((mover) => mover.dayPct > 0).length / movers.length) * 100, 1),
      moversUp: movers.filter((mover) => mover.dayPct > 0).slice(0, DAILY_MOVERS_SHOWN),
      moversDown: [...movers].reverse().filter((mover) => mover.dayPct < 0).slice(0, DAILY_MOVERS_SHOWN),
      pairsRead: movers.length
    },
    news: { major, storiesRead: input.stories.filter((story) => story.publishedAt >= fromSec && story.publishedAt < toSec).length, kept: input.storiesKept },
    session: input.session,
    models: { days: DAILY_MODEL_DAYS, rows },
    risk: {
      paused: { watch: input.pause.watch.paused !== null, news: input.pause.news.paused !== null },
      aiSpentUsd: Math.round(aiSpentUsd * 1_000_000) / 1_000_000,
      aiCapUsd: input.aiCapUsd,
      healthPauses: input.healthPauses,
      alertsHigh: input.session.alerts.high + input.session.alerts.critical
    }
  }
}

/** The report as CSV: the day's own tables, then the session report's. */
export function dailyReportCsv(report: DailyReport): string {
  const cell = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) return ''
    const text = typeof value === 'number' ? String(value) : value
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const line = (...values: (string | number | null | undefined)[]): string => values.map(cell).join(',')
  const lines = [
    line('section', 'key', 'value'),
    line('day', 'day', report.day),
    line('day', 'version', report.version),
    line('market', 'btcDayPct', report.market.btcDayPct),
    line('market', 'ethDayPct', report.market.ethDayPct),
    line('market', 'regime', report.market.regime),
    line('market', 'breadthPct', report.market.breadthPct),
    line('market', 'pairsRead', report.market.pairsRead),
    ...report.market.moversUp.map((mover) => line('moverUp', mover.symbol, mover.dayPct)),
    ...report.market.moversDown.map((mover) => line('moverDown', mover.symbol, mover.dayPct)),
    ...report.news.major.map((story) => line('news', `${story.source}: ${story.title}`, story.impact)),
    line('news', 'storiesRead', report.news.storiesRead),
    line('news', 'kept', report.news.kept ? 'yes' : 'no'),
    ...report.models.rows.map((row) => line('model', row.model, row.meanNetPct)),
    line('risk', 'pausedWatch', report.risk.paused.watch ? 'yes' : 'no'),
    line('risk', 'pausedNews', report.risk.paused.news ? 'yes' : 'no'),
    line('risk', 'aiSpentUsd', report.risk.aiSpentUsd),
    line('risk', 'aiCapUsd', report.risk.aiCapUsd),
    line('risk', 'healthPauses', report.risk.healthPauses),
    line('risk', 'alertsHigh', report.risk.alertsHigh)
  ]
  // A blank line, then the session report's own CSV, whole.
  return lines.join('\n') + '\n\n' + sessionReportCsv(report.session)
}

/** The report's figures as the fifth AI addition is shown them (shared/aiAdditions.ts): the same
 * numbers, bounded, and nothing a model could act on. */
export function dailySummaryQuestionOf(report: DailyReport): DailySummaryQuestion {
  const text = (value: string): string => value.slice(0, DAILY_SUMMARY_TEXT_CHARS)
  const paper = report.session.paper
  return {
    day: report.day,
    market: {
      regime: report.market.regime,
      btcDayPct: report.market.btcDayPct,
      ethDayPct: report.market.ethDayPct,
      breadthPct: report.market.breadthPct,
      pairsRead: report.market.pairsRead,
      moversUp: report.market.moversUp.map((mover) => ({ pair: mover.symbol, dayPct: mover.dayPct })),
      moversDown: report.market.moversDown.map((mover) => ({ pair: mover.symbol, dayPct: mover.dayPct }))
    },
    news: report.news.major.map((story) => ({ title: text(story.title), source: text(story.source), impact: story.impact, tickers: story.tickers.slice(0, 5), hourAfterPct: story.reactionH1Pct })),
    newsKept: report.news.kept,
    trades: {
      opened: paper.opened,
      ended: paper.ended,
      openNow: paper.open,
      net: paper.net.map((entry) => ({ asset: entry.asset, amount: Math.round(entry.amount * 100) / 100 })),
      r: Math.round(paper.r * 100) / 100,
      rTrades: paper.rTrades,
      bestPct: paper.bestPct,
      worstPct: paper.worstPct,
      refused: paper.refused.slice(0, 6).map((entry) => ({ reason: text(entry.reason), count: entry.count }))
    },
    calls: { made: report.session.calls.total, answered: report.session.calls.answered, valid: report.session.calls.valid, costUsd: Math.round(report.session.calls.costUsd * 10_000) / 10_000 },
    answers: report.session.answers,
    models: report.models.rows.map((row) => ({ model: text(row.model), closed: row.closed, netPctATrade: row.meanNetPct, profitFactor: row.profitFactor })),
    risk: {
      pausedWatch: report.risk.paused.watch,
      pausedNews: report.risk.paused.news,
      aiSpentUsd: Math.round(report.risk.aiSpentUsd * 10_000) / 10_000,
      aiCapUsd: report.risk.aiCapUsd,
      healthPauses: report.risk.healthPauses,
      highAlerts: report.risk.alertsHigh
    }
  }
}

/** One line of the report, for a notice or a card's head. */
export function describeDailyReport(report: DailyReport): string {
  const paper = report.session.paper
  const net = paper.net.map((entry) => `${entry.amount >= 0 ? '+' : ''}${entry.amount.toFixed(2)} ${entry.asset}`).join(', ')
  const btc = report.market.btcDayPct === null ? 'Bitcoin unread' : `Bitcoin ${report.market.btcDayPct >= 0 ? '+' : ''}${report.market.btcDayPct.toFixed(2)}%`
  return `${report.day}: ${btc}${report.market.regime === null ? '' : `, ${report.market.regime}`}; ${report.news.major.length} major ${report.news.major.length === 1 ? 'story' : 'stories'}; ${paper.opened} paper ${paper.opened === 1 ? 'trade' : 'trades'} opened, ${paper.ended} ended${net === '' ? '' : ` (${net})`}; ${report.session.alerts.high + report.session.alerts.critical} high alerts.`
}
