import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { SummaryLine } from '../components/SummaryLine'
import { TextLink } from '../components/TextLink'
import { watchPaperExecutors } from '../../shared/aiWatchPaper'
import type { ExecutorConfig, LivePosition } from '../../shared/ipc'
import { usePortfolioSnapshots, usePortfolioStatus } from '../portfolio/portfolioStore'
import type { Page } from '../navigation/pages'

const POLL_MS = 30_000

function formatUsd(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** What you hold: the portfolio's value, the paper strategies running (and how many of them the
 * watch opened), and the real positions open. It reads; it changes nothing. */
export function HoldingsSummary({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const snapshots = usePortfolioSnapshots()
  const status = usePortfolioStatus()
  const [executors, setExecutors] = useState<ExecutorConfig[] | null>(null)
  const [positions, setPositions] = useState<LivePosition[] | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      window.api.settings.get().then(
        (settings) => {
          if (!cancelled) setExecutors(settings.executors)
        },
        () => undefined
      )
      window.api.liveTrading.listPositions().then(
        (next) => {
          if (!cancelled) setPositions(next.filter((position) => position.closedAt === null))
        },
        () => {
          if (!cancelled) setPositions([])
        }
      )
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const latest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  const sessionChange = snapshots.length >= 2 && latest !== null ? latest.totalValue - snapshots[0].totalValue : null
  const running = executors === null ? null : executors.filter((executor) => executor.mode === 'paper' && executor.status === 'active')
  const watchOpen = executors === null ? 0 : watchPaperExecutors(executors).filter((executor) => executor.status === 'active').length

  return (
    <Card title="What you hold">
      <SummaryLine
        label="Portfolio value"
        value={
          status !== 'ready' || latest === null
            ? status === 'error'
              ? 'Unavailable'
              : 'Loading…'
            : `${formatUsd(latest.totalValue)}${sessionChange === null ? '' : `, ${sessionChange >= 0 ? '+' : ''}${formatUsd(sessionChange)} this session`}`
        }
      />
      <SummaryLine
        label="Paper strategies running"
        value={running === null ? 'Loading…' : running.length === 0 ? 'None' : `${running.length}${watchOpen > 0 ? `, ${watchOpen} opened by the watch` : ''}`}
      />
      <SummaryLine
        label="Real positions open"
        value={positions === null ? 'Loading…' : positions.length === 0 ? 'None' : `${positions.length}: ${positions.map((position) => position.symbol).join(', ')}`}
        tone={positions !== null && positions.length > 0 ? 'gold' : undefined}
      />
      <p style={{ margin: '0.7rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        Every position is on <TextLink onClick={() => onNavigate('positions')}>Positions</TextLink>, and how it has all done on{' '}
        <TextLink onClick={() => onNavigate('performance')}>Performance</TextLink>.
      </p>
    </Card>
  )
}
