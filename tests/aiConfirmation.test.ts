import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../shared/ipc'
import { GPT_INTRADAY_STRATEGY_ID, GPT_LOOKBACK_BARS, type AiSignalDecision } from '../shared/aiSignal'
import { AI_CONFIRM_MAX_DECISIONS, AI_CONFIRM_SETTLE_SECONDS, type AiEntryConfirmRequest } from '../shared/aiConfirm'

// A strategy whose signals a test dictates bar by bar, registered beside the real ones. What is
// under test is which bars a model gets asked about and what its answers do to the run, and both
// are only checkable against signals that are known exactly.
const script = vi.hoisted(() => ({ entries: new Set<number>(), exits: new Set<number>(), stopFraction: 0.5 }))

vi.mock('../src/backtest/strategies', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/backtest/strategies')>()
  const probe = {
    id: 'probe',
    name: 'Probe',
    description: 'Enters and exits on the bars a test names.',
    preferredInterval: '15m' as const,
    warmupBarsFor: () => 0,
    generateSignals: (candles: { close: number }[]) => ({
      entries: candles.map((_, i) => script.entries.has(i)),
      exits: candles.map((_, i) => script.exits.has(i)),
      stopPrices: candles.map((candle, i) => (script.entries.has(i) ? candle.close * script.stopFraction : null)),
      warmupBars: 0
    })
  }
  return {
    ...actual,
    STRATEGIES: [...actual.STRATEGIES, probe],
    getStrategy: (id: string) => (id === 'probe' ? probe : actual.getStrategy(id))
  }
})

import {
  CONFIRMATION_CANCELLED,
  canConfirmEntries,
  confirmationCounts,
  gateEntries,
  resolveConfirmedRun,
  reviewEntries,
  tradeFrom,
  type ResolveInput
} from '../src/backtest/aiConfirmation'
import { STRATEGIES } from '../src/backtest/strategies'

const BAR = 900
const START = 1_699_999_200
/** The first bar a reviewed run can trade on. */
const FIRST = GPT_LOOKBACK_BARS

/** A market that goes nowhere, so a trade's result is its fees and nothing else -- unless a test
 * moves a bar. */
function flatCandles(count: number, edit: (candle: Candle, index: number) => void = () => undefined): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const candle: Candle = { time: START + index * BAR, open: 100, high: 100.5, low: 99.5, close: 100, volume: 10 }
    edit(candle, index)
    return candle
  })
}

function answer(recommendation: 'buy' | 'sell' | 'hold', confidence: number, over: Partial<AiSignalDecision> = {}): AiSignalDecision {
  return {
    candleTime: 0,
    recommendation,
    confidence,
    rationale: '',
    model: 'test/model',
    cached: false,
    error: null,
    rejected: null,
    detail: null,
    usage: { promptTokens: 10, completionTokens: 10, costUsd: 0.002, latencyMs: 5 },
    ...over
  }
}

const CONFIRM = answer('buy', 0.9)
const VETO = answer('hold', 0.9)

/** Runs the loop against scripted answers, and records which bars were asked about, in order. */
async function review(
  candles: Candle[],
  rule: (index: number) => AiSignalDecision | null,
  over: Partial<ResolveInput> = {}
): Promise<{ asked: number[]; requests: AiEntryConfirmRequest[]; run: Awaited<ReturnType<typeof resolveConfirmedRun>> }> {
  const indexByTime = new Map(candles.map((candle, index) => [candle.time, index]))
  const asked: number[] = []
  const requests: AiEntryConfirmRequest[] = []
  const run = await resolveConfirmedRun({
    candles,
    strategyId: 'probe',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    interval: '15m',
    confirmFromSec: 0,
    // Long after the last bar: every candle here has closed unless a test says otherwise.
    nowSec: candles[candles.length - 1].time + 10 * BAR,
    source: 'backtest',
    ask: async (request) => {
      const index = indexByTime.get(request.window[request.window.length - 1].time) ?? -1
      asked.push(index)
      requests.push(request)
      return rule(index)
    },
    ...over
  })
  return { asked, requests, run }
}

function entryIndexes(candles: Candle[], run: { result: { trades: { entryTime: number }[] } }): number[] {
  return run.result.trades.map((trade) => candles.findIndex((candle) => candle.time === trade.entryTime))
}

beforeEach(() => {
  script.entries = new Set()
  script.exits = new Set()
  script.stopFraction = 0.5
})

