import { beforeEach, describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import type { AiOpportunityAskRequest, AiOpportunityPeek, AiOpportunityPeekRequest } from '../shared/aiOpportunity'
import type { AiSignalDecision, AiSignalDetail } from '../shared/aiSignal'
import type { AiWatchConfig } from '../shared/aiWatch'
import type { MarketEvent } from '../shared/marketEvent'
import { getWatchActivity, priceWatchCall, resetWatch, subscribeWatchActivity, watchPass, type WatchActivity, type WatchDeps } from '../src/agents/opportunityWatch'

// The watch at work, with everything it touches injected: the setting, the ledger, the candles,
// the call to a model and the desktop notice. No bridge, no network, no clock.

const A = 'openai/gpt-5-mini'
const B = 'mistralai/mistral-small-2603'
const C = 'anthropic/claude-haiku-4.5'
const T = Date.parse('2026-09-10T12:07:00Z') / 1000

function watch(overrides: Partial<AiWatchConfig> = {}): AiWatchConfig {
  return { enabled: true, models: [A, B], maxEventsPerDay: 10, minBand: 'urgent', firstModelGates: false, ...overrides }
}

function event(symbol = 'SOLUSDT', overrides: Partial<MarketEvent> = {}, rank = 1): MarketEvent {
  const time = overrides.time ?? T
  return {
    id: `binance:${symbol}:${time}`,
    exchange: 'binance',
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    time,
    type: 'breakout',
    direction: 'up',
    band: 'urgent',
    score: 91,
    components: { price: 90, volume: 95, volatility: 85, pressure: 90, breakout: 95 },
    price: 100,
    returnsPct: { m1: 0.4, m5: 1.5, m15: 3, h1: 3.2, h4: 2.5 },
    moveSigmas: 6,
    volumeRatio: 4.7,
    rangeRatio: 3,
    live: { detectedAt: time + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank },
    ...overrides
  }
}

const LONG: AiSignalDetail = {
  marketRegime: 'bull',
  riskLevel: 'medium',
  horizonBars: 4,
  stopLoss: 98.5,
  takeProfit: 103,
  reasonCodes: ['breakout'],
  levelsNote: null,
  entry: { min: 99.8, max: 100.2, validMinutes: 15 }
}

function decision(model: string, overrides: Partial<AiSignalDecision> = {}): AiSignalDecision {
  return {
    candleTime: T,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'Cleared the range on volume.',
    model,
    cached: false,
    error: null,
    rejected: null,
    detail: LONG,
    usage: { promptTokens: 2400, completionTokens: 500, costUsd: 0.003, latencyMs: 14_000 },
    ...overrides
  }
}

const NO_TRADE = { recommendation: 'hold' as const, confidence: 0.5, detail: null }

interface Rig {
  deps: WatchDeps
  /** Every call to a model: which, about which pair, and under what label. */
  asked: { model: string; symbol: string; source: string | undefined }[]
  notices: { title: string; body: string }[]
  /** The ledger the watch counts its day from. A call that answers adds a row. */
  rows: (Pick<AiCallRecord, 'at' | 'source' | 'eventId'> & Partial<Pick<AiCallRecord, 'model' | 'status'>>)[]
  /** Candle fetches made. */
  fetches: number
  state: { watch: AiWatchConfig; now: number; answer: (model: string, symbol: string) => Partial<AiSignalDecision> | Error; candlesFail: boolean }
}

function rig(initial: Partial<Rig['state']> = {}): Rig {
  const state: Rig['state'] = { watch: watch(), now: T + 10, answer: () => ({}), candlesFail: false, ...initial }
  const made: Rig = { deps: undefined as unknown as WatchDeps, asked: [], notices: [], rows: [], fetches: 0, state }
  made.deps = {
    getConfig: async () => ({ watch: state.watch }),
    listCalls: async (filter) => ({ rows: made.rows.filter((row) => row.source === filter.source && row.at >= (filter.sinceSec ?? 0)) as AiCallRecord[], skippedLines: 0 }),
    fetchCandles: async () => {
      made.fetches++
      if (state.candlesFail) throw new Error('the exchange did not answer')
      return []
    },
    ask: async (request: AiOpportunityAskRequest) => {
      const model = request.model ?? A
      made.asked.push({ model, symbol: request.symbol, source: request.source })
      const reply = state.answer(model, request.symbol)
      if (reply instanceof Error) throw reply
      made.rows.push({ at: state.now, source: 'watch', eventId: `binance:${request.symbol}:${T}`, model, status: reply.error ? 'failed' : reply.rejected ? 'rejected' : 'ok' })
      return decision(model, reply)
    },
    notify: (title, body) => {
      made.notices.push({ title, body })
    },
    nowSec: () => state.now
  }
  return made
}

beforeEach(() => resetWatch())

describe('watchPass', () => {
  it('asks nothing while the watch is off, and keeps the event for when it is switched on', async () => {
    const r = rig({ watch: watch({ enabled: false }) })
    expect(await watchPass([event()], r.deps)).toEqual({ asked: [], skipped: [] })
    expect(r.asked).toEqual([])
    expect(r.fetches).toBe(0)
    // Switched on while the event is still fresh: it is taken up like any other.
    r.state.watch = watch()
    expect((await watchPass([event()], r.deps)).asked).toEqual([event().id])
    expect(r.asked).toHaveLength(2)
  })

  it("puts an announcement's event with the announcement's id, and any other event with none", async () => {
    const r = rig()
    const requests: AiOpportunityAskRequest[] = []
    const ask = r.deps.ask
    r.deps.ask = async (request) => {
      requests.push(request)
      return ask(request)
    }
    // Quiet, as the minute a delisting is read often is: it is the announcement that raised it.
    const delisting = event('ICXUSDT', { type: 'delisting', direction: 'down', band: 'quiet', news: { articleId: 990001, title: 'Binance Will Delist ICX on 2026-10-20', releaseSec: T - 30 } })
    expect((await watchPass([delisting, event()], r.deps)).asked.sort()).toEqual([delisting.id, event().id].sort())
    expect(requests.filter((request) => request.symbol === 'ICXUSDT').map((request) => request.newsId)).toEqual([990001, 990001])
    expect(requests.filter((request) => request.symbol === 'SOLUSDT').map((request) => request.newsId)).toEqual([undefined, undefined])
  })

  it('puts a fresh event to every model of the watch, once, in the watch\'s name', async () => {
    const r = rig()
    const result = await watchPass([event()], r.deps)
    expect(result).toEqual({ asked: [event().id], skipped: [] })
    expect(r.asked).toEqual([
      { model: A, symbol: 'SOLUSDT', source: 'watch' },
      { model: B, symbol: 'SOLUSDT', source: 'watch' }
    ])
  })

  it('takes an event up once, however many times the scanner reports it', async () => {
    const r = rig()
    await watchPass([event()], r.deps)
    await watchPass([event()], r.deps)
    await watchPass([event(), event('ETHUSDT')], r.deps)
    expect(r.asked.map((call) => call.symbol)).toEqual(['SOLUSDT', 'SOLUSDT', 'ETHUSDT', 'ETHUSDT'])
  })

  it('takes an event up once when two passes overlap', async () => {
    const r = rig()
    await Promise.all([watchPass([event()], r.deps), watchPass([event()], r.deps), watchPass([event()], r.deps)])
    expect(r.asked).toHaveLength(2)
  })

  it('leaves what it should not ask about, and says why', async () => {
    const r = rig()
    const stale = event('OLDUSDT', { time: T - 600 })
    const history = event('HISTUSDT', { live: null })
    const weak = event('WEAKUSDT', {}, 4)
    const candidate = event('CANDUSDT', { band: 'candidate' })
    const spike = event('SPIKEUSDT', { direction: 'none', type: 'volume_spike' })
    const result = await watchPass([stale, history, weak, candidate, spike], r.deps)
    expect(result.asked).toEqual([])
    expect(Object.fromEntries(result.skipped.map((entry) => [entry.id.split(':')[1], entry.reason]))).toEqual({
      OLDUSDT: 'It is more than 3 minutes old.',
      HISTUSDT: 'It was found by scanning history, not raised live.',
      WEAKUSDT: 'It was not among the strongest 3 of its minute.',
      CANDUSDT: 'It is below the urgent band the watch asks about.',
      SPIKEUSDT: 'It has no direction to act on.'
    })
    expect(r.asked).toEqual([])
    expect(r.fetches).toBe(0)
    // Decided once: the next pass does not look at them again.
    expect(await watchPass([stale, history, weak, candidate, spike], r.deps)).toEqual({ asked: [], skipped: [] })
  })

  it('stops at its events for the day, counted from the ledger', async () => {
    const r = rig({ watch: watch({ maxEventsPerDay: 5 }) })
    for (let index = 0; index < 5; index++) r.rows.push({ at: T - 3600, source: 'watch', eventId: `binance:X${index}USDT:1` })
    const result = await watchPass([event()], r.deps)
    expect(result.asked).toEqual([])
    expect(result.skipped[0].reason).toMatch(/its 5 events for today/)
    expect(r.asked).toEqual([])
  })

  it('does not count what a click or yesterday asked', async () => {
    const r = rig({ watch: watch({ maxEventsPerDay: 5 }) })
    for (let index = 0; index < 5; index++) r.rows.push({ at: T - 3600, source: 'opportunity', eventId: `binance:X${index}USDT:1` })
    for (let index = 0; index < 5; index++) r.rows.push({ at: T - 86_400, source: 'watch', eventId: `binance:Y${index}USDT:1` })
    expect((await watchPass([event()], r.deps)).asked).toEqual([event().id])
  })

  it('gives the day\'s last place to the strongest event of the minute', async () => {
    const r = rig({ watch: watch({ maxEventsPerDay: 5, models: [A] }) })
    for (let index = 0; index < 4; index++) r.rows.push({ at: T - 3600, source: 'watch', eventId: `binance:X${index}USDT:1` })
    const second = event('ETHUSDT', {}, 2)
    const first = event('SOLUSDT', {}, 1)
    const result = await watchPass([second, first], r.deps)
    expect(result.asked).toEqual([first.id])
    expect(result.skipped).toEqual([{ id: second.id, reason: 'The watch has asked about its 5 events for today.' }])
    expect(r.asked.map((call) => call.symbol)).toEqual(['SOLUSDT'])
  })

  it('counts an event it is still asking about, though the ledger has no row for it yet', async () => {
    const r = rig({ watch: watch({ maxEventsPerDay: 5, models: [A] }) })
    for (let index = 0; index < 4; index++) r.rows.push({ at: T - 3600, source: 'watch', eventId: `binance:X${index}USDT:1` })
    let release: () => void = () => undefined
    const answering = new Promise<void>((resolve) => {
      release = resolve
    })
    const slow: WatchDeps = {
      ...r.deps,
      ask: async (request) => {
        await answering
        return r.deps.ask(request)
      }
    }
    const first = watchPass([event('SOLUSDT')], slow)
    await new Promise((resolve) => setTimeout(resolve, 5))
    // The next minute's pass: the fifth place is taken by a call that has not come back.
    const second = await watchPass([event('SOLUSDT'), event('ETHUSDT')], slow)
    expect(second.skipped).toEqual([{ id: event('ETHUSDT').id, reason: 'The watch has asked about its 5 events for today.' }])
    release()
    await first
    expect(r.asked.map((call) => call.symbol)).toEqual(['SOLUSDT'])
  })

  it('asks about several events of one minute at once, each to every model', async () => {
    const r = rig()
    const result = await watchPass([event('SOLUSDT', {}, 1), event('ETHUSDT', {}, 2), event('BNBUSDT', {}, 3)], r.deps)
    expect(result.asked).toHaveLength(3)
    expect(r.asked).toHaveLength(6)
  })
})

describe('watchPass: the first model asked alone', () => {
  const gated = watch({ models: [A, B, C], firstModelGates: true })

  it('asks only the first model about an event it calls no trade', async () => {
    const r = rig({ watch: gated, answer: () => NO_TRADE })
    await watchPass([event()], r.deps)
    expect(r.asked.map((call) => call.model)).toEqual([A])
    expect(getWatchActivity().last?.text).toContain('Not passed on to the other 2 models.')
  })

  it('passes on an event the first model would trade', async () => {
    const r = rig({ watch: gated, answer: (model) => (model === A ? {} : NO_TRADE) })
    await watchPass([event()], r.deps)
    expect(r.asked.map((call) => call.model)).toEqual([A, B, C])
  })

  it('does not pass on a side taken below the confidence this app acts on, a refused answer, or a call that failed', async () => {
    for (const reply of [{ confidence: 0.64 }, { rejected: 'The stop is not below the entry range.', recommendation: 'hold' as const, detail: null }, new Error('timeout')]) {
      resetWatch()
      const r = rig({ watch: gated, answer: (model) => (model === A ? reply : {}) })
      await watchPass([event()], r.deps)
      expect(r.asked.map((call) => call.model)).toEqual([A])
    }
  })

  it('is not a gate with one model', async () => {
    const r = rig({ watch: watch({ models: [A], firstModelGates: true }), answer: () => NO_TRADE })
    await watchPass([event()], r.deps)
    expect(r.asked.map((call) => call.model)).toEqual([A])
    expect(getWatchActivity().last?.text).not.toContain('Not passed on')
  })
})

describe('watchPass: the notice', () => {
  it('raises one notice an event, however many models call a trade, and says nothing was placed', async () => {
    const r = rig({ watch: watch({ models: [A, B, C] }) })
    await watchPass([event()], r.deps)
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0].title).toBe('SOLUSDT: BUY')
    expect(r.notices[0].body).toContain('Nothing has been placed.')
  })

  it('raises one for each event that has a call to trade', async () => {
    const r = rig({ answer: (_model, symbol) => (symbol === 'ETHUSDT' ? NO_TRADE : {}) })
    await watchPass([event('SOLUSDT', {}, 1), event('ETHUSDT', {}, 2), event('BNBUSDT', {}, 3)], r.deps)
    expect(r.notices.map((notice) => notice.title).sort()).toEqual(['BNBUSDT: BUY', 'SOLUSDT: BUY'])
  })

  it('keeps the answer when the desktop cannot show the notice', async () => {
    const r = rig({ watch: watch({ models: [A] }) })
    const broken: WatchDeps = {
      ...r.deps,
      notify: () => {
        throw new Error('no notification service')
      }
    }
    await watchPass([event()], broken)
    expect(r.asked).toHaveLength(1)
    expect(getWatchActivity().last).toMatchObject({ ok: true })
    expect(getWatchActivity().last?.text).toContain('BUY at 80%')
  })

  it('raises none when no model would act', async () => {
    const r = rig({ answer: (model) => (model === A ? NO_TRADE : { confidence: 0.6 }) })
    await watchPass([event()], r.deps)
    expect(r.notices).toEqual([])
  })
})

