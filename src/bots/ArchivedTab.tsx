import { Bot as BotIcon, RotateCcw, Trash2 } from 'lucide-react'
import { EXCHANGES } from '../../shared/ipc'
import { resolvedStrategy, type Bot } from './types'

export function ArchivedTab({
  bots,
  onRestore,
  onDelete
}: {
  bots: Bot[]
  onRestore: (id: string) => void
  onDelete: (id: string) => void
}): React.JSX.Element {
  if (bots.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: '0.9rem 0 0' }}>
        No archived bots. Archiving a bot from the Active tab keeps its Runs history and moves it here.
      </p>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', marginTop: '0.9rem' }}>
      {bots.map((bot) => {
        const exchangeName = EXCHANGES.find((e) => e.id === bot.exchange)?.name ?? bot.exchange
        return (
          <div
            key={bot.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: '1rem',
              padding: '0.75rem 1rem',
              background: 'var(--bg-app)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', minWidth: 0 }}>
              <div
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: '50%',
                  background: 'var(--bg-surface-hover)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0
                }}
              >
                <BotIcon size={14} color="var(--text-muted)" />
              </div>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.88rem' }}>{bot.name}</div>
                <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {exchangeName} • {bot.baseAsset}-{bot.quoteAsset} • {resolvedStrategy(bot).name}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
              <button
                onClick={() => onRestore(bot.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.4rem 0.7rem',
                  color: 'var(--text-primary)',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <RotateCcw size={13} /> Restore
              </button>
              <button
                onClick={() => onDelete(bot.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.35rem',
                  background: 'transparent',
                  border: '1px solid var(--down)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0.4rem 0.7rem',
                  color: 'var(--down)',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <Trash2 size={13} /> Delete Permanently
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
