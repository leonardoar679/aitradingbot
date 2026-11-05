import type { Direction } from '../../shared/forecast/direction'
import type { Horizon } from '../../shared/forecast/features'
import type { MarketShockState } from '../../shared/forecast/marketShock'
import { ratesAt } from '../../shared/forecast/moveRates'
import type { ForecastRange, PricePrediction } from '../../shared/forecast/prediction'
import { reasonText, type TradeDecision } from '../../shared/forecast/tradeDecision'
import type { PredictionView } from '../../shared/forecast/view'
import { forecastPrice, HORIZON_NAME, HORIZON_NEXT, HORIZON_SHORT } from '../../shared/forecast/words'
import type { ForecastState } from '../../shared/ipc'
import { ENGLISH, msg, type I18n } from '../../shared/i18n/translate'
import { durationOf, utcWhen } from '../traders/traderText'

// HOW THE FORECAST READS ON SCREEN (the V6 document, §3, §34-37, §70 and §118; V6 Stage 10, 13 October
// 2026): the same words on Home, the Predictions page and the drawer, so that a call, a range or a
// reason reads one way wherever it is shown. Words only; nothing here reads or asks anything. Since V6
// Stage 14 each is said in a language -- English unless handed the person's -- with its numbers in the
// language's own form (§86, §89).

export { HORIZON_NAME, HORIZON_NEXT, HORIZON_SHORT }

/** A call as it is shown: STRONG where it is, NEUTRAL / UNCERTAIN where the range is too wide (§61). */
export function callLabel(range: Pick<ForecastRange, 'direction' | 'strong' | 'uncertain'>, { t }: I18n = ENGLISH): string {
  if (range.uncertain) return t('NEUTRAL / UNCERTAIN')
  if (range.strong && range.direction === 'BULLISH') return t('STRONG BULLISH')
  if (range.strong && range.direction === 'BEARISH') return t('STRONG BEARISH')
  return t(CALL_NAMES[range.direction])
}

const CALL_NAMES: Record<Direction, string> = { BULLISH: msg('BULLISH'), BEARISH: msg('BEARISH'), NEUTRAL: msg('NEUTRAL') }

export function callColor(direction: Direction): string {
  return direction === 'BULLISH' ? 'var(--up)' : direction === 'BEARISH' ? 'var(--down)' : 'var(--text-secondary)'
}

/** A move in percent with its sign: +0.80%, -1.20%; none on a move that rounds to nothing. */
export function signedPct(value: number, digits = 2, i18n: I18n = ENGLISH): string {
  return i18n.pct(value, digits)
}

/** A likely range: +0.80% ~ +2.10%. */
export function rangeText(lowPct: number, highPct: number, i18n: I18n = ENGLISH): string {
  return i18n.t('{low} ~ {high}', { low: i18n.pct(lowPct, 2), high: i18n.pct(highPct, 2) })
}

/** A price as the app writes one: six significant figures. */
export function priceText(value: number, i18n: I18n = ENGLISH): string {
  return forecastPrice(value, i18n)
}

/** A price in dollars, six significant figures: $182.4 where English puts the sign, 182,4 $ where
 * Vietnamese does. */
export function dollarText(value: number, i18n: I18n = ENGLISH): string {
  return i18n.dollars(value)
}

/** A pair as it reads: SOL / USDT. */
export function pairText(pair: string): string {
  return pair.endsWith('USDT') ? `${pair.slice(0, -4)} / USDT` : pair
}

/** How long a forecast has left before its horizon's close (§38): FORECAST EXPIRED once it has none. */
export function timeLeftText(ms: number, { t, num }: I18n = ENGLISH): string {
  if (!(ms > 0)) return t('FORECAST EXPIRED')
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return t('valid {minutes} min', { minutes: num(minutes, 0, 0) })
  const hours = ms / 3_600_000
  return t('valid {hours} h', { hours: hours < 10 ? num(hours, 1, 1) : num(Math.round(hours), 0, 0) })
}

