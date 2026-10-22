import { describe, expect, it } from 'vitest'
import { coarseBars } from '../shared/forecast/bars'
import { BLOCKS_V3_LINES, CROSS_NAMES, FLOW_NAMES, POSITIONING_NAMES, permuteColumns, positioningAt, widenPanel, type PairPositioning } from '../shared/forecast/blocksV3'
import { FEATURE_NAMES, type PairSeries } from '../shared/forecast/features'
import { buildPanel } from '../shared/forecast/panel'
import { HOUR, MARKET } from './forecastServiceFixture'

// NEW INFORMATION FOR THE WAY, AS BLOCKS (shared/forecast/blocksV3.ts; V7.2-R Stage 7): the columns appended to a
// research panel's own rows, read only from what was known at each row's moment, neutral where they cannot be read.

// The pairs' bars, with the hours the panel's features read built once from them.
const series = new Map<string, PairSeries>([...MARKET].map(([symbol, m5]) => [symbol, { m5, h1: coarseBars(m5, '1h', Number.POSITIVE_INFINITY) }]))
const panel = buildPanel(series, { stepSec: 3600, fromSec: HOUR, toSec: HOUR + 6 * 3600 })

describe('a panel widened by the blocks', () => {
  it('keeps its own rows and figures, and appends each block in order', () => {
    const wide = widenPanel(panel, series, ['cross', 'flow'])
    expect(wide.rows).toBe(panel.rows)
    expect(wide.cols).toBe(panel.cols + CROSS_NAMES.length + FLOW_NAMES.length)
    expect(panel.cols).toBe(FEATURE_NAMES.length)
    for (let row = 0; row < panel.rows; row++) {
      for (let col = 0; col < panel.cols; col++) expect(wide.x[row * wide.cols + col]).toBe(panel.x[row * panel.cols + col])
    }
    expect([...wide.time]).toEqual([...panel.time])
    // Ranks are shares of the other pairs, dispersion and breadth shared by every row of a moment.
    const at = (row: number, name: string): number => wide.x[row * wide.cols + panel.cols + [...CROSS_NAMES, ...FLOW_NAMES].indexOf(name)]
    for (let row = 0; row < panel.rows; row++) {
      expect(at(row, 'xs_rank_24h')).toBeGreaterThanOrEqual(0)
      expect(at(row, 'xs_rank_24h')).toBeLessThanOrEqual(1)
      expect(Math.abs(at(row, 'taker_15m'))).toBeLessThanOrEqual(0.5)
    }
    const first = [...Array(panel.rows).keys()].filter((row) => panel.time[row] === panel.time[0])
    expect(new Set(first.map((row) => at(row, 'xs_disp_15m'))).size).toBe(1)
    expect(new Set(first.map((row) => at(row, 'market_taker_15m'))).size).toBe(1)
    // The ranks of a moment spread from 0 to 1 across its pairs.
    const ranks = first.map((row) => at(row, 'xs_rank_1h')).sort()
    expect(ranks[0]).toBe(0)
    expect(ranks[ranks.length - 1]).toBe(1)
  })

  it('reads positioning only where a pair has it, neutral with has_perp 0 elsewhere', () => {
    const t0 = panel.time[0]
    // Five-minute rows from a week before the panel's first hour to past its last.
    const metrics = Array.from({ length: 12 * 24 * 8 + 12 * 8 }, (_, k) => [t0 - 8 * 86_400 + k * 300, 1000 * (1 + k / 1e4), 1e6, 1.2, 1.1 + (k % 7) / 100, 1.3, 1.05])
    const data: PairPositioning = { metrics, premium: metrics.map((row) => [row[0], 0, 0, 0, 0.0002]), funding: [[t0 - 3600, 0.0001, 8]] }
    const wide = widenPanel(panel, series, ['positioning'], new Map([['SOLUSDT', data]]))
    const perp = wide.cols - 1
    for (let row = 0; row < panel.rows; row++) {
      const has = wide.x[row * wide.cols + perp]
      expect(has).toBe(panel.symbols[panel.pair[row]] === 'SOLUSDT' ? 1 : 0)
      if (has === 0) for (let k = 0; k < POSITIONING_NAMES.length; k++) expect(wide.x[row * wide.cols + panel.cols + k]).toBe(0)
    }
  })
})

describe('positioning at a moment', () => {
  const t = 1_800_000_000
  const rows = (until: number): number[][] => Array.from({ length: 12 * 24 * 8 }, (_, k) => [until - (12 * 24 * 8 - 1 - k) * 300, 1000 + k, 1e6, 1.2, 1.1, k === 12 * 24 * 8 - 1 ? 2.6 : 1.3, 1.1])
  const data = (until: number): PairPositioning => ({ metrics: rows(until), premium: rows(until).map((row) => [row[0], 0, 0, 0, row[0] === until - 300 ? 0.002 : 0.001]), funding: [[t - 7200, 0.0003, 8], [t + 60, 0.009, 8]] })

  it('reads only rows stamped ten minutes or more before it, changes and deviations alone', () => {
    // The rows run to the moment itself: those of its last ten minutes are not read.
    const read = positioningAt(data(t), t, 0.01)!
    expect(read).toHaveLength(POSITIONING_NAMES.length)
    const at = (name: string): number => read[POSITIONING_NAMES.indexOf(name as never)]
    const lastRead = 12 * 24 * 8 - 1 - BLOCKS_V3_LINES.positioningLagSec / 300
    expect(at('oi_chg_15m')).toBeCloseTo(Math.log((1000 + lastRead) / (1000 + lastRead - 3)), 12)
    expect(at('oi_chg_1h')).toBeCloseTo(Math.log((1000 + lastRead) / (1000 + lastRead - 12)), 12)
    expect(at('oi_x_price')).toBeCloseTo(at('oi_chg_1h'), 12)
    // The account ratio's spike in the last row is after the cut: not read.
    expect(at('lsr_acc_dev')).toBeCloseTo(0, 12)
    // The funding settled before the moment, not the one after it.
    expect(at('funding_last')).toBe(0.0003)
    expect(at('has_perp')).toBe(1)
    expect(positioningAt(data(t), t, -0.01)![POSITIONING_NAMES.indexOf('oi_x_price')]).toBeCloseTo(-at('oi_chg_1h'), 12)
  })

  it('is nothing where the last row it may read is over half an hour old, or there is none', () => {
    expect(positioningAt(data(t - 3600), t, 0)).toBeNull()
    expect(positioningAt(data(t - BLOCKS_V3_LINES.positioningLagSec - BLOCKS_V3_LINES.positioningStaleSec + 300), t, 0)).not.toBeNull()
    expect(positioningAt({ metrics: [], premium: [], funding: [] }, t, 0)).toBeNull()
  })
})

describe('the permuted control', () => {
  it("shuffles the block's columns across the rows, the same each time, and leaves the rest", () => {
    const wide = widenPanel(panel, series, ['cross'])
    const shuffled = permuteColumns(wide, panel.cols, 7)
    const again = permuteColumns(wide, panel.cols, 7)
    expect([...shuffled.x]).toEqual([...again.x])
    for (let row = 0; row < wide.rows; row++) for (let col = 0; col < panel.cols; col++) expect(shuffled.x[row * wide.cols + col]).toBe(wide.x[row * wide.cols + col])
    const column = (made: typeof wide, col: number): number[] => Array.from({ length: made.rows }, (_, row) => made.x[row * made.cols + col]).sort((a, b) => a - b)
    for (let col = panel.cols; col < wide.cols; col++) expect(column(shuffled, col)).toEqual(column(wide, col))
  })
})
