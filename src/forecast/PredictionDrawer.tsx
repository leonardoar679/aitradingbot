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
import type { ForecastRange, PricePrediction } from '../../shared/forecast/prediction'
import type { I18n } from '../../shared/i18n/translate'
import { decideOnBook, type TradeDecision } from '../../shared/forecast/tradeDecision'
import { forecastView } from '../../shared/forecast/view'
import type { LiveState } from '../../shared/liveMarket'
import { ForecastHistoryChart } from './ForecastHistoryChart'
import type { AiOrderProposal } from '../../shared/aiProposal'
import { tradeThisOf } from './tradeThis'
import { useRiskTarget } from './useRiskTarget'
import { callColor, callLabel, decisionWords, dollarText, leadHorizon, likelyLevels, marketStateWord, momentumWord, pairText, rangeText, signedPct, timeLeftText, volumeWord, wayKnown, HORIZON_NEXT, HORIZON_SHORT, reliabilityWord } from './forecastWords'
import type { MoveRates } from '../../shared/forecast/moveRates'
import { VENUE_STAKE_QUOTE, type RoundTrip } from '../../shared/venueCosts'

const VENUE_NAMES: Record<RoundTrip['venue'], string> = { binance: 'Binance', bitget: 'Bitget' }

/** What a round trip on the pair costs now on each venue (V7.2-R Stage 4; shared/venueCosts.ts), from the public books
 * the main process reads for the forecast's top ten and its open trades; said as what a trade would pay. */
function VenueCosts({ pair, i18n }: { pair: string; i18n: I18n }): React.JSX.Element {
  const { t, pctPlain, num } = i18n
  const [costs, setCosts] = useState<{ trips: RoundTrip[]; cheapest: RoundTrip | null; at: number } | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    setCosts(undefined)
    window.api.forecast
      .venueCosts(pair)
      .then((read) => {
        if (live) setCosts(read)
      })
      .catch(() => {
        if (live) setCosts(null)
      })
    return (): void => {
      live = false
    }
  }, [pair])
  if (costs === undefined) return <p style={line}>…</p>
  if (costs === null) return <p style={line}>{t('No venue book is held for this pair yet: the forecast reads them for its top ten and its open trades.')}</p>
  const share = (value: number | null): string => (value === null ? '—' : pctPlain(value, 2))
  return (
    <>
      {costs.trips.map((trip) => (
        <p key={trip.venue} style={line}>
          {t('{venue}: {total} in all ({fee} fee each way, {spread} spread, {impact} for the stake)', {
            venue: VENUE_NAMES[trip.venue],
            total: share(trip.totalPct),
            fee: share(trip.feePct),
            spread: share(trip.spreadPct),
            impact: share(trip.impactPct)
          })}
        </p>
      ))}
      {costs.cheapest !== null && costs.trips.length > 1 && <p style={line}>{t('{venue} is the cheaper venue for this pair now.', { venue: VENUE_NAMES[costs.cheapest.venue] })}</p>}
      <p style={{ ...line, color: 'var(--text-secondary)' }}>{t("From each venue's public book in the last three minutes, for a buy of {stake}: what a trade would pay, not a forecast.", { stake: `$${num(VENUE_STAKE_QUOTE, 0, 0)}` })}</p>
    </>
  )
}
import { invalidationConditionsOf } from '../../shared/forecast/prediction'
import { driverText } from '../../shared/forecast/rangeDrivers'
import { reliabilityReasonText } from '../../shared/forecast/reliability'
import { HORIZON_NAME, REGIME_NAME, forecastModelName } from '../../shared/forecast/words'
import { storyKindWord, type NewsEventType } from '../../shared/newsFeed'
import { msg, useI18n } from '../i18n'

const section: React.CSSProperties = { borderTop: '1px solid var(--border)', paddingTop: '0.7rem', marginTop: '0.7rem' }
const heading: React.CSSProperties = { margin: '0 0 0.4rem', fontSize: '0.7rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-secondary)' }
const line: React.CSSProperties = { margin: '0.15rem 0', fontSize: '0.8rem', color: 'var(--text-primary)' }

/** Where the lead horizon's P(up) came from (V7.1 Stage 2), and the skill of that source on weeks it
 * was not fitted on; nothing for a forecast made before sources were recorded. */
