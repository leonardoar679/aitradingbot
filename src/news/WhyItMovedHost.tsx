import { useEffect, useState } from 'react'
import { closeWhy, openWhy, subscribeWhy } from './whyStore'
import { WhyItMoved } from './WhyItMoved'

/** The one "Why did it move?" panel, over whichever page asked for it (./whyStore.ts). Escape or
 * the backdrop closes it. */
export function WhyItMovedHost(): React.JSX.Element | null {
  const [symbol, setSymbol] = useState<string | null>(null)
  useEffect(() => subscribeWhy(setSymbol), [])
  useEffect(() => {
    if (symbol === null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeWhy()
    }
    window.addEventListener('keydown', onKey)
    return (): void => window.removeEventListener('keydown', onKey)
  }, [symbol])
  if (symbol === null) return null
  return (
    <div
      onClick={closeWhy}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '8vh 16px', zIndex: 50 }}
    >
      <div
        role="dialog"
        aria-label={`Why did ${symbol} move?`}
        onClick={(event) => event.stopPropagation()}
        style={{ width: 'min(760px, 100%)', maxHeight: '80vh', overflowY: 'auto', background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '1.1rem 1.25rem' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.8rem' }}>
          <h2 style={{ margin: 0, fontSize: '1rem', color: 'var(--text-primary)' }}>Why did {symbol} move?</h2>
          <button onClick={closeWhy} style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.25rem 0.7rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
            Close
          </button>
        </div>
        <WhyItMoved symbol={symbol} />
      </div>
    </div>
  )
}

/** The button that opens it, for a pair. */
export function WhyButton({ symbol, compact = false }: { symbol: string; compact?: boolean }): React.JSX.Element {
  return (
    <button
      onClick={() => openWhy(symbol)}
      title={`Why did ${symbol} move?`}
      style={{
        background: 'none',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: compact ? '0.1rem 0.45rem' : '0.3rem 0.7rem',
        fontSize: compact ? '0.7rem' : '0.78rem',
        color: 'var(--text-secondary)',
        cursor: 'pointer',
        whiteSpace: 'nowrap'
      }}
    >
      Why?
    </button>
  )
}
