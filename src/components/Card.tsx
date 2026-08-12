import type { PropsWithChildren } from 'react'

export function Card({ title, children }: PropsWithChildren<{ title: string }>): React.JSX.Element {
  return (
    <section
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '1.25rem'
      }}
    >
      <h2
        style={{
          margin: '0 0 0.9rem',
          fontSize: '0.7rem',
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)'
        }}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}
