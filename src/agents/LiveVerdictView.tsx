import { describeLiveState, type LiveReading } from './liveVerdict'

const plain = (value: number): string => Number(value.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 8 })

/** One recommendation against the live price: ENTERABLE, WAITING or INVALIDATED with why, the price
 * a fill would take, and the execution score with what held it down. */
export function LiveVerdictView({ reading, compact = false }: { reading: LiveReading | null; compact?: boolean }): React.JSX.Element {
  if (reading === null) return <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Live price: connecting…</span>
  const { verdict, quality } = reading
  const state = describeLiveState(verdict)
  const why = verdict.reasons.join('; ')
  const execution = `Execution ${quality.score}/100`
  return (
    <span style={{ fontSize: compact ? '0.78rem' : '0.84rem', lineHeight: 1.5 }} title={quality.reasons.length > 0 ? `${execution}: ${quality.reasons.join('; ')}` : execution}>
      <strong style={{ color: `var(--${state.tone})` }}>{state.word}</strong>
      {verdict.price !== null && <span style={{ color: 'var(--text-secondary)' }}> at {plain(verdict.price)}</span>}
      <span style={{ color: quality.score >= 70 ? 'var(--text-secondary)' : 'var(--gold)' }}> · {execution}</span>
      {why !== '' && <span style={{ display: compact ? 'block' : 'inline', color: 'var(--text-muted)' }}>{compact ? why : ` · ${why}`}</span>}
    </span>
  )
}
