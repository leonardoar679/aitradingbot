import { describe, expect, it } from 'vitest'
import { AI_CONTEXT_VERSION, AI_ROUND_TRIP_COST_PCT, aiContextJson, buildAiContext } from '../shared/aiContext'
import { GPT_INTRADAY_INTERVAL, GPT_LOOKBACK_BARS } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'

const BAR = 900
/** On a 15-minute AND a 1-hour boundary, two hours into a 4-hour bucket -- so the coarser views
 * start part-way through a bucket, which is the ordinary case and the one that goes wrong. */
const START = 1_699_999_200
const META = { exchange: 'binance' as const, symbol: 'BTCUSDT', interval: GPT_INTRADAY_INTERVAL, position: 'flat' as const }

/** Deterministic wandering series. A straight line would leave every indicator degenerate: RSI
 * pinned at 100, ADX undefined, a Bollinger band of zero width. */
function series(count: number, startAt = START): Candle[] {
  let seed = 7
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const out: Candle[] = []
  let price = 100
  for (let i = 0; i < count; i++) {
    const open = price
    price = Math.max(1, price + (next() - 0.48) * 1.2)
    out.push({
      time: startAt + i * BAR,
      open,
      high: Math.max(open, price) + next() * 0.4,
      low: Math.min(open, price) - next() * 0.4,
      close: price,
      volume: 50 + next() * 100
    })
  }
  return out
}

