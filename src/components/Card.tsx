import type { PropsWithChildren } from 'react'

export function Card({
  title,
  actions,
  children
}: PropsWithChildren<{
  /** Text, or text with a value shown as written in it (V8 Stage 8: a trader's address on Copy Traders). */
  title: React.ReactNode
  /** Optional control rendered on the header row, right-aligned -- a Refresh button and the
   * like. Optional so every existing Card is unchanged. */
  actions?: React.ReactNode
}>): React.JSX.Element {
  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '1.25rem'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0 0 0.9rem' }}>
        <h2
          style={{
            margin: 0,
            fontSize: '0.7rem',
            fontWeight: 600,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: 'var(--text-secondary)'
          }}
        >
          {title}
        </h2>
        {actions !== undefined && <div style={{ marginInlineStart: 'auto' }}>{actions}</div>}
      </div>
      {children}
    </section>
  )
}
