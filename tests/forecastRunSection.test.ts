import { describe, expect, it } from 'vitest'
import type { HorizonLine, MissingOutcomeLine, OutcomeLine, PredictionLine } from '../shared/forecast/forecastRecord'
import type { Horizon } from '../shared/forecast/features'
import { RUN_LINES, SAMPLE_NOTE, forecastRunSectionOf, horizonSeconds, type ForecastRunInput } from '../shared/forecast/runSection'
import { experimentReportOf } from '../shared/experimentRun'
import type { ExecutorConfig } from '../shared/ipc'

// THE PRICE FORECAST IN A RUN'S REPORT (shared/forecast/runSection.ts; the V6 document, §45-48 and
// §113-114; V6 Stage 15): what a run's span holds of the forecast's record, and its gates.

const T = Date.parse('2026-10-13T15:00:00Z') / 1000

const horizonLine = (patch: Partial<HorizonLine> = {}): HorizonLine => ({
  q: [-2, -1, 0.5, 2, 3],
  pUp: 0.55,
  dir: 'NEUTRAL',
  strong: false,
  uncertain: false,
  rel: 'HIGH',
  width: 5,
  usualWidth: 4,
  skill: 0.01,
  dirSkill: -0.01,
  cell: 'large',
  v1: [-2.2, -1.1, 0.4, 1.9, 2.9],
  v1pUp: 0.54,
  parts: [],
  ...patch
})

function prediction(id: string, t: number, patch: Partial<PredictionLine> = {}, horizons: Partial<Record<Horizon, HorizonLine>> = { minutes5: horizonLine(), minutes15: horizonLine(), hour1: horizonLine() }): PredictionLine {
  return { v: 'forecast-record-v1', id, pair: 'SOLUSDT', t, at: t * 1000 + 7000, price: 180, cls: 'large', regime: 'sideways', best: 'hour1', run: 'r', foldsRun: 'f', why: 'grid', h: horizons, ...patch }
}

function outcome(id: string, t: number, h: Horizon, move: number, patch: Partial<OutcomeLine> = {}): OutcomeLine {
  return { v: 'forecast-record-v1', id, pair: 'SOLUSDT', h, t, due: t + horizonSeconds(h), move, best: Math.max(0, move), worst: Math.min(0, move), below: '00110', v1below: '00110', in80: Math.abs(move) < 2, in50: Math.abs(move) < 1, up: move > 0, dir: 'NEUTRAL', pUp: 0.55, cell: 'large', cls: 'large', errors: [], ...patch }
}

const missing = (id: string, t: number, h: Horizon): MissingOutcomeLine => ({ v: 'forecast-record-v1', id, pair: 'SOLUSDT', h, t, due: t + horizonSeconds(h), missing: 'no bars' })

/** A run of an hour from T, the forecasts at its quarter-hours, every horizon due in it judged. */
function hourRun(patch: Partial<ForecastRunInput> = {}): ForecastRunInput {
  const predictions = [0, 900, 1800, 2700, 3600].map((offset) => prediction(`p${offset}`, T + offset))
  const outcomes: (OutcomeLine | MissingOutcomeLine)[] = []
  for (const line of predictions) {
    for (const h of ['minutes5', 'minutes15', 'hour1'] as Horizon[]) {
      if (line.t + horizonSeconds(h) + RUN_LINES.outcomeGraceSeconds <= T + 3600 + 1800) outcomes.push(outcome(line.id, line.t, h, 0.4))
    }
  }
  return { fromSec: T, toSec: T + 3600 + 1800, predictions, outcomes, executors: [], alerts: [{ at: T + 60, sound: 'information' }], ...patch }
}

