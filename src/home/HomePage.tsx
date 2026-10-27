import { useMemo } from 'react'
import { PageHeader } from '../components/PageHeader'
import { TopPredictions } from '../forecast/BestPredictionCard'
import { openPredictionOf, useForecast } from '../forecast/useForecast'
import { useLiveMarket } from '../hooks/useLiveMarket'
import { HoldingsSummary } from '../overview/HoldingsSummary'
import { MarketStatusStrip } from '../overview/MarketStatusStrip'
import { TopOpportunityCard } from '../overview/TopOpportunityCard'
import { PrimaryCallCard } from '../calls/PrimaryCallCard'
import { usePrimaryCall } from '../calls/usePrimaryCall'
import type { AiOrderProposal } from '../../shared/aiProposal'
import type { Page } from '../navigation/pages'
import { useI18n } from '../i18n'

/** The first thing a person sees (the V6 document, §3, §70 and §118; V8 Stage 3): the market in a line, the primary
 * call -- a card only from a measured source whose expected net after costs clears its lines, or "No profitable
 * opportunity identified" with why -- and the top three forecasts by size, then the watch's best opportunity, then what
 * is held. The forecast's own best pair, with its lean, is on Predictions. Opening it asks no model and places
 * nothing. */
export function HomePage({ onPrepareOrder, onNavigate }: { onPrepareOrder: (proposal: AiOrderProposal) => void; onNavigate: (page: Page) => void }): React.JSX.Element {
  const { t } = useI18n()
  const { predictions, ranking } = useForecast()
  const calls = usePrimaryCall()
  const best = calls?.cards[0] ?? null
  const live = useLiveMarket(best === null ? [] : [best.pair])
  const book = best === null ? undefined : live?.books[best.pair]
  const livePrice = book !== undefined && book.bid > 0 && book.ask > 0 ? (book.bid + book.ask) / 2 : null
  const forecasts = useMemo(() => [...predictions.values()], [predictions])
  const top3 = ranking === null ? [] : ranking.ranked.filter((entry) => ranking.top3.includes(entry.pair))
  const details = (pair: string): void => {
    openPredictionOf(pair)
    onNavigate('predictions')
  }
  return (
    <>
      <PageHeader title={t('Home')} subtitle={t('The market in a line, the best prediction now, what can be acted on, and what you hold')} />
      <MarketStatusStrip />
      <PrimaryCallCard state={calls} predictions={forecasts} livePrice={livePrice} />
      <TopPredictions ranked={top3} predictions={predictions} onDetails={details} />
      <TopOpportunityCard onPrepareOrder={onPrepareOrder} onNavigate={onNavigate} />
      <HoldingsSummary onNavigate={onNavigate} />
    </>
  )
}
