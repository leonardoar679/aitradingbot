import type { MarketEvent } from './marketEvent'

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

const pct = (value: number): string => `${value.toFixed(2)}%`
const plain = (value: number): string => Number(value.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 8 })

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
}): LevelReadings {
  const { event } = input
  const mid = (input.entryMin + input.entryMax) / 2
  const usual = usualMoveOf(event)
  const inMoves = (movePct: number): string => (usual === null || usual <= 0 ? '' : `, ${(movePct / usual).toFixed(1)} of its usual fifteen-minute moves`)
  const fromEvent = event.price > 0 ? ((mid - event.price) / event.price) * 100 : null
  const where =
    input.livePrice === null
      ? 'the live price is not read yet'
      : input.livePrice < input.entryMin
        ? `the live price ${plain(input.livePrice)} is ${pct(((input.entryMin - input.livePrice) / input.entryMin) * 100)} under it`
        : input.livePrice > input.entryMax
          ? `the live price ${plain(input.livePrice)} is ${pct(((input.livePrice - input.entryMax) / input.entryMax) * 100)} over it`
          : `the live price ${plain(input.livePrice)} is inside it`
  const entry = `Between ${plain(input.entryMin)} and ${plain(input.entryMax)}, ${pct(((input.entryMax - input.entryMin) / mid) * 100)} wide${
    fromEvent === null ? '' : `, its middle ${fromEvent >= 0 ? '+' : ''}${pct(fromEvent)} from the event's price ${plain(event.price)}`
  }; ${where}.`
  const stopPct = input.stopLoss === null || !(mid > 0) ? null : (Math.abs(mid - input.stopLoss) / mid) * 100
  const targetPct = input.takeProfit === null || !(mid > 0) ? null : (Math.abs(input.takeProfit - mid) / mid) * 100
  const stopSide = input.side === 'buy' ? 'below' : 'above'
  const targetSide = input.side === 'buy' ? 'above' : 'below'
  const stop = input.stopLoss === null || stopPct === null ? 'No stop named.' : `${plain(input.stopLoss)}: ${pct(stopPct)} ${stopSide} the entry's middle${inMoves(stopPct)}.`
  const rewardToRisk = stopPct !== null && stopPct > 0 && targetPct !== null ? targetPct / stopPct : null
  const target =
    input.takeProfit === null || targetPct === null
      ? 'No target named.'
      : `${plain(input.takeProfit)}: ${pct(targetPct)} ${targetSide} the entry's middle${inMoves(targetPct)}${rewardToRisk === null ? '' : `, ${rewardToRisk.toFixed(1)} R against the stop`}.`
  return { entry, stop, target, usualMovePct: usual, stopPct, targetPct, rewardToRisk }
}
