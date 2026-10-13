import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { TextLink } from '../components/TextLink'
import type { AiConfig } from '../../shared/aiCost'
import { DEFAULT_ALERTS, healAlerts } from '../../shared/alerts'
import { DEFAULT_KEEP_RUNNING, healKeepRunning } from '../../shared/keepRunning'
import { DEFAULT_UI_MODE, UI_MODES, describeUiMode, healUiMode, type UiMode } from '../../shared/uiMode'
import { RISK_MODES, RISK_MODE_NAMES, describeRiskMode, riskModePatch, type PresetRiskMode } from '../../shared/appDefaults'
import { healForecastSettings, type ForecastSettings } from '../../shared/forecast/training'
import type { AlertSettings, CredentialStatus, LiveTradingStatus, PaperPauseSettings, PaperRiskSettings } from '../../shared/ipc'
import { DEFAULT_SCANNER_UNIVERSE, SCANNER_UNIVERSE_SIZES, type ScannerConfig } from '../../shared/marketScanner'
import { healPaperPause } from '../../shared/paperPause'
import { healPaperRisk } from '../../shared/paperRisk'
import type { Page } from '../navigation/pages'
import { connectionStateOf, describeAiSpend, describeLiveReadiness, describeWatchMode, liveReadinessOf, tradingModeOf, watchModeOf, type Tone } from '../status/statusModes'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { formButtonStyle, textInputStyle } from './formStyles'

/** How often the gates are read again: as often as the bar at the top of every page reads them. */
const POLL_MS = 15_000

const toneColor = (tone: Tone): string =>
  tone === 'safe' ? 'var(--up)' : tone === 'live' || tone === 'blocked' ? 'var(--down)' : tone === 'warn' ? 'var(--gold)' : 'var(--text-primary)'

const noteStyle: React.CSSProperties = { margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }

const amount = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(110px, 150px) 1fr', gap: '0.8rem', padding: '0.7rem 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)' }}>{label}</div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  )
}

/** The six settings an ordinary user needs, as the V3 document lists them: trading mode, risk
 * level, market universe, AI mode, notifications and exchange. Everything else is under Advanced.
 *
 * IT CHANGES ONLY WHAT IS SAFE TO CHANGE IN ONE CLICK: the scanner's pairs and switch, the desktop
 * notices, and the risk mode (since 13 October 2026, the V6 document's §66: Conservative, Balanced or
 * Aggressive), which sets only how big the app's own PAPER trades are and how many it keeps -- no real
 * order, and no switch that opens any by itself: whether the forecast trader is on is kept. Whether real
 * orders can be placed is read and shown, never changed here -- arming and the kill switch stay on
 * the bar, and the limits on Risk & Safety. Whether the AI asks, or trades on paper, is changed only
 * on Opportunities, after the confirmation that states what a day of it can cost. */
