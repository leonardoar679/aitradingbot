import type { FundingRate } from './delay'
import type { TraderFill } from './hyperliquid'

// FOLLOWING A TRADER ON PAPER (V8 Stage 8, 27 October 2026). A followed trader's every trade reaches the app as a
// leader event -- written to traders/<key>/events-YYYY-MM.jsonl before anything acts on it, its key the venue's own id
// so that it is acted on once -- and each event is turned here into what the follow does: a leader's new position,
// opened after the follow began and not part of the first snapshot, is entered on the same perpetual at 1x; an add or a
// partial close resizes the follow in the same proportion; a close closes it, and a flip closes it and enters the new
// side. Everything else is left alone, with why. The follow's own book is kept here too: its legs at the perpetual's
// prices, the taker fee each way, the funding the perpetual published over its hold, and its result once closed. Pure:
// the main process reads the leader (electron/services/followService.ts), the writer acts (src/traders/paperFollow.ts).

export const FOLLOW_VERSION = 'trader-follow-v1'

export const FOLLOW_LINES = {
  version: FOLLOW_VERSION,
  /** Follows open at once for one trader; the copy book's own cap (its setting, 15) holds for all of them. */
  maxOpenPerTrader: 5,
  /** Follows and clones opened in any hour, across the copy book. */
  maxOpensPerHour: 10,
  /** The perpetual's price may be at most this far from the leader's fill, in percent, for a follow to enter. */
  priceAgreePct: 2,
  /** A leader's fill the follow meets later than this is not entered: too late to call it the same trade. */
  maxEntryLagSec: 120,
  /** A follow is closed by time at the leader's longest hold, at most this. */
  maxHoldDays: 7,
  /** Reads of the leader missed in a row before the follow closes as "leader lost". */
  missedReads: 2,
  /** Hyperliquid's stream for at most this many addresses, a ping each `pingSec`; the others read each `pollSec`. */
  maxStreams: 5,
  pingSec: 50,
  pollSec: 60
} as const

/** A followed trader's reading, as the page shows it. */
export interface FollowStatus {
  key: string
  venue: 'hyperliquid' | 'okx'
  /** Read by the stream, or once a minute. */
  mode: 'stream' | 'poll'
  since: number
  lastReadMs: number | null
  missedReads: number
  /** Two reads missed in a row: the follow closes. */
  lost: boolean
  /** An OKX trader who hides their positions: nothing to follow. */
  hidden: boolean
  eventsToday: number
}

/** A clone's rule holding on a coin at a 15-minute close. */
export interface CloneSignal {
  v: 'clone-signal-v1'
  key: string
  traderKey: string
  coin: string
  venue: 'binance' | 'bitget'
  symbol: string
  side: 'long' | 'short'
  holdBars: number
  /** The close the rule was read at, and the time of that close, in seconds. */
  px: number
  barCloseSec: number
  receivedMs: number
}

