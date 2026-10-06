import { describe, expect, it } from 'vitest'
import { aiProposalEntryExpiry, aiProposalEntryRange, aiProposalPositionParams, buildOpportunityProposal } from '../shared/aiProposal'
import type { AiSignalDecision, AiSignalDetail } from '../shared/aiSignal'
import {
  AI_WATCH_PAPER_BTC_MOVES,
  AI_WATCH_PAPER_LOSING_RUNS,
  AI_WATCH_PAPER_OPEN_LIMITS,
  AI_WATCH_PAPER_SAME_SIDE_LIMITS,
  AI_WATCH_PAPER_STAKES,
  DEFAULT_AI_WATCH_PAPER,
  aiWatchPaperProblem,
  btcMoveAgainst,
  describeAiWatchPaper,
  describeWatchPaperOrigin,
  describeWatchPaperResult,
  describeWatchPaperSafeguards,
  describeWatchPaperTally,
  healAiWatchPaper,
  planWatchPaperTrade,
  watchPaperBlock,
  watchPaperExecutors,
  watchPaperNotice,
  watchPaperPause,
  watchPaperTally,
  type AiWatchPaperConfig,
  type WatchPaperOutcome,
  type WatchPaperPlan
} from '../shared/aiWatchPaper'
import type { Candle, ExecutorConfig, PaperAccount, PaperPauseSettings, PaperRiskSettings, PositionExecutorParams } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import type { LiveBook } from '../shared/liveMarket'
import { DEFAULT_PAPER_PAUSE, resumePaperPause } from '../shared/paperPause'
import { riskedAtStop } from '../shared/paperRisk'
import { simulatePosition } from '../src/executors/engine'
import { openWatchPaperTrade, settleWatchPaperTrades, watchPaperExecutor, type WatchPaperDeps, type WatchPaperResult } from '../src/agents/watchPaperTrade'

// Paper trades from the watch: what it may open, its limits, and the one file that writes them.
// Everything that file touches is injected: the setting, the executors on file, the price, the
// candles, the paper account's settlement and the desktop notice.

const A = 'openai/gpt-5-mini'
const B = 'mistralai/mistral-small-2603'
const T = Date.parse('2026-10-05T09:07:00Z') / 1000
const SOON = T + 20

/** Each trade at its own stake, with no cap: how the watch's own rules are held here. Sizing by
 * risk and the cap on what the app's own paper trades have out (shared/paperRisk.ts) are held below,
 * under their own heading. */
const STAKE: PaperRiskSettings = { sizing: 'stake', riskQuote: 1, maxOutQuote: null }

function config(overrides: Partial<AiWatchPaperConfig> = {}): AiWatchPaperConfig {
  return { enabled: true, model: A, stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 3, dropOnBtcMovePct: 1, ...overrides }
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

function okPlan(input: { decision?: AiSignalDecision; lastPrice?: number | null; nowSec?: number; config?: AiWatchPaperConfig; symbol?: string; risk?: PaperRiskSettings } = {}): Extract<WatchPaperPlan, { ok: true }> {
  const plan = planWatchPaperTrade({
    config: input.config ?? config(),
    risk: input.risk ?? STAKE,
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
    expect(DEFAULT_AI_WATCH_PAPER).toEqual({ enabled: false, model: null, stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 3, dropOnBtcMovePct: 1 })
    expect(healAiWatchPaper(undefined, [A])).toEqual(DEFAULT_AI_WATCH_PAPER)
    expect(healAiWatchPaper('nonsense', [A])).toEqual(DEFAULT_AI_WATCH_PAPER)
  })

  it('reads back exactly what was switched on', () => {
    expect(healAiWatchPaper(config({ stakeQuote: 250, maxOpen: 5 }), [A, B])).toEqual(config({ stakeQuote: 250, maxOpen: 5 }))
  })

  it('is off when it is not exactly something that could have been switched on', () => {
    // The watch no longer asks the model it followed.
    expect(healAiWatchPaper(config(), [B])).toEqual({ enabled: false, model: null, stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 3, dropOnBtcMovePct: 1 })
    // A stake and a limit that are not among the choices: the default, and off.
    expect(healAiWatchPaper(config({ stakeQuote: 123 }), [A])).toEqual({ enabled: false, model: A, stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 3, dropOnBtcMovePct: 1 })
    expect(healAiWatchPaper(config({ maxOpen: 99 }), [A])).toEqual({ enabled: false, model: A, stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 3, dropOnBtcMovePct: 1 })
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
    const text = describeAiWatchPaper({ config: config({ stakeQuote: 250, maxOpen: 5 }), risk: STAKE, watchOn: true, hasPaperAccount: true })
    expect(text).toContain(
      "each time openai/gpt-5-mini answers an event the watch put to it with BUY or SELL at 65% confidence or more, a PAPER position is opened at once, with nobody pressing anything, staking 250 of the pair's quote currency."
    )
    expect(text).toContain('with nobody pressing anything')
    expect(text).toContain('it enters in the first minute the price trades inside the range the model named, and is abandoned if that has not happened when its entry expires')
    expect(text).toContain('At most 5 open at once, one an event, and one on a pair at a time.')
    expect(text).toContain('When a position has closed, it is stopped, and its card on Strategies › Execution says how it ended.')
    expect(text).toContain('Its result goes to the paper account, and a trade the paper account cannot fund is not opened.')
    expect(text).toContain('It is paper. Nothing is placed on an exchange, and this cannot be pointed at real money.')
    expect(text).toContain('It asks no model and costs nothing')
    expect(text).not.toContain('The watch itself is off')
    expect(text.trim().endsWith('Switch it on?')).toBe(true)
  })

  it('says so when nothing holds them to a balance, and when the watch is off', () => {
    const text = describeAiWatchPaper({ config: config(), risk: STAKE, watchOn: false, hasPaperAccount: false })
    expect(text).toContain('No paper account is set up, so their results are added to no balance, and nothing limits what these positions add up to.')
    // With no account there is nowhere for a result to go, and it does not say there is.
    expect(text).not.toContain('goes to the paper account')
    expect(text).toContain('its card on Strategies › Execution says how it ended.')
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
    const plan = planWatchPaperTrade({ config: config(), risk: STAKE, event: event(), decision: answer, nowSec, lastPrice: price })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toMatch(reason)
  })

  it('opens nothing when one of the model\'s levels cannot be used, where the form would have shown its own', () => {
    // A stop sixty percent away is not carried into a form; nobody is looking at this one.
    const wild = decision(A, { detail: { ...LONG, stopLoss: 40 } })
    const plan = planWatchPaperTrade({ config: config(), risk: STAKE, event: event(), decision: wild, nowSec: SOON, lastPrice: 100 })
    expect(plan).toEqual({ ok: false, reason: 'Its stop or its target is not a usable distance from the entry.' })
  })
})

