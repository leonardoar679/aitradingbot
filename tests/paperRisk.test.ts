import { describe, expect, it } from 'vitest'
import type { ExecutorConfig, PaperRiskSettings, PositionExecutorParams } from '../shared/ipc'
import {
  DEFAULT_PAPER_RISK,
  PAPER_MAX_OUT_CHOICES,
  PAPER_MIN_STAKE,
  PAPER_RISK_CHOICES,
  PAPER_RISK_PCT_CHOICES,
  describePaperRisk,
  healPaperRisk,
  paperEquity,
  paperOut,
  paperOutBlock,
  paperRiskProblem,
  paperStake,
  riskPerTrade,
  riskedAtStop,
  sizePaperTrade
} from '../shared/paperRisk'

// shared/paperRisk.ts: how the paper trades the app opens by itself -- the watch's and the news
// rules' -- are sized, and how much they may stake together. The two writers are held to it in
// tests/aiWatchPaper.test.ts and tests/newsActions.test.ts.

const RISK: PaperRiskSettings = { sizing: 'risk', riskQuote: 1, riskPct: 0.25, maxOutQuote: 1000 }

const params = (amountQuote: number): PositionExecutorParams => ({
  side: 'buy',
  entryPrice: null,
  amountQuote,
  takeProfitPct: 3,
  stopLossPct: 1.5,
  timeLimitSec: 3600,
  trailingStop: null
})

function position(id: string, amountQuote: number, overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    id,
    name: id,
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: 1,
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
    params: params(amountQuote),
    ...overrides
  }
}

const WATCH = { eventId: 'binance:SOLUSDT:1', eventTime: 1, model: 'openai/gpt-5-mini', confidence: 0.8 }
const NEWS = { articleId: 7, ticker: 'XRP', releaseSec: 1, title: 'Binance Will Delist XRP on 2026-10-20', category: 'DELISTING' as const }

describe('the setting', () => {
  it('is on until changed: a stop risks about 1, and 1,000 at most out together', () => {
    expect(DEFAULT_PAPER_RISK).toEqual({ sizing: 'risk', riskQuote: 1, riskPct: 0.25, maxOutQuote: 1000 })
    for (const nothing of [undefined, null, 'risk', 7, []]) expect(healPaperRisk(nothing)).toEqual(DEFAULT_PAPER_RISK)
  })

  it('reads back each of its choices, and no cap as a choice of its own', () => {
    expect(healPaperRisk({ sizing: 'stake', riskQuote: 25, riskPct: 0.25, maxOutQuote: null })).toEqual({ sizing: 'stake', riskQuote: 25, riskPct: 0.25, maxOutQuote: null })
    for (const riskQuote of PAPER_RISK_CHOICES) for (const maxOutQuote of PAPER_MAX_OUT_CHOICES) expect(healPaperRisk({ sizing: 'risk', riskQuote, maxOutQuote })).toEqual({ sizing: 'risk', riskQuote, riskPct: 0.25, maxOutQuote })
  })

  it('heals a field that is not one of its choices to its default, a missing cap included', () => {
    expect(healPaperRisk({ sizing: 'kelly', riskQuote: 3, maxOutQuote: 123 })).toEqual(DEFAULT_PAPER_RISK)
    expect(healPaperRisk({ sizing: 'stake', riskQuote: 10 })).toEqual({ sizing: 'stake', riskQuote: 10, riskPct: 0.25, maxOutQuote: 1000 })
    expect(healPaperRisk({ sizing: 'stake', riskQuote: '10', riskPct: 0.25, maxOutQuote: '500' })).toEqual({ sizing: 'stake', riskQuote: 1, riskPct: 0.25, maxOutQuote: 1000 })
  })

  it('can only be saved as one of its choices', () => {
    expect(paperRiskProblem(RISK)).toBeNull()
    expect(paperRiskProblem({ ...RISK, maxOutQuote: null })).toBeNull()
    expect(paperRiskProblem({ ...RISK, sizing: 'kelly' as 'risk' })).toMatch(/sized by the risk at its stop, by a share of the paper account, or by its stake/)
    expect(paperRiskProblem({ ...RISK, riskQuote: 3 })).toMatch(/risks 1, 2, 5, 10, 25, 50/)
    expect(paperRiskProblem({ ...RISK, maxOutQuote: 0 })).toMatch(/or have no cap/)
  })

  it('says how it is set', () => {
    expect(describePaperRisk(RISK)).toBe('Each with a stop stakes what would lose about 1 there, after fees, and never more than its own stake. Together they stake at most 1,000.')
    expect(describePaperRisk({ sizing: 'stake', riskQuote: 5, riskPct: 0.25, maxOutQuote: null })).toBe('Each stakes its own stake. There is no cap on what they stake together.')
  })
})

