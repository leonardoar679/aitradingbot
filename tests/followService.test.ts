import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../shared/ipc'
import { DEFAULT_COPY_TRADING, type CopyTradingSettings } from '../shared/traders/copyTrading'
import type { CloneSignal, FollowStatus, LeaderEvent } from '../shared/traders/follow'
import type { TraderAnalysis } from '../shared/traders/traderAnalysis'

// FOLLOWING TRADERS AND RUNNING CLONES ON PAPER, THE READING HALF (electron/services/followService.ts; V8 Stage 8):
// up to five Hyperliquid follows on the stream and the rest read each minute, every OKX one read each minute from a
// first read taken as what the trader held; each event written once and then pushed, a restart pushing none twice; two
// reads missed in a row a lost leader; each clone's rule read at a new 15-minute close; the buttons' rules.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => ({}), setSettings: async () => ({}) }))
vi.mock('../electron/services/traderService', () => ({ listTraders: async () => ({ traders: [], analysed: 0 }) }))
vi.mock('../electron/services/hyperliquidClient', () => ({ hyperliquidInfo: async () => [] }))
vi.mock('../electron/services/okxClient', () => ({ okxGet: async () => [], OKX_PATHS: { current: '/current' } }))
vi.mock('../electron/services/perpMarketService', () => ({ perpBars: async () => [], perpSymbols: async () => new Set() }))

const T0 = Date.UTC(2026, 9, 27, 12, 0, 30)
const address = (k: number): string => `0x${String(k).padStart(40, '0')}`
const keyOf = (k: number): string => `hyperliquid-${address(k)}`
const OKX = 'okx-35E22983F436F55B'

type Handlers = { onFills: (user: string, fills: unknown[], snapshot: boolean) => void; onOpen: () => void; onConnectFailed: (n: number) => void }

let dir = ''
let copy: CopyTradingSettings = DEFAULT_COPY_TRADING
let now = T0
let streams: { users: readonly string[]; handlers: Handlers; stopped: boolean }[] = []
let polls: { user: string; fromMs: number }[] = []
let pollAnswer: (user: string) => unknown = () => []
let okxAnswers: unknown[][] = []
let tick: (() => void) | null = null
let analyses = new Map<string, TraderAnalysis>()
let bars: (venue: string, symbol: string, interval: string, fromSec: number, toSec: number) => Candle[] = () => []

const fill = (tid: number, over: Record<string, unknown> = {}): Record<string, unknown> => ({ coin: 'ETH', px: '2000', sz: '1', side: 'B', time: now - 2000, startPosition: '0', dir: 'Open Long', closedPnl: '0', fee: '0', tid, oid: 1, crossed: true, feeToken: 'USDC', ...over })

async function service() {
  vi.resetModules()
  const module = await import('../electron/services/followService')
  module.resetFollowing()
  Object.assign(module.followSeam, {
    dir: () => dir,
    nowMs: () => now,
    settings: async () => copy,
    saveSettings: async (next: CopyTradingSettings) => {
      copy = next
    },
    fillsSince: async (user: string, fromMs: number) => {
      polls.push({ user, fromMs })
      return pollAnswer(user)
    },
    accountValue: async () => 50_000,
    okxCurrent: async () => {
      const next = okxAnswers.shift()
      if (next === undefined) throw new Error('OKX answered 503')
      return next
    },
    symbols: async (venue: string) => new Set(venue === 'binance' ? ['ETHUSDT', 'BTCUSDT'] : []),
    bars: async (venue: string, symbol: string, interval: string, fromSec: number, toSec: number) => bars(venue, symbol, interval, fromSec, toSec),
    analyses: async () => analyses,
    stream: (users: readonly string[], handlers: Handlers) => {
      const entry = { users, handlers, stopped: false }
      streams.push(entry)
      return () => {
        entry.stopped = true
      }
    },
    setInterval: (run: () => void) => {
      tick = run
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => undefined
  })
  const events: LeaderEvent[] = []
  const signals: CloneSignal[] = []
  const statuses: FollowStatus[][] = []
  module.onLeaderEvent((event) => events.push(event))
  module.onCloneSignal((signal) => signals.push(signal))
  module.onFollowStatus((next) => statuses.push(next))
  return { module, events, signals, statuses }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))
