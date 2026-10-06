import { describe, expect, it } from 'vitest'
import type { ExitCheck, ExitCheckRequest } from '../shared/aiAdditions'
import type { AiExitOrder } from '../shared/aiExit'
import type { AiExitMark, Candle, ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import { lookAtOpenTrades, readOpenTrade, type ExitCheckDeps } from '../src/agents/exitCheck'

// src/agents/exitCheck.ts: the look at the app's own open paper trades. Each one that has entered is
// measured on its closed minutes and put to the main process; an answered EXIT is handed to the
// writer of that kind of trade, and nothing else is. Everything it reaches is injected.

const T = Date.parse('2026-10-06T12:00:00Z') / 1000
const NOW = T + 30
const OPENED = T - 3600 + 20
const ENTERED = T - 3540
const MODEL = 'openai/gpt-5-mini'

const bar = (time: number, close: number, low = close, high = close): Candle => ({ time, open: close, high, low, close, volume: 1 })

/** The pair: at 100 from twenty minutes before the trade was opened, falling to 98.4 over the last
 * fifteen minutes; and the minute under way. */
function pairMinutes(): Candle[] {
  const out: Candle[] = []
  for (let time = OPENED - 1220; time <= T; time += 60) {
    const aligned = Math.floor(time / 60) * 60
    const close = aligned <= T - 960 ? 100 : 100 - (1.6 * (aligned - (T - 960))) / 900
    out.push(bar(aligned, Number(close.toFixed(6)), Math.min(close, 99.9)))
  }
  return out
}

/** Bitcoin: flat at 100 until the last hour, then up 1.2% by its last closed minute; fifteen-minute
 * bars flat at 100. Sideways when the trade entered, bull now (shared/marketResearch.ts). */
function btcMinutes(): Candle[] {
  const out: Candle[] = []
  for (let time = T - 334 * 60; time <= T; time += 60) out.push(bar(time, time <= T - 3600 ? 100 : 100 + (1.2 * (time - (T - 3600))) / 3540))
  return out
}
function btcQuarters(): Candle[] {
  const out: Candle[] = []
  for (let time = T - 100 * 900; time <= T - 900; time += 900) out.push(bar(time, 100))
  return out
}

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
    params: { side: 'buy', entryPrice: null, amountQuote: 100, takeProfitPct: 4, stopLossPct: 2, timeLimitSec: 7200, trailingStop: null, entryRange: { min: 99.8, max: 100.2 }, ...params },
    ...over
  }
}

const SHORT = executor('n1', {
  name: 'Delisting short · ABCUSDT',
  symbol: 'ABCUSDT',
  baseAsset: 'ABC',
  watch: undefined,
  newsRule: { articleId: 7, ticker: 'ABC', releaseSec: OPENED - 30, title: 'Binance Will Delist ABC', category: 'DELISTING' }
}, { side: 'sell', takeProfitPct: null, stopLossPct: null, timeLimitSec: 14_400, entryRange: null })

const answered = (verdict: 'KEEP' | 'REDUCE' | 'EXIT'): ExitCheck => ({
  asked: true,
  triggers: ['near_stop'],
  outcome: { status: 'answered', answer: { verdict, confidence: 0.6, reason: 'It broke the level it was bought on.' }, cached: false, model: MODEL }
})

interface Rig {
  deps: ExitCheckDeps
  asked: ExitCheckRequest[]
  exits: { writer: 'watch' | 'news'; order: AiExitOrder }[]
  notices: { title: string; body: string }[]
  reads: string[]
}

