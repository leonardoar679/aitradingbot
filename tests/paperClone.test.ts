import { describe, expect, it } from 'vitest'
import type { AppSettings, ExecutorConfig } from '../shared/ipc'
import type { MissRecord } from '../shared/misses'
import { DEFAULT_PAPER_BOOKS, type BookStanding } from '../shared/paperBooks'
import type { CloneTradeStamp } from '../shared/traders/copyTrading'
import type { FundingRate } from '../shared/traders/delay'
import type { CloneSignal } from '../shared/traders/follow'
import { cloneExecutors, cloneSignal, closeClones, settleClones, type CloneDeps } from '../src/traders/paperClone'

// A TRADER'S CLONE ON PAPER (src/traders/paperClone.ts; V8 Stage 8): each signal of a running clone entered once, on
// the rule's side, staking the most the copy book lets one trade stake, one trade a coin at a time; an entry refused
// written as a miss with why; each trade closed at the rule's hold, at the loss of its stake, when the clone is switched
// off, or given its result when stopped elsewhere -- the perpetual's prices, the taker fee each way, the funding.

const KEY = 'okx-35E22983F436F55B'
const T0 = Date.UTC(2026, 9, 27, 12, 15, 30)
const STARTED = Math.floor(T0 / 1000) - 3600
const RULE = { side: 'short' as const, holdBars: 8, conditions: [{ feature: 'ret4h' as const, op: '<=' as const, threshold: -0.04 }] }

function harness(over: { running?: boolean; price?: number | null; cloned?: boolean; standing?: null } = {}) {
  const settings: Pick<AppSettings, 'executors' | 'paperBooks' | 'copyTrading'> = {
    executors: [],
    paperBooks: { ...DEFAULT_PAPER_BOOKS, running: over.running ?? true, startedAt: STARTED },
    copyTrading: {
      follows: {},
      clones:
        over.cloned === false
          ? {}
          : {
              [KEY]: {
                since: T0 - 3_600_000,
                rule: RULE,
                coins: [
                  { coin: 'ETH', venue: 'binance', symbol: 'ETHUSDT' },
                  { coin: 'BTC', venue: 'binance', symbol: 'BTCUSDT' }
                ]
              }
            }
    }
  }
  const misses: MissRecord[] = []
  const state = { now: T0, price: over.price === undefined ? 2000 : over.price, rates: [] as FundingRate[], id: 0, book: null as { bids: [number, number][]; asks: [number, number][]; atMs: number } | null }
  const standing: BookStanding = { id: 'copy', startQuote: 10_000, realizedQuote: 0, unrealizedQuote: 0, settledEquity: 10_000, equity: 10_000, open: 0, openStakeQuote: 0, closed: 0, dayStartEquity: null }
  const deps: CloneDeps = {
    getSettings: async () => settings,
    setExecutors: async (executors) => {
      settings.executors = executors
    },
    queue: (work) => work(),
    copyStanding: async () => (over.standing === null ? null : standing),
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
    nowMs: () => state.now,
    newId: () => `c${++state.id}`
  }
  return { settings, misses, state, deps }
}

const signal = (over: Partial<CloneSignal> = {}): CloneSignal => ({
  v: 'clone-signal-v1',
  key: `${KEY}:clone:ETH:1793103300`,
  traderKey: KEY,
  coin: 'ETH',
  venue: 'binance',
  symbol: 'ETHUSDT',
  side: 'short',
  holdBars: 8,
  px: 2001,
  barCloseSec: Math.floor(T0 / 1000) - 30,
  receivedMs: T0 - 10_000,
  ...over
})

const stampOf = (executors: readonly ExecutorConfig[]): CloneTradeStamp => cloneExecutors(executors)[0].clone as CloneTradeStamp

