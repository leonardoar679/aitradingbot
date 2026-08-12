import { useEffect, useRef } from 'react'
import { ChevronUp, ChevronDown } from 'lucide-react'

const ITEM_HEIGHT = 28
const VISIBLE_ITEMS = 3
const CONTAINER_HEIGHT = ITEM_HEIGHT * VISIBLE_ITEMS
const PADDING = ITEM_HEIGHT * Math.floor(VISIBLE_ITEMS / 2)

interface WheelColumnProps {
  value: number
  max: number
  onChange: (value: number) => void
}

export function WheelColumn({ value, max, onChange }: WheelColumnProps): React.JSX.Element {
  const listRef = useRef<HTMLDivElement>(null)
  const scrollTimeout = useRef<number | null>(null)
  const suppressNextScroll = useRef(false)

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const target = value * ITEM_HEIGHT
    if (Math.abs(el.scrollTop - target) > 1) {
      suppressNextScroll.current = true
      el.scrollTo({ top: target })
    }
  }, [value])

  function handleScroll(): void {
    if (suppressNextScroll.current) {
      suppressNextScroll.current = false
      return
    }
    const el = listRef.current
    if (!el) return
    if (scrollTimeout.current) window.clearTimeout(scrollTimeout.current)
    scrollTimeout.current = window.setTimeout(() => {
      const idx = Math.round(el.scrollTop / ITEM_HEIGHT)
      const clamped = Math.max(0, Math.min(max - 1, idx))
      if (clamped !== value) onChange(clamped)
    }, 100)
  }

  function step(delta: number): void {
    onChange((value + delta + max) % max)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.15rem' }}>
      <button
        onClick={() => step(1)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          padding: '0.1rem'
        }}
      >
        <ChevronUp size={13} />
      </button>
      <div
        ref={listRef}
        onScroll={handleScroll}
        style={{
          height: CONTAINER_HEIGHT,
          width: 44,
          overflowY: 'auto',
          scrollSnapType: 'y mandatory',
          scrollbarWidth: 'thin'
        }}
      >
        <div style={{ height: PADDING }} />
        {Array.from({ length: max }, (_, i) => (
          <div
            key={i}
            onClick={() => onChange(i)}
            style={{
              height: ITEM_HEIGHT,
              scrollSnapAlign: 'center',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.8rem',
              fontWeight: i === value ? 700 : 500,
              color: i === value ? 'var(--text-primary)' : 'var(--text-muted)',
              background: i === value ? 'var(--bg-app)' : 'transparent',
              borderRadius: i === value ? 'var(--radius-sm)' : 0,
              cursor: 'pointer'
            }}
          >
            {String(i).padStart(2, '0')}
          </div>
        ))}
        <div style={{ height: PADDING }} />
      </div>
      <button
        onClick={() => step(-1)}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-secondary)',
          cursor: 'pointer',
          padding: '0.1rem'
        }}
      >
        <ChevronDown size={13} />
      </button>
    </div>
  )
}