describe('a stake sized by risk', () => {
  it("is what the stop would lose about the risk at, after a round trip's fees, rounded down", () => {
    // 1.5% to the stop and 0.2% of fees: 1 / 1.7% is 58.8235…
    expect(paperStake({ risk: RISK, stakeQuote: 100, stopPct: 1.5 })).toBe(58.82)
    expect(paperStake({ risk: { ...RISK, riskQuote: 10 }, stakeQuote: 10_000, stopPct: 0.8 })).toBe(1000)
    // So the stop does lose about the risk: 58.82 short of 1.7%, less than the rounding.
    expect(58.82 * (1.5 / 100 + 0.002)).toBeCloseTo(1, 3)
  })

  it('is never more than its own stake, and is the stake with no stop to size from', () => {
    expect(paperStake({ risk: RISK, stakeQuote: 100, stopPct: 0.5 })).toBe(100)
    for (const stopPct of [null, 0, -1, Number.NaN]) expect(paperStake({ risk: RISK, stakeQuote: 250, stopPct })).toBe(250)
    expect(paperStake({ risk: { ...RISK, sizing: 'stake' }, stakeQuote: 250, stopPct: 1.5 })).toBe(250)
  })

  it('is not opened under what the smallest order on Binance is worth', () => {
    expect(PAPER_MIN_STAKE).toBe(5)
    // 1 / (19.8% + 0.2%) is exactly 5: opened. A stop any farther is not.
    expect(sizePaperTrade({ risk: RISK, stakeQuote: 100, stopPct: 19.8, quoteAsset: 'USDT' })).toEqual({ ok: true, amountQuote: 5 })
    expect(sizePaperTrade({ risk: RISK, stakeQuote: 100, stopPct: 25, quoteAsset: 'USDT' })).toEqual({
      ok: false,
      reason: 'Its stop is 25% away, so risking 1 USDT there stakes 3.96 USDT: under the 5 the smallest order on Binance is worth.'
    })
    expect(sizePaperTrade({ risk: RISK, stakeQuote: 100, stopPct: 1.5, quoteAsset: 'USDT' })).toEqual({ ok: true, amountQuote: 58.82 })
  })

  it("counts a trade's slippage on both fills, in what it stakes and in what it risks", () => {
    // 1.5% to the stop, 0.2% of fees and 2 bp a side: 1 / 1.74% is 57.47.
    expect(paperStake({ risk: RISK, stakeQuote: 100, stopPct: 1.5, slippageRate: 0.0002 })).toBe(57.47)
    expect(sizePaperTrade({ risk: RISK, stakeQuote: 100, stopPct: 1.5, quoteAsset: 'USDT', slippageRate: 0.0002 })).toEqual({ ok: true, amountQuote: 57.47 })
    expect(riskedAtStop({ amountQuote: 100, stopLossPct: 1.5, slippageRate: 0.0002 })).toBeCloseTo(1.74, 12)
    // None carried, none counted; and a rate that is not one is none.
    expect(riskedAtStop({ amountQuote: 100, stopLossPct: 1.5 })).toBeCloseTo(1.7, 12)
    for (const slippageRate of [null, Number.NaN, -0.001, 1]) {
      expect(riskedAtStop({ amountQuote: 100, stopLossPct: 1.5, slippageRate })).toBeCloseTo(1.7, 12)
      expect(paperStake({ risk: RISK, stakeQuote: 100, stopPct: 1.5, slippageRate })).toBe(58.82)
    }
  })
})

describe('what the app has out', () => {
  it("counts the watch's and the news rules' open paper positions, in one quote asset", () => {
    const executors = [
      position('watch', 300, { watch: WATCH }),
      position('news', 200, { newsRule: NEWS }),
      position('stopped', 999, { watch: WATCH, status: 'stopped' }),
      position('by hand', 5000),
      position('real', 999, { watch: WATCH, mode: 'live' }),
      position('grid', 999, { watch: WATCH, type: 'grid' }),
      position('other quote', 999, { newsRule: NEWS, quoteAsset: 'BTC' }),
      position('malformed', Number.NaN, { watch: WATCH })
    ]
    expect(paperOut(executors, 'USDT')).toBe(500)
    expect(paperOut(executors, 'BTC')).toBe(999)
    expect(paperOut([], 'USDT')).toBe(0)
  })

  it('refuses one more that would take them past the cap, and lets one in up to it', () => {
    const executors = [position('watch', 600, { watch: WATCH }), position('news', 300, { newsRule: NEWS })]
    expect(paperOutBlock({ risk: RISK, executors, quoteAsset: 'USDT', amountQuote: 100 })).toBeNull()
    expect(paperOutBlock({ risk: RISK, executors, quoteAsset: 'USDT', amountQuote: 100.01 })).toBe(
      "The watch's and the news rules' open paper trades stake 900 USDT together, and 100.01 more would take them past the 1,000 set on Risk & Safety."
    )
    // Out in another quote asset, or with no cap, nothing is refused.
    expect(paperOutBlock({ risk: RISK, executors, quoteAsset: 'BTC', amountQuote: 1000 })).toBeNull()
    expect(paperOutBlock({ risk: { ...RISK, maxOutQuote: null }, executors, quoteAsset: 'USDT', amountQuote: 1_000_000 })).toBeNull()
    // 5.33, 739.33 and 255.34 are 1,000 to the cent, and a hair over it in floating point: the
    // arithmetic's rounding does not count against the cap.
    const open = [position('a', 5.33, { watch: WATCH }), position('b', 739.33, { newsRule: NEWS })]
    expect(paperOut(open, 'USDT') + 255.34).toBeGreaterThan(1000)
    expect(paperOutBlock({ risk: RISK, executors: open, quoteAsset: 'USDT', amountQuote: 255.34 })).toBeNull()
    expect(paperOutBlock({ risk: RISK, executors: open, quoteAsset: 'USDT', amountQuote: 255.35 })).not.toBeNull()
  })
})

