import type { BacktestResult } from './engine'
import type { ResultsGeneralInfo } from './BacktestResultsView'

// Turning a finished backtest into a file, kept as pure string-building so it can be tested
// without Electron, a save dialog, or a filesystem. The main process deliberately knows nothing
// about backtests: it receives a filename and a string, shows a dialog and writes bytes. Putting
// the formatting here rather than there is what keeps the result types in the one place that
// already owns them, instead of duplicating them across the process boundary.

export type ExportFormat = 'json' | 'csv'

/** What a saved file can be, which is wider than what `serializeRunExport` can produce: the chart
 * image is bytes rendered elsewhere, but it wants the same name as its text siblings so a run's
 * three exports sort together in a folder. */
export type ExportExtension = ExportFormat | 'png'

export interface RunExport {
  exportedAt: string
  app: { schema: number }
  run: {
    exchange: string
    symbol: string
    interval: string
    strategy: string
    startDate: string
    endDate: string
    periodDays: number
    splitDate: string | null
    startingBalance: number
    leverage: number
    elapsedSec: number
    /** Leading candles the strategy could not trade in. Exported because a reader comparing two
     * runs needs to know the tradeable window differed, which the date range alone hides. */
    warmupBars: number
  }
  stats: BacktestResult['stats']
  monthlyBreakdown: BacktestResult['monthlyBreakdown']
  trades: Array<{
    n: number
    side: string
    entryTime: string
    exitTime: string
    entryTimestamp: number
    exitTimestamp: number
    holdingHours: number
    entryPrice: number
    exitPrice: number
    qty: number
    pnl: number
    returnPct: number
    exitReason: string
  }>
  equityCurve: Array<{ time: string; timestamp: number; value: number }>
  benchmarkCurve: Array<{ time: string; timestamp: number; value: number }>
}

/** Schema version, so a file exported today is still identifiable if the shape later changes.
 * Bump on any breaking change to the field layout. */
const SCHEMA_VERSION = 1

function iso(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return ''
  return new Date(unixSeconds * 1000).toISOString()
}

export function buildRunExport(
  result: BacktestResult,
  info: ResultsGeneralInfo,
  elapsedSec: number,
  leverage: number
): RunExport {
  return {
    exportedAt: new Date().toISOString(),
    app: { schema: SCHEMA_VERSION },
    run: {
      exchange: info.exchangeName,
      symbol: info.symbolLabel,
      interval: info.intervalLabel,
      strategy: info.strategyLabel,
      startDate: info.startDate,
      endDate: info.endDate,
      periodDays: info.periodDays,
      splitDate: info.splitDate,
      startingBalance: result.stats.startingBalance,
      leverage,
      elapsedSec,
      warmupBars: result.stats.warmupBars
    },
    stats: result.stats,
    monthlyBreakdown: result.monthlyBreakdown,
    trades: result.trades.map((t, i) => ({
      n: i + 1,
      side: t.side,
      entryTime: iso(t.entryTime),
      exitTime: iso(t.exitTime),
      entryTimestamp: t.entryTime,
      exitTimestamp: t.exitTime,
      holdingHours: (t.exitTime - t.entryTime) / 3600,
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      qty: t.qty,
      pnl: t.pnl,
      returnPct: t.returnPct,
      exitReason: t.exitReason
    })),
    equityCurve: result.equityCurve.map((p) => ({ time: iso(p.time), timestamp: p.time, value: p.value })),
    benchmarkCurve: result.benchmarkCurve.map((p) => ({ time: iso(p.time), timestamp: p.time, value: p.value }))
  }
}

/** One CSV field, quoted when it has to be.
 *
 * The leading-character guard is the part that is not obvious. A spreadsheet treats a cell
 * starting with = + - or @ as a FORMULA, so a value arriving from an exchange -- a symbol name,
 * an error string -- can execute when the file is opened. Prefixing with an apostrophe is the
 * standard mitigation and is invisible in the cell. Numbers are formatted by us and never take
 * this path, so a negative P&L still reads as a number rather than text. */
export function csvField(value: string | number): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  let s = value
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

/** Trims binary floating-point noise for display.
 *
 * An entry price carries slippage as a multiplication, so the exact double prints as
 * 64012.78999799999 -- true, and indistinguishable from a bug to anyone opening the file. This
 * rounds far below any exchange's tick size, so nothing real is lost. Applied ONLY to the CSV:
 * the JSON is the machine-readable copy and keeps the exact values the engine computed. */
function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : value
}

function csvRows(rows: Array<Array<string | number>>): string {
  // CRLF is what RFC 4180 specifies and what Excel is happiest opening on Windows, which is the
  // platform this app ships on.
  return rows.map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n'
}

