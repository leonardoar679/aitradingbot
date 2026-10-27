import type { CardRefusal, DelistLiveReading, LateCall, PrimaryCallState, PrimaryCard, RefusalCode } from '../../shared/forecast/primaryCall'
import type { Horizon } from '../../shared/forecast/features'
import type { PricePrediction } from '../../shared/forecast/prediction'
import { ratesAt } from '../../shared/forecast/moveRates'
import { ENGLISH, msg, type I18n } from '../../shared/i18n/translate'

// THE PRIMARY CALL IN WORDS (V8 Stage 3; in the person's language since V8 Stage 5). Plain functions of what the
// service weighed, each in a language -- English unless handed the person's -- so that a test reads the same sentences
// the page shows. A value is never translated text: a percentage, a price or a time is formatted by the language's own
// rules and put in its place.

/** A pair as people write it: ABC/USDT. */
export const pairWords = (pair: string): string => (pair.endsWith('USDT') ? `${pair.slice(0, -4)}/USDT` : pair)

/** A moment in UTC: "14:05 UTC". */
export const utcText = (seconds: number, { t, utcTime }: I18n = ENGLISH): string => t('{time} UTC', { time: utcTime(seconds * 1000) })

/** The card's label: BEARISH -15.82% or BULLISH +1.20%. */
export function cardLabel(card: Pick<PrimaryCard, 'side' | 'movePct'>, { t, pct }: I18n = ENGLISH): string {
  return card.side === 'down' ? t('BEARISH {move}', { move: pct(-card.movePct, 2) }) : t('BULLISH {move}', { move: pct(card.movePct, 2) })
}

const REFUSAL_WORDS: Record<RefusalCode, string> = {
  late: msg("Late for the rule: the study's shorts were entered within two minutes of the announcement, and the card is shown only within five."),
  withdrawn: msg("Withdrawn: the delistings announced since 1 October have not held up the study's result (its live check)."),
  'no-price': msg('No live price of the coin is read.'),
  'no-pair': msg('No USDT pair on a venue the app reads (a coin traded only on a decentralised exchange among them): nothing about it can be costed or traded here.'),
  'no-book': msg('Cost not measured: no fresh book of the venue holds the stake, so nothing is recommended.'),
  'stale-book': msg('Cost not measured: no fresh book of the venue holds the stake, so nothing is recommended.'),
  'cannot-hold': msg('Cost not measured: no fresh book of the venue holds the stake, so nothing is recommended.'),
  thin: msg('The book is too thin for the stake: under five stakes within 0.5% of the mid.'),
  'cost-share': msg("The spread and the book's impact would take more than half the move."),
  'under-lines': msg("Its expected net after costs does not clear the card's lines: a 90% lower bound above 0% and at least +1%."),
  'no-evidence': msg('Its source has no record to weigh it on.')
}

/** Why a candidate made no card, in a sentence. */
export function refusalText(code: RefusalCode, { t }: I18n = ENGLISH): string {
  return t(REFUSAL_WORDS[code])
}

/** What the card's source is, in a few words. */
export function sourceWords(card: PrimaryCard, { t }: I18n = ENGLISH): string {
  return card.detail.kind === 'delisting' ? t('Binance delisting rule') : t('direction model {model}', { model: card.detail.model })
}

/** The card's reason: one sentence, with its flags. */
export function reasonText(card: PrimaryCard, { t }: I18n = ENGLISH): string {
  if (card.detail.kind === 'delisting') {
    const said = t(
      "Binance announced it will delist {ticker}. Of the study's {coins} delisted coins, {ahead} were lower four hours on after costs, measured on {hours} announcement hours held out from January 2025 to September 2026; no venue could take most of these shorts for real.",
      { ticker: card.detail.ticker, coins: card.detail.coins, ahead: card.ahead.count, hours: card.detail.hours }
    )
    return card.detail.weaker ? `${said} ${t('Its live record since 1 October is weaker than its study.')}` : said
  }
  return t('{model} calls this way: a direction model that cleared the direction bar on two walk forwards in a row.', { model: card.detail.model })
}

