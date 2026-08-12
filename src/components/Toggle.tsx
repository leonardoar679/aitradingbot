function toggleTrackStyle(on: boolean): React.CSSProperties {
  return {
    width: 34,
    height: 18,
    borderRadius: 999,
    background: on ? '#f0b90b' : 'var(--border-strong)',
    position: 'relative',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background 0.15s ease'
  }
}

function toggleKnobStyle(on: boolean): React.CSSProperties {
  return {
    position: 'absolute',
    top: 2,
    left: on ? 18 : 2,
    width: 14,
    height: 14,
    borderRadius: '50%',
    background: on ? '#0b0e11' : 'var(--text-secondary)',
    transition: 'left 0.15s ease'
  }
}

interface ToggleProps {
  on: boolean
  onChange: (next: boolean) => void
}

export function Toggle({ on, onChange }: ToggleProps): React.JSX.Element {
  return (
    <div style={toggleTrackStyle(on)} onClick={() => onChange(!on)}>
      <div style={toggleKnobStyle(on)} />
    </div>
  )
}
