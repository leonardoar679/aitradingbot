import type { MarketRegime } from '../marketResearch'
import { CALIBRATION_VERSION, calibrate } from './calibration'
import { DIRECTION_LINES, calibratedPUp, classify, confidenceOf, rawPUp, type Direction } from './direction'
import { ENSEMBLE_VERSION, combine, halfWidth, sigmaOf, widenAround } from './ensemble'
import { FEATURES_VERSION, HORIZONS, HORIZON_BARS, type Horizon, type PairClass } from './features'
import { QUANTILE_LEVELS } from './ml/quantile'
import { MODELS_VERSION, type DirectionModelId, type ForecastModelId } from './models'
import { NEWS_EFFECT_VERSION, newsEffectOf, type AnalystReadingInput, type KindReactions, type NewsEffect, type NewsStoryInput } from './newsEffect'
import { QUALITY_VERSION, qualityOf, type PredictionQuality } from './quality'
import type { RangeDriver } from './rangeDrivers'
import { reliabilityOf, type Reliability, type ReliabilityReason } from './reliability'
import { forecastPrice, HORIZON_ADJECTIVE } from './words'
import { ENGLISH, type I18n } from '../i18n/translate'
import { RUN_CALIBRATION_VERSION, VARIANTS, cellOf, directionSourceOf, type ForecastVariant, type PUpSource, type RunCalibration } from './runCalibration'
import { FIRST_TOUCH, arrivalOf, type TouchWindow } from './firstTouch'
import { EXCURSION_LEVELS } from './models'
import { marketWidening, type MarketShockState } from './marketShock'
import { stretchShock } from './shock'
import { usualMove } from './targets'

// THE PREDICTION (the V6 document, §5-10, §14, §25 and §59-61; V6 Stage 6, 13 October 2026): what may
// happen to one pair, at five horizons, as a range rather than a point. §5's object, field for field,
// and beside each of its fields what it was made from.
//
// - The LIKELY RANGE of a horizon (lowPct to highPct, §8) is its P25 to P75: half the outcomes are
//   meant to fall inside it, and `confidenceLevel` says so (50). The bear and bull cases are P10 and
//   P90. Percentages are from the close the forecast was read at (`currentPrice`); the price levels
//   stay where they are as the live price moves, and are re-expressed from it (V6 Stage 7).
// - P(UP) is the map's reading (shared/forecast/direction.ts) only where the horizon's direction was
//   skilful on weeks the map was not fitted on; elsewhere it is the base rate -- the share that went
//   up over the weeks it was scored on -- since it knows no more than that. On the real record of 13
//   October the map read 32% at 24 hours for most large coins, from weeks whose drift did not carry:
//   shown, it would have been a confidence of 68 in nothing.
// - Each horizon's call, its confidence and its reliability are shared/forecast/direction.ts's and
//   reliability.ts's; the pair's are those of its BEST HORIZON (§9): the horizon whose calibrated
//   forecast beat calibrated persistence's by most, on weeks it was not calibrated on, for the
//   pair's class. With none that did, the pair is NEUTRAL.
// - It EXPIRES (§38) when its horizon's close is reached: the 1-hour forecast from the 15:00 close at
//   16:00.
// - Each model's part (§14) is its weight and its median, in log-return percent -- so that the
//   weighted medians and the calibration's shift add up to the forecast's median exactly.
// - The variants (§49): V1, price only, and V2, every market model, each calibrated on its own record;
//   V3, V2 moved by the news, and V4, by the news as the analyst read it (shared/forecast/newsEffect.ts),
//   each read at its own adaptive levels. V4 is the one shown: V2 itself where no story moves it. Until
//   the news-moved forecasts' own outcomes show their P(up) knew more than an even chance, by the same
//   line as V2's, a story moves the range and not the P(up), and calls no way.
// - A THIN BOOK widens it (§57): the closes it learned from already carry the bounce of a usual spread,
//   so only the half-spread beyond 0.05% -- a spread over a tenth of a percent -- is added, as a
//   variance, to the calibrated range. The models' disagreement widened it before the calibration.
// - BITCOIN'S SHARP MOVE widens it (V6.1, shared/forecast/shock.ts): at a horizon whose rule the walk
//   forward adopted, with Bitcoin's last fifteen minutes at or past 2.5 usual moves, the outer and inner
//   pairs of levels are stretched about the median by the rule's factors. Calm moments are untouched.
//   Since V7.1 Stage 11 (shared/forecast/marketShock.ts) a horizon that chose the states' rules widens by
//   the rule of the market's state at the moment instead, where that state's rule was adopted.
// - WHERE P(UP) COMES FROM (V7.1 Stage 2; shared/forecast/runCalibration.ts, directionSourceOf): the cell's
//   skilled reading with the highest honest skill -- the distribution's, or a promoted direction model's
//   mapped by its own map -- and the base rate where none is skilled; the news's own where its skill has
//   been shown. The call's lines are unchanged: only the reading they are applied to may be a model's.

