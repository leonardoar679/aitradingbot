import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { SummaryLine } from '../components/SummaryLine'
import { TextLink } from '../components/TextLink'
import type { CredentialStatus, ExecutorConfig, LiveTradingStatus } from '../../shared/ipc'
import type { Page } from '../navigation/pages'
import { useNowSec } from '../utils/useNowSec'
import { todaysPaper } from './overviewBlocks'

const POLL_MS = 30_000

function money(amount: number): string {
  return `${amount > 0 ? '+' : ''}${Number(amount.toPrecision(4))}`
}

/** What the app's own paper trades did today, by the UTC day, and with a Binance key what real
 * trading realized today (the second V3 document, §51). It reads the executors on file and the live
 * gates' status; it changes nothing. */
export function TodayPerformanceCard({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const [executors, setExecutors] = useState<ExecutorConfig[] | null>(null)
  const [status, setStatus] = useState<LiveTradingStatus | null>(null)
  const [binance, setBinance] = useState<CredentialStatus | undefined>(undefined)
  const nowSec = useNowSec(true, 60_000)

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      window.api.settings.get().then(
        (settings) => {
          if (!cancelled) setExecutors(settings.executors)
        },
        () => undefined
      )
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
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const today = useMemo(() => (executors === null ? null : todaysPaper(executors, nowSec)), [executors, nowSec])

  return (
    <Card title="Today's performance">
      <SummaryLine
        label="The app's paper trades today"
        value={today === null ? 'Loading…' : `${today.opened} opened, ${today.closed} closed, ${today.openNow} open now`}
      />
      <SummaryLine
        label="Net of those closed"
        value={
          today === null
            ? 'Loading…'
            : today.closed === 0
              ? 'Nothing closed today'
              : `${today.net.map((entry) => `${money(entry.amount)} ${entry.asset}`).join(', ')} after fees; ${today.r >= 0 ? '+' : ''}${today.r.toFixed(2)} R over ${today.rTrades} with a stop`
        }
        tone={today !== null && today.net.some((entry) => entry.amount < 0) ? 'down' : today !== null && today.net.some((entry) => entry.amount > 0) ? 'up' : undefined}
      />
      {today !== null && today.best !== null && today.worst !== null && (
        <SummaryLine
          label="Best and worst"
          value={`${today.best.symbol} ${money(today.best.pnlQuote)}${today.worst.symbol !== today.best.symbol || today.closed > 1 ? `, ${today.worst.symbol} ${money(today.worst.pnlQuote)}` : ''}`}
        />
      )}
      {status !== null && binance?.configured === true && (
        <SummaryLine
          label="Real trading, realized today"
          value={`${status.realizedPnlToday >= 0 ? '+' : ''}${status.realizedPnlToday.toFixed(2)}, against a loss limit of ${status.dailyLossLimitQuote}`}
          tone={status.realizedPnlToday < 0 ? 'down' : undefined}
        />
      )}
      <p style={{ margin: '0.7rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        The running totals in R, the leaderboard and the session report are on <TextLink onClick={() => onNavigate('performance')}>Performance</TextLink>. Paper results
        say nothing about real money.
      </p>
    </Card>
  )
}
