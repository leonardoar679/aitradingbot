import { describe, expect, it } from 'vitest'
import {
  FOLLOW_LINES,
  catchUpOf,
  followDecisionsOf,
  followDueOf,
  followFundingOf,
  followGateOf,
  followMaxHoldSec,
  followResultOf,
  followStakeOf,
  followWithLeg,
  leaderEventOfFill,
  okxLeaderEventsOf,
  readLeaderEvent,
  type FollowStamp,
  type LeaderEvent
} from '../shared/traders/follow'
import type { TraderFill } from '../shared/traders/hyperliquid'

// FOLLOWING A TRADER ON PAPER (shared/traders/follow.ts; V8 Stage 8): a leader's every trade an event, acted on once;
// a new position opened after the follow began entered, an add or partial close mirrored in proportion, a close
// closed, a flip closed and entered anew, everything else left alone with why; the gates of an entry; the follow's own
// legs, fees, funding and result; and when it must close.

const T0 = Date.UTC(2026, 9, 27, 0)
const MIN = 60_000
const KEY = 'hyperliquid-0xabc'

const fill = (over: Partial<TraderFill>): TraderFill => ({ coin: 'ETH', timeMs: T0 + MIN, side: 'buy', px: 2000, sz: 1, startPosition: 0, dir: 'Open Long', closedPnl: 0, fee: 0, feeToken: 'USDC', crossed: true, tid: 7, oid: 1, label: 'VERIFIED', ...over })
const event = (before: number, after: number, over: Partial<LeaderEvent> = {}): LeaderEvent => ({ v: 'leader-event-v1', key: `${KEY}:1`, traderKey: KEY, venue: 'hyperliquid', positionId: 'ETH', coin: 'ETH', before, after, px: 2000, timeMs: T0 + 10 * MIN, receivedMs: T0 + 10 * MIN + 2000, via: 'stream', accountValue: 100_000, perp: { venue: 'binance', symbol: 'ETHUSDT' }, ...over })

describe('a leader event', () => {
  it("is a Hyperliquid fill keyed by its trade id, the position before and after it, and read back only in its shape", () => {
    const sold = leaderEventOfFill(fill({ side: 'sell', sz: 0.5, startPosition: 2, tid: 99 }), KEY, T0 + 2 * MIN, 'poll', 5000, { venue: 'binance', symbol: 'ETHUSDT' })
    expect(sold).toMatchObject({ key: `${KEY}:99`, positionId: 'ETH', before: 2, after: 1.5, via: 'poll', accountValue: 5000, receivedMs: T0 + 2 * MIN, perp: { venue: 'binance', symbol: 'ETHUSDT' } })
    expect(readLeaderEvent(JSON.parse(JSON.stringify(sold)))).toEqual(sold)
    expect(readLeaderEvent({ ...sold, v: 'leader-event-v0' })).toBeNull()
    expect(readLeaderEvent({ ...sold, px: 0 })).toBeNull()
    expect(readLeaderEvent({ ...sold, via: 'rumour' })).toBeNull()
    expect(readLeaderEvent({ ...sold, venue: 'binance' })).toBeNull()
    expect(readLeaderEvent({ ...sold, accountValue: 'lots' })).toBeNull()
    expect(readLeaderEvent({ ...sold, perp: null })).not.toBeNull()
    expect(readLeaderEvent({ ...sold, perp: { venue: 'kraken', symbol: 'ETHUSD' } })).toBeNull()
    expect(readLeaderEvent({ ...sold, perp: undefined })).toBeNull()
  })

  it("is read from two reads of an OKX trader's open sub-positions: one opened, resized, or gone", () => {
    const before = new Map([
      ['a', { coin: 'BTC', size: 0.5, px: 100_000, openedMs: T0 }],
      ['b', { coin: 'ETH', size: -2, px: 2000, openedMs: T0 }]
    ])
    const after = new Map([
      ['a', { coin: 'BTC', size: 0.75, px: 101_000, openedMs: T0 }],
      ['c', { coin: 'SOL', size: 10, px: 150, openedMs: T0 + 5 * MIN }]
    ])
    const events = okxLeaderEventsOf('okx-X', before, after, T0 + 6 * MIN, 'poll', (coin) => (coin === 'SOL' ? null : { venue: 'binance', symbol: `${coin}USDT` }))
    expect(events.map((entry) => [entry.key, entry.positionId, entry.before, entry.after, entry.timeMs])).toEqual([
      [`okx-X:a:0.75:${T0 + 6 * MIN}`, 'a', 0.5, 0.75, T0 + 6 * MIN],
      [`okx-X:c:10:${T0 + 5 * MIN}`, 'c', 0, 10, T0 + 5 * MIN],
      [`okx-X:b:0:${T0 + 6 * MIN}`, 'b', -2, 0, T0 + 6 * MIN]
    ])
    expect(events.map((entry) => entry.perp?.symbol ?? null)).toEqual(['BTCUSDT', null, 'ETHUSDT'])
    expect(okxLeaderEventsOf('okx-X', after, after, T0, 'poll', () => null)).toEqual([])
  })
})

