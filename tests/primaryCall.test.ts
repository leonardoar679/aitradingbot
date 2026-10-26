import { describe, expect, it } from 'vitest'
import { DELISTING_STUDY } from '../shared/delistingStudy'
import {
  CARD_SOURCES,
  DELISTING_CARD_LINES,
  DELIST_LIVE_LINES,
  PRIMARY_CALL_LINES,
  clearsLines,
  delistLiveOf,
  delistingCardOf,
  delistingExitAt,
  delistingFiguresOf,
  expectedNetOf,
  isCard,
  isCardSideSource,
  modelCardOf,
  quantileOf,
  rankCards,
  type DelistLiveReading,
  type DelistingCandidate,
  type PrimaryCard
} from '../shared/forecast/primaryCall'
import { DIRECTION_MODELS } from '../shared/forecast/models'
import { ROUND_TRIP_PCT } from '../shared/forecast/edge'
import type { LiquidityVerdict } from '../shared/liquidityGate'
import type { RoundTrip } from '../shared/venueCosts'

// THE PRIMARY CALL (shared/forecast/primaryCall.ts; V8 Stage 3): a card's side only from the registry -- the delisting
// rule, a direction model that cleared the bar twice -- and a card only where the expected net after the route's cost
// clears its lines (V8-S3-EV); the delisting card from the study's own coins, within the rule's five minutes, withdrawn
// or marked weaker by its live check (V8-S3-DELIST-CARD, V8-S3-DELIST-LIVE).

const RELEASE = 1_793_030_430 // 16:00:30 UTC, half a minute into its minute
const trip: RoundTrip = { venue: 'binance', feePct: 0.1, spreadPct: 0.3, impactPct: 0.2, totalPct: 0.7, basis: 'book' }
const passing: LiquidityVerdict = { ok: true, trip, depthQuote: 5_000 }
const candidate: DelistingCandidate = { articleId: 4242, title: 'Binance Will Delist ABC on 2026-11-02', releaseSec: RELEASE, ticker: 'ABC', pair: 'ABCUSDT' }
const ok: DelistLiveReading = { hours: 2, coins: 2, meanPct: 11, low: 5, high: 16, state: 'ok' }

const card = (over: Partial<Parameters<typeof delistingCardOf>[0]> = {}): ReturnType<typeof delistingCardOf> =>
  delistingCardOf({ candidate, nowSec: RELEASE + 60, livePrice: 2, gate: passing, stakeQuote: 100, study: DELISTING_STUDY, live: ok, predictionId: 'delisting-rule:ABCUSDT:1793030430', ...over })

describe('the delisting study the card rests on', () => {
  const figures = delistingFiguresOf(DELISTING_STUDY.coins)
  it('reproduces what the study printed, to the digits it printed them', () => {
    const published = DELISTING_CARD_LINES.published
    expect(figures.coins).toBe(published.coins)
    expect(figures.hours).toBe(published.hours)
    expect(figures.ahead).toBe(published.ahead)
    expect(figures.hourlyMeanNetPct.toFixed(3)).toBe(published.hourlyMeanPct.toFixed(3))
    expect(figures.worstNetPct.toFixed(2)).toBe(published.worstPct.toFixed(2))
  })
  it('gives the card its median, its 10th and 90th percentiles before costs, and its target touch', () => {
    expect(figures.medianGrossPct).toBeCloseTo(DELISTING_STUDY.touch.targetPct, 4)
    expect(figures.p10GrossPct).toBeLessThan(0)
    expect(figures.p90GrossPct).toBeGreaterThan(figures.medianGrossPct)
    // Every coin's net is its gross less the study's costs: 0.2% of fees, and 0.1% of slippage on each fill of a short
    // whose exit price is (1 - gross / 100) of its entry's.
    for (const coin of DELISTING_STUDY.coins) expect(Math.abs(coin.grossPct - coin.netPct - (0.4002 - 0.002002 * coin.grossPct)), coin.ticker).toBeLessThan(2e-4)
    expect(DELISTING_STUDY.touch.of).toBe(87)
    expect(DELISTING_STUDY.touch.touched).toBeLessThanOrEqual(87)
    expect(DELISTING_STUDY.touch.p25Min).toBeLessThan(DELISTING_STUDY.touch.p75Min)
  })
  it('reads quantiles by straight lines between the order statistics', () => {
    expect(quantileOf([1, 2, 3, 4], 0.5)).toBe(2.5)
    expect(quantileOf([1, 2, 3, 4], 0)).toBe(1)
    expect(quantileOf([1, 2, 3, 4], 1)).toBe(4)
    expect(quantileOf([10], 0.9)).toBe(10)
    expect(quantileOf([], 0.5)).toBeNaN()
  })
})

