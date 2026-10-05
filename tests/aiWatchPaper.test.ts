import { describe, expect, it } from 'vitest'
import { aiProposalEntryExpiry, aiProposalEntryRange, aiProposalPositionParams, buildOpportunityProposal } from '../shared/aiProposal'
import type { AiSignalDecision, AiSignalDetail } from '../shared/aiSignal'
import {
  AI_WATCH_PAPER_OPEN_LIMITS,
  AI_WATCH_PAPER_STAKES,
  DEFAULT_AI_WATCH_PAPER,
  aiWatchPaperProblem,
  describeAiWatchPaper,
  describeWatchPaperOrigin,
  describeWatchPaperResult,
  describeWatchPaperTally,
  healAiWatchPaper,
  planWatchPaperTrade,
  watchPaperBlock,
  watchPaperExecutors,
  watchPaperNotice,
  watchPaperTally,
  type AiWatchPaperConfig,
  type WatchPaperOutcome,
  type WatchPaperPlan
} from '../shared/aiWatchPaper'
import type { Candle, ExecutorConfig, PaperAccount, PositionExecutorParams } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import { simulatePosition } from '../src/executors/engine'
import { openWatchPaperTrade, settleWatchPaperTrades, watchPaperExecutor, type WatchPaperDeps } from '../src/agents/watchPaperTrade'

// Paper trades from the watch: what it may open, its limits, and the one file that writes them.
// Everything that file touches is injected: the setting, the executors on file, the price, the
// candles, the paper account's settlement and the desktop notice.

const A = 'openai/gpt-5-mini'
const B = 'mistralai/mistral-small-2603'
const T = Date.parse('2026-10-05T09:07:00Z') / 1000
const SOON = T + 20

function config(overrides: Partial<AiWatchPaperConfig> = {}): AiWatchPaperConfig {
  return { enabled: true, model: A, stakeQuote: 100, maxOpen: 3, ...overrides }
}

function event(symbol = 'SOLUSDT', time = T): MarketEvent {
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
    live: { detectedAt: time + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 }
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
const SHORT: AiSignalDetail = { ...LONG, marketRegime: 'bear', stopLoss: 101.5, takeProfit: 97 }

function decision(model = A, overrides: Partial<AiSignalDecision> = {}): AiSignalDecision {
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
const sell = (model = A): AiSignalDecision => decision(model, { recommendation: 'sell', detail: SHORT })

function okPlan(input: { decision?: AiSignalDecision; lastPrice?: number | null; nowSec?: number; config?: AiWatchPaperConfig; symbol?: string } = {}): Extract<WatchPaperPlan, { ok: true }> {
  const plan = planWatchPaperTrade({
    config: input.config ?? config(),
    event: event(input.symbol),
    decision: input.decision ?? decision(),
    nowSec: input.nowSec ?? SOON,
    lastPrice: input.lastPrice === undefined ? 100 : input.lastPrice
  })
  if (!plan.ok) throw new Error(`expected a plan, got: ${plan.reason}`)
  return plan
}

const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 1 })
/** A few minutes of market after the answer: in the range, over it, under it, and back into it. */
const PATHS: Candle[][] = [
  [bar(SOON + 40, 100, 100.3, 99.9, 100.1), bar(SOON + 100, 100.1, 103.4, 100, 103.2)],
  [bar(SOON + 40, 100.9, 101.6, 100.8, 101.5), bar(SOON + 100, 101.5, 101.6, 100.1, 100.15), bar(SOON + 160, 100.15, 100.2, 98, 98.2)],
  [bar(SOON + 40, 99.4, 99.6, 98.9, 99), bar(SOON + 100, 99, 99.9, 98.95, 99.85), bar(SOON + 160, 99.85, 103.5, 99.8, 103.3)],
  [bar(SOON + 40, 99.4, 99.6, 98.9, 99), bar(T + 900, 100, 100.1, 99.9, 100)]
]

function executor(overrides: Partial<ExecutorConfig> & { symbol?: string; eventId?: string } = {}): ExecutorConfig {
  const symbol = overrides.symbol ?? 'SOLUSDT'
  return { ...watchPaperExecutor({ id: `e-${symbol}-${overrides.eventId ?? 'x'}`, event: event(symbol), plan: okPlan({ symbol }), nowSec: SOON }), ...overrides }
}