const turn = async (): Promise<void> => {
  tick?.()
  await settle()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'follows-'))
  copy = DEFAULT_COPY_TRADING
  now = T0
  streams = []
  polls = []
  pollAnswer = () => []
  okxAnswers = []
  tick = null
  analyses = new Map()
  bars = () => []
})

describe('the follows read', () => {
  it('streams the first five Hyperliquid follows on one socket and reads the rest each minute', async () => {
    copy = { follows: Object.fromEntries([1, 2, 3, 4, 5, 6].map((k) => [keyOf(k), { since: T0 - k * 1000, maxHoldSec: 3600 }])), clones: {} }
    const { module } = await service()
    await module.startFollowing()
    expect(streams).toHaveLength(1)
    // The longest followed first: since T0-6000 is the oldest, so the sixth address is on the stream, the first is not.
    expect([...streams[0].users].sort()).toEqual([2, 3, 4, 5, 6].map(address).sort())
    expect(module.followStatuses().filter((status) => status.mode === 'poll').map((status) => status.key)).toEqual([keyOf(1)])
    await turn()
    expect(polls.map((entry) => entry.user)).toEqual([address(1)])
    // The same follows read again: the stream is kept, not opened anew.
    await module.syncFollows()
    expect(streams.map((stream) => stream.stopped)).toEqual([false])
  })

  it("reads a polled trader's fills from the last one read, and their account's value each fifteen minutes", async () => {
    copy = { follows: Object.fromEntries([1, 2, 3, 4, 5, 6].map((k) => [keyOf(k), { since: T0 - k * 1000, maxHoldSec: 3600 }])), clones: {} }
    pollAnswer = (user) => (user === address(1) ? [fill(9, { time: T0 + 1000 })] : [])
    let accountReads = 0
    const { module, events } = await service()
    module.followSeam.accountValue = async () => {
      accountReads++
      return 50_000
    }
    await module.startFollowing()
    await turn()
    expect(polls.map((entry) => entry.fromMs)).toEqual([T0 - 1000])
    expect(events.map((event) => [event.key, event.accountValue])).toEqual([[`${keyOf(1)}:9`, 50_000]])
    const afterFirst = accountReads
    now = T0 + 5 * 60_000
    await turn()
    expect(polls.map((entry) => entry.fromMs)).toEqual([T0 - 1000, T0 + 1000])
    expect(accountReads).toBe(afterFirst)
    now = T0 + 16 * 60_000
    await turn()
    expect(accountReads).toBe(afterFirst * 2)
  })

  it("keeps each fill as an event once, a snapshot's as such, and pushes it after it is on file; a restart pushes none twice", async () => {
    copy = { follows: { [keyOf(1)]: { since: T0 - 60_000, maxHoldSec: 3600 } }, clones: {} }
    const first = await service()
    await first.module.startFollowing()
    const { handlers } = streams[0]
    handlers.onOpen()
    handlers.onFills(address(1), [fill(1, { time: T0 - 3_600_000 })], true)
    await settle()
    handlers.onFills(address(1), [fill(2), fill(1, { time: T0 - 3_600_000 })], false)
    await settle()
    expect(first.events.map((event) => [event.key, event.via, event.perp?.symbol])).toEqual([
      [`${keyOf(1)}:1`, 'snapshot', 'ETHUSDT'],
      [`${keyOf(1)}:2`, 'stream', 'ETHUSDT']
    ])
    const kept = readdirSync(join(dir, keyOf(1))).filter((name) => name.startsWith('events-'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dir, keyOf(1), kept[0]), 'utf-8').trim().split('\n')).toHaveLength(2)
    // Two messages of the stream carrying the same fill at once: one event.
    handlers.onFills(address(1), [fill(3)], false)
    handlers.onFills(address(1), [fill(3)], false)
    await settle()
    expect(first.events.map((event) => event.key)).toEqual([`${keyOf(1)}:1`, `${keyOf(1)}:2`, `${keyOf(1)}:3`])
    expect(first.module.followStatuses()[0].eventsToday).toBe(3)
    // The app starts again: the stream's snapshot re-sends both; nothing is pushed twice.
    const again = await service()
    await again.module.startFollowing()
    streams[streams.length - 1].handlers.onFills(address(1), [fill(1, { time: T0 - 3_600_000 }), fill(2)], true)
    await settle()
    expect(again.events).toEqual([])
    expect((await again.module.recentFollowRecords(T0 - 10 * 60_000)).events.map((event) => event.key)).toEqual([`${keyOf(1)}:1`, `${keyOf(1)}:2`, `${keyOf(1)}:3`])
  })

  it('reads back at most the last day of what it kept, for the writers at their start', async () => {
    const DAY = 86_400_000
    copy = { follows: { [keyOf(1)]: { since: T0 - 3 * DAY, maxHoldSec: 3600 } }, clones: {} }
    now = T0 - 2 * DAY
    const { module } = await service()
    await module.startFollowing()
    streams[0].handlers.onFills(address(1), [fill(1)], false)
    await settle()
    now = T0
    streams[0].handlers.onFills(address(1), [fill(2)], false)
    await settle()
    expect((await module.recentFollowRecords(T0 - 3 * DAY)).events.map((event) => event.key)).toEqual([`${keyOf(1)}:2`])
  })

  it('calls a leader lost after two reads missed in a row, and found again on the next read', async () => {
    copy = { follows: Object.fromEntries([1, 2, 3, 4, 5, 6].map((k) => [keyOf(k), { since: T0 - k * 1000, maxHoldSec: 3600 }])), clones: {} }
    pollAnswer = () => {
      throw new Error('Hyperliquid could not be read')
    }
    const { module } = await service()
    await module.startFollowing()
    await turn()
    expect(module.followStatuses().find((status) => status.key === keyOf(1))).toMatchObject({ missedReads: 1, lost: false })
    await turn()
    expect(module.followStatuses().find((status) => status.key === keyOf(1))).toMatchObject({ missedReads: 2, lost: true })
    pollAnswer = () => []
    await turn()
    expect(module.followStatuses().find((status) => status.key === keyOf(1))).toMatchObject({ missedReads: 0, lost: false })
    // The stream's traders: two failed connects in a row; found again when it opens.
    streams[0].handlers.onConnectFailed(2)
    expect(module.followStatuses().find((status) => status.key === keyOf(6))).toMatchObject({ lost: true })
    now = T0 + 90_000
    streams[0].handlers.onOpen()
    expect(module.followStatuses().find((status) => status.key === keyOf(6))).toMatchObject({ lost: false, missedReads: 0, lastReadMs: T0 + 90_000 })
  })

  it("takes an OKX trader's first read as what they held, then an opening, a resize and a close as events; hidden positions said so", async () => {
    copy = { follows: { [OKX]: { since: T0 - 60_000, maxHoldSec: 3600 } }, clones: {} }
    const position = (id: string, size: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({ subPosId: id, instId: 'ETH-USDT-SWAP', subPos: size, posSide: 'long', openAvgPx: '2000', markPx: '2010', openTime: String(T0 - 1000), ...over })
    okxAnswers = [
      [position('held', '10')],
      [position('held', '10'), position('new', '5')],
      [position('held', '10'), position('new', '8')],
      [position('held', '10'), position('new', '5')],
      [position('held', '10'), position('new', '8'), position('short', '3', { posSide: 'short' })],
      [position('held', '10')],
      [{ subPosId: 'x', instId: '', subPos: '' }]
    ]
    const { module, events } = await service()
    await module.startFollowing()
    for (let k = 0; k < 6; k++) {
      now = T0 + k * 60_000
      await turn()
    }
    // A size seen twice -- 8, back to 5, 8 again -- is a change each time; a read's events pushed in the order they were
    // made, an opening at OKX's own time of it.
    expect(events.map((event) => [event.positionId, event.before, event.after, event.via])).toEqual([
      ['new', 0, 5, 'poll'],
      ['new', 5, 8, 'poll'],
      ['new', 8, 5, 'poll'],
      ['short', 0, -3, 'poll'],
      ['new', 5, 8, 'poll'],
      ['new', 8, 0, 'poll'],
      ['short', -3, 0, 'poll']
    ])
    expect(new Set(events.map((event) => event.key)).size).toBe(events.length)
    await turn()
    expect(module.followStatuses()[0]).toMatchObject({ venue: 'okx', mode: 'poll', hidden: true })
  })
})