function whichWayText(range: ForecastRange, i18n: I18n): string | null {
  const { t, pctPlain } = i18n
  if (range.pUpSource === undefined) return null
  const pUp = pctPlain(Math.round(range.pUp * 100), 0)
  const skill = range.directionSkill === null || !Number.isFinite(range.directionSkill) ? '—' : pctPlain(range.directionSkill * 100, 2)
  if (range.pUpSource === 'base') return t('Which way: P(up) {pUp} is the base rate, since no reading beat it on weeks it was not fitted on (the best skill: {skill}).', { pUp, skill })
  const source = range.pUpSource === 'distribution' ? t("the range's own distribution") : range.pUpSource === 'news' ? t('the news') : range.pUpSource
  return t('Which way: P(up) {pUp} from {source}, whose skill on weeks it was not fitted on is {skill}.', { pUp, source, skill })
}

const cell: React.CSSProperties = { padding: '0.2rem 0.6rem 0.2rem 0', textAlign: 'start', whiteSpace: 'nowrap' }

/** How often the coin moved over its last ninety days (V7.2-R Stage 3; shared/forecast/moveRates.ts): by horizon,
 * the share of hours whose close a horizon on was 1% up, 1% down, 2% and 5% either way, whose path touched 1%, and
 * the typical time to that touch. A frequency of the past, said as such. */
