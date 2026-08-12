import { useEffect, useRef, useState } from 'react'
import { LineChart } from 'lucide-react'
import { Toggle } from '../Toggle'

export interface IndicatorSettings {
  ema: boolean
  rsi: boolean
  macd: boolean
}

interface IndicatorsPopoverProps {
  settings: IndicatorSettings
  onToggle: (key: keyof IndicatorSettings) => void
}

export function IndicatorsPopover({ settings, onToggle }: IndicatorsPopoverProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      <button
        title="Indicators"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          background: open ? 'var(--bg-app)' : 'transparent',
          color: open ? 'var(--text-primary)' : 'var(--text-secondary)',
          border: `1px solid ${open ? 'var(--border)' : 'transparent'}`,
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer'
        }}
      >
        <LineChart size={15} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 0.4rem)',
            left: 0,
            width: 210,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.6rem',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            zIndex: 20
          }}
        >
          <div
            style={{
              fontSize: '0.68rem',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--text-secondary)',
              marginBottom: '0.4rem'
            }}
          >
            Indicators
          </div>
          <Row label="EMA (20)" on={settings.ema} onToggle={() => onToggle('ema')} />
          <Row label="RSI (14)" on={settings.rsi} onToggle={() => onToggle('rsi')} />
          <Row label="MACD (12, 26, 9)" on={settings.macd} onToggle={() => onToggle('macd')} />
        </div>
      )}
    </div>
  )
}

function Row({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0.35rem 0',
        fontSize: '0.8rem',
        color: 'var(--text-primary)'
      }}
    >
      <span>{label}</span>
      <Toggle on={on} onChange={onToggle} />
    </div>
  )
}
