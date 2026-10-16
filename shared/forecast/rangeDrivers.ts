import type { MemberWeight } from './ensemble'
import { FEATURE_NAMES } from './features'
import { gbtContributions, type GbtModel } from './ml/gbt'
import type { FittedHorizon, ForecastModelId } from './models'
import { ENGLISH, msg, type I18n } from '../i18n/translate'

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
// before as a log. Each is said by a key with its value in its place (V6 Stage 14), in any language.
type Say = (value: number, i18n: I18n) => string

const share = (value: number, { num }: I18n): string => `${num(value, 0, 2)}×`
const pct = (value: number, i18n: I18n): string => i18n.pct(value * 100, 2)
const size = (value: number, i18n: I18n): string => i18n.pctPlain(value * 100, 2)
const whole = (value: number, i18n: I18n): string => i18n.pctPlain(value * 100, 0)
const count = (value: number, { num }: I18n): string => num(Math.abs(value), 0, 1)

/** A figure's sentence, one for each sign of it. */
const signed =
  (up: string, down: string): Say =>
  (value, i18n) =>
    i18n.t(value >= 0 ? up : down, { count: count(value, i18n) })
const moved =
  (key: string): Say =>
  (value, i18n) =>
    i18n.t(key, { move: pct(value, i18n) })

const REGIME_WORDS: Record<string, [string, string]> = {
  panic: [msg('the market is in panic'), msg('the market is not in panic')],
  'high-vol': [msg('the market is highly volatile'), msg('the market is not highly volatile')],
  recovery: [msg('the market is recovering'), msg('the market is not recovering')],
  bull: [msg('the market is in a bull run'), msg('the market is not in a bull run')],
  bear: [msg('the market is in a bear run'), msg('the market is not in a bear run')],
  sideways: [msg('the market is moving sideways'), msg('the market is not moving sideways')]
}
const CLASS_WORDS: Record<string, [string, string]> = {
  btc: [msg('it is Bitcoin'), msg('it is not Bitcoin')],
  eth: [msg('it is ether'), msg('it is not ether')],
  large: [msg('it is a large coin'), msg('it is not a large coin')],
  mid: [msg('it is a mid-sized coin'), msg('it is not a mid-sized coin')],
  'high-vol': [msg('it is a high-volatility coin'), msg('it is not a high-volatility coin')],
  other: [msg('it is a coin of no other kind'), msg('it is not a coin of no other kind')]
}

