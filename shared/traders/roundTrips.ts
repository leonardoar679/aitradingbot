import { isSpotCoin, type FundingPayment, type TraderFill } from './hyperliquid'

// A TRADER'S ROUND TRIPS (V8 Stage 6, 26 October 2026): from a position's opening to its return to nothing, rebuilt
// from the venue's fills. A fill that adds to a position adds to its trip; one that reduces it closes part of it; one
// that crosses through nothing ("Long > Short") closes the trip and opens the next at the same price, its fee split by
// size. A trip whose opening came before the first fill on file is partial -- its entry is not known -- and left out of
// every figure, counted. Each trip's funding is the payments on its coin between its opening and its close. Spot fills
// are not a perpetual's trips, and are counted apart.

export const ROUND_TRIP_VERSION = 'round-trips-v1'

export interface RoundTrip {
  coin: string
  side: 'long' | 'short'
  openedAtMs: number
  closedAtMs: number
  /** The average price of what opened it, and of what closed it. */
  entryPx: number
  exitPx: number
  /** The largest size it held, and that size at the entry price: what was at stake. */
  maxSize: number
  entryNotional: number
  /** The profit its fills closed, before fees, in USDC. */
  realizedPnl: number
  /** The fees paid (a maker's rebate counted as a negative fee), and the rebates alone, as a positive figure. */
  fees: number
  rebates: number
  /** The funding paid (negative) or received over it. */
  funding: number
  /** realizedPnl - fees + funding. */
  net: number
  /** Its move in its favour from the average entry to the average exit, before fees, in percent: its result at 1x. */
  movePct: number
  fills: number
}

/** A position still open at the end of the record: what of a trip is known so far. */
export interface OpenLeg {
  coin: string
  side: 'long' | 'short'
  openedAtMs: number
  size: number
  entryPx: number
  /** Its opening came before the first fill on file. */
  partial: boolean
}

export interface RoundTrips {
  version: typeof ROUND_TRIP_VERSION
  trips: RoundTrip[]
  open: OpenLeg[]
  /** Trips whose opening came before the record, left out. */
  partial: number
  spotFills: number
}

/** Two sizes the same where they differ by less than a billionth of the larger: the venue's decimals, not a trade. */
const same = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

interface Building {
  coin: string
  side: 'long' | 'short'
  openedAtMs: number
  partial: boolean
  openQty: number
  openNotional: number
  closeQty: number
  closeNotional: number
  maxSize: number
  realizedPnl: number
  fees: number
  rebates: number
  fills: number
  lastMs: number
}

const fresh = (fill: TraderFill, side: 'long' | 'short', partial: boolean): Building => ({
  coin: fill.coin,
  side,
  openedAtMs: fill.timeMs,
  partial,
  openQty: 0,
  openNotional: 0,
  closeQty: 0,
  closeNotional: 0,
  maxSize: 0,
  realizedPnl: 0,
  fees: 0,
  rebates: 0,
  fills: 0,
  lastMs: fill.timeMs
})

const addFee = (trip: Building, fee: number): void => {
  trip.fees += fee
  if (fee < 0) trip.rebates -= fee
}

/** The fills in the order they were made. One order taking several resting ones fills them in the same millisecond, and
 * their trade ids are not in that order: within a millisecond, a coin's fills are chained by the position each started
 * from -- the next is the one that starts where the last left the position -- and where no chain can be found, a buy's
 * fills by the position rising and a sell's by it falling. */
export function orderedFills(fills: readonly TraderFill[]): TraderFill[] {
  const byTime = [...fills].sort((a, b) => a.timeMs - b.timeMs || a.tid - b.tid)
  const out: TraderFill[] = []
  const position = new Map<string, number>()
  let at = 0
  while (at < byTime.length) {
    let end = at
    while (end < byTime.length && byTime[end].timeMs === byTime[at].timeMs) end++
    const run = byTime.slice(at, end)
    at = end
    const coins = [...new Set(run.map((fill) => fill.coin))]
    for (const coin of coins) {
      const left = run.filter((fill) => fill.coin === coin).sort((a, b) => (a.side === 'buy' ? a.startPosition - b.startPosition : b.startPosition - a.startPosition) || a.tid - b.tid)
      let current = position.get(coin)
      while (left.length > 0) {
        const next = current === undefined ? -1 : left.findIndex((fill) => same(fill.startPosition, current as number))
        const [fill] = left.splice(next >= 0 ? next : 0, 1)
        out.push(fill)
        current = fill.startPosition + (fill.side === 'buy' ? fill.sz : -fill.sz)
      }
      position.set(coin, current as number)
    }
  }
  return out
}