describe('the setting', () => {
  it('is off until switched on', () => {
    expect(DEFAULT_AI_WATCH_PAPER).toEqual({ enabled: false, model: null, stakeQuote: 100, maxOpen: 3 })
    expect(healAiWatchPaper(undefined, [A])).toEqual(DEFAULT_AI_WATCH_PAPER)
    expect(healAiWatchPaper('nonsense', [A])).toEqual(DEFAULT_AI_WATCH_PAPER)
  })

  it('reads back exactly what was switched on', () => {
    expect(healAiWatchPaper(config({ stakeQuote: 250, maxOpen: 5 }), [A, B])).toEqual(config({ stakeQuote: 250, maxOpen: 5 }))
  })

  it('is off when it is not exactly something that could have been switched on', () => {
    // The watch no longer asks the model it followed.
    expect(healAiWatchPaper(config(), [B])).toEqual({ enabled: false, model: null, stakeQuote: 100, maxOpen: 3 })
    // A stake and a limit that are not among the choices: the default, and off.
    expect(healAiWatchPaper(config({ stakeQuote: 123 }), [A])).toEqual({ enabled: false, model: A, stakeQuote: 100, maxOpen: 3 })
    expect(healAiWatchPaper(config({ maxOpen: 99 }), [A])).toEqual({ enabled: false, model: A, stakeQuote: 100, maxOpen: 3 })
    expect(healAiWatchPaper({ ...config(), enabled: 'yes' }, [A]).enabled).toBe(false)
  })

  it('can only be saved in a shape its confirmation could describe', () => {
    expect(aiWatchPaperProblem(config(), [A, B])).toBeNull()
    expect(aiWatchPaperProblem(config({ enabled: false, model: null }), [])).toBeNull()
    expect(aiWatchPaperProblem(config({ model: B }), [A])).toMatch(/not one of the models the watch asks/)
    expect(aiWatchPaperProblem(config({ model: null }), [A])).toMatch(/Choose the model/)
    expect(aiWatchPaperProblem(config({ stakeQuote: 7 }), [A])).toMatch(/stakes/)
    expect(aiWatchPaperProblem(config({ maxOpen: 4 }), [A])).toMatch(/at most/)
    expect(aiWatchPaperProblem({ ...config(), enabled: 1 as unknown as boolean }, [A])).toMatch(/on or off/)
    for (const stake of AI_WATCH_PAPER_STAKES) for (const open of AI_WATCH_PAPER_OPEN_LIMITS) expect(aiWatchPaperProblem(config({ stakeQuote: stake, maxOpen: open }), [A])).toBeNull()
  })

  it('says what switching it on does, that it is paper, and that it costs nothing', () => {
    const text = describeAiWatchPaper({ config: config({ stakeQuote: 250, maxOpen: 5 }), watchOn: true, hasPaperAccount: true })
    expect(text).toContain('each time openai/gpt-5-mini answers an event the watch put to it with BUY or SELL at 65% confidence or more, a PAPER position of 250')
    expect(text).toContain('with nobody pressing anything')
    expect(text).toContain('it enters in the first minute the price trades inside the range the model named, and is abandoned if that has not happened when its entry expires')
    expect(text).toContain('At most 5 open at once, one an event, and one on a pair at a time.')
    expect(text).toContain('When a position has closed, it is stopped, and its card on the Executors page says how it ended.')
    expect(text).toContain('Its result goes to the paper account, and a trade the paper account cannot fund is not opened.')
    expect(text).toContain('It is paper. Nothing is placed on an exchange, and this cannot be pointed at real money.')
    expect(text).toContain('It asks no model and costs nothing')
    expect(text).not.toContain('The watch itself is off')
    expect(text.trim().endsWith('Switch it on?')).toBe(true)
  })

  it('says so when nothing holds them to a balance, and when the watch is off', () => {
    const text = describeAiWatchPaper({ config: config(), watchOn: false, hasPaperAccount: false })
    expect(text).toContain('No paper account is set up, so their results are added to no balance, and nothing limits what these positions add up to.')
    // With no account there is nowhere for a result to go, and it does not say there is.
    expect(text).not.toContain('goes to the paper account')
    expect(text).toContain('its card on the Executors page says how it ended.')
    expect(text).toContain('The watch itself is off, so nothing will be opened until it is switched on.')
  })
})