describe("the follow's answer", () => {
  const started = T0 + 5 * MIN
  it('enters a new position opened after the follow began, on its side; not one before it, nor one in a snapshot', () => {
    expect(followDecisionsOf(event(0, 1), started, null)).toEqual([{ kind: 'open', positionId: 'ETH', coin: 'ETH', side: 'long' }])
    expect(followDecisionsOf(event(0, -3), started, null)).toEqual([{ kind: 'open', positionId: 'ETH', coin: 'ETH', side: 'short' }])
    expect(followDecisionsOf(event(0, 1, { timeMs: T0 }), started, null)[0]).toMatchObject({ kind: 'ignore', reason: 'a position opened before the follow began' })
    expect(followDecisionsOf(event(0, 1, { via: 'snapshot' }), started, null)[0]).toMatchObject({ kind: 'ignore' })
  })

  it('resizes in the same proportion as the leader, closes when the leader does, and closes and enters anew on a flip', () => {
    const held = { size: 0.2, leaderSize: 2 }
    const added = followDecisionsOf(event(2, 3), started, held)
    expect(added).toMatchObject([{ kind: 'resize', positionId: 'ETH' }])
    expect((added[0] as { targetSize: number }).targetSize).toBeCloseTo(0.3, 12)
    const reduced = followDecisionsOf(event(2, 0.5), started, held)[0] as { targetSize: number }
    expect(reduced.targetSize).toBeCloseTo(0.05, 12)
    expect(followDecisionsOf(event(2, 0), started, held)).toEqual([{ kind: 'close', positionId: 'ETH', reason: 'leader closed' }])
    expect(followDecisionsOf(event(2, -1), started, held)).toEqual([
      { kind: 'close', positionId: 'ETH', reason: 'leader flipped' },
      { kind: 'open', positionId: 'ETH', coin: 'ETH', side: 'short' }
    ])
  })

  it('leaves alone a position it never entered -- until it flips into a new one -- and a trade that changes nothing', () => {
    expect(followDecisionsOf(event(2, 3), started, null)[0]).toMatchObject({ kind: 'ignore', reason: 'a position the follow did not enter' })
    expect(followDecisionsOf(event(2, 0), started, null)[0]).toMatchObject({ kind: 'ignore' })
    expect(followDecisionsOf(event(2, -1), started, null)).toEqual([{ kind: 'open', positionId: 'ETH', coin: 'ETH', side: 'short' }])
    expect(followDecisionsOf(event(0, 0), started, null)[0]).toMatchObject({ kind: 'ignore', reason: 'nothing changed' })
  })
})

