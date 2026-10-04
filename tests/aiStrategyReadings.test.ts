import { describe, expect, it } from 'vitest'
import { STRATEGIES } from '../src/backtest/strategies'
import { strategyBlockFor } from '../src/backtest/aiConfirmation'
import { channelPosition, channelPositionAt, channelReadings, shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import { shortTermChannelRegime } from '../src/backtest/strategies/shortTermChannelRegime'
import { regimeAgreement, regimeReadings, trendRegimeEnsemble } from '../src/backtest/strategies/trendRegimeEnsemble'
import { parseStrategyBlock } from '../shared/aiConfirm'
import type { Candle } from '../shared/ipc'

// What a model reviewing an entry is told the strategy measured. Two things are pinned: the
// readings are the strategy's own numbers rather than a second calculation of them, and they are
// the same bytes however much history a caller fetched -- because they are hashed into the
// review's cache key, and a reading that moved with the fetch would bill one entry once per caller.

const DAY = 86_400
const HOUR = 3600

function series(count: number, barSeconds: number, drift = 0.5): Candle[] {
  let seed = 23
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const out: Candle[] = []
  let price = 100
  for (let i = 0; i < count; i++) {
    const open = price
    price = Math.max(1, price + (next() - drift) * 1.5)
    out.push({
      time: 1_600_000_000 + i * barSeconds,
      open,
      high: Math.max(open, price) + next() * 0.5,
      low: Math.min(open, price) - next() * 0.5,
      close: price,
      volume: 100 + next() * 50
    })
  }
  return out
}

describe('channelPositionAt', () => {
  it('is channelPosition read at one bar, on every bar', () => {
    const candles = series(260, HOUR)
    const periods = [5, 9, 20, 33]
    const whole = channelPosition(candles, periods)
    for (let index = 0; index < candles.length; index++) {
      // Object.is, so a NaN before warm-up has to be a NaN here too and not merely "falsy".
      expect(Object.is(channelPositionAt(candles, periods, index), whole[index]), `bar ${index}`).toBe(true)
    }
  })

  it('is NaN outside the series', () => {
    const candles = series(40, HOUR)
    expect(channelPositionAt(candles, [5], -1)).toBeNaN()
    expect(channelPositionAt(candles, [5], candles.length)).toBeNaN()
  })
})

describe('Trend Regime readings', () => {
  // A rising daily series, so the unanimous vote the strategy enters on actually occurs.
  const candles = series(220, DAY, 0.35)
  const signals = trendRegimeEnsemble.generateSignals(candles)
  const entry = signals.entries.lastIndexOf(true)

  it('reports the vote the strategy acted on', () => {
    expect(entry).toBeGreaterThan(0)
    const readings = regimeReadings(candles, entry)
    expect(readings[0]).toEqual({ label: 'lookbacks with the close above its average', value: '4 of 4' })
    // One distance per lookback, each positive on a bar where every lookback voted yes.
    expect(readings.slice(1).map((reading) => reading.label)).toEqual([
      'close above its 20-day average, %',
      'close above its 30-day average, %',
      'close above its 50-day average, %',
      'close above its 80-day average, %'
    ])
    for (const reading of readings.slice(1)) expect(reading.value).toBeGreaterThan(0)
  })

  it('counts the vote from regimeAgreement on a bar that is not unanimous', () => {
    // A series going nowhere, where the four lookbacks disagree as often as not.
    const sideways = series(220, DAY, 0.5)
    const agreement = regimeAgreement(sideways, DAY)
    const split = agreement.findIndex((value, index) => index >= 80 && value > 0 && value < 1)
    expect(split).toBeGreaterThan(0)
    expect(regimeReadings(sideways, split)[0].value).toBe(`${Math.round(agreement[split] * 4)} of 4`)
  })

  it('is the same however much history precedes the bar', () => {
    const full = regimeReadings(candles, entry)
    // Exactly the slowest lookback's worth of bars and no more.
    const cut = entry - 79
    expect(regimeReadings(candles.slice(cut), entry - cut)).toEqual(full)
    expect(regimeReadings(candles.slice(cut - 31), entry - cut + 31)).toEqual(full)
  })

  it('has nothing to say about a series whose bar size cannot be read', () => {
    expect(regimeReadings([candles[0]], 0)).toEqual([])
    expect(regimeReadings(candles, candles.length)).toEqual([])
  })
})

describe('Short-Term Channel readings', () => {
  const candles = series(700, HOUR, 0.4)
  const signals = shortTermChannel.generateSignals(candles)
  const entry = signals.entries.lastIndexOf(true)

  it('reports where the close sits in the channels, beside the lines the rule acts on', () => {
    expect(entry).toBeGreaterThan(0)
    const [position, enter, exit] = channelReadings(candles, entry)
    expect(position.label).toBe('mean position in the 2/3/5/8-day ranges (0 = lows, 1 = highs)')
    // It entered here, so the reading is at or past the entry line it is shown beside.
    expect(position.value).toBeGreaterThanOrEqual(0.95)
    expect(enter).toEqual({ label: 'enters at or above', value: 0.95 })
    expect(exit).toEqual({ label: 'exits at or below', value: 0.25 })
  })

  it('is the same however much history precedes the bar', () => {
    const full = channelReadings(candles, entry)
    // The longest channel is eight days of hourly bars, read as of the bar before.
    const cut = entry - 8 * 24
    expect(channelReadings(candles.slice(cut), entry - cut)).toEqual(full)
    expect(channelReadings(candles.slice(cut - 57), entry - cut + 57)).toEqual(full)
  })

  it('offers nothing before the channels are full', () => {
    expect(channelReadings(candles, 10)).toEqual([])
  })

  it('gives the gated strategy both halves of its rule', () => {
    const labels = shortTermChannelRegime.entryReadings?.(candles, entry).map((reading) => reading.label) ?? []
    expect(labels[0]).toContain('mean position')
    expect(labels).toContain('lookbacks with the close above its average')
  })
})

describe('the block a model is given', () => {
  const candles = series(700, HOUR, 0.4)

  // The main process refuses a block that is too long or malformed rather than trimming it. This
  // is what guarantees it never has to: every strategy that can be reviewed produces one it accepts.
  it.each(STRATEGIES.filter((strategy) => !strategy.requiresExternalSignals).map((strategy) => [strategy.id, strategy] as const))(
    '%s produces a block the main process accepts unchanged',
    (_id, strategy) => {
      const index = candles.length - 1
      const block = strategyBlockFor(strategy, candles, index, candles[index].close * 0.9)
      expect(parseStrategyBlock(block)).toEqual(block)
      expect(block.stopDistancePct).toBe(10)
    }
  )

  it('rounds the stop distance, and leaves it out when there is no usable stop', () => {
    const index = candles.length - 1
    const close = candles[index].close
    expect(strategyBlockFor(shortTermChannel, candles, index, close * (1 - 0.123456)).stopDistancePct).toBe(12.3)
    expect(strategyBlockFor(shortTermChannel, candles, index, null).stopDistancePct).toBeNull()
    // A "stop" above the entry is not a stop.
    expect(strategyBlockFor(shortTermChannel, candles, index, close * 1.1).stopDistancePct).toBeNull()
  })
})
