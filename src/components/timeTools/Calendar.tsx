import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
]

export interface DayState {
  isToday: boolean
  isSelected: boolean
  isRangeStart: boolean
  isRangeEnd: boolean
  isInRange: boolean
  isCurrentMonth: boolean
}

interface CalendarProps {
  viewMonth: Date
  onViewMonthChange: (nextMonth: Date) => void
  getDayState: (date: Date) => DayState
  onDayClick: (date: Date) => void
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function buildGridDays(viewMonth: Date): Date[] {
  const year = viewMonth.getFullYear()
  const month = viewMonth.getMonth()
  const firstOfMonth = new Date(year, month, 1)
  const gridStart = new Date(year, month, 1 - firstOfMonth.getDay())
  return Array.from(
    { length: 42 },
    (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i)
  )
}

function navButtonStyle(): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 24,
    height: 24,
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    borderRadius: 'var(--radius-sm)'
  }
}

export function Calendar({
  viewMonth,
  onViewMonthChange,
  getDayState,
  onDayClick
}: CalendarProps): React.JSX.Element {
  const days = buildGridDays(viewMonth)

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: '0.6rem'
        }}
      >
        <div style={{ display: 'flex', gap: '0.1rem' }}>
          <button
            style={navButtonStyle()}
            onClick={() => onViewMonthChange(new Date(viewMonth.getFullYear() - 1, viewMonth.getMonth(), 1))}
          >
            <ChevronsLeft size={14} />
          </button>
          <button
            style={navButtonStyle()}
            onClick={() => onViewMonthChange(new Date(viewMonth.getFullYear(), viewMonth.getMonth() - 1, 1))}
          >
            <ChevronLeft size={14} />
          </button>
        </div>
        <div style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-primary)' }}>
          {MONTH_LABELS[viewMonth.getMonth()]} {viewMonth.getFullYear()}
        </div>
        <div style={{ display: 'flex', gap: '0.1rem' }}>
          <button
            style={navButtonStyle()}
            onClick={() => onViewMonthChange(new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 1))}
          >
            <ChevronRight size={14} />
          </button>
          <button
            style={navButtonStyle()}
            onClick={() => onViewMonthChange(new Date(viewMonth.getFullYear() + 1, viewMonth.getMonth(), 1))}
          >
            <ChevronsRight size={14} />
          </button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px 0' }}>
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            style={{
              textAlign: 'center',
              fontSize: '0.68rem',
              color: 'var(--text-muted)',
              padding: '0.2rem 0'
            }}
          >
            {label}
          </div>
        ))}

        {days.map((date) => {
          const state = getDayState(date)
          const isWeekStart = date.getDay() === 0
          const isWeekEnd = date.getDay() === 6
          return (
            <button
              key={date.toISOString()}
              onClick={() => onDayClick(date)}
              style={{
                position: 'relative',
                height: 30,
                border: 'none',
                cursor: 'pointer',
                fontSize: '0.78rem',
                fontWeight: state.isToday || state.isSelected ? 700 : 500,
                color: !state.isCurrentMonth
                  ? 'var(--text-muted)'
                  : state.isSelected || state.isRangeStart || state.isRangeEnd
                    ? '#0b0e11'
                    : state.isInRange
                      ? 'var(--text-primary)'
                      : 'var(--text-primary)',
                background: state.isSelected || state.isRangeStart || state.isRangeEnd
                  ? '#f0b90b'
                  : state.isInRange
                    ? 'rgba(240,185,11,0.18)'
                    : 'transparent',
                borderRadius:
                  state.isSelected || (state.isRangeStart && state.isRangeEnd)
                    ? 'var(--radius-sm)'
                    : state.isRangeStart
                      ? 'var(--radius-sm) 0 0 var(--radius-sm)'
                      : state.isRangeEnd
                        ? '0 var(--radius-sm) var(--radius-sm) 0'
                        : state.isInRange && !isWeekStart && !isWeekEnd
                          ? 0
                          : state.isInRange && isWeekStart
                            ? 'var(--radius-sm) 0 0 var(--radius-sm)'
                            : state.isInRange && isWeekEnd
                              ? '0 var(--radius-sm) var(--radius-sm) 0'
                              : 'var(--radius-sm)',
                outline: state.isToday && !state.isSelected ? '1px solid var(--border-strong)' : 'none',
                outlineOffset: -1
              }}
            >
              {date.getDate()}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export { isSameDay }
