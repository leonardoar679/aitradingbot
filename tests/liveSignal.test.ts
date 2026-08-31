import { describe, expect, it } from 'vitest'
import { describeNextAction, readLiveSignals } from '../src/backtest/liveSignal'
import type { Candle } from '../shared/ipc'

// The live monitor's readings. These matter because the panel makes a claim about what the
// strategy will DO next, and a claim like that is either read from the rule or invented.
//
// The one that would be easiest to get wrong, and worst to get wrong, is the gated strategy:
// Short-Term Channel + Trend Regime needs both the channel and the regime to OPEN, but its exits
// come from the channel alone. A panel that treated the regime as symmetric would tell someone
// holding a position that a falling regime was about to close it. It never will.

const BAR = 14_400 // 4h, so the day-based lookbacks convert to a known number of bars

/** `n` candles walking one direction. Monotonic on purpose: it puts the regime vote and the
 * channel position at their extremes, which is what makes the assertions below unambiguous. */
function series(n: number, from: number, step: number): Candle[] {
  const out: Candle[] = []
  for (let i = 0; i < n; i++) {
    const close = from + step * i
    out.push({
      time: 1_600_000_000 + i * BAR,
      open: close,
      high: close,
      low: close,
      close,
      volume: 1
    })
  }
  return out
}

// 600 bars of 4h clears the slowest lookback (80 days = 480 bars) with room to spare.
const RISING = series(600, 100, 0.5)
const FALLING = series(600, 400, -0.5)

/** A long decline with a short rally on the end: price is making new SHORT-term highs while still
 * far below its 20-80 day averages. So the channel reads near the top and the regime reads near
 * the bottom, which is the only shape that can tell a correct exit rule from a wrong one -- on a
 * uniformly rising series both readings sit at 1.0 and either implementation names the channel. */
function rallyInsideDowntrend(): Candle[] {
  const down = series(550, 500, -0.6)
  const lastClose = down[down.length - 1].close
  const up = series(50, lastClose, 1.2).map((c, i) => ({ ...c, time: down[down.length - 1].time + (i + 1) * BAR }))
  return [...down, ...up]
}
const RALLY_IN_DOWNTREND = rallyInsideDowntrend()

describe('which readings each strategy publishes', () => {
  it('gives Trend Regime the vote and nothing else', () => {
    const r = readLiveSignals(RISING, 'trend-regime-ensemble')
    expect(r.map((x) => x.id)).toEqual(['regime'])
  })

  it('gives Short-Term Channel the channel and nothing else', () => {
    const r = readLiveSignals(RISING, 'short-term-channel')
    expect(r.map((x) => x.id)).toEqual(['channel'])
  })

  it('gives the gated strategy both, channel first', () => {
    const r = readLiveSignals(RISING, 'short-term-channel-regime')
    expect(r.map((x) => x.id)).toEqual(['channel', 'regime'])
  })

  it('publishes nothing for a strategy with no exported reading, rather than inventing one', () => {
    // A plausible-looking proxy for EMA/RSI/Bollinger would be a second implementation of a rule
    // this file does not own. Showing nothing is the honest answer.
    expect(readLiveSignals(RISING, 'bollinger-breakout')).toEqual([])
    expect(readLiveSignals(RISING, 'ema-cross-atr-stop')).toEqual([])
  })

  it('publishes nothing when there are no candles at all', () => {
    expect(readLiveSignals([], 'trend-regime-ensemble')).toEqual([])
  })
})

describe('the gate is asymmetric, and the readings say so', () => {
  it('marks the gated strategy regime as entry-only', () => {
    const regime = readLiveSignals(RISING, 'short-term-channel-regime').find((r) => r.id === 'regime')
    expect(regime?.gatesEntry).toBe(true)
    // The whole point of this file. Exits pass through ungated from the channel.
    expect(regime?.gatesExit).toBe(false)
  })

  it('marks the standalone Trend Regime vote as governing BOTH sides', () => {
    const regime = readLiveSignals(RISING, 'trend-regime-ensemble').find((r) => r.id === 'regime')
    expect(regime?.gatesEntry).toBe(true)
    expect(regime?.gatesExit).toBe(true)
  })

  it('never attributes an exit to the regime while the gated strategy holds', () => {
    const readings = readLiveSignals(RALLY_IN_DOWNTREND, 'short-term-channel-regime')
    // The fixture exists to make this test discriminating: the regime is far closer to its exit
    // level than the channel is, so an implementation that wrongly let the regime govern exits
    // would name it here. On a uniformly rising series the two tie and the bug hides.
    const regime = readings.find((r) => r.id === 'regime')
    const channel = readings.find((r) => r.id === 'channel')
    expect(regime?.value).toBeLessThan(channel?.value as number)

    const action = describeNextAction(readings, true)
    expect(action.kind).toBe('exit')
    // It must name the channel, because that is the only thing that can close this position.
    expect(action.summary).toContain('channel position')
    expect(action.summary).not.toContain('trend agreement')
  })
})

describe('reading the extremes', () => {
  it('reads a sustained uptrend as every lookback agreeing', () => {
    const regime = readLiveSignals(RISING, 'trend-regime-ensemble').find((r) => r.id === 'regime')
    expect(regime?.value).toBe(1)
    expect(regime?.display).toBe('4 of 4')
  })

  it('reads a sustained downtrend as no lookback agreeing', () => {
    const regime = readLiveSignals(FALLING, 'trend-regime-ensemble').find((r) => r.id === 'regime')
    expect(regime?.value).toBe(0)
    expect(regime?.display).toBe('0 of 4')
  })

  it('reads a new high as the top of the channel and a new low as the bottom', () => {
    expect(readLiveSignals(RISING, 'short-term-channel')[0].value).toBe(1)
    expect(readLiveSignals(FALLING, 'short-term-channel')[0].value).toBe(0)
  })
})

describe('what has to change for the strategy to act', () => {
  it('says every condition is met when the market is at the entry threshold', () => {
    const action = describeNextAction(readLiveSignals(RISING, 'trend-regime-ensemble'), false)
    expect(action.kind).toBe('entry')
    expect(action.blocking).toEqual([])
    expect(action.summary).toContain('Every entry condition is met')
  })

  it('names what is holding an entry back, with the value and the threshold', () => {
    const action = describeNextAction(readLiveSignals(FALLING, 'trend-regime-ensemble'), false)
    expect(action.kind).toBe('entry')
    expect(action.blocking.map((b) => b.id)).toEqual(['regime'])
    // Both halves have to be there: what it is, and what it needs. Either alone is unreadable.
    expect(action.summary).toContain('0 of 4')
    expect(action.summary).toContain('needs 4 of 4')
  })

  it('lists BOTH unmet conditions for the gated strategy rather than only the first', () => {
    const action = describeNextAction(readLiveSignals(FALLING, 'short-term-channel-regime'), false)
    expect(action.blocking.map((b) => b.id).sort()).toEqual(['channel', 'regime'])
    expect(action.summary).toContain(' and ')
  })

  it('reports honestly when the strategy publishes no reading', () => {
    const action = describeNextAction([], false)
    expect(action.kind).toBe('unknown')
    expect(action.summary).toContain('no live reading')
  })

  it('does not claim to know the next move while the strategy is still warming up', () => {
    // Too short for the 80-day lookback, so regimeAgreement is NaN-derived. A panel that rendered
    // that as "0 of 4, needs 4 of 4" would be reporting an unwarmed indicator as a market reading.
    const short = series(30, 100, 0.5)
    const action = describeNextAction(readLiveSignals(short, 'short-term-channel'), false)
    expect(action.kind).toBe('unknown')
  })
})
