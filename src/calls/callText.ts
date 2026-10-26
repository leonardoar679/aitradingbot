import type { CardRefusal, DelistLiveReading, LateCall, PrimaryCallState, PrimaryCard, RefusalCode } from '../../shared/forecast/primaryCall'
import type { Horizon } from '../../shared/forecast/features'
import type { PricePrediction } from '../../shared/forecast/prediction'
import { ratesAt } from '../../shared/forecast/moveRates'

// THE PRIMARY CALL IN WORDS (V8 Stage 3). English for now: the card and the lines are translated with the News URLs page
// in V8 Stage 5, and until then they are shown inside <EnglishOnly> on the translated pages. Plain functions of what
// the service weighed, so that a test reads the same sentences the page shows.

/** A signed percent: +1.23% or −1.23%. */
export function signed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—'
  const fixed = Math.abs(value).toFixed(digits)
  return `${value < 0 && Number(fixed) !== 0 ? '−' : '+'}${fixed}%`
}

/** A price to six significant figures, without trailing zeros past the point. */
export function priceText(price: number): string {
  if (!Number.isFinite(price) || price <= 0) return '—'
  const text = price >= 1000 ? price.toFixed(2) : price.toPrecision(6)
  return text.includes('.') && !text.includes('e') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** A moment in UTC, HH:MM. */
export const utcTime = (seconds: number): string => `${new Date(seconds * 1000).toISOString().slice(11, 16)} UTC`

/** A pair as people write it: ABC/USDT. */
export const pairWords = (pair: string): string => (pair.endsWith('USDT') ? `${pair.slice(0, -4)}/USDT` : pair)

/** The card's label: BEARISH −15.82% or BULLISH +1.20%. */
export function cardLabel(card: Pick<PrimaryCard, 'side' | 'movePct'>): string {
  return card.side === 'down' ? `BEARISH ${signed(-card.movePct)}` : `BULLISH ${signed(card.movePct)}`
}

/** Why a candidate made no card, in a sentence. */
export function refusalText(code: RefusalCode): string {
  switch (code) {
    case 'late':
      return "Late for the rule: the study's shorts were entered within two minutes of the announcement, and the card is shown only within five."
    case 'withdrawn':
      return "Withdrawn: the delistings announced since 1 October have not held up the study's result (its live check)."
    case 'no-price':
      return 'No live price of the coin is read.'
    case 'no-pair':
      return 'No USDT pair on a venue the app reads (a coin traded only on a decentralised exchange among them): nothing about it can be costed or traded here.'
    case 'no-book':
    case 'stale-book':
    case 'cannot-hold':
      return "Cost not measured: no fresh book of the venue holds the stake, so nothing is recommended."
    case 'thin':
      return 'The book is too thin for the stake: under five stakes within 0.5% of the mid.'
    case 'cost-share':
      return "The spread and the book's impact would take more than half the move."
    case 'under-lines':
      return "Its expected net after costs does not clear the card's lines: a 90% lower bound above 0% and at least +1%."
    case 'no-evidence':
      return 'Its source has no record to weigh it on.'
  }
}

/** What the card's source is, in a few words. */
export function sourceWords(card: PrimaryCard): string {
  return card.detail.kind === 'delisting' ? 'Binance delisting rule' : `direction model ${card.detail.model}`
}

/** The card's reason: one sentence, with its flags. */
export function reasonText(card: PrimaryCard): string {
  if (card.detail.kind === 'delisting') {
    const weaker = card.detail.weaker ? ' Its live record since 1 October is weaker than its study.' : ''
    return (
      `Binance announced it will delist ${card.detail.ticker}. Of the study's ${card.detail.coins} delisted coins, ${card.ahead.count} were lower four hours on after costs, ` +
      `measured on ${card.detail.hours} announcement hours held out from January 2025 to September 2026; no venue could take most of these shorts for real.${weaker}`
    )
  }
  return `${card.detail.model} calls this way: a direction model that cleared the direction bar on two walk forwards in a row.`
}

/** What a person can do with the card: never an order of its own. */
export function actionText(card: PrimaryCard): string {
  if (card.detail.kind === 'delisting') {
    return `If you hold ${card.detail.ticker}, this is the moment the study says to step out of it. A paper short is the news rule's to open (Settings › Market); nothing here places anything.`
  }
  return 'A paper trade can be filled in from the forecast on Predictions; nothing here places anything.'
}

/** The arrival: when its source's calls reached the target. */
export function arrivalText(card: PrimaryCard): string {
  if (card.arrival === null) return 'Not measured for this source.'
  const from = Math.round(card.arrival.fromSec / 60)
  const to = Math.round(card.arrival.toSec / 60)
  return `Of the study's coins, ${Math.round(card.arrival.touchedShare * 100)}% reached it within the hold; the middle half of those between ${from} and ${to} minutes after the announcement.`
}

/** The costs line: venue, basis, stake, side, and the parts. */
export function costText(card: PrimaryCard): string {
  const cost = card.cost
  const venue = cost.venue === 'binance' ? 'Binance' : 'Bitget'
  const parts = [
    `fee ${cost.feePct.toFixed(2)}% each way`,
    cost.spreadPct === null ? 'spread not read' : `spread ${cost.spreadPct.toFixed(2)}%`,
    `impact ${cost.impactPct.toFixed(2)}%`,
    `funding ${cost.fundingPct.toFixed(2)}%`
  ]
  return `${venue}, from its ${cost.basis === 'book' ? 'book' : cost.basis === 'best' ? 'best prices' : 'flat line'}, a ${cost.side === 'SELL' ? 'sell' : 'buy'} of ${cost.stakeQuote.toFixed(0)} USDT: ${parts.join(', ')} → ${cost.totalPct.toFixed(2)}% for the round trip.`
}

/** The expected net, with its interval and what it rests on. */
export function expectedNetText(card: PrimaryCard): string {
  const net = card.expectedNet
  return `${signed(net.pct)} (90%: ${signed(net.low)} to ${signed(net.high)}) on ${net.calls} calls in ${net.units} ${card.detail.kind === 'delisting' ? 'announcement hours' : 'hours'}.`
}

/** A late coin in a sentence. */
export function lateText(late: LateCall): string {
  const moved = late.movedSincePct === null ? 'its move since is not read' : `it has moved ${signed(late.movedSincePct)} since`
  return `${pairWords(late.pair)}: Binance announced its delisting at ${utcTime(late.eventAt)}, past the rule's five minutes; ${moved}. The rule's hold would end at ${utcTime(late.exitAt)}.`
}

/** The live check, in a sentence; null before it is read. */
export function liveCheckText(live: DelistLiveReading | null): string | null {
  if (live === null) return null
  if (live.hours === 0) return 'The rule\'s live check: no delisting since 1 October has been scored yet.'
  const mean = live.meanPct === null ? '' : `, ${signed(live.meanPct)} on hourly means`
  const state = live.state === 'withdrawn' ? ' — the card is withdrawn' : live.state === 'weaker' ? ' — weaker than its study' : ''
  return `The rule's live check since 1 October: ${live.coins} coins in ${live.hours} announcement hours${mean}${state}.`
}

/** Where calls come from: the sources that may set a side, and whether they can speak now. */
export function sourcesText(state: Pick<PrimaryCallState, 'readerOn' | 'modelSources'>): string {
  const reader = state.readerOn
    ? "Binance's announcements are read every minute, so a delisting is seen within its first minute."
    : "Binance's announcements are not read: the reader is off (Settings › Market), so a delisting would not be seen in time."
  const models = state.modelSources > 0 ? `${state.modelSources} forecast ranges read their way from a direction model.` : 'No direction model has cleared the direction bar twice, so the forecast calls no way.'
  return `A card comes only from a measured source: a Binance delisting (the one way measured, on a held-out year and a half), or a direction model once one clears the direction bar on two walk forwards in a row. ${reader} ${models}`
}

/** Why there is no card now, in a sentence. */
export function noCardText(state: Pick<PrimaryCallState, 'refused' | 'late'>): string {
  const first: CardRefusal | undefined = state.refused.find((refusal) => refusal.refused !== 'late') ?? state.refused[0]
  if (first !== undefined) return `${pairWords(first.pair)}: ${refusalText(first.refused)}`
  return 'No measured source calls a way for any coin now.'
}

/** The size a horizon's line asks about (V8-R1-SIZE's targets): 1% at an hour, 2% at four hours, 5% at a day. */
export const LINE_SIZE_PCT: Readonly<Record<'hour1' | 'hours4' | 'hours24', number>> = { hour1: 1, hours4: 2, hours24: 5 }
export const LINE_HORIZON_WORDS: Readonly<Record<'hour1' | 'hours4' | 'hours24', string>> = { hour1: 'an hour', hours4: 'four hours', hours24: 'a day' }
export const LINE_SPAN_WORDS: Readonly<Record<'hour1' | 'hours4' | 'hours24', string>> = { hour1: 'one-hour', hours4: 'four-hour', hours24: 'one-day' }

/** How often a coin's close moved at least the line's size, either way, over its last 90 days; null where not read. */
export function rateOf(prediction: Pick<PricePrediction, 'moveRates'>, horizon: 'hour1' | 'hours4' | 'hours24'): number | null {
  const rates = ratesAt(prediction.moveRates, horizon)
  const close = rates?.close.find((rate) => rate.pct === LINE_SIZE_PCT[horizon])
  return close === undefined ? null : close.either
}

/** The likely size of a coin's move at a horizon: its 80% range, P10 to P90, from the close's forecast. */
export function likelyText(prediction: Pick<PricePrediction, 'horizons'>, horizon: Horizon): string | null {
  const range = prediction.horizons[horizon]
  if (range === undefined) return null
  const q = range.quantilesPct
  return `${signed(q[0])} to ${signed(q[4])}`
}

/** The forecast's pairs' likely move at four hours, smallest to largest half-width of the 80% range, for the
 * no-card state: the size is measured, the way is not. */
export function sizeSpanText(predictions: readonly Pick<PricePrediction, 'pair' | 'horizons'>[]): string | null {
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
  return `Over the next four hours the forecast's ${widths.length} pairs are likely to move about ±${low.half.toFixed(1)}% (${pairWords(low.pair)}) to ±${high.half.toFixed(1)}% (${pairWords(high.pair)}), eight times in ten; over seven months its ranges held 79–81% of outcomes. The size is measured; which way is not.`
}
