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
import { connectionStateOf, describeAiSpend, describeLiveReadiness, describeWatchMode, liveReadinessOf, tradingModeOf, watchModeOf, watchModeWord, type Tone } from '../status/statusModes'
import { Interpolate, useI18n } from '../i18n'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { formButtonStyle, textInputStyle } from './formStyles'

/** How often the gates are read again: as often as the bar at the top of every page reads them. */
const POLL_MS = 15_000

const toneColor = (tone: Tone): string =>
  tone === 'safe' ? 'var(--up)' : tone === 'live' || tone === 'blocked' ? 'var(--down)' : tone === 'warn' ? 'var(--gold)' : 'var(--text-primary)'

const noteStyle: React.CSSProperties = { margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }

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
  const i18n = useI18n()
  const { t } = i18n
  const amount = (value: number): string => i18n.num(value, 0, 2)
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
    liveReadinessOf({ mode: tradingModeOf({ binanceKey: binance?.configured === true, status }), connection: connectionStateOf(binance) }),
    i18n
  )
  const risk = paper === null ? null : describeRiskMode({ paperRisk: paper.paperRisk, paperPause: paper.paperPause, trader: paper.forecast.trader }, i18n)
  const watchMode = keyConfigured === null ? null : watchModeOf({ keyConfigured, config })
  const watch = watchMode === null ? null : describeWatchMode(watchMode, i18n)
  const universe = scanner?.universeSize ?? DEFAULT_SCANNER_UNIVERSE

  return (
    <Card title={t('Essentials')}>
      <p style={{ ...noteStyle, margin: '0 0 0.4rem' }}>{t('The six settings that decide what the app does by itself. The rest are under Advanced, below; nothing there is needed to start.')}</p>

      <Row label={t('Trading mode')}>
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: toneColor(readiness.tone) }}>{readiness.label}</div>
        <p style={noteStyle}>
          {readiness.detail} <Interpolate text={t('Keys are on {connections}.')} values={{ connections: <TextLink onClick={() => onNavigate('connections')}>{t('Connections')}</TextLink> }} />
        </p>
      </Row>

      <Row label={t('Risk mode')}>
        {risk === null ? (
          <span style={noteStyle}>{t('Loading…')}</span>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '0.85rem', fontWeight: 700, color: risk.mode === 'conservative' ? 'var(--up)' : 'var(--gold)', marginInlineEnd: '0.3rem' }}>{risk.label}</span>
              {RISK_MODES.map((mode) => (
                <button
                  key={mode}
                  aria-label={t('Set the risk mode to {mode}', { mode: t(RISK_MODE_NAMES[mode]) })}
                  aria-pressed={risk.mode === mode}
                  onClick={() => void setRiskMode(mode)}
                  disabled={busy || risk.mode === mode}
                  style={{ ...formButtonStyle(risk.mode === mode ? 'primary' : 'secondary'), padding: '0.3rem 0.7rem', opacity: busy ? 0.6 : 1 }}
                >
                  {t(RISK_MODE_NAMES[mode])}
                </button>
              ))}
            </div>
            <p style={noteStyle}>
              {risk.detail}
              {status !== null &&
                ` ${t("Real orders, when live trading is armed: at most {order} an order, {day} a day, and a day's loss of {loss}.", {
                  order: amount(status.maxOrderQuote),
                  day: amount(status.dailyCapQuote),
                  loss: amount(status.dailyLossLimitQuote)
                })}`}{' '}
              <Interpolate text={t('All of it is set on {risk}; a mode sets only the paper settings.')} values={{ risk: <TextLink onClick={() => onNavigate('risk')}>{t('Risk & Safety')}</TextLink> }} />
            </p>
          </>
        )}
      </Row>

      <Row label={t('Market')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
            <input
              type="checkbox"
              aria-label={t('Watch the market')}
              checked={scanner?.enabled === true}
              disabled={busy || scanner === null}
              onChange={(event) => void setScannerConfig({ enabled: event.target.checked })}
            />
            {t('Watch the market')}
          </label>
          <select
            aria-label={t('Pairs the scanner watches')}
            value={universe}
            disabled={busy || scanner === null}
            onChange={(event) => void setScannerConfig({ universeSize: Number(event.target.value) })}
            style={{ ...textInputStyle(), width: 'auto', padding: '0.35rem 0.6rem' }}
          >
            {SCANNER_UNIVERSE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size === DEFAULT_SCANNER_UNIVERSE ? t('Auto: the {count} most traded USDT pairs', { count: size }) : t('The {count} most traded USDT pairs', { count: size })}
              </option>
            ))}
          </select>
        </div>
        <p style={noteStyle}>
          {scanner?.enabled === true
            ? t('The scanner reads these pairs once a minute and raises what moves unusually; it is free and places nothing.')
            : t('The scanner is off, so no event is raised for the AI or for you. It is free and places nothing.')}
        </p>
      </Row>

      <Row label={t('AI')}>
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: watch === null ? 'var(--text-muted)' : toneColor(watch.tone) }}>{watchMode === null ? t('Loading…') : watchModeWord(watchMode, i18n)}</div>
        <p style={noteStyle}>
          {watch?.detail}
          {config !== null && keyConfigured === true && ` ${t('Spent {spent}.', { spent: describeAiSpend(config, i18n) })}`}{' '}
          <Interpolate
            text={t('The watch, and its paper trades, are switched on and off on {opportunities}, after a confirmation stating the most a day can cost.')}
            values={{ opportunities: <TextLink onClick={() => onNavigate('opportunities')}>{t('Opportunities')}</TextLink> }}
          />
        </p>
      </Row>

      <Row label={t('Notifications')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.2rem', flexWrap: 'wrap', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input type="checkbox" aria-label={t('Notices')} checked={alerts.enabled} disabled={busy || paper === null} onChange={(event) => void setAlert({ enabled: event.target.checked })} />
            {t('Notices')}
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: alerts.enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>
            <input
              type="checkbox"
              aria-label={t('Notices with sound')}
              checked={alerts.sound}
              disabled={busy || paper === null || !alerts.enabled}
              onChange={(event) => void setAlert({ sound: event.target.checked })}
            />
            {t('With sound')}
          </label>
        </div>
        <p style={noteStyle}>
          {alerts.enabled
            ? t('A call from the watch, a paper trade opened or paused, the daily digest and news about a coin you hold each raise a notice, heard by its meaning -- each sound, its volume and quiet hours are under Advanced › Notifications.')
            : t('No notice is raised and none is heard, critical included; what would have been said is still on its page.')}
        </p>
      </Row>

      <Row label={t('When closed')}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
          <input
            type="checkbox"
            aria-label={t('Keep running when the window is closed')}
            checked={keepRunning}
            disabled={busy || paper === null}
            onChange={(event) => void setKeepRunningWhenClosed(event.target.checked)}
          />
          {t('Keep running in the tray when the window is closed')}
        </label>
        <p style={noteStyle}>
          {keepRunning
            ? t('Closing the window hides it: the watch, its paper trades, the exit check and the real position watchers run on until Quit from the tray icon.')
            : t('Closing the window quits the app: everything that runs in it stops, and a resting real order stays on the exchange. The tray icon shows the socket and the watch while the app runs.')}
        </p>
      </Row>

      <Row label={t('Exchange')}>
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>{t('Binance · spot · USDT pairs')}</div>
        <p style={noteStyle}>{t('Market data is public and needs no key; a key is needed only to place real orders.')}</p>
      </Row>

      <Row label={t('Layout')}>
        <select
          aria-label={t('Sidebar layout')}
          value={uiMode}
          disabled={busy || paper === null}
          onChange={(event) => void setLayout(healUiMode(event.target.value))}
          style={{ ...textInputStyle(), width: 'auto', padding: '0.35rem 0.6rem' }}
        >
          {UI_MODES.map((mode) => (
            <option key={mode} value={mode}>
              {describeUiMode(mode, i18n).label}
            </option>
          ))}
        </select>
        <p style={noteStyle}>
          {describeUiMode(uiMode, i18n).detail} {t('Every page is in the sidebar either way; this changes nothing the app does.')}
        </p>
      </Row>

      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
    </Card>
  )
}
