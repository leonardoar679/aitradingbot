export function fieldLabelStyle(): React.CSSProperties {
  return { fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem', display: 'block' }
}

export function textInputStyle(): React.CSSProperties {
  return {
    width: '100%',
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.55rem 0.7rem',
    color: 'var(--text-primary)',
    fontSize: '0.85rem'
  }
}

export function sideButtonStyle(active: boolean, side: 'buy' | 'sell'): React.CSSProperties {
  const color = side === 'buy' ? 'var(--up)' : 'var(--down)'
  return {
    flex: 1,
    padding: '0.5rem',
    fontSize: '0.8rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    border: `1px solid ${active ? color : 'var(--border)'}`,
    borderRadius: 'var(--radius-sm)',
    background: active ? color : 'transparent',
    color: active ? '#0b0e11' : 'var(--text-secondary)',
    cursor: 'pointer'
  }
}