export function EssentialsCard({ onNavigate, onUiModeChange }: { onNavigate: (page: Page) => void; onUiModeChange: (mode: UiMode) => void }): React.JSX.Element {
  const [status, setStatus] = useState<LiveTradingStatus | null>(null)
  const [binance, setBinance] = useState<CredentialStatus | undefined>(undefined)
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null)
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [scanner, setScanner] = useState<ScannerConfig | null>(null)
  const [paper, setPaper] = useState<{ paperRisk: PaperRiskSettings; paperPause: PaperPauseSettings; forecast: ForecastSettings } | null>(null)
  const [alerts, setAlerts] = useState<AlertSettings>(DEFAULT_ALERTS)
  const [keepRunning, setKeepRunning] = useState<boolean>(DEFAULT_KEEP_RUNNING)
  const [uiMode, setUiMode] = useState<UiMode>(DEFAULT_UI_MODE)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  function readSettings(): void {
    window.api.settings.get().then(
      (settings) => {
        setPaper({ paperRisk: healPaperRisk(settings.paperRisk), paperPause: healPaperPause(settings.paperPause), forecast: healForecastSettings(settings.forecast) })
        setAlerts(healAlerts(settings.alerts))
        setKeepRunning(healKeepRunning(settings.keepRunningWhenClosed))
        setUiMode(healUiMode(settings.uiMode))
      },
      (failure: unknown) => setProblem(describeError(failure))
    )
  }

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      window.api.liveTrading.getStatus().then(
        (next) => {
          if (!cancelled) setStatus(next)
        },
        () => undefined
      )
      window.api.credentials.list().then(
        (list) => {
          if (!cancelled) setBinance(list.find((entry) => entry.exchange === 'binance'))
        },
        () => undefined
      )
      window.api.ai.credentialsStatus().then(
        (next) => {
          if (!cancelled) setKeyConfigured(next.configured)
        },
        () => undefined
      )
      window.api.ai.getConfig().then(
        (next) => {
          if (!cancelled) setConfig(next)
        },
        () => undefined
      )
      window.api.scanner.getState().then(
        (state) => {
          if (!cancelled) setScanner(state.config)
        },
        () => undefined
      )
    }
    read()
    readSettings()
    const timer = setInterval(read, POLL_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const setScannerConfig = (patch: Partial<ScannerConfig>): Promise<void> =>
    run(async () => {
      setScanner((await window.api.scanner.setConfig(patch)).config)
    })

  const setAlert = (patch: Partial<AlertSettings>): Promise<void> =>
    run(async () => {
      await settingsWrites(async () => {
        const fresh = await window.api.settings.get()
        await window.api.settings.set({ alerts: { ...healAlerts(fresh.alerts), ...patch } })
      })
      readSettings()
    })

  /** What closing the window does (shared/keepRunning.ts): hide to the tray and run on, or quit. */
  const setKeepRunningWhenClosed = (next: boolean): Promise<void> =>
    run(async () => {
      await settingsWrites(async () => {
        await window.api.settings.set({ keepRunningWhenClosed: next })
      })
      readSettings()
    })

  /** Which groups of the sidebar start open (shared/uiMode.ts). It changes nothing the app does. */
  const setLayout = (next: UiMode): Promise<void> =>
    run(async () => {
      await settingsWrites(async () => {
        await window.api.settings.set({ uiMode: next })
      })
      onUiModeChange(next)
      readSettings()
    })

  const setRiskMode = (mode: PresetRiskMode): Promise<void> =>
    run(async () => {
      await settingsWrites(async () => {
        const fresh = await window.api.settings.get()
        await window.api.settings.set(riskModePatch(mode, { paperPause: healPaperPause(fresh.paperPause), forecast: healForecastSettings(fresh.forecast) }))
      })
      readSettings()
    })

  const readiness = describeLiveReadiness(
    liveReadinessOf({ mode: tradingModeOf({ binanceKey: binance?.configured === true, status }), connection: connectionStateOf(binance) })
  )
  const risk = paper === null ? null : describeRiskMode({ paperRisk: paper.paperRisk, paperPause: paper.paperPause, trader: paper.forecast.trader })
  const watch = keyConfigured === null ? null : describeWatchMode(watchModeOf({ keyConfigured, config }))
  const universe = scanner?.universeSize ?? DEFAULT_SCANNER_UNIVERSE

  return (
    <Card title="Essentials">
      <p style={{ ...noteStyle, margin: '0 0 0.4rem' }}>
        The six settings that decide what the app does by itself. The rest are under Advanced, below; nothing there is needed to start.
      </p>

      <Row label="Trading mode">
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: toneColor(readiness.tone) }}>{readiness.label}</div>
        <p style={noteStyle}>
          {readiness.detail} Keys are on <TextLink onClick={() => onNavigate('connections')}>Connections</TextLink>.
        </p>
      </Row>

      <Row label="Risk mode">
        {risk === null ? (
          <span style={noteStyle}>Loading…</span>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: risk.mode === 'conservative' ? 'var(--up)' : 'var(--gold)', marginRight: '0.3rem' }}>{risk.label}</span>
              {RISK_MODES.map((mode) => (
                <button
                  key={mode}
                  aria-label={`Set the risk mode to ${RISK_MODE_NAMES[mode]}`}
                  aria-pressed={risk.mode === mode}
                  onClick={() => void setRiskMode(mode)}
                  disabled={busy || risk.mode === mode}
                  style={{ ...formButtonStyle(risk.mode === mode ? 'primary' : 'secondary'), padding: '0.3rem 0.7rem', opacity: busy ? 0.6 : 1 }}
                >
                  {RISK_MODE_NAMES[mode]}
                </button>
              ))}
            </div>
            <p style={noteStyle}>
              {risk.detail}
              {status !== null &&
                ` Real orders, when live trading is armed: at most ${amount(status.maxOrderQuote)} an order, ${amount(status.dailyCapQuote)} a day, and a day's loss of ${amount(status.dailyLossLimitQuote)}.`}{' '}
              All of it is set on <TextLink onClick={() => onNavigate('risk')}>Risk &amp; Safety</TextLink>; a mode sets only the paper settings.
            </p>
          </>
        )}
      </Row>

      <Row label="Market">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
            <input
              type="checkbox"
              aria-label="Watch the market"
              checked={scanner?.enabled === true}
              disabled={busy || scanner === null}
              onChange={(event) => void setScannerConfig({ enabled: event.target.checked })}
            />
            Watch the market
          </label>
          <select
            aria-label="Pairs the scanner watches"
            value={universe}
            disabled={busy || scanner === null}
            onChange={(event) => void setScannerConfig({ universeSize: Number(event.target.value) })}
            style={{ ...textInputStyle(), width: 'auto', padding: '0.35rem 0.6rem' }}
          >
            {SCANNER_UNIVERSE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size === DEFAULT_SCANNER_UNIVERSE ? `Auto: the ${size} most traded USDT pairs` : `The ${size} most traded USDT pairs`}
              </option>
            ))}
          </select>
        </div>
        <p style={noteStyle}>
          {scanner?.enabled === true
            ? 'The scanner reads these pairs once a minute and raises what moves unusually; it is free and places nothing.'
            : 'The scanner is off, so no event is raised for the AI or for you. It is free and places nothing.'}
        </p>
      </Row>

      <Row label="AI">
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: watch === null ? 'var(--text-muted)' : toneColor(watch.tone) }}>
          {watch === null ? 'Loading…' : watch.label.replace(/^AI: /, '')}
        </div>
        <p style={noteStyle}>
          {watch?.detail}
          {config !== null && keyConfigured === true && ` Spent ${describeAiSpend(config)}.`} The watch, and its paper trades, are switched on and off on{' '}
          <TextLink onClick={() => onNavigate('opportunities')}>Opportunities</TextLink>, after a confirmation stating the most a day can cost.
        </p>
      </Row>

      <Row label="Notifications">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.2rem', flexWrap: 'wrap', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input type="checkbox" aria-label="Notices" checked={alerts.enabled} disabled={busy || paper === null} onChange={(event) => void setAlert({ enabled: event.target.checked })} />
            Notices
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: alerts.enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            <input
              type="checkbox"
              aria-label="Notices with sound"
              checked={alerts.sound}
              disabled={busy || paper === null || !alerts.enabled}
              onChange={(event) => void setAlert({ sound: event.target.checked })}
            />
            With sound
          </label>
        </div>
        <p style={noteStyle}>
          {alerts.enabled
            ? 'A call from the watch, a paper trade opened or paused, the daily digest and news about a coin you hold each raise a notice, heard by its meaning -- each sound, its volume and quiet hours are under Advanced › Notifications.'
            : 'No notice is raised and none is heard, critical included; what would have been said is still on its page.'}
        </p>
      </Row>

      <Row label="When closed">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
          <input
            type="checkbox"
            aria-label="Keep running when the window is closed"
            checked={keepRunning}
            disabled={busy || paper === null}
            onChange={(event) => void setKeepRunningWhenClosed(event.target.checked)}
          />
          Keep running in the tray when the window is closed
        </label>
        <p style={noteStyle}>
          {keepRunning
            ? 'Closing the window hides it: the watch, its paper trades, the exit check and the real position watchers run on until Quit from the tray icon.'
            : 'Closing the window quits the app: everything that runs in it stops, and a resting real order stays on the exchange. The tray icon shows the socket and the watch while the app runs.'}
        </p>
      </Row>

      <Row label="Exchange">
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>Binance · spot · USDT pairs</div>
        <p style={noteStyle}>Market data is public and needs no key; a key is needed only to place real orders.</p>
      </Row>

      <Row label="Layout">
        <select
          aria-label="Sidebar layout"
          value={uiMode}
          disabled={busy || paper === null}
          onChange={(event) => void setLayout(healUiMode(event.target.value))}
          style={{ ...textInputStyle(), width: 'auto', padding: '0.35rem 0.6rem' }}
        >
          {UI_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {describeUiMode(mode).label}
            </option>
          ))}
        </select>
        <p style={noteStyle}>{describeUiMode(uiMode).detail} Every page is in the sidebar either way; this changes nothing the app does.</p>
      </Row>

      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
    </Card>
  )
}