describe('watchPaperBlock', () => {
  const check = (executors: ExecutorConfig[], overrides: { config?: AiWatchPaperConfig; symbol?: string; model?: string } = {}): string | null =>
    watchPaperBlock({ config: overrides.config ?? config(), event: event(overrides.symbol), decision: { model: overrides.model ?? A, recommendation: 'buy' }, executors, nowSec: SOON })

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
    expect(check(open, { config: config({ maxOpen: 5, maxSameSide: 5 }) })).toBeNull()
    // (Room in one direction, so that the count this is about is the one in the way.)
    expect(check([open[0], open[1], { ...open[2], status: 'stopped', stoppedAt: T }], { config: config({ maxSameSide: 5 }) })).toBeNull()
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
    /** settings.json's paperRisk, and its paperPause, as stored. */
    risk: unknown
    pause?: unknown
    price: number | null | Error
    /** The live book (shared/liveMarket.ts). Absent: a tight one around the price, received just
     * now; null: none can be had. */
    book?: LiveBook | null | Error
    now: number
    candles: Candle[] | Error
  }
  notices: { title: string; body: string }[]
  settled: string[]
  writes: number
}

/** A book a hundredth of a percent either side of `mid`, received at `nowSec`. */
const tightBook = (symbol: string, mid: number, nowSec: number): LiveBook => ({
  symbol,
  bid: mid * 0.9999,
  bidQty: 1000,
  ask: mid * 1.0001,
  askQty: 1000,
  updatedAt: nowSec * 1000,
  source: 'stream'
})

