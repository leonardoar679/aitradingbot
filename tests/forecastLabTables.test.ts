import { describe, expect, it } from 'vitest'
import { ROUND_TRIP_PCT } from '../shared/forecast/edge'
import { labMetrics, traderStats, type LabCase, type LabTrade, type LeaderRow } from '../shared/forecast/lab'
import { LAB_VERSION } from '../shared/forecast/lab'
import type { LabFile } from '../shared/forecast/labFile'
import type { LabHorizon } from '../shared/forecast/labWalkForward'
import type { Candle } from '../shared/ipc'
import { QUANTS } from '../src/agents/quantState'
import { ablationTable, byHourTable, calibrationTable, classesOf, impactTable, leaderTable, marketShockTable, nextReleasesTable, outOfSampleTable, performanceTable, releasesTable, shockTable, tableCsv, traderTable } from '../src/forecastLab/labTables'
import { cellFiguresOf, type ReplayTrade } from '../shared/forecast/replay'
import type { AblationFile } from '../shared/forecast/ablation'
import type { ByHourReport } from '../shared/forecast/byHour'
import { EVENT_IMPACT } from '../shared/calendar/eventImpact'
import { noShockRecord } from '../shared/forecast/shock'
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
  it('reads the forecast by the hour it was made at, and what a block of figures added (V7.2 Stage 4)', () => {
    const cell = (n: number, coverage80: number): ByHourReport['hours'][number]['pooled'] => ({ n, coverage80, coverage50: 0.5, pinball: 0.25, dispersion: 1, missesInShock: null })
    const band = (hour: number, failing: boolean): ByHourReport['hours'][number] => ({ hour, pooled: cell(40, failing ? 0.6 : 0.8), halves: [cell(10, 0.6), cell(10, 0.6), null, cell(10, 0.6)], failing })
    const report: ByHourReport = { version: 'by-hour-v1', horizon: 'hour1', rows: 80, preEventOut: 0, firstWeeks: [1, 2], hours: [band(0, false), band(14, true), { ...band(23, false), pooled: cell(0, Number.NaN) }], weekdays: [], failing: [14] }
    const withHours: LabFile = { ...lab, horizons: { hour1: { ...horizonLab(), byHour: report } } }
    const table = byHourTable(withHours)
    expect(table.headers.slice(0, 3)).toEqual(['Horizon', 'UTC hour', 'Outcomes'])
    expect(table.rows.map((row) => row[1])).toEqual(['00:00', '14:00'])
    expect(table.rows[1].slice(2, 8)).toEqual([40, '60.0%', '50.0%', '0.2500', '1.00', '—'])
    expect(table.rows[1].slice(8)).toEqual(['60% of 10', '60% of 10', '—', '60% of 10', 'FAILING'])
    expect(table.rows[0][12]).toBe('within the line')
    expect(byHourTable(lab).rows).toEqual([])
    const figure = { difference: -0.0021, low: -0.003, high: -0.001, better: true, worse: false }
    const file: AblationFile = { version: 'ablation-v1', horizon: 'hour1', block: 'clock', madeAt: T, rows: 1000, paired: { hours: 400, blocks: 400, pinball: figure, coverageDistance: { ...figure, better: false }, directionSkill: null }, control: { hours: 400, blocks: 400, pinball: { difference: 0.0001, low: -0.0005, high: 0.0007, better: false, worse: false }, coverageDistance: figure, directionSkill: null }, seconds: 300 }
    const ablations = ablationTable([file, { ...file, block: 'market', paired: null, control: null }])
    expect(ablations.rows[0].slice(0, 2)).toEqual(['1h', 'clock'])
    expect(ablations.rows[0][4]).toBe('400 (400)')
    expect(ablations.rows[0][5]).toBe('+0.0021 (+0.0010–+0.0030)')
    expect(ablations.rows[0][6]).toBe('+0.21 (+0.10–+0.30)')
    expect(ablations.rows[0][7]).toBe('—')
    expect(ablations.rows[0][8]).toBe('-0.0001 (-0.0007–+0.0005)')
    expect(ablations.rows[0][9]).toBe('the block helped beyond noise and the floor')
    expect(ablations.rows[1].slice(4)).toEqual(['—', '—', '—', '—', '—', 'nothing to pair'])
  })

  it('reads each horizon\'s two variants, for every coin or one class', () => {
    const table = performanceTable(lab, 'pooled')
    expect(table.rows.map((row) => `${row[0]} ${row[1]}`)).toEqual(['1h V1 price only', '1h V2 + technical (shown)', '4h V1 price only', '4h V2 + technical (shown)'])
    // Two cases of one hour: a point without an interval, no independent outcomes or blocks to say (V7.2 Stage 1).
    expect(table.rows[0].slice(2, 10)).toEqual([2, '—', '—', '50.0%', 0, '—', '50.0%', '50.0%'])
    expect(table.headers.slice(2, 5)).toEqual(['Outcomes', 'Independent outcomes', 'Blocks resampled'])
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

  // V6.1: the rule on Bitcoin's sharp moves at each horizon, whether it is in use and why not, and what it
  // widened live.
  it("says the rule on Bitcoin's sharp moves at each horizon, why one is not in use, and what it widened live", () => {
    const adopted = { ...noShockRecord(), adopted: true, refusal: null, k80: 1.434, k50: 1.41, moments: 14, rows: 561, before: { in80: 0.633, in50: 0.33, pinball: 0.4193 }, after: { in80: 0.793, in50: 0.494, pinball: 0.408 } }
    const widened = labMetrics([entry(1), entry(-3)])
    const table = shockTable(
      { hour1: adopted, minutes5: { ...adopted, adopted: false, refusal: 'pinball' }, hours4: { ...noShockRecord(), refusal: 'too_few', moments: 3, rows: 90 }, hours24: noShockRecord() },
      { from: T, to: T, horizons: { hour1: { outcomes: 2, variants: { v1: widened, v2: widened, v3: widened, v4: widened }, news: { moved: widened, unmoved: widened }, shock: { widened, unwidened: labMetrics([entry(-3)]) } } }, events: {}, drift: { shocks: 0, overReacting: 0, underReacting: 0, refreshes: 0, byReason: {}, meanChangePct: null } }
    )
    expect(table.rows.map((row) => row[0])).toEqual(['5m', '1h', '4h', '24h'])
    expect(table.rows[1]).toEqual(['1h', 14, 561, '63.3%', '79.3%', '0.4193', '0.4080', 'x1.43 / x1.41', 'yes', 2, '50.0%', '0.0%'])
    expect(table.rows[0][8]).toBe('no: widening made the pinball loss worse')
    expect(table.rows[0][9]).toBe(0)
    expect(table.rows[2].slice(3, 9)).toEqual(['—', '—', '—', '—', '—', 'no: too few moments past the line to fit from'])
    expect(table.rows[3][8]).toMatch(/^no: no record of Bitcoin's moves/)
  })

  // V7.1 Stage 11: the rules by market state at each horizon, the horizon's choice, and the live record's
  // forecasts in each state.
  it("says each market state's rule, whether the horizon widens by the states' rules, and the live forecasts in each state", () => {
    const adopted = { ...noShockRecord(), adopted: true, refusal: null, k80: 1.3, k50: 1.1, moments: 20, rows: 400, before: { in80: 0.7, in50: 0.4, pinball: 0.45 }, after: { in80: 0.81, in50: 0.5, pinball: 0.44 } }
    const rules = { version: 'market-shock-v1', byState: { RECOVERY: adopted, POST_EVENT_SHOCK: { ...adopted, adopted: false, refusal: 'pinball' as const } }, compared: { rows: 900, before: { in80: 0.62, in50: 0.36, pinball: 0.49 }, line: { in80: 0.78, in50: 0.48, pinball: 0.47 }, states: { in80: 0.8, in50: 0.5, pinball: 0.46 } }, chosen: 'states' as const }
    const inState = labMetrics([entry(1), entry(-3)])
    const live = { from: T, to: T, horizons: { hour1: { outcomes: 2, variants: { v1: inState, v2: inState, v3: inState, v4: inState }, news: { moved: inState, unmoved: inState }, byState: { RECOVERY: inState } } }, events: {}, drift: { shocks: 0, overReacting: 0, underReacting: 0, refreshes: 0, byReason: {}, meanChangePct: null } }
    const table = marketShockTable({ hour1: rules, hours4: { ...rules, byState: {}, compared: null, chosen: 'none' as const } }, live)
    expect(table.rows.map((row) => `${row[0]} ${row[1]}`)).toEqual([
      '1h Before a scheduled release',
      "1h After a sharp move of Bitcoin's",
      "1h In a trending move of Bitcoin's",
      '1h In a liquidation cascade',
      '1h Recovering from a shock',
      '4h Before a scheduled release',
      "4h After a sharp move of Bitcoin's",
      "4h In a trending move of Bitcoin's",
      '4h In a liquidation cascade',
      '4h Recovering from a shock'
    ])
    expect(table.rows[4]).toEqual(['1h', 'Recovering from a shock', 20, 400, '70.0%', '81.0%', '0.4500', '0.4400', 'x1.30 / x1.10', 'yes', "the states' rules (on 900 rows: as forecast 62.0% in 80%, pinball 0.4900; by the line 78.0%, 0.4700; by the states 80.0%, 0.4600)", 2, '50.0%'])
    expect(table.rows[1][9]).toBe('no: widening made the pinball loss worse')
    expect(table.rows[0].slice(2, 10)).toEqual([0, 0, '—', '—', '—', '—', '—', 'no: no moment in this state'])
    expect(table.rows[5][10]).toBe('none: the models alone')
    expect(table.rows[5][11]).toBe(0)
    // A state's rule fitted at a horizon that widens by the line: said so.
    const lined = marketShockTable({ hour1: { ...rules, chosen: 'line' as const } }, live)
    expect(lined.rows[4][9]).toBe('fitted, the horizon widens otherwise')
    expect(lined.rows[4][10]).toMatch(/^V6\.1's one rule past the line/)
  })

  // V7.1 Stage 12: the calendar's next releases, the impact history by kind, and the releases replayed on the
  // walk forward.
  it("says the next releases, what past ones did by kind, and each release replayed on the walk forward's weeks", () => {
    const cpi = { kind: 'CPI' as const, name: 'Consumer Price Index', reference: 'September 2026', date: '2026-10-14', timeEt: '08:30', at: Date.parse('2026-10-14T12:30:00Z') / 1000 }
    expect(nextReleasesTable([cpi, { ...cpi, kind: 'FOMC', reference: undefined, date: '2026-10-28', timeEt: '14:00', at: Date.parse('2026-10-28T18:00:00Z') / 1000 }]).rows).toEqual([
      ['Consumer Price Index', 'September 2026', '2026-10-14 12:30 UTC', '2026-10-14 08:30'],
      ['FOMC statement', '—', '2026-10-28 18:00 UTC', '2026-10-28 14:00']
    ])
    const impact = impactTable(EVENT_IMPACT)
    expect(impact.rows.map((row) => row[0])).toEqual(['Consumer Price Index', 'Producer Price Index', 'Employment Situation', 'FOMC statement'])
    expect(impact.rows[0][14]).toMatch(/^no: \d+ of 30 needed$/)
    expect(impactTable(null).rows).toEqual([])
    const score = { in80: 0.6, in50: 0.3, pinball: 0.5 }
    const releases = [
      { kind: 'CPI' as const, name: 'Consumer Price Index', at: cpi.at, hour: 'before' as const, t: cpi.at - 1800, n: 40, asForecast: score, byLine: score, byStates: null, state: 'NORMAL' as const, btc15: 0.3, calls: 0, callsRight: 0 },
      { kind: 'CPI' as const, name: 'Consumer Price Index', at: cpi.at, hour: 'after' as const, t: cpi.at + 1800, n: 40, asForecast: score, byLine: { in80: 0.8, in50: 0.5, pinball: 0.47 }, byStates: { in80: 0.82, in50: 0.5, pinball: 0.46 }, state: 'POST_EVENT_SHOCK' as const, btc15: -7.4, calls: 4, callsRight: 3 }
    ]
    const table = releasesTable({ ...lab, horizons: { hour1: { ...horizonLab(), releases } } })
    expect(table.rows).toEqual([
      ['Consumer Price Index', '2026-10-14 12:30 UTC', '1h', 'before (12:00 UTC)', 40, 'Normal', '0.3', '60.0%', '60.0%', '—', '0.5000', '0.5000', '—', 0, '—'],
      ['Consumer Price Index', '2026-10-14 12:30 UTC', '1h', 'after (13:00 UTC)', 40, "After a sharp move of Bitcoin's", '-7.4', '60.0%', '80.0%', '82.0%', '0.5000', '0.4700', '0.4600', 4, '3 (75%)']
    ])
    expect(releasesTable(lab).rows).toEqual([])
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

describe('the replay out of sample, as a table (V7.2-R Stage 5)', () => {
  const trade = (k: number, net: number, sample: 'in' | 'out' = 'out', overrides: Partial<ReplayTrade> = {}): ReplayTrade => ({ cell: 'band:hour1', strategy: 'band', sample, pair: 'SOLUSDT', predictionId: `p${k}`, t: T + k * 3600, horizon: 'hour1', side: 'BUY', exit: 'target', filledAt: T + k * 3600 + 300, fillPrice: 1, exitAt: T + k * 3600 + 900, exitPrice: 1, grossPct: net + 0.2, costPct: 0.2, netPct: net, endedAt: T + k * 3600 + 1200, state: null, baselinePct: 0.1, ...overrides })

  it("says each cell's orders, trades, share filled and net with its interval, and nothing of P&L in sample", () => {
    const out = cellFiguresOf('band:hour1', 'band', 'hour1', 'out', [...Array.from({ length: 120 }, (_, k) => trade(k, 0.5 + 0.01 * (k % 5))), ...Array.from({ length: 30 }, (_, k) => trade(200 + k, 0, 'out', { exit: 'unfilled', filledAt: null }))])
    const grid = cellFiguresOf('grid:hours24', 'grid', 'hours24', 'out', [trade(1, -1, 'out', { cell: 'grid:hours24', strategy: 'grid', horizon: 'hours24', exit: 'time' })])
    const inside = cellFiguresOf('band:hour1', 'band', 'hour1', 'in', [trade(1, 2, 'in')])
    const table = outOfSampleTable([out, grid, inside])
    expect(table.headers).toEqual(['Strategy', 'Horizon', 'Sample', 'Orders', 'Trades', 'Filled', 'Net a trade (95%)', 'Won', 'Profit factor', 'Mean cost', 'Deepest fall', 'Best 5% of hours', 'Held long (95%)', 'Line'])
    const [band, day, held] = table.rows
    expect(band.slice(0, 6)).toEqual(['Band reversion', '1h', 'out of sample', 150, 120, '80.0%'])
    expect(band[6]).toMatch(/^\+0\.520% \(\+0\.\d{3}% to \+0\.\d{3}%\)$/)
    expect(band[7]).toBe('100.0%')
    expect(band[13]).toBe('held')
    expect(day.slice(0, 6)).toEqual(['Range grid', '24h', 'out of sample', 1, 1, '—'])
    expect(day[13]).toBe('not measured')
    expect(held.slice(2, 5)).toEqual(['in sample', 1, 1])
    expect(held.slice(6, 13)).toEqual(['—', '—', '—', '—', '—', '—', '—'])
    expect(held[13]).toBe('in sample')
  })
})