describe('planWatchPaperTrade', () => {
  it('opens what the Paper trade button would have filled in, at the stake in the setting', () => {
    for (const [answer, price] of [
      [decision(), 100],
      [decision(), 100.9],
      [decision(), 99.5],
      [sell(), 100],
      [sell(), 99.2]
    ] as [AiSignalDecision, number][]) {
      const plan = okPlan({ decision: answer, lastPrice: price })
      const proposal = buildOpportunityProposal({ event: event(), decision: answer, nowSec: SOON, lastPrice: price })
      if (proposal === null) throw new Error('expected a proposal')
      // The paper form, submitted as the recommendation filled it in: its fields, and the expiry
      // and the range that are stamped on at the click.
      const form: PositionExecutorParams = aiProposalPositionParams(proposal, { side: 'buy', entryPrice: null, amountQuote: 100, takeProfitPct: 9, stopLossPct: 9, timeLimitSec: 9, trailingStop: null })
      const submitted: PositionExecutorParams = { ...form, entryExpiresAt: aiProposalEntryExpiry(proposal, 'paper'), entryRange: aiProposalEntryRange(proposal, 'paper', form.entryPrice) }
      expect(submitted.entryRange).toEqual({ min: 99.8, max: 100.2 })
      // The one difference is a field nothing reads while a range is there.
      expect(plan.params).toEqual({ ...submitted, entryPrice: null })
      for (const bars of PATHS) expect(simulatePosition(bars, plan.params)).toEqual(simulatePosition(bars, submitted))
    }
  })

  it('enters by the range the model named wherever the price is now, and names no entry price', () => {
    for (const price of [100.1, 100.9, 99.5, null]) {
      const { params } = okPlan({ lastPrice: price })
      expect(params.entryRange).toEqual({ min: 99.8, max: 100.2 })
      expect(params.entryPrice).toBeNull()
    }
    expect(okPlan({ decision: sell(), lastPrice: 99.2 }).params).toMatchObject({ entryRange: { min: 99.8, max: 100.2 }, entryPrice: null })
  })

  it('does not enter under a range the price has fallen out of, and does not chase one it has run from', () => {
    // The case a check in the app turned up: the answer arrives with the price already under the
    // range. The first version opened a buy "waiting" at the range's edge, which is a limit above
    // the market, filled at the next open: a position the recommendation never entered.
    const fell: Candle[] = [bar(SOON + 40, 99.4, 99.6, 98.9, 99), bar(SOON + 100, 99, 99.1, 98.7, 98.8)]
    expect(simulatePosition(fell, okPlan({ lastPrice: 99.5 }).params)).toMatchObject({ status: 'pending', entryPrice: null })
    // And the other way: inside the range when the answer came, gone by the next minute.
    const ran: Candle[] = [bar(SOON + 40, 100.9, 101.6, 100.8, 101.5), bar(SOON + 100, 101.5, 102.4, 101.4, 102.3)]
    expect(simulatePosition(ran, okPlan({ lastPrice: 100.1 }).params)).toMatchObject({ status: 'pending', entryPrice: null })
    // It enters when the price comes back into the range, at the edge it comes in by.
    const back: Candle[] = [...fell, bar(SOON + 160, 98.8, 99.9, 98.75, 99.85)]
    expect(simulatePosition(back, okPlan({ lastPrice: 99.5 }).params)).toMatchObject({ status: 'open', entryPrice: 99.8, enteredAt: SOON + 160 })
  })

  it('carries the model\'s stop, target and hold, and the expiry of its entry', () => {
    const plan = okPlan()
    expect(plan.params).toMatchObject({ side: 'buy', amountQuote: 100, stopLossPct: 1.5, takeProfitPct: 3, timeLimitSec: 3600, trailingStop: null, entryExpiresAt: T + 900 })
    expect(plan.mark).toEqual({ eventId: event().id, eventTime: T, model: A, confidence: 0.8 })
    expect(plan.name).toBe('Watch: BUY SOLUSDT')
    expect(plan.side).toBe('buy')
  })

  it('opens a short as a sell, on paper like the rest', () => {
    const plan = okPlan({ decision: sell() })
    expect(plan.params).toMatchObject({ side: 'sell', stopLossPct: 1.5, takeProfitPct: 3 })
    expect(plan.name).toBe('Watch: SELL SOLUSDT')
  })

  it('never names leverage, whatever the answer says', () => {
    expect('leverage' in okPlan().params).toBe(false)
    expect('leverage' in okPlan({ decision: sell() }).params).toBe(false)
  })

  it.each<[string, AiSignalDecision, number, number, RegExp]>([
    ['a call not to trade', decision(A, { recommendation: 'hold', detail: null }), 100, SOON, /no trade/],
    ['a refused answer', decision(A, { rejected: 'The stop is not below the entry range' }), 100, SOON, /refused/],
    ['a model that was not reached', decision(A, { error: 'overloaded' }), 100, SOON, /not reached/],
    ['a call under 65%', decision(A, { confidence: 0.6 }), 100, SOON, /below the 65%/],
    ['an entry that has expired', decision(), 100, T + 900, /expired/],
    ['a price through the stop', decision(), 98.4, SOON, /through its stop/],
    ['a price at the target', decision(), 103.1, SOON, /reached its target/],
    ['a short with the price through its stop', sell(), 101.6, SOON, /through its stop/]
  ])('opens nothing on %s', (_what, answer, price, nowSec, reason) => {
    const plan = planWatchPaperTrade({ config: config(), event: event(), decision: answer, nowSec, lastPrice: price })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toMatch(reason)
  })

  it('opens nothing when one of the model\'s levels cannot be used, where the form would have shown its own', () => {
    // A stop sixty percent away is not carried into a form; nobody is looking at this one.
    const wild = decision(A, { detail: { ...LONG, stopLoss: 40 } })
    const plan = planWatchPaperTrade({ config: config(), event: event(), decision: wild, nowSec: SOON, lastPrice: 100 })
    expect(plan).toEqual({ ok: false, reason: 'Its stop or its target is not a usable distance from the entry.' })
  })
})

