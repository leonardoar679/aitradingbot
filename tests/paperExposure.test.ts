import { describe, expect, it } from 'vitest'
import type { Candle, ExecutorConfig, PaperAccount, PaperRiskSettings } from '../shared/ipc'
import {
  CORRELATED_LINE,
  CORRELATED_SHARE,
  correlatedCap,
  correlatedExposureBlock,
  correlatedOut,
  correlationWindow,
  describeCorrelatedExposure,
  hourlyCorrelation,
  readBtcCorrelation,
  tracksBtc
} from '../shared/paperExposure'

// shared/paperExposure.ts: what the app's own paper trades stake together on one side, on coins
// that move with Bitcoin (the second V3 document, §24), and the correlation that says which those are.

const HOUR = 3600
const NOW = Date.parse('2026-10-06T12:30:00Z') / 1000
const LAST = Math.floor(NOW / HOUR) * HOUR - HOUR

/** `count` closed hours ending at LAST, each moving by `step(k)` percent from the one before. */
function hours(step: (k: number) => number, count = 169, start = 100): Candle[] {
  const out: Candle[] = []
  let close = start
  for (let k = 0; k < count; k++) {
    if (k > 0) close *= 1 + step(k) / 100
    const time = LAST - (count - 1 - k) * HOUR
    out.push({ time, open: close, high: close, low: close, close, volume: 1 })
  }
  return out
}
const wiggle = (k: number): number => Math.sin(k * 1.7) + 0.4 * Math.cos(k * 0.6)

describe('the correlation with Bitcoin', () => {
  it('is 1 for a pair that moves as Bitcoin does, at any size, and -1 for one that moves against it', () => {
    const btc = hours(wiggle)
    expect(hourlyCorrelation(hours(wiggle, 169, 3), btc)).toBeCloseTo(1, 10)
    expect(hourlyCorrelation(hours((k) => 2 * wiggle(k)), btc)).toBeGreaterThan(0.99)
    expect(hourlyCorrelation(hours((k) => -wiggle(k)), btc)).toBeLessThan(-0.99)
    // Moves of their own: near nothing.
    expect(Math.abs(hourlyCorrelation(hours((k) => Math.sin(k * 0.37 + 1) * Math.cos(k * 2.9)), btc) as number)).toBeLessThan(0.3)
  })

  it('is read only over hours both pairs have, one hour apart, and not at all with too few or a flat one', () => {
    const btc = hours(wiggle)
    // A missing hour drops the two returns either side of it; the rest still say 1.
    const gapped = hours(wiggle).filter((_, k) => k !== 80)
    expect(hourlyCorrelation(gapped, btc)).toBeCloseTo(1, 10)
    // A pair halted for an hour that opens 20% higher: the jump over the gap is not an hour's move.
    const halted = gapped.map((bar) => (bar.time > LAST - 88 * HOUR ? { ...bar, close: bar.close * 1.2 } : bar))
    expect(hourlyCorrelation(halted, btc)).toBeCloseTo(1, 10)
    // Under 120 shared returns: nothing.
    expect(hourlyCorrelation(btc.slice(-120), btc)).toBeNull()
    expect(hourlyCorrelation(btc.slice(-121), btc)).toBeCloseTo(1, 10)
    expect(hourlyCorrelation(hours(() => 0), btc)).toBeNull()
    expect(hourlyCorrelation([], btc)).toBeNull()
  })

  it('is read from the week of hours that closed before now', async () => {
    expect(correlationWindow(NOW)).toEqual({ startSec: LAST + HOUR - 7 * 24 * HOUR - HOUR, endSec: LAST + HOUR })
    const asked: string[] = []
    // The forming hour is sent too, as an exchange does, and moves the pair alone: it is not read.
    const forming = (bars: Candle[], close: number): Candle[] => [...bars, { time: LAST + HOUR, open: close, high: close, low: close, close, volume: 1 }]
    const fetchHourly = async (_exchange: string, symbol: string, startSec: number, endSec: number): Promise<Candle[]> => {
      asked.push(`${symbol} ${startSec} ${endSec}`)
      return symbol === 'BTCUSDT' ? forming(hours(wiggle), 1) : forming(hours(wiggle, 169, 3), 999)
    }
    expect(await readBtcCorrelation(fetchHourly, 'binance', 'SOLUSDT', NOW)).toBeCloseTo(1, 10)
    const { startSec, endSec } = correlationWindow(NOW)
    expect(asked.sort()).toEqual([`BTCUSDT ${startSec} ${endSec}`, `SOLUSDT ${startSec} ${endSec}`])
    // Bitcoin is Bitcoin, read or not; a pair that cannot be read has no correlation.
    expect(await readBtcCorrelation(async () => Promise.reject(new Error('down')), 'binance', 'BTCUSDT', NOW)).toBe(1)
    expect(await readBtcCorrelation(async () => Promise.reject(new Error('down')), 'binance', 'SOLUSDT', NOW)).toBeNull()
  })

  it('tracks Bitcoin from the line, and when it could not be read', () => {
    expect(tracksBtc(CORRELATED_LINE)).toBe(true)
    expect(tracksBtc(0.69)).toBe(false)
    expect(tracksBtc(-0.9)).toBe(false)
    expect(tracksBtc(null)).toBe(true)
    expect(tracksBtc(undefined)).toBe(true)
  })
})

