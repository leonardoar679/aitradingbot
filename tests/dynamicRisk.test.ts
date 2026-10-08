import { describe, expect, it } from 'vitest'
import { FIFTEEN_MINUTES, RISK_LINES, atrPct, liquidityCoverOf, riskMultiplier, riskReasonsText, riskRefusal, usualAtrPct, volatilityRatio } from '../shared/dynamicRisk'
import type { Candle } from '../shared/ipc'
import { paperStake, sizePaperTrade } from '../shared/paperRisk'
import { planWatchPaperTrade, riskNoteOf } from '../shared/aiWatchPaper'
import type { AiSignalDecision } from '../shared/aiSignal'
import type { MarketEvent } from '../shared/marketEvent'
import type { PaperRiskSettings } from '../shared/ipc'

// RISK BY THE CONDITIONS (shared/dynamicRisk.ts; the V5 document, §46-47 and §72-73; V5 Stage 7,
// 8 October 2026): the whole risk, six tenths, or none, with the reasons; and the sizing that
// follows it (shared/paperRisk.ts, shared/aiWatchPaper.ts).

const none = { volatilityRatio: null, spreadPct: null, liquidityCover: null, dissent: null, correlatedShare: null }

describe('the multiplier', () => {
  it('is the whole risk with nothing against the trade, and with nothing read', () => {
    expect(riskMultiplier(none)).toEqual({ factor: 1, reasons: [] })
    expect(riskMultiplier({ volatilityRatio: 1.49, spreadPct: 0.049, liquidityCover: 3, dissent: false, correlatedShare: 0.1 })).toEqual({ factor: 1, reasons: [] })
    expect(riskMultiplier({ ...none, volatilityRatio: Number.NaN, spreadPct: Number.POSITIVE_INFINITY })).toEqual({ factor: 1, reasons: [] })
  })

  it('is none at extreme volatility, whatever else, and says so as a refusal', () => {
    const extreme = riskMultiplier({ ...none, volatilityRatio: 3.4, spreadPct: 0.2 })
    expect(extreme).toEqual({ factor: 0, reasons: ['extreme volatility, 3.4× its usual'] })
    expect(riskRefusal(extreme)).toBe('The conditions allow no trade: extreme volatility, 3.4× its usual.')
    expect(riskMultiplier({ ...none, volatilityRatio: RISK_LINES.volatilityExtreme }).factor).toBe(0)
    expect(riskRefusal(riskMultiplier({ ...none, volatilityRatio: 2.9 }))).toBeNull()
  })

  it('is six tenths with any one condition against it, each with its reason', () => {
    expect(riskMultiplier({ ...none, volatilityRatio: 1.5 })).toEqual({ factor: 0.6, reasons: ['high volatility, 1.5× its usual'] })
    expect(riskMultiplier({ ...none, spreadPct: 0.05 })).toEqual({ factor: 0.6, reasons: ['a spread of 0.050%'] })
    expect(riskMultiplier({ ...none, liquidityCover: 2.9 })).toEqual({ factor: 0.6, reasons: ['the best level covers the stake 2.9 times'] })
    expect(riskMultiplier({ ...none, dissent: true })).toEqual({ factor: 0.6, reasons: ['a model would not take it'] })
    expect(riskMultiplier({ ...none, correlatedShare: 0.101 })).toEqual({ factor: 0.6, reasons: ['10% of the paper money already out on this side on coins that move with Bitcoin'] })
    const all = riskMultiplier({ volatilityRatio: 1.8, spreadPct: 0.06, liquidityCover: 1.2, dissent: true, correlatedShare: 0.12 })
    expect(all.factor).toBe(0.6)
    expect(all.reasons).toHaveLength(5)
    expect(riskReasonsText(all)).toBe('high volatility, 1.8× its usual; a spread of 0.060%; the best level covers the stake 1.2 times; a model would not take it; 12% of the paper money already out on this side on coins that move with Bitcoin')
  })

  it('has its lines pinned', () => {
    expect(RISK_LINES).toEqual({ atrBars: 14, usualDays: 30, usualWindows: 10, volatilityHigh: 1.5, volatilityExtreme: 3, spreadPct: 0.05, liquidityCover: 3, correlatedShare: 0.1, reduced: 0.6 })
  })
})

