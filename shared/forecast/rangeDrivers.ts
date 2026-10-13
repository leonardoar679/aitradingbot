import type { MemberWeight } from './ensemble'
import { FEATURE_NAMES } from './features'
import { gbtContributions, type GbtModel } from './ml/gbt'
import type { FittedHorizon, ForecastModelId } from './models'

// WHY THIS RANGE (the V6 document, §36; V6 Stage 10, 13 October 2026): "the model expects higher
// volatility because...". The boosted size model (shared/forecast/models.ts, gbt's size) learned how
// big a move is from the row's figures; for one row, each tree's path says how much each figure moved
// its reading from the tree's start (path attributions), and summed over the trees they add up, with
// the base, to the size it read. The three figures that moved it most are its drivers, each said in
// words with its value, and whether it widened the range or narrowed it. Of the two boosted size
// models -- on every figure, and on the price's alone -- the one explained is the one weighing more in
// the pair's forecast at the horizon; where neither weighs, there are none to give.

export interface RangeDriver {
  /** The size model it explains: gbt, or gbt-price. */
  model: ForecastModelId
  feature: string
  /** How far it moved the size, in log units: above zero it widened the range. */
  effect: number
  value: number
  text: string
}

// The figures' own units (shared/forecast/features.ts): moves are log moves and volatilities their
// root sums of squares, both as fractions; the true ranges are already in percent; moves against the
// usual are in usual moves (the day's volatility scaled to the window); positions are shares of a
// range; the taker's share is read less a half, and the fifteen minutes' volume against the fifteen
// before as a log.
const share = (value: number): string => `${Number(value.toFixed(2))}×`
const pct = (value: number): string => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(2)}%`
const size = (value: number): string => `${(value * 100).toFixed(2)}%`
const whole = (value: number): string => `${(value * 100).toFixed(0)}%`
const count = (value: number): string => `${Number(Math.abs(value).toFixed(1))}`
const units = (value: number): string => `${value >= 0 ? 'up' : 'down'} ${count(value)} times its usual move`
const fromAverage = (value: number, average: string): string => `it is ${count(value)} usual days' moves ${value >= 0 ? 'above' : 'below'} its ${average}`

const REGIME_WORDS: Record<string, string> = { panic: 'in panic', 'high-vol': 'highly volatile', recovery: 'recovering', bull: 'in a bull run', bear: 'in a bear run', sideways: 'moving sideways' }
const CLASS_WORDS: Record<string, string> = { btc: 'Bitcoin', eth: 'ether', large: 'a large coin', mid: 'a mid-sized coin', 'high-vol': 'a high-volatility coin', other: 'a coin of no other kind' }

