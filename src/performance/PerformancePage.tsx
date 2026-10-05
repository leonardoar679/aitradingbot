import { useEffect, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { PortfolioHistory, PortfolioSummary } from '../portfolio/PortfolioSections'
import { LiveBoardCard } from '../agents/LiveBoardCard'
import { JournalCard } from '../agents/JournalCard'
import { getWatchActivity, subscribeWatchActivity } from '../agents/opportunityWatch'
import { watchPaperExecutors } from '../../shared/aiWatchPaper'

/** How often the executors on file are read again, for which journal rows the watch paper traded. */
const PAPER_REFRESH_MS = 30_000

/** What has happened: the portfolio's value and what it is made of, and what the watch's
 * recommendations went on to earn, trade by trade. Everything here reads; nothing asks a model,
 * and every result is worked out again from candles rather than stored. */
export function PerformancePage(): React.JSX.Element {
  const [models, setModels] = useState<string[] | null>(null)
  const [paperKeys, setPaperKeys] = useState<ReadonlySet<string>>(new Set())
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

  // Which recommendations the watch paper traded, so the journal can say so on their rows.
  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      void window.api.settings.get().then(
        (settings) => {
          if (cancelled) return
          setPaperKeys(new Set(watchPaperExecutors(settings.executors).map((executor) => `${executor.watch?.eventId}:${executor.watch?.model}`)))
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

  return (
    <>
      <PageHeader title="Performance" subtitle="What the portfolio, the bots and the AI's recommendations have done" />
      <PortfolioSummary />
      <PortfolioHistory />
      {models !== null && <LiveBoardCard title="What the watch's recommendations earned" models={models} refreshKey={answered} />}
      <JournalCard paper={paperKeys} />
    </>
  )
}
