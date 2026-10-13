import { PageHeader } from '../components/PageHeader'
import { BestPredictionCard, TopPredictions } from '../forecast/BestPredictionCard'
import { openPredictionOf, useForecast } from '../forecast/useForecast'
import { useLiveMarket } from '../hooks/useLiveMarket'
import { HoldingsSummary } from '../overview/HoldingsSummary'
import { MarketStatusStrip } from '../overview/MarketStatusStrip'
import { TopOpportunityCard } from '../overview/TopOpportunityCard'
import type { AiOrderProposal } from '../../shared/aiProposal'
import type { Page } from '../navigation/pages'

/** The first thing a person sees (the V6 document, §3, §70 and §118): the market in a line, the best
 * current prediction and the top three, then the watch's best opportunity, then what is held. Before
 * the forecast's first pass the prediction card says what it waits for. Everything Overview had stays
 * on Overview, under All Features. Opening it asks no model and places nothing. */
export function HomePage({ onPrepareOrder, onNavigate }: { onPrepareOrder: (proposal: AiOrderProposal) => void; onNavigate: (page: Page) => void }): React.JSX.Element {
  const { predictions, ranking } = useForecast()
  const best = ranking?.ranked[0] ?? null
  const prediction = best === null ? null : (predictions.get(best.pair) ?? null)
  const live = useLiveMarket(best === null ? [] : [best.pair])
  const top3 = ranking === null ? [] : ranking.ranked.filter((entry) => ranking.top3.includes(entry.pair))
  const details = (pair: string): void => {
    openPredictionOf(pair)
    onNavigate('predictions')
  }
  return (
    <>
      <PageHeader title="Home" subtitle="The market in a line, the best prediction now, what can be acted on, and what you hold" />
      <MarketStatusStrip />
      <BestPredictionCard prediction={prediction} ranked={best} live={live} onDetails={details} />
      <TopPredictions ranked={top3} predictions={predictions} onDetails={details} />
      <TopOpportunityCard onPrepareOrder={onPrepareOrder} onNavigate={onNavigate} />
      <HoldingsSummary onNavigate={onNavigate} />
    </>
  )
}
