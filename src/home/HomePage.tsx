import { useMemo } from 'react'
import { PageHeader } from '../components/PageHeader'
import { BigMoversView } from '../forecast/BigMoversCard'
import { forecastBehindText } from '../forecast/forecastWords'
import { openPredictionOf, useForecast } from '../forecast/useForecast'
import { useNowSec } from '../utils/useNowSec'
import { useLiveMarket } from '../hooks/useLiveMarket'
import { HoldingsSummary } from '../overview/HoldingsSummary'
import { MarketStatusStrip } from '../overview/MarketStatusStrip'
import { TopOpportunityCard } from '../overview/TopOpportunityCard'
import { PrimaryCallCard } from '../calls/PrimaryCallCard'
import { usePrimaryCall } from '../calls/usePrimaryCall'
import type { AiOrderProposal } from '../../shared/aiProposal'
import type { BigMoverHorizon } from '../../shared/forecast/bigMovers'
import type { Page } from '../navigation/pages'
import type { Handoff } from '../navigation/handoff'
import { useI18n } from '../i18n'
import { BitcoinTodayTile } from './BitcoinTodayTile'
import { CriticalNewsCard } from './CriticalNewsCard'
import { NewsPasteTile, PerformanceTile, PortfolioTile, TraderPasteTile } from './HomeTiles'

/** Home's big movers: four hours and a day, the sizes worth a trade (V9 Stage 1). */
const HOME_HORIZONS: readonly BigMoverHorizon[] = ['hours4', 'hours24']

/** The first thing a person sees (the V6 document, §3, §70 and §118; V8 Stages 3 and 10; V9 Stages 1 and 2): the market
 * in a line; the big movers -- the coins likely to move 2% within four hours and 5% within a day, how far and how soon, a
 * way only from a measured source -- Bitcoin's day, and the critical news: the first reports of large thefts and the
 * market's last shock; the tiles -- a news link and a trader to paste, how the recorded
 * calls came out, the paper books; then the primary call -- a card only from a measured source whose expected net after
 * costs clears its lines, or "No profitable opportunity identified" with why -- the watch's best opportunity, and what
 * is held. Until 6 November 2026 Home listed the forecast's top three by each pair's fifteen-minute middle range. Opening
 * it asks no model and places nothing. */
export function HomePage({ onPrepareOrder, onNavigate, onHandoff }: { onPrepareOrder: (proposal: AiOrderProposal) => void; onNavigate: (page: Page) => void; onHandoff: (handoff: Handoff) => void }): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  const { state, predictions } = useForecast()
  const nowSec = useNowSec(true, 30_000)
  const calls = usePrimaryCall()
  const best = calls?.cards[0] ?? null
  const live = useLiveMarket(best === null ? [] : [best.pair])
  const book = best === null ? undefined : live?.books[best.pair]
  const livePrice = book !== undefined && book.bid > 0 && book.ask > 0 ? (book.bid + book.ask) / 2 : null
  const forecasts = useMemo(() => [...predictions.values()], [predictions])
  const details = (pair: string): void => {
    openPredictionOf(pair)
    onNavigate('predictions')
  }
  return (
    <>
      <PageHeader title={t('Home')} subtitle={t('The market in a line, the best prediction now, what can be acted on, and what you hold')} />
      <MarketStatusStrip />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))', gap: '1.25rem', alignItems: 'start' }}>
        <BigMoversView predictions={forecasts} onOpen={details} horizons={HOME_HORIZONS} times calls={calls} behind={forecastBehindText(state, nowSec, i18n)} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', minWidth: 0 }}>
          <BitcoinTodayTile marketState={state?.engine.market?.state ?? null} />
          <CriticalNewsCard />
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))', gap: '1.25rem', alignItems: 'start' }}>
        <NewsPasteTile onPaste={(link) => onHandoff({ page: 'news-urls', link })} />
        <TraderPasteTile onPaste={(trader) => onHandoff({ page: 'copy-traders', trader })} />
        <PerformanceTile onOpen={() => onNavigate('performance')} />
        <PortfolioTile onStart={() => onHandoff({ page: 'paper-trading', askStart: true })} onOpen={() => onNavigate('paper-trading')} />
      </div>
      <PrimaryCallCard state={calls} predictions={forecasts} livePrice={livePrice} />
      <TopOpportunityCard onPrepareOrder={onPrepareOrder} onNavigate={onNavigate} />
      <HoldingsSummary onNavigate={onNavigate} />
    </>
  )
}
