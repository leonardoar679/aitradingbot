import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'

/** Without this, a render error anywhere unmounts the WHOLE React tree: React 18 deliberately
 * clears the root rather than leave a half-rendered UI up. Verified by running the app against a
 * settings file holding one executor of an unrecognised type -- the entire window went blank
 * (document.body.innerText === ''), taking the sidebar, every healthy executor, and the
 * live-trading bar's kill switch with it, and leaving no button to click back out of. For an app
 * that can have real money at risk that is the worst possible failure mode, so every page and
 * every headless scheduler is wrapped in one of these individually: a broken page stays a broken
 * page, and the frame around it keeps working.
 *
 * Caveat worth knowing when reading a bug report: this catches errors thrown while rendering, in
 * lifecycle methods, and in effect bodies. It does NOT catch errors inside event handlers or
 * inside a promise an effect kicked off -- those never reached the renderer's commit phase, and
 * React lets them go to window.onerror instead. */
export class ErrorBoundary extends Component<
  { label: string; children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the original stack reachable in devtools -- the fallback below only shows the message.
    console.error(`[${this.props.label}] render failed:`, error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (error === null) return this.props.children

    return (
      <div
        style={{
          background: 'var(--bg-surface)',
          border: '1px solid var(--down)',
          borderRadius: 'var(--radius-md)',
          padding: '1.25rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.7rem',
          maxWidth: '40rem'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--down)', fontWeight: 700 }}>
          <AlertTriangle size={16} />
          {this.props.label} could not be displayed
        </div>
        <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          Something in this section hit an error, so it has been replaced with this message instead
          of taking the rest of the app down with it. Everything outside this section still works
          normally, and no trading state was changed by this error.
        </div>
        <code
          style={{
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
            background: 'var(--bg-base)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.5rem 0.65rem',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}
        >
          {error.message || String(error)}
        </code>
        <div>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              padding: '0.45rem 0.8rem',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--bg-base)',
              color: 'var(--text-primary)',
              fontSize: '0.8rem',
              cursor: 'pointer'
            }}
          >
            <RotateCcw size={13} />
            Try again
          </button>
        </div>
      </div>
    )
  }
}