// - THE PATH (V7.1 Stage 3; shared/forecast/firstTouch.ts): each horizon's likely high and low -- the
//   levels the path's highest high stays under and its lowest low above, half the time, eight times in
//   ten and nine, read by the excursion models and scaled by what the walk forward's paths did -- and
//   when the expected price (the median) is reached: the chance within five minutes, fifteen, an hour and
//   four, and the typical time when it is, from the first-touch table; UNLIKELY under a fixed chance
//   within the horizon, and then no time is said.

/** prediction-v5 (V7.1 Stage 11): the market's shock state at the forecast's moment, and a widening that
 * says which state's rule made it. prediction-v4 (V7.1 Stage 3): each horizon carries its likely high and
 * low and when its expected price is reached. */
export const PREDICTION_VERSION = 'prediction-v5'

export const PREDICTION_LINES = {
  /** The half-spread, in percent, the training closes already carry. */
  usualHalfSpreadPct: 0.05
} as const

const P10 = QUANTILE_LEVELS.indexOf(0.1)
const P25 = QUANTILE_LEVELS.indexOf(0.25)
const P50 = QUANTILE_LEVELS.indexOf(0.5)
const P75 = QUANTILE_LEVELS.indexOf(0.75)
const P90 = QUANTILE_LEVELS.indexOf(0.9)

export interface ForecastRange {
  /** §5: the likely range, P25 to P75, in percent from the close, and its prices. */
  lowPct: number
  highPct: number
  lowerPrice: number
  upperPrice: number
  medianPct?: number
  /** The share of outcomes the likely range is meant to hold, in percent. */
  confidenceLevel: number
  /** P10, P25, P50, P75 and P90 of the move in percent, and their prices. */
  quantilesPct: number[]
  quantilePrices: number[]
  /** The bear and bull cases: P10 and P90, in percent. */
  bearPct: number
  bullPct: number
  /** The calibrated chance the close a horizon on is above this one: the map's reading where the
   * direction was skilful, the base rate where it was not; and the map's reading, for the Lab. */
  pUp: number
  pUpMapped: number
  /** Where P(up) came from (V7.1 Stage 2); absent on a forecast made before. */
  pUpSource?: PUpSource
  direction: Direction
  strong: boolean
  uncertain: boolean
  /** The calibrated chance of the way it calls, in percent. */
  confidence: number
  reliability: Reliability
  reliabilityReasons: string[]
  /** The same as codes, for the window to word in the person's language (V6 Stage 14); absent on a
   * forecast made before. */
  reliabilityCodes?: ReliabilityReason[]
  /** How good it is, 0 to 100, and from what (shared/forecast/quality.ts). */
  quality: PredictionQuality
  /** The width of P10-P90, and the pair class's usual width at the horizon, in percent. */
  width80Pct: number
  usualWidth80Pct: number
  /** How much its calibrated forecast beat calibrated persistence's on weeks it was not calibrated on,
   * and how much its P(up) beat the base rate on weeks its map was not fitted on. */
  skill: number | null
  directionSkill: number | null
  /** Whether the class had outcomes enough for weights and a calibration of its own. */
  ownClass: boolean
  /** Unix milliseconds: when the horizon's close is reached. */
  expiresAt: number
  /** Each weighing model's weight and median in log-return percent; with `calibrationShiftLogPct`
   * they add up to the median in log-return percent. */
  contributions: { model: ForecastModelId; weight: number; medianLogPct: number }[]
  calibrationShiftLogPct: number
  /** What the news moved the median by, in log-return percent (V4's story; 0 where none). */
  newsShiftLogPct: number
  /** The story that moved V3 and the one that moved V4, where one did (§58). */
  news: { v3: NewsEffect | null; v4: NewsEffect | null }
  /** How much a thin book widened the range: 1 where it did not. */
  spreadStretch: number
  /** Where Bitcoin's sharp move widened it (V6.1): Bitcoin's last fifteen minutes in its usual moves, the
   * outer and inner factors, and the share of the walk forward's moments past the line whose 80% range held,
   * as forecast and widened (cross-fitted); null where it did not, absent on a forecast made before. Since
   * V7.1 Stage 11, with the market state whose rule widened it where a state's did (null where the line's). */
  shock?: { btc15: number; k80: number; k50: number; held: { before: number; after: number } | null; state?: MarketShockState | null } | null
  /** The path's likely high and low (V7.1 Stage 3): at each of EXCURSION_LEVELS, the move from the close
   * the highest high stays under and the lowest low stays above that often, in percent, scaled by the
   * walk forward's calibration; and how often the tested paths stayed inside the scaled levels, on weeks
   * the factors were not fitted on. Absent where the run holds no excursion calibration. */
  excursion?: { highPct: number[]; lowPct: number[]; held: { high: number[]; low: number[] } | null }
  /** When the expected price -- the median -- is reached (V7.1 Stage 3): its distance in usual hourly
   * moves, the chance it is first touched within each window, the typical minutes when it is, and
   * whether it is UNLIKELY within the horizon (under FIRST_TOUCH.unlikely). Absent where the run holds no
   * first-touch table. */
  arrival?: { targetPct: number; k: number; pWithin: Record<TouchWindow, number>; medianMinutes: number | null; unlikely: boolean }
  /** The three figures that moved its size reading most (§36; shared/forecast/rangeDrivers.ts). */
  rangeDrivers: RangeDriver[]
  variants: Partial<Record<ForecastVariant, { medianPct: number; lowPct: number; highPct: number; quantilesPct: number[]; pUp: number; pUpMapped: number }>>
}

