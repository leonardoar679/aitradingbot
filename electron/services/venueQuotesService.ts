import type { BookLevels } from '../../shared/marketCompare'
import { COSTED_VENUES, VENUE_STAKE_QUOTE, cheapestOf, roundTripOf, venueFeeOf, type CostedVenue, type RoundTrip } from '../../shared/venueCosts'
import { fetchBitgetFeeRates } from './exchanges/bitget'
import { readVenueBooks } from './marketCompareService'
import { liquidityVerdictOf, type LiquidityVerdict } from '../../shared/liquidityGate'

// THE VENUES' BOOKS FOR THE PAIRS THAT MATTER (V7.2-R Stage 4, 22 October 2026). The forecast's decisions cost a trade
// on the venue it would be cheapest on: so Binance's and Bitget's PUBLIC books, a hundred levels each, are read every
// minute for the pairs the forecast ranks highest and the pairs of the app's own open paper trades -- at most twelve --
// and Bitget's per-pair fees from its public list every six hours. A pair's round trip on each venue at the reference
// stake, and the cheaper, are read off them (shared/venueCosts.ts); a book older than three minutes is not. Public data
// only: no request here carries a key, and nothing is placed.

const READ_EVERY_MS = 60_000
const FEES_EVERY_MS = 6 * 3600_000
/** The most pairs read a minute: four public requests each. */
export const VENUE_PAIRS_MAX = 12
/** A book older than this is not costed from. */
export const VENUE_BOOK_FRESH_MS = 3 * 60_000

interface HeldBooks {
  at: number
  books: Record<CostedVenue, BookLevels | null>
}

let wanted: string[] = []
/** THE EVENT LANE (V8 Stage 3): coins an announcement or a pasted link names, outside the pairs ranked and traded, whose
 * books are read on demand for a card's cost and gate, at most five at once, and let go when no card wants them. */
export const EVENT_PAIRS_MAX = 5
let eventPairs: string[] = []
const held = new Map<string, HeldBooks>()
let bitgetFees = new Map<string, number>()
let feesAt = 0
let timer: ReturnType<typeof setInterval> | null = null
let reading: Promise<void> | null = null

/** The pairs to read, most wanted first: the forecast's ranking's and the open paper trades'. */
export function setVenuePairs(pairs: readonly string[]): void {
  wanted = [...new Set(pairs.map((pair) => pair.toUpperCase()))].slice(0, VENUE_PAIRS_MAX)
}

async function readFees(nowMs: number): Promise<void> {
  if (nowMs - feesAt < FEES_EVERY_MS && bitgetFees.size > 0) return
  try {
    bitgetFees = await fetchBitgetFeeRates()
    feesAt = nowMs
  } catch (failure) {
    console.warn('Bitget fee rates could not be read; its base tier is used:', failure instanceof Error ? failure.message : failure)
    feesAt = nowMs
  }
}

/** One read: Bitget's fees where due, then each wanted pair's books, one pair at a time. */
async function readOnce(nowMs: number = Date.now()): Promise<void> {
  await readFees(nowMs)
  for (const pair of wanted) {
    const read = await readVenueBooks(pair).catch(() => null)
    if (read === null) continue
    held.set(pair, { at: read.at, books: read.books })
  }
  for (const pair of eventPairs) {
    if (wanted.includes(pair)) continue
    const read = await readVenueBooks(pair).catch(() => null)
    if (read !== null) held.set(pair, { at: read.at, books: read.books })
  }
  // A pair no longer wanted is let go.
  for (const pair of [...held.keys()]) if (!wanted.includes(pair) && !eventPairs.includes(pair)) held.delete(pair)
}

/** The event lane's pairs, most recent first; those past the lane's five are not read. */
export function setEventPairs(pairs: readonly string[]): void {
  eventPairs = [...new Set(pairs.map((pair) => pair.toUpperCase()))].slice(0, EVENT_PAIRS_MAX)
}

/** Reads one event pair's books now, rather than at the next minute's read: a card is weighed within the minute an
 * announcement is seen. True where a book was read. */
