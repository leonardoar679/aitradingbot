import { useEffect, useMemo, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { anchorElementId } from '../navigation/pages'
import { PortfolioHistory, PortfolioSummary } from '../portfolio/PortfolioSections'
import { LiveBoardCard } from '../agents/LiveBoardCard'
import { JournalCard } from '../agents/JournalCard'
import { getWatchActivity, subscribeWatchActivity } from '../agents/opportunityWatch'
import { watchPaperExecutors } from '../../shared/aiWatchPaper'
import type { ExecutorConfig } from '../../shared/ipc'
import { PaperRCurveCard } from './PaperRCurveCard'
import { ExitCheckCard } from './ExitCheckCard'
import { AiCostPerTradeCard } from './AiCostPerTradeCard'
import { AttributionCard } from './AttributionCard'
import { SessionReportCard } from './SessionReportCard'
import { DailyReportCard } from './DailyReportCard'
import { CameTrueCard } from './CameTrueCard'
import { BooksReportCard } from './BooksReportCard'
import { ExportCard } from './ExportCard'
import { ChampionCard } from './ChampionCard'
import { EnglishOnly, useI18n } from '../i18n'

/** How often the executors on file are read again: for which journal rows the watch paper traded,
 * and for the running total in R of the app's own paper trades. */
const PAPER_REFRESH_MS = 30_000

/** What has happened: the portfolio's value and what it is made of; since V8 Stage 10 whether the recorded calls came
 * true, source by source, the three paper books beside their benchmarks, and the records exported in one click; what
 * the watch's recommendations went on to earn, and what the app's own paper trades came to, trade by trade, with the
 * price forecast's champion and challenger. Everything here reads; nothing asks a model, and every result is worked
 * out again from candles rather than stored. */
export function PerformancePage(): React.JSX.Element {
  const { t } = useI18n()
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
      <PageHeader title={t('Performance')} subtitle={t("What the portfolio, the bots and the AI's recommendations have done")} />
      {/* The summary in the window's language (V6 Stage 14); the analysis below it, for an expert, in English. */}
      <div id={anchorElementId('portfolio')} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', scrollMarginTop: '1rem' }}>
        <PortfolioSummary />
        <EnglishOnly>
          <PortfolioHistory />
        </EnglishOnly>
      </div>
      <CameTrueCard />
      <BooksReportCard />
      <PaperRCurveCard executors={executors} />
      <ExportCard />
      <EnglishOnly>
        <ChampionCard />
        {models !== null && <LiveBoardCard title="What the watch's recommendations earned" models={models} refreshKey={answered} />}
        <ExitCheckCard executors={executors} />
        <AiCostPerTradeCard executors={executors} />
        <AttributionCard executors={executors} />
        <SessionReportCard />
        <DailyReportCard />
        <JournalCard paper={paperKeys} />
      </EnglishOnly>
    </>
  )
}