export interface PricePrediction {
  pair: string
  /** Unix milliseconds. */
  generatedAt: number
  direction: Direction
  horizons: Partial<Record<Horizon, ForecastRange>>
  /** The close the forecast was read at. */
  currentPrice: number
  /** The story that moved the lead horizon's forecast, and its impact (§5). */
  mainCatalyst?: string
  newsImpact?: number
  /** The best horizon's confidence, in percent. */
  confidence: number
  reliability: Reliability
  invalidationConditions: string[]
  modelVersion: string
  /** Beyond §5. */
  id: string
  strong: boolean
  uncertain: boolean
  bestHorizon: Horizon | null
  pairClass: PairClass
  regime: MarketRegime
  /** Unix seconds: the close the forecast was read at. */
  barTime: number
  /** The coin's last hour in units of its usual move, its volume against its usual hour, and the share
   * of coins that rose in the hour, at that close; null where not read. */
  market: { z1h: number; breadth1h: number; volRatio1h: number | null; atr5mPct?: number | null } | null
  /** The market's shock state at the forecast's moment (V7.1 Stage 11); null where it could not be read,
   * absent on a forecast made before. */
  marketState?: MarketShockState | null
  versions: { prediction: string; models: string; features: string; ensemble: string; calibration: string; runCalibration: string; news: string; quality: string; run: string; foldsRun: string }
}

/** What the news gives a pair's forecast: the stories naming its coin as the app holds them, the
 * reaction library, the analyst's readings on file, and how far its news-moved forecasts' P(up)
 * has beaten an even chance on their own outcomes, by horizon (null below their least). */
export interface PredictionNews {
  ticker: string
  stories: readonly NewsStoryInput[]
  library: readonly KindReactions[]
  readings?: Readonly<Record<string, AnalystReadingInput>>
  skill?: Partial<Record<Horizon, number | null>>
}