/** The coin's last hour in its usual moves, in a word (§3's "Momentum"). */
export function momentumWord(z1h: number | null | undefined, { t }: I18n = ENGLISH): string {
  if (z1h === null || z1h === undefined || !Number.isFinite(z1h)) return '—'
  if (z1h >= 2) return t('STRONG UP')
  if (z1h >= 1) return t('UP')
  if (z1h <= -2) return t('STRONG DOWN')
  if (z1h <= -1) return t('DOWN')
  return t('FLAT')
}

/** Its volume against its usual hour (§3's "Volume: 3.7×"). */
export function volumeWord(ratio: number | null | undefined, { t, num }: I18n = ENGLISH): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—'
  return t('{ratio}× its usual hour', { ratio: num(ratio, 1, 1) })
}

/** The story moving the forecast, in a line (§3's "News catalyst"). Its headline is the feed's own. */
export function newsWord(prediction: Pick<PricePrediction, 'mainCatalyst' | 'newsImpact'>, { t }: I18n = ENGLISH): string {
  if (prediction.mainCatalyst === undefined) return t('none')
  const impact = prediction.newsImpact ?? 0
  const catalyst = prediction.mainCatalyst
  if (impact >= 70) return t('HIGH IMPACT · {catalyst}', { catalyst })
  return impact >= 40 ? t('MODERATE IMPACT · {catalyst}', { catalyst }) : t('LOW IMPACT · {catalyst}', { catalyst })
}

/** What the decision says, as a label and the reasons behind a NO TRADE. */
export function decisionWords(decision: TradeDecision | null | undefined, i18n: I18n = ENGLISH): { label: string; detail: string; trade: boolean } {
  const { t } = i18n
  if (decision === null || decision === undefined) return { label: t('NO DECISION YET'), detail: '', trade: false }
  if (decision.decision === 'TRADE') return { label: decision.side === 'SELL' ? t('TRADE: SELL') : t('TRADE: BUY'), detail: decision.side === 'SELL' ? t('A sell is a paper trade only.') : '', trade: true }
  return { label: t('NO TRADE'), detail: decision.reasons.map((reason) => reasonText(reason, decision.horizon, i18n)).join(' '), trade: false }
}

/** A decision's first reason, in a language: what a table row shows of a NO TRADE. */
export function firstReason(decision: TradeDecision, i18n: I18n = ENGLISH): string {
  const reason = decision.reasons[0]
  return reason === undefined ? '' : reasonText(reason, decision.horizon, i18n)
}

/** The models asked about the coin's event, in a line (§118's "AI consensus: 3 / 3"). */
export function aiConsensusWord(sides: readonly ('long' | 'short' | null)[], { t }: I18n = ENGLISH): string | null {
  if (sides.length === 0) return null
  const up = sides.filter((side) => side === 'long').length
  const down = sides.filter((side) => side === 'short').length
  const total = sides.length
  if (up > down) return t('{count} / {total} bullish', { count: up, total })
  if (down > up) return t('{count} / {total} bearish', { count: down, total })
  if (up > 0) return t('split: {up} bullish, {down} bearish of {total}', { up, down, total })
  return t('0 / {total}: no trade', { total })
}

/** The horizon a pair is led by: its best, or the hour's. */
export function leadHorizon(prediction: PricePrediction): Horizon | null {
  if (prediction.bestHorizon !== null) return prediction.bestHorizon
  if (prediction.horizons.hour1 !== undefined) return 'hour1'
  return (Object.keys(prediction.horizons)[0] as Horizon | undefined) ?? null
}

/** How far the forecast's last pass may be behind before the pages say so (V8 Stage 12): three closes. In V8's three-day
 * run the forecast stopped at the 15:30 UTC close on 4 November, and Home went on listing that close's ranges as its top
 * predictions, with no time beside them, for the rest of the run. */
export const FORECAST_BEHIND_SEC = 15 * 60

/** A sentence when the forecast's last pass is more than FORECAST_BEHIND_SEC behind `nowSec`; null while it keeps up. */
export function forecastBehindText(state: ForecastState | null, nowSec: number, i18n: I18n = ENGLISH): string | null {
  const at = state?.engine.lastPassAt ?? null
  if (at === null || nowSec - at <= FORECAST_BEHIND_SEC) return null
  return i18n.t('Behind: the last forecast read the {time} close, {ago} ago. No close has been read since, so these ranges are not current.', {
    time: utcWhen(i18n, at * 1000),
    ago: durationOf(i18n, (nowSec - at) / 60)
  })
}

