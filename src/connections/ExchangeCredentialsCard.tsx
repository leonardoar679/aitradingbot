import { useEffect, useState } from 'react'
import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react'
import { Card } from '../components/Card'
import type { CredentialStatus, Exchange } from '../../shared/ipc'
import { cleanIpcErrorMessage } from '../utils/ipcError'
import { fieldLabelStyle, formButtonStyle, textInputStyle } from '../settings/formStyles'

// Live trading is Binance-only for now (see the live-trading design plan) — this card only
// offers credential management for exchanges that actually have a trading adapter, rather than
// implying live support that doesn't exist yet for the other 7.
// Exchanges a key can be stored for. Mirrors BALANCE_READERS in credentialsService -- the main
// process refuses anything not listed there, so the worst a drift here can do is offer a row that
// then says it cannot connect, never the reverse.
//
// The note on each is not decoration. Storing a key here used to mean one thing, because only
// Binance could be stored; now it means "this app can read your account", which is not the same
// as "this app can trade it", and the row is where that has to be said.
const SUPPORTED_EXCHANGES: { id: Exchange; name: string; note: string }[] = [
  {
    id: 'binance',
    name: 'Binance',
    note: 'Reads your balance, and is the only exchange this app can place a real order on.'
  },
  {
    id: 'upbit',
    name: 'Upbit',
    note:
      'Read-only here: this app shows your Upbit balance and never places an order on it, so a key with lookup permission alone is enough. Upbit also requires this machine\'s IP address to be on the key\'s allowlist.'
  }
]

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
    try {
      const result = await window.api.credentials.test(exchangeId)
      setMessage({ ok: result.ok, text: result.message })
      onChanged()
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      setMessage({ ok: false, text: cleanIpcErrorMessage(raw) })
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      await window.api.credentials.remove(exchangeId)
      onChanged()
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      setMessage({ ok: false, text: cleanIpcErrorMessage(raw) })
    } finally {
      setBusy(false)
    }
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
              style={{ ...formButtonStyle('primary'), opacity: busy || !apiKey.trim() || !apiSecret.trim() ? 0.6 : 1 }}
            >
              {busy ? 'Testing & saving…' : 'Test & Save'}
            </button>
            <button onClick={() => { setEditing(false); setMessage(null) }} disabled={busy} style={formButtonStyle('secondary')}>
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
          <button onClick={() => setEditing(true)} disabled={busy} style={formButtonStyle('secondary')}>
            {status?.configured ? 'Edit key' : 'Add key'}
          </button>
          {status?.configured && (
            <>
              <button onClick={handleTest} disabled={busy} style={formButtonStyle('secondary')}>
                Test
              </button>
              <button onClick={handleRemove} disabled={busy} style={formButtonStyle('danger')}>
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

/** The exchange keys: one row an exchange, each with whether a key is stored, when it was last
 * tested and how that went, and the buttons to add, test or remove it. */
export function ExchangeCredentialsCard(): React.JSX.Element {
  const [statuses, setStatuses] = useState<CredentialStatus[]>([])

  function refresh(): void {
    void window.api.credentials.list().then(setStatuses)
  }

  useEffect(() => {
    refresh()
  }, [])

  return (
    <Card title="Exchange API keys">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.9rem' }}>
        <ShieldCheck size={15} color="var(--text-secondary)" style={{ flexShrink: 0, marginTop: 2 }} />
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
          A verified key here can place real orders — only on Binance, only from an executor you explicitly created
          in live mode, and only once armed from the live trading bar at the top of the app. Five executor types can
          be created live: <strong>Order, Position, DCA, TWAP and Grid</strong>. DCA and Grid place a real resting
          order per ladder level, and TWAP keeps placing timed market buys on its own schedule — those three keep
          working <strong>while this app is open</strong>, without you watching it. Closing the app stops them: TWAP
          places no further slices and automatic exits stop being checked, but any resting order already on Binance
          stays live and can still fill. Live trading also has to be re-armed after every launch before an automatic
          exit can fire. XEMM, Arbitrage and Market Making are always paper, as is every bot.
        </p>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
        {SUPPORTED_EXCHANGES.map((ex) => (
          <div key={ex.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            <CredentialRow
              exchangeId={ex.id}
              exchangeName={ex.name}
              status={statuses.find((s) => s.exchange === ex.id)}
              onChanged={refresh}
            />
            <p style={{ margin: 0, fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              {ex.note}
            </p>
          </div>
        ))}
      </div>
    </Card>
  )
}
