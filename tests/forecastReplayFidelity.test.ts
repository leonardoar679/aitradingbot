import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AciTable } from '../shared/forecast/aciTable'
import { FIDELITY_LINES, levelsAgree, replayFidelity } from '../shared/forecast/fidelity'
import { HORIZONS, PAIR_CLASSES, type Horizon } from '../shared/forecast/features'
import { isMissing, parseOutcomeLine, parsePassLine, parsePredictionLine, type PassLine, type PredictionLine } from '../shared/forecast/forecastRecord'
import type { FittedHorizon } from '../shared/forecast/models'
import { CALIBRATION, MARKET, tinyFitted } from './forecastServiceFixture'

// REPLAY FIDELITY (shared/forecast/fidelity.ts; V7.2 Stage 5): a record the live forecast service made
// BEFORE its pass was moved into pure functions (tests/fixtures/forecastReplay/, 37 five-minute closes of
// the service's four fixture pairs with an event and a band refresh each hour, made at commit 25bc9bb by a
// generator since deleted), replayed through the pure pass from the same bars, models and calibration, must
// give the same V2 levels to four decimals on every line: the regression test of the move. And what does not
// replay is listed with its reason.

const FIXTURE = join(__dirname, 'fixtures', 'forecastReplay')
const rows = (name: string): unknown[] =>
  readFileSync(join(FIXTURE, name), 'utf-8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
const predictions = rows('predictions-2026-08.jsonl').map(parsePredictionLine).filter((line): line is PredictionLine => line !== null)
const passes = rows('passes-2026-08.jsonl').map(parsePassLine).filter((line): line is PassLine => line !== null)
const models = new Map<Horizon, FittedHorizon>(HORIZONS.map((horizon) => [horizon, tinyFitted(horizon)]))
const input = () => ({ bars: MARKET, models, calibration: CALIBRATION, runId: 'run-models', predictions, passes })

describe('the replay of a recorded run', () => {
  it('reads the fixture whole: grid forecasts and refreshes, and the passes', () => {
    expect(predictions).toHaveLength(58)
    expect(predictions.filter((line) => line.why === 'grid')).toHaveLength(52)
    expect(predictions.filter((line) => line.why === 'refresh').map((line) => line.reasons)).toEqual([['event'], ['band'], ['event'], ['band'], ['event'], ['band']])
    expect(passes).toHaveLength(13)
  })

  it('replays the record made before the pass moved to four decimals on every line, the states and P(up) too', () => {
    const closes: number[] = []
    const report = replayFidelity({ ...input(), onClose: (closedAt) => closes.push(closedAt) })
    expect(report.closes).toBe(37)
    expect(closes).toHaveLength(37)
    // 52 grid forecasts: the short three horizons at every quarter-hour, all five on the hour (4 hours x 4 pairs).
    expect(report.lines).toBe(52 * 3 + 16 * 2)
    expect(report.matched).toBe(report.lines)
    expect(report.share).toBe(1)
    expect(report.passed).toBe(true)
    expect(report.remainders).toEqual([])
    expect(report.byReason).toEqual({ 'not replayed': 0, 'bars differ': 0, 'cell differs': 0, 'levels differ': 0 })
    for (const horizon of HORIZONS) {
      const mine = report.byHorizon[horizon]!
      expect(mine.matched).toBe(mine.lines)
      expect(mine.pUpMatched).toBe(mine.lines)
    }
    expect(report.states).toEqual({ lines: 52, matched: 52 })
    expect(report.from).toBe(predictions[0].t)
    expect(report.to).toBe(predictions[predictions.length - 1].t)
  })

  it('compares a span alone while walking the closes before it, so that the levels move as they did', () => {
    const from = predictions[0].t + 7200
    const report = replayFidelity({ ...input(), from })
    expect(report.closes).toBe(37)
    // Five quarter-hours from two hours in to three, two of them on the hour.
    expect(report.lines).toBe(5 * 3 * 4 + 2 * 2 * 4)
    expect(report.matched).toBe(report.lines)
  })

  it('lists what does not replay with its reason: the levels, the bars, a horizon not forecast', () => {
    // The adaptive levels began elsewhere: every hour line differs, the rest not.
    const aci: AciTable = { calibrationRun: CALIBRATION.runId, levels: Object.fromEntries([...PAIR_CLASSES, 'pooled'].map((cell) => [`hour1/v2/${cell}`, [0.02, 0.25, 0.5, 0.75, 0.98]])), updatedAt: 0 }
    const moved = replayFidelity({ ...input(), aci })
    expect(moved.byReason['levels differ']).toBe(52)
    expect(moved.remainders.every((entry) => entry.horizon === 'hour1' && entry.reason === 'levels differ' && entry.maxDiff !== null && entry.maxDiff > 10 ** -FIDELITY_LINES.decimals)).toBe(true)
    expect(moved.share).toBeCloseTo((moved.lines - 52) / moved.lines, 6)
    expect(moved.passed).toBe(false)
    // Ether's bars changed since the record: its forecasts are from other bars.
    const bars = new Map(MARKET)
    bars.set(
      'ETHUSDT',
      MARKET.get('ETHUSDT')!.map((bar, index) => {
        const k = 1 + 0.002 * Math.sin(index / 7)
        return { ...bar, open: bar.open * k, high: bar.high * k, low: bar.low * k, close: bar.close * k }
      })
    )
    const changed = replayFidelity({ ...input(), bars })
    expect(changed.byReason['bars differ']).toBeGreaterThan(0)
    expect(changed.remainders.filter((entry) => entry.reason === 'bars differ').every((entry) => entry.pair === 'ETHUSDT')).toBe(true)
    // A horizon the models do not hold is not replayed.
    const fewer = new Map(models)
    fewer.delete('hours24')
    const missing = replayFidelity({ ...input(), models: fewer })
    expect(missing.byReason['not replayed']).toBe(16)
    expect(missing.remainders.every((entry) => entry.horizon === 'hours24' && entry.maxDiff === null)).toBe(true)
    expect(missing.byHorizon.hours24).toEqual({ lines: 16, matched: 0, pUpMatched: 0 })
  })

  it("settles an outcome at the close the record says it was settled at, so that the levels take the live run's steps", () => {
    const outcomes = rows('outcomes-2026-08.jsonl').map(parseOutcomeLine).filter((line): line is NonNullable<typeof line> => line !== null)
    expect(outcomes.length).toBeGreaterThan(100)
    // The fixture's outcomes carry no moment (made before): nothing changes.
    expect(replayFidelity({ ...input(), outcomes }).matched).toBe(52 * 3 + 16 * 2)
    // The grid forecasts' hour outcomes said settled a close late, the refreshes' on time (so that the late ones
    // join the refreshes' batch five minutes on): the hour's levels then differ from the record's, the rest not.
    const grid = new Set(predictions.filter((line) => line.why === 'grid').map((line) => line.id))
    const late = outcomes.map((line) => (isMissing(line) || line.h !== 'hour1' || !grid.has(line.id) ? line : { ...line, at: line.due + 300 }))
    const moved = replayFidelity({ ...input(), outcomes: late })
    expect(moved.byReason['levels differ']).toBeGreaterThan(0)
    expect(moved.remainders.every((entry) => entry.horizon === 'hour1')).toBe(true)
    expect(moved.byHorizon.minutes15!.matched).toBe(52)
    // The moment the record says is the moment the replay settles at: the same as a source naming that close
    // itself, and another than a source naming the close after.
    const named = replayFidelity({ ...input(), settleAt: (line, horizon, due) => (horizon === 'hour1' && line.why === 'grid' ? due + 300 : due) })
    expect(named.matched).toBe(moved.matched)
    expect(named.remainders).toEqual(moved.remainders)
    expect(named.aci).toEqual(moved.aci)
    const later = replayFidelity({ ...input(), settleAt: (line, horizon, due) => (horizon === 'hour1' && line.why === 'grid' ? due + 600 : due) })
    expect(later.aci).not.toEqual(moved.aci)
    // A moment at the due itself, or before it, is the due.
    const onTime = outcomes.map((line) => (isMissing(line) ? line : { ...line, at: line.due }))
    expect(replayFidelity({ ...input(), outcomes: onTime }).matched).toBe(52 * 3 + 16 * 2)
  })

  it('calls levels agreeing within one unit of the fourth decimal, and not beyond', () => {
    expect(levelsAgree([1.2345, -0.5], [1.2345, -0.5])).toBe(true)
    expect(levelsAgree([1.2345, -0.5], [1.2346, -0.5001])).toBe(true)
    expect(levelsAgree([1.2345, -0.5], [1.2347, -0.5])).toBe(false)
    expect(levelsAgree([1.2345, -0.5], [1.2345, -0.5002])).toBe(false)
    expect(levelsAgree([1.2345], [1.2345, 0])).toBe(false)
    expect(levelsAgree([1.23], [1.24], 2)).toBe(true)
    expect(levelsAgree([1.23], [1.25], 2)).toBe(false)
  })

  it('is empty on no record', () => {
    const report = replayFidelity({ ...input(), predictions: [] })
    expect(report).toMatchObject({ closes: 0, lines: 0, matched: 0, share: 0, passed: false, remainders: [] })
  })
})