/** Where the forecast stands, in a line (the Predictions page's status line). An error is the
 * engine's own words. */
export function forecastStatusText(state: ForecastState | null, i18n: I18n = ENGLISH): string {
  const { t, num, utcTime } = i18n
  if (state === null) return t('Reading the forecast…')
  const { engine, training, data } = state
  const bars = data.pairs > 0 && data.ready < data.pairs ? t("{ready} of {pairs} pairs' bars are up to date.", { ready: data.ready, pairs: data.pairs }) : ''
  const error = engine.lastError ?? training.lastError
  const tail = error === null ? '' : t('Last error: {error}', { error })
  const join = (...parts: string[]): string => parts.filter((part) => part !== '').join(' ')
  if (engine.status === 'waiting') {
    const progress = training.progress
    const what =
      engine.waitingFor === 'models'
        ? training.status === 'failed'
          ? t('Its first fit failed; it is tried again at the next start or the nightly refit.')
          : progress === null
            ? t('It is fitting its first models.')
            : t('It is fitting its first models ({step}, {done} of {total}).', { step: progress.step, done: progress.done, total: progress.total })
        : engine.waitingFor === 'calibration'
          ? progress === null
            ? t('Its models are fitted; the walk forward its ranges are calibrated on is running.')
            : t('Its models are fitted; the walk forward its ranges are calibrated on is running ({step}, {done} of {total}).', { step: progress.step, done: progress.done, total: progress.total })
          : t('It waits for the bars of the close.')
    return join(t('No forecast yet.'), what, bars, tail)
  }
  const at =
    engine.lastPassAt === null
      ? ''
      : engine.lastPassMs === null
        ? t('The last pass read the {time} UTC close.', { time: utcTime(engine.lastPassAt * 1000) })
        : t('The last pass read the {time} UTC close in {ms} ms.', { time: utcTime(engine.lastPassAt * 1000), ms: num(engine.lastPassMs, 0, 0) })
  const record =
    engine.missing > 0
      ? t('Since the app started: {recorded} forecasts recorded, {outcomes} outcomes written ({missing} with no price to judge by), {refreshes} forecasts made again between closes.', {
          recorded: engine.recorded,
          outcomes: engine.outcomes,
          missing: engine.missing,
          refreshes: engine.refreshes
        })
      : t('Since the app started: {recorded} forecasts recorded, {outcomes} outcomes written, {refreshes} forecasts made again between closes.', { recorded: engine.recorded, outcomes: engine.outcomes, refreshes: engine.refreshes })
  return join(t('Forecasting {count} pairs at every 5-minute close.', { count: engine.predictions }), at, record, bars, tail)
}

/** The horizons the best prediction's card shows, as §3 has them. */
/** Since V7.2-R Stage 3 an hour, four hours and a day: a quarter-hour's moves rarely pay for a round trip. */
export const CARD_HORIZONS: Horizon[] = ['hour1', 'hours4', 'hours24']

/** Whether a horizon's way comes from a source that beat the base rate (V7.2-R Stage 3): only then is an expected
 * price, a change and a time to it shown. A forecast made before its source was recorded says none. */
export function wayKnown(range: Pick<ForecastRange, 'pUpSource'> | undefined): boolean {
  return range !== undefined && range.pUpSource !== undefined && range.pUpSource !== 'base'
}

/** How often the coin's close a horizon on moved at least `pct` either way over its last ninety days, at each of
 * the card's horizons (shared/forecast/moveRates.ts): a frequency of the past; '—' where the coin has none. */
export function moveRatesWord(prediction: Pick<PricePrediction, 'moveRates'>, pct: number, i18n: I18n = ENGLISH): string {
  const { t, pctPlain } = i18n
  const parts = CARD_HORIZONS.flatMap((horizon) => {
    const rate = ratesAt(prediction.moveRates, horizon)?.close.find((entry) => entry.pct === pct)
    return rate === undefined ? [] : [t('{horizon}: {range}', { horizon: t(HORIZON_SHORT[horizon]), range: pctPlain(Math.round(rate.either * 100), 0) })]
  })
  return parts.length === 0 ? '—' : parts.join(' · ')
}