describe("a clone's signal", () => {
  it("is entered once on the rule's side, staking the most the copy book lets one trade stake, held for the rule's hold", async () => {
    const { settings, deps } = harness()
    expect(await cloneSignal(signal(), deps)).toBe('entered short ETH at 2000')
    const [executor] = settings.executors
    expect(executor).toMatchObject({ type: 'position', mode: 'paper', exchange: 'binance', symbol: 'ETHUSDT', status: 'active', book: { id: 'copy', startedAt: STARTED, ledger: 'clone' } })
    expect(executor.params).toMatchObject({ side: 'sell', entryPrice: 2000, amountQuote: 1000, timeLimitSec: 7200, feeRate: 0.0005 })
    expect(stampOf(settings.executors)).toMatchObject({ traderKey: KEY, side: 'short', entryPx: 2000, qty: 0.5, stakeQuote: 1000, holdSec: 7200, feesQuote: 0.5, signalKey: signal().key, closeReason: null })
    expect(await cloneSignal(signal(), deps)).toBe('already acted on')
    // A later close's signal on the same coin, while its trade is open: one trade a coin at a time.
    expect(await cloneSignal(signal({ key: 'next' }), deps)).toBe('a trade of this coin is open')
    expect(settings.executors).toHaveLength(1)
  })

  it("closes the coin's trade of the close before at this close and enters again, as its test trades bar after bar", async () => {
    const { settings, state, deps } = harness()
    await cloneSignal(signal({ holdBars: 1 }), deps)
    // The next close's signal arrives as the first trade's one bar comes due.
    state.now = T0 + 900_000 - 5_000
    expect(await cloneSignal(signal({ key: 'next', holdBars: 1, receivedMs: state.now - 5_000 }), deps)).toBe('closed ETH at its hold; entered short ETH at 2000')
    expect(settings.executors.map((executor) => [executor.status, executor.clone?.closeReason])).toEqual([
      ['stopped', 'time'],
      ['active', null]
    ])
    expect(settings.executors[0].book?.result).toBeDefined()
    // A trade a minute or more from its end still holds its coin.
    expect(await cloneSignal(signal({ key: 'third', receivedMs: state.now - 5_000 }), deps)).toBe('a trade of this coin is open')
    // And where the new one is refused, the one it ended is still written.
    const late = harness()
    await cloneSignal(signal({ holdBars: 1 }), late.deps)
    late.state.now = T0 + 900_000
    expect(await cloneSignal(signal({ key: 'late', holdBars: 1, receivedMs: late.state.now - 200_000 }), late.deps)).toMatch(/^closed ETH at its hold; missed: acted on 200 s/)
    expect(late.settings.executors.map((executor) => executor.status)).toEqual(['stopped'])
  })

  it('is written as a miss where it is late, has no price, or the book has no room; and passed over where the clone is off', async () => {
    const thin = harness()
    thin.state.book = { bids: [[1999, 0.01]], asks: [[2001, 0.01]], atMs: T0 }
    const cases: [ReturnType<typeof harness>, CloneSignal, MissRecord['stage'], RegExp][] = [
      [thin, signal(), 'liquidity', /hold/],
      [harness(), signal({ receivedMs: T0 - 121_000 }), 'late', /121 s after its close was read/],
      [harness({ price: null }), signal(), 'gate', /price could not be read/],
      [harness({ running: false }), signal(), 'off', /not running/],
      [harness({ standing: null }), signal(), 'cap', /standing could not be read/]
    ]
    for (const [{ settings, misses, deps }, entry, stage, reason] of cases) {
      await cloneSignal(entry, deps)
      expect(settings.executors, String(reason)).toEqual([])
      expect(misses[0], String(reason)).toMatchObject({ book: 'copy', writer: 'clone', pair: 'ETHUSDT', side: 'down', stage, eventKey: entry.key })
      expect(misses[0].reason).toMatch(reason)
    }
    const off = harness({ cloned: false })
    expect(await cloneSignal(signal(), off.deps)).toBe('not running')
    expect(off.misses).toEqual([])
  })

  it("is one trade a coin at a time, another coin's open trade no bar, and leaves the follows the hour's last five opens", async () => {
    const { settings, misses, deps } = harness()
    await cloneSignal(signal(), deps)
    expect(await cloneSignal(signal({ key: 'btc', coin: 'BTC', symbol: 'BTCUSDT' }), deps)).toMatch(/^entered short BTC/)
    expect(settings.executors).toHaveLength(2)
    const busy = (opened: number): ReturnType<typeof harness> => {
      const made = harness()
      made.settings.executors = Array.from(
        { length: opened },
        (_, k) => ({ id: `old${k}`, type: 'position', mode: 'paper', status: 'stopped', createdAt: Math.floor(T0 / 1000) - 600, params: {}, book: { id: 'copy', startedAt: STARTED, ledger: 'follow', result: { netQuote: 0, netPct: 0, feesQuote: 0, fundingQuote: 0, closedAt: Math.floor(T0 / 1000) - 60 } } }) as unknown as ExecutorConfig
      )
      return made
    }
    // Of the hour's ten, a clone takes five at most: v9-7d's four clones took every open and every place for three days.
    const five = busy(5)
    await cloneSignal(signal(), five.deps)
    expect(five.misses.map((miss) => [miss.stage, miss.reason])).toEqual([['cap', "5 opened in the last hour; the hour's last 5 are kept for follows"]])
    expect(await cloneSignal(signal(), busy(4).deps)).toMatch(/^entered short ETH/)
    expect(misses).toEqual([])
  })

  it("leaves the follows the copy book's last five places", async () => {
    // Trades of the book open since before the hour, followed and not cloned, so the hour's opens do not count them.
    const full = (open: number): ReturnType<typeof harness> => {
      const made = harness()
      made.settings.paperBooks = { ...made.settings.paperBooks, startedAt: STARTED - 7200 }
      made.settings.executors = Array.from({ length: open }, (_, k) => ({ id: `held${k}`, type: 'position', mode: 'paper', status: 'active', createdAt: STARTED - 3600, params: {}, book: { id: 'copy', startedAt: STARTED - 7200, ledger: 'follow' } }) as unknown as ExecutorConfig)
      return made
    }
    const ten = full(10)
    await cloneSignal(signal(), ten.deps)
    expect(ten.misses.map((miss) => [miss.stage, miss.reason])).toEqual([['cap', 'The copy book has 10 trades open; its last 5 places are kept for follows.']])
    expect(await cloneSignal(signal(), full(9).deps)).toMatch(/^entered short ETH/)
  })
})