/** What a person can do with the card: never an order of its own. */
export function actionText(card: PrimaryCard, { t }: I18n = ENGLISH): string {
  if (card.detail.kind === 'delisting') {
    return t("If you hold {ticker}, this is the moment the study says to step out of it. A paper short is the news rule's to open (Settings › Market); nothing here places anything.", { ticker: card.detail.ticker })
  }
  return t('A paper trade can be filled in from the forecast on Predictions; nothing here places anything.')
}

/** The arrival: when its source's calls reached the target. */
export function arrivalText(card: PrimaryCard, { t, pctPlain }: I18n = ENGLISH): string {
  if (card.arrival === null) return t('Not measured for this source.')
  return t("Of the study's coins, {share} reached it within the hold; the middle half of those between {from} and {to} minutes after the announcement.", {
    share: pctPlain(Math.round(card.arrival.touchedShare * 100), 0),
    from: Math.round(card.arrival.fromSec / 60),
    to: Math.round(card.arrival.toSec / 60)
  })
}

/** The costs line: venue, basis, stake, side, and the parts. */
export function costText(card: PrimaryCard, { t, pctPlain, money }: I18n = ENGLISH): string {
  const cost = card.cost
  const parts = [
    t('fee {fee} each way', { fee: pctPlain(cost.feePct, 2) }),
    cost.spreadPct === null ? t('spread not read') : t('spread {spread}', { spread: pctPlain(cost.spreadPct, 2) }),
    t('impact {impact}', { impact: pctPlain(cost.impactPct, 2) }),
    t('funding {funding}', { funding: pctPlain(cost.fundingPct, 2) })
  ]
  const basis = cost.basis === 'book' ? t('from its book') : cost.basis === 'best' ? t('from its best prices') : t('from its flat line')
  const stake = money(cost.stakeQuote, 'USDT', 0)
  return t('{venue}, {basis}, {trade}: {parts} → {total} for the round trip.', {
    venue: cost.venue === 'binance' ? 'Binance' : 'Bitget',
    basis,
    trade: cost.side === 'SELL' ? t('a sell of {stake}', { stake }) : t('a buy of {stake}', { stake }),
    parts: parts.join(', '),
    total: pctPlain(cost.totalPct, 2)
  })
}

/** The expected net, with its interval and what it rests on. */
export function expectedNetText(card: PrimaryCard, { t, pct }: I18n = ENGLISH): string {
  const net = card.expectedNet
  const values = { net: pct(net.pct, 2), low: pct(net.low, 2), high: pct(net.high, 2), calls: net.calls, units: net.units }
  return card.detail.kind === 'delisting' ? t('{net} (90%: {low} to {high}) on {calls} calls in {units} announcement hours.', values) : t('{net} (90%: {low} to {high}) on {calls} calls in {units} hours.', values)
}

/** A late coin in a sentence. */
export function lateText(late: LateCall, i18n: I18n = ENGLISH): string {
  const { t, pct } = i18n
  return t("{pair}: Binance announced its delisting at {time}, past the rule's five minutes; {moved}. The rule's hold would end at {end}.", {
    pair: pairWords(late.pair),
    time: utcText(late.eventAt, i18n),
    moved: late.movedSincePct === null ? t('its move since is not read') : t('it has moved {move} since', { move: pct(late.movedSincePct, 2) }),
    end: utcText(late.exitAt, i18n)
  })
}

/** The live check, in a sentence; null before it is read. */
export function liveCheckText(live: DelistLiveReading | null, { t, pct }: I18n = ENGLISH): string | null {
  if (live === null) return null
  if (live.hours === 0) return t("The rule's live check: no delisting since 1 October has been scored yet.")
  const read =
    live.meanPct === null
      ? t("The rule's live check since 1 October: {coins} coins in {hours} announcement hours.", { coins: live.coins, hours: live.hours })
      : t("The rule's live check since 1 October: {coins} coins in {hours} announcement hours, {mean} on hourly means.", { coins: live.coins, hours: live.hours, mean: pct(live.meanPct, 2) })
  if (live.state === 'withdrawn') return `${read} ${t('The card is withdrawn.')}`
  if (live.state === 'weaker') return `${read} ${t('It is weaker than its study.')}`
  return read
}

