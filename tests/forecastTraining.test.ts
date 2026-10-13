import { describe, expect, it } from 'vitest'
import { FORECAST_MODELS } from '../shared/forecast/models'
import { OOS_VERSION, decodeOos, encodeOos, oosQuantiles, type OosRecord } from '../shared/forecast/oosRecord'
import { DEGRADATION_LINES, PROMOTION_LINES, degradationOf, degradedForecastNotice, promotionChecklist } from '../shared/forecast/promotion'
import { RUNS_KEPT, fitDueAtStart, healForecastSettings, nextNightlyAt, promotionsOf, runIdAt, runsToSweep } from '../shared/forecast/training'
import { FOLDS, HORIZON_STEP_SEC, MAX_VALIDATION_SHARE, finalSplit, foldRows, knownBefore, lastFoldScores, planFolds, rowsFor, scoreRows, type ModelScore } from '../shared/forecast/walkForward'
import { HORIZONS } from '../shared/forecast/features'
import { outcomeKnownAt } from '../shared/forecast/panel'
import type { Panel } from '../shared/forecast/panel'

// THE FORECAST'S TRAINING RULES (shared/forecast/{walkForward,promotion,training,oosRecord}.ts; the V6
// document, §51-53 and §104-105): a model judged only on weeks it was not fitted on, and fitted only on
// rows whose outcomes were known before the week began; promoted and degraded line by line; fitted at
// first and each night; its out-of-sample forecasts kept in columns.

const DAY = 86_400
const T0 = Date.parse('2026-08-01T00:00:00Z') / 1000

/** A panel of `days` days on the quarter-hour grid, one pair, outcomes known everywhere but the end. */
function panelOf(days: number): Panel {
  const rows = days * 96
  const time = Uint32Array.from({ length: rows }, (_, row) => T0 + row * 900)
  const y = (bars: number): Float32Array => Float32Array.from({ length: rows }, (_, row) => (T0 + row * 900 + bars * 300 <= T0 + rows * 900 ? 0.001 : Number.NaN))
  return {
    rows,
    cols: 1,
    x: new Float32Array(rows),
    time,
    pair: new Uint16Array(rows),
    cls: new Uint8Array(rows),
    regime: new Uint8Array(rows),
    rv24h: new Float32Array(rows).fill(0.03),
    y: { minutes5: y(1), minutes15: y(3), hour1: y(12), hours4: y(48), hours24: y(288) },
    best: { minutes5: y(1), minutes15: y(3), hour1: y(12), hours4: y(48), hours24: y(288) },
    worst: { minutes5: y(1), minutes15: y(3), hour1: y(12), hours4: y(48), hours24: y(288) },
    symbols: ['BTCUSDT']
  }
}

const score = (patch: Partial<ModelScore> = {}): ModelScore => ({ n: 6000, pinball: 0.3, coverage80: 0.8, coverage50: 0.5, direction: 0.51, bias: 0, width80: 2.5, ...patch })

describe('the rows a horizon learns from', () => {
  it('are on its grid and have an outcome', () => {
    const panel = panelOf(3)
    const hour = rowsFor(panel, 'hour1')
    expect([...hour].every((row) => panel.time[row] % 900 === 0 && !Number.isNaN(panel.y.hour1[row]))).toBe(true)
    // An hour's outcome is not there for the last eleven quarter-hours' rows... the grid's last rows go.
    expect(hour.length).toBe(panel.rows - 3)
    const day = rowsFor(panel, 'hours24')
    expect([...day].every((row) => panel.time[row] % 3600 === 0)).toBe(true)
  })

  it('are purged of any whose outcome reaches past the cutoff less the embargo', () => {
    const panel = panelOf(10)
    const rows = rowsFor(panel, 'hours4')
    const cutoff = T0 + 6 * DAY
    const kept = knownBefore(panel, rows, 'hours4', cutoff)
    expect(kept.length).toBeGreaterThan(0)
    expect([...kept].every((row) => panel.time[row] + 4 * 3600 <= cutoff - FOLDS.embargoSec)).toBe(true)
    // The last row before the cutoff whose outcome is in time is kept; the next is not.
    const latest = Math.max(...[...kept].map((row) => panel.time[row]))
    expect(latest).toBe(cutoff - FOLDS.embargoSec - 4 * 3600)
  })
})

