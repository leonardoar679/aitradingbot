import { useEffect, useState } from 'react'
import { AlertTriangle, Power, ShieldOff } from 'lucide-react'
import type { CredentialStatus, LiveTradingStatus, LiveWatcherSummary } from '../../shared/ipc'
import { AiStatusChip } from '../ai/AiStatusChip'
import { StatusChip } from '../status/StatusChip'
import { connectionStateOf, describeConnection, describeTradingMode, tradingModeOf } from '../status/statusModes'
import { describeBlockedExits } from './blockedExits'

const POLL_MS = 15_000
// How long a pending confirmation stays armed before reverting to the plain label.
const CONFIRM_WINDOW_MS = 5_000

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
  const [binance, setBinance] = useState<CredentialStatus | undefined>(undefined)
  const credentialConfigured = binance?.configured === true
  const [watchers, setWatchers] = useState<LiveWatcherSummary[]>([])
  const [busy, setBusy] = useState(false)
  // Two risk-increasing controls live on this bar, and both used to fire on a single click:
  // arming the session is the gate that lets real orders through at all, and releasing the kill
  // switch un-blocks it. Meanwhile discarding a *paper* Inventory row already asks twice, and so
  // does closing a live position. The app was more careful about deleting a simulated record
  // than about turning real trading on. Disarming and engaging the kill switch stay one click --
  // they only ever reduce risk, and hesitating there is the wrong failure mode.
  const [pendingConfirm, setPendingConfirm] = useState<'arm' | 'release' | null>(null)

  useEffect(() => {
    if (pendingConfirm === null) return
    const timer = setTimeout(() => setPendingConfirm(null), CONFIRM_WINDOW_MS)
    return (): void => clearTimeout(timer)
  }, [pendingConfirm])

  function refresh(): void {
    window.api.liveTrading.getStatus().then(setStatus).catch((error) => console.error('Failed to load live trading status:', error))
    window.api.credentials
      .list()
      .then((list) => setBinance(list.find((c) => c.exchange === 'binance')))
      .catch((error) => console.error('Failed to load credential status:', error))
    window.api.liveTrading
      .listActiveWatchers()
      .then(setWatchers)
      .catch((error) => console.error('Failed to load active live watchers:', error))
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return (): void => clearInterval(timer)
  }, [])

  async function handleArmToggle(): Promise<void> {
    if (!status) return
    // Only arming needs confirming; disarming takes effect immediately.
    if (!status.sessionArmed && pendingConfirm !== 'arm') {
      setPendingConfirm('arm')
      return
    }
    setPendingConfirm(null)
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
    if (pendingConfirm !== 'release') {
      setPendingConfirm('release')
      return
    }
    setPendingConfirm(null)
    setBusy(true)
    try {
      await window.api.liveTrading.releaseKillSwitch()
    } finally {
      refresh()
      setBusy(false)
    }
  }

  if (!status) return null

  // The state of things at a glance, on every page: whether a real order can be placed at all,
  // whether the exchange key is good, and what the AI does by itself. Read from the gates and the
  // settings themselves (src/status/statusModes.ts); hovering one says what it means.
  const chips = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', flexWrap: 'wrap' }}>
      <StatusChip mode={describeTradingMode(tradingModeOf({ binanceKey: credentialConfigured, status }))} />
      <StatusChip mode={describeConnection('Binance', connectionStateOf(binance))} />
      <AiStatusChip />
    </span>
  )

  if (!credentialConfigured) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.7rem',
          flexWrap: 'wrap',
          padding: '0.35rem 1rem',
          fontSize: '0.72rem',
          color: 'var(--text-muted)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0
        }}
      >
        {chips}
        <span>Live trading: not available — add a verified Binance API key on Connections to enable it.</span>
      </div>
    )
  }

  const engaged = status.killSwitchEngaged
  const armed = status.sessionArmed
  const lossLimitBreached = !engaged && status.realizedPnlToday <= -status.dailyLossLimitQuote
  const blockedExits = describeBlockedExits({
    watchedPositions: watchers.length,
    symbols: [...new Set(watchers.map((w) => w.symbol))],
    sessionArmed: armed,
    killSwitchEngaged: engaged
  })

  return (
    <>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.78rem', fontWeight: 700, flexWrap: 'wrap' }}>
        {chips}
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
            {status.allocationQuote !== null && (
              <>
                {' '}
                · allocation {status.allocationCommittedQuote.toFixed(2)} / {status.allocationQuote.toFixed(2)} at work
              </>
            )}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        {engaged ? (
          <button onClick={() => void handleReleaseKillSwitch()} disabled={busy} style={buttonStyle('release')}>
            <ShieldOff size={13} />{' '}
            {pendingConfirm === 'release' ? 'Confirm — allow live orders again?' : 'Release Kill Switch'}
          </button>
        ) : (
          <>
            <button onClick={() => void handleArmToggle()} disabled={busy} style={buttonStyle(armed ? 'disarm' : 'arm')}>
              <Power size={13} />{' '}
              {armed
                ? 'Disarm'
                : pendingConfirm === 'arm'
                  ? `Confirm — allow real orders up to ${status.maxOrderQuote} each?`
                  : 'Arm for this session'}
            </button>
            <button onClick={() => void handleKillSwitch()} disabled={busy} style={buttonStyle('kill')}>
              Kill Switch
            </button>
          </>
        )}
      </div>
    </div>
    {blockedExits !== null && (
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: '0.5rem',
          padding: '0.55rem 1rem',
          flexShrink: 0,
          background: 'var(--down)',
          color: '#fff',
          fontSize: '0.75rem',
          fontWeight: 600,
          lineHeight: 1.45
        }}
      >
        <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: '0.12rem' }} />
        <span>{blockedExits}</span>
      </div>
    )}
    </>
  )
}
