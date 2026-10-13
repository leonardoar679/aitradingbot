import type { Direction } from '../../shared/forecast/direction'
import type { Horizon } from '../../shared/forecast/features'
import type { ForecastRange, PricePrediction } from '../../shared/forecast/prediction'
import type { TradeDecision } from '../../shared/forecast/tradeDecision'
import type { PredictionView } from '../../shared/forecast/view'
import type { ForecastState } from '../../shared/ipc'

// HOW THE FORECAST READS ON SCREEN (the V6 document, §3, §34-37, §70 and §118; V6 Stage 10, 13 October
// 2026): the same words on Home, the Predictions page and the drawer, so that a call, a range or a
// reason reads one way wherever it is shown. Words only; nothing here reads or asks anything.

export const HORIZON_SHORT: Record<Horizon, string> = { minutes5: '5m', minutes15: '15m', hour1: '1h', hours4: '4h', hours24: '24h' }
export const HORIZON_NEXT: Record<Horizon, string> = { minutes5: 'Next 5 min', minutes15: 'Next 15 min', hour1: 'Next 1 hour', hours4: 'Next 4 hours', hours24: 'Next 24 hours' }

/** A call as it is shown: STRONG where it is, NEUTRAL / UNCERTAIN where the range is too wide (§61). */
export function callLabel(range: Pick<ForecastRange, 'direction' | 'strong' | 'uncertain'>): string {
  if (range.uncertain) return 'NEUTRAL / UNCERTAIN'
  return range.strong ? `STRONG ${range.direction}` : range.direction
}

export function callColor(direction: Direction): string {
  return direction === 'BULLISH' ? 'var(--up)' : direction === 'BEARISH' ? 'var(--down)' : 'var(--text-secondary)'
}

/** A move in percent with its sign: +0.80%, -1.20%. */
export function signedPct(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—'
  const fixed = value.toFixed(digits)
  return `${value > 0 || (value === 0 && !fixed.startsWith('-')) ? '+' : ''}${fixed}%`
}

/** A likely range: +0.80% ~ +2.10%. */
export function rangeText(lowPct: number, highPct: number): string {
  return `${signedPct(lowPct)} ~ ${signedPct(highPct)}`
}

/** A price as the app writes one: six significant figures. */
export function priceText(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return Number(value.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 10 })
}

/** A pair as it reads: SOL / USDT. */
export function pairText(pair: string): string {
  return pair.endsWith('USDT') ? `${pair.slice(0, -4)} / USDT` : pair
}

/** How long a forecast has left before its horizon's close (§38): FORECAST EXPIRED once it has none. */
export function timeLeftText(ms: number): string {
  if (!(ms > 0)) return 'FORECAST EXPIRED'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `valid ${minutes} min`
  const hours = ms / 3_600_000
  return `valid ${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`
}

/** The coin's last hour in its usual moves, in a word (§3's "Momentum"). */
export function momentumWord(z1h: number | null | undefined): string {
  if (z1h === null || z1h === undefined || !Number.isFinite(z1h)) return '—'
  if (z1h >= 2) return 'STRONG UP'
  if (z1h >= 1) return 'UP'
  if (z1h <= -2) return 'STRONG DOWN'
  if (z1h <= -1) return 'DOWN'
  return 'FLAT'
}

/** Its volume against its usual hour (§3's "Volume: 3.7×"). */
export function volumeWord(ratio: number | null | undefined): string {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return '—'
  return `${ratio.toFixed(1)}× its usual hour`
}

/** The story moving the forecast, in a line (§3's "News catalyst"). */
export function newsWord(prediction: Pick<PricePrediction, 'mainCatalyst' | 'newsImpact'>): string {
  if (prediction.mainCatalyst === undefined) return 'none'
  const impact = prediction.newsImpact ?? 0
  return `${impact >= 70 ? 'HIGH' : impact >= 40 ? 'MODERATE' : 'LOW'} IMPACT · ${prediction.mainCatalyst}`
}

/** What the decision says, as a label and the reasons behind a NO TRADE. */
export function decisionWords(decision: TradeDecision | null | undefined): { label: string; detail: string; trade: boolean } {
  if (decision === null || decision === undefined) return { label: 'NO DECISION YET', detail: '', trade: false }
  if (decision.decision === 'TRADE') return { label: `TRADE: ${decision.side}`, detail: decision.side === 'SELL' ? 'A sell is a paper trade only.' : '', trade: true }
  return { label: 'NO TRADE', detail: decision.reasons.map((reason) => reason.text).join(' '), trade: false }
}