describe('the folds', () => {
  it('are the last weeks, each tested on its own, oldest first, with a month of training before each', () => {
    const last = T0 + 64 * DAY - 900
    const folds = planFolds(T0, last)
    expect(folds).toHaveLength(FOLDS.folds)
    expect(folds[folds.length - 1].to).toBe(last + 1)
    for (let k = 1; k < folds.length; k++) expect(folds[k].from).toBe(folds[k - 1].to)
    expect(folds.every((fold) => fold.to - fold.from === 7 * DAY)).toBe(true)
    // With too little history before them, the older weeks are not tested.
    expect(planFolds(T0, T0 + 40 * DAY)).toHaveLength(1)
    expect(planFolds(T0, T0 + 20 * DAY)).toHaveLength(0)
  })

  it("split the final fit's rows into the last week and the rows before it, purged", () => {
    // Forty days: a week is under a fifth of them.
    const panel = panelOf(40)
    const rows = rowsFor(panel, 'hour1')
    const { train, valid } = finalSplit(panel, rows, 'hour1')
    const lastRow = panel.time[rows[rows.length - 1]]
    const cutoff = lastRow + 1 - 7 * DAY
    expect([...valid].every((row) => panel.time[row] >= cutoff)).toBe(true)
    expect([...train].every((row) => panel.time[row] + 3600 <= cutoff - FOLDS.embargoSec)).toBe(true)
    expect(train.length + valid.length).toBeLessThan(rows.length)
  })

  it('holds back no more than a fifth of a short history', () => {
    const panel = panelOf(8)
    const rows = rowsFor(panel, 'hour1')
    const { train, valid } = finalSplit(panel, rows, 'hour1')
    const span = panel.time[rows[rows.length - 1]] - panel.time[rows[0]]
    expect(panel.time[valid[0]] - panel.time[rows[0]]).toBeGreaterThanOrEqual(Math.floor(span * (1 - MAX_VALIDATION_SHARE)))
    expect(train.length).toBeGreaterThan(3 * valid.length)
  })
})

describe('a fold', () => {
  it('learns from no row whose outcome reaches its week, and tests every row read inside it, at every horizon', () => {
    const panel = panelOf(64)
    const folds = planFolds(panel.time[0], panel.time[panel.rows - 1])
    expect(folds.length).toBeGreaterThanOrEqual(2)
    for (const horizon of HORIZONS) {
      const rows = rowsFor(panel, horizon)
      for (const fold of folds) {
        const { train, valid, test } = foldRows(panel, rows, horizon, fold)
        expect(train.length, horizon).toBeGreaterThan(0)
        expect(valid.length, horizon).toBeGreaterThan(0)
        // Neither the rows fitted on nor those the boosting stops on know anything of the week.
        for (const row of [...train, ...valid]) expect(outcomeKnownAt(panel.time[row], horizon), horizon).toBeLessThanOrEqual(fold.from - FOLDS.embargoSec)
        // And the rows learned from end where the boosting's begin, less the time their outcomes take.
        expect(Math.max(...[...train].map((row) => panel.time[row]))).toBeLessThan(Math.min(...[...valid].map((row) => panel.time[row])))
        // Every row of the week on the horizon's grid is tested, and no other.
        expect([...test].every((row) => panel.time[row] >= fold.from && panel.time[row] < fold.to)).toBe(true)
        const inWeek = [...rows].filter((row) => panel.time[row] >= fold.from && panel.time[row] < fold.to)
        expect(test.length).toBe(inWeek.length)
        expect(test.length, horizon).toBeGreaterThan((0.8 * 7 * DAY) / HORIZON_STEP_SEC[horizon])
      }
    }
  })
})

describe('a score out of sample', () => {
  it('is the pinball, the coverages, the direction, the bias and the width', () => {
    const quantiles = [
      [-2, -1, 0.5, 1, 2],
      [-2, -1, -0.5, 1, 2],
      [-1, -0.5, 0, 0.5, 1]
    ]
    const outcomes = [1.5, -3, 0]
    const out = scoreRows(quantiles, outcomes)
    expect(out.n).toBe(3)
    expect(out.coverage80).toBeCloseTo(2 / 3)
    expect(out.coverage50).toBeCloseTo(1 / 3)
    // Of the two that moved, the first's median called its sign and the second's did too.
    expect(out.direction).toBeCloseTo(1)
    expect(out.bias).toBeCloseTo((1.5 - 0.5 + (-3 + 0.5) + 0) / 3)
    expect(out.width80).toBeCloseTo((4 + 4 + 2) / 3)
  })

  it('counts an outcome on an edge of an interval inside it, and one that did not move out of the direction', () => {
    const q = [-1, -0.5, 0.2, 0.5, 1]
    expect(scoreRows([q], [1]).coverage80).toBe(1)
    expect(scoreRows([q], [-1]).coverage80).toBe(1)
    expect(scoreRows([q], [0.5]).coverage50).toBe(1)
    expect(scoreRows([q], [-0.5]).coverage50).toBe(1)
    // The first did not move: only the second's sign is called, rightly.
    expect(scoreRows([q, q], [0, 0.4]).direction).toBe(1)
    // A median of zero calls no way: only the second forecast's call counts.
    expect(scoreRows([[-1, -0.5, 0, 0.5, 1], q], [0.3, 0.4]).direction).toBe(1)
  })
})