const WORDS: Record<string, Say> = {
  r_5m: moved(msg('the last five minutes moved {move}')),
  r_15m: moved(msg('the last fifteen minutes moved {move}')),
  r_30m: moved(msg('the last half hour moved {move}')),
  r_1h: moved(msg('the last hour moved {move}')),
  r_4h: moved(msg('the last four hours moved {move}')),
  r_24h: moved(msg('the last day moved {move}')),
  r_7d: moved(msg('the last week moved {move}')),
  rv_1h: (v, i) => i.t("its last hour's volatility was {size}", { size: size(v, i) }),
  rv_4h: (v, i) => i.t("its last four hours' volatility was {size}", { size: size(v, i) }),
  rv_24h: (v, i) => i.t("its day's volatility was {size}", { size: size(v, i) }),
  rv_ratio: (v, i) => i.t("its last hour moved at {share} the day's pace", { share: share(v, i) }),
  z_15m: signed(msg('its last fifteen minutes went up {count} times its usual move'), msg('its last fifteen minutes went down {count} times its usual move')),
  z_1h: signed(msg('its last hour went up {count} times its usual move'), msg('its last hour went down {count} times its usual move')),
  z_4h: signed(msg('its last four hours went up {count} times its usual move'), msg('its last four hours went down {count} times its usual move')),
  z_24h: signed(msg('its last day went up {count} times its usual move'), msg('its last day went down {count} times its usual move')),
  acc_15m: signed(msg('its last fifteen minutes ran {count} usual moves above the fifteen before'), msg('its last fifteen minutes ran {count} usual moves below the fifteen before')),
  slope_1h: signed(msg('its trend over the last hour was up {count} times its usual move'), msg('its trend over the last hour was down {count} times its usual move')),
  slope_4h: signed(msg('its trend over the last four hours was up {count} times its usual move'), msg('its trend over the last four hours was down {count} times its usual move')),
  pos_24h: (v, i) => i.t("it stands at {share} of its day's range, from the low", { share: whole(v, i) }),
  pos_7d: (v, i) => i.t("it stands at {share} of its week's range, from the low", { share: whole(v, i) }),
  from_high_24h: (v, i) => i.t("it is {count} usual days' moves below its day's high", { count: count(v, i) }),
  from_low_24h: (v, i) => i.t("it is {count} usual days' moves above its day's low", { count: count(v, i) }),
  atr_15m: (v, i) => i.t('its fifteen-minute true range is {size}', { size: i.pctPlain(v, 2) }),
  atr_1h: (v, i) => i.t('its hourly true range is {size}', { size: i.pctPlain(v, 2) }),
  range_exp: (v, i) => i.t("its last hour's range was {share} the day's usual hour", { share: share(v, i) }),
  vol_ratio_1h: (v, i) => i.t('volume is {share} its usual hour', { share: share(v, i) }),
  vol_acc_15m: (v, i) => i.t('volume in the last fifteen minutes is {share} the fifteen before', { share: share(Math.exp(v), i) }),
  taker_1h: (v, i) => i.t("buyers took {share} of the last hour's volume", { share: whole(v + 0.5, i) }),
  taker_4h: (v, i) => i.t("buyers took {share} of the last four hours' volume", { share: whole(v + 0.5, i) }),
  ema20_1h: signed(msg("it is {count} usual days' moves above its 20-hour average"), msg("it is {count} usual days' moves below its 20-hour average")),
  ema50_1h: signed(msg("it is {count} usual days' moves above its 50-hour average"), msg("it is {count} usual days' moves below its 50-hour average")),
  ema200_1h: signed(msg("it is {count} usual days' moves above its 200-hour average"), msg("it is {count} usual days' moves below its 200-hour average")),
  rsi_15m: (v, i) => i.t('its fifteen-minute RSI is {value}', { value: i.num(v, 0, 0) }),
  rsi_1h: (v, i) => i.t('its hourly RSI is {value}', { value: i.num(v, 0, 0) }),
  bb_pos_1h: (v, i) => i.t('it stands at {share} of its hourly Bollinger band, from the lower edge', { share: whole(v, i) }),
  bb_width_1h: (v, i) => i.t('its hourly Bollinger band is {size} wide', { size: size(v, i) }),
  adx_1h: (v, i) => i.t('its hourly trend strength (ADX) is {value}', { value: i.num(v, 0, 0) }),
  btc_r_1h: moved(msg("Bitcoin's last hour moved {move}")),
  btc_r_4h: moved(msg("Bitcoin's last four hours moved {move}")),
  btc_r_24h: moved(msg("Bitcoin's last day moved {move}")),
  eth_r_1h: moved(msg("ether's last hour moved {move}")),
  eth_r_4h: moved(msg("ether's last four hours moved {move}")),
  breadth_1h: (v, i) => i.t('{share} of the coins rose in the last hour', { share: whole(v, i) }),
  breadth_24h: (v, i) => i.t('{share} of the coins rose over the day', { share: whole(v, i) }),
  alt_strength: moved(msg("the other coins' median day ran {move} against Bitcoin's")),
  beta_btc: (v, i) => i.t('its beta to Bitcoin is {value}', { value: i.num(v, 0, 2) }),
  idio_1h: moved(msg("its own last hour, beyond what Bitcoin's explains, was {move}")),
  // The market's last fifteen minutes (V7.1 Stage 11).
  btc_r_15m: moved(msg("Bitcoin's last fifteen minutes moved {move}")),
  eth_r_15m: moved(msg("ether's last fifteen minutes moved {move}")),
  btc_acc_15m: moved(msg("Bitcoin's last fifteen minutes ran {move} against the fifteen before")),
  breadth_15m: (v, i) => i.t('{share} of the coins rose over the last fifteen minutes', { share: whole(v, i) }),
  market_vol_acc: (v, i) => i.t("the market's volume in the last fifteen minutes is {share} its usual", { share: share(v, i) })
}

/** A figure in words, with its value, in a language: English unless handed another. */
export function describeFeature(feature: string, value: number, i18n: I18n = ENGLISH): string {
  const say = WORDS[feature]
  if (say !== undefined) return say(value, i18n)
  const yes = value > 0.5
  const pair = feature.startsWith('regime_') ? REGIME_WORDS[feature.slice(7)] : feature.startsWith('class_') ? CLASS_WORDS[feature.slice(6)] : undefined
  if (pair !== undefined) return i18n.t(yes ? pair[0] : pair[1])
  if (feature.startsWith('hour_') || feature.startsWith('dow_')) return i18n.t('the time of day and week')
  return i18n.t('{figure} is {value}', { figure: feature.replace(/_/g, ' '), value: i18n.num(Number(value.toPrecision(3)), 0, 10) })
}

/** A driver's line, in a language: its figure, and whether it widened the range or narrowed it. */
export function driverText(driver: Pick<RangeDriver, 'feature' | 'value' | 'effect'>, i18n: I18n = ENGLISH): string {
  const figure = describeFeature(driver.feature, driver.value, i18n)
  return driver.effect > 0 ? i18n.t('{figure}, which widened the range', { figure }) : i18n.t('{figure}, which narrowed it', { figure })
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
      return { model: name, feature, effect, value, text: driverText({ feature, value, effect }) }
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
