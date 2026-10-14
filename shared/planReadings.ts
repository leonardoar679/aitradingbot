import type { MarketEvent } from './marketEvent'
import { ENGLISH, msg, type I18n } from './i18n/translate'

// WHY THIS ENTRY, THIS STOP, THIS TARGET (the V5 document, §55; V5 Stage 6, 8 October 2026). A
// model names its levels and gives a rationale in prose; the app reads those levels against the
// numbers on the event's own record, so a person can see what they amount to without taking the
// model's word: how far the entry sits from the event's price and where the live price is against
// it; how far the stop is, in percent and in the pair's usual fifteen-minute moves; how far the
// target is, the same way, and in R against the stop. Readings, never a judgement.

export interface LevelReadings {
  entry: string
  stop: string
  target: string
  /** The pair's usual fifteen-minute move at the event, in percent; null where the record has none. */
  usualMovePct: number | null
  stopPct: number | null
  targetPct: number | null
  rewardToRisk: number | null
}


/** The usual fifteen-minute move the event was measured against, from the record: the move it
 * made over the number of such moves it was. */
export function usualMoveOf(event: Pick<MarketEvent, 'returnsPct' | 'moveSigmas'>): number | null {
  if (!(event.moveSigmas > 0) || !Number.isFinite(event.returnsPct.m15)) return null
  return Math.abs(event.returnsPct.m15) / event.moveSigmas
}

export function levelReadings(input: {
  event: Pick<MarketEvent, 'price' | 'returnsPct' | 'moveSigmas'>
  side: 'buy' | 'sell'
  entryMin: number
  entryMax: number
  stopLoss: number | null
  takeProfit: number | null
  /** The live price a fill would take, where the stream is read. */
  livePrice: number | null
}, i18n: I18n = ENGLISH): LevelReadings {
  const { t, num } = i18n
  const pct = (value: number): string => (i18n.language === 'en' ? `${value.toFixed(2)}%` : i18n.pctPlain(value, 2))
  const plain = (value: number): string => num(Number(value.toPrecision(7)), 0, 8)
  const { event } = input
  const mid = (input.entryMin + input.entryMax) / 2
  const usual = usualMoveOf(event)
  const moves = (movePct: number): string | null => (usual === null || usual <= 0 ? null : num(movePct / usual, 1, 1))
  const fromEvent = event.price > 0 ? ((mid - event.price) / event.price) * 100 : null
  const where =
    input.livePrice === null
      ? t('the live price is not read yet')
      : input.livePrice < input.entryMin
        ? t('the live price {price} is {gap} under it', { price: plain(input.livePrice), gap: pct(((input.entryMin - input.livePrice) / input.entryMin) * 100) })
        : input.livePrice > input.entryMax
          ? t('the live price {price} is {gap} over it', { price: plain(input.livePrice), gap: pct(((input.livePrice - input.entryMax) / input.entryMax) * 100) })
          : t('the live price {price} is inside it', { price: plain(input.livePrice) })
  const range = { low: plain(input.entryMin), high: plain(input.entryMax), width: pct(((input.entryMax - input.entryMin) / mid) * 100), where }
  const entry =
    fromEvent === null
      ? t('Between {low} and {high}, {width} wide; {where}.', range)
      : t("Between {low} and {high}, {width} wide, its middle {move} from the event's price {price}; {where}.", {
          ...range,
          move: i18n.language === 'en' ? `${fromEvent >= 0 ? '+' : ''}${pct(fromEvent)}` : i18n.pct(fromEvent, 2),
          price: plain(event.price)
        })
  const stopPct = input.stopLoss === null || !(mid > 0) ? null : (Math.abs(mid - input.stopLoss) / mid) * 100
  const targetPct = input.takeProfit === null || !(mid > 0) ? null : (Math.abs(input.takeProfit - mid) / mid) * 100
  const buy = input.side === 'buy'
  const stopMoves = stopPct === null ? null : moves(stopPct)
  const stop =
    input.stopLoss === null || stopPct === null
      ? t('No stop named.')
      : stopMoves === null
        ? buy
          ? t("{price}: {gap} below the entry's middle.", { price: plain(input.stopLoss), gap: pct(stopPct) })
          : t("{price}: {gap} above the entry's middle.", { price: plain(input.stopLoss), gap: pct(stopPct) })
        : buy
          ? t("{price}: {gap} below the entry's middle, {moves} of its usual fifteen-minute moves.", { price: plain(input.stopLoss), gap: pct(stopPct), moves: stopMoves })
          : t("{price}: {gap} above the entry's middle, {moves} of its usual fifteen-minute moves.", { price: plain(input.stopLoss), gap: pct(stopPct), moves: stopMoves })
  const rewardToRisk = stopPct !== null && stopPct > 0 && targetPct !== null ? targetPct / stopPct : null
  const targetMoves = targetPct === null ? null : moves(targetPct)
  const targetSide = (withMoves: boolean, withR: boolean): string =>
    buy
      ? withMoves
        ? withR
          ? msg("{price}: {gap} above the entry's middle, {moves} of its usual fifteen-minute moves, {r} R against the stop.")
          : msg("{price}: {gap} above the entry's middle, {moves} of its usual fifteen-minute moves.")
        : withR
          ? msg("{price}: {gap} above the entry's middle, {r} R against the stop.")
          : msg("{price}: {gap} above the entry's middle.")
      : withMoves
        ? withR
          ? msg("{price}: {gap} below the entry's middle, {moves} of its usual fifteen-minute moves, {r} R against the stop.")
          : msg("{price}: {gap} below the entry's middle, {moves} of its usual fifteen-minute moves.")
        : withR
          ? msg("{price}: {gap} below the entry's middle, {r} R against the stop.")
          : msg("{price}: {gap} below the entry's middle.")
  const target =
    input.takeProfit === null || targetPct === null
      ? t('No target named.')
      : t(targetSide(targetMoves !== null, rewardToRisk !== null), {
          price: plain(input.takeProfit),
          gap: pct(targetPct),
          moves: targetMoves ?? '',
          r: rewardToRisk === null ? '' : num(rewardToRisk, 1, 1)
        })
  return { entry, stop, target, usualMovePct: usual, stopPct, targetPct, rewardToRisk }
}
