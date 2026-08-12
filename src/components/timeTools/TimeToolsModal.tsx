import { useState } from 'react'
import { X, CalendarDays, ArrowRight } from 'lucide-react'
import { Calendar, isSameDay, type DayState } from './Calendar'
import { WheelColumn } from './WheelColumn'
import { Toggle } from '../Toggle'

export interface TimeAnchorSettings {
  enabled: boolean
  anchorLine: boolean
  acrossTokens: boolean
}

interface TimeToolsModalProps {
  onClose: () => void
  onGoToDate: (date: Date) => void
  onSetRange: (from: Date, to: Date) => void
  anchorSettings: TimeAnchorSettings
  onAnchorSettingsChange: (settings: TimeAnchorSettings) => void
}

type Tab = 'goToDate' | 'timeRange' | 'timeAnchor'

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function formatDateTime(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function withDatePart(base: Date, dayPart: Date): Date {
  return new Date(
    dayPart.getFullYear(),
    dayPart.getMonth(),
    dayPart.getDate(),
    base.getHours(),
    base.getMinutes(),
    base.getSeconds()
  )
}

function withHour(date: Date, hour: number): Date {
  const next = new Date(date)
  next.setHours(hour)
  return next
}
function withMinute(date: Date, minute: number): Date {
  const next = new Date(date)
  next.setMinutes(minute)
  return next
}
function withSecond(date: Date, second: number): Date {
  const next = new Date(date)
  next.setSeconds(second)
  return next
}

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    background: 'transparent',
    border: 'none',
    padding: '0.9rem 1.1rem',
    fontSize: '0.85rem',
    fontWeight: active ? 700 : 500,
    color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
    cursor: 'pointer',
    borderBottom: `2px solid ${active ? '#f0b90b' : 'transparent'}`
  }
}

function fieldStyle(): React.CSSProperties {
  return {
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.55rem 0.75rem',
    fontSize: '0.82rem',
    color: 'var(--text-primary)'
  }
}