describe('what a run holds of the forecast', () => {
  it('counts the forecasts and their closes, and judges each horizon from its outcomes', () => {
    const section = forecastRunSectionOf(hourRun())
    expect(section.predictions).toEqual({ lines: 5, pairs: 1, gridCloses: 5, expectedGridCloses: 7, refreshes: 0, byReason: {} })
    expect(Object.keys(section.horizons).sort()).toEqual(['hour1', 'minutes15', 'minutes5'])
    expect(section.horizons.minutes5?.outcomes).toBe(5)
    expect(section.horizons.hour1?.outcomes).toBe(2)
    expect(section.horizons.minutes5?.metrics.coverage80).toBe(1)
    // The half hour after the last forecast holds two closes with none: the span asks for them.
    expect(section.gates.find((gate) => gate.id === 'forecast_made')?.status).toBe('fail')
  })

  it("leaves out a forecast made outside the span, and an outcome of one", () => {
    const run = hourRun()
    const section = forecastRunSectionOf({ ...run, predictions: [...run.predictions, prediction('before', T - 900)], outcomes: [...run.outcomes, outcome('before', T - 900, 'minutes5', 3)] })
    expect(section.predictions.lines).toBe(5)
    expect(section.horizons.minutes5?.outcomes).toBe(5)
  })

  it('counts a BULLISH call right when it ended up, a BEARISH one when it ended down', () => {
    const run = hourRun()
    const outcomes = [
      outcome('p0', T, 'minutes5', 0.5, { dir: 'BULLISH' }),
      outcome('p900', T + 900, 'minutes5', -0.5, { dir: 'BULLISH' }),
      outcome('p1800', T + 1800, 'minutes5', -0.2, { dir: 'BEARISH' }),
      outcome('p2700', T + 2700, 'minutes5', 0, { dir: 'BEARISH' }),
      outcome('p3600', T + 3600, 'minutes5', 0, { dir: 'BULLISH' })
    ]
    const section = forecastRunSectionOf({ ...run, outcomes })
    // A close where it started is neither way's success.
    expect(section.horizons.minutes5?.bull).toEqual({ calls: 3, right: 1 })
    expect(section.horizons.minutes5?.bear).toEqual({ calls: 2, right: 1 })
  })

  it('counts the refreshes by their reasons', () => {
    const run = hourRun()
    const refresh = prediction('r1', T + 900, { why: 'refresh', reasons: ['NEWS', 'BAND'], previous: 'p900', at: (T + 1100) * 1000 })
    const section = forecastRunSectionOf({ ...run, predictions: [...run.predictions, refresh] })
    expect(section.predictions.refreshes).toBe(1)
    expect(section.predictions.byReason).toEqual({ NEWS: 1, BAND: 1 })
  })

  it("counts the forecast trader's trades and says a sample of under thirty proves nothing", () => {
    const trade = (id: string, openedAt: number, pnlQuote: number | null): ExecutorConfig =>
      ({
        id,
        symbol: `${id.toUpperCase()}USDT`,
        forecast: { predictionId: 'p0', barTime: openedAt - 60, openedAt, horizon: 'hour1', side: 'BUY', classKey: 'large/hour1/trend', verdict: 'PROBATION', quantilesPct: [], pUp: 0.6, edgePct: 0.3, pProfit: 0.6, plan: { entryMin: 1, entryMax: 1, stopPct: 1, targetPct: 1, targetLevel: 'P75', holdSec: 3600, validUntil: openedAt + 240 }, ...(pnlQuote === null ? {} : { result: { exit: 'take_profit', pnlQuote, closedAt: openedAt + 1800 } }) }
      }) as unknown as ExecutorConfig
    const section = forecastRunSectionOf(hourRun({ executors: [trade('a', T + 300, 1.5), trade('b', T + 600, -0.5), trade('c', T + 900, null), trade('old', T - 3600, 9)] }))
    // Without their stakes on record they add no fees or slippage; the best and the worst are named.
    expect(section.trades).toEqual({ opened: 3, closed: 2, wins: 1, netQuote: 1, feesQuote: 0, slippageQuote: 0, best: { pair: 'AUSDT', pnlQuote: 1.5 }, worst: { pair: 'BUSDT', pnlQuote: -0.5 } })
    expect(section.sampleNote).toBe(SAMPLE_NOTE)
    expect(SAMPLE_NOTE).toBe('Sample size is too small for a profitability conclusion.')
    expect(section.gates.find((gate) => gate.id === 'stale_trades')?.status).toBe('pass')
  })
})