describe('watchPaperBlock', () => {
  const check = (executors: ExecutorConfig[], overrides: { config?: AiWatchPaperConfig; symbol?: string; model?: string } = {}): string | null =>
    watchPaperBlock({ config: overrides.config ?? config(), event: event(overrides.symbol), decision: { model: overrides.model ?? A }, executors })

  it('allows a trade with nothing in the way', () => {
    expect(check([])).toBeNull()
  })

  it('follows one model, and only while it is switched on', () => {
    expect(check([], { model: B })).toMatch(/follow openai\/gpt-5-mini/)
    expect(check([], { config: config({ enabled: false }) })).toMatch(/are off/)
    expect(check([], { config: config({ model: null }) })).toMatch(/are off/)
  })

  it('opens one paper trade an event, even after the first has been stopped', () => {
    const first = executor({ watch: { eventId: event().id, eventTime: T, model: A, confidence: 0.8 } })
    expect(check([first])).toMatch(/already opened for this event/)
    expect(check([{ ...first, status: 'stopped', stoppedAt: T + 60 }])).toMatch(/already opened for this event/)
  })

  it('keeps one open on a pair at a time, and lets the next in once it has stopped', () => {
    const earlier = executor({ watch: { eventId: 'binance:SOLUSDT:1', eventTime: 1, model: A, confidence: 0.8 } })
    expect(check([earlier])).toMatch(/still open on SOLUSDT/)
    expect(check([{ ...earlier, status: 'stopped', stoppedAt: T }])).toBeNull()
    // Another pair is another matter.
    expect(check([earlier], { symbol: 'ETHUSDT' })).toBeNull()
  })

  it('keeps so many open at once and no more', () => {
    const open = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'].map((symbol) => executor({ symbol, watch: { eventId: `binance:${symbol}:1`, eventTime: 1, model: A, confidence: 0.8 } }))
    expect(check(open)).toMatch(/3 paper trades open, and 3 is the most/)
    expect(check(open, { config: config({ maxOpen: 5 }) })).toBeNull()
    expect(check([open[0], open[1], { ...open[2], status: 'stopped', stoppedAt: T }])).toBeNull()
  })

  it('counts only its own paper trades: not one made by hand, and never one that is not paper', () => {
    const byHand = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT'].map((symbol) => ({ ...executor({ symbol }), watch: undefined }))
    expect(check(byHand)).toBeNull()
    const real = { ...executor(), mode: 'live' as const }
    expect(watchPaperExecutors([real, ...byHand])).toEqual([])
    expect(check([real])).toBeNull()
  })
})

describe('watchPaperExecutor', () => {
  it.each<[string, AiSignalDecision]>([
    ['a BUY', decision()],
    ['a SELL', sell()]
  ])('makes %s a paper position with no leverage and nothing live about it', (_what, answer) => {
    const made = watchPaperExecutor({ id: 'id-1', event: event(), plan: okPlan({ decision: answer }), nowSec: SOON })
    expect(made).toMatchObject({
      id: 'id-1',
      type: 'position',
      mode: 'paper',
      status: 'active',
      keepPosition: false,
      exchange: 'binance',
      symbol: 'SOLUSDT',
      quoteAsset: 'USDT',
      createdAt: SOON,
      liveOrder: null,
      pendingLiveOrderIds: [],
      liveWatcherId: null,
      liveExitResult: null,
      liveTwapRunId: null,
      watch: { eventId: event().id, model: A }
    })
    expect((made.params as PositionExecutorParams).leverage).toBeUndefined()
    expect((made.params as PositionExecutorParams).side).toBe(answer.recommendation === 'buy' ? 'buy' : 'sell')
    expect(made.proposedBy).toBeUndefined()
    // And the engine runs it as it runs any paper position.
    const bars: Candle[] = [{ time: SOON + 40, open: 100, high: 100.3, low: 99.9, close: 100.1, volume: 1 }]
    expect(simulatePosition(bars, made.params as PositionExecutorParams)).toMatchObject({ status: 'open', entryPrice: 100, leverage: 1, liquidationPrice: null })
  })
})

interface Rig {
  deps: WatchPaperDeps
  state: {
    config: AiWatchPaperConfig
    executors: ExecutorConfig[]
    account: PaperAccount | null
    price: number | null | Error
    now: number
    candles: Candle[] | Error
  }
  notices: { title: string; body: string }[]
  settled: string[]
  writes: number
}

