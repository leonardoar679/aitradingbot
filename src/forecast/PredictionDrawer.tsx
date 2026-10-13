import { useEffect, useMemo, useState } from 'react'
import { buttonStyle, noteStyle } from '../agents/agentStyles'
import { useEventFeed } from '../agents/useEventFeed'
import { useNewsFeed } from '../news/useNewsFeed'
import { useNewsReadings } from '../news/useNewsReadings'
import { useMarketResearch } from '../hooks/useMarketResearch'
import { useNowSec } from '../utils/useNowSec'
import { describeNewsReading } from '../../shared/aiAdditions'
import { HORIZONS, type Horizon } from '../../shared/forecast/features'
import type { PredictionLine } from '../../shared/forecast/forecastRecord'
import type { PricePrediction } from '../../shared/forecast/prediction'
import type { TradeDecision } from '../../shared/forecast/tradeDecision'
import { forecastView } from '../../shared/forecast/view'
import type { LiveState } from '../../shared/liveMarket'
import { ForecastHistoryChart } from './ForecastHistoryChart'
import { callColor, callLabel, decisionWords, leadHorizon, momentumWord, pairText, priceText, rangeText, signedPct, timeLeftText, volumeWord, HORIZON_NEXT, HORIZON_SHORT } from './forecastWords'

const section: React.CSSProperties = { borderTop: '1px solid var(--border)', paddingTop: '0.7rem', marginTop: '0.7rem' }
const heading: React.CSSProperties = { margin: '0 0 0.4rem', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)' }
const line: React.CSSProperties = { margin: '0.15rem 0', fontSize: '0.8rem', color: 'var(--text-primary)' }

/** One pair's forecast in full (the V6 document, §35-37, §58 and §94): its timeline, WHY? -- the
 * evidence behind it -- WHY THIS RANGE?, its history against the price, and the decision. Everything
 * here is read from the forecast, the research, the news on file and the records; nothing is asked. */