describe('which entries a model is asked about', () => {
  it('asks once where the engine opens a position, not on every bar the signal is true', async () => {
    // A state, like Trend Regime's unanimous vote: true for eleven bars running.
    for (let i = FIRST + 8; i <= FIRST + 18; i++) script.entries.add(i)
    script.exits.add(FIRST + 30)
    const candles = flatCandles(FIRST + 60)

    const { asked, run } = await review(candles, () => CONFIRM)
    expect(asked).toEqual([FIRST + 8])
    expect(entryIndexes(candles, run)).toEqual([FIRST + 8])
    expect(run.unsettled).toBeNull()
  })

  it('never asks about a bar the strategy did not signal on', async () => {
    const candles = flatCandles(FIRST + 60)
    const { asked, run } = await review(candles, () => CONFIRM)
    expect(asked).toEqual([])
    expect(run.result.trades).toEqual([])
    expect(run.openQuestions).toBe(0)
  })

  it('asks once per trade: a veto removes the trade, and no re-fired signal inside it is asked about', async () => {
    // The signal drops and comes back twice while the first trade would still have been open --
    // what a threshold on a noisy reading does. Asking again each time lets a "no" be outlasted.
    for (let i = FIRST + 8; i <= FIRST + 10; i++) script.entries.add(i)
    script.entries.add(FIRST + 14)
    for (let i = FIRST + 23; i <= FIRST + 27; i++) script.entries.add(i)
    script.exits.add(FIRST + 40)
    script.entries.add(FIRST + 45)
    script.exits.add(FIRST + 52)
    const candles = flatCandles(FIRST + 60)

    const vetoedFirst = await review(candles, (index) => (index === FIRST + 8 ? VETO : CONFIRM))
    // Not 9, not 14, not 23: all of them fall inside the trade the veto removed.
    expect(vetoedFirst.asked).toEqual([FIRST + 8, FIRST + 45])
    expect(entryIndexes(candles, vetoedFirst.run)).toEqual([FIRST + 45])

    // And it is the same two questions when the first is confirmed: the questions are the
    // strategy's own trades, whatever the answers.
    const confirmed = await review(candles, () => CONFIRM)
    expect(confirmed.asked).toEqual([FIRST + 8, FIRST + 45])
    expect(entryIndexes(candles, confirmed.run)).toEqual(entryIndexes(candles, { result: confirmed.run.quantOnly }))
    expect(entryIndexes(candles, { result: vetoedFirst.run.quantOnly })).toEqual([FIRST + 8, FIRST + 45])
  })

  it('leaves the reviewed run as the strategy\'s own run with the vetoed trades missing', async () => {
    for (const [entry, exit] of [[8, 12], [20, 24], [30, 34], [40, 44]]) {
      script.entries.add(FIRST + entry)
      script.exits.add(FIRST + exit)
    }
    const candles = flatCandles(FIRST + 60)
    const { asked, run } = await review(candles, (index) => (index === FIRST + 20 || index === FIRST + 40 ? VETO : CONFIRM))
    expect(asked).toEqual([FIRST + 8, FIRST + 20, FIRST + 30, FIRST + 40])
    expect(entryIndexes(candles, run)).toEqual([FIRST + 8, FIRST + 30])
    expect([...run.removed.keys()]).toEqual([FIRST + 20, FIRST + 40])
    // The same trade the strategy alone made from that bar. Compared by its bars and its return
    // rather than whole: what it would have been worth in money depends on the balance it started
    // from, and a trade that was never taken has no balance of its own.
    const removed = run.removed.get(FIRST + 20)
    expect(removed).toMatchObject({ entryTime: candles[FIRST + 20].time, exitTime: candles[FIRST + 24].time, exitReason: 'signal' })
    expect(removed?.returnPct).toBeCloseTo(run.quantOnly.trades[1].returnPct, 10)
  })

  it('lets the strategy back in on the very bar a vetoed trade would have exited by signal', async () => {
    // The engine can close on a signal and open again on the same bar, so the strategy alone
    // would. A veto that blocked that bar too would remove a second trade nobody ruled on.
    script.entries.add(FIRST + 8)
    script.exits.add(FIRST + 20)
    script.entries.add(FIRST + 20)
    script.exits.add(FIRST + 30)
    const candles = flatCandles(FIRST + 60)
    const { asked, run } = await review(candles, (index) => (index === FIRST + 8 ? VETO : CONFIRM))
    expect(entryIndexes(candles, { result: run.quantOnly })).toEqual([FIRST + 8, FIRST + 20])
    expect(asked).toEqual([FIRST + 8, FIRST + 20])
    expect(entryIndexes(candles, run)).toEqual([FIRST + 20])
  })

  it('keeps the account out through the bar a vetoed trade would have been stopped out on', async () => {
    // The engine never re-enters on the bar that stopped it out, so neither does a run that was
    // vetoed out of that trade: the next question is the bar after, exactly as for the strategy.
    script.stopFraction = 0.9
    for (let i = FIRST + 8; i <= FIRST + 30; i++) script.entries.add(i)
    const candles = flatCandles(FIRST + 60, (candle, index) => {
      if (index === FIRST + 14) candle.low = 80
    })
    const { asked, run } = await review(candles, (index) => (index === FIRST + 8 ? VETO : CONFIRM))
    expect(asked).toEqual([FIRST + 8, FIRST + 15])
    expect(entryIndexes(candles, run)).toEqual([FIRST + 15])
    expect(run.removed.get(FIRST + 8)?.exitReason).toBe('stop_loss')
  })

  it('stays out for good when the vetoed trade would still be open at the end', async () => {
    script.entries.add(FIRST + 8)
    for (let i = FIRST + 20; i <= FIRST + 25; i++) script.entries.add(i)
    const candles = flatCandles(FIRST + 60)
    const { asked, run } = await review(candles, () => VETO)
    expect(asked).toEqual([FIRST + 8])
    expect(run.result.trades).toEqual([])
    expect(run.removed.get(FIRST + 8)?.exitReason).toBe('end_of_data')
  })

  it('follows the engine, not the signals, where a veto changes what the engine does next', async () => {
    // With a re-entry cooldown the strategy alone closes its first trade and then has to sit out
    // the signal two bars later. Vetoed out of that first trade, nothing was closed, so nothing is
    // cooling down, and that same signal is one the reviewed run CAN take. It is found, and asked
    // about, because the walk follows the engine rather than a list of the strategy's own trades.
    script.entries.add(FIRST + 8)
    script.exits.add(FIRST + 12)
    script.entries.add(FIRST + 14)
    script.exits.add(FIRST + 30)
    const candles = flatCandles(FIRST + 60)
    const engine = { reentryCooldown: { bars: 5 } }

    const alone = await review(candles, () => CONFIRM, { engine })
    expect(alone.asked).toEqual([FIRST + 8])
    expect(entryIndexes(candles, { result: alone.run.quantOnly })).toEqual([FIRST + 8])

    const vetoed = await review(candles, (index) => (index === FIRST + 8 ? VETO : CONFIRM), { engine })
    // The strategy alone never takes this one. The reviewed run does, and it was asked about.
    expect(vetoed.asked).toEqual([FIRST + 8, FIRST + 14])
    expect(entryIndexes(candles, vetoed.run)).toEqual([FIRST + 14])
  })

  it('reviews a re-entry after a stop-out as the new entry it is', async () => {
    script.stopFraction = 0.9
    for (let i = FIRST + 8; i <= FIRST + 30; i++) script.entries.add(i)
    const candles = flatCandles(FIRST + 60, (candle, index) => {
      if (index === FIRST + 14) candle.low = 80
    })

    const { asked, run } = await review(candles, () => CONFIRM)
    expect(asked).toEqual([FIRST + 8, FIRST + 15])
    expect(run.result.trades.map((trade) => trade.exitReason)).toEqual(['stop_loss', 'end_of_data'])
  })

  it('reviews an entry that is still open when the caller keeps positions open', async () => {
    script.entries.add(FIRST + 8)
    const candles = flatCandles(FIRST + 60)
    const { asked, run } = await review(candles, () => CONFIRM, { engine: { forceCloseAtEnd: false } })
    expect(asked).toEqual([FIRST + 8])
    expect(run.result.trades).toEqual([])
    expect(run.result.openPositionAtEnd?.entryTime).toBe(candles[FIRST + 8].time)
  })

  it('takes nothing before a review has its lookback, in either run', async () => {
    script.entries.add(100)
    script.exits.add(120)
    script.entries.add(FIRST + 8)
    const candles = flatCandles(FIRST + 60)
    const { asked, run } = await review(candles, () => CONFIRM)
    expect(asked).toEqual([FIRST + 8])
    expect(entryIndexes(candles, { result: run.quantOnly })).toEqual([FIRST + 8])
  })

  it('lets through, unasked, what the strategy did before the moment it is told to start reviewing', async () => {
    script.entries.add(FIRST + 8)
    script.exits.add(FIRST + 12)
    script.entries.add(FIRST + 20)
    const candles = flatCandles(FIRST + 60)

    const { asked, run } = await review(candles, () => VETO, { confirmFromSec: candles[FIRST + 16].time })
    // The first trade predates the bot and is the strategy's own history; only the second is the
    // bot's to take, and only that one is put to the model.
    expect(asked).toEqual([FIRST + 20])
    expect(entryIndexes(candles, run)).toEqual([FIRST + 8])
  })

  it('asks nothing at all when told to start reviewing only in the future', async () => {
    script.entries.add(FIRST + 8)
    const candles = flatCandles(FIRST + 60)
    const { asked, run } = await review(candles, () => VETO, { confirmFromSec: Number.POSITIVE_INFINITY })
    expect(asked).toEqual([])
    expect(entryIndexes(candles, run)).toEqual([FIRST + 8])
  })
})

