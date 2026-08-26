import { EquityCurveChart } from '../components/EquityCurveChart'
import { describeControllerBreach } from '../controllers/riskBreach'
import { describeControllerOutcome, type ControllerReplayResult } from './controllerReplay'
import type { ControllerConfig } from '../../shared/ipc'

/** Results for a replayed controller.
 *
 * A controller has no trades of its own, so the strategy panel would be almost entirely blank and
 * the executor panel would answer the wrong question. What a user wants to know about a set of
 * risk limits is whether they fired, when, and whether the group ended up better or worse for it
 * -- so the unmanaged result sits beside the managed one rather than being left to imagination. */

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

function Metric({ label, value, color, note }: { label: string; value: string; color?: string; note?: string }): React.JSX.Element {
  return (
    <div style={metricStyle()}>
      <span style={{ fontSize: '0.68rem', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: '1.05rem', fontWeight: 600, color: color ?? 'var(--text-primary)' }}>{value}</span>
      {note !== undefined && <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>{note}</span>}
    </div>
  )
}

function signed(value: number, digits = 2): string {
  const rounded = value.toFixed(digits)
  // A difference of -0.001 renders as "-0.00", which reads as a loss too small to name rather
  // than as nothing at all. Anything that rounds to zero is shown unsigned.
  if (Number(rounded) === 0) return (0).toFixed(digits)
  return `${value >= 0 ? '+' : ''}${rounded}`
}

function pnlColor(value: number): string {
  return value >= 0 ? 'var(--up)' : 'var(--down)'
}

function describeCadence(result: ControllerReplayResult): string {
  if (result.checks >= result.candles) return 'at every candle'
  const hours = result.checkIntervalSec / 3600
  if (hours < 1) return `about every ${Math.round(result.checkIntervalSec / 60)} minutes`
  return `about every ${hours < 10 ? hours.toFixed(1) : Math.round(hours)} hours`
}

export function ControllerBacktestView({
  controller,
  result
}: {
  controller: ControllerConfig
  result: ControllerReplayResult
}): React.JSX.Element {
  const difference = result.finalPnlQuote - result.uncontrolledPnlQuote

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        <strong style={{ color: 'var(--text-primary)' }}>{controller.name}</strong> supervising{' '}
        {result.executorOutcomes.length} executor{result.executorOutcomes.length === 1 ? '' : 's'} over{' '}
        {result.candles.toLocaleString()} candles. {describeControllerOutcome(result)}
      </p>

      {result.breach !== null && (
        <div
          style={{
            background: 'var(--surface-2)',
            border: '1px solid var(--down)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.7rem 0.85rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.25rem'
          }}
        >
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
            {describeControllerBreach(result.breach.breach)}
          </span>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
            {new Date(result.breach.atTime * 1000).toUTCString()} — every attached executor would have been stopped and
            settled here.
          </span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(11rem, 1fr))', gap: '0.7rem' }}>
        <Metric
          label="With the controller"
          value={`${signed(result.finalPnlQuote)} (${signed(result.finalPnlPct)}%)`}
          color={pnlColor(result.finalPnlQuote)}
        />
        <Metric
          label="Without it"
          value={`${signed(result.uncontrolledPnlQuote)} (${signed(result.uncontrolledPnlPct)}%)`}
          color={pnlColor(result.uncontrolledPnlQuote)}
          note={result.breach === null ? 'same run — no limit fired' : undefined}
        />
        <Metric
          label="The limits were worth"
          value={signed(difference)}
          color={pnlColor(difference)}
          note="managed result minus unmanaged"
        />
        <Metric label="Peak drawdown" value={`${result.peakDrawdownPct.toFixed(2)}%`} color="var(--down)" note="below peak equity" />
        <Metric label="Allocated capital" value={result.allocatedQuote.toFixed(2)} note="every percentage is of this" />
      </div>

      <EquityCurveChart equityCurve={result.equityCurve} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
        {result.executorOutcomes.map((outcome) => (
          <div
            key={outcome.id}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '1rem',
              padding: '0.5rem 0.7rem',
              background: 'var(--bg-app)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.78rem'
            }}
          >
            <span style={{ minWidth: 0, color: 'var(--text-primary)' }}>
              <strong>{outcome.name}</strong>{' '}
              <span style={{ color: 'var(--text-muted)' }}>
                ({outcome.type} • {outcome.symbol}) {outcome.outcome}
              </span>
            </span>
            <span style={{ flexShrink: 0, fontWeight: 600, color: pnlColor(outcome.pnlQuote) }}>{signed(outcome.pnlQuote)}</span>
          </div>
        ))}
      </div>

      {result.skipped.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          {result.skipped.map((s) => (
            <span key={s.name} style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <strong>{s.name}</strong> was not included: {s.reason}
            </span>
          ))}
        </div>
      )}

      <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Limits were checked {describeCadence(result)} ({result.checks.toLocaleString()} checks), never more often than
        the five minutes the running app uses — a replay that checked faster would catch dips the real controller
        sleeps through. Each check replays every attached executor from the start of the range, which is what the
        spacing pays for. After a breach the managed line is flat because everything was closed and settled at that
        moment; the unmanaged figure keeps running to the end of the range.
      </p>
    </div>
  )
}
