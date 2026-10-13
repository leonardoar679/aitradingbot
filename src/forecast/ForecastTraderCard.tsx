import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, noteStyle } from '../agents/agentStyles'
import { describeRiskMode, targetLevelOf } from '../../shared/appDefaults'
import { healForecastSettings } from '../../shared/forecast/training'
import type { AppSettings, PositionExecutorParams } from '../../shared/ipc'
import { healPaperPause } from '../../shared/paperPause'
import { healPaperRisk } from '../../shared/paperRisk'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { forecastPaperExecutors } from './forecastTrader'
import { lastForecastTraderPass, onForecastTraderPass } from './ForecastTraderScheduler'
import { pairText } from './forecastWords'

const clock = (sec: number): string => new Date(sec * 1000).toISOString().slice(11, 16)

/** START AI TRADING (the V6 document, §66-68; V6 Stage 12): the forecast trader switched on and off, on
 * paper -- off until a person switches it on -- what the risk mode holds it to, its open paper trades
 * and what its last pass did. Switching it on opens nothing at once: it acts on the next TRADE decision. */
export function ForecastTraderCard(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [pass, setPass] = useState(lastForecastTraderPass())
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      void window.api.settings.get().then(
        (next) => {
          if (!cancelled) setSettings(next)
        },
        (failure) => {
          if (!cancelled) setProblem(describeError(failure))
        }
      )
    }
    read()
    const stop = onForecastTraderPass(() => {
      setPass(lastForecastTraderPass())
      read()
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  // The forecast's settings are written whole (a patch replaces them): the refit's is kept as it is.
  const setEnabled = (on: boolean): void => {
    setBusy(true)
    setProblem(null)
    void settingsWrites(async () => {
      const fresh = await window.api.settings.get()
      const forecast = healForecastSettings(fresh.forecast)
      await window.api.settings.set({ forecast: { ...forecast, trader: { ...forecast.trader, enabled: on } } })
      return window.api.settings.get()
    })
      .then(setSettings, (failure) => setProblem(describeError(failure)))
      .finally(() => setBusy(false))
  }

  if (settings === null) {
    return (
      <Card title="Start AI trading">
        <p style={noteStyle}>{problem ?? 'Loading…'}</p>
      </Card>
    )
  }
  const trader = healForecastSettings(settings.forecast).trader
  const mode = describeRiskMode({ paperRisk: healPaperRisk(settings.paperRisk), paperPause: healPaperPause(settings.paperPause), trader })
  const mine = forecastPaperExecutors(settings.executors)
  const open = mine.filter((executor) => executor.status === 'active')
  const closed = mine.filter((executor) => executor.status === 'stopped' && executor.forecast?.result !== undefined).slice(-5)
  return (
    <Card
      title="Start AI trading"
      actions={
        <button type="button" style={buttonStyle(trader.enabled ? 'secondary' : 'primary', busy)} disabled={busy} onClick={() => setEnabled(!trader.enabled)}>
          {trader.enabled ? 'Stop AI trading' : 'Start AI trading (paper)'}
        </button>
      }
    >
      <p style={{ ...noteStyle, color: trader.enabled ? 'var(--up)' : 'var(--text-secondary)', fontWeight: 600 }}>{trader.enabled ? 'AI trading is ON, on paper.' : 'AI trading is off.'}</p>
      <p style={noteStyle}>
        On paper only, and never a real order: on each TRADE decision in an opportunity class that is approved or on probation, the forecast trader opens a paper Position from its trade plan -- in at the live price inside its zone, stopped at the forecast's
        bad case, its target at {targetLevelOf(mode.mode)}, held at most the horizon -- at most {trader.maxOpen} open, {trader.maxSameSide} on one side, {trader.stakeQuote} USDT a trade at most, sized by the risk mode ({mode.label}). Its own
        losing run pauses it, as the watch's does. Real orders stay a person's: TRADE THIS fills in the form.
      </p>
      {open.length > 0 && (
        <p style={{ ...noteStyle, marginTop: '0.4rem', color: 'var(--text-primary)' }}>
          Open: {open.map((executor) => `${executor.forecast?.side} ${pairText(executor.symbol)} (${(executor.params as PositionExecutorParams).amountQuote} USDT, ${clock(executor.createdAt)} UTC)`).join(' · ')}
        </p>
      )}
      {closed.length > 0 && (
        <p style={{ ...noteStyle, marginTop: '0.2rem' }}>
          Closed: {closed.map((executor) => `${pairText(executor.symbol)} ${executor.forecast?.result?.exit.replace(/_/g, ' ')} ${(executor.forecast?.result?.pnlQuote ?? 0) >= 0 ? '+' : ''}${(executor.forecast?.result?.pnlQuote ?? 0).toFixed(2)} USDT`).join(' · ')}
        </p>
      )}
      {pass !== null && trader.enabled && (
        <p style={{ ...noteStyle, marginTop: '0.2rem' }}>
          At {clock(pass.at)} UTC: {pass.result.opened.length === 0 && pass.result.refused.length === 0 ? 'no TRADE decision.' : ''}
          {pass.result.opened.length > 0 ? `opened ${pass.result.opened.map(pairText).join(', ')}. ` : ''}
          {pass.result.refused.slice(0, 3).map((entry) => `${pairText(entry.pair)} not opened: ${entry.why}`).join(' ')}
        </p>
      )}
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
    </Card>
  )
}
