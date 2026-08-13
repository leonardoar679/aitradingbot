import { useEffect, useState } from 'react'
import { AlertTriangle, Power, ShieldOff } from 'lucide-react'
import type { LiveTradingStatus } from '../../shared/ipc'

const POLL_MS = 15_000

function buttonStyle(kind: 'arm' | 'disarm' | 'kill' | 'release'): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '0.35rem',
    border: 'none',
    borderRadius: 999,
    padding: '0.35rem 0.8rem',
    fontSize: '0.75rem',
    fontWeight: 700,
    cursor: 'pointer'
  }
  if (kind === 'arm') return { ...base, background: 'var(--down)', color: '#fff' }
  if (kind === 'kill') return { ...base, background: '#fff', color: 'var(--down)' }
  if (kind === 'release') return { ...base, background: 'transparent', border: '1px solid rgba(255,255,255,0.5)', color: '#fff' }
  return { ...base, background: 'transparent', border: '1px solid var(--border)', color: 'var(--text-secondary)' }
}

export function LiveTradingBar(): React.JSX.Element | null {
  const [status, setStatus] = useState<LiveTradingStatus | null>(null)
  const [credentialConfigured, setCredentialConfigured] = useState(false)
  const [busy, setBusy] = useState(false)

  function refresh(): void {
    window.api.liveTrading.getStatus().then(setStatus).catch((error) => console.error('Failed to load live trading status:', error))
    window.api.credentials
      .list()
      .then((list) => setCredentialConfigured(list.some((c) => c.exchange === 'binance' && c.configured)))
      .catch((error) => console.error('Failed to load credential status:', error))
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => clearInterval(timer)
  }, [])

  async function handleArmToggle(): Promise<void> {
    if (!status) return
    setBusy(true)
    try {
      await window.api.liveTrading.setSessionArmed(!status.sessionArmed)
    } finally {
      refresh()
      setBusy(false)
    }
  }

  async function handleKillSwitch(): Promise<void> {
    setBusy(true)
    try {
      await window.api.liveTrading.engageKillSwitch()
    } finally {
      refresh()
      setBusy(false)
    }
  }

  async function handleReleaseKillSwitch(): Promise<void> {
    setBusy(true)
    try {
      await window.api.liveTrading.releaseKillSwitch()
    } finally {
      refresh()
      setBusy(false)
    }
  }

  if (!status) return null

  if (!credentialConfigured) {
    return (
      <div style={{ padding: '0.4rem 1rem', fontSize: '0.72rem', color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        Live trading: not available — add a verified Binance API key in Settings to enable it.
      </div>
    )
  }

  const engaged = status.killSwitchEngaged
  const armed = status.sessionArmed
  const lossLimitBreached = !engaged && status.realizedPnlToday <= -status.dailyLossLimitQuote

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        padding: '0.5rem 1rem',
        flexShrink: 0,
        background: engaged
          ? 'var(--down)'
          : lossLimitBreached
            ? 'color-mix(in srgb, orange 20%, var(--bg-app))'
            : armed
              ? 'color-mix(in srgb, var(--down) 20%, var(--bg-app))'
              : 'var(--bg-app)',
        borderBottom: `1px solid ${engaged || armed ? 'var(--down)' : lossLimitBreached ? 'orange' : 'var(--border)'}`,
        color: engaged ? '#fff' : 'var(--text-primary)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.78rem', fontWeight: 700 }}>
        <AlertTriangle size={14} />
        {engaged
          ? 'KILL SWITCH ENGAGED — live trading blocked'
          : lossLimitBreached
            ? 'Daily loss limit reached — live trading auto-disarmed for today'
            : armed
              ? 'Live trading: ARMED for this session'
              : 'Live trading: off'}
        {!engaged && (
          <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>
            · today {status.dailyUsedQuote.toFixed(2)} / {status.dailyCapQuote} used · P&amp;L{' '}
            <span style={{ color: status.realizedPnlToday >= 0 ? 'var(--up)' : 'var(--down)' }}>
              {status.realizedPnlToday >= 0 ? '+' : ''}
              {status.realizedPnlToday.toFixed(2)}
            </span>{' '}
            / limit -{status.dailyLossLimitQuote}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {engaged ? (
          <button onClick={() => void handleReleaseKillSwitch()} disabled={busy} style={buttonStyle('release')}>
            <ShieldOff size={13} /> Release Kill Switch
          </button>
        ) : (
          <>
            <button onClick={() => void handleArmToggle()} disabled={busy} style={buttonStyle(armed ? 'disarm' : 'arm')}>
              <Power size={13} /> {armed ? 'Disarm' : 'Arm for this session'}
            </button>
            <button onClick={() => void handleKillSwitch()} disabled={busy} style={buttonStyle('kill')}>
              Kill Switch
            </button>
          </>
        )}
      </div>
    </div>
  )
}