function rig(input: { executors: ExecutorConfig[]; answer?: (request: ExitCheckRequest) => ExitCheck | Promise<ExitCheck>; watchOn?: boolean; exitOn?: boolean; fail?: string[] }): Rig {
  const made: Rig = { deps: undefined as unknown as ExitCheckDeps, asked: [], exits: [], notices: [], reads: [] }
  const bars: Record<string, Candle[]> = { 'SOLUSDT:1m': pairMinutes(), 'ABCUSDT:1m': pairMinutes().map((candle) => ({ ...candle, close: 200 - candle.close, open: 200 - candle.open, high: 200 - candle.low, low: 200 - candle.high })), 'BTCUSDT:1m': btcMinutes(), 'BTCUSDT:15m': btcQuarters() }
  made.deps = {
    getConfig: async () => ({
      watch: { enabled: input.watchOn ?? true, models: [MODEL], maxEventsPerDay: 10, minBand: 'urgent', firstModelGates: false },
      additions: { news: true, why: true, exit: input.exitOn ?? true, review: true }
    }),
    getSettings: async () => ({ executors: input.executors }),
    fetchCandles: async (_exchange, symbol, interval, startSec, endSec) => {
      made.reads.push(`${symbol}:${interval}`)
      if ((input.fail ?? []).includes(`${symbol}:${interval}`)) throw new Error('down')
      return (bars[`${symbol}:${interval}`] ?? []).filter((candle) => candle.time >= startSec && candle.time <= endSec)
    },
    exitCheck: async (request) => {
      made.asked.push(request)
      if ((input.fail ?? []).includes(`ask:${request.executorId}`)) throw new Error('refused')
      return (input.answer ?? (() => ({ asked: false, triggers: [], outcome: null })))(request)
    },
    exitWatchTrade: async (order) => {
      made.exits.push({ writer: 'watch', order })
      return true
    },
    exitNewsShort: async (order) => {
      made.exits.push({ writer: 'news', order })
      return true
    },
    notify: (title, body) => {
      made.notices.push({ title, body })
    },
    nowSec: () => NOW
  }
  return made
}