export function PredictionDrawer({ prediction, decision, live, onClose }: { prediction: PricePrediction; decision: TradeDecision | null; live: LiveState | null; onClose: () => void }): React.JSX.Element {
  const nowSec = useNowSec(true, 5_000)
  const research = useMarketResearch().state
  const feedState = useNewsFeed()
  const readings = useNewsReadings(feedState)
  const { feed } = useEventFeed(20)
  const [history, setHistory] = useState<PredictionLine[]>([])
  const lead = leadHorizon(prediction) ?? 'hour1'
  // The chart reads a day of the record: a 24-hour forecast's range falls a day on, so it opens on the hour.
  const [chartHorizon, setChartHorizon] = useState<Horizon>(lead === 'hours24' ? 'hour1' : lead)

  useEffect(() => {
    let cancelled = false
    void window.api.forecast.history(prediction.pair, Math.floor(Date.now() / 1000) - 24 * 3600).then(
      (record) => {
        if (!cancelled) setHistory(record.predictions)
      },
      () => undefined
    )
    return (): void => {
      cancelled = true
    }
  }, [prediction.pair, prediction.barTime])

  const book = live?.books[prediction.pair]
  const livePrice = book !== undefined && book.bid > 0 && book.ask > 0 ? (book.bid + book.ask) / 2 : null
  const view = forecastView(prediction, livePrice, nowSec * 1000)
  const leadRange = prediction.horizons[lead]
  const pair = research?.pairs.find((entry) => entry.symbol === prediction.pair)
  const story = leadRange?.news.v4 ?? leadRange?.news.v3 ?? null
  const kind = story === null ? undefined : feedState?.impact.find((row) => row.eventType === story.kind)
  const reading = story === null ? undefined : readings[story.storyId]
  const answers = useMemo(() => feed.find((item) => item.event.symbol === prediction.pair && item.answers.length > 0)?.answers ?? [], [feed, prediction.pair])
  const words = decisionWords(decision)

  return (
    <aside
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'min(46rem, 100vw)',
        overflowY: 'auto',
        background: 'var(--bg-surface)',
        borderLeft: '1px solid var(--border)',
        boxShadow: '-8px 0 24px rgba(0,0,0,0.25)',
        padding: '1.25rem',
        zIndex: 50
      }}
      aria-label={`The forecast of ${pairText(prediction.pair)}`}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem', flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0, fontSize: '1.15rem' }}>{pairText(prediction.pair)}</h2>
        {leadRange !== undefined && <strong style={{ color: callColor(leadRange.direction) }}>{callLabel(leadRange)}</strong>}
        <span style={noteStyle}>
          ${priceText(view.price)} {view.priceFrom === 'live' ? `(live, ${signedPct(view.movedPct)} since the close)` : '(last close)'}
        </span>
        <button type="button" style={{ ...buttonStyle('secondary'), marginLeft: 'auto' }} onClick={onClose}>
          Close
        </button>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
        Read at the {new Date(prediction.barTime * 1000).toISOString().slice(11, 16)} UTC close; confidence {prediction.confidence}% the way it leans, reliability {prediction.reliability}
        {leadRange !== undefined && leadRange.reliabilityReasons.length > 0 ? ` (${leadRange.reliabilityReasons.join('; ')})` : ''}.
      </p>

      <div style={section}>
        <h3 style={heading}>Timeline</h3>
        <p style={line}>NOW · ${priceText(view.price)}</p>
        {HORIZONS.map((horizon) => {
          const range = view.horizons[horizon]
          const full = prediction.horizons[horizon]
          if (range === undefined || full === undefined) return null
          return (
            <p key={horizon} style={{ ...line, paddingLeft: '1rem', borderLeft: `2px solid ${callColor(full.direction)}` }}>
              <strong>{HORIZON_SHORT[horizon]}</strong> · {callLabel(full)} · likely {rangeText(range.lowPct, range.highPct)} · bear {signedPct(range.bearPct)} · bull {signedPct(range.bullPct)} · P(up) {Math.round(full.pUp * 100)}% · quality {full.quality.score} · {timeLeftText(range.timeLeftMs)}
              {range.invalidated ? ' · INVALIDATED: the price has left its 80% range' : ''}
            </p>
          )
        })}
      </div>

      <div style={section}>
        <h3 style={heading}>Why?</h3>
        <p style={line}>24 hours: {pair === undefined ? '—' : signedPct(pair.change24hPct)} · 7 days: {pair?.change7dPct === null || pair === undefined ? '—' : signedPct(pair.change7dPct)}</p>
        <p style={line}>Momentum: {momentumWord(prediction.market?.z1h)} · Volume: {volumeWord(prediction.market?.volRatio1h)} · Market: {prediction.regime}</p>
        <p style={line}>
          News:{' '}
          {story === null
            ? 'no story about the coin in the last four hours'
            : `${story.kind.toLowerCase()} story, impact ${story.impact} — "${story.title}" (${story.source}); it moved the median ${signedPct(story.shiftPct)}${story.fromLibrary ? '' : ' (no history for its kind: it only widened the range)'}`}
        </p>
        {kind?.medianPct !== null && kind?.medianPct !== undefined && (
          <p style={line}>
            Stories of its kind before ({kind.stories}): median move {signedPct(kind.medianPct.m5 ?? Number.NaN)} at 5 min, {signedPct(kind.medianPct.h1 ?? Number.NaN)} at 1 h, {signedPct(kind.medianPct.h4 ?? Number.NaN)} at 4 h.
          </p>
        )}
        {reading !== undefined && <p style={line}>The news analyst read it as: {describeNewsReading(reading)}. AI summary, in its own words: “{reading.reasons}”</p>}
        {answers.length > 0 && (
          <p style={line}>
            The watch's models on its event:{' '}
            {answers.map((answer) => `${answer.model}: ${answer.decision.recommendation}${answer.decision.rationale ? ` — “${answer.decision.rationale.slice(0, 160)}”` : ''}`).join(' · ')}
          </p>
        )}
        {leadRange !== undefined && (
          <p style={line}>
            The models at {HORIZON_SHORT[lead]}: {leadRange.contributions.map((member) => `${member.model} ${Math.round(member.weight * 100)}% (median ${signedPct(member.medianLogPct)})`).join(', ')}; calibration moved it {signedPct(leadRange.calibrationShiftLogPct)}
            {leadRange.newsShiftLogPct !== 0 ? `, the news ${signedPct(leadRange.newsShiftLogPct)}` : ''}.
          </p>
        )}
      </div>

      {leadRange !== undefined && (
        <div style={section}>
          <h3 style={heading}>Why this range?</h3>
          <p style={line}>
            Its 80% range is {leadRange.width80Pct.toFixed(2)}% wide, against {leadRange.usualWidth80Pct.toFixed(2)}% usual for its kind of coin at {HORIZON_SHORT[lead]}: the forecast expects {leadRange.width80Pct > leadRange.usualWidth80Pct ? 'wider' : 'narrower'} moves than usual.{' '}
            {leadRange.rangeDrivers.length === 0
              ? `No boosted model weighs at ${HORIZON_SHORT[lead]}: its range is the other models' reading of the day's volatility.`
              : `What moved the ${leadRange.rangeDrivers[0].model === 'gbt-price' ? 'price-only boosted' : 'boosted'} model's reading of the move's size most:`}
          </p>
          <ol style={{ margin: '0.2rem 0 0.2rem 1.2rem', padding: 0 }}>
            {leadRange.rangeDrivers.map((driver) => (
              <li key={driver.feature} style={line}>
                {driver.text}
              </li>
            ))}
            {story !== null && (story.widenPct > 0 || story.widenShare > 0) && <li style={line}>a story about the coin, which widened it</li>}
            {leadRange.spreadStretch > 1 && <li style={line}>a thin book: its spread widened it {Math.round((leadRange.spreadStretch - 1) * 100)}%</li>}
          </ol>
        </div>
      )}

      <div style={section}>
        <h3 style={heading}>Its forecasts against the price</h3>
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
          {HORIZONS.filter((horizon) => horizon !== 'hours24').map((horizon) => (
            <button key={horizon} type="button" style={buttonStyle(horizon === chartHorizon ? 'primary' : 'secondary')} onClick={() => setChartHorizon(horizon)}>
              {HORIZON_SHORT[horizon]}
            </button>
          ))}
        </div>
        {history.length === 0 ? <p style={noteStyle}>No forecast of it on record yet: one is kept every quarter hour.</p> : <ForecastHistoryChart lines={history} horizon={chartHorizon} />}
        <p style={noteStyle}>The blue lines are each forecast's likely range and the dotted ones its 80% range, drawn at the moment it was a forecast for; the gold line is the price at each close.</p>
      </div>

      <div style={section}>
        <h3 style={heading}>The trade</h3>
        <p style={{ ...line, fontWeight: 600, color: words.trade ? 'var(--up)' : 'var(--text-secondary)' }}>{words.label}</p>
        {words.detail !== '' && <p style={noteStyle}>{words.detail}</p>}
        {prediction.invalidationConditions.length > 0 && <p style={{ ...noteStyle, marginTop: '0.4rem' }}>It would be undone if: {prediction.invalidationConditions.join(' ')}</p>}
        <p style={{ ...noteStyle, marginTop: '0.4rem' }}>{HORIZON_NEXT[lead]} is its lead horizon. A forecast is not a trade; nothing was placed.</p>
      </div>
    </aside>
  )
}
