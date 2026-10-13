import { HORIZONS, PAIR_CLASSES, type Horizon, type PairClass } from '../../shared/forecast/features'
import { LIVE_VARIANTS, type LabErrorKind, type LabEvent, type LabMetrics, type LeaderRow, type LiveLab, type TraderStats } from '../../shared/forecast/lab'
import type { LabFile } from '../../shared/forecast/labFile'

// THE FORECAST LAB'S TABLES (V6 Stage 11, 13 October 2026): each card's headers and rows, from the Lab's
// figures, the same for the page and its CSV. A share is said in percent, a move in percent with its
// sign; a cell with nothing to say reads "—".

export interface LabTableData {
  headers: string[]
  rows: (string | number)[][]
}

export const HORIZON_NAME: Record<Horizon, string> = { minutes5: '5m', minutes15: '15m', hour1: '1h', hours4: '4h', hours24: '24h' }
export const CLASS_NAME: Record<PairClass | 'pooled', string> = { pooled: 'Every coin', btc: 'Bitcoin', eth: 'Ether', large: 'Large', mid: 'Mid', 'high-vol': 'High volatility', other: 'Other' }
export const EVENT_NAME: Record<LabEvent, string> = { all: 'Every forecast', pump: 'After a pump', dump: 'After a dump', breakout: 'On a break of the day\'s range', news: 'With a story about the coin', listing: 'Listing', hack: 'Hack or exploit', etf: 'ETF', macro: 'Macro' }
export const ERROR_KINDS: LabErrorKind[] = ['CORRECT_DIRECTION', 'WRONG_DIRECTION', 'RIGHT_RANGE', 'TOO_NARROW', 'TOO_WIDE', 'EARLY', 'LATE', 'NEWS_MISREAD', 'MARKET_MISREAD']

export const share = (value: number | null | undefined, digits = 1): string => (value === null || value === undefined || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(digits)}%`)
export const pct = (value: number | null | undefined, digits = 2): string => (value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`)
export const plain = (value: number | null | undefined, digits = 3): string => (value === null || value === undefined || !Number.isFinite(value) ? '—' : value.toFixed(digits))

const METRIC_HEADERS = ['Outcomes', 'Median\'s way right', 'Calls', 'Calls right', 'In the 50% range', 'In the 80% range', 'MAE', 'RMSE', 'Bias', 'Pinball', 'Skill over persistence', '80% width']

function metricCells(metrics: LabMetrics | undefined): (string | number)[] {
  if (metrics === undefined) return METRIC_HEADERS.map(() => '—')
  return [
    metrics.n,
    share(metrics.direction),
    metrics.calls,
    share(metrics.callsRight),
    share(metrics.coverage50),
    share(metrics.coverage80),
    `${plain(metrics.mae, 2)}%`,
    `${plain(metrics.rmse, 2)}%`,
    pct(metrics.bias, 3),
    plain(metrics.pinball, 4),
    share(metrics.skill, 2),
    `${plain(metrics.width80, 2)}%`
  ]
}

/** The walk forward's forecasts by horizon and variant, for one class or every coin (§27-28, §49). */
export function performanceTable(lab: LabFile, cls: PairClass | 'pooled'): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const entry = lab.horizons[horizon]
    if (entry === undefined) continue
    for (const variant of ['v1', 'v2'] as const) {
      const metrics = cls === 'pooled' ? entry.variants[variant].pooled : entry.variants[variant].byClass[cls]
      rows.push([HORIZON_NAME[horizon], variant === 'v1' ? 'V1 price only' : 'V2 + technical (shown)', ...metricCells(metrics)])
    }
  }
  return { headers: ['Horizon', 'Variant', ...METRIC_HEADERS], rows }
}

/** The classes a Lab holds outcomes for, for its class picker. */
export function classesOf(lab: LabFile): (PairClass | 'pooled')[] {
  const held = new Set<PairClass>()
  for (const entry of Object.values(lab.horizons)) for (const cls of Object.keys(entry?.variants.v2.byClass ?? {})) held.add(cls as PairClass)
  return ['pooled', ...PAIR_CLASSES.filter((cls) => held.has(cls))]
}

/** The calibration curve (§26, §56): the share at or below each level against its nominal, and the tails. */
export function calibrationTable(lab: LabFile): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const metrics = lab.horizons[horizon]?.variants.v2.pooled
    if (metrics === undefined) continue
    rows.push([HORIZON_NAME[horizon], ...metrics.levels.map((level) => share(level)), share(metrics.tailLow), share(metrics.tailHigh)])
  }
  return { headers: ['Horizon', 'At or below P10 (10%)', 'P25 (25%)', 'P50 (50%)', 'P75 (75%)', 'P90 (90%)', 'Under P10', 'Over P90'], rows }
}

/** P(up) against what went up (§59), tenth by tenth, every horizon. */
export function pUpCurveTable(lab: LabFile): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    for (const bin of lab.horizons[horizon]?.variants.v2.pUpCurve ?? []) rows.push([HORIZON_NAME[horizon], share(bin.predicted), share(bin.observed), bin.n])
  }
  return { headers: ['Horizon', 'P(up) forecast', 'Went up', 'Outcomes'], rows }
}

function errorCells(metrics: LabMetrics | undefined): (string | number)[] {
  return ERROR_KINDS.map((kind) => {
    const count = metrics?.errors[kind] ?? 0
    return metrics === undefined || metrics.n === 0 ? '—' : `${count} (${share(count / metrics.n)})`
  })
}

