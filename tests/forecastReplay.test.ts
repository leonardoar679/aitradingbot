import { describe, expect, it } from 'vitest'
import { FORECAST_BAR_SECONDS, type ForecastBar } from '../shared/forecast/bars'
import { HORIZONS, type Horizon } from '../shared/forecast/features'
import { EXCURSION_CALIBRATION_VERSION } from '../shared/forecast/firstTouch'
import type { FittedHorizon } from '../shared/forecast/models'
import type { OosRecord } from '../shared/forecast/oosRecord'
import { REPLAY_LINES, cellFiguresOf, forwardCalibrations, holdBaselinePct, labPositionParams, positionOutcomeOf, recordBefore, runReplay, type ReplaySegment, type ReplayTrade } from '../shared/forecast/replay'
import { buildRunCalibration, tradeableVerdictsOf, type RunCalibration } from '../shared/forecast/runCalibration'
import type { TradePlan } from '../shared/forecast/tradePlan'
import type { PositionExecutorParams } from '../shared/ipc'
import { simulatePosition } from '../src/executors/engine'
import { labPaperExecutor } from '../src/forecast/labTrader'
import type { LabTradeMark } from '../shared/forecast/labTrader'
import { promoted, recordOf } from './forecastRecords'
import { CALIBRATION, HOUR, MARKET, tinyFitted } from './forecastServiceFixture'

// THE REPLAY OUT OF SAMPLE (shared/forecast/replay.ts; V7.2-R Stage 5): a walk forward's weeks forecast again with
// each week's own models and a calibration from the weeks before it alone, through the forecast's pure pass, and the
// strategies played on the bars after each quarter-hour -- the same bytes every time, every line stamped with its
// sample, nothing read as P&L in sample, and the laboratory's trades filled as the paper engine fills them.

const seeded = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