/** The trade list, one row per closed trade — the shape a spreadsheet is actually for.
 *
 * Deliberately only the trades. A backtest holds four different tables (stats, monthly, trades,
 * equity curve) and stacking them into one CSV with blank-line separators produces a file no
 * spreadsheet parses correctly. The JSON export carries all four; this carries the one people
 * open Excel to sort and filter. */
export function runExportToCsv(x: RunExport): string {
  const header = [
    '#', 'side', 'entry_time_utc', 'exit_time_utc', 'holding_hours',
    'entry_price', 'exit_price', 'qty', 'pnl', 'return_pct', 'exit_reason'
  ]
  const rows: Array<Array<string | number>> = [header]
  for (const t of x.trades) {
    rows.push([
      t.n, t.side, t.entryTime, t.exitTime, Number(t.holdingHours.toFixed(4)),
      round(t.entryPrice, 8), round(t.exitPrice, 8), round(t.qty, 10),
      round(t.pnl, 8), round(t.returnPct, 6), t.exitReason
    ])
  }
  return csvRows(rows)
}

/** One strategy's row in a Compare Strategies export. */
export interface ComparisonRow {
  strategy: string
  tookNoTrades: boolean
  netPct: number
  winRatePct: number
  maxDrawdownPct: number
  sharpeRatio: number
  profitFactor: number
  trades: number
  finishingBalance: number
  totalPaidFees: number
}

export interface ComparisonExport {
  exportedAt: string
  run: {
    exchange: string
    symbol: string
    interval: string
    startDate: string
    endDate: string
    candles: number
    startingBalance: number
  }
  rows: ComparisonRow[]
}

/** The Compare Strategies table as a spreadsheet.
 *
 * A strategy that never fired is written with EMPTY cells rather than zeroes, matching the dashes
 * the table shows on screen. Zero would be a lie of a specific kind here: it reads as "flat and
 * safe" -- a 0% drawdown and a 0% loss look like the least risky row in the file -- when the truth
 * is that nothing was measured at all. The tookNoTrades column says so explicitly so a reader
 * sorting by drawdown in Excel cannot be misled by blanks either. */
export function comparisonToCsv(x: ComparisonExport): string {
  const header = [
    'strategy', 'took_no_trades', 'net_pct', 'win_rate_pct', 'max_drawdown_pct',
    'sharpe', 'profit_factor', 'trades', 'finishing_balance', 'fees_paid'
  ]
  const rows: Array<Array<string | number>> = [header]
  for (const r of x.rows) {
    const measured = <T,>(value: T): T | string => (r.tookNoTrades ? '' : value)
    rows.push([
      r.strategy,
      r.tookNoTrades ? 'yes' : 'no',
      measured(round(r.netPct, 4)),
      measured(round(r.winRatePct, 4)),
      measured(round(r.maxDrawdownPct, 4)),
      measured(round(r.sharpeRatio, 4)),
      // Infinity is what the engine reports for a run that never had a losing period. It is not a
      // number a spreadsheet can hold, and csvField would blank it silently, so it is named.
      r.tookNoTrades ? '' : Number.isFinite(r.profitFactor) ? round(r.profitFactor, 4) : 'infinite',
      r.trades,
      round(r.finishingBalance, 2),
      round(r.totalPaidFees, 2)
    ])
  }
  return csvRows(rows)
}

export function comparisonToJson(x: ComparisonExport): string {
  return JSON.stringify(x, null, 2)
}

export function serializeComparison(x: ComparisonExport, format: ExportFormat): string {
  return format === 'csv' ? comparisonToCsv(x) : comparisonToJson(x)
}

/** Names the file after the window rather than any one strategy, since it holds all of them. */
export function comparisonFileName(x: ComparisonExport, format: ExportFormat): string {
  const safe = (v: string): string => v.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
  return [
    'compare',
    safe(x.run.symbol),
    safe(x.run.interval),
    safe(x.run.startDate),
    'to',
    safe(x.run.endDate)
  ].join('_') + `.${format}`
}

export function runExportToJson(x: RunExport): string {
  return JSON.stringify(x, null, 2)
}

export function serializeRunExport(x: RunExport, format: ExportFormat): string {
  return format === 'csv' ? runExportToCsv(x) : runExportToJson(x)
}

/** A filename that says what the run was, so a folder of exports is readable without opening
 * them. Everything a filesystem objects to is collapsed to a hyphen. */
export function exportFileName(x: RunExport, format: ExportExtension): string {
  const safe = (s: string): string =>
    s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'run'
  const parts = [
    'backtest',
    safe(x.run.symbol),
    safe(x.run.interval),
    safe(x.run.strategy),
    safe(x.run.startDate),
    'to',
    safe(x.run.endDate)
  ]
  return `${parts.join('_')}.${format}`
}
