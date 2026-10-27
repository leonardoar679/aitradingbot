import { describe, expect, it } from 'vitest'
import type { AppSettings, ExecutorConfig } from '../shared/ipc'
import type { MissRecord } from '../shared/misses'
import { DEFAULT_PAPER_BOOKS, type BookStanding } from '../shared/paperBooks'
import type { FundingRate } from '../shared/traders/delay'
import type { FollowStamp, LeaderEvent } from '../shared/traders/follow'
import { archiveSettled, closeFollows, followEvent, followExecutors, settleFollows, type FollowDeps } from '../src/traders/paperFollow'

// FOLLOWING A TRADER ON PAPER, THE WRITING HALF (src/traders/paperFollow.ts; V8 Stage 8): each leader event acted on
// once -- a new position entered in the copy book at the leader's share of their account, an add or a partial close
// mirrored, a close or a flip closed -- each entry the gates refuse written as a miss with why; and each follow closed
// at its time, at the loss of its stake, when its leader is lost, when it is switched off, or given its result when
// stopped elsewhere; the settled moved to the books' archive a day on.

const KEY = 'hyperliquid-0x0b4b6beaca45fce66ca818fbd867ec3761ed2143'
const T0 = Date.UTC(2026, 9, 27, 12)
const STARTED = Math.floor(T0 / 1000) - 3600

function harness(over: { running?: boolean; price?: number | null; standing?: Partial<BookStanding> | null; follows?: AppSettings['copyTrading'] } = {}) {
  const settings: Pick<AppSettings, 'executors' | 'paperBooks' | 'copyTrading'> = {
    executors: [],
    paperBooks: { ...DEFAULT_PAPER_BOOKS, running: over.running ?? true, startedAt: STARTED },
    copyTrading: over.follows ?? { follows: { [KEY]: { since: T0 - 60_000, maxHoldSec: 3600 } }, clones: {} }
  }
  const misses: MissRecord[] = []
  const archived: ExecutorConfig[] = []
  const state = { now: T0, price: over.price === undefined ? 2000 : over.price, rates: [] as FundingRate[], id: 0, book: null as { bids: [number, number][]; asks: [number, number][]; atMs: number } | null }
  const standing: BookStanding | null =
    over.standing === null ? null : { id: 'copy', startQuote: 10_000, realizedQuote: 0, unrealizedQuote: 0, settledEquity: 10_000, equity: 10_000, open: 0, openStakeQuote: 0, closed: 0, dayStartEquity: null, ...over.standing }
  const deps: FollowDeps = {
    getSettings: async () => settings,
    setExecutors: async (executors) => {
      settings.executors = executors
    },
    queue: (work) => work(),
    copyStanding: async () => standing,
    perpPrice: async () => {
      if (state.price === null) throw new Error('no price')
      return state.price
    },
    perpFunding: async () => state.rates,
    // A deep book at the price: the liquidity gate passes unless a test thins it.
    perpBook: async () => {
      const px = state.price ?? 2000
      return state.book ?? { bids: [[px * 0.9999, 1000]], asks: [[px * 1.0001, 1000]], atMs: state.now }
    },
    miss: async (miss) => void misses.push(miss),
    archive: async (executors) => {
      archived.push(...executors)
      return executors.length
    },
    nowMs: () => state.now,
    newId: () => `f${++state.id}`
  }
  return { settings, misses, archived, state, deps }
}

const event = (before: number, after: number, over: Partial<LeaderEvent> = {}): LeaderEvent => ({
  v: 'leader-event-v1',
  key: `${KEY}:${before}:${after}`,
  traderKey: KEY,
  venue: 'hyperliquid',
  positionId: 'ETH',
  coin: 'ETH',
  before,
  after,
  px: 2000,
  timeMs: T0 - 3000,
  receivedMs: T0 - 1000,
  via: 'stream',
  accountValue: 100_000,
  perp: { venue: 'binance', symbol: 'ETHUSDT' },
  ...over
})