describe('buildAiContext', () => {
  it('refuses to build from less than the full lookback', () => {
    const data = series(GPT_LOOKBACK_BARS)
    expect(buildAiContext(data, GPT_LOOKBACK_BARS - 1, META)).toBeNull()
    expect(buildAiContext(data, GPT_LOOKBACK_BARS + 1, META)).toBeNull()
    expect(buildAiContext(data, GPT_LOOKBACK_BARS, META)).not.toBeNull()
  })

  // The property a backtest lives or dies by. A context that reads one bar of the future makes
  // every historical decision look brilliant and tells nothing about a live one.
  it('reads nothing at or after the execution candle', () => {
    const data = series(GPT_LOOKBACK_BARS + 50)
    const index = GPT_LOOKBACK_BARS + 10
    const honest = aiContextJson(buildAiContext(data, index, META)!)

    const tampered = data.map((candle, i) =>
      i >= index ? { time: candle.time + 7, open: 9e6, high: 9e6, low: 1e-6, close: 9e6, volume: 9e9 } : candle
    )
    expect(aiContextJson(buildAiContext(tampered, index, META)!)).toBe(honest)
    // Nor does it matter whether the execution candle exists yet at all.
    expect(aiContextJson(buildAiContext(data.slice(0, index), index, META)!)).toBe(honest)
  })

  // The property the bill depends on. An EMA carries memory of everything before it, so a context
  // computed over "whatever was passed in" would differ between a 7-day backtest and a bot that
  // has been running for a month -- same candle, different cache key, charged twice.
  it('gives the same bytes however much history precedes the window', () => {
    const data = series(GPT_LOOKBACK_BARS + 900)
    const index = data.length - 3
    const fromEverything = aiContextJson(buildAiContext(data, index, META)!)
    const fromExactlyTheWindow = aiContextJson(buildAiContext(data.slice(index - GPT_LOOKBACK_BARS), GPT_LOOKBACK_BARS, META)!)
    expect(fromExactlyTheWindow).toBe(fromEverything)
  })

  it('names the candle it decides for without reading that candle', () => {
    const data = series(GPT_LOOKBACK_BARS + 1)
    const context = buildAiContext(data, GPT_LOOKBACK_BARS, META)!
    expect(context.decisionTime).toBe(data[GPT_LOOKBACK_BARS - 1].time + BAR)
    expect(context.lastClose).toBe(data[GPT_LOOKBACK_BARS - 1].close)
    expect(context.version).toBe(AI_CONTEXT_VERSION)
    expect(context.windowDays).toBe(7)
  })

  it('puts the position in the context, so flat and long are different questions', () => {
    const data = series(GPT_LOOKBACK_BARS)
    const flat = aiContextJson(buildAiContext(data, GPT_LOOKBACK_BARS, META)!)
    const long = aiContextJson(buildAiContext(data, GPT_LOOKBACK_BARS, { ...META, position: 'long' })!)
    expect(long).not.toBe(flat)
  })

  it('states the round-trip cost the strategy actually pays', () => {
    // 0.1% fee and 2bps of slippage, each way.
    expect(AI_ROUND_TRIP_COST_PCT).toBe(0.24)
    expect(buildAiContext(series(GPT_LOOKBACK_BARS), GPT_LOOKBACK_BARS, META)!.roundTripCostPct).toBe(0.24)
  })

  describe('the coarser views', () => {
    it('offers the base interval and the two above it', () => {
      const context = buildAiContext(series(GPT_LOOKBACK_BARS), GPT_LOOKBACK_BARS, META)!
      expect(context.timeframes.map((view) => view.interval)).toEqual(['15m', '1h', '4h'])
      expect(context.timeframes[0].bars).toHaveLength(32)
    })

    it('holds only bars that had finished before the decision', () => {
      // Ends 30 minutes into an hour and 2.5 hours into a 4-hour bucket: both coarser views have a
      // bucket in progress, and neither may show it as a bar.
      const data = series(GPT_LOOKBACK_BARS + 2)
      const context = buildAiContext(data, data.length, META)!
      expect(context.decisionTime % 3600).not.toBe(0)

      for (const [view, width] of [
        [context.timeframes[1], 3600],
        [context.timeframes[2], 4 * 3600]
      ] as const) {
        const lastBar = view.bars[view.bars.length - 1]
        expect(lastBar[0] % width).toBe(0)
        expect(lastBar[0] + width).toBeLessThanOrEqual(context.decisionTime)
      }
    })

    it('keeps a bar that finished exactly as the decision candle opens', () => {
      // 672 bars from an hour boundary end on one, so the final hour is complete and belongs.
      const data = series(GPT_LOOKBACK_BARS)
      const context = buildAiContext(data, GPT_LOOKBACK_BARS, META)!
      const hourly = context.timeframes[1]
      expect(context.decisionTime % 3600).toBe(0)
      expect(hourly.bars[hourly.bars.length - 1][0] + 3600).toBe(context.decisionTime)
    })

    it('reports an indicator only where the view holds enough bars for it', () => {
      const context = buildAiContext(series(GPT_LOOKBACK_BARS), GPT_LOOKBACK_BARS, META)!
      const [base, hourly, fourHour] = context.timeframes
      expect(base.ema200).not.toBeNull()
      expect(hourly.ema50).not.toBeNull()
      // About 41 four-hour bars: enough for EMA(20), RSI and ADX, not for EMA(50). computeEma
      // returns a number from bar zero, so without the guard this would be a seed dressed as an EMA.
      expect(fourHour.ema20).not.toBeNull()
      expect(fourHour.ema50).toBeNull()
      expect(fourHour.ema200).toBeNull()
      expect(fourHour.rsi14).not.toBeNull()
      expect(fourHour.adx14).not.toBeNull()
    })
  })

  it('rounds every derived number, so the hashed bytes do not carry float noise', () => {
    const context = buildAiContext(series(GPT_LOOKBACK_BARS), GPT_LOOKBACK_BARS, META)!
    const derived = [
      context.changePct.h1,
      context.changePct.h24,
      context.range.positionPct,
      context.bollinger?.percentB,
      context.volume.ratio,
      context.timeframes[0].ema20,
      context.timeframes[0].rsi14,
      context.timeframes[0].atrPct,
      context.timeframes[1].adx14
    ]
    for (const value of derived) {
      expect(typeof value).toBe('number')
      expect(Number((value as number).toPrecision(6))).toBe(value)
    }
  })
})
