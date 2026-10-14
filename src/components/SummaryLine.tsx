/** One label and its value, ruled off from the next: the rows of a summary card. */
export function SummaryLine({
  label,
  value,
  tone
}: {
  label: string
  value: React.ReactNode
  tone?: 'up' | 'down' | 'gold' | 'muted'
}): React.JSX.Element {
  const color =
    tone === undefined ? 'var(--text-primary)' : tone === 'gold' ? 'var(--gold)' : tone === 'muted' ? 'var(--text-muted)' : `var(--${tone})`
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: '1rem',
        padding: '0.35rem 0',
        borderBottom: '1px solid var(--border)',
        fontSize: '0.82rem'
      }}
    >
      <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{label}</span>
      <span style={{ fontWeight: 600, color, textAlign: 'end' }}>{value}</span>
    </div>
  )
}
