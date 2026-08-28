import { useMemo, useState } from 'react'
import { Download, Check, TriangleAlert } from 'lucide-react'
import { runBacktest } from './engine'
import { STRATEGIES } from './strategies'
import type { Candle } from '../../shared/ipc'
import { COMPARISON_COLUMNS as COLUMNS, describeNoTrades, rankStrategyRows, tookNoTrades, type SortKey } from './strategyRanking'
import {
  comparisonFileName,
  serializeComparison,
  type ComparisonExport,
  type ExportFormat
} from './exportResults'


const headerCellStyle: React.CSSProperties = {
  padding: '0 0.9rem 0.6rem',
  fontSize: '0.68rem',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  textAlign: 'left',
  cursor: 'pointer'
}

const cellStyle: React.CSSProperties = { padding: '0.65rem 0.9rem', fontSize: '0.82rem' }

function pctColor(value: number): string {
  return value >= 0 ? 'var(--up)' : 'var(--down)'
}

export function StrategyComparisonView({
  candles,
  startingBalance,
  meta
}: {
  candles: Candle[]
  /** The same capital the single-strategy run used, so a strategy's row here and its own results
   * page cannot disagree on what it earned. */
  startingBalance: number
  /** Only used to label an export. Without it a saved comparison is a table of numbers with
   * nothing saying which symbol, timeframe or dates produced them. */
  meta: { exchange: string; symbol: string; interval: string; startDate: string; endDate: string }
}): React.JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('totalNetProfitPct')
  const [exportState, setExportState] = useState<
    { status: 'idle' } | { status: 'busy' } | { status: 'saved'; filePath: string } | { status: 'error'; message: string }
  >({ status: 'idle' })

  const rows = useMemo(() => {
    const column = COLUMNS.find((c) => c.key === sortKey)!
    return rankStrategyRows(
      STRATEGIES.map((strategy) => ({ row: strategy, stats: runBacktest(candles, strategy.id, { startingBalance }).stats })),
      sortKey,
      column.higherIsBetter
    ).map(({ row, stats }) => ({ strategy: row, stats }))
  }, [candles, sortKey, startingBalance])

  async function handleExport(format: ExportFormat): Promise<void> {
    setExportState({ status: 'busy' })
    try {
      // Exports the rows in the order shown, so a saved file matches the screen it came from.
      const payload: ComparisonExport = {
        exportedAt: new Date().toISOString(),
        run: { ...meta, candles: candles.length, startingBalance },
        rows: rows.map(({ strategy, stats }) => ({
          strategy: strategy.name,
          tookNoTrades: tookNoTrades(stats),
          netPct: stats.totalNetProfitPct,
          winRatePct: stats.winRatePct,
          maxDrawdownPct: stats.maxDrawdownPct,
          sharpeRatio: stats.sharpeRatio,
          profitFactor: stats.profitFactor,
          trades: stats.totalClosedTrades,
          finishingBalance: stats.finishingBalance,
          totalPaidFees: stats.totalPaidFees
        }))
      }
      const outcome = await window.api.backtest.exportSave({
        defaultFileName: comparisonFileName(payload, format),
        content: serializeComparison(payload, format),
        format
      })
      if (outcome.status === 'saved') setExportState({ status: 'saved', filePath: outcome.filePath })
      else if (outcome.status === 'cancelled') setExportState({ status: 'idle' })
      else setExportState({ status: 'error', message: outcome.message })
    } catch (error) {
      setExportState({ status: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const exportButtonStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.45rem 0.75rem',
    color: 'var(--text-primary)',
    fontSize: '0.78rem',
    fontWeight: 600,
    cursor: exportState.status === 'busy' ? 'wait' : 'pointer'
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', margin: '0 0 0.9rem' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: 0, maxWidth: '52ch' }}>
          Every registered strategy replayed over the same {candles.length.toLocaleString()} candles, so choosing one
          is evidence-based rather than a guess. Click a column to sort by it.
        </p>
        <div style={{ display: 'flex', gap: '0.45rem', flexShrink: 0 }}>
          <button onClick={() => void handleExport('csv')} disabled={exportState.status === 'busy'} style={exportButtonStyle}>
            <Download size={14} /> Export CSV
          </button>
          <button onClick={() => void handleExport('json')} disabled={exportState.status === 'busy'} style={exportButtonStyle}>
            <Download size={14} /> Export JSON
          </button>
        </div>
      </div>
      {exportState.status === 'saved' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--text-secondary)', margin: '0 0 0.9rem' }}>
          <Check size={14} style={{ color: '#14b8a6', flexShrink: 0 }} />
          <span style={{ wordBreak: 'break-all' }}>Saved to {exportState.filePath}</span>
        </div>
      )}
      {exportState.status === 'error' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', color: 'var(--down)', margin: '0 0 0.9rem' }}>
          <TriangleAlert size={14} style={{ flexShrink: 0 }} />
          <span>Could not save: {exportState.message}</span>
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={{ ...headerCellStyle, cursor: 'default' }}>Strategy</th>
            {COLUMNS.map((col) => (
              <th key={col.key} style={headerCellStyle} onClick={() => setSortKey(col.key)}>
                {col.label} {sortKey === col.key ? '▾' : ''}
              </th>
            ))}
            <th style={{ ...headerCellStyle, cursor: 'default' }}>Trades</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ strategy, stats }) => {
            // A strategy that never fired has no win rate, no profit factor and no risk figures --
            // only zeroes standing in for numbers that were never measured. Shown as dashes so the
            // row cannot be read as "flat and safe", and never tinted green.
            const flat = tookNoTrades(stats)
            return (
              <tr key={strategy.id} style={{ borderBottom: '1px solid var(--border)', opacity: flat ? 0.75 : 1 }}>
                <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {strategy.name}
                  <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)', maxWidth: 260 }}>{strategy.description}</div>
                  {flat && (
                    <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--gold)', maxWidth: 320, marginTop: '0.3rem' }}>
                      {describeNoTrades(strategy.name, stats, candles.length)}
                    </div>
                  )}
                </td>
                <td style={{ ...cellStyle, color: flat ? 'var(--text-muted)' : pctColor(stats.totalNetProfitPct), fontWeight: 600 }}>
                  {flat ? 'no trades' : COLUMNS[0].format(stats)}
                </td>
                <td style={cellStyle}>{flat ? '—' : COLUMNS[1].format(stats)}</td>
                <td style={{ ...cellStyle, color: flat ? 'var(--text-muted)' : 'var(--down)' }}>{flat ? '—' : COLUMNS[2].format(stats)}</td>
                <td style={cellStyle}>{flat ? '—' : COLUMNS[3].format(stats)}</td>
                <td style={cellStyle}>{flat ? '—' : COLUMNS[4].format(stats)}</td>
                <td style={cellStyle}>{stats.totalClosedTrades}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