describe('the clones read', () => {
  it("read each running clone's rule at a new 15-minute close on each coin, and signal where it holds -- once a close", async () => {
    copy = { follows: {}, clones: { [OKX]: { since: T0 - 60_000, rule: { side: 'long', holdBars: 4, conditions: [] }, coins: [{ coin: 'ETH', venue: 'binance', symbol: 'ETHUSDT' }] } } }
    // Flat bars at every step: a rule of no condition holds wherever the features can be read.
    bars = (_venue, _symbol, interval, fromSec, toSec) => {
      const step = interval === '1h' ? 3600 : 900
      const out: Candle[] = []
      for (let t = Math.ceil(fromSec / step) * step; t < toSec; t += step) out.push({ time: t, open: 100, high: 100, low: 100, close: 100, volume: 1 })
      return out
    }
    // A rule that does not hold on them: no signal.
    copy.clones[keyOf(7)] = { since: T0 - 60_000, rule: { side: 'short', holdBars: 2, conditions: [{ feature: 'ret1h', op: '>=', threshold: 0.01 }] }, coins: [{ coin: 'ETH', venue: 'binance', symbol: 'ETHUSDT' }] }
    // Ten seconds after the close its bar may not be final: read twenty seconds after it.
    now = Date.UTC(2026, 9, 27, 12, 15, 10)
    const { module, signals } = await service()
    await module.startFollowing()
    await turn()
    expect(signals).toEqual([])
    now = Date.UTC(2026, 9, 27, 12, 15, 25)
    await turn()
    expect(signals.map((signal) => [signal.key, signal.side, signal.holdBars, signal.px])).toEqual([[`${OKX}:clone:ETH:${Math.floor(Date.UTC(2026, 9, 27, 12, 15) / 1000)}`, 'long', 4, 100]])
    await turn()
    expect(signals).toHaveLength(1)
    expect(readdirSync(join(dir, OKX)).filter((name) => name.startsWith('clone-signals-'))).toHaveLength(1)
  })
})