/** One executor: by default the watch's open paper BUY of 100 USDT, with no correlation on it. */
function trade(
  over: { id?: string; side?: 'buy' | 'sell'; amount?: number; correlation?: number | null; kind?: 'watch' | 'news' | 'hand'; status?: 'active' | 'stopped'; mode?: 'paper' | 'live'; quote?: string } = {}
): ExecutorConfig {
  const quote = over.quote ?? 'USDT'
  const base = {
    id: over.id ?? 'x',
    name: 'x',
    type: 'position',
    exchange: 'binance',
    symbol: `X${quote}`,
    baseAsset: 'X',
    quoteAsset: quote,
    createdAt: 0,
    status: over.status ?? 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: over.mode ?? 'paper',
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: { side: over.side ?? 'buy', entryPrice: null, amountQuote: over.amount ?? 100, takeProfitPct: 2, stopLossPct: 1, timeLimitSec: 3600, trailingStop: null }
  }
  const correlation = 'correlation' in over ? { btcCorrelation: over.correlation } : {}
  const kind = over.kind ?? 'watch'
  if (kind === 'watch') return { ...base, watch: { eventId: 'e', eventTime: 0, model: 'm', confidence: 0.8, ...correlation } } as ExecutorConfig
  if (kind === 'news') return { ...base, newsRule: { articleId: 1, ticker: 'X', releaseSec: 0, title: 't', ...correlation } } as ExecutorConfig
  return base as ExecutorConfig
}

const CAPPED: PaperRiskSettings = { sizing: 'stake', riskQuote: 1, riskPct: 0.25, maxOutQuote: 1000 }
const funded = (usdt: number): PaperAccount => ({ balances: { USDT: usdt }, initialBalances: { USDT: usdt }, createdAt: 0, ledger: [] })