describe('what an answer does', () => {
  it.each([
    ['a hold', VETO],
    ['a sell', answer('sell', 0.95)],
    ['a buy below the confidence gate', answer('buy', 0.64)],
    ['an answer the validator refused', answer('hold', 0, { rejected: 'marketRegime is not an allowed value' })]
  ])('treats %s as a veto', async (_label, decision) => {
    script.entries.add(FIRST + 8)
    const candles = flatCandles(FIRST + 60)
    const { run } = await review(candles, () => decision)
    expect(run.result.trades).toEqual([])
    expect(run.decisions.size).toBe(1)
  })

  it('lets an entry through on a buy at the gate', async () => {
    script.entries.add(FIRST + 8)
    const candles = flatCandles(FIRST + 60)
    const { run } = await review(candles, () => answer('buy', 0.65))
    expect(entryIndexes(candles, run)).toEqual([FIRST + 8])
  })

  it('fills a confirmed entry exactly where the strategy alone would', async () => {
    script.entries.add(FIRST + 8)
    script.exits.add(FIRST + 20)
    const candles = flatCandles(FIRST + 60, (candle, index) => {
      if (index > FIRST + 8) candle.close = 104
    })
    const { run } = await review(candles, () => CONFIRM)
    expect(run.result.trades).toEqual(run.quantOnly.trades)
  })

  it('never closes or keeps open anything: exits and stops are the strategy\'s own', async () => {
    const signals = {
      entries: [false, true, true, false, true],
      exits: [false, false, false, true, false],
      stopPrices: [null, 90, 91, null, 92],
      warmupBars: 0
    }
    const gated = gateEntries(signals, [{ from: 1, through: 2 }])
    expect(gated.entries).toEqual([false, false, false, false, true])
    expect(gated.exits).toBe(signals.exits)
    expect(gated.stopPrices).toBe(signals.stopPrices)
    // And the original is not edited in place.
    expect(signals.entries).toEqual([false, true, true, false, true])
    expect(gateEntries(signals, [], 2).entries).toEqual([false, true, false, false, false])
  })
})