const WORDS: Record<string, (v: number) => string> = {
  r_5m: (v) => `the last five minutes moved ${pct(v)}`,
  r_15m: (v) => `the last fifteen minutes moved ${pct(v)}`,
  r_30m: (v) => `the last half hour moved ${pct(v)}`,
  r_1h: (v) => `the last hour moved ${pct(v)}`,
  r_4h: (v) => `the last four hours moved ${pct(v)}`,
  r_24h: (v) => `the last day moved ${pct(v)}`,
  r_7d: (v) => `the last week moved ${pct(v)}`,
  rv_1h: (v) => `its last hour's volatility was ${size(v)}`,
  rv_4h: (v) => `its last four hours' volatility was ${size(v)}`,
  rv_24h: (v) => `its day's volatility was ${size(v)}`,
  rv_ratio: (v) => `its last hour moved at ${share(v)} the day's pace`,
  z_15m: (v) => `its last fifteen minutes went ${units(v)}`,
  z_1h: (v) => `its last hour went ${units(v)}`,
  z_4h: (v) => `its last four hours went ${units(v)}`,
  z_24h: (v) => `its last day went ${units(v)}`,
  acc_15m: (v) => `its last fifteen minutes ran ${count(v)} usual moves ${v >= 0 ? 'above' : 'below'} the fifteen before`,
  slope_1h: (v) => `its trend over the last hour was ${units(v)}`,
  slope_4h: (v) => `its trend over the last four hours was ${units(v)}`,
  pos_24h: (v) => `it stands at ${whole(v)} of its day's range, from the low`,
  pos_7d: (v) => `it stands at ${whole(v)} of its week's range, from the low`,
  from_high_24h: (v) => `it is ${count(v)} usual days' moves below its day's high`,
  from_low_24h: (v) => `it is ${count(v)} usual days' moves above its day's low`,
  atr_15m: (v) => `its fifteen-minute true range is ${v.toFixed(2)}%`,
  atr_1h: (v) => `its hourly true range is ${v.toFixed(2)}%`,
  range_exp: (v) => `its last hour's range was ${share(v)} the day's usual hour`,
  vol_ratio_1h: (v) => `volume is ${share(v)} its usual hour`,
  vol_acc_15m: (v) => `volume in the last fifteen minutes is ${share(Math.exp(v))} the fifteen before`,
  taker_1h: (v) => `buyers took ${whole(v + 0.5)} of the last hour's volume`,
  taker_4h: (v) => `buyers took ${whole(v + 0.5)} of the last four hours' volume`,
  ema20_1h: (v) => fromAverage(v, '20-hour average'),
  ema50_1h: (v) => fromAverage(v, '50-hour average'),
  ema200_1h: (v) => fromAverage(v, '200-hour average'),
  rsi_15m: (v) => `its fifteen-minute RSI is ${v.toFixed(0)}`,
  rsi_1h: (v) => `its hourly RSI is ${v.toFixed(0)}`,
  bb_pos_1h: (v) => `it stands at ${whole(v)} of its hourly Bollinger band, from the lower edge`,
  bb_width_1h: (v) => `its hourly Bollinger band is ${size(v)} wide`,
  adx_1h: (v) => `its hourly trend strength (ADX) is ${v.toFixed(0)}`,
  btc_r_1h: (v) => `Bitcoin's last hour moved ${pct(v)}`,
  btc_r_4h: (v) => `Bitcoin's last four hours moved ${pct(v)}`,
  btc_r_24h: (v) => `Bitcoin's last day moved ${pct(v)}`,
  eth_r_1h: (v) => `ether's last hour moved ${pct(v)}`,
  eth_r_4h: (v) => `ether's last four hours moved ${pct(v)}`,
  breadth_1h: (v) => `${whole(v)} of the coins rose in the last hour`,
  breadth_24h: (v) => `${whole(v)} of the coins rose over the day`,
  alt_strength: (v) => `the other coins' median day ran ${pct(v)} against Bitcoin's`,
  beta_btc: (v) => `its beta to Bitcoin is ${Number(v.toFixed(2))}`,
  idio_1h: (v) => `its own last hour, beyond what Bitcoin's explains, was ${pct(v)}`
}

/** A figure in words, with its value. */
export function describeFeature(feature: string, value: number): string {
  const say = WORDS[feature]
  if (say !== undefined) return say(value)
  const yes = value > 0.5
  if (feature.startsWith('regime_')) return `the market is ${yes ? '' : 'not '}${REGIME_WORDS[feature.slice(7)] ?? feature.slice(7)}`
  if (feature.startsWith('class_')) return `it is ${yes ? '' : 'not '}${CLASS_WORDS[feature.slice(6)] ?? feature.slice(6)}`
  if (feature.startsWith('hour_') || feature.startsWith('dow_')) return 'the time of day and week'
  return `${feature.replace(/_/g, ' ')} is ${Number(value.toPrecision(3))}`
}

/** The three figures that moved a row's size reading most, by a boosted size model. */
export function rangeDriversOf(model: GbtModel, row: ArrayLike<number>, top = 3, name: ForecastModelId = 'gbt'): RangeDriver[] {
  const { contributions } = gbtContributions(model, row)
  return [...contributions]
    .map((effect, index) => ({ index, effect }))
    .filter((entry) => entry.effect !== 0 && Number.isFinite(entry.effect))
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))
    .slice(0, top)
    .map(({ index, effect }) => {
      const feature = FEATURE_NAMES[index] ?? `figure ${index}`
      const value = row[index]
      return { model: name, feature, effect, value, text: `${describeFeature(feature, value)}${effect > 0 ? ', which widened the range' : ', which narrowed it'}` }
    })
}

/** The drivers of the boosted size model weighing more at the horizon for the pair's class (its
 * calibration's weights); none where neither weighs. */
export function rangeDriversFor(fitted: Pick<FittedHorizon, 'gbt' | 'gbtPrice'>, weights: readonly MemberWeight[], row: ArrayLike<number>): RangeDriver[] {
  const weight = (model: ForecastModelId): number => weights.find((member) => member.model === model)?.weight ?? 0
  const gbt = weight('gbt')
  const price = weight('gbt-price')
  if (!(gbt > 0) && !(price > 0)) return []
  return price > gbt ? rangeDriversOf(fitted.gbtPrice.size, row, 3, 'gbt-price') : rangeDriversOf(fitted.gbt.size, row, 3, 'gbt')
}
