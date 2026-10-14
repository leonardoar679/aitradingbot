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
        forecast: { predictionId: 'p0', barTime: openedAt - 60, openedAt, horizon: 'hour1', side: 'BUY', classKey: 'large/hour1/trend', verdict: 'PROBATION', quantilesPct: [], pUp: 0.6, edgePct: 0.3, pProfit: 0.6, plan: { entryMin: 1, entryMax: 1, stopPct: 1, targetPct: 1, targetLevel: 'P75', holdSec: 3600, validUntil: openedAt + 240 }, ...(pnlQuote === null ? {} : { result: { exit: 'take_profit', pnlQuote, closedAt: openedAt + 1800 } }) }
      }) as unknown as ExecutorConfig
    const section = forecastRunSectionOf(hourRun({ executors: [trade('a', T + 300, 1.5), trade('b', T + 600, -0.5), trade('c', T + 900, null), trade('old', T - 3600, 9)] }))
    expect(section.trades).toEqual({ opened: 3, closed: 2, wins: 1, netQuote: 1 })
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
    expect(gate(without, 'forecast_outcomes')).toMatchObject({ status: 'fail' })
    const explained = { ...without, outcomes: [...without.outcomes, missing('p0', T, 'hour1')] }
    expect(gate(explained, 'forecast_outcomes')).toMatchObject({ status: 'pass' })
    expect(gate(explained, 'forecast_outcomes').detail).toContain('1 of them a line saying why')
    // A horizon due after the span, or too near its end to be written yet, is not wanted.
    expect(gate({ ...run, toSec: T + 300 + RUN_LINES.outcomeGraceSeconds - 1, outcomes: [] }, 'forecast_outcomes').status).toBe('not measured')
  })

  it('wants, read an hour on, the hours of the forecasts too', () => {
    const run = hourRun({ toSec: T + 3600 })
    const later = T + 3600 + 3600 + RUN_LINES.outcomeGraceSeconds
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
