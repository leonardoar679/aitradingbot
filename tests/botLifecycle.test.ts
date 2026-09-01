import { describe, expect, it } from 'vitest'
import { archiveBot, costsMoneyToRun, createBot, resolvedStrategy, type Bot } from '../src/bots/types'
import { STRATEGIES, getStrategy } from '../src/backtest/strategies'
import { GPT_INTRADAY_STRATEGY_ID } from '../shared/aiSignal'

const PAIR = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' }

function enabledBot(over: Partial<Bot> = {}): Bot {
  return {
    ...createBot({ id: 'b1', name: 'Probe', exchange: 'binance', pair: PAIR, strategyId: 'short-term-channel' }),
    enabled: true,
    enabledAt: 1_700_000_000,
    ...over
  }
}

describe('createBot', () => {
  it('creates a stopped, unarchived bot with no enabled window', () => {
    const bot = createBot({ id: 'b1', name: 'Probe', exchange: 'binance', pair: PAIR, strategyId: 'short-term-channel' })
    expect(bot.enabled).toBe(false)
    expect(bot.enabledAt).toBeNull()
    expect(bot.archived).toBe(false)
    expect(bot.symbol).toBe('BTCUSDT')
  })

  // The label-vs-execution mismatch on the card comes from records written before strategyId
  // existed. This is the guarantee that no NEW record can be born that way, for any strategy.
  it('labels every strategy with the name that strategy actually runs under', () => {
    for (const strategy of STRATEGIES) {
      const bot = createBot({ id: 'b1', name: 'Probe', exchange: 'binance', pair: PAIR, strategyId: strategy.id })
      expect(bot.strategy).toBe(getStrategy(strategy.id).name)
      expect(resolvedStrategy(bot).mismatched).toBe(false)
    }
  })
})

describe('archiveBot', () => {
  // Archiving used to set archived:true and enabled:false and stop there, leaving enabledAt live
  // on a stopped bot -- a record no other path in the page produces.
  it('stops the bot and closes its enabled window', () => {
    const archived = archiveBot(enabledBot())
    expect(archived.archived).toBe(true)
    expect(archived.enabled).toBe(false)
    expect(archived.enabledAt).toBeNull()
  })

  it('never leaves enabledAt set on a bot that is not enabled', () => {
    for (const bot of [enabledBot(), enabledBot({ enabled: false }), enabledBot({ enabledAt: null })]) {
      const archived = archiveBot(bot)
      expect(archived.enabled === false && archived.enabledAt === null).toBe(true)
    }
  })

  it('preserves identity and configuration', () => {
    const bot = enabledBot({ name: 'Keep Me' })
    const archived = archiveBot(bot)
    expect(archived.id).toBe(bot.id)
    expect(archived.name).toBe('Keep Me')
    expect(archived.symbol).toBe(bot.symbol)
    expect(archived.strategyId).toBe(bot.strategyId)
  })
})

describe('costsMoneyToRun', () => {
  it('is true for GPT Intraday', () => {
    expect(costsMoneyToRun(GPT_INTRADAY_STRATEGY_ID)).toBe(true)
  })

  // Every other shipped strategy replays local arithmetic over candles that are already fetched.
  // If a second paid strategy is ever added, this fails until the gate learns about it -- which
  // is the point: the enable-confirmation and the stopped-bot fetch both read this one answer.
  it('is false for every other shipped strategy', () => {
    for (const strategy of STRATEGIES) {
      if (strategy.id === GPT_INTRADAY_STRATEGY_ID) continue
      expect(costsMoneyToRun(strategy.id)).toBe(false)
    }
  })

  it('is false for a missing or unknown id, which falls back to a free strategy', () => {
    expect(costsMoneyToRun('')).toBe(false)
    expect(costsMoneyToRun('no-such-strategy')).toBe(false)
  })
})