function MoveRatesTable({ rates, i18n }: { rates: MoveRates; i18n: I18n }): React.JSX.Element {
  const { t, pctPlain, num } = i18n
  const share = (value: number | undefined): string => (value === undefined ? '—' : pctPlain(Math.round(value * 100), 0))
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums', marginTop: '0.3rem' }}>
        <thead>
          <tr style={{ color: 'var(--text-secondary)' }}>
            {[t('Within'), t('Up 1%+'), t('Down 1%+'), t('2%+ either way'), t('5%+ either way'), t('Touched 1%'), t('Typically after')].map((label) => (
              <th key={label} style={{ ...cell, fontWeight: 600 }}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rates.horizons.map((entry) => {
            const at = (pct: number): { up: number; down: number; either: number } | undefined => entry.close.find((rate) => rate.pct === pct)
            const touch = entry.touch.find((rate) => rate.pct === 1)
            return (
              <tr key={entry.horizon}>
                <td style={cell}>{t(HORIZON_NAME[entry.horizon])}</td>
                <td style={cell}>{share(at(1)?.up)}</td>
                <td style={cell}>{share(at(1)?.down)}</td>
                <td style={cell}>{share(at(2)?.either)}</td>
                <td style={cell}>{share(at(5)?.either)}</td>
                <td style={cell}>{share(touch?.either)}</td>
                <td style={cell}>{touch === undefined || touch.medianMinutes === null ? '—' : t('{minutes} min', { minutes: num(Math.round(touch.medianMinutes), 0, 0) })}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** One pair's forecast in full (the V6 document, §35-37, §58 and §94): its timeline, WHY? -- the
 * evidence behind it -- WHY THIS RANGE?, its history against the price, and the decision. Everything
 * here is read from the forecast, the research, the news on file and the records; nothing is asked. */
export function PredictionDrawer({
  prediction,
  decision,
  live,
  onClose,
  onPrepareOrder
}: {
  prediction: PricePrediction
  decision: TradeDecision | null
  live: LiveState | null
  onClose: () => void
  /** TRADE THIS (V6 Stage 12): the plan filled into the Position form, for a person to place. */
  onPrepareOrder?: (proposal: AiOrderProposal) => void
}): React.JSX.Element {
  const i18n = useI18n()
  const { t, pctPlain, utcTime, num } = i18n
  const pct = (value: number | null | undefined): string => (value === null || value === undefined ? '—' : signedPct(value, 2, i18n))
  const nowSec = useNowSec(true, 5_000)
  const targetLevel = useRiskTarget()
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
  // The decision on the book the window holds now, where it holds one (shared/forecast/tradeDecision.ts).
  const decided = decision === null ? null : decideOnBook(decision, prediction, book, nowSec * 1000)
  const words = decisionWords(decided, i18n)
  const trade = tradeThisOf({ prediction, decision: decided, livePrice, targetLevel, nowSec }, i18n)
  const rtl = i18n.dir === 'rtl'
  const reasons = leadRange === undefined ? [] : (leadRange.reliabilityCodes?.map((code) => reliabilityReasonText(code, i18n)) ?? leadRange.reliabilityReasons)
  const undone = leadRange === undefined ? prediction.invalidationConditions : invalidationConditionsOf(prediction.direction, lead, leadRange, i18n)
  const price = dollarText(view.price, i18n)
  const horizonShort = t(HORIZON_SHORT[lead])
  // The likely high and low of the lead horizon, as prices (V7.1 Stage 3); null where the forecast carries none.
  const likely = leadRange === undefined ? null : likelyLevels(prediction, leadRange)

  return (
    <aside
      style={{
        position: 'fixed',
        top: 0,
        insetInlineEnd: 0,
        bottom: 0,
        width: 'min(46rem, 100vw)',
        overflowY: 'auto',
        background: 'var(--bg-surface)',
        borderInlineStart: '1px solid var(--border)',
        boxShadow: `${rtl ? 8 : -8}px 0 24px rgba(0,0,0,0.25)`,
        padding: '1.25rem',
        zIndex: 50
      }}
      aria-label={t('The forecast of {pair}', { pair: pairText(prediction.pair) })}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.8rem', flexWrap: 'wrap' }}>
        <h2 dir="ltr" style={{ margin: 0, fontSize: '1.15rem' }}>
          {pairText(prediction.pair)}
        </h2>
        {leadRange !== undefined && <strong style={{ color: callColor(leadRange.direction) }}>{callLabel(leadRange, i18n)}</strong>}
        <span style={noteStyle}>{view.priceFrom === 'live' ? t('{price} (live, {move} since the close)', { price, move: pct(view.movedPct) }) : t('{price} (last close)', { price })}</span>
        <button type="button" style={{ ...buttonStyle('secondary'), marginInlineStart: 'auto' }} onClick={onClose}>
          {t('Close')}
        </button>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
        {reasons.length > 0
          ? t('Read at the {time} UTC close; confidence {confidence} the way it leans, reliability {reliability} ({reasons}).', {
              time: utcTime(prediction.barTime * 1000),
              confidence: pctPlain(prediction.confidence, 0),
              reliability: reliabilityWord(prediction.reliability, i18n),
              reasons: reasons.join(t('; '))
            })
          : t('Read at the {time} UTC close; confidence {confidence} the way it leans, reliability {reliability}.', {
              time: utcTime(prediction.barTime * 1000),
              confidence: pctPlain(prediction.confidence, 0),
              reliability: reliabilityWord(prediction.reliability, i18n)
            })}
      </p>

      <div style={section}>
        <h3 style={heading}>{t('Timeline')}</h3>
        <p style={line}>{t('NOW · {price}', { price })}</p>
        {HORIZONS.map((horizon) => {
          const range = view.horizons[horizon]
          const full = prediction.horizons[horizon]
          if (range === undefined || full === undefined) return null
          return (
            <p key={horizon} style={{ ...line, paddingInlineStart: '1rem', borderInlineStart: `2px solid ${callColor(full.direction)}` }}>
              <strong>{t(HORIZON_SHORT[horizon])}</strong>{' '}
              {t('· {call} · likely {range} · bear {bear} · bull {bull} · P(up) {pUp} · quality {quality} · {time}', {
                call: callLabel(full, i18n),
                range: rangeText(range.lowPct, range.highPct, i18n),
                bear: pct(range.bearPct),
                bull: pct(range.bullPct),
                pUp: pctPlain(Math.round(full.pUp * 100), 0),
                quality: full.quality.score,
                time: timeLeftText(range.timeLeftMs, i18n)
              })}
              {range.invalidated ? ` ${t('· INVALIDATED: the price has left its 80% range')}` : ''}
            </p>
          )
        })}
      </div>

      <div style={section}>
        <h3 style={heading}>{t('Why?')}</h3>
        <p style={line}>{t('24 hours: {day} · 7 days: {week}', { day: pct(pair?.change24hPct), week: pct(pair?.change7dPct) })}</p>
        <p style={line}>
          {t('Momentum: {momentum} · Volume: {volume} · Market: {regime}', {
            momentum: momentumWord(prediction.market?.z1h, i18n),
            volume: volumeWord(prediction.market?.volRatio1h, i18n),
            regime: t(REGIME_NAME[prediction.regime] ?? prediction.regime)
          })}
        </p>
        {leadRange !== undefined && whichWayText(leadRange, i18n) !== null && <p style={line}>{whichWayText(leadRange, i18n)}</p>}
        <p style={line}>
          {story === null
            ? t('News: no story about the coin in the last four hours')
            : story.fromLibrary
              ? t('News: {kind} story, impact {impact} — “{title}” ({source}); it moved the median {shift}', {
                  kind: storyKindWord(story.kind as NewsEventType, i18n),
                  impact: story.impact,
                  title: story.title,
                  source: story.source,
                  shift: pct(story.shiftPct)
                })
              : t('News: {kind} story, impact {impact} — “{title}” ({source}); it moved the median {shift} (no history for its kind: it only widened the range)', {
                  kind: storyKindWord(story.kind as NewsEventType, i18n),
                  impact: story.impact,
                  title: story.title,
                  source: story.source,
                  shift: pct(story.shiftPct)
                })}
        </p>
        {kind?.medianPct !== null && kind?.medianPct !== undefined && (
          <p style={line}>
            {t('Stories of its kind before ({count}): median move {m5} at 5 min, {h1} at 1 h, {h4} at 4 h.', {
              count: kind.stories,
              m5: pct(kind.medianPct.m5 ?? Number.NaN),
              h1: pct(kind.medianPct.h1 ?? Number.NaN),
              h4: pct(kind.medianPct.h4 ?? Number.NaN)
            })}
          </p>
        )}
        {reading !== undefined && (
          <p style={line}>
            {t('The news analyst read it as: {reading}.', { reading: describeNewsReading(reading, i18n) })} <AiWords label={t('AI summary, in its own words:')} words={reading.reasons} />
          </p>
        )}
        {answers.length > 0 && (
          <div style={line}>
            {t("The watch's models on its event:")}
            {answers.map((answer) => (
              <p key={answer.model} style={{ ...line, paddingInlineStart: '1rem' }}>
                <span dir="ltr">{answer.model}</span>: {t(RECOMMENDATIONS[answer.decision.recommendation] ?? answer.decision.recommendation)}
                {answer.decision.rationale ? (
                  <>
                    {' '}
                    <AiWords label={t('AI summary, in its own words:')} words={answer.decision.rationale.slice(0, 160)} />
                  </>
                ) : null}
              </p>
            ))}
          </div>
        )}
        {leadRange !== undefined && (
          <p style={line}>
            {leadRange.newsShiftLogPct !== 0
              ? t('The models at {horizon}: {members}; calibration moved it {shift}, the news {news}.', {
                  horizon: horizonShort,
                  members: membersText(leadRange.contributions),
                  shift: pct(leadRange.calibrationShiftLogPct),
                  news: pct(leadRange.newsShiftLogPct)
                })
              : t('The models at {horizon}: {members}; calibration moved it {shift}.', {
                  horizon: horizonShort,
                  members: membersText(leadRange.contributions),
                  shift: pct(leadRange.calibrationShiftLogPct)
                })}
          </p>
        )}
      </div>

      {leadRange !== undefined && (
        <div style={section}>
          <h3 style={heading}>{t('Why this range?')}</h3>
          <p style={line}>
            {leadRange.width80Pct > leadRange.usualWidth80Pct
              ? t('Its 80% range is {width} wide, against {usual} usual for its kind of coin at {horizon}: the forecast expects wider moves than usual.', { width: pctPlain(leadRange.width80Pct, 2), usual: pctPlain(leadRange.usualWidth80Pct, 2), horizon: horizonShort })
              : t('Its 80% range is {width} wide, against {usual} usual for its kind of coin at {horizon}: the forecast expects narrower moves than usual.', { width: pctPlain(leadRange.width80Pct, 2), usual: pctPlain(leadRange.usualWidth80Pct, 2), horizon: horizonShort })}{' '}
            {leadRange.rangeDrivers.length === 0
              ? t("No boosted model weighs at {horizon}: its range is the other models' reading of the day's volatility.", { horizon: horizonShort })
              : leadRange.rangeDrivers[0].model === 'gbt-price'
                ? t("What moved the price-only boosted model's reading of the move's size most:")
                : t("What moved the boosted model's reading of the move's size most:")}
          </p>
          <ol style={{ margin: '0.2rem 0', paddingInlineStart: '1.2rem' }}>
            {leadRange.rangeDrivers.map((driver) => (
              <li key={driver.feature} style={line}>
                {driverText(driver, i18n)}
              </li>
            ))}
            {story !== null && (story.widenPct > 0 || story.widenShare > 0) && <li style={line}>{t('a story about the coin, which widened it')}</li>}
            {leadRange.spreadStretch > 1 && <li style={line}>{t('a thin book: its spread widened it {share}', { share: pctPlain(Math.round((leadRange.spreadStretch - 1) * 100), 0) })}</li>}
            {leadRange.shock !== null && leadRange.shock !== undefined && leadRange.shock.held !== null && (
              <li style={line}>
                {leadRange.shock.state === undefined || leadRange.shock.state === null
                  ? t("Bitcoin's sharp move ({moves} usual moves in fifteen minutes) widened it ×{factor}: on the weeks tested, after such moves it held {before} of the time, widened {after}", {
                      moves: num(Math.abs(leadRange.shock.btc15), 1, 1),
                      factor: num(leadRange.shock.k80, 2, 2),
                      before: pctPlain(Math.round(leadRange.shock.held.before * 100), 0),
                      after: pctPlain(Math.round(leadRange.shock.held.after * 100), 0)
                    })
                  : t("the market's state ({state}) widened it ×{factor}: on the weeks tested, in that state it held {before} of the time, widened {after}", {
                      state: marketStateWord(leadRange.shock.state, i18n),
                      factor: num(leadRange.shock.k80, 2, 2),
                      before: pctPlain(Math.round(leadRange.shock.held.before * 100), 0),
                      after: pctPlain(Math.round(leadRange.shock.held.after * 100), 0)
                    })}
              </li>
            )}
          </ol>
        </div>
      )}

      {prediction.moveRates !== undefined && prediction.moveRates !== null && (
        <div style={section}>
          <h3 style={heading}>{t('How often it moved, its last 90 days')}</h3>
          <p style={line}>{t("At every hour of the coin's last 90 days, how far its own price had moved a horizon on: a frequency of the past, not a forecast. Which way it goes next is not known.")}</p>
          <MoveRatesTable rates={prediction.moveRates} i18n={i18n} />
        </div>
      )}

      <div style={section}>
        <h3 style={heading}>{t('What a round trip costs now')}</h3>
        <VenueCosts pair={prediction.pair} i18n={i18n} />
      </div>

      {leadRange !== undefined && (leadRange.excursion !== undefined || leadRange.arrival !== undefined) && (
        <div style={section}>
          <h3 style={heading}>{t('Price and time')}</h3>
          {likely !== null && !wayKnown(leadRange) && (
            <p style={line}>
              {t('The path likely stays under {high} ({highPct}) and above {low} ({lowPct}) within {horizon}, eight times in ten; no expected price is forecast, since no way is known.', {
                horizon: horizonShort,
                high: dollarText(likely.high, i18n),
                highPct: pct(likely.highPct),
                low: dollarText(likely.low, i18n),
                lowPct: pct(likely.lowPct)
              })}
            </p>
          )}
          {likely !== null && wayKnown(leadRange) && (
            <p style={line}>
              {t('Expected {price} ({move}) at {horizon}; the path likely stays under {high} ({highPct}) and above {low} ({lowPct}), eight times in ten.', {
                price: dollarText(leadRange.quantilePrices[2], i18n),
                move: pct(leadRange.medianPct),
                horizon: horizonShort,
                high: dollarText(likely.high, i18n),
                highPct: pct(likely.highPct),
                low: dollarText(likely.low, i18n),
                lowPct: pct(likely.lowPct)
              })}
            </p>
          )}
          {leadRange.arrival !== undefined && wayKnown(leadRange) && (
            <p style={line}>
              {leadRange.arrival.unlikely
                ? t('Reaching it within {horizon} is unlikely ({share}): no time is said.', { horizon: horizonShort, share: pctPlain(Math.round(leadRange.arrival.pWithin[lead === 'hours24' ? 'hours4' : lead] * 100), 0) })
                : leadRange.arrival.medianMinutes === null
                  ? t('The expected price is reached within 5 min {m5} of the time, 15 min {m15}, 1 hour {h1}, 4 hours {h4}.', {
                      m5: pctPlain(Math.round(leadRange.arrival.pWithin.minutes5 * 100), 0),
                      m15: pctPlain(Math.round(leadRange.arrival.pWithin.minutes15 * 100), 0),
                      h1: pctPlain(Math.round(leadRange.arrival.pWithin.hour1 * 100), 0),
                      h4: pctPlain(Math.round(leadRange.arrival.pWithin.hours4 * 100), 0)
                    })
                  : t('The expected price is reached within 5 min {m5} of the time, 15 min {m15}, 1 hour {h1}, 4 hours {h4}; when it is, typically in {minutes} min.', {
                      m5: pctPlain(Math.round(leadRange.arrival.pWithin.minutes5 * 100), 0),
                      m15: pctPlain(Math.round(leadRange.arrival.pWithin.minutes15 * 100), 0),
                      h1: pctPlain(Math.round(leadRange.arrival.pWithin.hour1 * 100), 0),
                      h4: pctPlain(Math.round(leadRange.arrival.pWithin.hours4 * 100), 0),
                      minutes: num(Math.round(leadRange.arrival.medianMinutes), 0, 0)
                    })}
            </p>
          )}
        </div>
      )}

      <div style={section}>
        <h3 style={heading}>{t('Its forecasts against the price')}</h3>
        <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
          {HORIZONS.filter((horizon) => horizon !== 'hours24').map((horizon) => (
            <button key={horizon} type="button" style={buttonStyle(horizon === chartHorizon ? 'primary' : 'secondary')} onClick={() => setChartHorizon(horizon)}>
              {t(HORIZON_SHORT[horizon])}
            </button>
          ))}
        </div>
        {history.length === 0 ? (
          <p style={noteStyle}>{t('No forecast of it on record yet: one is kept every quarter hour.')}</p>
        ) : (
          // A chart reads left to right in every language.
          <div dir="ltr">
            <ForecastHistoryChart lines={history} horizon={chartHorizon} />
          </div>
        )}
        <p style={noteStyle}>{t("The blue lines are each forecast's likely range and the dotted ones its 80% range, drawn at the moment it was a forecast for; the gold line is the price at each close.")}</p>
      </div>

      <div style={section}>
        <h3 style={heading}>{t('The trade')}</h3>
        <p style={{ ...line, fontWeight: 600, color: words.trade ? 'var(--up)' : 'var(--text-secondary)' }}>{words.label}</p>
        {words.detail !== '' && <p style={noteStyle}>{words.detail}</p>}
        {'plan' in trade && (
          <p style={line}>
            {t('The plan, from {price}: enter in {low} ~ {high} until {time} UTC; stop {stop} away ({stopPrice}); target {target} at its {level} ({targetPrice}); held at most {horizon}.', {
              price: dollarText(trade.plan.entryPrice, i18n),
              low: dollarText(trade.plan.entryMin, i18n),
              high: dollarText(trade.plan.entryMax, i18n),
              time: utcTime(trade.plan.validUntil * 1000),
              stop: pctPlain(trade.plan.stopPct, 2),
              stopPrice: dollarText(trade.plan.stopPrice, i18n),
              target: pctPlain(trade.plan.targetPct, 2),
              level: trade.plan.targetLevel,
              targetPrice: dollarText(trade.plan.targetPrice, i18n),
              horizon: t(HORIZON_SHORT[trade.plan.horizon])
            })}
          </p>
        )}
        {onPrepareOrder !== undefined && (
          <button
            type="button"
            style={{ ...buttonStyle('primary', 'problem' in trade), marginTop: '0.4rem' }}
            disabled={'problem' in trade}
            title={'problem' in trade ? trade.problem : t('Fills in the Position form, on paper; a person places it.')}
            onClick={() => {
              if ('proposal' in trade) onPrepareOrder(trade.proposal)
            }}
          >
            {t('TRADE THIS')}
          </button>
        )}
        {'problem' in trade && onPrepareOrder !== undefined && <p style={noteStyle}>{trade.problem}</p>}
        {undone.length > 0 && <p style={{ ...noteStyle, marginTop: '0.4rem' }}>{t('It would be undone if: {conditions}', { conditions: undone.join(' ') })}</p>}
        <p style={{ ...noteStyle, marginTop: '0.4rem' }}>{t('{horizon} is its lead horizon. A forecast is not a trade; nothing was placed.', { horizon: t(HORIZON_NEXT[lead]) })}</p>
      </div>
    </aside>
  )

  /** The weighing models, each with its weight and median. */
  function membersText(members: readonly { model: string; weight: number; medianLogPct: number }[]): string {
    return members.map((member) => t('{model} {weight} (median {median})', { model: forecastModelName(member.model, i18n), weight: pctPlain(Math.round(member.weight * 100), 0), median: pct(member.medianLogPct) })).join(t(', '))
  }
}

/** What a model recommended, in a word. */
const RECOMMENDATIONS: Record<string, string> = { buy: msg('buy'), sell: msg('sell'), hold: msg('hold') }

/** A model's own words (the V6 document, §89): labelled, and left as it wrote them, in its language. */
function AiWords({ label, words }: { label: string; words: string }): React.JSX.Element {
  return (
    <span>
      <em>{label}</em>{' '}
      <span lang="en" dir="auto">
        “{words}”
      </span>
    </span>
  )
}
