import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { SummaryLine } from '../components/SummaryLine'
import { TextLink } from '../components/TextLink'
import { watchPaperExecutors } from '../../shared/aiWatchPaper'
import type { ExecutorConfig, LivePosition } from '../../shared/ipc'
import { usePortfolioSnapshots, usePortfolioStatus } from '../portfolio/portfolioStore'
import type { Page } from '../navigation/pages'
import { portfolioValueLine } from './portfolioValueLine'
import { Interpolate, useI18n } from '../i18n'

const POLL_MS = 30_000

/** What you hold: the portfolio's value, the paper strategies running (and how many of them the
 * watch opened), and the real positions open. It reads; it changes nothing. */
export function HoldingsSummary({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
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
  const running = executors === null ? null : executors.filter((executor) => executor.mode === 'paper' && executor.status === 'active')
  const watchOpen = executors === null ? 0 : watchPaperExecutors(executors).filter((executor) => executor.status === 'active').length

  return (
    <Card title={t('What you hold')}>
      <SummaryLine
        label={t('Portfolio value')}
        value={
          status !== 'ready' || latest === null
            ? status === 'error'
              ? t('Unavailable')
              : t('Loading…')
            : portfolioValueLine(snapshots[0], latest, i18n)
        }
      />
      <SummaryLine
        label={t('Paper strategies running')}
        value={
          running === null
            ? t('Loading…')
            : running.length === 0
              ? t('None')
              : watchOpen > 0
                ? t('{count}, {watch} opened by the watch', { count: running.length, watch: watchOpen })
                : String(running.length)
        }
      />
      <SummaryLine
        label={t('Real positions open')}
        value={positions === null ? t('Loading…') : positions.length === 0 ? t('None') : t('{count}: {pairs}', { count: positions.length, pairs: positions.map((position) => position.symbol).join(', ') })}
        tone={positions !== null && positions.length > 0 ? 'gold' : undefined}
      />
      <p style={{ margin: '0.7rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
        <Interpolate
          text={t('Every position is on {positions}, and how it has all done on {performance}.')}
          values={{
            positions: <TextLink onClick={() => onNavigate('positions')}>{t('Positions')}</TextLink>,
            performance: <TextLink onClick={() => onNavigate('performance')}>{t('Performance')}</TextLink>
          }}
        />
      </p>
    </Card>
  )
}