/** How often the coin's path touched 1% either way within four hours over its last ninety days, and the typical
 * minutes to the first touch; '—' where the coin has no rates. */
export function touchRateWord(prediction: Pick<PricePrediction, 'moveRates'>, i18n: I18n = ENGLISH): string {
  const { t, pctPlain, num } = i18n
  const rate = ratesAt(prediction.moveRates, 'hours4')?.touch.find((entry) => entry.pct === 1)
  if (rate === undefined) return '—'
  const share = pctPlain(Math.round(rate.either * 100), 0)
  const span = t(HORIZON_NAME.hours4)
  return rate.medianMinutes === null ? t('{share} within {horizon}', { share, horizon: span }) : t('{share} within {horizon}, typically in {minutes} min', { share, horizon: span, minutes: num(Math.round(rate.medianMinutes), 0, 0) })
}

export interface CardRow {
  /** What the row is, as a key: the same in every language, for React. */
  id: string
  name: string
  value: string
}

const RELIABILITY_NAMES: Record<string, string> = { LOW: msg('LOW'), MEDIUM: msg('MEDIUM'), HIGH: msg('HIGH') }

/** A reliability in a word, in a language. */
export function reliabilityWord(reliability: string | undefined, { t }: I18n = ENGLISH): string {
  if (reliability === undefined) return '—'
  const name = RELIABILITY_NAMES[reliability]
  return name === undefined ? reliability : t(name)
}

/** The market's shock state in words (V7.1 Stage 11; shared/forecast/marketShock.ts), as a phrase inside a
 * sentence. */
const STATE_NAMES: Record<MarketShockState, string> = {
  NORMAL: msg('normal@@market state'),
  PRE_EVENT: msg('before a scheduled release'),
  POST_EVENT_SHOCK: msg("after a sharp move of Bitcoin's"),
  TRENDING_SHOCK: msg("in a trending move of Bitcoin's"),
  LIQUIDATION_SHOCK: msg('in a liquidation cascade'),
  RECOVERY: msg('recovering from a shock')
}

export function marketStateWord(state: MarketShockState | null | undefined, { t }: I18n = ENGLISH): string {
  if (state === null || state === undefined) return '—'
  const name = STATE_NAMES[state]
  return name === undefined ? state : t(name)
}

/** The level the path's highest high stays under eight times in ten, and the lowest low above, as prices
 * from the close the forecast was read at (V7.1 Stage 3); null where the forecast carries none. */
export function likelyLevels(prediction: Pick<PricePrediction, 'currentPrice'>, range: Pick<ForecastRange, 'excursion'>): { high: number; highPct: number; low: number; lowPct: number } | null {
  const excursion = range.excursion
  if (excursion === undefined || excursion.highPct.length < 2 || excursion.lowPct.length < 2) return null
  const highPct = excursion.highPct[1]
  const lowPct = excursion.lowPct[1]
  return { high: prediction.currentPrice * (1 + highPct / 100), highPct, low: prediction.currentPrice * (1 + lowPct / 100), lowPct }
}

/** When the expected price is reached, in a few words (V7.1 Stage 3): the chance within the horizon and
 * the typical minutes, or that it is unlikely. '—' where the forecast carries no arrival. */
export function arrivalWord(range: Pick<ForecastRange, 'arrival'>, horizon: Horizon, i18n: I18n = ENGLISH): string {
  const { t, pctPlain, num } = i18n
  const arrival = range.arrival
  if (arrival === undefined) return '—'
  const window = horizon === 'hours24' ? 'hours4' : horizon
  const share = pctPlain(Math.round(arrival.pWithin[window] * 100), 0)
  const span = t(HORIZON_NAME[window])
  if (arrival.unlikely) return t('unlikely within {horizon} ({share})', { horizon: span, share })
  if (arrival.medianMinutes === null) return t('{share} within {horizon}', { share, horizon: span })
  return t('{share} within {horizon}, typically in {minutes} min', { share, horizon: span, minutes: num(Math.round(arrival.medianMinutes), 0, 0) })
}