function rig(initial: Partial<Rig['state']> = {}): Rig {
  const state: Rig['state'] = { config: config(), executors: [], account: null, price: 100, now: SOON, candles: [], ...initial }
  const made: Rig = { deps: undefined as unknown as WatchPaperDeps, state, notices: [], settled: [], writes: 0 }
  let tail: Promise<unknown> = Promise.resolve()
  let ids = 0
  made.deps = {
    getConfig: async () => ({ watchPaper: state.config }),
    getSettings: async () => ({ executors: [...state.executors], paperAccount: state.account }),
    setExecutors: async (executors) => {
      made.writes++
      state.executors = executors
    },
    lastPrice: async () => {
      if (state.price instanceof Error) throw state.price
      return state.price
    },
    fetchCandles: async () => {
      if (state.candles instanceof Error) throw state.candles
      return state.candles
    },
    settle: async (target) => {
      made.settled.push(target.id)
    },
    notify: (title, body) => {
      made.notices.push({ title, body })
    },
    nowSec: () => state.now,
    newId: () => `paper-${++ids}`,
    queue: <T>(work: () => Promise<T>): Promise<T> => {
      const run = tail.then(work)
      tail = run.catch(() => undefined)
      return run
    }
  }
  return made
}

function account(usdt: number): PaperAccount {
  return { balances: { USDT: usdt }, ledger: [], createdAt: T - 86_400, updatedAt: T - 86_400 } as unknown as PaperAccount
}

describe('openWatchPaperTrade', () => {
  it('says nothing while paper trades are off, and nothing about another model\'s answer', async () => {
    const off = rig({ config: config({ enabled: false }) })
    expect(await openWatchPaperTrade(event(), decision(), off.deps)).toBeNull()
    const other = rig()
    expect(await openWatchPaperTrade(event(), decision(B), other.deps)).toBeNull()
    expect(off.state.executors).toEqual([])
    expect(other.state.executors).toEqual([])
    expect(off.writes + other.writes).toBe(0)
  })

  it('opens one paper position, says so on the desktop, and says nothing real was placed', async () => {
    const r = rig()
    const result = await openWatchPaperTrade(event(), decision(), r.deps)
    expect(result).toEqual({ opened: true, text: 'A paper BUY of 100 USDT was opened, to enter between 99.8 and 100.2.' })
    expect(r.state.executors).toHaveLength(1)
    expect(r.state.executors[0]).toMatchObject({ id: 'paper-1', mode: 'paper', type: 'position', name: 'Watch: BUY SOLUSDT', watch: { eventId: event().id, model: A } })
    expect(r.notices).toHaveLength(1)
    expect(r.notices[0].title).toBe('SOLUSDT: paper BUY opened')
    expect(r.notices[0].body).toContain('A paper position of 100 USDT was opened to enter between 99.8 and 100.2, with its stop 1.5% away and its target 3%.')
    expect(r.notices[0].body).toContain('Nothing real has been placed.')
  })

  it('opens a short on paper, to enter by the same range when the price has left it', async () => {
    const r = rig({ price: 99.2 })
    const result = await openWatchPaperTrade(event(), sell(), r.deps)
    expect(result).toEqual({ opened: true, text: 'A paper SELL of 100 USDT was opened, to enter between 99.8 and 100.2.' })
    expect(r.state.executors[0].params).toMatchObject({ side: 'sell', entryPrice: null, entryRange: { min: 99.8, max: 100.2 }, entryExpiresAt: T + 900 })
    expect(r.notices[0].title).toBe('SOLUSDT: paper SELL opened')
    expect(r.notices[0].body).toContain('to enter between 99.8 and 100.2')
  })

  it('uses the event\'s own price when the price now cannot be had', async () => {
    const r = rig({ price: new Error('the exchange did not answer') })
    expect((await openWatchPaperTrade(event(), decision(), r.deps))?.opened).toBe(true)
    expect((r.state.executors[0].params as PositionExecutorParams).entryPrice).toBeNull()
  })

  it('opens nothing, and says why, when its limits or the price are in the way', async () => {
    const through = rig({ price: 98.4 })
    expect(await openWatchPaperTrade(event(), decision(), through.deps)).toEqual({ opened: false, text: 'No paper trade: The price had already gone through its stop.' })
    const full = rig({ executors: ['BTCUSDT', 'ETHUSDT', 'XRPUSDT'].map((symbol) => executor({ symbol, watch: { eventId: `binance:${symbol}:1`, eventTime: 1, model: A, confidence: 0.8 } })) })
    expect((await openWatchPaperTrade(event(), decision(), full.deps))?.text).toMatch(/^No paper trade: The watch has 3 paper trades open/)
    expect(through.state.executors).toEqual([])
    expect(full.state.executors).toHaveLength(3)
    expect(through.notices.length + full.notices.length).toBe(0)
  })

  it('opens nothing the paper account cannot fund, and says by how much', async () => {
    const short = rig({ account: account(60) })
    const result = await openWatchPaperTrade(event(), decision(), short.deps)
    expect(result?.opened).toBe(false)
    expect(result?.text).toMatch(/^No paper trade: /)
    expect(result?.text).toMatch(/USDT/)
    expect(short.state.executors).toEqual([])
    // With the money there, it opens.
    const funded = rig({ account: account(500) })
    expect((await openWatchPaperTrade(event(), decision(), funded.deps))?.opened).toBe(true)
    // And funds already out working are not counted twice.
    const committed = rig({ account: account(150), executors: [executor({ symbol: 'BTCUSDT', watch: { eventId: 'binance:BTCUSDT:1', eventTime: 1, model: A, confidence: 0.8 } })] })
    expect((await openWatchPaperTrade(event(), decision(), committed.deps))?.opened).toBe(false)
  })

  it('opens one trade when two answers about one event arrive together', async () => {
    const r = rig()
    const results = await Promise.all([openWatchPaperTrade(event(), decision(), r.deps), openWatchPaperTrade(event(), decision(), r.deps)])
    expect(results.filter((result) => result?.opened)).toHaveLength(1)
    expect(results.find((result) => !result?.opened)?.text).toMatch(/already opened for this event/)
    expect(r.state.executors).toHaveLength(1)
  })

  it('opens one trade on a pair when two of its events arrive together', async () => {
    const r = rig()
    const results = await Promise.all([openWatchPaperTrade(event('SOLUSDT', T), decision(), r.deps), openWatchPaperTrade(event('SOLUSDT', T + 60), decision(), r.deps)])
    expect(results.filter((result) => result?.opened)).toHaveLength(1)
    expect(r.state.executors).toHaveLength(1)
  })

  it('does not lose a trade it opened to a desktop that cannot show a notice', async () => {
    const r = rig()
    r.deps.notify = (): void => {
      throw new Error('no notification centre')
    }
    expect((await openWatchPaperTrade(event(), decision(), r.deps))?.opened).toBe(true)
    expect(r.state.executors).toHaveLength(1)
  })
})