describe('the gates of an entry, and its size', () => {
  const at = { event: { px: 2000, timeMs: T0 }, nowMs: T0 + 30_000, venuePx: 2010, openForTrader: 0, opensLastHour: 0 }
  it('refuses one seen too late, a price too far from the leader\'s or not read, and one past a cap', () => {
    expect(followGateOf(at)).toBeNull()
    expect(followGateOf({ ...at, nowMs: T0 + (FOLLOW_LINES.maxEntryLagSec + 1) * 1000 })).toMatchObject({ stage: 'late' })
    expect(followGateOf({ ...at, nowMs: T0 + FOLLOW_LINES.maxEntryLagSec * 1000 })).toBeNull()
    expect(followGateOf({ ...at, venuePx: 2041 })).toMatchObject({ stage: 'gate', reason: "the perpetual's price is 2.05% from the leader's fill, over 2%" })
    expect(followGateOf({ ...at, venuePx: 2040 })).toBeNull()
    expect(followGateOf({ ...at, venuePx: null })).toMatchObject({ stage: 'gate' })
    expect(followGateOf({ ...at, openForTrader: 5 })).toMatchObject({ stage: 'cap', reason: '5 follows of this trader open, its most' })
    expect(followGateOf({ ...at, openForTrader: 4 })).toBeNull()
    expect(followGateOf({ ...at, opensLastHour: 10 })).toMatchObject({ stage: 'cap' })
  })

  it("stakes the leader's share of their account of the book, at most the book's stake; the book's stake where the account is not known", () => {
    expect(followStakeOf({ leaderNotional: 2000, accountValue: 100_000, bookEquity: 10_000, bookStake: 1000 })).toBeCloseTo(200, 9)
    expect(followStakeOf({ leaderNotional: 50_000, accountValue: 100_000, bookEquity: 10_000, bookStake: 1000 })).toBe(1000)
    expect(followStakeOf({ leaderNotional: 50_000, accountValue: null, bookEquity: 10_000, bookStake: 1000 })).toBe(1000)
    expect(followStakeOf({ leaderNotional: 50_000, accountValue: 0, bookEquity: 10_000, bookStake: 1000 })).toBe(1000)
  })
})