describe("the walk forward's last week", () => {
  it("is scored on the last fold tested alone, model by model, whatever the rows' order", () => {
    const wide = [-2, -1, 0, 1, 2]
    const narrow = [-0.2, -0.1, 0, 0.1, 0.2]
    // Weeks 0 and 1 held every outcome in both models' ranges; the last week, 2, held one in three
    // of the narrow model's.
    const tested = [
      { fold: 2, quantiles: { wide, narrow } },
      { fold: 0, quantiles: { wide, narrow } },
      { fold: 2, quantiles: { wide, narrow } },
      { fold: 1, quantiles: { wide, narrow } },
      { fold: 2, quantiles: { wide, narrow } }
    ]
    const z = [1.5, 0.05, -1, 0.1, 0.1]
    const last = lastFoldScores(tested, z, ['wide', 'narrow'] as const)
    expect(last.map((entry) => entry.model)).toEqual(['wide', 'narrow'])
    expect(last[0].score.n).toBe(3)
    expect(last[0].score.coverage80).toBe(1)
    expect(last[1].score.coverage80).toBeCloseTo(1 / 3)
    expect(last[1].score).toEqual(scoreRows([narrow, narrow, narrow], [1.5, -1, 0.1]))
    expect(lastFoldScores([], [], ['wide'] as const)[0].score.n).toBe(0)
  })
})

describe('promotion', () => {
  it('needs enough outcomes, an interval that held about 80%, and a loss under persistence', () => {
    const floor = score()
    expect(promotionChecklist(score({ pinball: 0.29 }), floor, null).promoted).toBe(true)
    expect(promotionChecklist(score({ pinball: 0.29, n: PROMOTION_LINES.minOutcomes - 1 }), floor, null).promoted).toBe(false)
    expect(promotionChecklist(score({ pinball: 0.29, coverage80: 0.86 }), floor, null).promoted).toBe(false)
    expect(promotionChecklist(score({ pinball: 0.29, coverage80: 0.75 }), floor, null).promoted).toBe(true)
    expect(promotionChecklist(score({ pinball: 0.3 }), floor, null).promoted).toBe(false)
  })

  it("waits for the trader's thirty trades without being blocked by them, and is blocked by a loss on them", () => {
    const floor = score()
    const pending = promotionChecklist(score({ pinball: 0.29 }), floor, { count: 12, net: -0.05 })
    expect(pending.promoted).toBe(true)
    expect(pending.lines.find((line) => line.id === 'trades')?.ok).toBeNull()
    expect(promotionChecklist(score({ pinball: 0.29 }), floor, { count: 30, net: -0.01 }).promoted).toBe(false)
    expect(promotionChecklist(score({ pinball: 0.29 }), floor, { count: 30, net: 0.01 }).promoted).toBe(true)
  })

  it('holds persistence as the floor and judges every other model against it, horizon by horizon', () => {
    const verdicts = promotionsOf([
      {
        horizon: 'hour1',
        scores: [
          { model: 'persistence', overall: score(), byClass: {} },
          { model: 'gbt', overall: score({ pinball: 0.28 }), byClass: {} },
          { model: 'technical', overall: score({ pinball: 0.31 }), byClass: {} }
        ]
      }
    ])
    expect(verdicts.map((verdict) => [verdict.model, verdict.promoted])).toEqual([
      ['persistence', true],
      ['gbt', true],
      ['technical', false]
    ])
  })
})

describe('degradation', () => {
  const floor = score()

  it('reads each way a week can go wrong', () => {
    expect(degradationOf(score(), floor, null)).toEqual({ degraded: false, reasons: [] })
    expect(degradationOf(score({ coverage80: 0.69 }), floor, null).reasons[0]).toMatch(/69.0%/)
    expect(degradationOf(score({ coverage80: 0.71 }), floor, null).degraded).toBe(false)
    expect(degradationOf(score({ pinball: 0.31 }), floor, null).reasons[0]).toMatch(/above persistence/)
    expect(degradationOf(score({ bias: -0.3 }), floor, null).reasons[0]).toMatch(/-0.30/)
    expect(degradationOf(score({ bias: 0.24 }), floor, null).degraded).toBe(false)
    expect(degradationOf(score(), floor, -0.02).reasons[0]).toMatch(/lost 2.00%/)
  })

  it('says nothing on a week with too few outcomes', () => {
    expect(degradationOf(score({ n: DEGRADATION_LINES.minOutcomes - 1, coverage80: 0.2 }), floor, -1).degraded).toBe(false)
  })

  it('is told on a thread of its own, saying nothing was switched off', () => {
    const notice = degradedForecastNotice('gbt', 'hour1', ['its 80% interval held 60.0% of the week\'s outcomes'])
    expect(notice.thread).toBe('degraded:forecast:gbt:hour1')
    expect(notice.title).toBe('Forecast model degraded: gbt, 1 hour')
    expect(notice.body).toMatch(/stays computed and on record/)
  })
})

