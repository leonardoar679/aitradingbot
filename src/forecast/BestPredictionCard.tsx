import { useMemo } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, noteStyle } from '../agents/agentStyles'
import { opportunitySide } from '../../shared/aiOpportunity'
import type { PricePrediction } from '../../shared/forecast/prediction'
import type { RankedForecast } from '../../shared/forecast/ranking'
import { forecastView } from '../../shared/forecast/view'
import type { LiveState } from '../../shared/liveMarket'
import { useEventFeed } from '../agents/useEventFeed'
import { useNowSec } from '../utils/useNowSec'
import { aiConsensusWord, callColor, callLabel, decisionWords, leadHorizon, pairText, predictionCardRows, rangeText, timeLeftText, HORIZON_NEXT } from './forecastWords'

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
 * stream holds it (§41). Reading it asks no model and places nothing. */
export function BestPredictionCard({
  prediction,
  ranked,
  live,
  onDetails
}: {
  prediction: PricePrediction | null
  ranked: RankedForecast | null
  live: LiveState | null
  onDetails: (pair: string) => void
}): React.JSX.Element {
  const nowSec = useNowSec(true)
  const { feed } = useEventFeed(20)
  const consensus = useMemo(() => {
    if (prediction === null) return null
    const item = feed.find((entry) => entry.event.symbol === prediction.pair && entry.answers.length > 0)
    return item === undefined ? null : aiConsensusWord(item.answers.map((answer) => opportunitySide(answer.decision)))
  }, [feed, prediction])
  if (prediction === null) {
    return (
      <Card title="Best current prediction">
        <p style={noteStyle}>The forecast has not made its first pass yet: it waits for its bars, its first fit and its walk forward, a few minutes after a first start.</p>
      </Card>
    )
  }
  const book = live?.books[prediction.pair]
  const livePrice = book !== undefined && book.bid > 0 && book.ask > 0 ? (book.bid + book.ask) / 2 : null
  const view = forecastView(prediction, livePrice, nowSec * 1000)
  const lead = leadHorizon(prediction)
  const leadRange = lead === null ? undefined : prediction.horizons[lead]
  const leadView = lead === null ? undefined : view.horizons[lead]
  const decision = decisionWords(ranked?.decision)
  const rows = predictionCardRows(prediction, view, consensus)
  return (
    <Card title="Best current prediction" actions={<button type="button" style={buttonStyle('secondary')} onClick={() => onDetails(prediction.pair)}>Details</button>}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.9rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '1.25rem', fontWeight: 700 }}>{pairText(prediction.pair)}</span>
        {leadRange !== undefined && <span style={{ fontSize: '1rem', fontWeight: 700, color: callColor(leadRange.direction) }}>{callLabel(leadRange)}</span>}
        <span style={{ ...noteStyle, marginLeft: 'auto' }}>{leadView === undefined ? '' : timeLeftText(leadView.timeLeftMs)}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: '0.2rem 2rem', marginTop: '0.7rem' }}>
        {[rows.left, rows.right].map((column, index) => (
          <div key={index}>
            {column.map((row) => (
              <Row key={row.name} name={row.name}>
                {row.value}
              </Row>
            ))}
          </div>
        ))}
      </div>
      <div style={{ marginTop: '0.8rem', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-app)', border: '1px solid var(--border)' }}>
        <strong style={{ color: decision.trade ? 'var(--up)' : 'var(--text-secondary)' }}>{decision.label}</strong>
        {decision.detail !== '' && <span style={{ ...noteStyle, marginLeft: '0.5rem' }}>{decision.detail}</span>}
      </div>
      <p style={{ ...noteStyle, marginTop: '0.6rem' }}>
        A range, not a point: half the moves are meant to land inside the likely range, eight in ten between the bear and bull cases. It is a forecast, not a trade; nothing was placed.
      </p>
    </Card>
  )
}

/** The top three predictions (§70), each in a line. */
export function TopPredictions({ ranked, predictions, onDetails }: { ranked: RankedForecast[]; predictions: ReadonlyMap<string, PricePrediction>; onDetails: (pair: string) => void }): React.JSX.Element | null {
  if (ranked.length === 0) return null
  return (
    <Card title="Top predictions">
      <ol style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.35rem' }}>
        {ranked.map((entry) => {
          const prediction = predictions.get(entry.pair)
          const lead = prediction === undefined ? null : leadHorizon(prediction)
          const range = prediction === undefined || lead === null ? undefined : prediction.horizons[lead]
          return (
            <li key={entry.pair} style={{ fontSize: '0.84rem' }}>
              <button type="button" onClick={() => onDetails(entry.pair)} style={{ all: 'unset', cursor: 'pointer', display: 'inline-flex', gap: '0.7rem', flexWrap: 'wrap' }}>
                <strong>{pairText(entry.pair)}</strong>
                {range !== undefined && <span style={{ color: callColor(range.direction), fontWeight: 600 }}>{callLabel(range)}</span>}
                {range !== undefined && lead !== null && (
                  <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {HORIZON_NEXT[lead].replace('Next ', '')}: {rangeText(range.lowPct, range.highPct)}
                  </span>
                )}
                <span style={{ color: 'var(--text-muted)' }}>quality {entry.quality}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}