/** Fifteen-minute bars from `start`, each `rangePct` of 100 wide around 100, closing at 100. */
function bars(count: number, start: number, rangePct: number, over: Partial<Candle> = {}): Candle[] {
  return Array.from({ length: count }, (_, k) => ({ time: start + k * FIFTEEN_MINUTES, open: 100, high: 100 + rangePct / 2, low: 100 - rangePct / 2, close: 100, volume: 1, ...over }))
}

describe('the range now against its usual', () => {
  const T = 1_800_000_000

  it('reads the average true range of the last fourteen bars as a percent of the close, widened to the previous close where a bar gapped', () => {
    expect(atrPct(bars(15, T, 0.4))).toBeCloseTo(0.4, 10)
    expect(atrPct(bars(14, T, 0.4))).toBeNull()
    // A bar that gapped up: its range runs from the previous close.
    const gapped = bars(15, T, 0.4)
    gapped[14] = { ...gapped[14], open: 101, high: 101.2, low: 100.8, close: 101 }
    expect(atrPct(gapped)).toBeCloseTo((13 * 0.4 + 1.2) / 14 / 101 * 100, 10)
    expect(atrPct([...bars(14, T, 0.4), { time: T + 14 * FIFTEEN_MINUTES, open: 100, high: 99, low: 100, close: 100, volume: 1 }])).toBeNull()
  })

  it('reads the usual as the median over consecutive windows, newest first, and needs ten of them', () => {
    // 141 bars: ten windows of fourteen, the newest wider than the rest.
    const month = [...bars(127, T, 0.2), ...bars(14, T + 127 * FIFTEEN_MINUTES, 2)]
    expect(usualAtrPct(month)).toBeCloseTo(0.2, 10)
    expect(usualAtrPct(bars(140, T, 0.2))).toBeNull()
  })

  it('is the last fourteen closed bars over the usual, leaving a forming bar out', () => {
    const now = T + 141 * FIFTEEN_MINUTES
    const month = [...bars(127, T, 0.2), ...bars(14, T + 127 * FIFTEEN_MINUTES, 0.36)]
    expect(volatilityRatio(month, now)).toBeCloseTo(1.8, 6)
    // A forming bar, however wide, is not read.
    const forming = { time: now - 60, open: 100, high: 120, low: 80, close: 100, volume: 1 }
    expect(volatilityRatio([...month, forming], now)).toBeCloseTo(1.8, 6)
    expect(volatilityRatio(bars(20, T, 0.2), now)).toBeNull()
    expect(volatilityRatio([], now)).toBeNull()
  })

  it('reads how many times the best level holds the stake', () => {
    const book = { bid: 99.9, ask: 100.1, bidQty: 2, askQty: 3 }
    expect(liquidityCoverOf(book, 'buy', 100)).toBeCloseTo(3.003, 10)
    expect(liquidityCoverOf(book, 'sell', 100)).toBeCloseTo(1.998, 10)
    expect(liquidityCoverOf(null, 'buy', 100)).toBeNull()
    expect(liquidityCoverOf(book, 'buy', 0)).toBeNull()
  })
})

const RISK: PaperRiskSettings = { sizing: 'risk', riskQuote: 1, riskPct: 0.25, maxOutQuote: 1000 }

describe('a stake at the factor', () => {
  it('is six tenths of the whole, rounded down, and the whole at a factor that is not one', () => {
    // 1 / 1.7% is 58.82 at the whole risk; six tenths of it 35.29.
    expect(paperStake({ risk: RISK, stakeQuote: 100, stopPct: 1.5 })).toBe(58.82)
    expect(paperStake({ risk: RISK, stakeQuote: 100, stopPct: 1.5, multiplier: 0.6 })).toBe(35.29)
    expect(paperStake({ risk: { ...RISK, sizing: 'stake' }, stakeQuote: 100, stopPct: 1.5, multiplier: 0.6 })).toBe(60)
    expect(paperStake({ risk: RISK, stakeQuote: 100, stopPct: 1.5, multiplier: 1 })).toBe(58.82)
    for (const bad of [null, undefined, Number.NaN, 2, -1]) expect(paperStake({ risk: RISK, stakeQuote: 100, stopPct: 1.5, multiplier: bad })).toBe(58.82)
    expect(paperStake({ risk: RISK, stakeQuote: 100, stopPct: 1.5, multiplier: 0 })).toBe(0)
    // Under the smallest order once reduced: not opened.
    expect(sizePaperTrade({ risk: RISK, stakeQuote: 100, stopPct: 12, quoteAsset: 'USDT', multiplier: 0.6 }).ok).toBe(false)
  })

  it('says the risk it was sized at, in the words of how the trades are sized', () => {
    const reduced = { factor: 0.6 as const, reasons: ['high volatility, 1.8× its usual'] }
    expect(riskNoteOf(RISK, null, reduced, 'USDT')).toBe('risk 0.6 USDT (high volatility, 1.8× its usual)')
    expect(riskNoteOf({ ...RISK, sizing: 'equity' }, 2000, reduced, 'USDT')).toBe('risk 0.15% (high volatility, 1.8× its usual)')
    expect(riskNoteOf({ ...RISK, sizing: 'equity' }, null, reduced, 'USDT')).toBe('risk 0.6 USDT (high volatility, 1.8× its usual)')
    expect(riskNoteOf({ ...RISK, sizing: 'stake' }, null, reduced, 'USDT')).toBe('the stake at 60% (high volatility, 1.8× its usual)')
    expect(riskNoteOf(RISK, null, { factor: 1, reasons: [] }, 'USDT')).toBeNull()
  })
})

