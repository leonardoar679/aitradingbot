import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import { QUANTS, loadQuantData, quantBacktests, quantSideAt, quantSpan, type QuantFetch } from '../src/agents/quantState'

// src/agents/quantState.ts: the app's two quant strategies read at an event's moment from their own
// exports, never ahead of it and never before their warm-up; and run on their own over a window.

const H4 = 14_400
const M15 = 900
const NOW = Date.parse('2026-10-06T12:00:00Z') / 1000

/** `count` bars of `step` seconds whose last closes at `end`, each moving by `move(k)` percent. */
function bars(count: number, step: number, move: (k: number) => number, end = NOW): Candle[] {
  const out: Candle[] = []
  let close = 100
  for (let k = 0; k < count; k++) {
    const open = close
    close = open * (1 + move(k) / 100)
    out.push({ time: end - (count - k) * step, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 })
  }
  return out
}

describe('a strategy read at a moment', () => {
  it("is on Trend Regime 4h's long side when every average agrees, short when none does, neither between", () => {
    expect(quantSideAt('trend4h', bars(600, H4, () => 0.1), NOW)).toBe('long')
    expect(quantSideAt('trend4h', bars(600, H4, () => -0.1), NOW)).toBe('short')
    // A long rise, then a dip that takes the close under its two shorter averages only: 2 of 4.
    expect(quantSideAt('trend4h', bars(600, H4, (k) => (k < 560 ? 0.1 : -0.25)), NOW)).toBe('none')
  })

  it("is on Short-Term Channel 15m's long side at the top of its channels, short at the bottom, neither in the middle", () => {
    expect(quantSideAt('channel15m', bars(900, M15, () => 0.05), NOW)).toBe('long')
    expect(quantSideAt('channel15m', bars(900, M15, () => -0.05), NOW)).toBe('short')
    // Up and down twelve hours at a time, ending halfway up a rise: the middle of its range.
    expect(quantSideAt('channel15m', bars(984, M15, (k) => (Math.floor(k / 48) % 2 === 0 ? 0.1 : -0.1)), NOW)).toBe('none')
    // Ending at the bottom of a fall, it is at its lows.
    expect(quantSideAt('channel15m', bars(960, M15, (k) => (Math.floor(k / 48) % 2 === 0 ? 0.1 : -0.1)), NOW)).toBe('short')
  })

  it('reads nothing that had not closed by the moment, and nothing before its warm-up', () => {
    // The last bar plunges, but it closes after the moment asked about: still on the long side.
    const rising = bars(600, H4, (k) => (k === 599 ? -60 : 0.1))
    expect(quantSideAt('trend4h', rising, NOW - 1)).toBe('long')
    expect(quantSideAt('trend4h', rising, NOW)).not.toBe('long')
    // One bar short of its warm-up, it has no state.
    expect(quantSideAt('trend4h', bars(QUANTS.trend4h.warmupBars - 1, H4, () => 0.1), NOW)).toBeNull()
    expect(quantSideAt('trend4h', bars(QUANTS.trend4h.warmupBars, H4, () => 0.1), NOW)).toBe('long')
    expect(quantSideAt('channel15m', bars(QUANTS.channel15m.warmupBars - 1, M15, () => 0.05), NOW)).toBeNull()
    expect(quantSideAt('trend4h', [], NOW)).toBeNull()
  })
})

