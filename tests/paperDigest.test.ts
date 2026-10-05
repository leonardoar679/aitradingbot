import { describe, expect, it } from 'vitest'
import type { ExecutorConfig, PositionExecutorParams } from '../shared/ipc'
import { DEFAULT_PAPER_DIGEST, healPaperDigest, paperDigest, paperDigestNotice, planPaperDigest, riskedAtStop, utcDay } from '../shared/paperDigest'

// shared/paperDigest.ts: the one notice a day of what the app's own paper trades did the UTC day
// before. src/risk/PaperDigestScheduler.tsx raises it, and tests/aiNoLivePath.test.ts holds that to
// reading settings and saying so.

const DAY = '2026-10-05'
const D = Date.parse(`${DAY}T00:00:00Z`) / 1000
const H = 3600

const params = (amountQuote: number, stopLossPct: number | null): PositionExecutorParams => ({
  side: 'buy',
  entryPrice: null,
  amountQuote,
  takeProfitPct: stopLossPct === null ? null : stopLossPct * 2,
  stopLossPct,
  timeLimitSec: 3600,
  trailingStop: null
})

function position(id: string, overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    id,
    name: id,
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: D + 9 * H,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: params(100, 1.5),
    ...overrides
  }
}

type Exit = NonNullable<NonNullable<ExecutorConfig['watch']>['result']>['exit']
const watched = (id: string, createdAt: number, result?: { exit: Exit; pnlQuote: number; closedAt: number }): ExecutorConfig =>
  position(id, {
    createdAt,
    status: result === undefined ? 'active' : 'stopped',
    watch: { eventId: `binance:SOLUSDT:${id}`, eventTime: createdAt, model: 'openai/gpt-5-mini', confidence: 0.8, ...(result === undefined ? {} : { result }) }
  })
const shorted = (id: string, stake: number, stopLossPct: number | null, result: { exit: Exit; pnlQuote: number; closedAt: number }): ExecutorConfig =>
  position(id, {
    status: 'stopped',
    params: { ...params(stake, stopLossPct), side: 'sell' },
    newsRule: { articleId: 7, ticker: 'SOL', releaseSec: D + 9 * H, title: 't', category: stopLossPct === null ? 'DELISTING' : 'MONITORING_TAG', result }
  })

/** One day's trades: what each origin opened and closed on 5 October, and what is not theirs. */
const DAY_OF_TRADES: ExecutorConfig[] = [
  // Opened and closed that day at its target: 1.70 made on 1.70 risked, +1 R.
  watched('target', D + 9 * H, { exit: 'take_profit', pnlQuote: 1.7, closedAt: D + 10 * H }),
  // Opened the day before, out by its clock that day: -0.85, half of what it risked.
  watched('clock', D - 2 * H, { exit: 'time_limit', pnlQuote: -0.85, closedAt: D + 1 * H }),
  // Opened that day, its entry never reached.
  watched('unfilled', D + 11 * H, { exit: 'entry_expired', pnlQuote: 0, closedAt: D + 11 * H + 900 }),
  // Opened that day and still open.
  watched('open', D + 20 * H),
  // Opened that day and stopped by hand: no result, so not closed.
  { ...watched('by hand', D + 12 * H), status: 'stopped' },
  // Closed the day before: not this day's.
  watched('yesterday', D - 5 * H, { exit: 'take_profit', pnlQuote: 9, closedAt: D - 4 * H }),
  // A delisting's short, held with no stop: +12.40.
  shorted('delisting', 100, null, { exit: 'time_limit', pnlQuote: 12.4, closedAt: D + 13 * H }),
  // A tag's short stopped out: -0.95 on 50 staked 2% from its stop, 1.10 risked.
  shorted('tag', 50, 2, { exit: 'stop_loss', pnlQuote: -0.95, closedAt: D + 14 * H }),
  // Not the app's own: a paper position made by hand, and a real one carrying the watch's mark.
  position('mine', { status: 'stopped' }),
  { ...watched('real', D + 9 * H, { exit: 'take_profit', pnlQuote: 50, closedAt: D + 10 * H }), mode: 'live' }
]

describe('the setting', () => {
  it('is on until switched off, and remembers the last day it told', () => {
    expect(DEFAULT_PAPER_DIGEST).toEqual({ enabled: true, lastDay: null })
    for (const nothing of [undefined, null, 'on', [], { enabled: 'no' }]) expect(healPaperDigest(nothing)).toEqual(DEFAULT_PAPER_DIGEST)
    expect(healPaperDigest({ enabled: false, lastDay: DAY })).toEqual({ enabled: false, lastDay: DAY })
    expect(healPaperDigest({ enabled: true, lastDay: '5 Oct' })).toEqual({ enabled: true, lastDay: null })
  })
})

