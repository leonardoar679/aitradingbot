// The field, input and button styles the key and limit cards share. They were one file's private
// helpers until those cards moved to Connections and Risk & Safety.

export function fieldLabelStyle(): React.CSSProperties {
  return { fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem', display: 'block' }
}

export function textInputStyle(): React.CSSProperties {
  return {
    width: '100%',
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.6rem 0.75rem',
    color: 'var(--text-primary)',
    fontSize: '0.85rem'
  }
}

export function formButtonStyle(kind: 'primary' | 'secondary' | 'danger'): React.CSSProperties {
  const base: React.CSSProperties = {
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: '0.55rem 0.9rem',
    fontSize: '0.8rem',
    fontWeight: 700,
    cursor: 'pointer'
  }
  if (kind === 'primary') return { ...base, background: 'linear-gradient(135deg, #7c86ff, #6366f1)', color: '#fff' }
  if (kind === 'danger') return { ...base, background: 'transparent', border: '1px solid var(--down)', color: 'var(--down)' }
  return { ...base, background: 'var(--bg-app)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
}