describe('what the app has out on one side, on coins that move with Bitcoin', () => {
  it("counts the watch's and the news rules' open paper trades on the side, in the quote, on pairs that track it", () => {
    const executors = [
      trade({ id: 'a', amount: 100 }),
      trade({ id: 'b', amount: 40, kind: 'news', correlation: 0.9 }),
      trade({ id: 'c', amount: 1000, correlation: 0.4 }),
      trade({ id: 'd', amount: 1000, side: 'sell' }),
      trade({ id: 'e', amount: 1000, kind: 'hand' }),
      trade({ id: 'f', amount: 1000, status: 'stopped' }),
      trade({ id: 'g', amount: 1000, mode: 'live' }),
      trade({ id: 'h', amount: 1000, quote: 'BTC' }),
      trade({ id: 'i', amount: 7, correlation: null }),
      trade({ id: 'j', amount: Number.NaN })
    ]
    expect(correlatedOut(executors, 'buy', 'USDT')).toBe(147)
    expect(correlatedOut(executors, 'sell', 'USDT')).toBe(1000)
  })

  it("is capped at a share of what the paper account was funded with, or of the money-out cap, or not at all", () => {
    expect(CORRELATED_SHARE).toBe(0.15)
    expect(correlatedCap({ account: funded(10_000), risk: CAPPED, quoteAsset: 'USDT' })).toBe(1500)
    expect(correlatedCap({ account: null, risk: CAPPED, quoteAsset: 'USDT' })).toBe(150)
    // An account with nothing funded in the quote: the money-out cap, as with none.
    expect(correlatedCap({ account: funded(10_000), risk: CAPPED, quoteAsset: 'BTC' })).toBe(150)
    expect(correlatedCap({ account: { balances: {}, createdAt: 0, ledger: [] } as unknown as PaperAccount, risk: CAPPED, quoteAsset: 'USDT' })).toBe(150)
    expect(correlatedCap({ account: null, risk: { ...CAPPED, maxOutQuote: null }, quoteAsset: 'USDT' })).toBeNull()
  })

  it('refuses a trade on a pair that tracks Bitcoin past the cap, and says why', () => {
    const open = [trade({ amount: 100 })]
    const ask = (over: Partial<Parameters<typeof correlatedExposureBlock>[0]> = {}): string | null =>
      correlatedExposureBlock({ account: null, risk: CAPPED, executors: open, quoteAsset: 'USDT', side: 'buy', amountQuote: 100, correlation: 0.85, ...over })
    expect(ask()).toBe(
      "Its pair moves with Bitcoin (its hourly moves over 7 days correlate at 0.85), and the app's open paper BUYs on such pairs stake 100 USDT together: 100 more would take them past 150, 15% of the money-out cap."
    )
    expect(ask({ correlation: null })).toBe(
      "Its pair's correlation with Bitcoin could not be read, so it counts as one that moves with it, and the app's open paper BUYs on such pairs stake 100 USDT together: 100 more would take them past 150, 15% of the money-out cap."
    )
    // Up to the cap, it opens.
    expect(ask({ amountQuote: 50 })).toBeNull()
    // A pair that does not track Bitcoin is not held to it; nor is the other side; nor anything without a cap.
    expect(ask({ correlation: 0.5 })).toBeNull()
    expect(ask({ side: 'sell' })).toBeNull()
    expect(ask({ risk: { ...CAPPED, maxOutQuote: null } })).toBeNull()
    // With a funded account, the cap is its share of that.
    expect(ask({ account: funded(10_000) })).toBeNull()
    expect(ask({ account: funded(1000) })).toBe(
      "Its pair moves with Bitcoin (its hourly moves over 7 days correlate at 0.85), and the app's open paper BUYs on such pairs stake 100 USDT together: 100 more would take them past 150, 15% of what the paper account was funded with."
    )
  })

  it('says the rule as it stands', () => {
    expect(describeCorrelatedExposure({ account: null, risk: CAPPED, quoteAsset: 'USDT' })).toBe(
      "On pairs whose hourly moves over 7 days correlate with Bitcoin's at 0.7 or more, those open on one side stake at most 15% of the money-out cap: 150 USDT together."
    )
    expect(describeCorrelatedExposure({ account: funded(10_000), risk: CAPPED, quoteAsset: 'USDT' })).toBe(
      "On pairs whose hourly moves over 7 days correlate with Bitcoin's at 0.7 or more, those open on one side stake at most 15% of what the paper account was funded with: 1,500 USDT together."
    )
    expect(describeCorrelatedExposure({ account: null, risk: { ...CAPPED, maxOutQuote: null }, quoteAsset: 'USDT' })).toBe(
      "On pairs whose hourly moves over 7 days correlate with Bitcoin's at 0.7 or more, those open on one side stake at most 15% of the paper account, or of the money-out cap; with neither, there is no such limit."
    )
  })
})