describe("a clone's open trade", () => {
  it('closes at its hold, at the perpetual\'s price, after the taker fee each way and the funding over its hold', async () => {
    const { settings, state, deps } = harness()
    await cloneSignal(signal(), deps)
    state.now = T0 + 3_600_000
    await settleClones(deps)
    expect(settings.executors[0].status).toBe('active')
    state.now = T0 + 7_200_000
    state.price = 1900
    state.rates = [{ timeSec: Math.floor(T0 / 1000) + 100, rate: 0.0002 }]
    expect(await settleClones(deps)).toEqual(['Clone · ETH short'])
    const [ended] = settings.executors
    // A short of 0.5 ETH from 2,000 to 1,900: 50 made; 0.05% of 1,000 and of 950 in fees; paid 0.02% of 1,000 (a short
    // is paid a positive rate).
    expect(ended).toMatchObject({ status: 'stopped', clone: { closeReason: 'time' } })
    expect(ended.book?.result?.feesQuote).toBeCloseTo(0.5 + 0.475, 9)
    expect(ended.book?.result?.fundingQuote).toBeCloseTo(0.2, 9)
    expect(ended.book?.result?.netQuote).toBeCloseTo(50 - 0.975 + 0.2, 9)
    expect(ended.book?.result?.netPct).toBeCloseTo(((50 - 0.975 + 0.2) / 1000) * 100, 9)
  })

  it('charges the assumed funding against it where no rate could be read, and is closed once though two settlements run at once', async () => {
    const { settings, state, deps } = harness()
    let chain: Promise<unknown> = Promise.resolve()
    deps.queue = <T>(work: () => Promise<T>): Promise<T> => {
      const run = chain.then(work)
      chain = run.catch(() => undefined)
      return run
    }
    await cloneSignal(signal(), deps)
    deps.perpFunding = async () => {
      throw new Error('no rates')
    }
    // From 12:15 to 14:15 UTC: no funding time crossed; then to 16:15, one: 16:00, at 0.01% of its 1,000 against it.
    state.now = T0 + 4 * 3_600_000
    const [first, second] = await Promise.all([settleClones(deps), settleClones(deps)])
    expect([...first, ...second]).toEqual(['Clone · ETH short'])
    expect(settings.executors[0].book?.result?.fundingQuote).toBeCloseTo(-0.1, 12)
  })

  it('is closed at the price then when paper testing is stopped, once, and not where its price cannot be read (V8 Stage 9)', async () => {
    const { settings, state, deps } = harness()
    let chain: Promise<unknown> = Promise.resolve()
    deps.queue = <T>(work: () => Promise<T>): Promise<T> => {
      const run = chain.then(work)
      chain = run.catch(() => undefined)
      return run
    }
    await cloneSignal(signal(), deps)
    state.price = null
    expect(await closeClones(deps)).toEqual([])
    state.price = 1900
    const [first, second] = await Promise.all([closeClones(deps), closeClones(deps)])
    expect([...first, ...second]).toEqual(['Clone · ETH short'])
    const [ended] = cloneExecutors(settings.executors)
    expect(ended).toMatchObject({ status: 'stopped', clone: { closeReason: 'stopped' } })
    // Short 0.5 ETH from 2,000 to 1,900: 50, less the taker fee each way.
    expect(ended.book?.result?.netQuote).toBeCloseTo(50 - 0.0005 * 1000 - 0.0005 * 950, 9)
    expect(await closeClones(deps)).toEqual([])
  })

  it('closes at the loss of its stake, when its clone is switched off, and is given its result when stopped elsewhere', async () => {
    const lost = harness()
    await cloneSignal(signal(), lost.deps)
    lost.state.price = 4000
    await settleClones(lost.deps)
    expect(lost.settings.executors[0].clone?.closeReason).toBe('loss cap')
    const off = harness()
    await cloneSignal(signal(), off.deps)
    off.settings.copyTrading = { follows: {}, clones: {} }
    await settleClones(off.deps)
    expect(off.settings.executors[0].clone?.closeReason).toBe('stopped')
    const elsewhere = harness()
    await cloneSignal(signal(), elsewhere.deps)
    elsewhere.settings.executors = elsewhere.settings.executors.map((executor) => ({ ...executor, status: 'stopped' as const }))
    await settleClones(elsewhere.deps)
    expect(elsewhere.settings.executors[0]).toMatchObject({ clone: { closeReason: 'stopped' } })
    expect(elsewhere.settings.executors[0].book?.result).toBeDefined()
  })
})
