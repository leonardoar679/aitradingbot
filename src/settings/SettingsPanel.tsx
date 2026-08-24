import { useEffect, useState } from 'react'
import { describeFeeRateMismatch } from '../../shared/observedFee'
import { KeyRound, ShieldCheck, Trash2, Moon, Sun, Eye, AlertTriangle } from 'lucide-react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/palette'
import type { CredentialStatus, Exchange, LiveTradingStatus } from '../../shared/ipc'
import { cleanIpcErrorMessage } from '../utils/ipcError'

const THEME_OPTIONS: { id: Theme; label: string; icon: typeof Moon }[] = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'colorblind', label: 'Colorblind', icon: Eye }
]

// Live trading is Binance-only for now (see the live-trading design plan) — this screen only
// offers credential management for exchanges that actually have a trading adapter, rather than
// implying live support that doesn't exist yet for the other 7.
const SUPPORTED_EXCHANGES: { id: Exchange; name: string }[] = [{ id: 'binance', name: 'Binance' }]

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
      {/* Every other page renders a PageHeader; this one went straight into its first card, so it
          was the only screen in the app with no title at all. */}
      <PageHeader title="Settings" subtitle="Appearance, exchange API credentials, and live trading risk limits" />

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

      <LiveTradingLimitsCard />
    </>
  )
}

function LiveTradingLimitsCard(): React.JSX.Element {
  const [status, setStatus] = useState<LiveTradingStatus | null>(null)
  const [maxOrderQuote, setMaxOrderQuote] = useState('')
  const [dailyCapQuote, setDailyCapQuote] = useState('')
  const [dailyLossLimitQuote, setDailyLossLimitQuote] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function refresh(): void {
    window.api.liveTrading.getStatus().then((s) => {
      setStatus(s)
      setMaxOrderQuote(String(s.maxOrderQuote))
      setDailyCapQuote(String(s.dailyCapQuote))
      setDailyLossLimitQuote(String(s.dailyLossLimitQuote))
    })
  }

  useEffect(() => {
    refresh()
  }, [])

  async function handleSave(): Promise<void> {
    setBusy(true)
    setSaved(false)
    setSaveError(null)
    try {
      await window.api.liveTrading.setConfig({
        maxOrderQuote: Number(maxOrderQuote),
        dailyCapQuote: Number(dailyCapQuote),
        dailyLossLimitQuote: Number(dailyLossLimitQuote)
      })
      refresh()
      setSaved(true)
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return <Card title="Live Trading — Risk Limits">Loading…</Card>

  // The exchange reports what it really charged on every fill, so the app can say when its own
  // assumed rate is wrong instead of leaving someone to discover it in their balance.
  const feeMismatch = describeFeeRateMismatch(status.observedFeeRate)

  return (
    <Card title="Live Trading — Risk Limits">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginBottom: '0.9rem' }}>
        <AlertTriangle size={15} color="var(--down)" style={{ flexShrink: 0, marginTop: 2 }} />
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
          Max order size has an absolute, code-only ceiling of {status.hardMaxOrderQuote} — nothing here, and no bug
          in this app, can place a live order above that no matter what's typed below. The daily cap bounds live
          order notional (used {status.dailyUsedQuote.toFixed(2)} / {status.dailyCapQuote} so far). The daily loss
          limit is the real one — it's realized P&amp;L from closed live positions (today: {status.realizedPnlToday.toFixed(2)}
          ), and breaching it auto-disarms live trading for the rest of the day. Closing a position is never blocked
          by any of these — they only ever bound new/opening orders.
        </p>
      </div>
      {feeMismatch !== null && (
        <p
          style={{
            fontSize: '0.76rem',
            color: 'var(--down)',
            border: '1px solid var(--down)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.55rem 0.7rem',
            margin: '0 0 0.9rem',
            lineHeight: 1.5
          }}
        >
          {feeMismatch}
        </p>
      )}
      <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px' }}>
          <label style={fieldLabelStyle()}>Max Order Size (quote, ≤ {status.hardMaxOrderQuote})</label>
          <input
            type="number"
            max={status.hardMaxOrderQuote}
            value={maxOrderQuote}
            onChange={(e) => setMaxOrderQuote(e.target.value)}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label style={fieldLabelStyle()}>Daily Cap (quote)</label>
          <input type="number" value={dailyCapQuote} onChange={(e) => setDailyCapQuote(e.target.value)} style={textInputStyle()} />
        </div>
        <div style={{ flex: '1 1 160px' }}>
          <label style={fieldLabelStyle()}>Daily Loss Limit (quote)</label>
          <input
            type="number"
            value={dailyLossLimitQuote}
            onChange={(e) => setDailyLossLimitQuote(e.target.value)}
            style={textInputStyle()}
          />
        </div>
      </div>
      <div style={{ marginTop: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <button onClick={() => void handleSave()} disabled={busy} style={{ ...buttonStyle('primary'), opacity: busy ? 0.6 : 1 }}>
          Save
        </button>
        {saved && <span style={{ fontSize: '0.78rem', color: 'var(--up)' }}>Saved</span>}
        {saveError && <span style={{ fontSize: '0.78rem', color: 'var(--down)' }}>Failed to save: {saveError}</span>}
      </div>
    </Card>
  )
}
