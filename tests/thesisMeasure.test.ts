import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Candle, ExecutorConfig, LivePosition, LiveWatcherSummary, PositionExecutorParams } from '../shared/ipc'
import type { NewsAgainstStory } from '../shared/paperNewsBlock'
import { readBitcoin, readMinutes } from '../src/agents/openTradeReading'
import { LIVE_MINUTES_SEC, REGIME_LOOKBACK_SEC, distancesOf, latestStoryNaming, liveSubjects, measureTheses, paperSubjects, type ThesisDeps } from '../src/positions/thesisMeasure'

// src/positions/thesisMeasure.ts: the thesis status measured for the app's own paper trades and for
// the real positions with a watcher, on fixtures shaped as the exit check's are; and the reading of
// a pair's minutes it shares with the exit check (src/agents/openTradeReading.ts). Everything it
// reaches is injected, and it is only ever read.

const T = Date.parse('2026-10-08T12:00:00Z') / 1000
const NOW = T + 30
const OPENED = T - 3600 + 20
const ENTERED = T - 3540
const LIVE_ENTERED = T - 7200
const MODEL = 'openai/gpt-5-mini'

const bar = (time: number, close: number, low = close, high = close): Candle => ({ time, open: close, high, low, close, volume: 1 })

/** A pair at 100 from twenty minutes before `opened`, moving by `movePct` over the last fifteen
 * closed minutes; and the minute under way. Lows stay above a 2% stop. */
function pairMinutes(opened: number, movePct: number): Candle[] {
  const out: Candle[] = []
  for (let time = opened - 1220; time <= T; time += 60) {
    const aligned = Math.floor(time / 60) * 60
    const close = aligned <= T - 960 ? 100 : 100 + (movePct * (aligned - (T - 960))) / 900
    out.push(bar(aligned, Number(close.toFixed(6)), Math.min(close, 99.9), Math.max(close, 100.1)))
  }
  return out
}

function flat(from: number, to: number, close: number, step = 60): Candle[] {
  const out: Candle[] = []
  for (let time = Math.ceil(from / step) * step; time <= to; time += step) out.push(bar(time, close))
  return out
}

/** Bitcoin: flat at 100 until the last hour, then up 1.2% by its last closed minute; fifteen-minute
 * bars flat at 100. Sideways two hours ago and an hour ago, bull now (shared/marketResearch.ts). */
function btcMinutes(): Candle[] {
  const out: Candle[] = []
  for (let time = T - 400 * 60; time <= T; time += 60) out.push(bar(time, time <= T - 3600 ? 100 : 100 + (1.2 * (time - (T - 3600))) / 3540))
  return out
}
const btcQuarters = (): Candle[] => flat(T - 100 * 900, T - 900, 100, 900)

function executor(id: string, over: Partial<ExecutorConfig> = {}, params: Partial<PositionExecutorParams> = {}): ExecutorConfig {
  return {
    id,
    name: `Watch: BUY ${id}`,
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: OPENED,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    watch: { eventId: `binance:SOLUSDT:${OPENED - 60}`, eventTime: OPENED - 60, model: MODEL, confidence: 0.8 },
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: { side: 'buy', entryPrice: null, amountQuote: 100, takeProfitPct: 4, stopLossPct: 2, timeLimitSec: 7200, trailingStop: null, ...params },
    ...over
  }
}

const SHORT = executor('n1', { name: 'Delisting short · ABCUSDT', symbol: 'ABCUSDT', baseAsset: 'ABC', watch: undefined, newsRule: { articleId: 1, ticker: 'ABC', releaseSec: OPENED - 120, title: 'Binance Will Delist ABC', category: 'DELISTING' } }, { side: 'sell', takeProfitPct: null, stopLossPct: null, timeLimitSec: 14_400 })