describe('watchPass: paper trades', () => {
  const OPENED = { opened: true, text: 'A paper BUY of 100 USDT was opened, at market.' }

  it('hands each call the watch would act on to the paper trader, with its event', async () => {
    const r = rig({ answer: (model) => (model === B ? NO_TRADE : {}) })
    const handed: { symbol: string; model: string; side: string }[] = []
    r.deps.paperTrade = async (about, answer) => {
      handed.push({ symbol: about.symbol, model: answer.model, side: answer.recommendation })
      return null
    }
    await watchPass([event(), event('ETHUSDT')], r.deps)
    expect(handed.sort((a, b) => a.symbol.localeCompare(b.symbol))).toEqual([
      { symbol: 'ETHUSDT', model: A, side: 'buy' },
      { symbol: 'SOLUSDT', model: A, side: 'buy' }
    ])
  })

  it('hands over nothing this app would not act on: no trade, a side under 65%, a refused answer, a call that failed', async () => {
    const replies: Record<string, Partial<AiSignalDecision>> = {
      AUSDT: NO_TRADE,
      BUSDT: { confidence: 0.6 },
      CUSDT: { rejected: 'The stop is not below the entry range' },
      DUSDT: { error: 'overloaded', recommendation: 'hold', confidence: 0, detail: null }
    }
    const r = rig({ watch: watch({ models: [A] }), answer: (_model, symbol) => replies[symbol] })
    let handed = 0
    r.deps.paperTrade = async () => {
      handed++
      return OPENED
    }
    await watchPass(Object.keys(replies).map((symbol) => event(symbol)), r.deps)
    expect(r.asked).toHaveLength(4)
    expect(handed).toBe(0)
  })

  it('says what came of it on the Watch card, and leaves the plain notice out when a trade was opened', async () => {
    const r = rig()
    r.deps.paperTrade = async (_about, answer) => (answer.model === A ? OPENED : null)
    await watchPass([event()], r.deps)
    // The paper trader raises its own notice, which says more; the watch raises none beside it,
    // for this answer or for the other model's.
    expect(r.notices).toEqual([])
    expect(getWatchActivity().last?.text).toBe(
      'SOLUSDT breakout: openai/gpt-5-mini BUY at 80%; mistralai/mistral-small-2603 BUY at 80%. A paper BUY of 100 USDT was opened, at market.'
    )
  })

  it('still raises the plain notice when no paper trade was opened, and says why none was', async () => {
    const r = rig({ watch: watch({ models: [A] }) })
    r.deps.paperTrade = async () => ({ opened: false, text: "No paper trade: A paper trade of the watch's is still open on SOLUSDT." })
    await watchPass([event()], r.deps)
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0].body).toContain('Nothing has been placed')
    expect(getWatchActivity().last?.text).toContain("No paper trade: A paper trade of the watch's is still open on SOLUSDT.")
  })

  it('keeps an answer that was paid for when the paper trader fails, and says so', async () => {
    const r = rig({ watch: watch({ models: [A] }) })
    r.deps.paperTrade = async () => {
      throw new Error('settings could not be written')
    }
    const result = await watchPass([event()], r.deps)
    expect(result.asked).toEqual([event().id])
    expect(getWatchActivity().last).toMatchObject({ ok: true })
    expect(getWatchActivity().last?.text).toContain('No paper trade: settings could not be written')
    expect(r.notices).toHaveLength(1)
  })

  it('asks and notifies exactly as before with no paper trader given', async () => {
    const r = rig()
    expect(r.deps.paperTrade).toBeUndefined()
    await watchPass([event()], r.deps)
    expect(r.notices).toHaveLength(1)
    expect(getWatchActivity().last?.text).toBe('SOLUSDT breakout: openai/gpt-5-mini BUY at 80%; mistralai/mistral-small-2603 BUY at 80%.')
  })
})