describe('settleWatchPaperTrades', () => {
  /** A paper trade opened at SOON, and the minutes after it. */
  const start = Math.ceil(SOON / 60) * 60
  const trade = (overrides: Partial<ExecutorConfig> = {}, plan = okPlan()): ExecutorConfig => ({ ...watchPaperExecutor({ id: 'w1', event: event(), plan, nowSec: SOON }), ...overrides })

  it('stops and settles a position its target has closed', async () => {
    const r = rig({ executors: [trade()], now: start + 300, candles: [bar(start, 100, 100.4, 99.9, 100.2), bar(start + 60, 100.2, 103.5, 100.1, 103.2)] })
    expect(await settleWatchPaperTrades(r.deps)).toEqual(['Watch: BUY SOLUSDT'])
    expect(r.state.executors[0]).toMatchObject({ status: 'stopped', stoppedAt: start + 300 })
    expect(r.settled).toEqual(['w1'])
  })

  it('writes on it how it ended: the exit, the minute, and what a stake of 100 made after fees', async () => {
    const candles = [bar(start, 100, 100.4, 99.9, 100.2), bar(start + 60, 100.2, 103.5, 100.1, 103.2)]
    const r = rig({ executors: [trade()], now: start + 300, candles })
    await settleWatchPaperTrades(r.deps)
    const mark = r.state.executors[0].watch
    expect(mark?.result).toMatchObject({ exit: 'take_profit', closedAt: start + 60 })
    // The engine's own figure for the same candles: a 3% target on 100, less a fee on each fill.
    const simulated = simulatePosition(candles, trade().params as PositionExecutorParams)
    expect(mark?.result?.pnlQuote).toBe(simulated.realizedPnl)
    expect(mark?.result?.pnlQuote).toBeGreaterThan(2.7)
    expect(mark?.result?.pnlQuote).toBeLessThan(3)
    // And what it was opened on is still there beside it.
    expect(mark).toMatchObject({ eventId: event().id, eventTime: T, model: A, confidence: 0.8 })
  })

  it('stops and settles one its stop has closed, and one whose time ran out', async () => {
    const stopped = rig({ executors: [trade()], now: start + 300, candles: [bar(start, 100, 100.1, 98.2, 98.4)] })
    expect(await settleWatchPaperTrades(stopped.deps)).toHaveLength(1)
    expect(stopped.state.executors[0].watch?.result).toMatchObject({ exit: 'stop_loss', closedAt: start })
    expect(stopped.state.executors[0].watch?.result?.pnlQuote).toBeLessThan(-1.5)
    const timed = rig({ executors: [trade()], now: start + 4000, candles: [bar(start, 100, 100.4, 99.9, 100.2), bar(start + 3600, 100.2, 100.4, 100, 100.3)] })
    expect(await settleWatchPaperTrades(timed.deps)).toHaveLength(1)
    expect(timed.state.executors[0].status).toBe('stopped')
    expect(timed.state.executors[0].watch?.result).toMatchObject({ exit: 'time_limit', closedAt: start + 3600 })
  })

  it('stops one whose entry expired unfilled, which bought nothing', async () => {
    const waiting = trade({}, okPlan({ lastPrice: 100.9 }))
    expect((waiting.params as PositionExecutorParams).entryRange).toEqual({ min: 99.8, max: 100.2 })
    const r = rig({ executors: [waiting], now: T + 1200, candles: [bar(start, 100.9, 101.2, 100.6, 101), bar(T + 900, 101, 101.3, 100.8, 101.1)] })
    expect(await settleWatchPaperTrades(r.deps)).toEqual(['Watch: BUY SOLUSDT'])
    expect(r.state.executors[0].status).toBe('stopped')
    expect(r.state.executors[0].watch?.result).toEqual({ exit: 'entry_expired', pnlQuote: 0, closedAt: T + 900 })
  })

  it('leaves alone a position still open, and one still waiting to enter', async () => {
    const open = rig({ executors: [trade()], now: start + 300, candles: [bar(start, 100, 100.4, 99.9, 100.2), bar(start + 60, 100.2, 100.6, 100, 100.4)] })
    expect(await settleWatchPaperTrades(open.deps)).toEqual([])
    expect(open.state.executors[0].status).toBe('active')
    const waiting = rig({ executors: [trade({}, okPlan({ lastPrice: 100.9 }))], now: start + 300, candles: [bar(start, 100.9, 101.2, 100.6, 101)] })
    expect(await settleWatchPaperTrades(waiting.deps)).toEqual([])
    expect(open.settled.length + waiting.settled.length).toBe(0)
  })

  it('judges a position on minutes that have closed, not on one still forming', async () => {
    // The minute that would stop it is still open: its low is not a fact yet.
    const r = rig({ executors: [trade()], now: start + 90, candles: [bar(start, 100, 100.4, 99.9, 100.2), bar(start + 60, 100.2, 100.3, 98, 98.2)] })
    expect(await settleWatchPaperTrades(r.deps)).toEqual([])
    r.state.now = start + 120
    expect(await settleWatchPaperTrades(r.deps)).toHaveLength(1)
  })

  it('touches only the watch\'s own paper trades', async () => {
    const byHand = { ...trade({ id: 'hand' }), watch: undefined }
    const real = { ...trade({ id: 'real' }), mode: 'live' as const }
    const r = rig({ executors: [byHand, real], now: start + 300, candles: [bar(start, 100, 104, 99.9, 103.5)] })
    expect(await settleWatchPaperTrades(r.deps)).toEqual([])
    expect(r.state.executors.map((entry) => entry.status)).toEqual(['active', 'active'])
    expect(r.writes).toBe(0)
  })

  it('leaves one somebody stopped or deleted by hand while its candles were being read', async () => {
    const r = rig({ executors: [trade()], now: start + 300, candles: [bar(start, 100, 104, 99.9, 103.5)] })
    const fetch = r.deps.fetchCandles
    r.deps.fetchCandles = async (...args) => {
      // Stopped by hand in the meantime: the page settled it, and it must not be settled again.
      r.state.executors = r.state.executors.map((entry) => ({ ...entry, status: 'stopped' as const, stoppedAt: start + 200 }))
      return fetch(...args)
    }
    expect(await settleWatchPaperTrades(r.deps)).toEqual([])
    expect(r.settled).toEqual([])
    expect(r.state.executors[0].stoppedAt).toBe(start + 200)
    // Nobody simulated it to its end, so nothing says how it ended.
    expect(r.state.executors[0].watch?.result).toBeUndefined()
  })

  it('goes on to the next trade when one cannot be read, and tries that one again later', async () => {
    const first = trade({ id: 'w1', symbol: 'BADUSDT', name: 'Watch: BUY BADUSDT' })
    const second = trade({ id: 'w2', symbol: 'ETHUSDT', name: 'Watch: BUY ETHUSDT' })
    const r = rig({ executors: [first, second], now: start + 300 })
    r.deps.fetchCandles = async (_exchange, symbol) => {
      if (symbol === 'BADUSDT') throw new Error('the exchange did not answer')
      return [bar(start, 100, 104, 99.9, 103.5)]
    }
    expect(await settleWatchPaperTrades(r.deps)).toEqual(['Watch: BUY ETHUSDT'])
    expect(r.state.executors.map((entry) => entry.status)).toEqual(['active', 'stopped'])
  })

  it('settles a trade once when two passes overlap', async () => {
    const r = rig({ executors: [trade()], now: start + 300, candles: [bar(start, 100, 104, 99.9, 103.5)] })
    const [first, second] = await Promise.all([settleWatchPaperTrades(r.deps), settleWatchPaperTrades(r.deps)])
    expect([first.length, second.length].sort()).toEqual([0, 1])
    expect(r.settled).toEqual(['w1'])
    expect(r.writes).toBe(1)
  })
})