/** Where calls come from: the sources that may set a side, and whether they can speak now. */
export function sourcesText(state: Pick<PrimaryCallState, 'readerOn' | 'modelSources'>, { t }: I18n = ENGLISH): string {
  return [
    t('A card comes only from a measured source: a Binance delisting (the one way measured, on a held-out year and a half), or a direction model once one clears the direction bar on two walk forwards in a row.'),
    state.readerOn
      ? t("Binance's announcements are read every minute, so a delisting is seen within its first minute.")
      : t("Binance's announcements are not read: the reader is off (Settings › Market), so a delisting would not be seen in time."),
    state.modelSources > 0
      ? t('{count} forecast ranges read their way from a direction model.', { count: state.modelSources })
      : t('No direction model has cleared the direction bar twice, so the forecast calls no way.')
  ].join(' ')
}

/** Why there is no card now, in a sentence. */
export function noCardText(state: Pick<PrimaryCallState, 'refused' | 'late'>, i18n: I18n = ENGLISH): string {
  const first: CardRefusal | undefined = state.refused.find((refusal) => refusal.refused !== 'late') ?? state.refused[0]
  if (first !== undefined) return i18n.t('{pair}: {why}', { pair: pairWords(first.pair), why: refusalText(first.refused, i18n) })
  return i18n.t('No measured source calls a way for any coin now.')
}

export type LineHorizon = 'hour1' | 'hours4' | 'hours24'

/** The size a horizon's line asks about (V8-R1-SIZE's targets): 1% at an hour, 2% at four hours, 5% at a day. */
export const LINE_SIZE_PCT: Readonly<Record<LineHorizon, number>> = { hour1: 1, hours4: 2, hours24: 5 }
/** A horizon inside a sentence: "over {span}". */
export const LINE_HORIZON_WORDS: Readonly<Record<LineHorizon, string>> = { hour1: msg('an hour'), hours4: msg('four hours'), hours24: msg('a day') }
/** How often a coin moved that much: "{share} of four-hour spans". */
export const LINE_SPAN_WORDS: Readonly<Record<LineHorizon, string>> = { hour1: msg('{share} of one-hour spans'), hours4: msg('{share} of four-hour spans'), hours24: msg('{share} of one-day spans') }

/** How often a coin's close moved at least the line's size, either way, over its last 90 days; null where not read. */
export function rateOf(prediction: Pick<PricePrediction, 'moveRates'>, horizon: LineHorizon): number | null {
  const rates = ratesAt(prediction.moveRates, horizon)
  const close = rates?.close.find((rate) => rate.pct === LINE_SIZE_PCT[horizon])
  return close === undefined ? null : close.either
}

/** The likely size of a coin's move at a horizon: its 80% range, P10 to P90, from the close's forecast. */
export function likelyText(prediction: Pick<PricePrediction, 'horizons'>, horizon: Horizon, { t, pct }: I18n = ENGLISH): string | null {
  const range = prediction.horizons[horizon]
  if (range === undefined) return null
  const q = range.quantilesPct
  return t('{low} to {high}', { low: pct(q[0], 2), high: pct(q[4], 2) })
}

/** The forecast's pairs' likely move at four hours, smallest to largest half-width of the 80% range, for the
 * no-card state: the size is measured, the way is not. */
export function sizeSpanText(predictions: readonly Pick<PricePrediction, 'pair' | 'horizons'>[], { t, pctPlain }: I18n = ENGLISH): string | null {
  const widths = predictions
    .map((prediction) => {
      const range = prediction.horizons.hours4
      return range === undefined ? null : { pair: prediction.pair, half: (range.quantilesPct[4] - range.quantilesPct[0]) / 2 }
    })
    .filter((entry): entry is { pair: string; half: number } => entry !== null && Number.isFinite(entry.half))
    .sort((a, b) => a.half - b.half)
  if (widths.length === 0) return null
  const low = widths[0]
  const high = widths[widths.length - 1]
  return t(
    "Over the next four hours the forecast's {count} pairs are likely to move about ±{low} ({lowPair}) to ±{high} ({highPair}), eight times in ten; over seven months its ranges held 79–81% of outcomes. The size is measured; which way is not.",
    { count: widths.length, low: pctPlain(low.half, 1), lowPair: pairWords(low.pair), high: pctPlain(high.half, 1), highPair: pairWords(high.pair) }
  )
}