describe("the follow's own book", () => {
  const opened: FollowStamp = {
    traderKey: KEY,
    positionId: 'ETH',
    coin: 'ETH',
    venue: 'binance',
    symbol: 'ETHUSDT',
    side: 'long',
    leaderSize: 2,
    size: 0,
    avgPx: 0,
    maxStakeQuote: 0,
    legs: [],
    realizedQuote: 0,
    feesQuote: 0,
    openedOnKey: `${KEY}:1`,
    openedAtMs: T0,
    delaySec: 3,
    maxHoldSec: 3600,
    closeReason: null
  }

  it('averages its adds, realizes what a reduction closes, pays the taker fee each way, and reads its result', () => {
    let stamp = followWithLeg(opened, { qty: 1, px: 100, atMs: T0, eventKey: 'e1' }, 0.05)
    stamp = followWithLeg(stamp, { qty: 1, px: 110, atMs: T0 + MIN, eventKey: 'e2' }, 0.05)
    expect(stamp).toMatchObject({ size: 2, avgPx: 105, maxStakeQuote: 210 })
    stamp = followWithLeg(stamp, { qty: -0.5, px: 120, atMs: T0 + 2 * MIN, eventKey: 'e3' }, 0.05)
    expect(stamp.size).toBe(1.5)
    expect(stamp.realizedQuote).toBeCloseTo(7.5, 12)
    // A sell larger than what is held closes what is held.
    stamp = followWithLeg(stamp, { qty: -5, px: 100, atMs: T0 + 3 * MIN, eventKey: 'e4' }, 0.05)
    expect(stamp.size).toBe(0)
    expect(stamp.realizedQuote).toBeCloseTo(7.5 - 7.5, 12)
    expect(stamp.legs.map((leg) => leg.qty)).toEqual([1, 1, -0.5, -1.5])
    expect(stamp.feesQuote).toBeCloseTo(0.0005 * (100 + 110 + 60 + 150), 12)
    const result = followResultOf(stamp, -0.2, 1_793_000_000)
    expect(result.netQuote).toBeCloseTo(-0.21 - 0.2, 12)
    expect(result.netPct).toBeCloseTo((-0.41 / 210) * 100, 9)
    expect(result).toMatchObject({ fundingQuote: -0.2, closedAt: 1_793_000_000 })
    // A short gains as the price falls.
    const short = followWithLeg(followWithLeg({ ...opened, side: 'short' }, { qty: -2, px: 50, atMs: T0, eventKey: 's1' }, 0), { qty: 2, px: 40, atMs: T0 + MIN, eventKey: 's2' }, 0)
    expect(short.realizedQuote).toBeCloseTo(20, 12)
    // Its stake is the most it has had at stake: an add after a reduction stakes no more than it once did.
    const readded = followWithLeg(followWithLeg(followWithLeg(opened, { qty: 2, px: 100, atMs: T0, eventKey: 'm1' }, 0), { qty: -1.5, px: 100, atMs: T0 + MIN, eventKey: 'm2' }, 0), { qty: 0.5, px: 100, atMs: T0 + 2 * MIN, eventKey: 'm3' }, 0)
    expect(readded).toMatchObject({ size: 1, maxStakeQuote: 200 })
  })

  it('pays the funding the perpetual published at each funding time it was open through, on its size then', () => {
    let stamp = followWithLeg(opened, { qty: 1, px: 100, atMs: T0, eventKey: 'e1' }, 0)
    stamp = followWithLeg(stamp, { qty: 1, px: 100, atMs: T0 + 8 * 3_600_000 + MIN, eventKey: 'e2' }, 0)
    const rates = [0, 8, 16, 24].map((hours) => ({ timeSec: (T0 + hours * 3_600_000) / 1000, rate: 0.001 }))
    // At 08:00 one unit is held, at 16:00 two; the 00:00 rate is the opening's own moment, and 24:00 is past the close.
    expect(followFundingOf(stamp, rates, T0 + 20 * 3_600_000)).toBeCloseTo(-(0.1 + 0.2), 12)
    expect(followFundingOf({ ...stamp, side: 'short', legs: stamp.legs.map((leg) => ({ ...leg, qty: -leg.qty })) }, rates, T0 + 20 * 3_600_000)).toBeCloseTo(0.3, 12)
    expect(followFundingOf(opened, rates, T0 + 20 * 3_600_000)).toBe(0)
    // A reduction before a funding time lowers what the rate is charged on, at the average price: 3 at 110 held, half
    // of it sold, 165 charged.
    let cut = followWithLeg(opened, { qty: 2, px: 100, atMs: T0, eventKey: 'r1' }, 0)
    cut = followWithLeg(cut, { qty: 1, px: 130, atMs: T0 + MIN, eventKey: 'r2' }, 0)
    cut = followWithLeg(cut, { qty: -1.5, px: 120, atMs: T0 + 2 * MIN, eventKey: 'r3' }, 0)
    expect(followFundingOf(cut, [{ timeSec: (T0 + 8 * 3_600_000) / 1000, rate: 0.001 }], T0 + 9 * 3_600_000)).toBeCloseTo(-0.165, 12)
  })

  it('closes by time at the leader\'s longest hold, at most seven days, and at the loss of its whole stake', () => {
    const open = { side: 'short' as const, avgPx: 100, openedAtMs: T0, maxHoldSec: 3600, size: 1 }
    expect(followDueOf(open, 150, T0 + MIN)).toBeNull()
    expect(followDueOf(open, 200, T0 + MIN)).toBe('loss cap')
    expect(followDueOf(open, 150, T0 + 3600 * 1000)).toBe('time')
    expect(followDueOf({ ...open, side: 'long' }, 1, T0 + MIN)).toBeNull()
    expect(followMaxHoldSec(90)).toBe(5400)
    expect(followMaxHoldSec(30 * 24 * 60)).toBe(7 * 86_400)
    expect(followMaxHoldSec(null)).toBe(7 * 86_400)
    expect(followMaxHoldSec(0)).toBe(7 * 86_400)
  })
})

describe('what the window reads back at its start', () => {
  it('is every event but one a miss was written on, and only the clone signals still young enough to enter', () => {
    const events = [{ key: 'e1' }, { key: 'e2' }, { key: 'e3' }]
    const signals = [
      { key: 's1', receivedMs: T0 - 60_000 },
      { key: 's2', receivedMs: T0 - (FOLLOW_LINES.maxEntryLagSec + 1) * 1000 },
      { key: 's3', receivedMs: T0 - 10_000 }
    ]
    expect(catchUpOf({ events, signals }, new Set(['e2', 's3']), T0)).toEqual({ events: [{ key: 'e1' }, { key: 'e3' }], signals: [signals[0]] })
    expect(catchUpOf({ events, signals: [{ key: 's4', receivedMs: T0 - FOLLOW_LINES.maxEntryLagSec * 1000 }] }, new Set(), T0).signals).toHaveLength(1)
  })
})