/** One trade of a followed trader's, as the app read it. */
export interface LeaderEvent {
  v: 'leader-event-v1'
  /** The venue's own id for it, the trader's key before it: acted on once. */
  key: string
  traderKey: string
  venue: 'hyperliquid' | 'okx'
  /** The position the trade changed: a Hyperliquid coin's one position, an OKX sub-position. */
  positionId: string
  coin: string
  /** The leader's position before and after, signed (long positive), in the coin. */
  before: number
  after: number
  px: number
  /** When the leader traded, and when the app read it, in milliseconds. */
  timeMs: number
  receivedMs: number
  /** From the stream, a poll, or the stream's first snapshot (which never opens a follow). */
  via: 'stream' | 'poll' | 'snapshot'
  /** The leader's account value where the venue gives it: what the follow's size is read against. */
  accountValue: number | null
  /** The perpetual the follow would trade, Binance's first; null where neither venue lists one. */
  perp: { venue: 'binance' | 'bitget'; symbol: string } | null
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** A Hyperliquid fill as a leader event. */
export function leaderEventOfFill(fill: TraderFill, traderKey: string, receivedMs: number, via: LeaderEvent['via'], accountValue: number | null, perp: LeaderEvent['perp']): LeaderEvent {
  return {
    v: 'leader-event-v1',
    key: `${traderKey}:${fill.tid}`,
    traderKey,
    venue: 'hyperliquid',
    positionId: fill.coin,
    coin: fill.coin,
    before: fill.startPosition,
    after: fill.startPosition + (fill.side === 'buy' ? fill.sz : -fill.sz),
    px: fill.px,
    timeMs: fill.timeMs,
    receivedMs,
    via,
    accountValue,
    perp
  }
}

/** A kept event read back; null for one out of its shape. */
export function readLeaderEvent(value: unknown): LeaderEvent | null {
  const event = value as Partial<LeaderEvent> | null
  if (event === null || typeof event !== 'object' || event.v !== 'leader-event-v1') return null
  if (typeof event.key !== 'string' || typeof event.traderKey !== 'string' || typeof event.positionId !== 'string' || typeof event.coin !== 'string') return null
  if (event.venue !== 'hyperliquid' && event.venue !== 'okx') return null
  if (event.via !== 'stream' && event.via !== 'poll' && event.via !== 'snapshot') return null
  if (!finite(event.before) || !finite(event.after) || !finite(event.px) || !(event.px > 0) || !finite(event.timeMs) || !finite(event.receivedMs)) return null
  if (event.accountValue !== null && !finite(event.accountValue)) return null
  const perp = event.perp as { venue?: unknown; symbol?: unknown } | null | undefined
  if (perp !== null && (typeof perp !== 'object' || (perp.venue !== 'binance' && perp.venue !== 'bitget') || typeof perp.symbol !== 'string')) return null
  return event as LeaderEvent
}

/** An OKX sub-position as the app last saw it open. */
export interface OkxSeen {
  coin: string
  /** Signed: long positive, in the coin. */
  size: number
  px: number
  openedMs: number
}

/** The events between two reads of an OKX trader's open sub-positions: one opened, resized or gone. A sub-position gone
 * is closed at the last price the app saw for it, as OKX's public read gives no close until its history does. */
export function okxLeaderEventsOf(traderKey: string, previous: ReadonlyMap<string, OkxSeen>, current: ReadonlyMap<string, OkxSeen>, receivedMs: number, via: LeaderEvent['via'], perpOf: (coin: string) => LeaderEvent['perp']): LeaderEvent[] {
  const out: LeaderEvent[] = []
  const event = (positionId: string, coin: string, before: number, after: number, px: number, timeMs: number): LeaderEvent => ({
    v: 'leader-event-v1',
    // The change's own moment with its size: a size the sub-position had before, met again, is a change of its own.
    key: `${traderKey}:${positionId}:${after}:${timeMs}`,
    traderKey,
    venue: 'okx',
    positionId,
    coin,
    before,
    after,
    px,
    timeMs,
    receivedMs,
    via,
    accountValue: null,
    perp: perpOf(coin)
  })
  for (const [id, now] of current) {
    const was = previous.get(id)
    if (was === undefined) out.push(event(id, now.coin, 0, now.size, now.px, now.openedMs))
    else if (was.size !== now.size) out.push(event(id, now.coin, was.size, now.size, now.px, receivedMs))
  }
  for (const [id, was] of previous) if (!current.has(id)) out.push(event(id, was.coin, was.size, 0, was.px, receivedMs))
  return out
}

/** One fill of the follow's own: signed (long positive), at the perpetual's price. */
export interface FollowLeg {
  qty: number
  px: number
  atMs: number
  feeQuote: number
  eventKey: string
}

/** What a follow keeps of itself, on its executor (`follow`). */
export interface FollowStamp {
  traderKey: string
  positionId: string
  coin: string
  /** The perpetual followed on. */
  venue: 'binance' | 'bitget'
  symbol: string
  side: 'long' | 'short'
  /** The leader's size the follow last matched, signed, and the follow's own, unsigned. */
  leaderSize: number
  size: number
  avgPx: number
  /** The most it has had at stake, at its average price: its stake. */
  maxStakeQuote: number
  legs: FollowLeg[]
  realizedQuote: number
  feesQuote: number
  /** The leader's trade it was entered on, how late, and the longest it may stay open. */
  openedOnKey: string
  openedAtMs: number
  delaySec: number
  maxHoldSec: number
  closeReason: FollowCloseReason | null
}

export type FollowCloseReason = 'leader closed' | 'leader flipped' | 'time' | 'loss cap' | 'leader lost' | 'stopped'

/** What one leader event asks of the follow, for the position it changed. */
export type FollowDecision =
  | { kind: 'open'; positionId: string; coin: string; side: 'long' | 'short' }
  | { kind: 'resize'; positionId: string; targetSize: number }
  | { kind: 'close'; positionId: string; reason: 'leader closed' | 'leader flipped' }
  | { kind: 'ignore'; positionId: string; reason: string }

const flat = (size: number): boolean => Math.abs(size) <= 1e-12

/** The follow's answer to a leader event, given the follow it has on that position (if any). */
export function followDecisionsOf(event: LeaderEvent, startedAtMs: number, held: Pick<FollowStamp, 'size' | 'leaderSize'> | null): FollowDecision[] {
  const { positionId, coin, before, after } = event
  const opening = (side: 'long' | 'short'): FollowDecision => {
    if (event.via === 'snapshot') return { kind: 'ignore', positionId, reason: "a position in the stream's first snapshot: the follow enters only trades it sees made" }
    if (event.timeMs < startedAtMs) return { kind: 'ignore', positionId, reason: 'a position opened before the follow began' }
    return { kind: 'open', positionId, coin, side }
  }
  if (flat(before) && flat(after)) return [{ kind: 'ignore', positionId, reason: 'nothing changed' }]
  if (flat(before)) return [opening(after > 0 ? 'long' : 'short')]
  if (held === null) {
    // A position the follow never entered: left alone, until it flips -- a new position made now.
    if (!flat(after) && Math.sign(after) !== Math.sign(before)) return [opening(after > 0 ? 'long' : 'short')]
    return [{ kind: 'ignore', positionId, reason: 'a position the follow did not enter' }]
  }
  if (flat(after)) return [{ kind: 'close', positionId, reason: 'leader closed' }]
  if (Math.sign(after) !== Math.sign(before)) return [{ kind: 'close', positionId, reason: 'leader flipped' }, opening(after > 0 ? 'long' : 'short')]
  // An add or a partial close: the follow's size in the same proportion as the leader's.
  return [{ kind: 'resize', positionId, targetSize: held.size * (Math.abs(after) / Math.abs(before)) }]
}

/** Why a follow may not enter a leader's new position now, or null where it may: too late, a price that disagrees,
 * or a cap. The copy book's own room is the book's (shared/paperBooks.ts bookRoomProblem). */
export function followGateOf(input: {
  event: Pick<LeaderEvent, 'px' | 'timeMs'>
  nowMs: number
  venuePx: number | null
  openForTrader: number
  opensLastHour: number
  lines?: typeof FOLLOW_LINES
}): { stage: 'late' | 'gate' | 'cap'; reason: string } | null {
  const lines = input.lines ?? FOLLOW_LINES
  const lagSec = (input.nowMs - input.event.timeMs) / 1000
  if (lagSec > lines.maxEntryLagSec) return { stage: 'late', reason: `seen ${Math.round(lagSec)} s after the leader traded, past ${lines.maxEntryLagSec} s` }
  if (input.venuePx === null || !(input.venuePx > 0)) return { stage: 'gate', reason: "the perpetual's price could not be read" }
  const apartPct = Math.abs(input.venuePx / input.event.px - 1) * 100
  if (apartPct > lines.priceAgreePct + 1e-9) return { stage: 'gate', reason: `the perpetual's price is ${apartPct.toFixed(2)}% from the leader's fill, over ${lines.priceAgreePct}%` }
  if (input.openForTrader >= lines.maxOpenPerTrader) return { stage: 'cap', reason: `${input.openForTrader} follows of this trader open, its most` }
  if (input.opensLastHour >= lines.maxOpensPerHour) return { stage: 'cap', reason: `${input.opensLastHour} opened in the last hour, the most` }
  return null
}

/** A follow's stake: the leader's share of their account where the venue gives it, of the book's settled equity, at
 * most the book's stake; the book's stake where it does not. */
export function followStakeOf(input: { leaderNotional: number; accountValue: number | null; bookEquity: number; bookStake: number }): number {
  if (input.accountValue === null || !(input.accountValue > 0)) return input.bookStake
  return Math.min(input.bookStake, (input.leaderNotional / input.accountValue) * input.bookEquity)
}

/** A follow's legs applied: a buy or a sell of `qty` (signed, long positive) at `px`, paying the taker fee; what a
 * reduction closes is realized at the average price. */
export function followWithLeg(stamp: FollowStamp, leg: Omit<FollowLeg, 'feeQuote'>, takerFeePct: number): FollowStamp {
  const sign = stamp.side === 'long' ? 1 : -1
  const fee = (qty: number): number => (takerFeePct / 100) * qty * leg.px
  const qty = Math.abs(leg.qty)
  if (Math.sign(leg.qty) === sign) {
    const size = stamp.size + qty
    const avgPx = (stamp.size * stamp.avgPx + qty * leg.px) / size
    return { ...stamp, size, avgPx, maxStakeQuote: Math.max(stamp.maxStakeQuote, size * avgPx), legs: [...stamp.legs, { ...leg, feeQuote: fee(qty) }], feesQuote: stamp.feesQuote + fee(qty) }
  }
  // A reduction closes at most what is held, and pays its fee on that.
  const closing = Math.min(qty, stamp.size)
  const feeQuote = fee(closing)
  return {
    ...stamp,
    size: stamp.size - closing,
    realizedQuote: stamp.realizedQuote + sign * (leg.px - stamp.avgPx) * closing,
    legs: [...stamp.legs, { ...leg, qty: sign * -closing, feeQuote }],
    feesQuote: stamp.feesQuote + feeQuote
  }
}

/** The funding a follow paid (negative) or was paid over its hold, at the rates the perpetual published: at each
 * funding time, its size then at its average price then, a long paying a positive rate. */
export function followFundingOf(stamp: Pick<FollowStamp, 'side' | 'legs'>, rates: readonly FundingRate[], untilMs: number): number {
  const sign = stamp.side === 'long' ? 1 : -1
  const legs = [...stamp.legs].sort((a, b) => a.atMs - b.atMs)
  let funding = 0
  for (const rate of rates) {
    const atMs = rate.timeSec * 1000
    // A funding time before its first leg, or at it, finds nothing held.
    if (atMs > untilMs) continue
    let size = 0
    let cost = 0
    for (const leg of legs) {
      if (leg.atMs >= atMs) break
      const qty = Math.abs(leg.qty)
      if (Math.sign(leg.qty) === sign) {
        cost += qty * leg.px
        size += qty
      } else {
        const closing = Math.min(qty, size)
        cost -= size > 0 ? (cost / size) * closing : 0
        size -= closing
      }
    }
    funding -= sign * rate.rate * cost
  }
  return funding
}

/** A closed follow's result, for its book: net in the quote and in percent of its stake, after fees and funding. */
export function followResultOf(stamp: Pick<FollowStamp, 'realizedQuote' | 'feesQuote' | 'maxStakeQuote'>, fundingQuote: number, closedAt: number): { netQuote: number; netPct: number; feesQuote: number; fundingQuote: number; closedAt: number } {
  const netQuote = stamp.realizedQuote - stamp.feesQuote + fundingQuote
  return { netQuote, netPct: stamp.maxStakeQuote > 0 ? (netQuote / stamp.maxStakeQuote) * 100 : 0, feesQuote: stamp.feesQuote, fundingQuote, closedAt }
}

/** Why an open follow must close now, if it must: its time, or a loss of its whole stake. */
export function followDueOf(stamp: Pick<FollowStamp, 'side' | 'avgPx' | 'openedAtMs' | 'maxHoldSec' | 'size'>, px: number | null, nowMs: number): FollowCloseReason | null {
  if (nowMs - stamp.openedAtMs >= stamp.maxHoldSec * 1000) return 'time'
  if (px !== null && px > 0 && stamp.size > 0 && (stamp.side === 'long' ? px / stamp.avgPx - 1 : 1 - px / stamp.avgPx) <= -1) return 'loss cap'
  return null
}

/** The longest a follow may stay open: the leader's longest hold, at most the lines' days. */
export function followMaxHoldSec(leaderLongestHoldMin: number | null, lines: typeof FOLLOW_LINES = FOLLOW_LINES): number {
  const most = lines.maxHoldDays * 86_400
  return leaderLongestHoldMin === null || !(leaderLongestHoldMin > 0) ? most : Math.min(most, Math.ceil(leaderLongestHoldMin * 60))
}