/** The best prediction's card, row by row (§3 and §118): the price and the likely ranges, the bull and
 * bear cases, then what the forecast is worth and what moves it. Percentages from the view's price. Since
 * V7.1 Stage 3 the expected price, the likely high and low, and when the expected price is reached. */
export function predictionCardRows(prediction: PricePrediction, view: PredictionView, consensus: string | null, i18n: I18n = ENGLISH): { left: CardRow[]; right: CardRow[] } {
  const { t } = i18n
  const lead = leadHorizon(prediction)
  const leadRange = lead === null ? undefined : prediction.horizons[lead]
  const leadView = lead === null ? undefined : view.horizons[lead]
  const current = dollarText(view.price, i18n)
  const levels = leadRange === undefined ? null : likelyLevels(prediction, leadRange)
  const priceAndMove = (price: number, pct: number): string => t('{price} ({move})', { price: dollarText(price, i18n), move: signedPct(pct, 2, i18n) })
  const left: CardRow[] = [
    { id: 'current', name: t('Current'), value: view.priceFrom === 'close' ? t('{price} (last close)', { price: current }) : current },
    ...CARD_HORIZONS.map((horizon) => {
      const range = view.horizons[horizon]
      const text = range === undefined ? '—' : rangeText(range.lowPct, range.highPct, i18n)
      return { id: horizon, name: t(HORIZON_NEXT[horizon]), value: range !== undefined && range.expired ? t('{range} (expired)', { range: text }) : text }
    }),
    // An expected price only where a source of the way is in use: with none, the median is the price give or take
    // noise, and a change of a tenth of a percent is no forecast of anything (V7.2-R Stage 3).
    {
      id: 'expected',
      name: t('Expected price'),
      value: leadRange === undefined || leadView === undefined ? '—' : wayKnown(leadRange) ? priceAndMove(leadRange.quantilePrices[2], leadView.medianPct) : t('not forecast: no way is known')
    },
    { id: 'bull', name: t('Bull case'), value: leadView === undefined ? '—' : signedPct(leadView.bullPct, 2, i18n) },
    { id: 'bear', name: t('Bear case'), value: leadView === undefined ? '—' : signedPct(leadView.bearPct, 2, i18n) },
    { id: 'high', name: t('Likely high'), value: levels === null ? '—' : priceAndMove(levels.high, levels.highPct) },
    { id: 'low', name: t('Likely low'), value: levels === null ? '—' : priceAndMove(levels.low, levels.lowPct) }
  ]
  const right: CardRow[] = [
    { id: 'quality', name: t('Forecast quality'), value: leadRange === undefined ? '—' : t('{score} / 100', { score: leadRange.quality.score }) },
    { id: 'reliability', name: t('Reliability'), value: reliabilityWord(leadRange?.reliability, i18n) },
    { id: 'best', name: t('Best horizon'), value: lead === null ? '—' : prediction.bestHorizon === null ? t('none beat a plain range') : t(HORIZON_NAME[lead]) },
    ...(wayKnown(leadRange) ? [{ id: 'arrival', name: t('Reached within'), value: leadRange === undefined || lead === null ? '—' : arrivalWord(leadRange, lead, i18n) }] : []),
    { id: 'moved1', name: t('Moved 1% or more, last 90 days'), value: moveRatesWord(prediction, 1, i18n) },
    { id: 'moved2', name: t('Moved 2% or more, last 90 days'), value: moveRatesWord(prediction, 2, i18n) },
    { id: 'touched1', name: t('Touched 1% either way, last 90 days'), value: touchRateWord(prediction, i18n) },
    { id: 'news', name: t('News catalyst'), value: newsWord(prediction, i18n) },
    { id: 'volume', name: t('Volume'), value: volumeWord(prediction.market?.volRatio1h, i18n) },
    { id: 'momentum', name: t('Momentum'), value: momentumWord(prediction.market?.z1h, i18n) },
    { id: 'ai', name: t('AI consensus'), value: consensus ?? t('not asked') }
  ]
  return { left, right }
}
