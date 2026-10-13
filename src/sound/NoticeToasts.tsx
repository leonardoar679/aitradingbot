import { useEffect, useState } from 'react'
import type { SoundName } from '../../shared/sounds'

// WHAT A SOUND MEANS, SHOWN (the V6 document, §80; V6 Stage 13): every notice the window hears, and every
// one it does not, is shown here for a few seconds, bottom right -- never sound alone. CRITICAL has its
// banner (src/news/AlertBanner.tsx) and is not repeated here.

export interface Toast {
  id: string
  title: string
  body: string
  sound: SoundName | null
}

/** How long a toast stays, and how many are shown at once. */
const TOAST_MS = 8000
const MAX_TOASTS = 4

let toasts: Toast[] = []
const listeners = new Set<(list: Toast[]) => void>()

function told(): void {
  for (const listener of listeners) listener(toasts)
}

export function showToast(toast: Toast): void {
  toasts = [...toasts.filter((entry) => entry.id !== toast.id), toast].slice(-MAX_TOASTS)
  told()
  setTimeout(() => {
    toasts = toasts.filter((entry) => entry.id !== toast.id)
    told()
  }, TOAST_MS)
}

const ACCENT: Record<SoundName, string> = { information: 'var(--accent)', opportunity: 'var(--up)', warning: 'var(--gold)', critical: 'var(--down)' }

export function NoticeToasts(): React.JSX.Element | null {
  const [list, setList] = useState<Toast[]>(toasts)
  useEffect(() => {
    listeners.add(setList)
    return (): void => void listeners.delete(setList)
  }, [])
  if (list.length === 0) return null
  return (
    <div aria-live="polite" style={{ position: 'fixed', right: '1rem', bottom: '1rem', zIndex: 60, display: 'grid', gap: '0.5rem', width: 'min(22rem, calc(100vw - 2rem))' }}>
      {list.map((toast) => (
        <div
          key={toast.id}
          role="status"
          onClick={() => {
            toasts = toasts.filter((entry) => entry.id !== toast.id)
            told()
          }}
          style={{
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderLeft: `3px solid ${toast.sound === null ? 'var(--border)' : ACCENT[toast.sound]}`,
            borderRadius: 'var(--radius-sm)',
            boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
            padding: '0.55rem 0.75rem',
            cursor: 'pointer'
          }}
        >
          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{toast.title}</div>
          <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: '0.15rem', lineHeight: 1.45 }}>{toast.body}</div>
        </div>
      ))}
    </div>
  )
}
