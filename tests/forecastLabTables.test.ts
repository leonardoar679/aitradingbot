import { describe, expect, it } from 'vitest'
import { ROUND_TRIP_PCT } from '../shared/forecast/edge'
import { labMetrics, traderStats, type LabCase, type LabTrade, type LeaderRow } from '../shared/forecast/lab'
import { LAB_VERSION } from '../shared/forecast/lab'
import type { LabFile } from '../shared/forecast/labFile'
import type { LabHorizon } from '../shared/forecast/labWalkForward'
import type { Candle } from '../shared/ipc'
import { QUANTS } from '../src/agents/quantState'
import { calibrationTable, classesOf, leaderTable, performanceTable, tableCsv, traderTable } from '../src/forecastLab/labTables'
import { buyAndHold, hybridTrades, runComparison } from '../src/forecastLab/strategyComparison'

// THE FORECAST LAB'S TABLES AND ITS COMPARISON (src/forecastLab/; V6 Stage 11): each card's rows from
// the Lab's figures, the CSV a table saves, buy and hold over the span, the hybrid keeping the forecast's
// trades where a strategy's state agreed, and a comparison run on bars whose trend is known.

const T = Date.parse('2026-10-01T00:00:00Z') / 1000

const entry = (move: number): LabCase => ({ pair: 'SOLUSDT', t: T, horizon: 'hour1', cls: 'large', q: [-2, -1, 0.5, 2, 3], dir: 'NEUTRAL', pUp: 0.5, uncertain: false, width: 5, usualWidth: 4, move, best: 0, worst: 0 })

function horizonLab(): LabHorizon {
  const metrics = labMetrics([entry(1), entry(-3)])
  const stats = traderStats([])
  return {
    rows: 2,
    weeks: [1, 2, 3],
    variants: { v1: { pooled: metrics, byClass: { large: metrics }, pUpCurve: [] }, v2: { pooled: metrics, byClass: { large: metrics, mid: metrics }, pUpCurve: [{ predicted: 0.52, observed: 0.5, n: 2 }] } },
    events: { all: metrics },
    drift: { shocks: 0, overReacting: 0, underReacting: 0 },
    trader: { rules: stats, medians: stats },
    trades: { rules: [], medians: [] }
  }
}

const lab: LabFile = { version: LAB_VERSION, runId: 'run-x', madeAt: T, span: { from: T, to: T + 86_400 }, pairs: ['SOLUSDT'], horizons: { hour1: horizonLab(), hours4: horizonLab() } }

describe('the tables', () => {
  it('reads each horizon\'s two variants, for every coin or one class', () => {
    const table = performanceTable(lab, 'pooled')
    expect(table.rows.map((row) => `${row[0]} ${row[1]}`)).toEqual(['1h V1 price only', '1h V2 + technical (shown)', '4h V1 price only', '4h V2 + technical (shown)'])
    expect(table.rows[0].slice(2, 8)).toEqual([2, '50.0%', 0, '—', '50.0%', '50.0%'])
    // A class without outcomes at a variant reads as dashes.
    expect(performanceTable(lab, 'mid').rows[0].slice(2)).toEqual(table.headers.slice(2).map(() => '—'))
    expect(classesOf(lab)).toEqual(['pooled', 'large', 'mid'])
    // Moves of +1 and -3 against -2, -1, 0.5, 2, 3: -3 under every level, +1 under P75 and P90.
    expect(calibrationTable(lab).rows[0]).toEqual(['1h', '50.0%', '50.0%', '50.0%', '100.0%', '100.0%', '50.0%', '0.0%'])
    expect(traderTable(lab).rows.map((row) => row[1])).toEqual(['As the rules stand', 'On the median alone (research)', 'As the rules stand', 'On the median alone (research)'])
  })

  it('calls persistence the floor and a model its last week found worse DEGRADED', () => {
    const row = (model: LeaderRow['model'], degraded: boolean): LeaderRow => ({ horizon: 'hour1', model, n: 10, pinball: 0.4, skill: 0.01, coverage80: 0.8, direction: 0.5, weight: 0.5, promoted: true, degraded, lines: [] })
    const table = leaderTable([row('persistence', false), row('gbt', true)])
    expect(table.rows.map((cells) => [cells[1], cells[4], cells[9]])).toEqual([
      ['persistence', 'the floor', 'within its lines'],
      ['gbt', '1.00%', 'DEGRADED']
    ])
  })

  it('saves a table as CSV, quoting what needs it', () => {
    expect(tableCsv({ headers: ['A', 'B, with a comma'], rows: [['say "hi"', 1]] })).toBe('A,"B, with a comma"\n"say ""hi""",1')
  })
})

/** Four-hour bars from `from`, rising or falling a percent a bar. */
function trend(from: number, count: number, step: number, seconds = 14_400): Candle[] {
  return Array.from({ length: count }, (_, k) => {
    const close = 100 * Math.pow(1 + step, k)
    return { time: from + k * seconds, open: close / (1 + step), high: close * 1.002, low: (close / (1 + step)) * 0.998, close, volume: 10 }
  })
}