const stampOf = (executors: readonly ExecutorConfig[]): FollowStamp => followExecutors(executors)[0].follow as FollowStamp

describe('a leader event', () => {
  it("enters a new position in the copy book, at the leader's share of their account, once", async () => {
    const { settings, deps } = harness()
    expect(await followEvent(event(0, 2), deps)).toBe('entered long 0.2 ETH at 2000')
    const [executor] = settings.executors
    // 2 ETH at 2,000 of a 100,000 account is 4%: 4% of the book's 10,000, under its 1,000 stake.
    expect(executor).toMatchObject({ type: 'position', mode: 'paper', exchange: 'binance', symbol: 'ETHUSDT', status: 'active', book: { id: 'copy', startedAt: STARTED, ledger: 'follow' } })
    expect(executor.params).toMatchObject({ side: 'buy', entryPrice: 2000, amountQuote: 400, timeLimitSec: 3600, feeRate: 0.0005 })
    expect(executor.follow).toMatchObject({ traderKey: KEY, positionId: 'ETH', side: 'long', size: 0.2, avgPx: 2000, leaderSize: 2, delaySec: 3, maxHoldSec: 3600, openedOnKey: event(0, 2).key })
    expect(await followEvent(event(0, 2), deps)).toBe('already acted on')
    expect(settings.executors).toHaveLength(1)
  })

  it('mirrors an add and a partial close in proportion, its opening parameters left as they were, and closes when the leader does', async () => {
    const { settings, state, deps } = harness()
    await followEvent(event(0, 2), deps)
    state.price = 2100
    expect(await followEvent(event(2, 3), deps)).toMatch(/^resized to 0\.3/)
    expect(stampOf(settings.executors).size).toBeCloseTo(0.3, 12)
    expect(stampOf(settings.executors).leaderSize).toBe(3)
    expect(stampOf(settings.executors).avgPx).toBeCloseTo((0.2 * 2000 + 0.1 * 2100) / 0.3, 9)
    expect(settings.executors[0].params).toMatchObject({ entryPrice: 2000, amountQuote: 400 })
    state.price = 2200
    await followEvent(event(3, 1.5), deps)
    expect(stampOf(settings.executors).size).toBeCloseTo(0.15, 12)
    expect(stampOf(settings.executors).realizedQuote).toBeCloseTo(0.15 * (2200 - (0.2 * 2000 + 0.1 * 2100) / 0.3), 9)
    state.rates = [{ timeSec: Math.floor(T0 / 1000) + 1, rate: 0.0001 }]
    state.now = T0 + 5000
    expect(await followEvent(event(1.5, 0), deps)).toBe('closed: leader closed')
    const [ended] = settings.executors
    expect(ended).toMatchObject({ status: 'stopped', follow: { size: 0, closeReason: 'leader closed' } })
    const stamp = ended.follow as FollowStamp
    expect(ended.book?.result?.netQuote).toBeCloseTo(stamp.realizedQuote - stamp.feesQuote + (ended.book?.result?.fundingQuote ?? 0), 9)
    expect(ended.book?.result?.fundingQuote).toBeLessThan(0)
  })

  it('acts on each event once: an add handed on twice is mirrored once, and a position opened again is a new follow', async () => {
    const { settings, deps } = harness()
    await followEvent(event(0, 2), deps)
    await followEvent(event(2, 3), deps)
    expect(await followEvent(event(2, 3), deps)).toBe('already acted on')
    expect(stampOf(settings.executors).legs).toHaveLength(2)
    await followEvent(event(3, 0), deps)
    await followEvent(event(0, 1, { key: 'again' }), deps)
    await followEvent(event(1, 2, { key: 'again-add' }), deps)
    expect(settings.executors.map((executor) => [executor.status, executor.follow?.legs.length])).toEqual([
      ['stopped', 3],
      ['active', 2]
    ])
  })

  it("trades at the perpetual's price, not the leader's fill; holds an add to the book's stake; and leaves a change under a cent", async () => {
    const { settings, state, deps } = harness()
    await followEvent(event(0, 2), deps)
    // A change of the leader's that moves the follow by less than a cent is left.
    expect(await followEvent(event(2, 2.0000001), deps)).toBe('nothing to do')
    expect(stampOf(settings.executors).legs).toHaveLength(1)
    // The leader adds tenfold: the follow's 0.2 ETH would be 2 ETH, 4,000, past the book's 1,000 for one trade.
    await followEvent(event(2.0000001, 20), deps)
    expect(stampOf(settings.executors).size).toBeCloseTo(0.5, 12)
    state.price = 2010
    await followEvent(event(20, 0, { px: 1990 }), deps)
    const stamp = settings.executors[0].follow as FollowStamp
    expect(stamp.legs[stamp.legs.length - 1].px).toBe(2010)
  })

  it('writes the settings only when an event changes them', async () => {
    const h = harness()
    let writes = 0
    const write = h.deps.setExecutors
    h.deps.setExecutors = async (executors) => {
      writes++
      await write(executors)
    }
    await followEvent(event(0, 2, { via: 'snapshot' }), h.deps)
    await followEvent(event(0, 2, { timeMs: T0 - 3_600_000, key: 'old' }), h.deps)
    expect(writes).toBe(0)
    await followEvent(event(0, 2), h.deps)
    expect(writes).toBe(1)
  })

  it('closes on a flip and enters the new side', async () => {
    const { settings, deps } = harness()
    await followEvent(event(0, 1), deps)
    expect(await followEvent(event(1, -1), deps)).toMatch(/^closed: leader flipped; entered short/)
    expect(settings.executors.map((executor) => [executor.status, executor.follow?.side])).toEqual([
      ['stopped', 'long'],
      ['active', 'short']
    ])
  })

  it('leaves alone a position in the first snapshot, one opened before the follow, and a trader not followed', async () => {
    const { settings, deps } = harness()
    expect(await followEvent(event(0, 2, { via: 'snapshot' }), deps)).toMatch(/snapshot/)
    expect(await followEvent(event(0, 2, { timeMs: T0 - 3_600_000, key: 'old' }), deps)).toBe('a position opened before the follow began')
    expect(await followEvent(event(0, 2, { traderKey: 'okx-35E22983F436F55B', key: 'other' }), deps)).toBe('not followed')
    expect(settings.executors).toEqual([])
  })
})