describe("the run's forecast gates (§113-114)", () => {
  const gate = (input: ForecastRunInput, id: string): { status: string; detail: string } => forecastRunSectionOf(input).gates.find((entry) => entry.id === id)!

  it('wants forecasts at the quarter-hour closes, missing at most one', () => {
    expect(gate(hourRun(), 'forecast_made').status).toBe('fail')
    const full = hourRun({ toSec: T + 3600 })
    expect(gate(full, 'forecast_made')).toMatchObject({ status: 'pass' })
    const gap = { ...full, predictions: full.predictions.filter((line) => line.t !== T + 900 && line.t !== T + 1800) }
    expect(gate(gap, 'forecast_made').status).toBe('fail')
    expect(gate({ ...full, predictions: full.predictions.filter((line) => line.t !== T + 900) }, 'forecast_made').status).toBe('pass')
    expect(gate({ ...full, fromSec: T + 1, toSec: T + 800 }, 'forecast_made').status).toBe('not measured')
  })

  it('wants each forecast stamped with a close and made after it, in time', () => {
    const run = hourRun({ toSec: T + 3600 })
    expect(gate(run, 'forecast_stamped').status).toBe('pass')
    const late = { ...run, predictions: [...run.predictions.slice(1), prediction('late', T, { at: (T + RUN_LINES.madeWithinSeconds + 1) * 1000 })] }
    expect(gate(late, 'forecast_stamped').status).toBe('fail')
    const early = { ...run, predictions: [...run.predictions.slice(1), prediction('early', T, { at: (T - 1) * 1000 })] }
    expect(gate(early, 'forecast_stamped').status).toBe('fail')
    const offClose = { ...run, predictions: [...run.predictions.slice(1), prediction('odd', T + 60, { at: (T + 70) * 1000 })] }
    expect(gate(offClose, 'forecast_stamped').status).toBe('fail')
    const refresh = { ...run, predictions: [...run.predictions, prediction('r', T + 900, { why: 'refresh', reasons: ['NEWS'], previous: 'p900', at: (T + 1100) * 1000 })] }
    expect(gate(refresh, 'forecast_stamped').status).toBe('pass')
    const staleRefresh = { ...run, predictions: [...run.predictions, prediction('r', T + 900, { why: 'refresh', reasons: ['NEWS'], previous: 'p900', at: (T + 1600) * 1000 })] }
    expect(gate(staleRefresh, 'forecast_stamped').status).toBe('fail')
  })

  it('wants a refresh to name its reason and what it replaced, and measures none without one', () => {
    const run = hourRun({ toSec: T + 3600 })
    expect(gate(run, 'forecast_refresh').status).toBe('not measured')
    const linked = { ...run, predictions: [...run.predictions, prediction('r', T + 900, { why: 'refresh', reasons: ['SCANNER'], previous: 'p900', at: (T + 1000) * 1000 })] }
    expect(gate(linked, 'forecast_refresh').status).toBe('pass')
    const unlinked = { ...run, predictions: [...run.predictions, prediction('r', T + 900, { why: 'refresh', reasons: ['SCANNER'], at: (T + 1000) * 1000 })] }
    expect(gate(unlinked, 'forecast_refresh').status).toBe('fail')
    const reasonless = { ...run, predictions: [...run.predictions, prediction('r', T + 900, { why: 'refresh', reasons: [], previous: 'p900', at: (T + 1000) * 1000 })] }
    expect(gate(reasonless, 'forecast_refresh').status).toBe('fail')
  })

  it('wants every horizon due in the span, with time to write it, judged; a line saying why one could not be counts', () => {
    const run = hourRun()
    expect(gate(run, 'forecast_outcomes').status).toBe('pass')
    const without = { ...run, outcomes: run.outcomes.filter((line) => !(line.id === 'p0' && line.h === 'hour1')) }
    // Within the engine's hour for its bars, an outcome not written waits; past it, it is missing.
    expect(gate(without, 'forecast_outcomes')).toMatchObject({ status: 'pass' })
    expect(gate(without, 'forecast_outcomes').detail).toContain('1 more waits for bars')
    const anHourOn = T + 3600 + RUN_LINES.missingAfterSeconds + RUN_LINES.outcomeGraceSeconds
    expect(gate({ ...without, asOfSec: anHourOn - 1 }, 'forecast_outcomes').status).toBe('pass')
    expect(gate({ ...without, asOfSec: anHourOn }, 'forecast_outcomes')).toMatchObject({ status: 'fail' })
    const explained = { ...without, outcomes: [...without.outcomes, missing('p0', T, 'hour1')], asOfSec: anHourOn }
    expect(gate(explained, 'forecast_outcomes')).toMatchObject({ status: 'pass' })
    expect(gate(explained, 'forecast_outcomes').detail).toContain('1 of them a line saying why')
    // A horizon due after the span, or too near its end to be written yet, is not wanted.
    expect(gate({ ...run, toSec: T + 300 + RUN_LINES.outcomeGraceSeconds - 1, outcomes: [] }, 'forecast_outcomes').status).toBe('not measured')
  })

  it('wants, read an hour on, the hours of the forecasts too', () => {
    const run = hourRun({ toSec: T + 3600 })
    const later = T + 3600 + 3600 + RUN_LINES.missingAfterSeconds + RUN_LINES.outcomeGraceSeconds
    // As the run ends, an hour's horizon of its forecasts is not due; read an hour on, each is.
    const atEnd = forecastRunSectionOf(run).gates.find((gate) => gate.id === 'forecast_outcomes')!
    const onFile = run.outcomes.length
    expect(atEnd.status).toBe('pass')
    const asOf = forecastRunSectionOf({ ...run, asOfSec: later }).gates.find((gate) => gate.id === 'forecast_outcomes')!
    expect(asOf.status).toBe('fail')
    const hours = run.predictions.map((line) => outcome(line.id, line.t, 'hour1', 0.2))
    const judged = forecastRunSectionOf({ ...run, outcomes: [...run.outcomes.filter((line) => line.h !== 'hour1'), ...hours], asOfSec: later })
    expect(judged.gates.find((gate) => gate.id === 'forecast_outcomes')!.status).toBe('pass')
    expect(onFile).toBeGreaterThan(0)
    // A moment before the span's end reads as its end.
    expect(forecastRunSectionOf({ ...run, asOfSec: T }).gates.find((gate) => gate.id === 'forecast_outcomes')!.status).toBe('pass')
  })

  it("wants every notice's sound on file", () => {
    expect(gate(hourRun(), 'notice_sounds').status).toBe('pass')
    expect(gate(hourRun({ alerts: [{ at: T + 60, sound: 'warning' }, { at: T + 120 }] }), 'notice_sounds').status).toBe('fail')
    expect(gate(hourRun({ alerts: [{ at: T - 60 }] }), 'notice_sounds').status).toBe('not measured')
  })

  it('wants no trade on a forecast two closes old, or past its plan', () => {
    const trade = (barTime: number, openedAt: number, validUntil: number): ExecutorConfig =>
      ({ id: 'x', forecast: { predictionId: 'p', barTime, openedAt, horizon: 'hour1', side: 'BUY', classKey: 'k', verdict: 'APPROVED', quantilesPct: [], pUp: 0.6, edgePct: 0.3, pProfit: 0.6, plan: { entryMin: 1, entryMax: 1, stopPct: 1, targetPct: 1, targetLevel: 'P75', holdSec: 3600, validUntil } } }) as unknown as ExecutorConfig
    expect(gate(hourRun(), 'stale_trades').status).toBe('not measured')
    expect(gate(hourRun({ executors: [trade(T + 300, T + 300 + RUN_LINES.staleTradeSeconds, T + 1200)] }), 'stale_trades').status).toBe('pass')
    expect(gate(hourRun({ executors: [trade(T + 300, T + 301 + RUN_LINES.staleTradeSeconds, T + 1200)] }), 'stale_trades').status).toBe('fail')
    expect(gate(hourRun({ executors: [trade(T + 300, T + 400, T + 399)] }), 'stale_trades').status).toBe('fail')
  })

  it('fails the run on a failed gate and never on one not measured', () => {
    expect(forecastRunSectionOf(hourRun({ toSec: T + 3600 })).passed).toBe(true)
    expect(forecastRunSectionOf(hourRun({ alerts: [{ at: T + 60 }] })).passed).toBe(false)
  })
})