/** The kinds of error (§43) by horizon, on the walk forward and on the live record. */
export function errorsTable(lab: LabFile | null, live: LiveLab): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const walked = lab?.horizons[horizon]?.variants.v2.pooled
    if (walked !== undefined) rows.push(['Walk forward', HORIZON_NAME[horizon], walked.n, ...errorCells(walked)])
    const shown = live.horizons[horizon]?.variants.v4
    if (shown !== undefined) rows.push(['Live record', HORIZON_NAME[horizon], shown.n, ...errorCells(shown)])
  }
  return { headers: ['Record', 'Horizon', 'Outcomes', ...ERROR_KINDS.map((kind) => kind.replace(/_/g, ' '))], rows }
}

/** Drift (§42): how forecasts made after an hour's shock behaved. */
export function driftTable(lab: LabFile | null, live: LiveLab): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const drift = lab?.horizons[horizon]?.drift
    if (drift !== undefined) rows.push(['Walk forward', HORIZON_NAME[horizon], drift.shocks, `${drift.overReacting} (${share(drift.shocks > 0 ? drift.overReacting / drift.shocks : null)})`, `${drift.underReacting} (${share(drift.shocks > 0 ? drift.underReacting / drift.shocks : null)})`])
  }
  const drift = live.drift
  rows.push(['Live record', 'every horizon', drift.shocks, `${drift.overReacting} (${share(drift.shocks > 0 ? drift.overReacting / drift.shocks : null)})`, `${drift.underReacting} (${share(drift.shocks > 0 ? drift.underReacting / drift.shocks : null)})`])
  return { headers: ['Record', 'Horizon', 'After a shock', 'Over-reacting', 'Under-reacting'], rows }
}

/** One event's forecasts by horizon (§92-93), on the walk forward and the live record. */
export function eventsTable(lab: LabFile | null, live: LiveLab, event: LabEvent): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const walked = lab?.horizons[horizon]?.events[event]
    if (walked !== undefined) rows.push(['Walk forward', HORIZON_NAME[horizon], ...metricCells(walked)])
  }
  const shown = live.events[event]
  if (shown !== undefined) rows.push(['Live record', 'every horizon', ...metricCells(shown)])
  return { headers: ['Record', 'Horizon', ...METRIC_HEADERS], rows }
}

const LIVE_NAME = { v1: 'V1 price only', v2: 'V2 + technical', v3: 'V3 + news', v4: 'V4 + news + AI (shown)' } as const

/** The live record's four variants on the same moments (§49), and the shown forecast with and without a story. */
export function liveTable(live: LiveLab): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const entry = live.horizons[horizon]
    if (entry === undefined) continue
    for (const variant of LIVE_VARIANTS) rows.push([HORIZON_NAME[horizon], LIVE_NAME[variant], ...metricCells(entry.variants[variant])])
    rows.push([HORIZON_NAME[horizon], 'Shown, a story moving it', ...metricCells(entry.news.moved)])
    rows.push([HORIZON_NAME[horizon], 'Shown, no story', ...metricCells(entry.news.unmoved)])
  }
  return { headers: ['Horizon', 'Variant', ...METRIC_HEADERS], rows }
}

/** Every model at every horizon (§103-105). */
export function leaderTable(rows: readonly LeaderRow[]): LabTableData {
  return {
    headers: ['Horizon', 'Model', 'Outcomes', 'Pinball', 'Skill over persistence', 'In the 80% range', 'Median\'s way right', 'Weight', 'Promoted', 'Last week'],
    rows: rows.map((row) => [
      HORIZON_NAME[row.horizon],
      row.model,
      row.n,
      plain(row.pinball, 4),
      row.model === 'persistence' ? 'the floor' : share(row.skill, 2),
      share(row.coverage80),
      share(row.direction),
      share(row.weight, 0),
      row.promoted === null ? '—' : row.promoted ? 'yes' : 'no',
      row.degraded ? 'DEGRADED' : 'within its lines'
    ])
  }
}

const TRADER_HEADERS = ['Trades', 'Win rate', 'Profit factor', 'Expectancy a trade', 'Net, a stake a trade', 'Max drawdown', 'Round trips\' cost']

export function traderCells(stats: TraderStats): (string | number)[] {
  return [stats.trades, share(stats.winRate), plain(stats.profitFactor, 2), pct(stats.expectancyPct, 3), pct(stats.netPct), `${plain(stats.maxDrawdownPct, 2)}%`, `${plain(stats.costPct, 2)}%`]
}

/** The forecast trader (§97) by horizon: as the rules stand, and on the median alone (research). */
export function traderTable(lab: LabFile): LabTableData {
  const rows: (string | number)[][] = []
  for (const horizon of HORIZONS) {
    const entry = lab.horizons[horizon]
    if (entry === undefined) continue
    rows.push([HORIZON_NAME[horizon], 'As the rules stand', ...traderCells(entry.trader.rules)])
    rows.push([HORIZON_NAME[horizon], 'On the median alone (research)', ...traderCells(entry.trader.medians)])
  }
  return { headers: ['Horizon', 'Rule', ...TRADER_HEADERS], rows }
}

export const COMPARISON_HEADERS = ['What', ...TRADER_HEADERS]

export function csvCell(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function tableCsv(table: LabTableData): string {
  return [table.headers, ...table.rows].map((row) => row.map(csvCell).join(',')).join('\n')
}