describe('the schedule', () => {
  it('refits at half past midnight UTC, and at a start when the last fit is stale and the refit on', () => {
    expect(nextNightlyAt(Date.parse('2026-10-13T00:10:00Z') / 1000)).toBe(Date.parse('2026-10-13T00:30:00Z') / 1000)
    expect(nextNightlyAt(Date.parse('2026-10-13T00:30:00Z') / 1000)).toBe(Date.parse('2026-10-14T00:30:00Z') / 1000)
    const now = Date.parse('2026-10-13T12:00:00Z') / 1000
    expect(fitDueAtStart(null, now, { refitNightly: false })).toBe(true)
    expect(fitDueAtStart(now - 27 * 3600, now, { refitNightly: true })).toBe(true)
    expect(fitDueAtStart(now - 25 * 3600, now, { refitNightly: true })).toBe(false)
    expect(fitDueAtStart(now - 27 * 3600, now, { refitNightly: false })).toBe(false)
  })

  it('names a run by its minute, keeps the two newest and the one in use, and reads the setting as on unless off', () => {
    expect(runIdAt(Date.parse('2026-10-13T02:31:59Z') / 1000)).toBe('run-20261013-0231')
    expect(RUNS_KEPT).toBe(2)
    expect(runsToSweep(['run-20261010-0030', 'run-20261011-0030', 'run-20261012-0030', 'run-20261013-0030', 'current.json'], ['run-20261010-0030'])).toEqual(['run-20261011-0030'])
    expect(healForecastSettings(undefined)).toEqual({ refitNightly: true })
    expect(healForecastSettings({ refitNightly: 'no' })).toEqual({ refitNightly: true })
    expect(healForecastSettings({ refitNightly: false })).toEqual({ refitNightly: false })
  })
})

describe('the out-of-sample record', () => {
  const record: OosRecord = {
    version: OOS_VERSION,
    horizon: 'hours4',
    symbols: ['BTCUSDT', 'ETHUSDT'],
    models: FORECAST_MODELS,
    rows: 3,
    time: Uint32Array.from([T0, T0 + 3600, T0 + 7200]),
    pair: Uint16Array.from([0, 1, 0]),
    cls: Uint8Array.from([0, 1, 0]),
    regime: Uint8Array.from([5, 5, 3]),
    fold: Uint8Array.from([0, 0, 1]),
    z: Float32Array.from([0.5, -1.25, 2]),
    rv24h: Float32Array.from([0.02, 0.03, 0.02]),
    y: Float32Array.from([0.004, -0.01, 0.016]),
    best: Float32Array.from([0.006, 0.001, 0.02]),
    worst: Float32Array.from([-0.002, -0.012, -0.001]),
    quantiles: Float32Array.from({ length: 3 * FORECAST_MODELS.length * 5 }, (_, index) => index / 8)
  }

  it('reads back as written, column by column', () => {
    const back = decodeOos(encodeOos(record))
    expect(back).not.toBeNull()
    for (const key of ['time', 'pair', 'cls', 'regime', 'fold', 'z', 'rv24h', 'y', 'best', 'worst', 'quantiles'] as const) expect([...back![key]], key).toEqual([...record[key]])
    expect(back!.symbols).toEqual(record.symbols)
    expect(oosQuantiles(back!, 1, 'gbt')).toEqual([...record.quantiles.subarray((1 * FORECAST_MODELS.length + FORECAST_MODELS.indexOf('gbt')) * 5, (1 * FORECAST_MODELS.length + FORECAST_MODELS.indexOf('gbt')) * 5 + 5)])
  })

  it('is refused cut short, or with a header that is not its own', () => {
    const bytes = encodeOos(record)
    expect(decodeOos(bytes.subarray(0, bytes.length - 8))).toBeNull()
    expect(decodeOos(new Uint8Array(2))).toBeNull()
    const other = encodeOos({ ...record, version: 'other' as typeof OOS_VERSION })
    expect(decodeOos(other)).not.toBeNull()
    const text = new TextEncoder().encode(JSON.stringify({ version: 'forecast-oos-v0', horizon: 'hours4', symbols: [], models: [], rows: 0 }))
    const wrong = new Uint8Array(8 + text.length)
    new DataView(wrong.buffer).setUint32(0, text.length, true)
    wrong.set(text, 4)
    expect(decodeOos(wrong)).toBeNull()
  })
})