describe('the comparison', () => {
  it('buys and holds over the span, a round trip a pair', () => {
    const bars = trend(T - 86_400, 30, 0.01)
    const hold = buyAndHold('SOLUSDT', bars, { from: T, to: T + 4 * 14_400 })!
    const inside = bars.filter((bar) => bar.time >= T && bar.time <= T + 4 * 14_400)
    expect(hold.grossPct).toBeCloseTo((inside[inside.length - 1].close / inside[0].close - 1) * 100, 9)
    expect(hold.netPct).toBeCloseTo(hold.grossPct - ROUND_TRIP_PCT, 12)
    expect(buyAndHold('SOLUSDT', bars.slice(0, 1), { from: T - 86_400, to: T })).toBeNull()
  })

  it('keeps the forecast\'s trades where the strategy\'s state was on their side', () => {
    const warm = QUANTS.trend4h.warmupBars + 20
    const rising = trend(T - warm * 14_400, warm + 10, 0.01)
    const falling = trend(T - warm * 14_400, warm + 10, -0.01)
    const trade = (pair: string, side: 'BUY' | 'SELL'): LabTrade => ({ pair, t: T, horizon: 'hour1', side, exit: 'close', grossPct: 1, netPct: 1 - ROUND_TRIP_PCT })
    const bars = new Map([
      ['UPUSDT', rising],
      ['DOWNUSDT', falling]
    ])
    const kept = hybridTrades([trade('UPUSDT', 'BUY'), trade('UPUSDT', 'SELL'), trade('DOWNUSDT', 'BUY'), trade('DOWNUSDT', 'SELL'), trade('NOBARSUSDT', 'BUY')], bars, 'trend4h')
    expect(kept.map((one) => `${one.pair} ${one.side}`)).toEqual(['UPUSDT BUY', 'DOWNUSDT SELL'])
  })

  it('runs every row on bars on file, the strategies their own backtests', async () => {
    const span = { from: T, to: T + 10 * 86_400 }
    const asked: string[] = []
    const fetchBars = async (pair: string, width: '15m' | '4h', fromSec: number, toSec: number): Promise<Candle[]> => {
      asked.push(`${pair}:${width}`)
      const seconds = width === '4h' ? 14_400 : 900
      const from = Math.floor(fromSec / seconds) * seconds
      return trend(from, Math.floor((toSec - from) / seconds), width === '4h' ? 0.004 : 0.0001, seconds)
    }
    const progress: number[] = []
    const result = await runComparison(['AUSDT', 'BUSDT'], span, { rules: [], medians: [] }, fetchBars, { onProgress: (done) => progress.push(done) })
    expect(progress).toEqual([1, 2])
    expect(asked).toEqual(['AUSDT:4h', 'AUSDT:15m', 'BUSDT:4h', 'BUSDT:15m'])
    // Both warm-ups are on file before the span: the window is the span, every pair in it.
    expect(result.window).toEqual(span)
    expect(result.pairs).toEqual(['AUSDT', 'BUSDT'])
    const rows = result.rows
    expect(rows.map((row) => row.name)).toEqual([
      'Trend Regime 4h (its own backtest)',
      'Short-Term Channel 15m (its own backtest)',
      'Buy and hold, a round trip a pair',
      'The forecast trader, as the rules stand',
      'The forecast trader on the median alone (research)',
      "Hybrid: the rules' trades where Trend Regime 4h agreed",
      "Hybrid: the median's trades where Trend Regime 4h agreed (research)",
      "Hybrid: the rules' trades where Short-Term Channel 15m agreed",
      "Hybrid: the median's trades where Short-Term Channel 15m agreed (research)"
    ])
    // Two pairs held over a rising span.
    expect(rows[2].stats.trades).toBe(2)
    expect(rows[2].stats.netPct).toBeGreaterThan(0)
    expect(rows[3].stats.trades).toBe(0)
  })

  it('reads every row from where the warm-ups have passed on the bars on file, leaving out a pair too young for it', async () => {
    const span = { from: T, to: T + 30 * 86_400 }
    // The files begin 100 days before the span's end: Trend Regime's 80 days run out 10 days into the span.
    const filesFrom = span.to - 100 * 86_400
    const fetchBars = async (pair: string, width: '15m' | '4h', fromSec: number, toSec: number): Promise<Candle[]> => {
      const seconds = width === '4h' ? 14_400 : 900
      const from = Math.max(Math.floor(fromSec / seconds) * seconds, pair === 'YOUNGUSDT' ? span.to - 20 * 86_400 : filesFrom)
      return trend(from, Math.floor((toSec - from) / seconds), width === '4h' ? 0.004 : 0.0001, seconds)
    }
    const at = (t: number): LabTrade => ({ pair: 'BTCUSDT', t, horizon: 'hour1', side: 'BUY', exit: 'close', grossPct: 1, netPct: 1 - ROUND_TRIP_PCT })
    const result = await runComparison(['BTCUSDT', 'YOUNGUSDT'], span, { rules: [], medians: [at(T + 86_400), at(span.to - 86_400)] }, fetchBars)
    const warm = QUANTS.trend4h.warmupBars * 14_400
    expect(result.window).toEqual({ from: filesFrom + warm, to: span.to })
    expect(result.pairs).toEqual(['BTCUSDT'])
    expect(result.left).toEqual(['YOUNGUSDT'])
    // The median trader's trade before the window is cut; the one in it is kept.
    expect(result.rows[4].stats.trades).toBe(1)
    expect(result.rows[2].stats.trades).toBe(1)
  })
})