export async function readEventBooksNow(pair: string): Promise<boolean> {
  const symbol = pair.toUpperCase()
  if (!eventPairs.includes(symbol) && !wanted.includes(symbol)) return false
  const read = await readVenueBooks(symbol).catch(() => null)
  if (read === null) return false
  held.set(symbol, { at: read.at, books: read.books })
  return true
}

function readNow(): Promise<void> {
  if (reading === null) {
    reading = readOnce().finally(() => {
      reading = null
    })
  }
  return reading
}

/** A pair's round trip on each venue whose book is fresh, at the reference stake on a side, and the cheaper; null where
 * no book is held. */
export function venueCostOf(pair: string, side: 'BUY' | 'SELL', nowMs: number = Date.now(), stakeQuote: number = VENUE_STAKE_QUOTE): { trips: RoundTrip[]; cheapest: RoundTrip | null; at: number } | null {
  const entry = held.get(pair.toUpperCase())
  if (entry === undefined || nowMs - entry.at > VENUE_BOOK_FRESH_MS) return null
  const trips: RoundTrip[] = []
  for (const venue of COSTED_VENUES) {
    const levels = entry.books[venue]
    const bid = levels?.bids[0]?.[0]
    const ask = levels?.asks[0]?.[0]
    if (levels === null || levels === undefined || bid === undefined || ask === undefined) continue
    trips.push(roundTripOf({ venue, feePct: venueFeeOf(venue, venue === 'bitget' ? bitgetFees.get(pair.toUpperCase()) : null), side, stakeQuote, book: { bid, ask }, levels }))
  }
  if (trips.length === 0) return null
  return { trips, cheapest: cheapestOf(trips), at: entry.at }
}

/** A pair's mid on a venue from its book as held, where that book is fresh; null otherwise. */
export function venueMidOf(pair: string, venue: CostedVenue, nowMs: number = Date.now()): number | null {
  const entry = held.get(pair.toUpperCase())
  if (entry === undefined || nowMs - entry.at > VENUE_BOOK_FRESH_MS) return null
  const bid = entry.books[venue]?.bids[0]?.[0]
  const ask = entry.books[venue]?.asks[0]?.[0]
  return bid !== undefined && ask !== undefined && bid > 0 && ask >= bid ? (bid + ask) / 2 : null
}

/** The liquidity gate on a trade (V8 Stage 2; shared/liquidityGate.ts), on a venue's book as held: no book held, a
 * book too old, too thin, or too dear for the move, each said; the round trip where it passes. */
export function venueGateOf(pair: string, venue: CostedVenue, side: 'BUY' | 'SELL', stakeQuote: number, predictedMovePct: number | null, nowMs: number = Date.now()): LiquidityVerdict {
  const entry = held.get(pair.toUpperCase())
  const levels = entry?.books[venue] ?? null
  return liquidityVerdictOf({
    venue,
    feePct: venueFeeOf(venue, venue === 'bitget' ? bitgetFees.get(pair.toUpperCase()) : null),
    side,
    stakeQuote,
    levels,
    bookAgeMs: entry === undefined ? null : Math.max(0, nowMs - entry.at),
    predictedMovePct
  })
}

/** What the service holds, for the status. */
export function venueQuotesState(): { pairs: string[]; events: string[]; held: number; bitgetFees: number; feesAt: number | null } {
  return { pairs: [...wanted], events: [...eventPairs], held: held.size, bitgetFees: bitgetFees.size, feesAt: feesAt === 0 ? null : feesAt }
}

/** Starts the minute's reads. Called once, from electron/main.ts. */
export function startVenueQuotes(): void {
  if (timer !== null) return
  timer = setInterval(() => void readNow().catch(() => undefined), READ_EVERY_MS)
  void readNow().catch(() => undefined)
}

/** Test seams. */
export const venueQuotesForTest = {
  readOnce,
  setFees(rates: Map<string, number>): void {
    bitgetFees = rates
    feesAt = Date.now()
  },
  reset(): void {
    wanted = []
    eventPairs = []
    held.clear()
    bitgetFees = new Map()
    feesAt = 0
    if (timer !== null) clearInterval(timer)
    timer = null
    reading = null
  }
}