describe('watchPass: a model that keeps failing', () => {
  const failing = (model: string, r: Rig): void => {
    for (let index = 0; index < 3; index++) r.rows.push({ at: T - 100 - index, source: 'watch', eventId: `binance:X${index}USDT:1`, model, status: 'failed' })
  }

  it('leaves out a model whose last three calls today failed, still asks the others, and says so', async () => {
    const r = rig()
    failing(B, r)
    const result = await watchPass([event()], r.deps)
    expect(result.asked).toEqual([event().id])
    expect(r.asked).toEqual([{ model: A, symbol: 'SOLUSDT', source: 'watch' }])
    expect(getWatchActivity().last?.text).toBe('SOLUSDT breakout: openai/gpt-5-mini BUY at 80%. Not asked: mistralai/mistral-small-2603, rested until midnight UTC.')
  })

  it('counts a refused answer like a failure, and an answer among the last three as a reason to go on', async () => {
    const refused = rig({ watch: watch({ models: [A] }) })
    for (let index = 0; index < 3; index++) refused.rows.push({ at: T - 100 - index, source: 'watch', eventId: `binance:X${index}USDT:1`, model: A, status: 'rejected' })
    expect((await watchPass([event()], refused.deps)).skipped[0].reason).toMatch(/failed or was refused on its last 3 calls/)
    resetWatch()
    const mixed = rig({ watch: watch({ models: [A] }) })
    mixed.rows.push({ at: T - 300, source: 'watch', eventId: 'binance:X0USDT:1', model: A, status: 'failed' })
    mixed.rows.push({ at: T - 200, source: 'watch', eventId: 'binance:X1USDT:1', model: A, status: 'ok' })
    mixed.rows.push({ at: T - 100, source: 'watch', eventId: 'binance:X2USDT:1', model: A, status: 'failed' })
    expect((await watchPass([event()], mixed.deps)).asked).toEqual([event().id])
  })

  it('takes up no event when every model it asks is left out, and asks nothing', async () => {
    const r = rig()
    failing(A, r)
    failing(B, r)
    const result = await watchPass([event()], r.deps)
    expect(result.asked).toEqual([])
    expect(result.skipped).toEqual([{ id: event().id, reason: 'Every model the watch asks has failed or been refused three times running today.' }])
    expect(r.asked).toEqual([])
    expect(r.fetches).toBe(0)
  })

  it('makes the next model the one asked alone when the first is left out', async () => {
    const r = rig({ watch: watch({ models: [A, B, C], firstModelGates: true }), answer: (model) => (model === B ? NO_TRADE : {}) })
    failing(A, r)
    await watchPass([event()], r.deps)
    // B is asked alone, calls no trade, and C is never asked.
    expect(r.asked.map((entry) => entry.model)).toEqual([B])
  })
})