describe("the laboratory's trades on the replay", () => {
  it('fill as the paper engine fills a Position, exit for exit and to the cent, on random bars and plans', () => {
    const random = seeded(7)
    const T = 1_800_000_000
    let closed = 0
    let expired = 0
    for (let run = 0; run < 400; run++) {
      let price = 100
      const bars: ForecastBar[] = Array.from({ length: 40 }, (_, k) => {
        const open = price
        price *= Math.exp(0.004 * (random() - 0.5) * 2)
        const high = Math.max(open, price) * (1 + 0.002 * random())
        const low = Math.min(open, price) * (1 - 0.002 * random())
        return { time: T + k * FORECAST_BAR_SECONDS, open, high, low, close: price, volume: 1, quoteVolume: price, takerBuyVolume: 0.5, trades: 1 }
      })
      // The zone about the price, or away from it often enough for entries to expire unfilled.
      const center = 100 * (1 + (random() < 0.3 ? 0.04 : 0.006) * (random() - 0.5))
      const half = 0.001 + 0.004 * random()
      const params: PositionExecutorParams = {
        side: random() < 0.5 ? 'buy' : 'sell',
        entryPrice: null,
        amountQuote: 1,
        takeProfitPct: random() < 0.15 ? null : 0.2 + 3 * random(),
        stopLossPct: random() < 0.15 ? null : 0.2 + 3 * random(),
        timeLimitSec: random() < 0.15 ? null : FORECAST_BAR_SECONDS * (1 + Math.floor(30 * random())),
        trailingStop: null,
        entryExpiresAt: random() < 0.2 ? null : T + FORECAST_BAR_SECONDS * (1 + Math.floor(10 * random())),
        entryRange: { min: center * (1 - half), max: center * (1 + half) },
        slippageRate: random() < 0.5 ? 0.0002 : 0.0005,
        feeRate: random() < 0.5 ? 0.001 : 0.002
      }
      const engine = simulatePosition(bars, params)
      const mine = positionOutcomeOf(params, bars, 0)
      if (engine.status !== 'closed') {
        expect(mine).toBeNull()
        continue
      }
      const exit = { stop_loss: 'stop', take_profit: 'target', time_limit: 'time', entry_expired: 'unfilled' }[engine.exitReason as string]
      expect(mine).not.toBeNull()
      expect(mine!.exit).toBe(exit)
      expect(mine!.netPct).toBeCloseTo((engine.realizedPnl as number) * 100, 10)
      if (exit === 'unfilled') {
        expired++
        expect(mine!.endedAt).toBe(engine.closedAt)
        continue
      }
      closed++
      expect(mine!.enteredAt).toBe(engine.enteredAt)
      expect(mine!.entryPrice).toBeCloseTo(engine.entryPrice as number, 10)
      expect(mine!.exitPrice).toBeCloseTo(engine.exitPrice as number, 10)
      expect(mine!.exitAt).toBe(engine.closedAt)
      expect(mine!.endedAt).toBe((engine.closedAt as number) + FORECAST_BAR_SECONDS)
    }
    // Enough of each kind to mean something.
    expect(closed).toBeGreaterThan(150)
    expect(expired).toBeGreaterThan(20)
  })

  it('call a bar that reached both the stop and the target a stop, as the engine does, on either side', () => {
    const T = 1_800_000_000
    const at = (k: number, open: number, high: number, low: number, close: number): ForecastBar => ({ time: T + k * FORECAST_BAR_SECONDS, open, high, low, close, volume: 1, quoteVolume: open, takerBuyVolume: 0.5, trades: 1 })
    const bars = [at(0, 100, 100.05, 99.95, 100), at(1, 100, 103, 97, 100), at(2, 100, 100.1, 99.9, 100)]
    for (const side of ['buy', 'sell'] as const) {
      const params: PositionExecutorParams = { side, entryPrice: null, amountQuote: 1, takeProfitPct: 2, stopLossPct: 2, timeLimitSec: 3600, trailingStop: null, entryExpiresAt: T + 600, entryRange: { min: 99.9, max: 100.1 }, slippageRate: 0.0002, feeRate: 0.001 }
      const engine = simulatePosition(bars, params)
      expect(engine.exitReason).toBe('stop_loss')
      const mine = positionOutcomeOf(params, bars, 0)!
      expect(mine.exit).toBe('stop')
      expect(mine.exitPrice).toBeCloseTo(engine.exitPrice as number, 10)
      expect(mine.netPct).toBeCloseTo((engine.realizedPnl as number) * 100, 10)
    }
  })

  it("are planned with the laboratory's own executor parameters", () => {
    const plan: TradePlan = { version: 'trade-plan-v1', pair: 'SOLUSDT', side: 'BUY', horizon: 'hour1', entryPrice: 100, entryMin: 99.9, entryMax: 100.1, stopPct: 1.2345, stopPrice: 98.77, targetPct: 2.3456, targetPrice: 102.35, targetLevel: 'P75', holdSec: 3600, validUntil: 1_800_000_300 }
    const mark = { strategy: 'strict', qualified: ['strict'] } as unknown as LabTradeMark
    const live = labPaperExecutor({ id: 'x', plan, mark, amountQuote: 500, nowSec: 1_800_000_000 }).params as PositionExecutorParams
    const replayed = labPositionParams(plan)
    for (const field of ['side', 'entryPrice', 'takeProfitPct', 'stopLossPct', 'timeLimitSec', 'entryExpiresAt', 'entryRange', 'slippageRate', 'feeRate'] as const) expect(replayed[field]).toEqual(live[field])
    const costed: TradePlan = { ...plan, cost: { venue: 'bitget', feePct: 0.2, spreadPct: 0.02, impactPct: 0.01, totalPct: 0.43, basis: 'book' } }
    const liveCosted = labPaperExecutor({ id: 'y', plan: costed, mark, amountQuote: 500, nowSec: 1_800_000_000 }).params as PositionExecutorParams
    expect(labPositionParams(costed).feeRate).toBe(liveCosted.feeRate)
    expect(labPositionParams(costed).slippageRate).toBe(liveCosted.slippageRate)
  })
})