describe('how the watch\'s paper trades ended', () => {
  const ended = (symbol: string, result: WatchPaperOutcome, overrides: Partial<ExecutorConfig> = {}): ExecutorConfig => {
    const base = executor({ symbol })
    return { ...base, status: 'stopped', stoppedAt: T + 4000, watch: { ...base.watch!, result }, ...overrides }
  }
  const won: WatchPaperOutcome = { exit: 'take_profit', pnlQuote: 3.78601, closedAt: T + 660 }
  const lost: WatchPaperOutcome = { exit: 'stop_loss', pnlQuote: -1.7, closedAt: T + 300 }
  const never: WatchPaperOutcome = { exit: 'entry_expired', pnlQuote: 0, closedAt: T + 900 }

  it('says on a card how one ended and what it made or lost', () => {
    expect(describeWatchPaperResult(won, 'USDT')).toBe('Target reached: +3.786 USDT after fees.')
    expect(describeWatchPaperResult(lost, 'USDT')).toBe('Stopped out: -1.7 USDT after fees.')
    expect(describeWatchPaperResult({ exit: 'time_limit', pnlQuote: 0.4, closedAt: T }, 'FDUSD')).toBe('Time ran out: +0.4 FDUSD after fees.')
    // One that bought nothing has no figure to show, and is not shown a zero as if it were one.
    expect(describeWatchPaperResult(never, 'USDT')).toBe('Never entered: the price did not trade in its entry range before it expired.')
  })

  it('says on a card where the trade came from, and that it is paper', () => {
    expect(describeWatchPaperOrigin(executor().watch!)).toBe('Opened by the watch, with nobody pressing anything, on a call by openai/gpt-5-mini (80% confidence, 09:07 UTC event). Paper.')
  })

  it('adds up the ones that have ended, from what is written on them', () => {
    const tally = watchPaperTally([
      ended('BTCUSDT', won),
      ended('ETHUSDT', lost),
      ended('XRPUSDT', never),
      // Still open, and one a person stopped: neither has ended with a result.
      executor({ symbol: 'ADAUSDT' }),
      executor({ symbol: 'DOGEUSDT', status: 'stopped', stoppedAt: T + 50 })
    ])
    expect(tally).toMatchObject({ ended: 3, entered: 2, ahead: 1 })
    expect(tally.pnl).toHaveLength(1)
    expect(tally.pnl[0].asset).toBe('USDT')
    expect(tally.pnl[0].amount).toBeCloseTo(2.08601, 8)
    expect(describeWatchPaperTally(tally)).toBe('3 have ended: 2 entered, 1 of them ahead, +2.086 USDT in all after fees.')
  })

  it('counts nothing that is not a paper trade of the watch\'s, whatever is written on it', () => {
    const live = ended('BTCUSDT', won, { mode: 'live' })
    const grid = ended('ETHUSDT', won, { type: 'grid' })
    // Nor one that is still running: a result on it is not one the watch wrote when it stopped it.
    const running = ended('SOLUSDT', won, { status: 'active', stoppedAt: null })
    expect(watchPaperTally([live, grid, running])).toEqual({ ended: 0, entered: 0, ahead: 0, pnl: [] })
  })

  it('keeps each quote asset\'s sum apart', () => {
    const tally = watchPaperTally([ended('BTCUSDT', won), ended('ETHBTC', { exit: 'stop_loss', pnlQuote: -0.002, closedAt: T }, { quoteAsset: 'BTC' }), ended('SOLUSDT', lost)])
    expect(tally.pnl.map((entry) => entry.asset)).toEqual(['USDT', 'BTC'])
    expect(describeWatchPaperTally(tally)).toBe('3 have ended: 3 entered, 1 of them ahead, +2.086 USDT and -0.002 BTC in all after fees.')
  })

  it('says so plainly when none entered, and nothing when none has ended', () => {
    expect(describeWatchPaperTally(watchPaperTally([ended('BTCUSDT', never)]))).toBe('1 has ended, and it never entered.')
    expect(describeWatchPaperTally(watchPaperTally([ended('BTCUSDT', never), ended('ETHUSDT', never)]))).toBe('2 have ended, and none entered.')
    expect(describeWatchPaperTally(watchPaperTally([executor()]))).toBe('')
    expect(describeWatchPaperTally(watchPaperTally([ended('BTCUSDT', won)]))).toBe('1 has ended: 1 entered, 1 of them ahead, +3.786 USDT in all after fees.')
  })
})

describe('watchPaperNotice', () => {
  it('is keyed apart from the recommendation\'s own notice, so both can be raised for one event', () => {
    const notice = watchPaperNotice(event(), okPlan())
    expect(notice.key).toBe(`${event().id}:paper`)
    expect(notice.body).toContain('openai/gpt-5-mini at 80% confidence, on the breakout at 09:07 UTC.')
    expect(notice.body).toContain('It is on the Executors page.')
  })
})