describe('watchPass: when something fails', () => {
  it('asks the other models when one cannot be reached, and reports it', async () => {
    const r = rig({ answer: (model) => (model === A ? new Error("Error invoking remote method 'ai:askOpportunity': Error: The daily AI budget is used up.") : {}) })
    await watchPass([event()], r.deps)
    expect(r.asked.map((call) => call.model)).toEqual([A, B])
    const last = getWatchActivity().last
    expect(last?.ok).toBe(false)
    expect(last?.text).toContain('did not answer (The daily AI budget is used up.)')
    expect(last?.text).toContain('BUY at 80%')
  })

  it('asks nothing when the candles cannot be read, and takes the event up again while it is fresh', async () => {
    const r = rig({ candlesFail: true })
    expect((await watchPass([event()], r.deps)).asked).toEqual([event().id])
    expect(r.asked).toEqual([])
    expect(getWatchActivity().last).toMatchObject({ ok: false, symbol: 'SOLUSDT' })
    expect(getWatchActivity().last?.text).toContain('could not be read')
    r.state.candlesFail = false
    r.state.now = T + 70
    await watchPass([event()], r.deps)
    expect(r.asked).toHaveLength(2)
    // And not once it has gone stale.
    resetWatch()
    const late = rig({ candlesFail: true })
    await watchPass([event()], late.deps)
    late.state.candlesFail = false
    late.state.now = T + 400
    expect((await watchPass([event()], late.deps)).skipped[0].reason).toMatch(/minutes old/)
    expect(late.asked).toEqual([])
  })

  it('leaves the event for the next pass when the setting or the ledger cannot be read', async () => {
    const r = rig()
    const broken: WatchDeps = { ...r.deps, listCalls: async () => Promise.reject(new Error('the ledger could not be read')) }
    await expect(watchPass([event()], broken)).rejects.toThrow(/ledger/)
    expect(r.asked).toEqual([])
    expect((await watchPass([event()], r.deps)).asked).toEqual([event().id])
  })
})