describe("each week's calibration", () => {
  const records = new Map<Horizon, OosRecord>(HORIZONS.map((horizon, index) => [horizon, recordOf({ rows: 4000, seed: 90 + index, horizon })]))
  const promotions = HORIZONS.flatMap((horizon) => promoted(horizon, ['persistence', 'gbt']))

  it('keeps the rows of the weeks before it alone, every column', () => {
    const record = records.get('hour1')!
    const before = recordBefore(record, 2)
    const kept: number[] = []
    for (let row = 0; row < record.rows; row++) if (record.fold[row] < 2) kept.push(row)
    expect(before.rows).toBe(kept.length)
    expect(before.rows).toBeGreaterThan(0)
    expect(before.rows).toBeLessThan(record.rows)
    expect([...before.fold].every((week) => week < 2)).toBe(true)
    expect([...before.time]).toEqual(kept.map((row) => record.time[row]))
    expect([...before.z]).toEqual(kept.map((row) => record.z[row]))
    const width = record.models.length * 5
    expect(before.quantiles.length).toBe(kept.length * width)
    expect([...before.quantiles.slice(width, 2 * width)]).toEqual([...record.quantiles.slice(kept[1] * width, (kept[1] + 1) * width)])
    expect(recordBefore(record, 0).rows).toBe(0)
  })

  it('is made from the weeks before it alone: what came in its week or after changes nothing of it', () => {
    const made = forwardCalibrations(records, promotions, 'run-x', [0, 1, 2, 3])
    expect([...made.keys()]).toEqual([1, 2, 3])
    expect(made.get(2)!.runId).toBe('run-x#before-week-2')
    // Week 2's calibration as if built by hand from weeks 0 and 1, with week 1's verdicts as the run before's.
    const byHand = buildRunCalibration(new Map([...records].map(([horizon, record]) => [horizon, recordBefore(record, 2)])), promotions, 'run-x#before-week-2', undefined, undefined)
    expect(made.get(2)!.horizons.hour1!.variants.v2.cells).toEqual(byHand.horizons.hour1!.variants.v2.cells)
    // The outcomes of weeks 2 and 3 turned upside down: week 2's calibration is the same.
    const flipped = new Map<Horizon, OosRecord>()
    for (const [horizon, record] of records) flipped.set(horizon, { ...record, z: Float32Array.from(record.z, (z, row) => (record.fold[row] >= 2 ? -10 * z : z)) })
    const again = forwardCalibrations(flipped, promotions, 'run-x', [1, 2, 3])
    expect(again.get(2)).toEqual(made.get(2))
    expect(again.get(1)).toEqual(made.get(1))
    expect(again.get(3)).not.toEqual(made.get(3))
  })

  it("hands each week's direction verdicts on to the next week's, as a walk forward's go to the next", () => {
    const knowing = new Map<Horizon, OosRecord>(HORIZONS.map((horizon, index) => [horizon, recordOf({ rows: 8000, seed: 120 + index, horizon, direction: { 'dir-logistic': 0.6, 'dir-gbt': 0 } })]))
    const made = forwardCalibrations(knowing, promotions, 'run-d', [1, 2, 3])
    let read = 0
    for (const week of [2, 3]) {
      const handed = tradeableVerdictsOf(made.get(week - 1)!)
      for (const horizon of HORIZONS) {
        for (const model of ['dir-logistic', 'dir-gbt'] as const) {
          const mine = made.get(week)!.horizons[horizon]?.direction?.models[model]
          if (mine === undefined) continue
          read++
          expect(mine.tradeableBefore).toBe(handed[horizon]?.[model] ?? null)
        }
      }
    }
    expect(read).toBeGreaterThan(0)
    // The first week replayed has no walk forward before it.
    const first = made.get(1)!.horizons.hour1?.direction?.models['dir-logistic']
    if (first !== undefined) expect(first.tradeableBefore).toBeNull()
  })
})