describe('a stake sized by a share of the paper account (8 October 2026)', () => {
  const EQUITY: PaperRiskSettings = { sizing: 'equity', riskQuote: 1, riskPct: 0.5, maxOutQuote: 1000 }
  const account = (usdt: number): { balances: Record<string, number> } => ({ balances: { USDT: usdt } })

  it('is on offer as a choice, read back, and saved only as one of its shares', () => {
    expect(PAPER_RISK_PCT_CHOICES).toEqual([0.1, 0.25, 0.5, 1, 2])
    expect(healPaperRisk({ sizing: 'equity', riskQuote: 2, riskPct: 1, maxOutQuote: 500 })).toEqual({ sizing: 'equity', riskQuote: 2, riskPct: 1, maxOutQuote: 500 })
    expect(healPaperRisk({ sizing: 'equity', riskQuote: 2, riskPct: 3, maxOutQuote: 500 }).riskPct).toBe(0.25)
    expect(paperRiskProblem(EQUITY)).toBeNull()
    expect(paperRiskProblem({ ...EQUITY, riskPct: 3 })).toMatch(/risks 0.1, 0.25, 0.5, 1, 2% of the paper account/)
  })

  it("measures the account's equity in a quote asset: its balance and what its own trades have out", () => {
    expect(paperEquity(account(900), [position('a', 100, { watch: WATCH })], 'USDT')).toBe(1000)
    expect(paperEquity(account(900), [position('a', 100)], 'USDT')).toBe(900)
    expect(paperEquity(account(0), [], 'USDT')).toBeNull()
    expect(paperEquity(null, [position('a', 100, { watch: WATCH })], 'USDT')).toBeNull()
    expect(paperEquity(undefined, [], 'USDT')).toBeNull()
    expect(paperEquity({ balances: { BTC: 1 } }, [], 'USDT')).toBeNull()
  })

  it('risks the share of the equity at the stop, and the fixed risk without an account', () => {
    expect(riskPerTrade(EQUITY, 1000)).toBe(5)
    expect(riskPerTrade(EQUITY, null)).toBe(1)
    expect(riskPerTrade(EQUITY, undefined)).toBe(1)
    // An equity of nothing, or less, is no equity to take a share of: the fixed risk stands.
    expect(riskPerTrade(EQUITY, 0)).toBe(1)
    expect(riskPerTrade(EQUITY, -50)).toBe(1)
    expect(riskPerTrade(RISK, 1000)).toBe(1)
    // 5 at a 1.5% stop and 0.2% of fees: 5 / 1.7% is 294.11; held to a stake of 100.
    expect(paperStake({ risk: EQUITY, stakeQuote: 1000, stopPct: 1.5, equityQuote: 1000 })).toBe(294.11)
    expect(paperStake({ risk: EQUITY, stakeQuote: 100, stopPct: 1.5, equityQuote: 1000 })).toBe(100)
    expect(paperStake({ risk: EQUITY, stakeQuote: 1000, stopPct: 1.5, equityQuote: null })).toBe(58.82)
    expect(paperStake({ risk: EQUITY, stakeQuote: 1000, stopPct: 1.5 })).toBe(58.82)
    expect(sizePaperTrade({ risk: EQUITY, stakeQuote: 100, stopPct: 25, quoteAsset: 'USDT', equityQuote: 1000 })).toEqual({ ok: true, amountQuote: 19.84 })
    expect(sizePaperTrade({ risk: EQUITY, stakeQuote: 100, stopPct: 25, quoteAsset: 'USDT', equityQuote: 100 })).toEqual({
      ok: false,
      reason: 'Its stop is 25% away, so risking 0.5 USDT there stakes 1.98 USDT: under the 5 the smallest order on Binance is worth.'
    })
  })

  it('says how it is set', () => {
    expect(describePaperRisk(EQUITY)).toBe(
      "Each with a stop stakes what would lose about 0.5% of the paper account's equity there, after fees, and never more than its own stake; without a paper account, about 1. Together they stake at most 1,000."
    )
  })
})