export interface PredictionInput {
  pair: string
  pairClass: PairClass
  regime: MarketRegime
  /** Unix seconds: the close the row was read at, and its price. */
  barTime: number
  price: number
  /** Unix milliseconds. */
  generatedAt: number
  /** The row's day volatility and its hour against its day. */
  rv24h: number
  rvRatio: number
  /** The live book's spread in percent of the price, where it is known. */
  spreadPct?: number | null
  /** Each horizon's models' quantiles of the move in units of the usual move (predictHorizon). */
  models: Partial<Record<Horizon, Record<ForecastModelId, number[]>>>
  calibration: RunCalibration
  /** The levels the adaptive step reads a variant's cell at, where the engine keeps them (V6 Stage
   * 7): the cell is the pair's class where it has one of its own (`ownClass`), the horizon's otherwise. */
  levels?: (horizon: Horizon, variant: ForecastVariant, cell: PairClass | 'pooled') => readonly number[] | undefined
  news?: PredictionNews
  /** The coin's last hour in units of its usual move and the share of pairs that rose in it, from its
   * row, for the quality's market confirmation (V6 Stage 9). */
  market?: { z1h: number; breadth1h: number; volRatio1h?: number; atr5mPct?: number | null }
  /** Each horizon's range drivers, where the engine read them from the size model. */
  drivers?: Partial<Record<Horizon, RangeDriver[]>>
  /** Bitcoin's last fifteen minutes in its usual moves: the close's, or the stream's where fresher (V6.1). */
  btc15?: number | null
  /** The market's shock state at the moment (V7.1 Stage 11): the close's, or the stream's where fresher. */
  marketState?: MarketShockState | null
  /** Each horizon's direction models' raw chances of up at the close (V7.1 Stage 2, predictDirection). */
  direction?: Partial<Record<Horizon, Partial<Record<DirectionModelId, number>>>>
  /** Each horizon's excursion levels at the close, in usual moves (V7.1 Stage 3, predictExcursion). */
  excursion?: Partial<Record<Horizon, { high: readonly number[]; low: readonly number[] }>>
  runId: string
  foldsRunId: string
}

/** The windows the first-touch table answers for, by horizon: a day's forecast is read at four hours. */
const TOUCH_WINDOW_OF: Record<Horizon, TouchWindow> = { minutes5: 'minutes5', minutes15: 'minutes15', hour1: 'hour1', hours4: 'hours4', hours24: 'hours4' }

const pctOf = (logReturn: number): number => (Math.exp(logReturn) - 1) * 100

/** What would undo a forecast (§5), led by its horizon: its own bad case, and the market turning on it.
 * In English on the forecast; the window words it again in the person's language (V6 Stage 14). */
export function invalidationConditionsOf(direction: Direction, horizon: Horizon, lead: Pick<ForecastRange, 'quantilePrices'>, i18n: I18n = ENGLISH): string[] {
  const { t } = i18n
  const words = t(HORIZON_ADJECTIVE[horizon])
  const price = (value: number): string => forecastPrice(value, i18n)
  if (direction === 'BULLISH') {
    return [
      t('The price falls below {price}, the {horizon} bear case.', { price: price(lead.quantilePrices[P10]), horizon: words }),
      t('Bitcoin falls 1% within fifteen minutes.'),
      t('The market turns to panic.'),
      t('A story of impact 70 or more goes against the coin.')
    ]
  }
  if (direction === 'BEARISH') {
    return [
      t('The price rises above {price}, the {horizon} bull case.', { price: price(lead.quantilePrices[P90]), horizon: words }),
      t('Bitcoin rises 1% within fifteen minutes.'),
      t('The market turns to a rally.'),
      t('A story of impact 70 or more goes for the coin.')
    ]
  }
  return [t('The price leaves {low} – {high}, the {horizon} 80% range.', { low: price(lead.quantilePrices[P10]), high: price(lead.quantilePrices[P90]), horizon: words })]
}