describe('watch activity', () => {
  it('says which pairs are being asked about, and counts each event that finishes', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const r = rig({ watch: watch({ models: [A] }) })
    const slow: WatchDeps = {
      ...r.deps,
      ask: async (request) => {
        await gate
        return r.deps.ask(request)
      }
    }
    const seen: WatchActivity[] = []
    const stop = subscribeWatchActivity((activity) => seen.push(activity))
    const pass = watchPass([event()], slow)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(getWatchActivity()).toMatchObject({ asking: ['SOLUSDT'], answered: 0 })
    release()
    await pass
    stop()
    expect(getWatchActivity()).toMatchObject({ asking: [], answered: 1 })
    expect(getWatchActivity().last).toMatchObject({ symbol: 'SOLUSDT', ok: true, at: T + 10 })
    expect(getWatchActivity().last?.text).toContain('SOLUSDT breakout:')
    expect(seen.length).toBeGreaterThanOrEqual(2)
  })
})

describe('priceWatchCall', () => {
  const peeked: AiOpportunityPeek = {
    eventId: 'x',
    eventTime: T,
    models: [{ model: A, decision: null, perCallCostUsd: 0.002, costBasis: 'pricing', perCallLatencyMs: null }],
    budgetRemainingUsd: 1
  }

  it('prices a call on the newest event that has a question, and spends nothing', async () => {
    const peeks: AiOpportunityPeekRequest[] = []
    const result = await priceWatchCall([event('NEWUSDT'), event('OLDUSDT')], [A], {
      fetchCandles: async () => [],
      peek: async (request) => {
        peeks.push(request)
        return peeked
      }
    })
    expect(result).toBe(peeked)
    expect(peeks.map((request) => [request.symbol, request.models])).toEqual([['NEWUSDT', [A]]])
  })

  it('tries the next event when the newest cannot be read, and skips one with no direction', async () => {
    const tried: string[] = []
    const result = await priceWatchCall([event('SPIKEUSDT', { direction: 'none' }), event('BADUSDT'), event('GOODUSDT')], [A], {
      fetchCandles: async () => [],
      peek: async (request) => {
        tried.push(request.symbol)
        if (request.symbol === 'BADUSDT') throw new Error('These candles do not end in an event.')
        return peeked
      }
    })
    expect(result).toBe(peeked)
    expect(tried).toEqual(['BADUSDT', 'GOODUSDT'])
  })

  it('has nothing to price on with no event, and says why when none could be read', async () => {
    const quiet = { fetchCandles: async () => [], peek: async () => peeked }
    expect(await priceWatchCall([], [A], quiet)).toBeNull()
    await expect(
      priceWatchCall([event('AUSDT'), event('BUSDT'), event('CUSDT'), event('DUSDT')], [A], {
        fetchCandles: async () => [],
        peek: async (request) => Promise.reject(new Error(`No OpenRouter key (${request.symbol})`))
      })
    ).rejects.toThrow(/No OpenRouter key \(CUSDT\)/)
  })
})
