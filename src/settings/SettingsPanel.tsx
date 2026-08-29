import { useEffect, useState } from 'react'
import { describeFeeRateMismatch } from '../../shared/observedFee'
import { KeyRound, ShieldCheck, Trash2, Moon, Sun, Eye, AlertTriangle } from 'lucide-react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/palette'
import type { CredentialStatus, Exchange, LiveTradingStatus } from '../../shared/ipc'
import type { AiCredentialStatus } from '../../shared/aiSignal'
import { cleanIpcErrorMessage } from '../utils/ipcError'

const THEME_OPTIONS: { id: Theme; label: string; icon: typeof Moon }[] = [
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'colorblind', label: 'Colorblind', icon: Eye }
]

// Live trading is Binance-only for now (see the live-trading design plan) — this screen only
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

      <AiCredentialsCard />

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

      <LiveTradingLimitsCard />
    </>
  )
}

function AiCredentialsCard(): React.JSX.Element {
  const [status, setStatus] = useState<AiCredentialStatus | null>(null)
  const [editing, setEditing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('gpt-5-mini')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  function refresh(): void {
    void window.api.ai.credentialsStatus().then((next) => {
      setStatus(next)
      setModel(next.model)
    })
  }

  useEffect(() => refresh(), [])

  async function save(): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      await window.api.ai.setCredentials(apiKey.trim(), model.trim())
      setApiKey('')
      setEditing(false)
      refresh()
      setMessage({ ok: true, text: 'OpenAI key verified and saved.' })
    } catch (error) {
      setMessage({ ok: false, text: cleanIpcErrorMessage(error instanceof Error ? error.message : String(error)) })
    } finally {
      setBusy(false)
    }
  }

  async function test(): Promise<void> {
    setBusy(true)
    try {
      const result = await window.api.ai.testCredentials()
      setMessage({ ok: result.ok, text: result.message })
      refresh()
    } catch (error) {
      setMessage({ ok: false, text: cleanIpcErrorMessage(error instanceof Error ? error.message : String(error)) })
    } finally {
      setBusy(false)
    }
  }

  async function remove(): Promise<void> {
    setBusy(true)
    try {
      await window.api.ai.removeCredentials()
      setMessage({ ok: true, text: 'OpenAI key removed.' })
      refresh()
    } catch (error) {
      setMessage({ ok: false, text: cleanIpcErrorMessage(error instanceof Error ? error.message : String(error)) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="GPT Intraday — OpenAI">
      <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 0.9rem', lineHeight: 1.5 }}>
        Used only for chart signals, backtests, and paper bots. GPT signals have no live-order route. The key is
        encrypted by Windows and never enters the renderer.
      </p>
      {editing ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <div>
            <label style={fieldLabelStyle()}>OpenAI API Key</label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" style={textInputStyle()} />
          </div>
          <div>
            <label style={fieldLabelStyle()}>Model</label>
            <input value={model} onChange={(e) => setModel(e.target.value)} style={textInputStyle()} />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={() => void save()} disabled={busy || !apiKey.trim() || !model.trim()} style={buttonStyle('primary')}>
              {busy ? 'Testing…' : 'Test & Save'}
            </button>
            <button onClick={() => setEditing(false)} disabled={busy} style={buttonStyle('secondary')}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
            {status?.configured ? `Configured model: ${status.model}` : 'No OpenAI key configured'}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={() => setEditing(true)} disabled={busy} style={buttonStyle('secondary')}>
              {status?.configured ? 'Replace key' : 'Add key'}
            </button>
            {status?.configured && <>
              <button onClick={() => void test()} disabled={busy} style={buttonStyle('secondary')}>Test</button>
              <button onClick={() => void remove()} disabled={busy} style={buttonStyle('danger')}>Remove</button>
            </>}
          </div>
        </div>
      )}
      {message && <p style={{ color: message.ok ? 'var(--up)' : 'var(--down)', fontSize: '0.78rem', marginBottom: 0 }}>{message.text}</p>}
    </Card>
  )
}

function LiveTradingLimitsCard(): React.JSX.Element {
  const [status, setStatus] = useState<LiveTradingStatus | null>(null)
  const [maxOrderQuote, setMaxOrderQuote] = useState('')
  const [dailyCapQuote, setDailyCapQuote] = useState('')
  const [dailyLossLimitQuote, setDailyLossLimitQuote] = useState('')
  const [allocationQuote, setAllocationQuote] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  function refresh(): void {
    window.api.liveTrading.getStatus().then((s) => {
      setStatus(s)
      setMaxOrderQuote(String(s.maxOrderQuote))
      setDailyCapQuote(String(s.dailyCapQuote))
      setDailyLossLimitQuote(String(s.dailyLossLimitQuote))
      // Blank and 0 are different answers -- "not using an allocation" and "an allocation of
      // nothing" -- so an unset allocation must come back as an empty field, never as "0".
      setAllocationQuote(s.allocationQuote === null ? '' : String(s.allocationQuote))
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
        dailyLossLimitQuote: Number(dailyLossLimitQuote),
        allocationQuote: allocationQuote.trim() === '' ? null : Number(allocationQuote)
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
        <div style={{ flex: '1 1 160px' }}>
          <label style={fieldLabelStyle()}>Managed Allocation (quote, blank = none)</label>
          <input
            type="number"
            min="0"
            placeholder="none"
            value={allocationQuote}
            onChange={(e) => setAllocationQuote(e.target.value)}
            style={textInputStyle()}
          />
        </div>
      </div>
      <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0.7rem 0 0', lineHeight: 1.5 }}>
        {status.allocationQuote === null
          ? 'A managed allocation is the only limit here that bounds the total rather than the day. Every cap above resets at midnight UTC, so a 50-a-day cap still permits 1,500 over a month. Set an amount and this app will never have more than that at work at once. Your funds never move — they stay on your exchange, under your keys; this is permission, not a deposit.'
          : `This app may have ${status.allocationQuote.toFixed(2)} at work at once, and currently has ${status.allocationCommittedQuote.toFixed(2)} — counting what open positions cost and what resting buy orders have reserved. ${Math.max(status.allocationQuote - status.allocationCommittedQuote, 0).toFixed(2)} is free. Your funds have not moved: they are on your exchange, under your keys. Clear the field to trade without an allocation.`}
      </p>
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
