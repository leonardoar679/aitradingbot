import { describe, expect, it } from 'vitest'
import {
  AI_EXIT_PLAN_PATIENCE_SECONDS,
  aiExitOutcome,
  aiExitPlanEnd,
  aiExitPlanParams,
  aiExitPlanResult,
  aiExitTally,
  aiExitWrite,
  describeAiExit,
  describeAiExitTally,
  describeAiExitTriggers
} from '../shared/aiExit'
import type { AiExitMark, Candle, ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import { describeR, rMultiple } from '../shared/paperRisk'
import { simulatePosition } from '../src/executors/engine'

// shared/aiExit.ts: what the exit check's EXIT writes on one of the app's own paper trades -- its time
// limit brought forward, and nothing else -- and what the trades it closed came to against their
// plans.

const T = Date.parse('2026-10-06T12:00:00Z') / 1000
const ENTERED = T - 1800
const PARAMS: PositionExecutorParams = {
  side: 'buy',
  entryPrice: null,
  amountQuote: 100,
  takeProfitPct: 4,
  stopLossPct: 2,
  timeLimitSec: 7200,
  trailingStop: null,
  entryRange: { min: 99.8, max: 100.2 },
  entryExpiresAt: ENTERED + 600
}
const ORDER = { model: 'openai/gpt-5-mini', triggers: ['near_stop', 'news'], confidence: 0.65, reason: 'It broke the level it was bought on.' }

const bar = (time: number, open: number, high: number, low: number, close: number): Candle => ({ time, open, high, low, close, volume: 1 })

function written(nowSec = T + 25, params = PARAMS): { params: PositionExecutorParams; mark: AiExitMark } {
  const out = aiExitWrite({ params, enteredAt: ENTERED, nowSec, ...ORDER })
  if (out === null) throw new Error('expected it to be brought forward')
  return out
}

describe('what an EXIT writes', () => {
  it('brings the time limit forward to end the trade in the next minute, and says so on its mark', () => {
    expect(written()).toEqual({
      params: { ...PARAMS, timeLimitSec: T + 60 - ENTERED },
      mark: { at: T + 25, closeAt: T + 60, enteredAt: ENTERED, planTimeLimitSec: 7200, ...ORDER }
    })
    // At a minute's very start the next minute is still the next one, not the one under way.
    expect(written(T).mark.closeAt).toBe(T + 60)
    expect(written(T + 59).mark.closeAt).toBe(T + 60)
  })

  it('never makes a time limit longer, and changes nothing but the time limit', () => {
    // Its own clock ends it in that minute or sooner: there is nothing to bring forward.
    expect(aiExitWrite({ params: { ...PARAMS, timeLimitSec: T + 60 - ENTERED }, enteredAt: ENTERED, nowSec: T + 25, ...ORDER })).toBeNull()
    expect(aiExitWrite({ params: { ...PARAMS, timeLimitSec: 600 }, enteredAt: ENTERED, nowSec: T + 25, ...ORDER })).toBeNull()
    expect(aiExitWrite({ params: { ...PARAMS, timeLimitSec: null }, enteredAt: ENTERED, nowSec: T + 25, ...ORDER })).toBeNull()
    // An entry after now, or off a minute, is not one the engine could have given.
    expect(aiExitWrite({ params: PARAMS, enteredAt: T + 60, nowSec: T + 25, ...ORDER })).toBeNull()
    expect(aiExitWrite({ params: PARAMS, enteredAt: ENTERED + 30, nowSec: T + 25, ...ORDER })).toBeNull()
    const { timeLimitSec: _limit, ...before } = PARAMS
    for (let now = ENTERED; now < ENTERED + 7300; now += 97) {
      const out = aiExitWrite({ params: PARAMS, enteredAt: ENTERED, nowSec: now, ...ORDER })
      if (out === null) {
        expect(Math.floor(now / 60) * 60 + 60 - ENTERED, String(now)).toBeGreaterThanOrEqual(7200)
        continue
      }
      expect(out.params.timeLimitSec, String(now)).toBeLessThan(7200)
      expect(out.params.timeLimitSec, String(now)).toBeGreaterThan(now - ENTERED)
      const { timeLimitSec: _new, ...rest } = out.params
      expect(rest).toEqual(before)
      expect(out.mark.planTimeLimitSec).toBe(7200)
    }
  })

  it("closes the trade at the close of the next minute by the engine's own time rule; its stop, hit first, still ends it", () => {
    const minutes: Candle[] = []
    for (let time = ENTERED; time <= T + 300; time += 60) minutes.push(time === T + 60 ? bar(time, 100.1, 100.2, 98.9, 99) : bar(time, 100, 100.2, 99.9, 100.1))
    const { params, mark } = written()
    expect(simulatePosition(minutes, params)).toMatchObject({ status: 'closed', enteredAt: ENTERED, exitReason: 'time_limit', closedAt: T + 60, exitPrice: 99 })
    const stopped = minutes.map((candle) => (candle.time === T + 60 ? bar(T + 60, 100.1, 100.2, 97.5, 97.8) : candle))
    expect(simulatePosition(stopped, params)).toMatchObject({ exitReason: 'stop_loss', closedAt: T + 60 })
    // Before that minute it is as it was: the same entry, open, on the same minutes.
    const before = minutes.filter((candle) => candle.time < T + 60)
    expect(simulatePosition(before, params)).toEqual(simulatePosition(before, PARAMS))
    // The plan as it was runs on to its own end.
    expect(aiExitPlanParams(params, mark)).toEqual(PARAMS)
    expect(simulatePosition(minutes, aiExitPlanParams(params, mark)).status).toBe('open')
  })
})

describe('how it is written down', () => {
  it("is the check's exit where the time limit it brought forward ended the trade, and the trade's own otherwise", () => {
    const { mark } = written()
    expect(aiExitOutcome('time_limit', mark)).toBe('ai_exit')
    expect(aiExitOutcome('stop_loss', mark)).toBe('stop_loss')
    expect(aiExitOutcome('take_profit', mark)).toBe('take_profit')
    expect(aiExitOutcome('time_limit', undefined)).toBe('time_limit')
  })

  it("reads the plan's result once it has ended, waits until then, and gives up a day after its end", () => {
    const mark = { enteredAt: ENTERED, planTimeLimitSec: 7200 }
    expect(aiExitPlanEnd(mark)).toBe(ENTERED + 7200)
    expect(aiExitPlanResult({ status: 'closed', exitReason: 'take_profit', realizedPnl: 3.8, closedAt: ENTERED + 600 }, mark, T)).toEqual({ exit: 'take_profit', pnlQuote: 3.8, closedAt: ENTERED + 600 })
    const open = { status: 'open' as const, exitReason: null, realizedPnl: null, closedAt: null }
    expect(aiExitPlanResult(open, mark, ENTERED + 7200 + AI_EXIT_PLAN_PATIENCE_SECONDS)).toBeUndefined()
    expect(aiExitPlanResult(open, mark, ENTERED + 7200 + AI_EXIT_PLAN_PATIENCE_SECONDS + 1)).toBeNull()
    expect(aiExitPlanResult(null, mark, T)).toBeUndefined()
  })

  it('says on the trade what was said, what it did, and what the plan would have made', () => {
    const { mark } = written()
    const said = 'The exit check (openai/gpt-5-mini) answered EXIT at 12:00 UTC, asked because it is near its stop, news on the coin: "It broke the level it was bought on."'
    const did = ' Its time limit was brought forward to close it in the minute of 12:01 UTC; the plan would have run to 13:30 UTC. Paper.'
    expect(describeAiExit(mark, 'USDT', PARAMS)).toBe(said + did)
    expect(describeAiExit({ ...mark, plan: { exit: 'stop_loss', pnlQuote: -2.2, closedAt: T + 900 } }, 'USDT', PARAMS)).toBe(
      `${said}${did} The plan would have made -2.2 USDT after fees, ${describeR(rMultiple(-2.2, PARAMS) as number)}.`
    )
    expect(describeAiExit({ ...mark, plan: { exit: 'time_limit', pnlQuote: 1, closedAt: T + 900 } }, 'USDT', { ...PARAMS, stopLossPct: null })).toBe(`${said}${did} The plan would have made +1 USDT after fees.`)
    expect(describeAiExit({ ...mark, plan: null }, 'USDT', PARAMS)).toBe(`${said}${did} What the plan would have made could not be measured.`)
    expect(describeAiExitTriggers(['regime_change', 'nonsense', 'opposite_move'])).toBe("the market's regime changed, a sharp move against it")
  })
})

describe('whether it helps', () => {
  const STOPPED = T + 7200
  function trade(id: string, over: { taken?: number; plan?: AiExitMark['plan']; exited?: boolean; news?: boolean; executor?: Partial<ExecutorConfig> } = {}): ExecutorConfig {
    const mark = { ...written().mark, ...(over.plan === undefined ? {} : { plan: over.plan }) }
    const result = { exit: 'ai_exit' as const, pnlQuote: over.taken ?? 1, closedAt: T + 60 }
    const own = { result, ...(over.exited === false ? {} : { aiExit: mark }) }
    return {
      id,
      name: id,
      type: 'position',
      exchange: 'binance',
      symbol: 'SOLUSDT',
      baseAsset: 'SOL',
      quoteAsset: 'USDT',
      createdAt: ENTERED - 30,
      status: 'stopped',
      stoppedAt: STOPPED,
      keepPosition: false,
      mode: 'paper',
      ...(over.news === true
        ? { newsRule: { articleId: 1, ticker: 'SOL', releaseSec: ENTERED - 60, title: 't', category: 'DELISTING' as const, ...own } }
        : { watch: { eventId: `e-${id}`, eventTime: ENTERED - 60, model: 'm', confidence: 0.7, ...own } }),
      liveOrder: null,
      pendingLiveOrderIds: [],
      liveWatcherId: null,
      liveWatcherError: null,
      liveExitResult: null,
      liveDcaBasePrice: null,
      liveTwapRunId: null,
      liveTwapResult: null,
      params: over.news === true ? { ...PARAMS, side: 'sell', stopLossPct: null, takeProfitPct: null } : PARAMS,
      ...over.executor
    }
  }
  const plan = (pnlQuote: number): AiExitMark['plan'] => ({ exit: 'time_limit', pnlQuote, closedAt: T + 3600 })
  const executors = [
    trade('better', { taken: 1, plan: plan(-2.1) }),
    trade('worse', { taken: -0.5, plan: plan(3.8) }),
    // The stop was hit in the last minute: the plan would have gone the same way.
    trade('same', { taken: -2.2, plan: { exit: 'stop_loss', pnlQuote: -2.2, closedAt: T + 60 } }),
    trade('waiting'),
    trade('lost', { plan: null }),
    trade('short', { taken: 2, plan: plan(1), news: true }),
    // None of these is counted: not closed by the check, still open, and -- whatever it carries -- live.
    trade('untouched', { taken: 5, exited: false }),
    trade('open', { plan: plan(-9), executor: { status: 'active' } }),
    trade('live', { plan: plan(-9), executor: { mode: 'live' } })
  ]

  it('sets each trade it closed against its plan, in R where it had a stop, and in money', () => {
    const r = (taken: number, planned: number): number => (rMultiple(taken, PARAMS) as number) - (rMultiple(planned, PARAMS) as number)
    const tally = aiExitTally(executors)
    expect(tally).toEqual({
      closed: 6,
      measured: 4,
      better: 2,
      worse: 1,
      same: 1,
      rDiff: r(1, -2.1) + r(-0.5, 3.8) + 0,
      rTrades: 3,
      quoteDiff: [{ asset: 'USDT', amount: 3.1 - 4.3 + 0 + 1 }],
      unmeasured: 1
    })
    expect(tally.rDiff).toBeCloseTo(-1.2 / 2.2, 9)
  })

  it('says it in a sentence or two, and plainly when there is nothing yet', () => {
    expect(describeAiExitTally(aiExitTally([]))).toBe("The exit check has closed none of the app's paper trades yet.")
    expect(describeAiExitTally(aiExitTally([trade('waiting')]))).toBe("It has closed 1 of the app's paper trades early. 1 is still waiting for its plan's time to pass.")
    const tally = aiExitTally(executors)
    expect(describeAiExitTally(tally)).toBe(
      `It has closed 6 of the app's paper trades early. Against the 4 plans it cut short: 2 better, 1 worse, 1 the same; ${describeR(tally.rDiff)} for the 3 with a stop, -0.2 USDT after fees in all. 1 is still waiting for its plan's time to pass. 1 could not be measured.`
    )
  })
})