describe("who may set a card's side", () => {
  it('is the registry: the delisting rule and a direction model, nothing else', () => {
    expect(Object.keys(CARD_SOURCES).sort()).toEqual(['delisting-rule', 'direction-model'])
    expect(CARD_SOURCES['delisting-rule'].registration).toBe('V8-S3-DELIST-CARD')
  })
  it("never the forecast's own distribution, the news or the base rate, whatever way they lean", () => {
    for (const source of ['distribution', 'news', 'base', undefined] as const) {
      expect(isCardSideSource(source)).toBe(false)
      for (const direction of ['BEARISH', 'BULLISH'] as const) {
        const made = modelCardOf({
          pair: 'ABCUSDT',
          nowSec: RELEASE,
          horizonSec: 3600,
          pUpSource: source,
          direction,
          livePrice: 2,
          record: { calls: 900, meanPct: 5, ci: { low: 4, high: 6 }, hours: 300 },
          quantilesPct: [-3, -2, -1, 0, 1],
          gate: passing,
          stakeQuote: 100,
          predictionId: 'x'
        })
        expect(made, `${String(source)} ${direction}`).toBeNull()
      }
    }
    for (const model of DIRECTION_MODELS) expect(isCardSideSource(model)).toBe(true)
  })
})

describe('the expected net (V8-S3-EV)', () => {
  it("is the source's calls' mean move less the cost, with its interval resampled by unit", () => {
    const calls = [
      { unit: 1, favourablePct: 4 },
      { unit: 1, favourablePct: 6 },
      { unit: 2, favourablePct: 3 },
      { unit: 3, favourablePct: 5 }
    ]
    const net = expectedNetOf(calls, 0.5)!
    expect(net.value).toBeCloseTo(4.5 - 0.5, 12)
    expect(net.low).toBeLessThan(net.value)
    expect(net.high).toBeGreaterThan(net.value)
    expect(expectedNetOf(calls, Number.NaN)).toBeNull()
    expect(expectedNetOf([], 0.5)).toBeNull()
    // One unit gives nothing to resample.
    expect(expectedNetOf([{ unit: 1, favourablePct: 4 }, { unit: 1, favourablePct: 5 }], 0.5)).toBeNull()
  })
  it('clears its lines only with its lower end above zero and its mean at least +1%', () => {
    expect(PRIMARY_CALL_LINES).toMatchObject({ level: 0.9, minLowerPct: 0, minNetPct: 1 })
    expect(clearsLines({ value: 1, low: 0.01 })).toBe(true)
    expect(clearsLines({ value: 0.99, low: 0.5 })).toBe(false)
    expect(clearsLines({ value: 3, low: 0 })).toBe(false)
    expect(clearsLines({ value: 3, low: Number.NaN })).toBe(false)
    expect(clearsLines(null)).toBe(false)
  })
})