/** The fixture's calibration with the path's levels: the likely low twice the excursion models' reading, under P10. */
const WITH_PATH: RunCalibration = {
  ...CALIBRATION,
  horizons: Object.fromEntries(
    Object.entries(CALIBRATION.horizons).map(([horizon, entry]) => [horizon, { ...entry!, excursion: { version: EXCURSION_CALIBRATION_VERSION, high: [1, 1, 1], low: [2, 2, 2], honest: { high: [0.5, 0.8, 0.9], low: [0.5, 0.8, 0.9], rawHigh: [0.5, 0.8, 0.9], rawLow: [0.5, 0.8, 0.9], n: 100 } } }])
  )
}
const MODELS = new Map<Horizon, FittedHorizon>(HORIZONS.map((horizon) => [horizon, tinyFitted(horizon)]))
const SEGMENTS: ReplaySegment[] = [
  { sample: 'out', label: 'a week out of sample', from: HOUR, to: HOUR + 2 * 3600, models: MODELS, calibration: WITH_PATH, runId: 'run-a/fold-1' },
  { sample: 'in', label: 'the final models', from: HOUR + 2 * 3600, to: HOUR + 3 * 3600, models: MODELS, calibration: WITH_PATH, runId: 'run-a' }
]

function replayed(): { lines: string[]; trades: ReplayTrade[]; summary: ReturnType<typeof runReplay>; kinds: Record<string, { t: number; sample: string }[]> } {
  const lines: string[] = []
  const trades: ReplayTrade[] = []
  const kinds: Record<string, { t: number; sample: string }[]> = { prediction: [], outcome: [], pass: [] }
  const summary = runReplay(
    { bars: MARKET, segments: SEGMENTS },
    {
      prediction: (line) => {
        lines.push(`p ${JSON.stringify(line)}`)
        kinds.prediction.push({ t: line.t, sample: line.sample })
      },
      outcome: (line) => {
        lines.push(`o ${JSON.stringify(line)}`)
        kinds.outcome.push({ t: line.t, sample: line.sample })
      },
      pass: (line) => {
        lines.push(`s ${JSON.stringify(line)}`)
        kinds.pass.push({ t: line.t, sample: line.sample })
      },
      trade: (trade) => {
        lines.push(`t ${JSON.stringify(trade)}`)
        trades.push(trade)
      }
    }
  )
  return { lines, trades, summary, kinds }
}

