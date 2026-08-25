import { useMemo, useState } from 'react'
import { runBacktest } from './engine'
import { STRATEGIES } from './strategies'
import type { Candle } from '../../shared/ipc'
import { COMPARISON_COLUMNS as COLUMNS, describeNoTrades, rankStrategyRows, tookNoTrades, type SortKey } from './strategyRanking'


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
    const column = COLUMNS.find((c) => c.key === sortKey)!
    return rankStrategyRows(
      STRATEGIES.map((strategy) => ({ row: strategy, stats: runBacktest(candles, strategy.id, { startingBalance }).stats })),
      sortKey,
      column.higherIsBetter
    ).map(({ row, stats }) => ({ strategy: row, stats }))
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