describe('an entry that cannot be ruled on', () => {
  it('is neither asked about nor taken while its bar is still forming', async () => {
    const candles = flatCandles(FIRST + 60)
    const last = candles.length - 1
    script.entries.add(last)
    const closesAt = candles[last].time + BAR

    const forming = await review(candles, () => CONFIRM, { nowSec: closesAt + AI_CONFIRM_SETTLE_SECONDS - 1, engine: { forceCloseAtEnd: false } })
    expect(forming.asked).toEqual([])
    expect(forming.run.unsettled).toMatchObject({ index: last, reason: 'forming' })
    expect(forming.run.result.openPositionAtEnd).toBeNull()

    const settled = await review(candles, () => CONFIRM, { nowSec: closesAt + AI_CONFIRM_SETTLE_SECONDS, engine: { forceCloseAtEnd: false } })
    expect(settled.asked).toEqual([last])
    expect(settled.run.result.openPositionAtEnd?.entryTime).toBe(candles[last].time)
  })

  it('stops at the first entry that would cost something when the caller may not pay, and counts what is left', async () => {
    for (const [entry, exit] of [[8, 12], [20, 24], [30, 34]]) {
      script.entries.add(FIRST + entry)
      script.exits.add(FIRST + exit)
    }
    const candles = flatCandles(FIRST + 60)

    // The first is already held; the second is not.
    const { asked, run } = await review(candles, (index) => (index === FIRST + 8 ? CONFIRM : null))
    expect(asked).toEqual([FIRST + 8, FIRST + 20])
    expect(run.unsettled).toMatchObject({ index: FIRST + 20, reason: 'uncached' })
    expect(run.decisions.size).toBe(1)
    expect(run.openQuestions).toBe(2)
  })

  it('does not record an unreachable model as a veto, and takes nothing from that bar on', async () => {
    for (const [entry, exit] of [[8, 12], [20, 24], [30, 34]]) {
      script.entries.add(FIRST + entry)
      script.exits.add(FIRST + exit)
    }
    const candles = flatCandles(FIRST + 60)
    const failed = answer('hold', 0, { error: 'OpenRouter 503: no provider' })

    const first = await review(candles, (index) => (index === FIRST + 20 ? failed : CONFIRM))
    expect(first.run.unsettled).toMatchObject({ index: FIRST + 20, reason: 'unanswered', detail: 'OpenRouter 503: no provider' })
    expect([...first.run.decisions.keys()]).toEqual([FIRST + 8])
    // The entry already ruled on stands; the unanswered one and everything after it do not open.
    expect(entryIndexes(candles, first.run)).toEqual([FIRST + 8])

    // Next time round it is asked again, because nothing was kept for it.
    const again = await review(candles, () => CONFIRM, { known: first.run.decisions })
    expect(again.asked).toEqual([FIRST + 20, FIRST + 30])
    expect(entryIndexes(candles, again.run)).toEqual([FIRST + 8, FIRST + 20, FIRST + 30])
  })

  it('uses rulings it already holds without asking again', async () => {
    script.entries.add(FIRST + 8)
    script.exits.add(FIRST + 20)
    script.entries.add(FIRST + 30)
    script.exits.add(FIRST + 40)
    const candles = flatCandles(FIRST + 60)
    const known = new Map([[FIRST + 8, VETO]])
    const { asked, run } = await review(candles, () => CONFIRM, { known })
    expect(asked).toEqual([FIRST + 30])
    expect(entryIndexes(candles, run)).toEqual([FIRST + 30])
    // A ruling handed in is applied exactly as one given this time round: the trade it vetoed is
    // known, and so is the stretch it keeps the account out for.
    expect(run.removed.get(FIRST + 8)?.exitTime).toBe(candles[FIRST + 20].time)
    // The caller's map is not written to.
    expect(known.size).toBe(1)
  })

  it('stops when told to, before asking anything more', async () => {
    script.entries.add(FIRST + 8)
    const candles = flatCandles(FIRST + 60)
    await expect(review(candles, () => CONFIRM, { shouldStop: () => true })).rejects.toThrow(CONFIRMATION_CANCELLED)
  })

  it('refuses to review more entries in one run than the ceiling allows', async () => {
    // A one-bar trade on every other bar, each vetoed: more trades than one run may review.
    const signals = AI_CONFIRM_MAX_DECISIONS + 3
    for (let i = 0; i < signals; i++) {
      script.entries.add(FIRST + i * 2)
      script.exits.add(FIRST + i * 2 + 1)
    }
    const candles = flatCandles(FIRST + signals * 2 + 2)
    let asked = 0
    // Reduced to a string first: a run that wrongly resolved would otherwise be printed whole,
    // every candle of it, as the failure message.
    const outcome = await review(candles, () => {
      asked++
      return VETO
    }).then(
      () => 'resolved',
      (error: Error) => error.message
    )
    expect(outcome).toMatch(new RegExp(`at most ${AI_CONFIRM_MAX_DECISIONS} entries`))
    expect(asked).toBe(AI_CONFIRM_MAX_DECISIONS)
  })
})

