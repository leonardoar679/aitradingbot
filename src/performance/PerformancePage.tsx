import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { PortfolioHistory, PortfolioSummary } from '../portfolio/PortfolioSections'
import { LiveBoardCard } from '../agents/LiveBoardCard'
import { JournalCard } from '../agents/JournalCard'
import { getWatchActivity, subscribeWatchActivity } from '../agents/opportunityWatch'
import { watchPaperExecutors } from '../../shared/aiWatchPaper'
import type { ExecutorConfig } from '../../shared/ipc'
import { PaperRCurveCard } from './PaperRCurveCard'
import { ExitCheckCard } from './ExitCheckCard'
import { AiCostPerTradeCard } from './AiCostPerTradeCard'
import { SessionReportCard } from './SessionReportCard'
import { DailyReportCard } from './DailyReportCard'

/** How often the executors on file are read again: for which journal rows the watch paper traded,
 * and for the running total in R of the app's own paper trades. */
const PAPER_REFRESH_MS = 30_000

/** What has happened: the portfolio's value and what it is made of, what the watch's
 * recommendations went on to earn, and what the app's own paper trades came to, trade by trade. Everything here reads; nothing asks a model,
 * and every result is worked out again from candles rather than stored. */
export function PerformancePage(): React.JSX.Element {
  const [models, setModels] = useState<string[] | null>(null)
  const [executors, setExecutors] = useState<ExecutorConfig[] | null>(null)
  // The watch answers with nobody pressing anything, so the board is told when it has.
  const [answered, setAnswered] = useState(getWatchActivity().answered)

  useEffect(() => subscribeWatchActivity((activity) => setAnswered(activity.answered)), [])

  useEffect(() => {
    let cancelled = false
    void window.api.ai.getConfig().then(
      (config) => {
        if (!cancelled) setModels(config.watch.models)
      },
      () => {
        if (!cancelled) setModels([])
      }
    )
    return (): void => {
      cancelled = true
    }
  }, [])

  // The executors on file: which recommendations the watch paper traded, so the journal can say so
  // on their rows, and how the app's own paper trades ended.
  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      void window.api.settings.get().then(
        (settings) => {
          if (cancelled) return
          setExecutors(settings.executors)
        },
        () => undefined
      )
    }
    read()
    const timer = setInterval(read, PAPER_REFRESH_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [answered])

  const paperKeys = useMemo<ReadonlySet<string>>(
    () => new Set(watchPaperExecutors(executors ?? []).map((executor) => `${executor.watch?.eventId}:${executor.watch?.model}`)),
    [executors]
  )

  return (
    <>
      <PageHeader title="Performance" subtitle="What the portfolio, the bots and the AI's recommendations have done" />
      <PortfolioSummary />
      <PortfolioHistory />
      {models !== null && <LiveBoardCard title="What the watch's recommendations earned" models={models} refreshKey={answered} />}
      <PaperRCurveCard executors={executors} />
      <ExitCheckCard executors={executors} />
      <AiCostPerTradeCard executors={executors} />
      <SessionReportCard />
      <DailyReportCard />
      <JournalCard paper={paperKeys} />
    </>
  )
}