/** A trader's round trips from their fills and funding, oldest first by close. */
export function roundTripsOf(fills: readonly TraderFill[], funding: readonly FundingPayment[] = []): RoundTrips {
  const ordered = orderedFills(fills)
  const building = new Map<string, Building>()
  const trips: RoundTrip[] = []
  let partial = 0
  let spotFills = 0
  const finish = (trip: Building, atMs: number): void => {
    building.delete(trip.coin)
    if (trip.partial) {
      partial++
      return
    }
    const entryPx = trip.openNotional / trip.openQty
    const exitPx = trip.closeQty > 0 ? trip.closeNotional / trip.closeQty : entryPx
    trips.push({
      coin: trip.coin,
      side: trip.side,
      openedAtMs: trip.openedAtMs,
      closedAtMs: atMs,
      entryPx,
      exitPx,
      maxSize: trip.maxSize,
      entryNotional: trip.maxSize * entryPx,
      realizedPnl: trip.realizedPnl,
      fees: trip.fees,
      rebates: trip.rebates,
      funding: 0,
      net: trip.realizedPnl - trip.fees,
      movePct: (trip.side === 'long' ? exitPx / entryPx - 1 : 1 - exitPx / entryPx) * 100,
      fills: trip.fills
    })
  }
  for (const fill of ordered) {
    if (isSpotCoin(fill.coin)) {
      spotFills++
      continue
    }
    const qty = fill.side === 'buy' ? fill.sz : -fill.sz
    const before = fill.startPosition
    const after = before + qty
    let trip = building.get(fill.coin)
    if (same(before, 0)) {
      // A new trip; one left open on a record that says the position was flat is not knowable, and is dropped.
      if (trip !== undefined) {
        trip.partial = true
        finish(trip, trip.lastMs)
      }
      trip = fresh(fill, qty > 0 ? 'long' : 'short', false)
      building.set(fill.coin, trip)
      trip.openQty += Math.abs(qty)
      trip.openNotional += Math.abs(qty) * fill.px
      trip.maxSize = Math.max(trip.maxSize, Math.abs(after))
      trip.realizedPnl += fill.closedPnl
      addFee(trip, fill.fee)
      trip.fills++
      trip.lastMs = fill.timeMs
      continue
    }
    // A position the record did not see open: its trip is partial. And one the record says differs from the trip built
    // -- the other side, or another size -- had fills the record lacks: its trip is partial from here.
    if (trip !== undefined && (trip.side === 'long') !== before > 0) {
      trip.partial = true
      finish(trip, trip.lastMs)
      trip = undefined
    }
    if (trip === undefined) {
      trip = fresh(fill, before > 0 ? 'long' : 'short', true)
      building.set(fill.coin, trip)
    } else if (!trip.partial && !same(trip.openQty - trip.closeQty, Math.abs(before))) trip.partial = true
    trip.fills++
    trip.lastMs = fill.timeMs
    if (Math.sign(qty) === Math.sign(before)) {
      trip.openQty += Math.abs(qty)
      trip.openNotional += Math.abs(qty) * fill.px
      trip.maxSize = Math.max(trip.maxSize, Math.abs(after))
      trip.realizedPnl += fill.closedPnl
      addFee(trip, fill.fee)
      continue
    }
    if (same(after, 0) || Math.sign(after) === Math.sign(before)) {
      // Reduced, or closed.
      trip.closeQty += Math.abs(qty)
      trip.closeNotional += Math.abs(qty) * fill.px
      trip.realizedPnl += fill.closedPnl
      addFee(trip, fill.fee)
      if (same(after, 0)) finish(trip, fill.timeMs)
      continue
    }
    // Crossed through nothing: the closing part ends this trip, the rest opens the next at the same price.
    const closing = Math.abs(before)
    const opening = Math.abs(after)
    const share = closing / (closing + opening)
    trip.closeQty += closing
    trip.closeNotional += closing * fill.px
    trip.realizedPnl += fill.closedPnl
    addFee(trip, fill.fee * share)
    finish(trip, fill.timeMs)
    const next = fresh(fill, after > 0 ? 'long' : 'short', false)
    next.openQty = opening
    next.openNotional = opening * fill.px
    next.maxSize = opening
    addFee(next, fill.fee * (1 - share))
    next.fills = 1
    building.set(fill.coin, next)
  }

  // Funding: each payment to the trip of its coin open at its time (a coin's trips never overlap).
  const byCoin = new Map<string, RoundTrip[]>()
  for (const trip of trips) {
    const mine = byCoin.get(trip.coin)
    if (mine === undefined) byCoin.set(trip.coin, [trip])
    else mine.push(trip)
  }
  for (const mine of byCoin.values()) mine.sort((a, b) => a.openedAtMs - b.openedAtMs)
  for (const payment of funding) {
    const mine = byCoin.get(payment.coin)
    if (mine === undefined) continue
    let low = 0
    let high = mine.length - 1
    let at = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (mine[mid].openedAtMs <= payment.timeMs) {
        at = mid
        low = mid + 1
      } else high = mid - 1
    }
    if (at >= 0 && payment.timeMs <= mine[at].closedAtMs) mine[at].funding += payment.usdc
  }
  for (const trip of trips) trip.net = trip.realizedPnl - trip.fees + trip.funding

  const open: OpenLeg[] = [...building.values()].map((trip) => ({
    coin: trip.coin,
    side: trip.side,
    openedAtMs: trip.openedAtMs,
    size: trip.openQty - trip.closeQty,
    entryPx: trip.openQty > 0 ? trip.openNotional / trip.openQty : Number.NaN,
    partial: trip.partial
  }))
  return { version: ROUND_TRIP_VERSION, trips: trips.sort((a, b) => a.closedAtMs - b.closedAtMs), open, partial, spotFills }
}