describe('the look', () => {
  it('does nothing while the watch is off, or the check is switched off: it reads nothing and asks nothing', async () => {
    for (const r of [rig({ executors: [executor('w1')], watchOn: false }), rig({ executors: [executor('w1')], exitOn: false })]) {
      expect(await lookAtOpenTrades(r.deps)).toEqual([])
      expect(r.reads).toEqual([])
      expect(r.asked).toEqual([])
    }
  })

  it("measures each of the app's own open trades on its closed minutes, and puts it to the main process", async () => {
    const r = rig({ executors: [executor('w1')] })
    expect(await lookAtOpenTrades(r.deps)).toEqual([])
    expect(r.asked).toHaveLength(1)
    const [request] = r.asked
    expect(request).toMatchObject({ executorId: 'w1', entryPrice: 100, enteredAt: ENTERED, priceTime: T - 60, price: 98.4, regimeAtEntry: 'sideways', regimeNow: 'bull' })
    expect(request.move15mPct).toBeCloseTo(-1.6, 9)
    // Bitcoin's minutes are read once a look, however many trades there are.
    const two = rig({ executors: [executor('w1'), SHORT] })
    await lookAtOpenTrades(two.deps)
    expect(two.asked.map((asked) => asked.executorId)).toEqual(['w1', 'n1'])
    expect(two.reads.filter((read) => read.startsWith('BTCUSDT'))).toEqual(['BTCUSDT:1m', 'BTCUSDT:15m'])
  })

  it('hands an answered EXIT to the writer of that kind of trade, and says so on the desktop', async () => {
    const r = rig({ executors: [executor('w1'), SHORT], answer: () => answered('EXIT') })
    expect(await lookAtOpenTrades(r.deps)).toEqual([
      'SOLUSDT: EXIT (it is near its stop); it closes at the next minute, on paper.',
      'ABCUSDT: EXIT (it is near its stop); it closes at the next minute, on paper.'
    ])
    const order = { enteredAt: ENTERED, model: MODEL, triggers: ['near_stop'], confidence: 0.6, reason: 'It broke the level it was bought on.' }
    expect(r.exits).toEqual([
      { writer: 'watch', order: { executorId: 'w1', ...order } },
      { writer: 'news', order: { executorId: 'n1', ...order } }
    ])
    expect(r.notices[0]).toEqual({
      title: 'Exit check: Watch: BUY w1 closes',
      body: 'Asked because it is near its stop. It broke the level it was bought on. It closes at the next minute, on paper.'
    })
    expect(r.notices).toHaveLength(2)
  })

  it('says so, and tells nobody, when the writer finds the trade ends by its own plan as soon', async () => {
    const r = rig({ executors: [executor('w1')], answer: () => answered('EXIT') })
    r.deps.exitWatchTrade = async () => false
    expect(await lookAtOpenTrades(r.deps)).toEqual(['SOLUSDT: EXIT (it is near its stop), but it closes by its own plan as soon.'])
    expect(r.notices).toEqual([])
  })

  it('changes nothing on KEEP or REDUCE, or on a check that was not asked, was refused or failed', async () => {
    const outcomes: ExitCheck[] = [
      answered('KEEP'),
      answered('REDUCE'),
      { asked: false, triggers: [], outcome: null },
      { asked: true, triggers: ['news'], outcome: { status: 'skipped', reason: 'The exit check has made its 30 calls today.' } },
      { asked: true, triggers: ['news'], outcome: { status: 'refused', reason: 'verdict is not one of KEEP, REDUCE, EXIT.', cached: false, model: MODEL } },
      { asked: true, triggers: ['news'], outcome: { status: 'failed', reason: 'down' } }
    ]
    const lines: string[][] = []
    for (const outcome of outcomes) {
      const r = rig({ executors: [executor('w1')], answer: () => outcome })
      lines.push(await lookAtOpenTrades(r.deps))
      expect(r.exits).toEqual([])
      expect(r.notices).toEqual([])
    }
    expect(lines).toEqual([
      ['SOLUSDT: KEEP (it is near its stop).'],
      ['SOLUSDT: REDUCE (it is near its stop).'],
      [],
      ['SOLUSDT: not checked (news on the coin): The exit check has made its 30 calls today.'],
      ['SOLUSDT: not checked (news on the coin): verdict is not one of KEEP, REDUCE, EXIT.'],
      ['SOLUSDT: not checked (news on the coin): down']
    ])
  })

  it("looks only at the app's own open paper trades that have entered, and not again at one it closed", async () => {
    const closing: AiExitMark = { at: T - 600, closeAt: T - 540, enteredAt: ENTERED, planTimeLimitSec: 7200, model: MODEL, triggers: ['news'], confidence: 0.6, reason: 'r' }
    const r = rig({
      executors: [
        executor('live', { mode: 'live' }),
        executor('hand', { watch: undefined }),
        executor('stopped', { status: 'stopped', stoppedAt: T - 300 }),
        executor('closing', { watch: { eventId: 'e', eventTime: OPENED - 60, model: MODEL, confidence: 0.8, aiExit: closing } }),
        // Still waiting for an entry the price never reached.
        executor('waiting', {}, { entryRange: { min: 90, max: 91 } }),
        // Its stop has ended it: the settle loop's to stop, not the check's to ask about.
        executor('ended', {}, { stopLossPct: 1 }),
        executor('w1')
      ],
      answer: () => answered('EXIT')
    })
    await lookAtOpenTrades(r.deps)
    expect(r.asked.map((asked) => asked.executorId)).toEqual(['w1'])
    expect(r.exits.map((exit) => exit.order.executorId)).toEqual(['w1'])
  })

  it('goes on past a trade whose minutes cannot be read or whose check cannot be had, and asks without a regime it cannot read', async () => {
    const other = executor('w2', { symbol: 'ABCUSDT', baseAsset: 'ABC' })
    const r = rig({ executors: [executor('w1'), other, executor('w3')], fail: ['SOLUSDT:1m'] })
    await lookAtOpenTrades(r.deps)
    expect(r.asked.map((asked) => asked.executorId)).toEqual(['w2'])
    const s = rig({ executors: [executor('w1'), executor('w3')], fail: ['ask:w1', 'BTCUSDT:15m'], answer: () => answered('EXIT') })
    expect(await lookAtOpenTrades(s.deps)).toEqual(['SOLUSDT: EXIT (it is near its stop); it closes at the next minute, on paper.'])
    expect(s.asked.map((asked) => [asked.executorId, asked.regimeAtEntry, asked.regimeNow])).toEqual([
      ['w1', null, null],
      ['w3', null, null]
    ])
  })
})

describe('readOpenTrade', () => {
  it("reads a trade's minutes as the settle loops do, from when it was opened, and only ones that have closed", () => {
    const minutes = pairMinutes()
    expect(readOpenTrade(executor('w1'), minutes, NOW)).toMatchObject({ entryPrice: 100, enteredAt: ENTERED, last: { time: T - 60, close: 98.4 } })
    // The minute under way is no fact yet: with it closed early, it would be the last.
    expect(readOpenTrade(executor('w1'), minutes, T + 60)?.last.time).toBe(T)
  })

  it('reads none for minutes that are not of the last few, and no fifteen-minute move without the minute it is measured from', () => {
    expect(readOpenTrade(executor('w1'), pairMinutes(), NOW + 600)).toBeNull()
    const gap = pairMinutes().filter((candle) => candle.time !== T - 960)
    expect(readOpenTrade(executor('w1'), gap, NOW)?.move15mPct).toBeNull()
  })
})