describe("the watch's plan at the conditions", () => {
  const T = 1_800_000_000
  const event: Pick<MarketEvent, 'id' | 'exchange' | 'symbol' | 'baseAsset' | 'quoteAsset' | 'time' | 'type' | 'price'> = {
    id: 'binance:SOLUSDT:1800000000',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    time: T,
    type: 'breakout',
    price: 100
  }
  const decision: AiSignalDecision = {
    model: 'openai/gpt-5-mini',
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'test',
    detail: { marketRegime: 'bull', riskLevel: 'medium', horizonBars: 4, stopLoss: 98.5, takeProfit: 103, reasonCodes: ['breakout'], levelsNote: null, entry: { min: 99.8, max: 100.2, validMinutes: 15 } },
    error: null,
    rejected: false,
    cached: false,
    usage: null,
    promptVersion: 'test',
    contextVersion: 'test',
    schemaVersion: 'test'
  } as unknown as AiSignalDecision
  const config = { enabled: true, model: 'openai/gpt-5-mini', stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 0, dropOnBtcMovePct: 0 }
  const plan = (conditions?: Parameters<typeof planWatchPaperTrade>[0]['conditions']) =>
    planWatchPaperTrade({ config, risk: RISK, event, decision, nowSec: T + 30, lastPrice: 100, equityQuote: null, conditions })

  it('sizes at the whole risk with no conditions read, and reads the cover against that stake', () => {
    // 1 at a 1.5% stop, 0.2% of fees and 0.1% of slippage (an event with no live reading is charged
    // 0.05% a fill): 1 / 1.8% is 55.55.
    const whole = plan()
    expect(whole.ok && whole.params.amountQuote).toBe(55.55)
    expect(whole.ok && whole.riskNote).toBeNull()
    expect(whole.ok && whole.mark.riskFactor).toBeUndefined()
    // 166.65 in the quote on the best level: three times 55.55, just covered.
    const covered = plan({ volatilityRatio: null, spreadPct: null, bestLevelQuote: 166.65, dissent: null, correlatedShare: null })
    expect(covered.ok && covered.params.amountQuote).toBe(55.55)
    const thin = plan({ volatilityRatio: null, spreadPct: null, bestLevelQuote: 150, dissent: null, correlatedShare: null })
    expect(thin.ok && thin.params.amountQuote).toBe(33.33)
    expect(thin.ok && thin.riskNote).toBe('risk 0.6 USDT (the best level covers the stake 2.7 times)')
  })

  it('sizes at six tenths with a condition against it, writes it on the mark, and refuses at the extreme', () => {
    const reduced = plan({ volatilityRatio: 1.8, spreadPct: 0.01, bestLevelQuote: 10_000, dissent: false, correlatedShare: 0 })
    expect(reduced.ok && reduced.params.amountQuote).toBe(33.33)
    expect(reduced.ok && reduced.riskNote).toBe('risk 0.6 USDT (high volatility, 1.8× its usual)')
    expect(reduced.ok && reduced.mark.riskFactor).toBe(0.6)
    expect(reduced.ok && reduced.mark.riskReasons).toEqual(['high volatility, 1.8× its usual'])
    const refused = plan({ volatilityRatio: 3.2, spreadPct: null, bestLevelQuote: null, dissent: null, correlatedShare: null })
    expect(refused).toEqual({ ok: false, reason: 'The conditions allow no trade: extreme volatility, 3.2× its usual.' })
  })
})