describe('an entry the gates refuse', () => {
  it('is written as a miss with its stage: late, a price apart, a cap, no perpetual, no room in the book, a thin book', async () => {
    // A book that cannot hold the stake: the liquidity gate refuses for V8's writers (V8 Stage 9).
    const thin = harness()
    thin.state.book = { bids: [[1999, 0.01]], asks: [[2001, 0.01]], atMs: T0 }
    const cases: [ReturnType<typeof harness>, LeaderEvent, MissRecord['stage'], RegExp][] = [
      [thin, event(0, 2), 'liquidity', /hold/],
      // Followed for an hour, a trade seen 200 s after it was made.
      [harness({ follows: { follows: { [KEY]: { since: T0 - 3_600_000, maxHoldSec: 3600 } }, clones: {} } }), event(0, 2, { timeMs: T0 - 200_000 }), 'late', /seen 200 s after the leader traded, past 120 s/],
      [harness({ price: 2100 }), event(0, 2), 'gate', /5\.00% from the leader's fill/],
      [harness({ price: null }), event(0, 2), 'gate', /price could not be read/],
      [harness(), event(0, 2, { perp: null }), 'gate', /no USDT perpetual/],
      [harness({ running: false }), event(0, 2), 'off', /not running/],
      [harness({ standing: { settledEquity: 10_000, open: 0, equity: 9600 } }), event(0, 2), 'cap', /daily stop/]
    ]
    for (const [{ settings, misses, deps }, leader, stage, reason] of cases) {
      await followEvent(leader, deps)
      expect(settings.executors, String(reason)).toEqual([])
      expect(misses, String(reason)).toHaveLength(1)
      expect(misses[0]).toMatchObject({ v: 'miss-v1', book: 'copy', writer: 'follow', pair: leader.perp?.symbol ?? 'ETHUSDT', side: 'up', stage, shadow: false, eventKey: leader.key })
      expect(misses[0].reason).toMatch(reason)
    }
  })

  it("holds five follows of one trader open, and ten opened in the hour across the book", async () => {
    const { settings, misses, deps } = harness()
    for (let k = 0; k < 6; k++) await followEvent(event(0, 1, { positionId: `C${k}`, coin: 'ETH', key: `k${k}` }), deps)
    expect(followExecutors(settings.executors)).toHaveLength(5)
    expect(misses.map((miss) => [miss.stage, miss.reason])).toEqual([['cap', '5 follows of this trader open, its most']])
    // Another trader's five open do not count against this one's.
    const OTHER = 'okx-35E22983F436F55B'
    const two = harness({ follows: { follows: { [KEY]: { since: T0 - 60_000, maxHoldSec: 3600 }, [OTHER]: { since: T0 - 60_000, maxHoldSec: 3600 } }, clones: {} } })
    for (let k = 0; k < 5; k++) await followEvent(event(0, 1, { traderKey: OTHER, venue: 'okx', positionId: `O${k}`, key: `o${k}`, accountValue: null }), two.deps)
    expect(await followEvent(event(0, 1), two.deps)).toMatch(/^entered/)
    expect(two.misses).toEqual([])
  })

  it('counts against the hour only what the copy book opened in the last hour', async () => {
    const settled = (k: number, agoSec: number): ExecutorConfig =>
      ({
        id: `old${k}`,
        type: 'position',
        mode: 'paper',
        status: 'stopped',
        createdAt: Math.floor(T0 / 1000) - agoSec,
        params: {},
        book: { id: 'copy', startedAt: STARTED, ledger: 'clone', result: { netQuote: 0, netPct: 0, feesQuote: 0, fundingQuote: 0, closedAt: Math.floor(T0 / 1000) - 60 } }
      }) as unknown as ExecutorConfig
    const earlier = harness()
    earlier.settings.executors = Array.from({ length: 10 }, (_, k) => settled(k, 7200))
    expect(await followEvent(event(0, 2), earlier.deps)).toMatch(/^entered/)
    const busy = harness()
    busy.settings.executors = Array.from({ length: 10 }, (_, k) => settled(k, 600))
    await followEvent(event(0, 2), busy.deps)
    expect(busy.misses.map((miss) => [miss.stage, miss.reason])).toEqual([['cap', '10 opened in the last hour, the most']])
  })
})

describe('an open follow', () => {
  it('closes at its time, at the loss of its stake, when its leader is lost, and when it is no longer followed', async () => {
    const run = async (setup: (h: ReturnType<typeof harness>) => void, statuses: Parameters<typeof settleFollows>[0] = []): Promise<FollowStamp> => {
      const h = harness()
      await followEvent(event(0, -2), h.deps)
      setup(h)
      await settleFollows(statuses, h.deps)
      return h.settings.executors[0].follow as FollowStamp
    }
    expect((await run((h) => (h.state.now = T0 + 3600_000))).closeReason).toBe('time')
    expect((await run((h) => (h.state.price = 4000))).closeReason).toBe('loss cap')
    expect((await run(() => undefined, [{ key: KEY, venue: 'hyperliquid', mode: 'stream', since: 0, lastReadMs: null, missedReads: 2, lost: true, hidden: false, eventsToday: 0 }])).closeReason).toBe('leader lost')
    expect((await run((h) => (h.settings.copyTrading = { follows: {}, clones: {} }))).closeReason).toBe('stopped')
    expect((await run(() => undefined)).closeReason).toBeNull()
  })

  it('charges the assumed funding against it where no rate could be read', async () => {
    const { settings, state, deps } = harness()
    await followEvent(event(0, 2), deps)
    deps.perpFunding = async () => {
      throw new Error('no rates')
    }
    // From 12:00 to 21:00 UTC: one funding time, 16:00, crossed, at 0.01% of its 400 against it.
    state.now = T0 + 9 * 3_600_000
    await followEvent(event(2, 0), deps)
    expect(settings.executors[0].book?.result?.fundingQuote).toBeCloseTo(-0.04, 12)
  })

  it('is closed once, though two settlements run at once', async () => {
    const h = harness()
    let chain: Promise<unknown> = Promise.resolve()
    h.deps.queue = <T>(work: () => Promise<T>): Promise<T> => {
      const run = chain.then(work)
      chain = run.catch(() => undefined)
      return run
    }
    await followEvent(event(0, 2), h.deps)
    h.state.now = T0 + 3_600_000
    const [first, second] = await Promise.all([settleFollows([], h.deps), settleFollows([], h.deps)])
    expect([...first, ...second]).toHaveLength(1)
  })

  it('is closed at the price then when paper testing is stopped, once, and none whose price cannot be read (V8 Stage 9)', async () => {
    const h = harness()
    let chain: Promise<unknown> = Promise.resolve()
    h.deps.queue = <T>(work: () => Promise<T>): Promise<T> => {
      const run = chain.then(work)
      chain = run.catch(() => undefined)
      return run
    }
    await followEvent(event(0, 2), h.deps)
    await followEvent(event(0, 1, { key: 'btc', positionId: 'BTC', coin: 'BTC', perp: { venue: 'binance', symbol: 'BTCUSDT' } }), h.deps)
    await followEvent(event(1, 0, { key: 'btc-closed', positionId: 'BTC', coin: 'BTC', perp: { venue: 'binance', symbol: 'BTCUSDT' } }), h.deps)
    h.state.price = null
    expect(await closeFollows(h.deps)).toEqual([])
    h.state.price = 1900
    const [first, second] = await Promise.all([closeFollows(h.deps), closeFollows(h.deps)])
    expect([...first, ...second]).toHaveLength(1)
    const ended = followExecutors(h.settings.executors).find((executor) => executor.follow?.positionId === 'ETH')
    expect(ended).toMatchObject({ status: 'stopped', follow: { closeReason: 'stopped', size: 0 } })
    expect(ended?.book?.result?.netQuote).toBeLessThan(0)
    // The one the leader closed keeps its own reason.
    expect(followExecutors(h.settings.executors).find((executor) => executor.follow?.positionId === 'BTC')?.follow?.closeReason).toBe('leader closed')
  })

  it('stopped elsewhere -- the Executors page -- is given its result, at the price then', async () => {
    const { settings, deps } = harness()
    await followEvent(event(0, 2), deps)
    settings.executors = settings.executors.map((executor) => ({ ...executor, status: 'stopped' as const, stoppedAt: Math.floor(T0 / 1000) }))
    await settleFollows([], deps)
    expect(settings.executors[0]).toMatchObject({ status: 'stopped', follow: { closeReason: 'stopped', size: 0 } })
    expect(settings.executors[0].book?.result).toBeDefined()
  })

  it('settled a day ago, moves to the books\' archive, in one write', async () => {
    const { settings, archived, state, deps } = harness()
    await followEvent(event(0, 1), deps)
    await followEvent(event(1, 0), deps)
    await followEvent(event(0, 1, { key: 'second' }), deps)
    expect(await archiveSettled(deps)).toBe(0)
    state.now = T0 + 86_400_000 + 1000
    expect(await archiveSettled(deps)).toBe(1)
    expect(archived.map((executor) => executor.follow?.closeReason)).toEqual(['leader closed'])
    expect(settings.executors.map((executor) => executor.status)).toEqual(['active'])
    // The minute's settlement moves it there itself.
    const later = harness()
    await followEvent(event(0, 1), later.deps)
    await followEvent(event(1, 0), later.deps)
    later.state.now = T0 + 86_400_000 + 1000
    await settleFollows([], later.deps)
    expect(later.archived).toHaveLength(1)
    expect(later.settings.executors).toEqual([])
  })
})
