import { useMemo } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, noteStyle } from '../agents/agentStyles'
import { opportunitySide } from '../../shared/aiOpportunity'
import type { AiOrderProposal } from '../../shared/aiProposal'
import { tradeThisOf } from './tradeThis'
import { useRiskTarget } from './useRiskTarget'
import type { PricePrediction } from '../../shared/forecast/prediction'
import type { RankedForecast } from '../../shared/forecast/ranking'
import { decideOnBook } from '../../shared/forecast/tradeDecision'
import { forecastView } from '../../shared/forecast/view'
import type { LiveState } from '../../shared/liveMarket'
import { useEventFeed } from '../agents/useEventFeed'
import { useNowSec } from '../utils/useNowSec'
import { aiConsensusWord, callColor, callLabel, decisionWords, leadHorizon, pairText, predictionCardRows, rangeText, timeLeftText, HORIZON_NAME } from './forecastWords'
import { useI18n } from '../i18n'

const label: React.CSSProperties = { fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }
const value: React.CSSProperties = { fontSize: '0.86rem', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }

function Row({ name, children }: { name: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', padding: '0.2rem 0' }}>
      <span style={label}>{name}</span>
      <span style={value}>{children}</span>
    </div>
  )
}

/** The first thing Home shows (the V6 document, §3 and §118): the best current prediction -- the
 * ranking's first -- with its likely ranges, its bull and bear cases, its quality and reliability,
 * the story moving it, its volume and momentum, the models' vote where the watch asked about it, and
 * whether it is worth trading and, if not, why. The percentages are from the live price where the
 * stream holds it (§41), and so is the decision: the pass made it on the books the stream held then.
 * Reading it asks no model and places nothing. */
export function BestPredictionCard({
  prediction,
  ranked,
  live,
  onDetails,
  onPrepareOrder
}: {
  prediction: PricePrediction | null
  ranked: RankedForecast | null
  live: LiveState | null
  onDetails: (pair: string) => void
  /** TRADE THIS (V6 Stage 12): the plan filled into the Position form, for a person to place. */
  onPrepareOrder?: (proposal: AiOrderProposal) => void
}): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  const nowSec = useNowSec(true)
  const targetLevel = useRiskTarget()
  const { feed } = useEventFeed(20)
  const consensus = useMemo(() => {
    if (prediction === null) return null
    const item = feed.find((entry) => entry.event.symbol === prediction.pair && entry.answers.length > 0)
    return item === undefined ? null : aiConsensusWord(
      item.answers.map((answer) => opportunitySide(answer.decision)),
      i18n
    )
  }, [feed, prediction, i18n])
  if (prediction === null) {
    return (
      <Card title={t('Best current prediction')}>
        <p style={noteStyle}>{t('The forecast has not made its first pass yet: it waits for its bars, its first fit and its walk forward, a few minutes after a first start.')}</p>
      </Card>
    )
  }
  const book = live?.books[prediction.pair]
  const livePrice = book !== undefined && book.bid > 0 && book.ask > 0 ? (book.bid + book.ask) / 2 : null
  const view = forecastView(prediction, livePrice, nowSec * 1000)
  const lead = leadHorizon(prediction)
  const leadRange = lead === null ? undefined : prediction.horizons[lead]
  const leadView = lead === null ? undefined : view.horizons[lead]
  const decided = ranked === null ? undefined : decideOnBook(ranked.decision, prediction, book, nowSec * 1000)
  const decision = decisionWords(decided, i18n)
  const rows = predictionCardRows(prediction, view, consensus, i18n)
  const trade = tradeThisOf({ prediction, decision: decided, livePrice, targetLevel, nowSec }, i18n)
  return (
    <Card
      title={t('Best current prediction')}
      actions={
        <button type="button" style={buttonStyle('secondary')} onClick={() => onDetails(prediction.pair)}>
          {t('VIEW WHY')}
        </button>
      }
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.9rem', flexWrap: 'wrap' }}>
        <span dir="ltr" style={{ fontSize: '1.25rem', fontWeight: 700 }}>
          {pairText(prediction.pair)}
        </span>
        {leadRange !== undefined && <span style={{ fontSize: '1rem', fontWeight: 700, color: callColor(leadRange.direction) }}>{callLabel(leadRange, i18n)}</span>}
        <span style={{ ...noteStyle, marginInlineStart: 'auto' }}>{leadView === undefined ? '' : timeLeftText(leadView.timeLeftMs, i18n)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '0.2rem 2rem', marginTop: '0.7rem' }}>
        {[rows.left, rows.right].map((column, index) => (
          <div key={index}>
            {column.map((row) => (
              <Row key={row.id} name={row.name}>
                {row.value}
              </Row>
            ))}
          </div>
        ))}
      </div>
      <div style={{ marginTop: '0.8rem', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-app)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 18rem' }}>
          <strong style={{ color: decision.trade ? 'var(--up)' : 'var(--text-secondary)' }}>{decision.label}</strong>
          {decision.detail !== '' && <span style={{ ...noteStyle, marginInlineStart: '0.5rem' }}>{decision.detail}</span>}
        </div>
        {onPrepareOrder !== undefined && (
          <button
            type="button"
            style={buttonStyle('primary', 'problem' in trade)}
            disabled={'problem' in trade}
            title={'problem' in trade ? trade.problem : t('Fills in the Position form, on paper; a person places it.')}
            onClick={() => {
              if ('proposal' in trade) onPrepareOrder(trade.proposal)
            }}
          >
            {t('PAPER TRADE')}
          </button>
        )}
      </div>
      <p style={{ ...noteStyle, marginTop: '0.6rem' }}>
        {t('A range, not a point: half the moves are meant to land inside the likely range, eight in ten between the bear and bull cases. It is a forecast, not a trade; nothing was placed.')}
      </p>
    </Card>
  )
}

/** The top three predictions (§70), each in a line. */
export function TopPredictions({ ranked, predictions, onDetails }: { ranked: RankedForecast[]; predictions: ReadonlyMap<string, PricePrediction>; onDetails: (pair: string) => void }): React.JSX.Element | null {
  const i18n = useI18n()
  const { t } = i18n
  if (ranked.length === 0) return null
  return (
    <Card title={t('Top predictions')}>
      <ol style={{ margin: 0, paddingInlineStart: '1.2rem', display: 'grid', gap: '0.35rem' }}>
        {ranked.map((entry) => {
          const prediction = predictions.get(entry.pair)
          const lead = prediction === undefined ? null : leadHorizon(prediction)
          const range = prediction === undefined || lead === null ? undefined : prediction.horizons[lead]
          return (
            <li key={entry.pair} style={{ fontSize: '0.84rem' }}>
              <button type="button" onClick={() => onDetails(entry.pair)} style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', gap: '0.7rem', flexWrap: 'wrap' }}>
                <strong dir="ltr">{pairText(entry.pair)}</strong>
                {range !== undefined && <span style={{ color: callColor(range.direction), fontWeight: 600 }}>{callLabel(range, i18n)}</span>}
                {range !== undefined && lead !== null && (
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>{t('{horizon}: {range}', { horizon: t(HORIZON_NAME[lead]), range: rangeText(range.lowPct, range.highPct, i18n) })}</span>
                )}
                <span style={{ color: 'var(--text-muted)' }}>{t('quality {score}', { score: entry.quality })}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}