describe('the question that is sent', () => {
  it('ends at the signal bar and holds exactly the lookback', async () => {
    script.entries.add(FIRST + 8)
    const candles = flatCandles(FIRST + 60)
    const { requests } = await review(candles, () => CONFIRM)
    const [request] = requests
    expect(request.window).toHaveLength(GPT_LOOKBACK_BARS)
    expect(request.window[0].time).toBe(candles[9].time)
    expect(request.window[GPT_LOOKBACK_BARS - 1].time).toBe(candles[FIRST + 8].time)
    expect(request).toMatchObject({ exchange: 'binance', symbol: 'BTCUSDT', interval: '15m', source: 'backtest' })
    expect(request.strategy).toEqual({
      id: 'probe',
      name: 'Probe',
      rule: 'Enters and exits on the bars a test names.',
      stopDistancePct: 50,
      readings: []
    })
  })

  it('reads nothing after the signal bar', async () => {
    script.entries.add(FIRST + 8)
    const honest = await review(flatCandles(FIRST + 60), () => CONFIRM)
    const tampered = await review(
      flatCandles(FIRST + 60, (candle, index) => {
        if (index > FIRST + 8) Object.assign(candle, { open: 9e6, high: 9e6, low: 1, close: 9e6, volume: 9e9 })
      }),
      () => CONFIRM
    )
    expect(tampered.requests[0]).toEqual(honest.requests[0])
  })

  it('passes on the model a bot was pinned to', async () => {
    script.entries.add(FIRST + 8)
    const { requests } = await review(flatCandles(FIRST + 60), () => CONFIRM, { model: 'anthropic/claude-haiku', source: 'bot' })
    expect(requests[0]).toMatchObject({ model: 'anthropic/claude-haiku', source: 'bot' })
  })
})

