import { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck, Trash2, Moon, Sun, Eye } from 'lucide-react'
import { Card } from '../components/Card'
import { useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/palette'
import type { CredentialStatus, Exchange } from '../../shared/ipc'

const THEME_OPTIONS: { id: Theme; label: string; icon: typeof Moon }[] = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'colorblind', label: 'Colorblind', icon: Eye }
]

// Live trading is Binance-only for now (see the live-trading design plan) — this screen only
// offers credential management for exchanges that actually have a trading adapter, rather than
// implying live support that doesn't exist yet for the other 7.
const SUPPORTED_EXCHANGES: { id: Exchange; name: string }[] = [{ id: 'binance', name: 'Binance' }]

// electron's ipcRenderer.invoke wraps a thrown main-process error as
// "Error invoking remote method 'channel': Error: <message>" — strip that wrapper so the user
// sees the actual reason (e.g. "Binance API error: API-key format invalid.") instead of internals.
function cleanIpcErrorMessage(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '')
}

function fieldLabelStyle(): React.CSSProperties {
  return { fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem', display: 'block' }
}

function textInputStyle(): React.CSSProperties {
  return {
    width: '100%',
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.6rem 0.75rem',
    color: 'var(--text-primary)',
    fontSize: '0.85rem'
  }
}

function buttonStyle(kind: 'primary' | 'secondary' | 'danger'): React.CSSProperties {
  const base: React.CSSProperties = {
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: '0.55rem 0.9rem',
    fontSize: '0.8rem',
    fontWeight: 700,
    cursor: 'pointer'
  }
  if (kind === 'primary') return { ...base, background: 'linear-gradient(135deg, #7c86ff, #6366f1)', color: '#fff' }
  if (kind === 'danger') return { ...base, background: 'transparent', border: '1px solid var(--down)', color: 'var(--down)' }
  return { ...base, background: 'var(--bg-app)', border: '1px solid var(--border)', color: 'var(--text-primary)' }
}

function CredentialRow({
  exchangeId,
  exchangeName,
  status,
  onChanged
}: {
  exchangeId: Exchange
  exchangeName: string
  status: CredentialStatus | undefined
  onChanged: () => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [apiSecret, setApiSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  async function handleSave(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      await window.api.credentials.set(exchangeId, apiKey.trim(), apiSecret.trim())
      setApiKey('')
      setApiSecret('')
      setEditing(false)
      onChanged()
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      setMessage({ ok: false, text: cleanIpcErrorMessage(raw) })
    } finally {
      setBusy(false)
    }
  }

  async function handleTest(): Promise<void> {
    setBusy(true)
    setMessage(null)
    const result = await window.api.credentials.test(exchangeId)
    setMessage({ ok: result.ok, text: result.message })
    setBusy(false)
    onChanged()
  }

  async function handleRemove(): Promise<void> {
    setBusy(true)
    await window.api.credentials.remove(exchangeId)
    setBusy(false)
    onChanged()
  }

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.9rem', display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <KeyRound size={15} color="var(--text-secondary)" />
          <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.88rem' }}>{exchangeName}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: status?.configured ? 'var(--up)' : 'var(--text-muted)'
            }}
          />
          <span style={{ color: 'var(--text-secondary)' }}>{status?.configured ? 'Key configured' : 'No key configured'}</span>
        </div>
      </div>

      {status?.configured && !editing && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          Added {status.addedAt ? new Date(status.addedAt).toLocaleString() : '—'}
          {status.lastTestedAt && (
            <>
              {' · '}last tested {new Date(status.lastTestedAt).toLocaleString()} (
              <span style={{ color: status.lastTestOk ? 'var(--up)' : 'var(--down)' }}>{status.lastTestOk ? 'ok' : 'failed'}</span>)
            </>
          )}
        </div>
      )}

      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <div>
            <label style={fieldLabelStyle()}>API Key</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" style={textInputStyle()} />
          </div>
          <div>
            <label style={fieldLabelStyle()}>API Secret</label>
            <input type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} autoComplete="off" style={textInputStyle()} />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              onClick={handleSave}
              disabled={busy || !apiKey.trim() || !apiSecret.trim()}
              style={{ ...buttonStyle('primary'), opacity: busy || !apiKey.trim() || !apiSecret.trim() ? 0.6 : 1 }}
            >
              {busy ? 'Testing & saving…' : 'Test & Save'}
            </button>
            <button onClick={() => { setEditing(false); setMessage(null) }} disabled={busy} style={buttonStyle('secondary')}>
              Cancel
            </button>
          </div>
          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
            The key is verified with a real read-only account request before it's saved. A key that fails verification is
            never stored. Keys are encrypted at rest and never leave this device.
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => setEditing(true)} disabled={busy} style={buttonStyle('secondary')}>
            {status?.configured ? 'Edit key' : 'Add key'}
          </button>
          {status?.configured && (
            <>
              <button onClick={handleTest} disabled={busy} style={buttonStyle('secondary')}>
                Test
              </button>
              <button onClick={handleRemove} disabled={busy} style={buttonStyle('danger')}>
                <Trash2 size={13} style={{ verticalAlign: -2, marginRight: '0.3rem' }} />
                Remove
              </button>
            </>
          )}
        </div>
      )}

      {message && (
        <div style={{ fontSize: '0.78rem', color: message.ok ? 'var(--up)' : 'var(--down)' }}>{message.text}</div>
      )}
    </div>
  )
}

export function SettingsPanel(): React.JSX.Element {
  const [statuses, setStatuses] = useState<CredentialStatus[]>([])
  const { theme, setTheme } = useTheme()

  function refresh(): void {
    void window.api.credentials.list().then(setStatuses)
  }

  useEffect(() => {
    refresh()
  }, [])

  return (
    <>
      <Card title="Appearance">
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          {THEME_OPTIONS.map(({ id, label, icon: Icon }) => {
            const active = theme === id
            return (
              <button
                key={id}
                onClick={() => setTheme(id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.6rem 1rem',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-sm)',
                  background: active ? 'var(--accent-soft)' : 'var(--bg-app)',
                  color: active ? 'var(--accent)' : 'var(--text-primary)',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <Icon size={15} />
                {label}
              </button>
            )
          })}
        </div>
      </Card>

      <Card title="Live Trading — API Credentials">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.9rem' }}>
          <ShieldCheck size={15} color="var(--text-secondary)" style={{ flexShrink: 0, marginTop: 2 }} />
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
            No bot can place a real order today — real order execution isn't built yet. Keys added here are only used to
            verify they're valid; they aren't attached to any bot. Only Binance is supported so far.
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          {SUPPORTED_EXCHANGES.map((ex) => (
            <CredentialRow
              key={ex.id}
              exchangeId={ex.id}
              exchangeName={ex.name}
              status={statuses.find((s) => s.exchange === ex.id)}
              onChanged={refresh}
            />
          ))}
        </div>
      </Card>
    </>
  )
}