describe("the experiment's report", () => {
  it('carries the forecast and fails on its gates, and stays as it was without it', () => {
    const session = { passed: true, paper: { fees: [] }, calls: { costUsd: 0 } } as never
    const sessionInput = { fromSec: T, toSec: T + 3600, calls: [], executors: [], connection: null } as never
    const without = experimentReportOf({ session, sessionInput, help: [] })
    expect('forecast' in without).toBe(false)
    expect(without.passed).toBe(true)
    const good = forecastRunSectionOf(hourRun({ toSec: T + 3600 }))
    expect(experimentReportOf({ session, sessionInput, help: [], forecast: good })).toMatchObject({ forecast: good, passed: true })
    const bad = forecastRunSectionOf(hourRun({ alerts: [{ at: T + 60 }] }))
    expect(experimentReportOf({ session, sessionInput, help: [], forecast: bad }).passed).toBe(false)
  })
})

describe("the twelve-hour run's report (§48-49, §114)", () => {
  const gate = (input: ForecastRunInput, id: string): { status: string; detail: string } => forecastRunSectionOf(input).gates.find((entry) => entry.id === id)!

  it('counts the calls at each forecast\'s lead horizon, and its coin\'s class', () => {
    const run = hourRun({ toSec: T + 3600 })
    const predictions = [
      prediction('a', T, {}, { hour1: horizonLine({ dir: 'BULLISH' }) }),
      prediction('b', T + 900, { cls: 'btc' }, { hour1: horizonLine({ dir: 'BULLISH', strong: true }) }),
      prediction('c', T + 1800, {}, { hour1: horizonLine({ uncertain: true }) }),
      prediction('d', T + 2700, { best: 'minutes15' }, { minutes15: horizonLine({ dir: 'BEARISH' }), hour1: horizonLine({ dir: 'BULLISH' }) }),
      prediction('e', T + 3600, { best: null }, { hour1: horizonLine() })
    ]
    const section = forecastRunSectionOf({ ...run, predictions, outcomes: [] })
    expect(section.classes.calls).toEqual({ BULLISH: 1, 'STRONG BULLISH': 1, UNCERTAIN: 1, BEARISH: 1, NEUTRAL: 1 })
    expect(section.classes.pairClasses).toEqual({ large: 4, btc: 1 })
  })

  it('lists the best-rated forecasts, and the best and worst called once judged', () => {
    const run = hourRun({ toSec: T + 3600 })
    const predictions = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((k) => prediction(`q${k}`, T + (k % 5) * 900, { pair: `P${k}USDT` }, { hour1: horizonLine({ qual: 40 + k }) }))
    const outcomes = predictions.slice(0, 8).map((line, k) => outcome(line.id, line.t, 'hour1', 0.5 + (k - 4) * 0.25))
    const section = forecastRunSectionOf({ ...run, predictions, outcomes })
    expect(section.top.map((row) => row.quality)).toEqual([51, 50, 49, 48, 47, 46, 45, 44, 43, 42])
    expect(section.top[0]).toMatchObject({ pair: 'P11USDT', horizon: 'hour1', call: 'NEUTRAL', medianPct: 0.5, movePct: null, in80: null })
    // The median is 0.5: the move nearest it is the best called, the farthest the worst; a tie goes to
    // the earlier forecast.
    expect(section.best.map((row) => row.pair)).toEqual(['P4USDT', 'P5USDT', 'P3USDT', 'P6USDT', 'P2USDT'])
    expect(section.worst.map((row) => row.pair)).toEqual(['P0USDT', 'P7USDT', 'P1USDT', 'P2USDT', 'P6USDT'])
    expect(section.best[0].movePct).toBe(0.5)
  })

  it('carries the four variants on the same moments (§49)', () => {
    const section = forecastRunSectionOf(hourRun())
    const hour = section.horizons.minutes5!
    expect(Object.keys(hour.variants).sort()).toEqual(['v1', 'v2', 'v3', 'v4'])
    expect(hour.variants.v4).toEqual(hour.metrics)
    expect(hour.variants.v1.n).toBe(hour.metrics.n)
  })

  it("counts the forecast trades' fees and slippage, their best and worst", () => {
    const trade = (id: string, symbol: string, pnlQuote: number, exit = 'take_profit'): ExecutorConfig =>
      ({
        id,
        symbol,
        status: 'stopped',
        params: { amountQuote: 100, slippageRate: 0.0005 },
        forecast: { predictionId: 'p0', barTime: T + 240, openedAt: T + 300, horizon: 'hour1', side: 'BUY', classKey: 'k', verdict: 'PROBATION', quantilesPct: [-2, -1, 0.5, 2, 3], pUp: 0.6, edgePct: 0.3, pProfit: 0.6, plan: { entryMin: 1, entryMax: 1, stopPct: 1, targetPct: 1, targetLevel: 'P75', holdSec: 3600, validUntil: T + 540 }, result: { exit, pnlQuote, closedAt: T + 1800 } }
      }) as unknown as ExecutorConfig
    const section = forecastRunSectionOf(hourRun({ executors: [trade('a', 'SOLUSDT', 2), trade('b', 'ETHUSDT', -1), trade('c', 'BTCUSDT', 0, 'entry_expired')] }))
    expect(section.trades).toMatchObject({ opened: 3, closed: 3, wins: 1, netQuote: 1, best: { pair: 'SOLUSDT', pnlQuote: 2 }, worst: { pair: 'ETHUSDT', pnlQuote: -1 } })
    // Two that entered: a fee of 0.1% on each fill, and the slippage the engine charges each.
    expect(section.trades.feesQuote).toBeCloseTo(2 * 100 * 0.001 * 2, 10)
    expect(section.trades.slippageQuote).toBeCloseTo(2 * 100 * 2 * 0.0005, 10)
    expect(gate(hourRun({ executors: [trade('a', 'SOLUSDT', 2)] }), 'trades_whole').status).toBe('pass')
  })

  it('wants every pair at every quarter-hour close between its first and its last (history complete)', () => {
    const run = hourRun({ toSec: T + 3600 })
    const two = [0, 900, 1800, 2700].flatMap((offset) => [prediction(`s${offset}`, T + offset), prediction(`e${offset}`, T + offset, { pair: 'ETHUSDT' })])
    expect(gate({ ...run, predictions: two }, 'forecast_history').status).toBe('pass')
    // ETH from the second close on: a pair joining the universe is no hole.
    expect(gate({ ...run, predictions: two.filter((line) => line.id !== 'e0') }, 'forecast_history').status).toBe('pass')
    expect(gate({ ...run, predictions: two.filter((line) => line.id !== 'e900') }, 'forecast_history')).toMatchObject({ status: 'fail' })
    expect(gate({ ...run, predictions: [] }, 'forecast_history').status).toBe('not measured')
  })

  it('wants every forecast to name its model run and its calibration', () => {
    const run = hourRun({ toSec: T + 3600 })
    expect(gate(run, 'forecast_calibrated').status).toBe('pass')
    expect(gate({ ...run, predictions: [...run.predictions, prediction('x', T + 900, { foldsRun: '' })] }, 'forecast_calibrated').status).toBe('fail')
    expect(gate({ ...run, predictions: [...run.predictions, prediction('x', T + 900, { run: 'none' })] }, 'forecast_calibrated').status).toBe('fail')
  })

  it('wants every story naming a traded coin measured to four hours once it has had them (news correlation complete)', () => {
    const run = hourRun({ toSec: T + 3600 })
    const asOf = T + 3600 + RUN_LINES.storySeconds
    const stories = [
      { id: 'a', publishedAt: T + 60, tradable: true },
      { id: 'b', publishedAt: T + 120, tradable: false },
      { id: 'c', publishedAt: T + 3500, tradable: true },
      { id: 'old', publishedAt: T - 60, tradable: true }
    ]
    expect(gate(run, 'news_reactions').status).toBe('not measured')
    expect(gate({ ...run, stories, reactions: {} }, 'news_reactions').status).toBe('not measured')
    expect(gate({ ...run, stories, reactions: { a: { after: { h4: 1.2 } } }, asOfSec: T + 60 + RUN_LINES.storySeconds }, 'news_reactions').status).toBe('pass')
    expect(gate({ ...run, stories, reactions: { a: { after: { h4: 1.2 } } }, asOfSec: asOf }, 'news_reactions')).toMatchObject({ status: 'fail' })
    expect(gate({ ...run, stories, reactions: { a: { after: { h4: 1.2 } }, c: { after: { h4: null } } }, asOfSec: asOf }, 'news_reactions').status).toBe('fail')
    expect(gate({ ...run, stories, reactions: { a: { after: { h4: 1.2 } }, c: { after: { h4: -0.4 } } }, asOfSec: asOf }, 'news_reactions').status).toBe('pass')
  })

  it("wants every forecast trade's record whole: its forecast, levels and plan, and once stopped its end", () => {
    const mark = { predictionId: 'p0', barTime: T + 240, openedAt: T + 300, horizon: 'hour1', side: 'BUY', classKey: 'k', verdict: 'APPROVED', quantilesPct: [-2, -1, 0.5, 2, 3], pUp: 0.6, edgePct: 0.3, pProfit: 0.6, plan: { entryMin: 1, entryMax: 1, stopPct: 1, targetPct: 1, targetLevel: 'P75', holdSec: 3600, validUntil: T + 540 } }
    const of = (patch: Record<string, unknown>, status = 'active'): ExecutorConfig => ({ id: 'x', symbol: 'SOLUSDT', status, params: { amountQuote: 100 }, forecast: { ...mark, ...patch } }) as unknown as ExecutorConfig
    expect(gate(hourRun({ executors: [of({})] }), 'trades_whole').status).toBe('pass')
    expect(gate(hourRun({ executors: [of({}, 'stopped')] }), 'trades_whole').status).toBe('fail')
    expect(gate(hourRun({ executors: [of({ result: { exit: 'stop_loss', pnlQuote: -1, closedAt: T + 900 } }, 'stopped')] }), 'trades_whole').status).toBe('pass')
    expect(gate(hourRun({ executors: [of({ predictionId: '' })] }), 'trades_whole').status).toBe('fail')
    expect(gate(hourRun({ executors: [of({ quantilesPct: [1, 2, 3] })] }), 'trades_whole').status).toBe('fail')
  })
})