describe('the delisting card', () => {
  it("shows the study's coins at this route's cost within the rule's five minutes", () => {
    const made = card()
    expect(isCard(made)).toBe(true)
    const shown = made as PrimaryCard
    const figures = delistingFiguresOf(DELISTING_STUDY.coins)
    expect(shown).toMatchObject({ source: 'delisting-rule', side: 'down', pair: 'ABCUSDT', venue: 'binance', eventAt: RELEASE, refPrice: 2, madeAt: RELEASE + 60 })
    expect(shown.movePct).toBeCloseTo(figures.medianGrossPct, 12)
    expect(shown.targetPrice).toBeCloseTo(2 * (1 - figures.medianGrossPct / 100), 12)
    expect(shown.exitAt).toBe(delistingExitAt(RELEASE))
    expect(shown.exitAt).toBe(RELEASE - 30 + 240 * 60)
    expect(shown.arrival).toEqual({ fromSec: -30 + DELISTING_STUDY.touch.p25Min * 60, toSec: -30 + DELISTING_STUDY.touch.p75Min * 60, touchedShare: DELISTING_STUDY.touch.touched / 87 })
    expect(shown.scenarios).toEqual({ forPct: figures.p90GrossPct, againstPct: figures.p10GrossPct, worstPct: figures.worstNetPct })
    expect(shown.ahead).toEqual({ count: 75, of: 87 })
    expect(shown.evidence).toEqual(['binance:4242'])
    expect(shown.detail).toEqual({ kind: 'delisting', ticker: 'ABC', title: candidate.title, hours: 18, coins: 87, weaker: false })
    // The hold, 16:02 to 20:00 UTC, crosses no funding time; the cost is the round trip read.
    expect(shown.cost).toMatchObject({ side: 'SELL', stakeQuote: 100, fundingPct: 0, totalPct: 0.7, basis: 'book' })
    expect(shown.netAtTargetPct).toBeCloseTo(figures.medianGrossPct - 0.7, 12)
    const net = expectedNetOf(
      DELISTING_STUDY.coins.map((coin) => ({ unit: coin.hour, favourablePct: coin.grossPct })),
      0.7
    )!
    expect(shown.expectedNet).toEqual({ pct: net.value, low: net.low, high: net.high, calls: 87, units: 18 })
    expect(shown.expectedNet.low).toBeGreaterThan(0)
  })
  it('charges the funding a hold across a funding time crosses, against it', () => {
    const late = RELEASE - (RELEASE % 86_400) + 6 * 3600 + 30 // 06:00:30 UTC: the hold to 10:00 crosses 08:00
    const made = card({ candidate: { ...candidate, releaseSec: late }, nowSec: late + 60 }) as PrimaryCard
    expect(made.cost.fundingPct).toBeCloseTo(0.01, 12)
    expect(made.cost.totalPct).toBeCloseTo(0.71, 12)
  })
  it('is refused, saying why, in the order the rule reads them', () => {
    expect(card({ live: { ...ok, state: 'withdrawn' } })).toMatchObject({ refused: 'withdrawn' })
    expect(card({ nowSec: RELEASE + DELISTING_CARD_LINES.windowSec })).toSatisfy(isCard)
    expect(card({ nowSec: RELEASE + DELISTING_CARD_LINES.windowSec + 1 })).toMatchObject({ refused: 'late', pair: 'ABCUSDT', eventAt: RELEASE })
    expect(card({ study: { ...DELISTING_STUDY, coins: [] } })).toMatchObject({ refused: 'no-evidence' })
    expect(card({ livePrice: null })).toMatchObject({ refused: 'no-price' })
    expect(card({ livePrice: 0 })).toMatchObject({ refused: 'no-price' })
    for (const code of ['no-book', 'stale-book', 'cannot-hold', 'thin', 'cost-share'] as const) {
      expect(card({ gate: { ok: false, code, reason: 'r', trip: null, depthQuote: null } })).toMatchObject({ refused: code })
    }
    const dear = card({ gate: { ok: true, trip: { ...trip, totalPct: 30 }, depthQuote: 1 } })
    expect(dear).toMatchObject({ refused: 'under-lines' })
    expect((dear as { expectedNet: { pct: number } }).expectedNet.pct).toBeLessThan(0)
  })
  it('says so when its live check found it weaker than its study', () => {
    expect((card({ live: { ...ok, state: 'weaker' } }) as PrimaryCard).detail).toMatchObject({ weaker: true })
  })
})

