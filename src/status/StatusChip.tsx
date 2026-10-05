import type { ModeLabel, Tone } from './statusModes'

const COLOR: Record<Tone, string> = {
  safe: 'var(--up)',
  live: 'var(--down)',
  blocked: 'var(--down)',
  muted: 'var(--text-muted)',
  info: 'var(--accent)',
  warn: 'var(--gold)'
}

/** One state, as a pill: its label, and on hover the sentence that says what it means. */
export function StatusChip({ mode, extra }: { mode: ModeLabel; extra?: string }): React.JSX.Element {
  const color = COLOR[mode.tone]
  const text = extra === undefined ? mode.label : `${mode.label} · ${extra}`
  return (
    <span
      title={mode.detail}
      aria-label={`${text}. ${mode.detail}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.3rem',
        padding: '0.08rem 0.5rem',
        borderRadius: 999,
        border: `1px solid ${color}`,
        color,
        background: 'var(--bg-app)',
        fontSize: '0.66rem',
        fontWeight: 700,
        letterSpacing: '0.03em',
        whiteSpace: 'nowrap'
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {text}
    </span>
  )
}