/** One horizon's range from its models' quantiles and the run's calibration. */
function rangeOf(input: PredictionInput, horizon: Horizon): ForecastRange | null {
  const models = input.models[horizon]
  const calibration = input.calibration.horizons[horizon]
  if (models === undefined || calibration === undefined) return null
  const usual = usualMove(input.rv24h, HORIZON_BARS[horizon])
  if (!(usual > 0) || !(input.price > 0)) return null
  const variants: ForecastRange['variants'] = {}
  let v2: { quantiles: number[]; pUp: number; pUpMapped: number; combined: ReturnType<typeof combine>; read: ReturnType<typeof cellOf> } | null = null
  for (const variant of VARIANTS) {
    const read = cellOf(calibration.variants[variant], input.pairClass)
    const combined = combine(models, read.weights)
    const quantiles = calibrate(combined.quantiles, read.cell, input.levels?.(horizon, variant, read.ownClass ? input.pairClass : 'pooled') ?? QUANTILE_LEVELS)
    if (!quantiles.every(Number.isFinite)) return null
    const pUpMapped = calibratedPUp(calibration.variants[variant].pUp, rawPUp(quantiles))
    const skilful = read.honest !== null && read.honest.directionSkill >= DIRECTION_LINES.minDirectionSkill
    const base = read.honest !== null && Number.isFinite(read.honest.upShare) ? read.honest.upShare : 0.5
    const pUp = skilful ? pUpMapped : base
    variants[variant] = { medianPct: pctOf(quantiles[P50] * usual), lowPct: pctOf(quantiles[P25] * usual), highPct: pctOf(quantiles[P75] * usual), quantilesPct: quantiles.map((q) => pctOf(q * usual)), pUp, pUpMapped }
    if (variant === 'v2') v2 = { quantiles, pUp, pUpMapped, combined, read }
  }
  if (v2 === null) return null
  // Where P(up) comes from (V7.1 Stage 2): a promoted direction model's reading, mapped by its own map,
  // where its honest skill is the highest skilled one; else the distribution's as read above.
  const chosen = directionSourceOf(calibration, input.pairClass)
  const rawDirection = chosen.map === null ? undefined : input.direction?.[horizon]?.[chosen.source as DirectionModelId]
  const base: { pUp: number; pUpMapped: number; directionSkill: number | null; source: PUpSource } =
    chosen.map !== null && rawDirection !== undefined
      ? { pUp: calibratedPUp(chosen.map, rawDirection), pUpMapped: calibratedPUp(chosen.map, rawDirection), directionSkill: chosen.skill, source: chosen.source }
      : { pUp: v2.pUp, pUpMapped: v2.pUpMapped, directionSkill: v2.read.honest?.directionSkill ?? null, source: chosen.source === 'distribution' ? 'distribution' : 'base' }
  // The news (V3) and the AI (V4): V2's combination read at the variant's own levels, its median moved
  // and its range widened by the story that moves it most.
  const cell = v2.read.ownClass ? input.pairClass : 'pooled'
  const news: ForecastRange['news'] = { v3: null, v4: null }
  let shown = { quantiles: v2.quantiles, pUp: base.pUp, pUpMapped: base.pUpMapped, directionSkill: base.directionSkill, source: base.source }
  for (const variant of ['v3', 'v4'] as const) {
    const effect = input.news === undefined ? null : newsEffectOf({ variant, ...input.news, horizon, nowSec: Math.floor(input.generatedAt / 1000) })
    news[variant] = effect
    if (effect === null) {
      variants[variant] = variants.v2
      continue
    }
    const levelled = calibrate(v2.combined.quantiles, v2.read.cell, input.levels?.(horizon, variant, cell) ?? QUANTILE_LEVELS)
    const shiftZ = Math.log(1 + effect.shiftPct / 100) / usual
    const shifted = levelled.map((q) => q + shiftZ)
    const quantiles = widenAround(shifted, effect.widenPct > 0 ? effect.widenPct / 100 / usual : effect.widenShare * sigmaOf(shifted))
    const pUpMapped = calibratedPUp(calibration.variants.v2.pUp, rawPUp(quantiles))
    const live = input.news?.skill?.[horizon] ?? null
    const skilful = live !== null && live >= DIRECTION_LINES.minDirectionSkill
    const pUp = skilful ? pUpMapped : base.pUp
    variants[variant] = { medianPct: pctOf(quantiles[P50] * usual), lowPct: pctOf(quantiles[P25] * usual), highPct: pctOf(quantiles[P75] * usual), quantilesPct: quantiles.map((q) => pctOf(q * usual)), pUp, pUpMapped }
    if (variant === 'v4') shown = { quantiles, pUp, pUpMapped, directionSkill: skilful ? live : base.directionSkill, source: skilful ? 'news' : base.source }
  }
  const excessLog = Math.max(0, (input.spreadPct ?? 0) / 2 - PREDICTION_LINES.usualHalfSpreadPct) / 100
  const widened = widenAround(shown.quantiles, excessLog / usual)
  const spreadStretch = halfWidth(widened) / halfWidth(shown.quantiles)
  // Bitcoin's sharp move (V6.1), or the market's state (V7.1 Stage 11): an adopted rule, stretched about its median.
  const shock = marketWidening(calibration, input.btc15, input.marketState)
  const final = shock === null ? widened : stretchShock(widened, shock.k80, shock.k50)
  const logs = final.map((q) => q * usual)
  const quantilesPct = logs.map(pctOf)
  const quantilePrices = logs.map((value) => input.price * Math.exp(value))
  const width80Pct = quantilesPct[P90] - quantilesPct[P10]
  const shownNews = news.v4
  const quality = qualityOf({
    pUp: shown.pUp,
    directionSkill: shown.directionSkill,
    width80Pct,
    usualWidth80Pct: v2.read.usualWidth80Pct,
    coverage80: v2.read.honest?.coverage80 ?? Number.NaN,
    disagreement: v2.combined.disagreement / halfWidth(v2.combined.quantiles),
    news: shownNews === null ? null : { impact: shownNews.impact, novelty: shownNews.novelty, fromLibrary: shownNews.fromLibrary, shiftPct: shownNews.shiftPct },
    market: input.market ?? null,
    ageSec: Math.max(0, input.generatedAt / 1000 - input.barTime)
  })
  const call = classify({
    pUp: shown.pUp,
    medianPct: quantilesPct[P50],
    p10Pct: quantilesPct[P10],
    p90Pct: quantilesPct[P90],
    width80Pct,
    usualWidth80Pct: v2.read.usualWidth80Pct,
    quality: quality.score,
    directionSkill: shown.directionSkill
  })
  const trust = reliabilityOf({
    cellRows: v2.read.honest?.n ?? 0,
    coverage80: v2.read.honest?.coverage80 ?? Number.NaN,
    disagreement: v2.combined.disagreement / halfWidth(v2.combined.quantiles),
    regime: input.regime,
    rvRatio: input.rvRatio
  })
  const contributions = v2.combined.members.map((member) => ({ model: member.model, weight: member.weight, medianLogPct: member.median * usual * 100 }))
  const combinedMedianLogPct = contributions.reduce((sum, member) => sum + member.weight * member.medianLogPct, 0)
  // The path (V7.1 Stage 3): the likely high and low from the excursion models' levels, scaled by the
  // walk forward's factors; and when the median is reached, from the first-touch table at its distance.
  const read = input.excursion?.[horizon]
  const scale = calibration.excursion
  const excursion: ForecastRange['excursion'] =
    read === undefined || scale === undefined || read.high.length !== EXCURSION_LEVELS.length || read.low.length !== EXCURSION_LEVELS.length
      ? undefined
      : {
          highPct: read.high.map((level, at) => pctOf(Math.max(0, level * scale.high[at]) * usual)),
          lowPct: read.low.map((level, at) => pctOf(Math.min(0, level * scale.low[at]) * usual)),
          held: scale.honest.n > 0 ? { high: scale.honest.high, low: scale.honest.low } : null
        }
  const table = input.calibration.touch
  const hourly = usualMove(input.rv24h, 12)
  const arrival: ForecastRange['arrival'] =
    table === undefined || !(hourly > 0) || !Number.isFinite(logs[P50])
      ? undefined
      : ((): ForecastRange['arrival'] => {
          const k = Math.abs(logs[P50]) / hourly
          const reached = arrivalOf(table, k, logs[P50] >= 0 ? 'up' : 'down', input.regime)
          const window = TOUCH_WINDOW_OF[horizon]
          const within = reached.pWithin[window]
          return {
            targetPct: quantilesPct[P50],
            k,
            pWithin: reached.pWithin,
            medianMinutes: reached.medianBars === null ? null : reached.medianBars * 5,
            unlikely: !(within >= FIRST_TOUCH.unlikely)
          }
        })()
  return {
    ...(excursion === undefined ? {} : { excursion }),
    ...(arrival === undefined ? {} : { arrival }),
    lowPct: quantilesPct[P25],
    highPct: quantilesPct[P75],
    lowerPrice: quantilePrices[P25],
    upperPrice: quantilePrices[P75],
    medianPct: quantilesPct[P50],
    confidenceLevel: 50,
    quantilesPct,
    quantilePrices,
    bearPct: quantilesPct[P10],
    bullPct: quantilesPct[P90],
    pUp: shown.pUp,
    pUpMapped: shown.pUpMapped,
    pUpSource: shown.source,
    direction: call.direction,
    strong: call.strong,
    uncertain: call.uncertain,
    confidence: confidenceOf(shown.pUp, call.direction),
    reliability: trust.reliability,
    reliabilityReasons: trust.reasons,
    reliabilityCodes: trust.codes,
    quality,
    width80Pct,
    usualWidth80Pct: v2.read.usualWidth80Pct,
    skill: v2.read.honest?.skill ?? null,
    directionSkill: shown.directionSkill,
    ownClass: v2.read.ownClass,
    expiresAt: (input.barTime + HORIZON_BARS[horizon] * 300) * 1000,
    contributions,
    calibrationShiftLogPct: v2.quantiles[P50] * usual * 100 - combinedMedianLogPct,
    newsShiftLogPct: (logs[P50] - v2.quantiles[P50] * usual) * 100,
    news,
    spreadStretch,
    shock: shock === null ? null : { btc15: input.btc15 ?? Number.NaN, k80: shock.k80, k50: shock.k50, held: shock.held, state: shock.state },
    rangeDrivers: input.drivers?.[horizon] ?? [],
    variants
  }
}