describe('what each ruling was worth', () => {
  it('shows a vetoed entry the trade it removed', async () => {
    script.entries.add(FIRST + 8)
    script.exits.add(FIRST + 20)
    script.entries.add(FIRST + 30)
    script.exits.add(FIRST + 40)
    // The first trade loses, the second wins.
    const candles = flatCandles(FIRST + 60, (candle, index) => {
      if (index > FIRST + 8 && index <= FIRST + 20) candle.close = 95
      if (index > FIRST + 30) candle.close = 110
    })

    const { run } = await review(candles, (index) => (index === FIRST + 8 ? VETO : CONFIRM))
    const reviews = reviewEntries(candles, run)
    expect(reviews.map((entry) => [entry.index, entry.confirmed])).toEqual([
      [FIRST + 8, false],
      [FIRST + 30, true]
    ])
    // The veto's row carries the losing trade the strategy alone took from that bar...
    expect(reviews[0].trade).toEqual(run.quantOnly.trades[0])
    expect(reviews[0].trade?.pnl).toBeLessThan(0)
    // ...and the confirmed row carries the trade that was actually made.
    expect(reviews[1].trade?.entryTime).toBe(run.result.trades[0].entryTime)
    expect(reviews[1].trade?.returnPct).toBeCloseTo(run.result.trades[0].returnPct, 10)
    expect(reviews[1].trade?.pnl).toBeGreaterThan(0)
    expect(reviews[0].price).toBe(100)
  })

  it('shows a later veto the trade from ITS bar, not the first trade of the run', async () => {
    script.entries.add(FIRST + 8)
    script.exits.add(FIRST + 20)
    script.entries.add(FIRST + 30)
    script.exits.add(FIRST + 40)
    const candles = flatCandles(FIRST + 60, (candle, index) => {
      if (index > FIRST + 30) candle.close = 110
    })

    const { run } = await review(candles, (index) => (index === FIRST + 30 ? VETO : CONFIRM))
    const [, vetoed] = reviewEntries(candles, run)
    expect(vetoed.confirmed).toBe(false)
    expect(vetoed.trade?.entryTime).toBe(candles[FIRST + 30].time)
    expect(vetoed.trade?.exitTime).toBe(candles[FIRST + 40].time)
    expect(vetoed.trade?.returnPct).toBeGreaterThan(9)
  })

  it('has no trade to show for a bar the engine would not have entered on', () => {
    const candles = flatCandles(FIRST + 20)
    const signals = { entries: candles.map(() => false), exits: candles.map(() => false), stopPrices: candles.map(() => null), warmupBars: FIRST }
    expect(tradeFrom(candles, 'probe', signals, FIRST + 5)).toBeNull()
  })

  it('counts rulings, and charges only the ones this run paid for', () => {
    const counts = confirmationCounts([
      CONFIRM,
      VETO,
      answer('buy', 0.9, { cached: true }),
      answer('hold', 0, { rejected: 'not valid JSON' })
    ])
    expect(counts).toEqual({ reviewed: 4, confirmed: 2, vetoed: 2, refused: 1, cached: 1, generated: 3, costUsd: expect.closeTo(0.006, 10) })
  })
})

describe('canConfirmEntries', () => {
  it('is true for every strategy whose decisions are its own rules', () => {
    for (const strategy of STRATEGIES) {
      expect(canConfirmEntries(strategy.id), strategy.id).toBe(strategy.id !== GPT_INTRADAY_STRATEGY_ID)
    }
  })

  it('is false for something that is not a registered strategy', () => {
    // getStrategy would fall back to the default for these; a saved executor must not be offered
    // a model to review entries it does not have.
    expect(canConfirmEntries('executor:abc')).toBe(false)
    expect(canConfirmEntries('')).toBe(false)
  })
})