describe('the buttons', () => {
  const analysis = (over: Partial<TraderAnalysis> = {}): TraderAnalysis =>
    ({
      figures: { holdMin: { p10: 1, median: 30, p90: 60, max: 90 }, coins: [{ coin: 'ETH', trips: 40, net: 1 }] },
      mapping: [{ coin: 'ETH', venue: 'binance', symbol: 'ETHUSDT' }],
      clone: { rule: { side: 'short', holdBars: 8, conditions: [] }, trades: { n: 1, meanNetPct: 0, interval: null, coins: ['ETH'] } },
      ...over
    }) as unknown as TraderAnalysis

  it("follow from now, a trader analysed, for the leader's longest hold; and no longer", async () => {
    const { module } = await service()
    await expect(module.setFollow(keyOf(1), true)).rejects.toThrow('Analyse the trader before following them.')
    await expect(module.setFollow('file-019b6c3cc293e353', true)).rejects.toThrow('Only a Hyperliquid or OKX trader on file can be followed.')
    analyses = new Map([[keyOf(1), analysis()]])
    const statuses = await module.setFollow(keyOf(1), true)
    expect(copy.follows[keyOf(1)]).toEqual({ since: T0, maxHoldSec: 5400 })
    expect(statuses.map((status) => status.key)).toEqual([keyOf(1)])
    expect(await module.setFollow(keyOf(1), false)).toEqual([])
    expect(copy.follows).toEqual({})
  })

  it("run a clone on the rule the trader's last analysis fitted, on its coins' perpetuals; and no longer", async () => {
    const { module } = await service()
    analyses = new Map([[OKX, analysis({ clone: null })]])
    await expect(module.setClone(OKX, true)).rejects.toThrow("The trader's last analysis fitted no rule to run.")
    // Its coins are those its rule traded in the test, each on its perpetual: BTC, traded by the trader but not by the rule,
    // is left out.
    analyses = new Map([
      [
        OKX,
        analysis({
          figures: { holdMin: { p10: 1, median: 30, p90: 60, max: 90 }, coins: [{ coin: 'ETH', trips: 40, net: 1 }, { coin: 'BTC', trips: 9, net: 2 }] } as TraderAnalysis['figures'],
          mapping: [
            { coin: 'ETH', venue: 'binance', symbol: 'ETHUSDT' },
            { coin: 'BTC', venue: 'binance', symbol: 'BTCUSDT' }
          ]
        })
      ]
    ])
    await module.setClone(OKX, true)
    expect(copy.clones[OKX]).toEqual({ since: T0, rule: { side: 'short', holdBars: 8, conditions: [] }, coins: [{ coin: 'ETH', venue: 'binance', symbol: 'ETHUSDT' }] })
    await module.setClone(OKX, false)
    expect(copy.clones).toEqual({})
  })
})
