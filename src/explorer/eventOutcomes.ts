import type { Candle } from '../../shared/ipc'
import { EVENT_BAR_SECONDS, EVENT_FOLLOW_MINUTES, moveAfterEvent, type MarketEvent } from '../../shared/marketEvent'

// What the price did after each event on the page: fifteen minutes, an hour and four hours on.
//
// WORKED OUT, NOT STORED. An event's record holds what the scanner saw; what followed is read
// from candles whenever the page asks, so it cannot drift from the market it describes.
//
// One request a pair, not one an event: a pair that raised three events in an afternoon is
// fetched once, from its earliest to its latest.

/** One entry per EVENT_FOLLOW_MINUTES: the plain change in percent, or null while that horizon
 * has not closed yet. */
export type EventMoves = (number | null)[]

export type RangeFetch = (symbol: string, startSec: number, endSec: number) => Promise<Candle[]>

/** Moves that can no longer change, kept so a page that refreshes every minute asks for each
 * event's candles until its last horizon closes and then never again. */
const settled = new Map<string, EventMoves>()

const LONGEST_SECONDS = Math.max(...EVENT_FOLLOW_MINUTES) * EVENT_BAR_SECONDS

/** The moves after each event, by event id. Events whose candles could not be fetched come back
 * with every horizon null rather than being left out: "not known" is an answer the page can show. */
export async function loadEventMoves(events: MarketEvent[], nowSec: number, fetchRange: RangeFetch): Promise<Map<string, EventMoves>> {
  const moves = new Map<string, EventMoves>()
  const pending = new Map<string, MarketEvent[]>()
  for (const event of events) {
    const known = settled.get(event.id)
    if (known) {
      moves.set(event.id, known)
      continue
    }
    const list = pending.get(event.symbol)
    if (list) list.push(event)
    else pending.set(event.symbol, [event])
  }

  await Promise.all(
    [...pending.entries()].map(async ([symbol, list]) => {
      const first = Math.min(...list.map((event) => event.time))
      const last = Math.max(...list.map((event) => event.time))
      let bars: Candle[] = []
      try {
        bars = await fetchRange(symbol, first, Math.min(nowSec, last + LONGEST_SECONDS))
      } catch {
        bars = []
      }
      for (const event of list) {
        const result = EVENT_FOLLOW_MINUTES.map((minutes) => moveAfterEvent(event, bars, minutes, nowSec))
        moves.set(event.id, result)
        if (result.every((move) => move !== null)) settled.set(event.id, result)
      }
    })
  )
  return moves
}

/** Test seam. */
export function clearSettledEventMoves(): void {
  settled.clear()
}
