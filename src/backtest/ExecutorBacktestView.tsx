import { EquityCurveChart } from '../components/EquityCurveChart'
import { describeExecutorOutcome, type ExecutorReplayResult } from './executorReplay'
import type { ExecutorConfig } from '../../shared/ipc'

/** Results for a replayed executor.
 *
 * Deliberately not the thirty-stat panel a signal strategy gets. That panel measures a population
 * of trades -- win rate, expectancy, profit factor, streaks -- and most executors take one
 * position and manage it, so nearly every box would be a placeholder. What is shown here is what
 * an executor run actually produces: what it did, what it was worth over time, and the worst it
 * got. */
function metricStyle(): React.CSSProperties {
  return {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.7rem 0.85rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.2rem'
  }
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }): React.JSX.Element {
  return (
    <div style={metricStyle()}>
      <span style={{ fontSize: '0.68rem', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: '1.05rem', fontWeight: 600, color: color ?? 'var(--text-primary)' }}>{value}</span>
    </div>
  )
}

export function ExecutorBacktestView({
  executor,
  result
}: {
  executor: ExecutorConfig
  result: ExecutorReplayResult
}): React.JSX.Element {
  const positive = result.netProfit >= 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        <strong style={{ color: 'var(--text-primary)' }}>{executor.name}</strong> ({executor.type}) replayed over{' '}
        {result.candles.toLocaleString()} candles of {executor.symbol}. {describeExecutorOutcome(result.finalState)}
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(10rem, 1fr))', gap: '0.7rem' }}>
        <Metric label="Net P&L" value={`${positive ? '+' : ''}${result.netProfit.toFixed(2)}`} color={positive ? 'var(--up)' : 'var(--down)'} />
        <Metric label="Return" value={`${positive ? '+' : ''}${result.netProfitPct.toFixed(2)}%`} color={positive ? 'var(--up)' : 'var(--down)'} />
        <Metric label="Max Drawdown" value={`${result.maxDrawdownPct.toFixed(2)}%`} color="var(--down)" />
        <Metric label="Finishing Balance" value={result.finishingBalance.toFixed(2)} />
      </div>

      <EquityCurveChart equityCurve={result.equityCurve} />

      <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        The curve is drawn from {result.samples} points across the range rather than one per candle: valuing an executor
        at a moment means replaying it up to that moment, so a point per candle costs quadratic time on a long range.
        The last point is always the final candle, so the figures above are exact — only the shape between points is
        sampled. Fees are charged at the app&rsquo;s standard rate; the run starts the executor at the beginning of the
        range regardless of when it was created, so a TWAP or DCA schedule runs inside the window you chose.
      </p>
    </div>
  )
}