describe('the states at each event', () => {
  it("reads each pair's bars once for all its events, from its warm-up before the window", async () => {
    const asked: string[] = []
    const fetch: QuantFetch = async (_exchange, symbol, interval, startSec, endSec) => {
      asked.push(`${symbol} ${interval} ${startSec} ${endSec}`)
      if (symbol === 'XRPUSDT') throw new Error('down')
      return interval === '4h' ? bars(600, H4, () => 0.1) : bars(900, M15, () => -0.05)
    }
    const window = { startSec: NOW - 86_400, endSec: NOW }
    const events = [
      { id: 'a', exchange: 'binance' as const, symbol: 'SOLUSDT', time: NOW },
      { id: 'b', exchange: 'binance' as const, symbol: 'SOLUSDT', time: NOW },
      { id: 'c', exchange: 'binance' as const, symbol: 'XRPUSDT', time: NOW }
    ]
    const progress: string[] = []
    const data = await loadQuantData(events, window, fetch, { onProgress: (done, total) => progress.push(`${done}/${total}`) })
    const trend = quantSpan('trend4h', window)
    const channel = quantSpan('channel15m', window)
    expect(trend.startSec).toBe(window.startSec - (QUANTS.trend4h.warmupBars + 2) * H4)
    expect(asked).toEqual([
      `SOLUSDT 4h ${trend.startSec} ${NOW}`,
      `SOLUSDT 15m ${channel.startSec} ${NOW}`,
      `XRPUSDT 4h ${trend.startSec} ${NOW}`
    ])
    expect(data.states).toEqual({
      a: { trend4h: 'long', channel15m: 'short' },
      b: { trend4h: 'long', channel15m: 'short' },
      c: { trend4h: null, channel15m: null }
    })
    expect(data.failed).toEqual([{ symbol: 'XRPUSDT', error: 'down' }])
    expect(progress).toEqual(['1/2', '2/2'])
  })

  it('reads the state each event had, not the one at the end of the bars', async () => {
    // Rising until a day before the end, then falling: an event before the turn is long, after it short.
    const turning = bars(800, H4, (k) => (k < 600 ? 0.1 : -0.3))
    const fetch: QuantFetch = async (_exchange, _symbol, interval) => (interval === '4h' ? turning : [])
    const early = turning[580].time + H4
    // An event with fewer of the strategy's bars closed before it than its warm-up has no state.
    const cold = turning[QUANTS.trend4h.warmupBars - 2].time + H4
    const data = await loadQuantData(
      [
        { id: 'early', exchange: 'binance', symbol: 'SOLUSDT', time: early },
        { id: 'late', exchange: 'binance', symbol: 'SOLUSDT', time: NOW },
        { id: 'cold', exchange: 'binance', symbol: 'SOLUSDT', time: cold }
      ],
      { startSec: early, endSec: NOW },
      fetch
    )
    expect(data.states.early).toEqual({ trend4h: 'long', channel15m: null })
    expect(data.states.late).toEqual({ trend4h: 'short', channel15m: null })
    expect(data.states.cold).toEqual({ trend4h: null, channel15m: null })
    expect(quantSideAt('trend4h', turning, turning[QUANTS.trend4h.warmupBars - 1].time + H4)).toBe('long')
  })
})

describe('the strategies on their own', () => {
  it('runs each through the backtest engine over the window, beside holding the same pairs', () => {
    const window = { startSec: NOW - 30 * 86_400, endSec: NOW }
    const rising = bars(QUANTS.trend4h.warmupBars + 200, H4, () => 0.2)
    const [trend, channel] = quantBacktests({ bars: { SOLUSDT: { trend4h: rising }, XRPUSDT: {} } }, window, NOW)
    expect(trend).toMatchObject({ id: 'trend4h', pairs: 1 })
    expect(trend.trades).toBeGreaterThan(0)
    expect(trend.meanReturnPct).toBeGreaterThan(0)
    const inWindow = rising.filter((bar) => bar.time >= window.startSec)
    expect(trend.holdMeanReturnPct).toBeCloseTo((inWindow[inWindow.length - 1].close / inWindow[0].open - 1) * 100, 9)
    // No bars, no run: nothing is made up.
    expect(channel).toEqual({ id: 'channel15m', pairs: 0, trades: 0, meanReturnPct: null, medianReturnPct: null, meanMaxDrawdownPct: null, holdMeanReturnPct: null })
  })
})
