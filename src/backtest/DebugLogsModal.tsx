import { X } from 'lucide-react'

interface DebugLogsModalProps {
  logLines: string[]
  onClose: () => void
}

export function DebugLogsModal({ logLines, onClose }: DebugLogsModalProps): React.JSX.Element {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 300,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 640,
          maxHeight: '70vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0.9rem 1.1rem',
            borderBottom: '1px solid var(--border)'
          }}
        >
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Debugging Logs</span>
          <button
            onClick={onClose}
            style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            <X size={18} />
          </button>
        </div>
        <div
          style={{
            overflowY: 'auto',
            padding: '0.9rem 1.1rem',
            fontFamily: 'ui-monospace, monospace',
            fontSize: '0.78rem',
            color: 'var(--text-secondary)',
            lineHeight: 1.7
          }}
        >
          {logLines.length === 0 ? (
            <span>No log entries.</span>
          ) : (
            logLines.map((line, i) => <div key={i}>{line}</div>)
          )}
        </div>
      </div>
    </div>
  )
}