describe('what a closed trade risked', () => {
  it('is its stake times the distance to its stop and the fees of a round trip', () => {
    expect(riskedAtStop({ amountQuote: 100, stopLossPct: 1.5 })).toBeCloseTo(1.7, 12)
    expect(riskedAtStop({ amountQuote: 50, stopLossPct: 2 })).toBeCloseTo(1.1, 12)
  })

  it('is nothing to measure against with no stop', () => {
    expect(riskedAtStop({ amountQuote: 100, stopLossPct: null })).toBeNull()
    expect(riskedAtStop({ amountQuote: 100, stopLossPct: 0 })).toBeNull()
    expect(riskedAtStop({ amountQuote: 0, stopLossPct: 1.5 })).toBeNull()
  })
})

describe("a day's digest", () => {
  it('counts what each origin opened and closed that day, and what it made against what it risked', () => {
    expect(utcDay(D + 23 * H)).toBe(DAY)
    const digest = paperDigest(DAY_OF_TRADES, DAY)
    expect(digest.watch).toMatchObject({ opened: 4, closed: 3, neverEntered: 1, ahead: 1, rTrades: 2, unmeasured: 0 })
    expect(digest.watch.pnl).toEqual([{ asset: 'USDT', amount: expect.closeTo(0.85, 9) }])
    expect(digest.watch.r).toBeCloseTo(0.5, 9)
    expect(digest.news).toMatchObject({ opened: 2, closed: 2, neverEntered: 0, ahead: 1, rTrades: 1, unmeasured: 1 })
    expect(digest.news.pnl).toEqual([{ asset: 'USDT', amount: expect.closeTo(11.45, 9) }])
    expect(digest.news.r).toBeCloseTo(-0.95 / 1.1, 9)
    expect(digest.openNow).toBe(1)
  })

  it('says it in one notice', () => {
    expect(paperDigestNotice(paperDigest(DAY_OF_TRADES, DAY))).toEqual({
      title: 'Paper trades on 5 Oct (UTC)',
      body:
        'The watch opened 4 paper trades and closed 2, 1 of them ahead: +0.85 USDT after fees, or +0.50 R against what each risked at its stop; 1 more never entered. ' +
        'The news rules opened 2 paper shorts and closed 2, 1 of them ahead: +11.45 USDT after fees, or -0.86 R for the 1 with a stop. ' +
        '1 is open now. Nothing real was placed.'
    })
  })

  it('says only what there is to say', () => {
    const opened = paperDigestNotice(paperDigest([watched('open', D + 20 * H)], DAY))
    expect(opened?.body).toBe('The watch opened 1 paper trade. 1 is open now. Nothing real was placed.')
    const unfilled = paperDigestNotice(paperDigest([watched('unfilled', D - 2 * H, { exit: 'btc_moved', pnlQuote: 0, closedAt: D + H })], DAY))
    expect(unfilled?.body).toBe('The watch opened no paper trades, and 1 never entered. None is open now. Nothing real was placed.')
    const delisted = paperDigestNotice(paperDigest([shorted('delisting', 100, null, { exit: 'time_limit', pnlQuote: 12.4, closedAt: D + 13 * H })], DAY))
    expect(delisted?.body).toBe('The news rules opened 1 paper short and closed 1, 1 of them ahead: +12.40 USDT after fees, with no stop to measure R against. None is open now. Nothing real was placed.')
  })

  it('is no notice on a day with nothing opened or closed', () => {
    expect(paperDigestNotice(paperDigest(DAY_OF_TRADES, '2026-10-07'))).toBeNull()
    expect(paperDigestNotice(paperDigest([], DAY))).toBeNull()
    // Only what is not the app's own happened: nothing to tell.
    expect(paperDigestNotice(paperDigest(DAY_OF_TRADES.slice(-2), DAY))).toBeNull()
  })
})

describe('when it tells', () => {
  const next = D + 86_400 + 60

  it('tells the day before, once, at the first look after midnight UTC', () => {
    const plan = planPaperDigest({ setting: DEFAULT_PAPER_DIGEST, executors: DAY_OF_TRADES, nowSec: next })
    expect(plan?.day).toBe(DAY)
    expect(plan?.notice?.title).toBe('Paper trades on 5 Oct (UTC)')
    expect(planPaperDigest({ setting: { enabled: true, lastDay: DAY }, executors: DAY_OF_TRADES, nowSec: next + 5 * H })).toBeNull()
  })

  it('marks a quiet day told without a notice, and tells nothing while it is off', () => {
    expect(planPaperDigest({ setting: DEFAULT_PAPER_DIGEST, executors: [], nowSec: next })).toEqual({ day: DAY, notice: null })
    expect(planPaperDigest({ setting: { enabled: false, lastDay: null }, executors: DAY_OF_TRADES, nowSec: next })).toBeNull()
  })

  it('does not catch up on days the app was closed: only the day before is told', () => {
    const plan = planPaperDigest({ setting: { enabled: true, lastDay: '2026-10-01' }, executors: DAY_OF_TRADES, nowSec: next })
    expect(plan?.day).toBe(DAY)
  })
})
