import { useMemo, useState } from 'react'
import { runBacktest, type BacktestStats } from './engine'
import { STRATEGIES } from './strategies'
import type { Candle } from '../../shared/ipc'

type SortKey = 'totalNetProfitPct' | 'winRatePct' | 'maxDrawdownPct' | 'sharpeRatio' | 'profitFactor'

const COLUMNS: { key: SortKey; label: string; format: (stats: BacktestStats) => string; higherIsBetter: boolean }[] = [
  { key: 'totalNetProfitPct', label: 'Net %', format: (s) => `${s.totalNetProfitPct >= 0 ? '+' : ''}${s.totalNetProfitPct.toFixed(2)}%`, higherIsBetter: true },
  { key: 'winRatePct', label: 'Win Rate', format: (s) => `${s.winRatePct.toFixed(1)}%`, higherIsBetter: true },
  { key: 'maxDrawdownPct', label: 'Max Drawdown', format: (s) => `${s.maxDrawdownPct.toFixed(2)}%`, higherIsBetter: false },
  { key: 'sharpeRatio', label: 'Sharpe', format: (s) => s.sharpeRatio.toFixed(2), higherIsBetter: true },
  { key: 'profitFactor', label: 'Profit Factor', format: (s) => (s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)), higherIsBetter: true }
]

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
  startingBalance
}: {
  candles: Candle[]
  /** The same capital the single-strategy run used, so a strategy's row here and its own results
   * page cannot disagree on what it earned. */
  startingBalance: number
}): React.JSX.Element {
  const [sortKey, setSortKey] = useState<SortKey>('totalNetProfitPct')

  const rows = useMemo(() => {
    return STRATEGIES.map((strategy) => ({
      strategy,
      stats: runBacktest(candles, strategy.id, { startingBalance }).stats
    })).sort((a, b) => {
      const column = COLUMNS.find((c) => c.key === sortKey)!
      const diff = a.stats[sortKey] - b.stats[sortKey]
      return column.higherIsBetter ? -diff : diff
    })
  }, [candles, sortKey, startingBalance])

  return (
    <div style={{ overflowX: 'auto' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: '0 0 0.9rem' }}>
        Every registered strategy replayed over the same {candles.length.toLocaleString()} candles, so choosing one
        is evidence-based rather than a guess. Click a column to sort by it.
      </p>
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
          {rows.map(({ strategy, stats }) => (
            <tr key={strategy.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
                {strategy.name}
                <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)', maxWidth: 260 }}>{strategy.description}</div>
              </td>
              <td style={{ ...cellStyle, color: pctColor(stats.totalNetProfitPct), fontWeight: 600 }}>
                {COLUMNS[0].format(stats)}
              </td>
              <td style={cellStyle}>{COLUMNS[1].format(stats)}</td>
              <td style={{ ...cellStyle, color: 'var(--down)' }}>{COLUMNS[2].format(stats)}</td>
              <td style={cellStyle}>{COLUMNS[3].format(stats)}</td>
              <td style={cellStyle}>{COLUMNS[4].format(stats)}</td>
              <td style={cellStyle}>{stats.totalClosedTrades}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