describe('the replay', () => {
  const first = replayed()

  it('writes the same lines twice over, byte for byte', () => {
    const second = replayed()
    expect(second.lines).toEqual(first.lines)
    expect(JSON.stringify(second.summary)).toBe(JSON.stringify(first.summary))
    expect(first.lines.length).toBeGreaterThan(100)
  })

  it('walks every close of its segments and a day after the last, settling, and records the quarter-hours', () => {
    expect(first.summary.closes).toBe((3 + 24) * 12 + 1)
    // Every pair at every quarter-hour of the three hours.
    expect(first.summary.forecasts).toBe(12 * MARKET.size)
    expect(first.kinds.prediction.every((line) => line.t % 900 === 0)).toBe(true)
    expect(first.summary.outcomes).toBe(first.kinds.outcome.length)
    // Every horizon recorded is owed and, the day after walked, settled.
    expect(first.kinds.outcome.length).toBe(MARKET.size * (12 * 3 + 3 * 2))
    expect(first.summary.segments.map((segment) => [segment.label, segment.sample, segment.calibrationRun])).toEqual([
      ['a week out of sample', 'out', CALIBRATION.runId],
      ['the final models', 'in', CALIBRATION.runId]
    ])
  })

  it("stamps every line with its segment's sample, an outcome with its forecast's", () => {
    const sampleOf = (t: number): string => (t < HOUR + 2 * 3600 ? 'out' : 'in')
    for (const kind of ['prediction', 'outcome', 'pass']) {
      expect(first.kinds[kind].length).toBeGreaterThan(0)
      expect(first.kinds[kind].every((line) => line.sample === sampleOf(line.t))).toBe(true)
    }
    expect(first.trades.every((trade) => trade.sample === sampleOf(trade.t))).toBe(true)
    expect(new Set(first.trades.map((trade) => trade.sample))).toEqual(new Set(['out', 'in']))
  })

  it('makes one order at a time a pair and a cell, each from a quarter-hour', () => {
    expect(first.trades.filter((trade) => trade.strategy === 'band').length).toBeGreaterThan(0)
    expect(first.trades.filter((trade) => trade.strategy === 'grid').length).toBeGreaterThan(0)
    const byCell = new Map<string, ReplayTrade[]>()
    for (const trade of first.trades) byCell.set(`${trade.cell}|${trade.pair}`, [...(byCell.get(`${trade.cell}|${trade.pair}`) ?? []), trade])
    for (const mine of byCell.values()) {
      for (let at = 1; at < mine.length; at++) expect(mine[at].t).toBeGreaterThanOrEqual(mine[at - 1].endedAt)
    }
    expect(first.trades.every((trade) => trade.t % 900 === 0)).toBe(true)
    // A band's baseline is the long held over its horizon from the order's close.
    const band = first.trades.find((trade) => trade.cell === 'band:hour1')!
    expect(band.baselinePct).toBeCloseTo(holdBaselinePct(MARKET.get(band.pair)!, band.t, band.t + 3600)!, 12)
    // Nothing calls a way on these models: the laboratory opens nothing.
    expect(first.trades.filter((trade) => trade.cell.startsWith('lab:'))).toEqual([])
  })

  it('reads no P&L in sample, and the out-of-sample cells by their line', () => {
    const inSample = first.summary.cells.filter((cell) => cell.sample === 'in')
    expect(inSample.length).toBeGreaterThan(0)
    for (const cell of inSample) expect(cell).toMatchObject({ verdict: 'in sample', net: null, wins: null, winRate: null, profitFactor: null, netSumPct: null, baseline: null, bestHoursShare: null })
    const out = first.summary.cells.filter((cell) => cell.sample === 'out')
    expect(out.map((cell) => cell.cell)).toEqual(['band:hour1', 'band:hours4', 'band:hours24', 'grid:hours24', 'lab:strict', 'lab:direction', 'lab:news', 'lab:hybrid'])
    // Too few trades for the line.
    expect(out.every((cell) => cell.verdict === 'not measured')).toBe(true)
    expect(first.summary.assumptions.length).toBeGreaterThan(3)
  })
})

describe("a strategy's baseline", () => {
  it("is the long bought at the open of the order's first bar and sold at its last bar's close, at market each way", () => {
    const bars: ForecastBar[] = [100, 101, 99, 102].map((close, k) => ({ time: 1_800_000_000 + k * 300, open: [99, 100, 101, 99][k], high: 103, low: 98, close, volume: 1, quoteVolume: close, takerBuyVolume: 0.5, trades: 1 }))
    const buy = 99 * 1.0002
    const sell = 102 * 0.9998
    expect(holdBaselinePct(bars, 1_800_000_000, 1_800_000_000 + 1200)).toBeCloseTo(((sell / buy) * 0.999 - 1 - 0.001) * 100, 12)
    expect(holdBaselinePct(bars, 1_800_000_000 + 300, 1_800_000_000 + 900)).toBeCloseTo(((99 * 0.9998) / (100 * 1.0002) * 0.999 - 1.001) * 100, 12)
    // The bars stop before the life ends: none.
    expect(holdBaselinePct(bars, 1_800_000_000, 1_800_000_000 + 1500)).toBeNull()
  })
})

