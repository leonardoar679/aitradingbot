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
import { useI18n } from '../i18n'
import { exitWord } from '../../shared/tradeWords'

/** START AI TRADING (the V6 document, §66-68; V6 Stage 12): the forecast trader switched on and off, on
 * paper -- off until a person switches it on -- what the risk mode holds it to, its open paper trades
 * and what its last pass did. Switching it on opens nothing at once: it acts on the next TRADE decision. */
export function ForecastTraderCard(): React.JSX.Element {
  const i18n = useI18n()
  const { t, utcTime, signed } = i18n
  const clock = (sec: number): string => utcTime(sec * 1000)
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
      <Card title={t('Start AI trading')}>
        <p style={noteStyle}>{problem ?? t('Loading…')}</p>
      </Card>
    )
  }
  const trader = healForecastSettings(settings.forecast).trader
  const mode = describeRiskMode({ paperRisk: healPaperRisk(settings.paperRisk), paperPause: healPaperPause(settings.paperPause), trader }, i18n)
  const mine = forecastPaperExecutors(settings.executors)
  const open = mine.filter((executor) => executor.status === 'active')
  const closed = mine.filter((executor) => executor.status === 'stopped' && executor.forecast?.result !== undefined).slice(-5)
  return (
    <Card
      title={t('Start AI trading')}
      actions={
        <button type="button" style={buttonStyle(trader.enabled ? 'secondary' : 'primary', busy)} disabled={busy} onClick={() => setEnabled(!trader.enabled)}>
          {trader.enabled ? t('Stop AI trading') : t('Start AI trading (paper)')}
        </button>
      }
    >
      <p style={{ ...noteStyle, color: trader.enabled ? 'var(--up)' : 'var(--text-secondary)', fontWeight: 600 }}>{trader.enabled ? t('AI trading is ON, on paper.') : t('AI trading is off.')}</p>
      <p style={noteStyle}>
        {t(
          "On paper only, and never a real order: on each TRADE decision in an opportunity class that is approved or on probation, the forecast trader opens a paper Position from its trade plan -- in at the live price inside its zone, stopped at the forecast's bad case, its target at {level}, held at most the horizon -- at most {open} open, {side} on one side, {stake} USDT a trade at most, sized by the risk mode ({mode}). Its own losing run pauses it, as the watch's does. Real orders stay a person's: TRADE THIS fills in the form.",
          { level: targetLevelOf(mode.mode), open: trader.maxOpen, side: trader.maxSameSide, stake: trader.stakeQuote, mode: mode.label }
        )}
      </p>
      {open.length > 0 && (
        <p style={{ ...noteStyle, marginTop: '0.4rem', color: 'var(--text-primary)' }}>
          {t('Open: {trades}', {
            trades: open
              .map((executor) =>
                t('{side} {pair} ({amount} USDT, {time} UTC)', {
                  side: executor.forecast?.side === 'SELL' ? t('SELL') : t('BUY'),
                  pair: pairText(executor.symbol),
                  amount: (executor.params as PositionExecutorParams).amountQuote,
                  time: clock(executor.createdAt)
                })
              )
              .join(' · ')
          })}
        </p>
      )}
      {closed.length > 0 && (
        <p style={{ ...noteStyle, marginTop: '0.2rem' }}>
          {t('Closed: {trades}', {
            trades: closed
              .map((executor) =>
                t('{pair} {exit} {pnl}', {
                  pair: pairText(executor.symbol),
                  exit: exitWord(executor.forecast?.result?.exit, i18n),
                  pnl: `${signed(executor.forecast?.result?.pnlQuote ?? 0, 2)} USDT`
                })
              )
              .join(' · ')
          })}
        </p>
      )}
      {pass !== null && trader.enabled && (
        <p style={{ ...noteStyle, marginTop: '0.2rem' }}>
          {t('At {time} UTC:', { time: clock(pass.at) })} {pass.result.opened.length === 0 && pass.result.refused.length === 0 ? t('no TRADE decision.') : ''}
          {pass.result.opened.length > 0 ? `${t('opened {pairs}.', { pairs: pass.result.opened.map(pairText).join(t(', ')) })} ` : ''}
          {pass.result.refused
            .slice(0, 3)
            .map((entry) => t('{pair} not opened: {why}', { pair: pairText(entry.pair), why: entry.why }))
            .join(' ')}
        </p>
      )}
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
    </Card>
  )
}
