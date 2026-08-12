import { CircleSlash } from 'lucide-react'

export type RunningState =
  | { status: 'running'; done: number; total: number }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

interface BacktestRunningViewProps {
  runState: RunningState
  onCancel: () => void
}

const RADIUS = 100
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

function percentFor(runState: RunningState): number {
  if (runState.status === 'running') return Math.min(100, (runState.done / Math.max(1, runState.total)) * 100)
  return 0
}

function subtitleFor(runState: RunningState): string {
  switch (runState.status) {
    case 'running':
      return 'Please wait...'
    case 'cancelled':
      return 'Cancelled.'
    case 'error':
      return runState.message
  }
}

export function BacktestRunningView({ runState, onCancel }: BacktestRunningViewProps): React.JSX.Element {
  const pct = percentFor(runState)
  const color = runState.status === 'error' ? 'var(--down)' : '#7c86ff'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '1.75rem',
        padding: '4rem 0'
      }}
    >
      <div style={{ position: 'relative', width: 220, height: 220 }}>
        <svg width={220} height={220} viewBox="0 0 220 220">
          <circle cx={110} cy={110} r={RADIUS} fill="none" stroke="var(--border-strong)" strokeWidth={12} />
          <circle
            cx={110}
            cy={110}
            r={RADIUS}
            fill="none"
            stroke={color}
            strokeWidth={12}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={CIRCUMFERENCE * (1 - pct / 100)}
            transform="rotate(-90 110 110)"
            style={{ transition: 'stroke-dashoffset 0.2s ease' }}
          />
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '2rem',
            fontWeight: 700,
            color
          }}
        >
          {pct.toFixed(1)}%
        </div>
      </div>

      <span style={{ color: 'var(--text-secondary)', fontSize: '0.95rem', textAlign: 'center', maxWidth: 420 }}>
        {subtitleFor(runState)}
      </span>

      <button
        onClick={onCancel}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          background: 'var(--bg-app)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
          padding: '0.75rem 2rem',
          color: 'var(--down)',
          fontSize: '0.9rem',
          fontWeight: 600,
          cursor: 'pointer'
        }}
      >
        <CircleSlash size={16} />
        {runState.status === 'running' ? 'Cancel' : 'Back to Configuration'}
      </button>
    </div>
  )
}