describe('the live check (V8-S3-DELIST-LIVE)', () => {
  const hourRows = (count: number, netPct: number, spread = 0.5, from = DELIST_LIVE_LINES.sinceSec): { releaseSec: number; netPct: number }[] =>
    Array.from({ length: count }, (_, k) => ({ releaseSec: from + k * 86_400 + 600, netPct: netPct + (k % 2 === 0 ? spread : -spread) }))
  it('reads only the delistings since its start, an hour once', () => {
    const reading = delistLiveOf([...hourRows(3, 10), { releaseSec: DELIST_LIVE_LINES.sinceSec - 60, netPct: -50 }, { releaseSec: DELIST_LIVE_LINES.sinceSec + 600, netPct: 10.5 }])
    expect(reading.hours).toBe(3)
    expect(reading.coins).toBe(4)
    expect(reading.meanPct).toBeCloseTo(10.1666667, 5)
    expect(reading.state).toBe('ok')
  })
  it('withdraws the card with 6 hours whose upper end is under +2%, never with fewer', () => {
    expect(delistLiveOf(hourRows(6, -3)).state).toBe('withdrawn')
    expect(delistLiveOf(hourRows(5, -3)).state).toBe('ok')
    expect(delistLiveOf(hourRows(6, 2.5)).state).toBe('ok')
    // A mean under +2% whose interval still reaches past it is not enough: the upper end is what withdraws.
    const wide = delistLiveOf(hourRows(6, 1.5, 2.5))
    expect(wide.meanPct).toBeCloseTo(1.5, 12)
    expect(wide.high).toBeGreaterThan(2)
    expect(wide.state).toBe('ok')
  })
  it('marks it weaker than its study with 12 hours under +7.4%', () => {
    expect(delistLiveOf(hourRows(12, 6)).state).toBe('weaker')
    expect(delistLiveOf(hourRows(11, 6)).state).toBe('ok')
    expect(delistLiveOf(hourRows(12, 8)).state).toBe('ok')
    // The mean is what marks it, even where the interval reaches past the line.
    const wide = delistLiveOf(hourRows(12, 6.5, 3.5))
    expect(wide.high).toBeGreaterThan(7.4)
    expect(wide.state).toBe('weaker')
    expect(delistLiveOf([]).meanPct).toBeNull()
  })
})

describe("a direction model's card", () => {
  const base = {
    pair: 'BTCUSDT',
    nowSec: RELEASE,
    horizonSec: 4 * 3600,
    pUpSource: DIRECTION_MODELS[0],
    direction: 'BULLISH' as const,
    livePrice: 100,
    record: { calls: 400, meanPct: 2, ci: { low: 1.2, high: 2.8 }, hours: 300 },
    quantilesPct: [-2, -0.5, 1.5, 3, 4] as const,
    gate: passing,
    stakeQuote: 1000,
    predictionId: 'direction-model:BTCUSDT:1'
  }
  it("moves its walk forward's edge from the flat round trip to this route's cost", () => {
    const made = modelCardOf(base) as PrimaryCard
    const shift = ROUND_TRIP_PCT - 0.7
    expect(made.expectedNet).toMatchObject({ pct: 2 + shift, low: 1.2 + shift, high: 2.8 + shift, calls: 400, units: 300 })
    expect(made).toMatchObject({ side: 'up', movePct: 1.5, exitAt: RELEASE + 4 * 3600, source: 'direction-model', sourceVersion: DIRECTION_MODELS[0] })
    expect(made.cost.fundingPct).toBe(0)
    expect(made.scenarios).toEqual({ forPct: 4, againstPct: -2, worstPct: -2 - 0.7 })
  })
  it('a short pays the funding its hold crosses; a call without a record or under the lines is refused', () => {
    const short = modelCardOf({ ...base, direction: 'BEARISH', nowSec: RELEASE - (RELEASE % 86_400) + 6 * 3600 }) as PrimaryCard
    expect(short.side).toBe('down')
    expect(short.cost.fundingPct).toBeCloseTo(0.01, 12)
    expect(short.movePct).toBe(0)
    expect(modelCardOf({ ...base, record: null })).toMatchObject({ refused: 'no-evidence' })
    expect(modelCardOf({ ...base, record: { ...base.record, ci: null } })).toMatchObject({ refused: 'no-evidence' })
    expect(modelCardOf({ ...base, record: { ...base.record, meanPct: 0.5, ci: { low: 0.1, high: 0.9 } } })).toMatchObject({ refused: 'under-lines' })
    expect(modelCardOf({ ...base, direction: 'NEUTRAL' })).toBeNull()
  })
})

describe('the cards in order', () => {
  it('puts the largest expected net first, a tie to the earlier made', () => {
    const one = card() as PrimaryCard
    const two = { ...one, pair: 'XYZUSDT', expectedNet: { ...one.expectedNet, pct: one.expectedNet.pct + 1 } }
    const three = { ...one, pair: 'OLDUSDT', madeAt: one.madeAt - 10 }
    expect(rankCards([one, two, three]).map((entry) => entry.pair)).toEqual(['XYZUSDT', 'OLDUSDT', 'ABCUSDT'])
    expect(isCard(null)).toBe(false)
  })
})