/** The models asked about the coin's event, in a line (§118's "AI consensus: 3 / 3"). */
export function aiConsensusWord(sides: readonly ('long' | 'short' | null)[]): string | null {
  if (sides.length === 0) return null
  const up = sides.filter((side) => side === 'long').length
  const down = sides.filter((side) => side === 'short').length
  if (up > down) return `${up} / ${sides.length} bullish`
  if (down > up) return `${down} / ${sides.length} bearish`
  if (up > 0) return `split: ${up} bullish, ${down} bearish of ${sides.length}`
  return `0 / ${sides.length}: no trade`
}

/** The horizon a pair is led by: its best, or the hour's. */
export function leadHorizon(prediction: PricePrediction): Horizon | null {
  if (prediction.bestHorizon !== null) return prediction.bestHorizon
  if (prediction.horizons.hour1 !== undefined) return 'hour1'
  return (Object.keys(prediction.horizons)[0] as Horizon | undefined) ?? null
}

/** Where the forecast stands, in a line (the Predictions page's status line). */
export function forecastStatusText(state: ForecastState | null): string {
  if (state === null) return 'Reading the forecast…'
  const { engine, training, data } = state
  const bars = data.pairs > 0 && data.ready < data.pairs ? ` ${data.ready} of ${data.pairs} pairs' bars are up to date.` : ''
  const error = engine.lastError ?? training.lastError
  const tail = error === null ? '' : ` Last error: ${error}`
  if (engine.status === 'waiting') {
    const step = training.progress === null ? '' : ` (${training.progress.step}, ${training.progress.done} of ${training.progress.total})`
    const what =
      engine.waitingFor === 'models'
        ? training.status === 'failed'
          ? 'Its first fit failed; it is tried again at the next start or the nightly refit.'
          : `It is fitting its first models${step}.`
        : engine.waitingFor === 'calibration'
          ? `Its models are fitted; the walk forward its ranges are calibrated on is running${step}.`
          : 'It waits for the bars of the close.'
    return `No forecast yet. ${what}${bars}${tail}`
  }
  const at = engine.lastPassAt === null ? '' : ` The last pass read the ${new Date(engine.lastPassAt * 1000).toISOString().slice(11, 16)} UTC close${engine.lastPassMs === null ? '' : ` in ${engine.lastPassMs} ms`}.`
  const record = ` Since the app started: ${engine.recorded} forecasts recorded, ${engine.outcomes} outcomes written${engine.missing > 0 ? ` (${engine.missing} with no price to judge by)` : ''}, ${engine.refreshes} forecasts made again between closes.`
  return `Forecasting ${engine.predictions} pairs at every 5-minute close.${at}${record}${bars}${tail}`
}

/** The horizons the best prediction's card shows, as §3 has them. */
export const CARD_HORIZONS: Horizon[] = ['minutes15', 'hour1', 'hours4']

export interface CardRow {
  name: string
  value: string
}

/** The best prediction's card, row by row (§3 and §118): the price and the likely ranges, the bull and
 * bear cases, then what the forecast is worth and what moves it. Percentages from the view's price. */
export function predictionCardRows(prediction: PricePrediction, view: PredictionView, consensus: string | null): { left: CardRow[]; right: CardRow[] } {
  const lead = leadHorizon(prediction)
  const leadRange = lead === null ? undefined : prediction.horizons[lead]
  const leadView = lead === null ? undefined : view.horizons[lead]
  const left: CardRow[] = [
    { name: 'Current', value: `$${priceText(view.price)}${view.priceFrom === 'close' ? ' (last close)' : ''}` },
    ...CARD_HORIZONS.map((horizon) => {
      const range = view.horizons[horizon]
      return { name: HORIZON_NEXT[horizon], value: range === undefined ? '—' : `${rangeText(range.lowPct, range.highPct)}${range.expired ? ' (expired)' : ''}` }
    }),
    { name: 'Bull case', value: leadView === undefined ? '—' : signedPct(leadView.bullPct) },
    { name: 'Bear case', value: leadView === undefined ? '—' : signedPct(leadView.bearPct) }
  ]
  const right: CardRow[] = [
    { name: 'Forecast quality', value: leadRange === undefined ? '—' : `${leadRange.quality.score} / 100` },
    { name: 'Reliability', value: leadRange?.reliability ?? '—' },
    { name: 'Best horizon', value: lead === null ? '—' : prediction.bestHorizon === null ? 'none beat a plain range' : HORIZON_NEXT[lead].replace('Next ', '') },
    { name: 'News catalyst', value: newsWord(prediction) },
    { name: 'Volume', value: volumeWord(prediction.market?.volRatio1h) },
    { name: 'Momentum', value: momentumWord(prediction.market?.z1h) },
    { name: 'AI consensus', value: consensus ?? 'not asked' }
  ]
  return { left, right }
}