const POSITION: LivePosition = { id: 'p1', exchange: 'binance', symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', qty: 0.1, avgCost: 3000, openedAt: LIVE_ENTERED, closedAt: null, exitPrice: null, realizedPnl: null }
const WATCHER: LiveWatcherSummary = {
  executorId: 'e1',
  livePositionId: 'p1',
  exchange: 'binance',
  symbol: 'ETHUSDT',
  entryPrice: 3000,
  trailingPeakPrice: 3000,
  takeProfitPct: 6,
  stopLossPct: 3,
  timeLimitSec: null,
  trailingStop: null,
  enteredAt: LIVE_ENTERED,
  consecutiveFailures: 0,
  lastError: null
}

const story = (id: string, ticker: string, eventType: NewsAgainstStory['eventType'], impact: number, publishedAt: number, stale = false): NewsAgainstStory => ({
  id,
  eventType,
  assets: [{ ticker }] as NewsAgainstStory['assets'],
  impact,
  publishedAt,
  stale,
  title: `${ticker}: ${eventType}`,
  sourceName: 'CoinDesk'
})
const SOL_HACK = story('sol-hack', 'SOL', 'HACK', 80, OPENED + 600)
const SOL_OLD = story('sol-old', 'SOL', 'PARTNERSHIP', 50, OPENED - 7200)
const ETH_LISTING = story('eth-listing', 'ETH', 'LISTING', 75, T - 300)
const SOL_STALE = story('sol-stale', 'SOL', 'HACK', 90, T - 120, true)

interface Rig {
  deps: ThesisDeps
  fetched: { symbol: string; interval: string; startSec: number; endSec: number }[]
  readingsSince: number[]
}

function rig(over: Partial<ThesisDeps> = {}, minutes: Record<string, Candle[]> = {}): Rig {
  const fetched: Rig['fetched'] = []
  const readingsSince: number[] = []
  const series: Record<string, Candle[]> = { SOLUSDT: pairMinutes(OPENED, -1.6), ETHUSDT: flat(NOW - LIVE_MINUTES_SEC, T, 3000), ABCUSDT: pairMinutes(OPENED, 0), ...minutes }
  const deps: ThesisDeps = {
    fetchCandles: async (_exchange, symbol, interval, startSec, endSec) => {
      fetched.push({ symbol, interval, startSec, endSec })
      if (symbol === 'BTCUSDT') return interval === '1m' ? btcMinutes() : btcQuarters()
      const found = series[symbol]
      if (found === undefined) throw new Error(`no minutes for ${symbol}`)
      return found
    },
    stories: async () => [SOL_HACK, SOL_OLD, ETH_LISTING, SOL_STALE],
    readings: async (sinceSec) => {
      readingsSince.push(sinceSec)
      return {}
    },
    nowSec: () => NOW,
    ...over
  }
  return { deps, fetched, readingsSince }
}

describe('the subjects', () => {
  it("are the app's own open paper trades, with their executors for the engine to say where each entered", () => {
    const live = executor('l1', { mode: 'live', watch: undefined, proposedBy: { model: MODEL, candleTime: OPENED, confidence: 0.8 } })
    const stopped = executor('w2', { status: 'stopped', stoppedAt: T })
    const plain = executor('o1', { watch: undefined })
    const subjects = paperSubjects([executor('w1'), live, stopped, plain, SHORT])
    expect(subjects.map((subject) => subject.id)).toEqual(['w1', 'n1'])
    expect(subjects[0]).toMatchObject({ exchange: 'binance', symbol: 'SOLUSDT', baseAsset: 'SOL', side: 'buy', openedAt: OPENED, stopPct: 2, targetPct: 4, timeLimitSec: 7200, entryPrice: null })
    expect(subjects[0].executor?.id).toBe('w1')
    expect(subjects[1]).toMatchObject({ side: 'sell', stopPct: null, targetPct: null, timeLimitSec: 14_400 })
  })

  it("are the real positions with a watcher, as longs, with the watcher's entry and barriers", () => {
    const other: LivePosition = { ...POSITION, id: 'p2', symbol: 'BNBUSDT', baseAsset: 'BNB' }
    const subjects = liveSubjects([POSITION, other], [WATCHER])
    expect(subjects).toEqual([
      { id: 'p1', exchange: 'binance', symbol: 'ETHUSDT', baseAsset: 'ETH', side: 'buy', openedAt: LIVE_ENTERED, stopPct: 3, targetPct: 6, timeLimitSec: null, executor: null, entryPrice: 3000 }
    ])
    expect(liveSubjects([POSITION], [{ ...WATCHER, entryPrice: 0 }])).toEqual([])
    expect(liveSubjects([POSITION], [{ ...WATCHER, livePositionId: 'p9' }])).toEqual([])
  })
})

describe('one measurement', () => {
  it('reads each subject on its last closed minute, Bitcoin once an exchange, the stories and the readings once', async () => {
    const s = rig()
    const out = await measureTheses([...paperSubjects([executor('w1')]), ...liveSubjects([POSITION], [WATCHER])], s.deps)
    expect(Object.keys(out).sort()).toEqual(['p1', 'w1'])
    // The watch's trade: entered at 100, at 98.4 on the last closed minute, 80% of the way to its
    // 2% stop, with a hack story against it since it was opened: BROKEN on two reasons.
    expect(out.w1).toMatchObject({ id: 'w1', entryPrice: 100, enteredAt: ENTERED, price: 98.4, priceTime: T - 60, regimeAtEntry: 'sideways', regimeNow: 'bull' })
    expect(out.w1.move15mPct).toBeCloseTo(-1.6, 6)
    expect(out.w1.verdict).toMatchObject({ status: 'BROKEN', reasons: ['near_stop', 'news_against'] })
    expect(out.w1.verdict.stopProgress).toBeCloseTo(0.8, 6)
    expect(out.w1.storyAgainst?.id).toBe('sol-hack')
    // The latest story naming the coin that is not stale is the hack, not the stale one after it.
    expect(out.w1.latestStory?.id).toBe('sol-hack')
    // The real position: its watcher's entry, flat since, a listing story that points its way.
    expect(out.p1).toMatchObject({ id: 'p1', entryPrice: 3000, enteredAt: LIVE_ENTERED, price: 3000, priceTime: T - 60, move15mPct: 0, regimeAtEntry: 'sideways', regimeNow: 'bull', storyAgainst: null })
    expect(out.p1.latestStory?.id).toBe('eth-listing')
    expect(out.p1.verdict).toEqual({ status: 'VALID', reasons: [], stopProgress: 0 })
    // What was read: the paper trade's minutes from before it was opened, the real position's last
    // twenty-five minutes, and Bitcoin's minutes and quarters once, from before the earliest entry.
    expect(s.fetched).toEqual([
      { symbol: 'SOLUSDT', interval: '1m', startSec: OPENED - 960, endSec: NOW },
      { symbol: 'ETHUSDT', interval: '1m', startSec: NOW - LIVE_MINUTES_SEC, endSec: NOW },
      { symbol: 'BTCUSDT', interval: '1m', startSec: LIVE_ENTERED - 242 * 60, endSec: NOW },
      { symbol: 'BTCUSDT', interval: '15m', startSec: LIVE_ENTERED - 99 * 900, endSec: NOW }
    ])
    expect(s.readingsSince).toEqual([LIVE_ENTERED - 10_800])
  })

  it('leaves out a subject that has not entered, one whose minutes are not of the last few, and one it could not read; the others are measured', async () => {
    const s = rig({}, { ABCUSDT: pairMinutes(OPENED, 0).filter((candle) => candle.time <= T - 1200) })
    const notEntered = executor('w3', { createdAt: T + 600 })
    const unreadable = executor('w4', { symbol: 'XRPUSDT', baseAsset: 'XRP' })
    const out = await measureTheses(paperSubjects([executor('w1'), notEntered, SHORT, unreadable]), s.deps)
    expect(Object.keys(out)).toEqual(['w1'])
  })

  it('measures nothing for no subjects, and reads nothing', async () => {
    const s = rig()
    expect(await measureTheses([], s.deps)).toEqual({})
    expect(s.fetched).toEqual([])
  })

  it('reads the regime at the entry only within a day: before that, the status reads the regime now alone', async () => {
    const s = rig()
    const old: LiveWatcherSummary = { ...WATCHER, enteredAt: NOW - 2 * 86_400 }
    const out = await measureTheses(liveSubjects([POSITION], [old]), s.deps)
    expect(out.p1).toMatchObject({ regimeAtEntry: null, regimeNow: 'bull', enteredAt: NOW - 2 * 86_400 })
    expect(s.fetched[1]).toEqual({ symbol: 'BTCUSDT', interval: '1m', startSec: NOW - REGIME_LOOKBACK_SEC - 242 * 60, endSec: NOW })
  })

  it('goes on without the stories or the readings when they cannot be read, and without Bitcoin', async () => {
    const s = rig({
      stories: async () => {
        throw new Error('the feed is down')
      },
      readings: async () => {
        throw new Error('the ledger is locked')
      }
    })
    const out = await measureTheses(paperSubjects([executor('w1')]), s.deps)
    expect(out.w1).toMatchObject({ storyAgainst: null, latestStory: null, verdict: { status: 'WEAKENING', reasons: ['near_stop'] } })
    const noBtc = rig({
      fetchCandles: async (_exchange, symbol) => {
        if (symbol === 'BTCUSDT') throw new Error('no reference')
        return pairMinutes(OPENED, -1.6)
      }
    })
    const without = await measureTheses(paperSubjects([executor('w1')]), noBtc.deps)
    expect(without.w1).toMatchObject({ regimeAtEntry: null, regimeNow: null, verdict: { status: 'BROKEN' } })
  })
})

describe("a pair's minutes", () => {
  it('give the last closed minute and the move over the fifteen before it; none closed of late is nothing', () => {
    const minutes = pairMinutes(OPENED, -1.6)
    expect(readMinutes(minutes, NOW)).toMatchObject({ last: { time: T - 60, close: 98.4 } })
    expect(readMinutes(minutes, NOW)?.move15mPct).toBeCloseTo(-1.6, 6)
    // The minute under way is no fact yet: with it closed, it is the last.
    expect(readMinutes(minutes, T + 60)?.last.time).toBe(T)
    expect(readMinutes(minutes, NOW + 600)).toBeNull()
    expect(readMinutes([], NOW)).toBeNull()
    expect(readMinutes(minutes.filter((candle) => candle.time !== T - 960), NOW)?.move15mPct).toBeNull()
  })

  it("reads Bitcoin's minutes and quarters from before a time, and nothing when either cannot be read", async () => {
    const s = rig()
    const btc = await readBitcoin(s.deps.fetchCandles, 'binance', ENTERED, NOW)
    expect(btc?.candles1m.length).toBe(401)
    expect(btc?.candles15m.length).toBe(100)
    expect(s.fetched).toEqual([
      { symbol: 'BTCUSDT', interval: '1m', startSec: ENTERED - 242 * 60, endSec: NOW },
      { symbol: 'BTCUSDT', interval: '15m', startSec: ENTERED - 99 * 900, endSec: NOW }
    ])
    const failing = rig({
      fetchCandles: async (_exchange, _symbol, interval) => {
        if (interval === '15m') throw new Error('no quarters')
        return btcMinutes()
      }
    })
    expect(await readBitcoin(failing.deps.fetchCandles, 'binance', ENTERED, NOW)).toBeNull()
  })
})

describe('what is shown beside it', () => {
  it('is the latest story naming the coin that is not stale, whichever way it points', () => {
    expect(latestStoryNaming([SOL_OLD, SOL_HACK, SOL_STALE, ETH_LISTING], 'SOL', NOW)?.id).toBe('sol-hack')
    expect(latestStoryNaming([SOL_OLD, SOL_HACK, ETH_LISTING], 'BNB', NOW)).toBeNull()
    // One dated after now is not yet a story.
    expect(latestStoryNaming([story('later', 'SOL', 'HACK', 80, NOW + 60)], 'SOL', NOW)).toBeNull()
  })

  it('is how far the stop and the target are, in percent of the price, either side, and none without a level', () => {
    const long = distancesOf({ side: 'buy', entryPrice: 100, price: 99, stopPct: 2, targetPct: 4 })
    expect(long.toStopPct).toBeCloseTo((1 / 99) * 100, 6)
    expect(long.toTargetPct).toBeCloseTo((5 / 99) * 100, 6)
    const short = distancesOf({ side: 'sell', entryPrice: 100, price: 101, stopPct: 2, targetPct: 4 })
    expect(short.toStopPct).toBeCloseTo((1 / 101) * 100, 6)
    expect(short.toTargetPct).toBeCloseTo((5 / 101) * 100, 6)
    expect(distancesOf({ side: 'buy', entryPrice: 100, price: 97, stopPct: 2, targetPct: null })).toMatchObject({ toTargetPct: null })
    expect(distancesOf({ side: 'buy', entryPrice: 100, price: 97, stopPct: 2, targetPct: null }).toStopPct).toBeLessThan(0)
    expect(distancesOf({ side: 'buy', entryPrice: 100, price: 99, stopPct: null, targetPct: null })).toEqual({ toStopPct: null, toTargetPct: null })
    expect(distancesOf({ side: 'buy', entryPrice: 0, price: 99, stopPct: 2, targetPct: 4 })).toEqual({ toStopPct: null, toTargetPct: null })
  })

  it("is the watcher's copy, with the position it guards and its barriers, as the handler hands it over", () => {
    const handler = readFileSync(join(__dirname, '..', 'electron', 'ipc', 'handlers', 'liveTradingHandlers.ts'), 'utf-8')
    for (const field of ['livePositionId', 'takeProfitPct', 'stopLossPct', 'timeLimitSec', 'trailingStop', 'enteredAt']) expect(handler).toContain(`${field}: w.${field},`)
  })
})