/** The horizon whose forecast beat persistence's by most for the pair's class; null where none did. */
export function bestHorizonOf(horizons: Partial<Record<Horizon, ForecastRange>>): Horizon | null {
  let best: Horizon | null = null
  for (const horizon of HORIZONS) {
    const skill = horizons[horizon]?.skill
    if (skill === null || skill === undefined || !(skill > 0)) continue
    if (best === null || skill > (horizons[best]!.skill as number)) best = horizon
  }
  return best
}

/** The prediction for one pair from its models' quantiles at every horizon; null where none could be
 * made. */
export function makePrediction(input: PredictionInput): PricePrediction | null {
  const horizons: Partial<Record<Horizon, ForecastRange>> = {}
  for (const horizon of HORIZONS) {
    const range = rangeOf(input, horizon)
    if (range !== null) horizons[horizon] = range
  }
  const made = HORIZONS.filter((horizon) => horizons[horizon] !== undefined)
  if (made.length === 0) return null
  const bestHorizon = bestHorizonOf(horizons)
  const leadHorizon = bestHorizon ?? (horizons.hour1 !== undefined ? 'hour1' : made[0])
  const lead = horizons[leadHorizon]!
  const direction: Direction = bestHorizon === null ? 'NEUTRAL' : lead.direction
  // What would undo it (§5): its own bad case, and the market turning on it.
  const invalidationConditions = invalidationConditionsOf(direction, leadHorizon, lead)
  const catalyst = lead.news.v4
  return {
    pair: input.pair,
    generatedAt: input.generatedAt,
    direction,
    horizons,
    currentPrice: input.price,
    ...(catalyst === null ? {} : { mainCatalyst: catalyst.title, newsImpact: catalyst.impact }),
    confidence: confidenceOf(lead.pUp, direction),
    reliability: lead.reliability,
    invalidationConditions,
    modelVersion: `${MODELS_VERSION}/${FEATURES_VERSION}/${ENSEMBLE_VERSION}/${CALIBRATION_VERSION} ${input.runId}`,
    id: `${input.pair}:${input.barTime}:${input.generatedAt}`,
    strong: bestHorizon !== null && lead.strong,
    uncertain: lead.uncertain,
    bestHorizon,
    pairClass: input.pairClass,
    regime: input.regime,
    barTime: input.barTime,
    market: input.market === undefined ? null : { z1h: input.market.z1h, breadth1h: input.market.breadth1h, volRatio1h: input.market.volRatio1h ?? null, atr5mPct: input.market.atr5mPct ?? null },
    marketState: input.marketState ?? null,
    versions: {
      prediction: PREDICTION_VERSION,
      models: MODELS_VERSION,
      features: FEATURES_VERSION,
      ensemble: ENSEMBLE_VERSION,
      calibration: CALIBRATION_VERSION,
      runCalibration: RUN_CALIBRATION_VERSION,
      news: NEWS_EFFECT_VERSION,
      quality: QUALITY_VERSION,
      run: input.runId,
      foldsRun: input.foldsRunId
    }
  }
}