describe("a cell's figures", () => {
  const trade = (k: number, net: number, overrides: Partial<ReplayTrade> = {}): ReplayTrade => ({
    cell: 'band:hour1',
    strategy: 'band',
    sample: 'out',
    pair: `P${k % 7}`,
    predictionId: `p${k}`,
    t: 1_800_000_000 + k * 3600,
    horizon: 'hour1',
    side: 'BUY',
    exit: net > 0 ? 'target' : 'stop',
    filledAt: 1_800_000_000 + k * 3600 + 600,
    fillPrice: 1,
    exitAt: 1_800_000_000 + k * 3600 + 1200,
    exitPrice: 1,
    grossPct: net + 0.2,
    costPct: 0.2,
    netPct: net,
    endedAt: 1_800_000_000 + k * 3600 + 1500,
    state: k % 2 === 0 ? 'CALM' : null,
    baselinePct: -0.1,
    ...overrides
  })

  it('holds its line on enough trades whose net is above zero beyond noise, and fails it where it is not', () => {
    const good = Array.from({ length: 240 }, (_, k) => trade(k, 0.5 + 0.1 * Math.sin(k)))
    const held = cellFiguresOf('band:hour1', 'band', 'hour1', 'out', good)
    expect(held.verdict).toBe('held')
    expect(held.net!.low).toBeGreaterThan(0)
    expect(held.trades).toBe(240)
    expect(held.winRate).toBe(1)
    expect(held.profitFactor).toBeNull()
    expect(held.meanCostPct).toBeCloseTo(0.2, 12)
    expect(held.baseline!.value).toBeCloseTo(-0.1, 12)
    expect(held.byState.CALM.trades + held.byState.unknown.trades).toBe(240)
    // A mean above zero inside the noise: the line reads the interval, not the point.
    const even = Array.from({ length: 240 }, (_, k) => trade(k, k % 2 === 0 ? 1.05 : -1))
    const failed = cellFiguresOf('band:hour1', 'band', 'hour1', 'out', even)
    expect(failed.net!.value).toBeGreaterThan(0)
    expect(failed.net!.low).toBeLessThan(0)
    expect(failed.verdict).toBe('failed')
    expect(failed.profitFactor).toBeCloseTo(1.05, 12)
    expect(failed.winRate).toBeCloseTo(0.5, 12)
    expect(failed.maxDrawdownPct).toBeGreaterThan(0)
  })

  it('is not measured on fewer trades than the line reads, unfilled orders not counted as trades', () => {
    const few = [...Array.from({ length: REPLAY_LINES.minTrades - 1 }, (_, k) => trade(k, 1)), ...Array.from({ length: 50 }, (_, k) => trade(200 + k, 0, { exit: 'unfilled', filledAt: null }))]
    const cell = cellFiguresOf('band:hour1', 'band', 'hour1', 'out', few)
    expect(cell).toMatchObject({ orders: REPLAY_LINES.minTrades + 49, trades: REPLAY_LINES.minTrades - 1, verdict: 'not measured' })
    expect(cell.byExit).toEqual({ target: REPLAY_LINES.minTrades - 1, unfilled: 50 })
    expect(cellFiguresOf('band:hour1', 'band', 'hour1', 'out', [...few, trade(400, 1)]).verdict).toBe('held')
  })

  it("tells the best hours' part of the net", () => {
    const trades = [...Array.from({ length: 100 }, (_, k) => trade(k, 0.1)), trade(100, 50)]
    const cell = cellFiguresOf('band:hour1', 'band', 'hour1', 'out', trades)
    // Six of 101 hours are the best 5%: the big one and five of the rest.
    expect(cell.bestHoursShare).toBeCloseTo((50 + 5 * 0.1) / (50 + 100 * 0.1), 12)
    expect(cellFiguresOf('band:hour1', 'band', 'hour1', 'out', [trade(1, -1)]).bestHoursShare).toBeNull()
  })

  it('refuses every P&L figure in sample', () => {
    const good = Array.from({ length: 240 }, (_, k) => trade(k, 0.5, { sample: 'in' }))
    expect(cellFiguresOf('band:hour1', 'band', 'hour1', 'in', good)).toMatchObject({ verdict: 'in sample', trades: 240, orders: 240, net: null, wins: null, netSumPct: null, baseline: null, byState: {} })
  })
})