function rig(initial: Partial<Rig['state']> = {}): Rig {
  const state: Rig['state'] = { config: config(), executors: [], account: null, risk: STAKE, price: 100, now: SOON, candles: [], ...initial }
  const made: Rig = { deps: undefined as unknown as WatchPaperDeps, state, notices: [], settled: [], writes: 0 }
  let tail: Promise<unknown> = Promise.resolve()
  let ids = 0
  made.deps = {
    getConfig: async () => ({ watchPaper: state.config }),
    getSettings: async () => ({
      executors: [...state.executors],
      paperAccount: state.account,
      paperRisk: state.risk as PaperRiskSettings | undefined,
      paperPause: state.pause as PaperPauseSettings | undefined
    }),
    setExecutors: async (executors) => {
      made.writes++
      state.executors = executors
    },
    lastPrice: async () => {
      if (state.price instanceof Error) throw state.price
      return state.price
    },
    liveBook: async (_exchange, symbol) => {
      if (state.book instanceof Error) throw state.book
      if (state.book !== undefined) return state.book
      return tightBook(symbol, typeof state.price === 'number' ? state.price : 100, state.now)
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

  it('says it in R too, given the trade: what it made over what its stop would have lost', () => {
    // 100 staked 1.5% from its stop, and a round trip's fees of 0.2%: 1.70 risked.
    const staked = { amountQuote: 100, stopLossPct: 1.5 }
    expect(describeWatchPaperResult(won, 'USDT', staked)).toBe('Target reached: +3.786 USDT after fees, +2.23 R.')
    expect(describeWatchPaperResult(lost, 'USDT', staked)).toBe('Stopped out: -1.7 USDT after fees, -1.00 R.')
    // A delisting's short has no stop: no R, and no word of one.
    expect(describeWatchPaperResult({ exit: 'time_limit', pnlQuote: 12.4, closedAt: T }, 'USDT', { amountQuote: 100, stopLossPct: null })).toBe('Time ran out: +12.4 USDT after fees.')
    expect(describeWatchPaperResult(never, 'USDT', staked)).toBe('Never entered: the price did not trade in its entry range before it expired.')
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
    // Each staked 100 1.5% from its stop: +3.786 is +2.23 R, and -1.70 is -1 R.
    expect(tally.r).toBeCloseTo(3.78601 / 1.7 - 1, 9)
    expect(tally.rTrades).toBe(2)
    expect(describeWatchPaperTally(tally)).toBe('3 have ended: 2 entered, 1 of them ahead, +2.086 USDT in all after fees, or +1.23 R.')
  })

  it('counts nothing that is not a paper trade of the watch\'s, whatever is written on it', () => {
    const live = ended('BTCUSDT', won, { mode: 'live' })
    const grid = ended('ETHUSDT', won, { type: 'grid' })
    // Nor one that is still running: a result on it is not one the watch wrote when it stopped it.
    const running = ended('SOLUSDT', won, { status: 'active', stoppedAt: null })
    expect(watchPaperTally([live, grid, running])).toEqual({ ended: 0, entered: 0, ahead: 0, pnl: [], r: 0, rTrades: 0 })
  })

  it('keeps each quote asset\'s sum apart', () => {
    const tally = watchPaperTally([ended('BTCUSDT', won), ended('ETHBTC', { exit: 'stop_loss', pnlQuote: -0.002, closedAt: T }, { quoteAsset: 'BTC' }), ended('SOLUSDT', lost)])
    expect(tally.pnl.map((entry) => entry.asset)).toEqual(['USDT', 'BTC'])
    // R has no asset: it adds across them.
    expect(describeWatchPaperTally(tally)).toBe('3 have ended: 3 entered, 1 of them ahead, +2.086 USDT and -0.002 BTC in all after fees, or +1.23 R.')
  })

  it('says so plainly when none entered, and nothing when none has ended', () => {
    expect(describeWatchPaperTally(watchPaperTally([ended('BTCUSDT', never)]))).toBe('1 has ended, and it never entered.')
    expect(describeWatchPaperTally(watchPaperTally([ended('BTCUSDT', never), ended('ETHUSDT', never)]))).toBe('2 have ended, and none entered.')
    expect(describeWatchPaperTally(watchPaperTally([executor()]))).toBe('')
    expect(describeWatchPaperTally(watchPaperTally([ended('BTCUSDT', won)]))).toBe('1 has ended: 1 entered, 1 of them ahead, +3.786 USDT in all after fees, or +2.23 R.')
    // One with no stop to measure against is in the sum and not in the R.
    const stopless = ended('ETHUSDT', won, { params: { ...(executor().params as PositionExecutorParams), stopLossPct: null } })
    expect(describeWatchPaperTally(watchPaperTally([ended('BTCUSDT', won), stopless]))).toBe('2 have ended: 2 entered, 2 of them ahead, +7.572 USDT in all after fees, or +2.23 R for the 1 with a stop.')
  })
})

describe('watchPaperNotice', () => {
  it('is keyed apart from the recommendation\'s own notice, so both can be raised for one event', () => {
    const notice = watchPaperNotice(event(), okPlan())
    expect(notice.key).toBe(`${event().id}:paper`)
    expect(notice.body).toContain('openai/gpt-5-mini at 80% confidence, on the breakout at 09:07 UTC.')
    expect(notice.body).toContain('It is on Strategies › Execution.')
  })
})

// ---------------------------------------------------------------------------------------------
// The safeguards (2026-10-05): so many open in one direction, a pause after a losing run today,
// and a trade still waiting to enter dropped when Bitcoin has moved against it.

describe('the safeguards', () => {
  const opened = (symbol: string, side: 'buy' | 'sell', result?: WatchPaperOutcome): ExecutorConfig => {
    const base = executor({ symbol, watch: { eventId: `binance:${symbol}:1`, eventTime: 1, model: A, confidence: 0.8 } })
    const params = { ...(base.params as PositionExecutorParams), side }
    return result === undefined ? { ...base, params } : { ...base, params, status: 'stopped', stoppedAt: result.closedAt, watch: { ...base.watch!, result } }
  }
  const block = (executors: ExecutorConfig[], recommendation: 'buy' | 'sell', overrides: Partial<AiWatchPaperConfig> = {}, nowSec = SOON): string | null =>
    watchPaperBlock({ config: config({ maxOpen: 10, ...overrides }), event: event('SOLUSDT'), decision: { model: A, recommendation }, executors, nowSec })

  it('are read from a file written before them as their defaults, and leave it on', () => {
    const before = { enabled: true, model: A, stakeQuote: 100, maxOpen: 3 }
    expect(healAiWatchPaper(before, [A])).toEqual(config())
    // One a file holds that is not a choice leaves it off, as a stake or a limit would.
    expect(healAiWatchPaper({ ...before, maxSameSide: 4 }, [A]).enabled).toBe(false)
    expect(healAiWatchPaper({ ...before, pauseAfterLosses: 1 }, [A]).enabled).toBe(false)
    expect(healAiWatchPaper({ ...before, dropOnBtcMovePct: 0.7 }, [A])).toEqual(config({ enabled: false }))
    expect(healAiWatchPaper(config({ maxSameSide: 10, pauseAfterLosses: 0, dropOnBtcMovePct: 0 }), [A])).toEqual(config({ maxSameSide: 10, pauseAfterLosses: 0, dropOnBtcMovePct: 0 }))
  })

  it('can only be saved as one of their choices, and are said before paper trades are switched on', () => {
    expect(aiWatchPaperProblem(config({ maxSameSide: 4 }), [A])).toMatch(/in one direction/)
    expect(aiWatchPaperProblem(config({ pauseAfterLosses: 1 }), [A])).toMatch(/pause after 2, 3 or 5 losses in a row, or never/)
    expect(aiWatchPaperProblem(config({ dropOnBtcMovePct: 3 }), [A])).toMatch(/Bitcoin moves 0.5%, 1% or 2% against it, or never/)
    for (const side of AI_WATCH_PAPER_SAME_SIDE_LIMITS)
      for (const run of AI_WATCH_PAPER_LOSING_RUNS)
        for (const move of AI_WATCH_PAPER_BTC_MOVES) expect(aiWatchPaperProblem(config({ maxSameSide: side, pauseAfterLosses: run, dropOnBtcMovePct: move }), [A])).toBeNull()
    const text = describeAiWatchPaper({ config: config(), risk: STAKE, watchOn: true, hasPaperAccount: true })
    expect(text).toContain('At most 2 open in one direction. After 3 in a row close at a loss in one day, none is opened until midnight UTC. One still waiting to enter is dropped if Bitcoin moves 1% against it after the event.')
    expect(describeWatchPaperSafeguards(config({ pauseAfterLosses: 0, dropOnBtcMovePct: 0 }))).toBe('At most 2 open in one direction. No pause after losses. Bitcoin moving does not drop one.')
  })

  it('keeps so many open in one direction, and lets the other direction in', () => {
    const two = [opened('BTCUSDT', 'buy'), opened('ETHUSDT', 'buy')]
    expect(block(two, 'buy')).toBe('The watch has 2 paper BUYs open, and 2 in one direction is the most it keeps: coins move together, so more would be one bet on the market.')
    expect(block(two, 'sell')).toBeNull()
    expect(block(two, 'buy', { maxSameSide: 3 })).toBeNull()
    expect(block([opened('BTCUSDT', 'sell')], 'sell', { maxSameSide: 1 })).toMatch(/1 paper SELL open/)
    // One that has stopped is not open.
    expect(block([two[0], { ...two[1], status: 'stopped', stoppedAt: T }], 'buy')).toBeNull()
  })

  it('pauses for the rest of the day after a run of losses closed today, and only then', () => {
    const day = Math.floor(SOON / 86_400) * 86_400
    const loss = (k: number): WatchPaperOutcome => ({ exit: 'stop_loss', pnlQuote: -1.5, closedAt: day + 600 + k * 60 })
    const win = (k: number): WatchPaperOutcome => ({ exit: 'take_profit', pnlQuote: 2.9, closedAt: day + 600 + k * 60 })
    const run = [opened('AAAUSDT', 'buy', loss(1)), opened('BBBUSDT', 'buy', loss(2)), opened('CCCUSDT', 'sell', loss(3))]
    expect(block(run, 'buy')).toBe("The last 3 paper trades of the watch's to close today all lost, so it opens none until 00:00 UTC.")
    expect(watchPaperPause(run, config(), SOON)).toMatch(/until 00:00 UTC/)
    // A win anywhere in the last three, or fewer than three today: no pause.
    expect(block([...run.slice(0, 2), opened('CCCUSDT', 'sell', win(3))], 'buy')).toBeNull()
    expect(block([opened('DDDUSDT', 'buy', win(0)), ...run], 'buy')).not.toBeNull()
    expect(block([...run, opened('DDDUSDT', 'buy', win(4))], 'buy')).toBeNull()
    expect(block(run.slice(0, 2), 'buy')).toBeNull()
    // Never entered, or dropped before entering: neither a loss nor a win.
    const never: WatchPaperOutcome = { exit: 'entry_expired', pnlQuote: 0, closedAt: day + 900 }
    const dropped: WatchPaperOutcome = { exit: 'btc_moved', pnlQuote: 0, closedAt: day + 960, btcMovePct: -1.2 }
    expect(block([...run, opened('EEEUSDT', 'buy', never), opened('FFFUSDT', 'buy', dropped)], 'buy')).not.toBeNull()
    // A new UTC day starts the count again, and a run of 0 never pauses.
    expect(block(run, 'buy', {}, day + 86_400 + 30)).toBeNull()
    expect(block(run, 'buy', { pauseAfterLosses: 0 })).toBeNull()
    expect(block(run, 'buy', { pauseAfterLosses: 2 })).not.toBeNull()
    expect(block(run, 'buy', { pauseAfterLosses: 5 })).toBeNull()
  })

  it("measures Bitcoin's move from the minute the event was read, against the trade's side", () => {
    const btc = (closes: number[]): Candle[] => closes.map((close, k) => bar(T - 60 + k * 60, close, close, close, close))
    expect(btcMoveAgainst({ side: 'buy', eventTime: T, btc: btc([100, 99.5, 98.8]), limitPct: 1 })).toBeCloseTo(-1.2, 9)
    expect(btcMoveAgainst({ side: 'buy', eventTime: T, btc: btc([100, 99.5, 99.1]), limitPct: 1 })).toBeNull()
    expect(btcMoveAgainst({ side: 'buy', eventTime: T, btc: btc([100, 101.5]), limitPct: 1 })).toBeNull()
    expect(btcMoveAgainst({ side: 'sell', eventTime: T, btc: btc([100, 101.5]), limitPct: 1 })).toBeCloseTo(1.5, 9)
    expect(btcMoveAgainst({ side: 'sell', eventTime: T, btc: btc([100, 100.4]), limitPct: 0.5 })).toBeNull()
    expect(btcMoveAgainst({ side: 'sell', eventTime: T, btc: btc([100, 100.6]), limitPct: 0.5 })).toBeCloseTo(0.6, 9)
    // Minutes read from before the event -- as they are when two trades are waiting, from the
    // earlier one's -- are measured from the minute this one's event was read at, not the first.
    const earlier = [bar(T - 180, 103, 103, 103, 103), bar(T - 120, 102, 102, 102, 102), ...btc([100, 99.5, 98.8])]
    expect(btcMoveAgainst({ side: 'buy', eventTime: T, btc: earlier, limitPct: 1 })).toBeCloseTo(-1.2, 9)
    expect(btcMoveAgainst({ side: 'buy', eventTime: T, btc: earlier.slice(0, 3).concat(btc([100, 99.5])), limitPct: 1 })).toBeNull()
    // Off, or no minute to measure from, or none since: nothing is dropped.
    expect(btcMoveAgainst({ side: 'buy', eventTime: T, btc: btc([100, 90]), limitPct: 0 })).toBeNull()
    expect(btcMoveAgainst({ side: 'buy', eventTime: T, btc: btc([100, 90]).slice(1), limitPct: 1 })).toBeNull()
    expect(btcMoveAgainst({ side: 'buy', eventTime: T, btc: btc([100]), limitPct: 1 })).toBeNull()
  })

  describe('in the settle loop', () => {
    const start = Math.ceil(SOON / 60) * 60
    /** Waiting to enter: asked at 100.9, its range 99.8 to 100.2, and the price stays above it. */
    const waiting = (): ExecutorConfig => watchPaperExecutor({ id: 'w1', event: event(), plan: okPlan({ lastPrice: 100.9 }), nowSec: SOON })
    const pair = [bar(start, 100.9, 101.2, 100.6, 101), bar(start + 60, 101, 101.3, 100.7, 101.1)]
    const withBitcoin = (r: Rig, closes: number[], own: Candle[] = pair): void => {
      r.deps.fetchCandles = async (_exchange, symbol) => (symbol === 'BTCUSDT' ? closes.map((close, k) => bar(T - 60 + k * 60, close, close, close, close)) : own)
    }

    it('drops a trade still waiting to enter once Bitcoin has moved against it, says so, and books nothing', async () => {
      const r = rig({ executors: [waiting()], now: start + 180 })
      withBitcoin(r, [60000, 59800, 59300])
      expect(await settleWatchPaperTrades(r.deps)).toEqual(['Watch: BUY SOLUSDT'])
      const [dropped] = r.state.executors
      expect(dropped.status).toBe('stopped')
      expect(dropped.watch?.result).toEqual({ exit: 'btc_moved', pnlQuote: 0, closedAt: start + 180, btcMovePct: expect.closeTo(-1.1667, 3) })
      expect(r.settled).toEqual(['w1'])
      expect(r.notices).toEqual([
        {
          title: 'SOLUSDT: paper BUY dropped',
          body: 'Bitcoin fell 1.17% after the call on the 09:07 UTC event, before this trade entered, so the watch dropped it. Nothing real was placed or held.'
        }
      ])
      expect(describeWatchPaperResult(dropped.watch!.result!, 'USDT')).toBe('Dropped before it entered: Bitcoin fell 1.17% after the call.')
      // It never entered: not counted as entered in the tally, nor as a loss.
      expect(watchPaperTally([dropped])).toEqual({ ended: 1, entered: 0, ahead: 0, pnl: [], r: 0, rTrades: 0 })
    })

    it('leaves it waiting when Bitcoin has not moved that far, or moved its way, or the safeguard is off', async () => {
      for (const [closes, overrides] of [
        [[60000, 59800, 59500], {}],
        [[60000, 60800], {}],
        [[60000, 59000], { dropOnBtcMovePct: 0 }],
        [[60000, 59500], { dropOnBtcMovePct: 2 }]
      ] as [number[], Partial<AiWatchPaperConfig>][]) {
        const r = rig({ executors: [waiting()], now: start + 180, config: config(overrides) })
        withBitcoin(r, closes)
        expect(await settleWatchPaperTrades(r.deps)).toEqual([])
        expect(r.state.executors[0].status).toBe('active')
      }
    })

    it('never drops one that has entered: its own stop and target look after it', async () => {
      const entered = trade0()
      const r = rig({ executors: [entered], now: start + 180 })
      withBitcoin(r, [60000, 59000, 58000], [bar(start, 100, 100.4, 99.9, 100.2), bar(start + 60, 100.2, 100.6, 100, 100.4)])
      expect(await settleWatchPaperTrades(r.deps)).toEqual([])
      expect(r.state.executors[0].status).toBe('active')
    })

    function trade0(): ExecutorConfig {
      return watchPaperExecutor({ id: 'w2', event: event(), plan: okPlan(), nowSec: SOON })
    }
  })
})

describe('sized by risk, and held to what the app has out (shared/paperRisk.ts)', () => {
  const RISK: PaperRiskSettings = { sizing: 'risk', riskQuote: 1, maxOutQuote: null }
  const amountOf = (made: ExecutorConfig): number => (made.params as PositionExecutorParams).amountQuote

  it('stakes what its stop would lose about the risk at, after fees, and never more than its stake', () => {
    // The model's stop is 1.5% from the entry, and a round trip's fees are 0.2%: 1 / 1.7% is 58.82.
    expect(okPlan({ risk: RISK }).params.amountQuote).toBe(58.82)
    // Risking 5 there would stake 294.11: held to the stake of 100, and let through where it is larger.
    expect(okPlan({ risk: { ...RISK, riskQuote: 5 } }).params.amountQuote).toBe(100)
    expect(okPlan({ risk: { ...RISK, riskQuote: 5 }, config: config({ stakeQuote: 1000 }) }).params.amountQuote).toBe(294.11)
  })

  it('opens nothing it would size under what the smallest order on Binance is worth, and says why', () => {
    const wide = decision(A, { detail: { ...LONG, stopLoss: 75 } })
    expect(planWatchPaperTrade({ config: config(), risk: RISK, event: event(), decision: wide, nowSec: SOON, lastPrice: 100 })).toEqual({
      ok: false,
      reason: 'Its stop is 25% away, so risking 1 USDT there stakes 3.96 USDT: under the 5 the smallest order on Binance is worth.'
    })
    // At its stake, the same answer is a trade.
    expect(planWatchPaperTrade({ config: config(), risk: STAKE, event: event(), decision: wide, nowSec: SOON, lastPrice: 100 }).ok).toBe(true)
  })

  it('says how it is sized, and what the app may have out, before it is switched on', () => {
    const text = describeAiWatchPaper({ config: config({ stakeQuote: 250 }), risk: { sizing: 'risk', riskQuote: 2, maxOutQuote: 1000 }, watchOn: true, hasPaperAccount: false })
    expect(text).toContain("a PAPER position is opened at once, with nobody pressing anything, staking at most 250 of the pair's quote currency, sized so that being stopped out loses about 2.")
    expect(text).toContain(
      'On Risk & Safety, for every paper trade the app opens by itself: Each with a stop stakes what would lose about 2 there, after fees, and never more than its own stake. Together they stake at most 1,000.'
    )
  })

  it('opens it at that size with nothing stored, by the defaults, and says so', async () => {
    const r = rig({ risk: undefined })
    expect(await openWatchPaperTrade(event(), decision(), r.deps)).toEqual({ opened: true, text: 'A paper BUY of 58.82 USDT was opened, to enter between 99.8 and 100.2.' })
    expect(amountOf(r.state.executors[0])).toBe(58.82)
    expect(r.notices[0].body).toContain('A paper position of 58.82 USDT was opened')
  })

  it("opens nothing past what the app's own paper trades may have out together, and counts only theirs", async () => {
    const capped: PaperRiskSettings = { ...RISK, maxOutQuote: 1000 }
    const roomy = config({ maxOpen: 5, maxSameSide: 5 })
    const watched = { ...executor({ symbol: 'BTCUSDT', watch: { eventId: 'binance:BTCUSDT:1', eventTime: 1, model: A, confidence: 0.8 } }) }
    const own: ExecutorConfig = { ...watched, params: { ...(watched.params as PositionExecutorParams), amountQuote: 500 } }
    const shorted: ExecutorConfig = {
      ...watched,
      id: 'news-1',
      symbol: 'XRPUSDT',
      watch: undefined,
      newsRule: { articleId: 7, ticker: 'XRP', releaseSec: T, title: 'Binance Will Extend the Monitoring Tag to Include XRP on 2026-10-08', category: 'MONITORING_TAG' },
      params: { ...(watched.params as PositionExecutorParams), side: 'sell', amountQuote: 450 }
    }
    // 950 out in the watch's and the news rules' trades: 58.82 more would pass 1,000.
    const near = rig({ risk: capped, config: roomy, executors: [own, shorted] })
    expect(await openWatchPaperTrade(event(), decision(), near.deps)).toEqual({
      opened: false,
      text: "No paper trade: The watch's and the news rules' open paper trades stake 950 USDT together, and 58.82 more would take them past the 1,000 set on Risk & Safety."
    })
    expect(near.state.executors).toHaveLength(2)
    // One of them stopped, there is room again.
    const after = rig({ risk: capped, config: roomy, executors: [own, { ...shorted, status: 'stopped' }] })
    expect((await openWatchPaperTrade(event(), decision(), after.deps))?.opened).toBe(true)
    // A paper position made by hand, however large, is a person's own and is not counted.
    const byHand: ExecutorConfig = { ...watched, id: 'hand-1', symbol: 'ETHUSDT', watch: undefined, params: { ...(watched.params as PositionExecutorParams), amountQuote: 5000 } }
    const mine = rig({ risk: capped, config: roomy, executors: [byHand] })
    expect((await openWatchPaperTrade(event(), decision(), mine.deps))?.opened).toBe(true)
  })
})

describe('paused after a losing run of its own (shared/paperPause.ts)', () => {
  /** One of the watch's, on another pair, stopped out at `closedAt` having made `r` R. */
  function closedTrade(symbol: string, closedAt: number, r: number): ExecutorConfig {
    const made = executor({ symbol })
    const mark = made.watch as NonNullable<ExecutorConfig['watch']>
    const pnlQuote = r * (riskedAtStop(made.params as PositionExecutorParams) as number)
    return { ...made, status: 'stopped', stoppedAt: closedAt, watch: { ...mark, result: { exit: r < 0 ? 'stop_loss' : 'take_profit', pnlQuote, closedAt } } }
  }
  // Closed the day before, so that the pause for the day after losses in a row does not apply.
  const DAY_BEFORE = T - 86_400
  const lost = ['AAAUSDT', 'BBBUSDT', 'CCCUSDT', 'DDDUSDT', 'EEEUSDT'].map((symbol, k) => closedTrade(symbol, DAY_BEFORE + k * 600, -1))
  const PAUSED = "No paper trade: The watch's last 5 closed paper trades lost 5.00 R together, so it opens none until they are resumed on Risk & Safety."

  it('opens nothing once its last trades have lost the run, by the defaults with nothing stored, and says why', async () => {
    const r = rig({ executors: lost })
    let priceReads = 0
    const price = r.deps.lastPrice
    r.deps.lastPrice = async (exchange, symbol) => {
      priceReads++
      return price(exchange, symbol)
    }
    expect(await openWatchPaperTrade(event(), decision(), r.deps)).toEqual({ opened: false, text: PAUSED })
    // Refused at the first look, before the price is even read.
    expect(priceReads).toBe(0)
    expect(r.writes).toBe(0)
    expect(r.notices).toEqual([])
    // Four lost are short of it.
    expect((await openWatchPaperTrade(event(), decision(), rig({ executors: lost.slice(1) }).deps))?.opened).toBe(true)
  })

  it('reads the run again inside the queue, where a trade that closed meanwhile may have ended it', async () => {
    const r = rig({ executors: lost.slice(1) })
    const price = r.deps.lastPrice
    // The first look passes with four lost; the fifth closes while the price is being read.
    r.deps.lastPrice = async (exchange, symbol) => {
      r.state.executors = [...r.state.executors, lost[0]]
      return price(exchange, symbol)
    }
    expect(await openWatchPaperTrade(event(), decision(), r.deps)).toEqual({ opened: false, text: PAUSED })
    expect(r.writes).toBe(0)
  })

  it('holds while it is written down, whatever has closed since, and opens again once resumed', async () => {
    const paused: PaperPauseSettings = { ...DEFAULT_PAPER_PAUSE, watch: { countFrom: null, paused: { at: T - 3600, r: -5, trades: 5 } } }
    const since = [...lost, closedTrade('FFFUSDT', T - 1800, 3), closedTrade('GGGUSDT', T - 1200, 3)]
    expect(await openWatchPaperTrade(event(), decision(), rig({ executors: since, pause: paused }).deps)).toEqual({
      opened: false,
      text: "No paper trade: The watch's last 5 closed paper trades had lost 5.00 R together by 08:07 UTC on 5 Oct, so it opens none until they are resumed on Risk & Safety."
    })
    const resumed = rig({ executors: lost, pause: resumePaperPause(paused, 'watch', T - 60) })
    expect((await openWatchPaperTrade(event(), decision(), resumed.deps))?.opened).toBe(true)
    expect((await openWatchPaperTrade(event(), decision(), rig({ executors: lost, pause: { ...paused, lossR: null } }).deps))?.opened).toBe(true)
  })

  it("is not paused by the news rules' losing run", async () => {
    const shorts = lost.map(
      (trade, k): ExecutorConfig => ({
        ...trade,
        watch: undefined,
        newsRule: { articleId: 9, ticker: `T${k}`, releaseSec: DAY_BEFORE, title: 't', category: 'MONITORING_TAG', result: trade.watch?.result as NonNullable<ExecutorConfig['newsRule']>['result'] }
      })
    )
    expect((await openWatchPaperTrade(event(), decision(), rig({ executors: shorts }).deps))?.opened).toBe(true)
  })

  it('says the pause beside how the trades are sized, before it is switched on', () => {
    const text = describeAiWatchPaper({ config: config(), risk: STAKE, pause: DEFAULT_PAPER_PAUSE, watchOn: true, hasPaperAccount: false })
    expect(text).toContain(
      'Each stakes its own stake. There is no cap on what they stake together. Once the last 20 of them to close have lost 5 R together, none is opened until they are resumed on Risk & Safety.'
    )
  })
})

describe('checked against the live price before it opens (shared/liveMarket.ts)', () => {
  it('opens with a fresh, tight book, and writes the book on its mark', async () => {
    const r = rig()
    expect((await openWatchPaperTrade(event(), decision(), r.deps))?.opened).toBe(true)
    const mark = r.state.executors[0].watch
    expect(mark?.book).toMatchObject({ bid: 100 * 0.9999, ask: 100 * 1.0001, ageMs: 0, source: 'stream' })
    expect(mark?.book?.spreadPct).toBeCloseTo(0.02, 6)
  })

  it('opens nothing with no live price, an old one, or a spread over the line, and says why', async () => {
    const refused = async (book: LiveBook | null | Error): Promise<WatchPaperResult | null> => {
      const r = rig({ book })
      const result = await openWatchPaperTrade(event(), decision(), r.deps)
      expect(r.writes).toBe(0)
      return result
    }
    expect(await refused(null)).toEqual({ opened: false, text: 'No paper trade: The live price could not be read, so the market it would enter is not known.' })
    expect(await refused(new Error('socket closed'))).toEqual({ opened: false, text: 'No paper trade: The live price could not be read, so the market it would enter is not known.' })
    expect(await refused({ ...tightBook('SOLUSDT', 100, SOON), updatedAt: (SOON - 15) * 1000 })).toEqual({
      opened: false,
      text: 'No paper trade: The live price is 15 seconds old, so the market it would enter is not known.'
    })
    expect(await refused({ ...tightBook('SOLUSDT', 100, SOON), bid: 99.8, ask: 100.2 })).toEqual({ opened: false, text: 'No paper trade: The spread is 0.400%, over the 0.1% a trade is entered at.' })
  })
})
