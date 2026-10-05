import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { SummaryLine } from '../components/SummaryLine'
import { TextLink } from '../components/TextLink'
import type { AiConfig } from '../../shared/aiCost'
import type { CredentialStatus, LiveTradingStatus } from '../../shared/ipc'
import { describeAiSpend, describeTradingMode, describeWatchMode, tradingModeOf, watchModeOf } from '../status/statusModes'
import type { Page } from '../navigation/pages'

const POLL_MS = 15_000

/** Whether real money is at risk, and what the AI does by itself: the same reading as the bar at
 * the top of every page, spelled out. It reads the gates and the settings, and offers nothing to
 * act on -- arming and the kill switch stay on the bar. */
export function SafetySummary({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const [status, setStatus] = useState<LiveTradingStatus | null>(null)
  const [binance, setBinance] = useState<CredentialStatus | undefined>(undefined)
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null)
  const [config, setConfig] = useState<AiConfig | null>(null)

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
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const trading = describeTradingMode(tradingModeOf({ binanceKey: binance?.configured === true, status }))
  const watch = keyConfigured === null ? null : describeWatchMode(watchModeOf({ keyConfigured, config }))

  return (
    <Card title="Safety">
      <SummaryLine label="Real orders" value={trading.label} tone={trading.tone === 'safe' ? 'up' : 'down'} />
      <p style={{ margin: '0.3rem 0 0.4rem', fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{trading.detail}</p>
      {status !== null && binance?.configured === true && (
        <SummaryLine
          label="Realized today"
          value={`${status.realizedPnlToday >= 0 ? '+' : ''}${status.realizedPnlToday.toFixed(2)}, against a loss limit of ${status.dailyLossLimitQuote}`}
          tone={status.realizedPnlToday < 0 ? 'down' : undefined}
        />
      )}
      <SummaryLine label="AI spend" value={config === null ? 'Loading…' : describeAiSpend(config)} />
      <SummaryLine label="The watch" value={watch === null ? 'Loading…' : watch.label.replace(/^AI: /, '')} tone={watch?.tone === 'warn' ? 'gold' : undefined} />
      {watch !== null && <p style={{ margin: '0.3rem 0 0', fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{watch.detail}</p>}
      <p style={{ margin: '0.7rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        The limits are on <TextLink onClick={() => onNavigate('risk')}>Risk &amp; Safety</TextLink>. No model sizes, places or arms an order.
      </p>
    </Card>
  )
}
