import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  icon: LucideIcon
  label: string
  value: string
  valueColor?: string
  sub?: string
  subColor?: string
  /** A value in words rather than a figure: it wraps instead of being cut, since a translation may run
   * longer than the English (V6 Stage 14). A figure is never broken. */
  wraps?: boolean
}

export function StatCard({
  icon: Icon,
  label,
  value,
  valueColor,
  sub,
  subColor,
  wraps = false
}: StatCardProps): React.JSX.Element {
  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '1.1rem 1.25rem',
        flex: '1 1 200px',
        minWidth: 0
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.4rem',
          color: 'var(--text-muted)',
          fontSize: '0.68rem',
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase'
        }}
      >
        <Icon size={13} />
        {label}
      </div>
      <div
        style={{
          marginTop: '0.5rem',
          fontSize: '1.4rem',
          fontWeight: 700,
          color: valueColor ?? 'var(--text-primary)',
          ...(wraps ? { lineHeight: 1.3 } : { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' })
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ marginTop: '0.2rem', fontSize: '0.75rem', fontWeight: 600, color: subColor ?? 'var(--text-secondary)' }}>
          {sub}
        </div>
      )}
    </section>
  )
}