export function TimeToolsModal({
  onClose,
  onGoToDate,
  onSetRange,
  anchorSettings,
  onAnchorSettingsChange
}: TimeToolsModalProps): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('goToDate')
  const today = new Date()

  const [gtdValue, setGtdValue] = useState<Date>(today)
  const [gtdViewMonth, setGtdViewMonth] = useState<Date>(today)

  const [rangeFrom, setRangeFrom] = useState<Date>(() => {
    const d = new Date(today)
    d.setMonth(d.getMonth() - 1)
    return d
  })
  const [rangeTo, setRangeTo] = useState<Date>(today)
  const [rangeViewMonth, setRangeViewMonth] = useState<Date>(today)
  const [activeRangeField, setActiveRangeField] = useState<'from' | 'to'>('to')

  const [draftAnchor, setDraftAnchor] = useState<TimeAnchorSettings>(anchorSettings)

  function handleConfirm(): void {
    if (tab === 'goToDate') {
      onGoToDate(gtdValue)
    } else if (tab === 'timeRange') {
      onSetRange(rangeFrom, rangeTo)
    } else {
      onAnchorSettingsChange(draftAnchor)
    }
    onClose()
  }

  function goToDateDayState(date: Date): DayState {
    return {
      isToday: isSameDay(date, today),
      isSelected: isSameDay(date, gtdValue),
      isRangeStart: false,
      isRangeEnd: false,
      isInRange: false,
      isCurrentMonth: date.getMonth() === gtdViewMonth.getMonth()
    }
  }

  function rangeDayState(date: Date): DayState {
    const startDay = new Date(rangeFrom.getFullYear(), rangeFrom.getMonth(), rangeFrom.getDate())
    const endDay = new Date(rangeTo.getFullYear(), rangeTo.getMonth(), rangeTo.getDate())
    const [lo, hi] = startDay.getTime() <= endDay.getTime() ? [startDay, endDay] : [endDay, startDay]
    const dayOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate())
    return {
      isToday: isSameDay(date, today),
      isSelected: false,
      isRangeStart: isSameDay(dayOnly, lo),
      isRangeEnd: isSameDay(dayOnly, hi),
      isInRange: dayOnly.getTime() > lo.getTime() && dayOnly.getTime() < hi.getTime(),
      isCurrentMonth: date.getMonth() === rangeViewMonth.getMonth()
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 380,
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.5)'
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border)',
            paddingRight: '1rem'
          }}
        >
          <div style={{ display: 'flex' }}>
            <button style={tabButtonStyle(tab === 'goToDate')} onClick={() => setTab('goToDate')}>
              Go to Date
            </button>
            <button style={tabButtonStyle(tab === 'timeRange')} onClick={() => setTab('timeRange')}>
              Time Range
            </button>
            <button style={tabButtonStyle(tab === 'timeAnchor')} onClick={() => setTab('timeAnchor')}>
              Time Anchor
            </button>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'flex'
            }}
          >
            <X size={16} />
          </button>
        </div>

        <div style={{ padding: '1rem' }}>
          {tab === 'goToDate' && (
            <>
              <div style={{ ...fieldStyle(), marginBottom: '0.9rem' }}>
                <span>{formatDateTime(gtdValue)}</span>
                <CalendarDays size={14} color="var(--text-secondary)" />
              </div>
              <Calendar
                viewMonth={gtdViewMonth}
                onViewMonthChange={setGtdViewMonth}
                getDayState={goToDateDayState}
                onDayClick={(date) => setGtdValue((prev) => withDatePart(prev, date))}
              />
              <div style={{ display: 'flex', justifyContent: 'center', gap: '0.6rem', marginTop: '0.75rem' }}>
                <WheelColumn value={gtdValue.getHours()} max={24} onChange={(h) => setGtdValue((p) => withHour(p, h))} />
                <WheelColumn
                  value={gtdValue.getMinutes()}
                  max={60}
                  onChange={(m) => setGtdValue((p) => withMinute(p, m))}
                />
                <WheelColumn
                  value={gtdValue.getSeconds()}
                  max={60}
                  onChange={(s) => setGtdValue((p) => withSecond(p, s))}
                />
              </div>
            </>
          )}

          {tab === 'timeRange' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.9rem' }}>
                <div
                  style={{
                    ...fieldStyle(),
                    border: `1px solid ${activeRangeField === 'from' ? '#f0b90b' : 'var(--border)'}`,
                    cursor: 'pointer'
                  }}
                  onClick={() => setActiveRangeField('from')}
                >
                  <span>{formatDateTime(rangeFrom)}</span>
                </div>
                <ArrowRight size={14} color="var(--text-secondary)" />
                <div
                  style={{
                    ...fieldStyle(),
                    border: `1px solid ${activeRangeField === 'to' ? '#f0b90b' : 'var(--border)'}`,
                    cursor: 'pointer'
                  }}
                  onClick={() => setActiveRangeField('to')}
                >
                  <span>{formatDateTime(rangeTo)}</span>
                </div>
              </div>
              <Calendar
                viewMonth={rangeViewMonth}
                onViewMonthChange={setRangeViewMonth}
                getDayState={rangeDayState}
                onDayClick={(date) => {
                  if (activeRangeField === 'from') setRangeFrom((prev) => withDatePart(prev, date))
                  else setRangeTo((prev) => withDatePart(prev, date))
                }}
              />
              <div style={{ display: 'flex', justifyContent: 'center', gap: '0.6rem', marginTop: '0.75rem' }}>
                <WheelColumn
                  value={activeRangeField === 'from' ? rangeFrom.getHours() : rangeTo.getHours()}
                  max={24}
                  onChange={(h) =>
                    activeRangeField === 'from'
                      ? setRangeFrom((p) => withHour(p, h))
                      : setRangeTo((p) => withHour(p, h))
                  }
                />
                <WheelColumn
                  value={activeRangeField === 'from' ? rangeFrom.getMinutes() : rangeTo.getMinutes()}
                  max={60}
                  onChange={(m) =>
                    activeRangeField === 'from'
                      ? setRangeFrom((p) => withMinute(p, m))
                      : setRangeTo((p) => withMinute(p, m))
                  }
                />
                <WheelColumn
                  value={activeRangeField === 'from' ? rangeFrom.getSeconds() : rangeTo.getSeconds()}
                  max={60}
                  onChange={(s) =>
                    activeRangeField === 'from'
                      ? setRangeFrom((p) => withSecond(p, s))
                      : setRangeTo((p) => withSecond(p, s))
                  }
                />
              </div>
            </>
          )}

          {tab === 'timeAnchor' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Time Anchor</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                    Anchor to a time on the chart when switching between intervals
                  </div>
                </div>
                <Toggle
                  on={draftAnchor.enabled}
                  onChange={(enabled) => setDraftAnchor((prev) => ({ ...prev, enabled }))}
                />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Anchor Point</div>
                <div
                  style={{
                    fontSize: '0.78rem',
                    color: draftAnchor.enabled ? 'var(--text-primary)' : 'var(--text-muted)',
                    background: 'var(--bg-app)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    padding: '0.3rem 0.6rem'
                  }}
                >
                  Date
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Anchor line</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                    Mark the anchored time on the chart with a vertical line
                  </div>
                </div>
                <Toggle
                  on={draftAnchor.anchorLine}
                  onChange={(anchorLine) => setDraftAnchor((prev) => ({ ...prev, anchorLine }))}
                />
              </div>

              <div style={{ borderTop: '1px solid var(--border)' }} />

              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>Across Tokens</div>
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', marginTop: '0.15rem' }}>
                    Retain onscreen chart range when switching between symbols
                  </div>
                </div>
                <Toggle
                  on={draftAnchor.acrossTokens}
                  onChange={(acrossTokens) => setDraftAnchor((prev) => ({ ...prev, acrossTokens }))}
                />
              </div>
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: '0.6rem',
            padding: '0.9rem 1rem',
            borderTop: '1px solid var(--border)'
          }}
        >
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-secondary)',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: 'pointer',
              padding: '0.5rem 1rem'
            }}
          >
            Close
          </button>
          <button
            onClick={handleConfirm}
            style={{
              background: '#f0b90b',
              border: 'none',
              color: '#0b0e11',
              fontSize: '0.82rem',
              fontWeight: 700,
              cursor: 'pointer',
              borderRadius: 'var(--radius-sm)',
              padding: '0.5rem 1.2rem'
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
