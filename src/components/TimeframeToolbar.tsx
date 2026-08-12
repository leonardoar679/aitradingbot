import { useState } from 'react'
import { Calendar } from 'lucide-react'
import { INTERVALS, type Interval } from '../../shared/ipc'
import { TimeToolsModal, type TimeAnchorSettings } from './timeTools/TimeToolsModal'
import { IndicatorsPopover, type IndicatorSettings } from './indicators/IndicatorsPopover'

interface TimeframeToolbarProps {
  interval: Interval
  onSelect: (interval: Interval) => void
  onJumpToDate: (date: Date) => void
  onSetRange: (from: Date, to: Date) => void
  anchorSettings: TimeAnchorSettings
  onAnchorSettingsChange: (settings: TimeAnchorSettings) => void
  indicatorSettings: IndicatorSettings
  onIndicatorToggle: (key: keyof IndicatorSettings) => void
}

export function TimeframeToolbar({
  interval,
  onSelect,
  onJumpToDate,
  onSetRange,
  anchorSettings,
  onAnchorSettingsChange,
  indicatorSettings,
  onIndicatorToggle
}: TimeframeToolbarProps): React.JSX.Element {
  const [modalOpen, setModalOpen] = useState(false)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.9rem',
        marginBottom: '0.9rem',
        paddingBottom: '0.75rem',
        borderBottom: '1px solid var(--border)'
      }}
    >
      <span
        style={{
          fontSize: '0.7rem',
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--text-secondary)'
        }}
      >
        Time
      </span>
      <div style={{ display: 'flex', gap: '0.25rem' }}>
        {INTERVALS.map((tf) => {
          const active = tf.id === interval
          return (
            <button
              key={tf.id}
              onClick={() => onSelect(tf.id)}
              style={{
                background: active ? 'var(--bg-app)' : 'transparent',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                border: `1px solid ${active ? 'var(--border)' : 'transparent'}`,
                borderRadius: 'var(--radius-sm)',
                padding: '0.3rem 0.65rem',
                fontSize: '0.78rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              {tf.label}
            </button>
          )
        })}
      </div>

      <button
        title="Time Tools"
        onClick={() => setModalOpen(true)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          background: modalOpen ? 'var(--bg-app)' : 'transparent',
          color: modalOpen ? 'var(--text-primary)' : 'var(--text-secondary)',
          border: `1px solid ${modalOpen ? 'var(--border)' : 'transparent'}`,
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer'
        }}
      >
        <Calendar size={15} />
      </button>

      <IndicatorsPopover settings={indicatorSettings} onToggle={onIndicatorToggle} />

      {modalOpen && (
        <TimeToolsModal
          onClose={() => setModalOpen(false)}
          onGoToDate={onJumpToDate}
          onSetRange={onSetRange}
          anchorSettings={anchorSettings}
          onAnchorSettingsChange={onAnchorSettingsChange}
        />
      )}
    </div>
  )
}
