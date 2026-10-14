import { ENGLISH, msg, type I18n } from '../i18n/translate'
import type { Horizon, PairClass } from './features'
import type { Setup } from './opportunityClass'
import type { MarketRegime } from '../marketResearch'

// THE FORECAST'S WORDS IN ANY LANGUAGE (the V6 document, §88-89; V6 Stage 14, 13 October 2026). A forecast
// is made in the main process as figures and codes; its sentences are built from them by these words, in
// English for the records and a model's prompt, and in the person's language where the window shows them.
// Each is a key (shared/i18n/translate.ts): t(HORIZON_NAME[horizon]) is its text in a language.

/** A horizon in a table's column: 5m, 1h. */
export const HORIZON_SHORT: Record<Horizon, string> = { minutes5: msg('5m'), minutes15: msg('15m'), hour1: msg('1h'), hours4: msg('4h'), hours24: msg('24h') }
/** A horizon as the card heads its row: Next 1 hour. */
export const HORIZON_NEXT: Record<Horizon, string> = {
  minutes5: msg('Next 5 min'),
  minutes15: msg('Next 15 min'),
  hour1: msg('Next 1 hour'),
  hours4: msg('Next 4 hours'),
  hours24: msg('Next 24 hours')
}
/** A horizon by itself: 1 hour. */
export const HORIZON_NAME: Record<Horizon, string> = { minutes5: msg('5 min'), minutes15: msg('15 min'), hour1: msg('1 hour'), hours4: msg('4 hours'), hours24: msg('24 hours') }
/** A horizon before a noun: the 1-hour forecast. */
export const HORIZON_ADJECTIVE: Record<Horizon, string> = {
  minutes5: msg('5-minute'),
  minutes15: msg('15-minute'),
  hour1: msg('1-hour'),
  hours4: msg('4-hour'),
  hours24: msg('24-hour')
}
/** A horizon as a span of time: 15 minutes. */
export const HORIZON_SPAN: Record<Horizon, string> = { minutes5: msg('5 minutes'), minutes15: msg('15 minutes'), hour1: msg('1 hour'), hours4: msg('4 hours'), hours24: msg('24 hours') }

/** A kind of coin, as the forecast classes it. */
export const PAIR_CLASS_NAME: Record<PairClass, string> = {
  btc: msg('Bitcoin'),
  eth: msg('Ether'),
  large: msg('Large coin'),
  mid: msg('Mid-sized coin'),
  'high-vol': msg('High-volatility coin'),
  other: msg('Other coin')
}

/** The setup a trade is made in (shared/forecast/opportunityClass.ts). */
export const SETUP_NAME: Record<Setup, string> = { news: msg('news'), breakout: msg('breakout'), reversal: msg('reversal'), trend: msg('trend'), other: msg('other setup') }

/** The market's regime in a word, as the forecast names it. */
export const REGIME_NAME: Record<MarketRegime, string> = {
  panic: msg('panic@@market regime'),
  'high-vol': msg('high-vol@@market regime'),
  recovery: msg('recovery@@market regime'),
  bull: msg('bull@@market regime'),
  bear: msg('bear@@market regime'),
  sideways: msg('sideways@@market regime')
}

/** A level the forecast fixed, as a price: six significant figures, in the language's own separators. */
/** The forecast's models by name (V6 Stage 14): English, as the Lab, calls each by its id. */
const FORECAST_MODEL_NAME: Readonly<Record<string, string>> = {
  persistence: msg('persistence@@a forecast model'),
  volatility: msg('volatility@@a forecast model'),
  technical: msg('technical@@a forecast model'),
  'random-forest': msg('random-forest@@a forecast model'),
  gbt: msg('gbt@@a forecast model'),
  'quantile-gbt': msg('quantile-gbt@@a forecast model'),
  'gbt-price': msg('gbt-price@@a forecast model')
}

/** A forecast model by name, in a language; one the app does not know, by its id. */
export function forecastModelName(id: string, { t }: I18n = ENGLISH): string {
  const key = FORECAST_MODEL_NAME[id]
  return key === undefined ? id : t(key)
}

export function forecastPrice(value: number, { num }: I18n = ENGLISH): string {
  if (!Number.isFinite(value)) return '—'
  return num(Number(value.toPrecision(6)), 0, 10)
}

/** An opportunity class's key (kind/horizon/setup) in words: "large coin · 1 hour · breakout". */
export function classKeyWords(key: string, { t }: I18n = ENGLISH): string {
  const [pairClass, horizon, setup] = key.split('/') as [PairClass, Horizon, Setup]
  const parts = [PAIR_CLASS_NAME[pairClass], HORIZON_NAME[horizon], SETUP_NAME[setup]]
  if (parts.some((part) => part === undefined)) return key
  return parts.map((part) => t(part)).join(' · ')
}
