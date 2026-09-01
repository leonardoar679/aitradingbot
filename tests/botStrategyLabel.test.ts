import { describe, expect, it } from 'vitest'
import type { Bot } from '../shared/ipc'
import { resolvedStrategy } from '../src/bots/types'
import { getStrategy } from '../src/backtest/strategies'

// A bot card used to print bot.strategy, a free-text label written when the bot was created, while
// the dry run executed getStrategy(bot.strategyId). getStrategy falls back to the default for a
// missing or unknown id rather than throwing, so the two could name different strategies and the
// card would never say so.
//
// This is not hypothetical: a real profile holds a bot saved before strategyId existed, labelled
// "EMS", with no strategyId at all. It runs EMA Crossover + ATR Stop. The card said "EMS".
//
// shared/ipc.ts declares strategyId as a required string, so TypeScript offers no protection here
// -- the stored record simply does not match the declared type. These tests stand in for the
// compiler on data that predates it.
const bot = (over: Partial<Bot>): Bot =>
  ({
    id: 'b1',
    name: 'CloudSpider',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    strategy: 'Trend Regime Ensemble',
    strategyId: 'trend-regime-ensemble',
    enabled: true,
    enabledAt: 1,
    archived: false,
    ...over
  }) as Bot

describe('what a bot is labelled versus what it runs', () => {
  it('reports the executed strategy, not the stored label', () => {
    const legacy = bot({ strategy: 'EMS', strategyId: undefined as unknown as string })
    const r = resolvedStrategy(legacy)
    expect(r.name).toBe(getStrategy('').name)
    expect(r.name).not.toBe('EMS')
    expect(r.mismatched).toBe(true)
    expect(r.label).toBe('EMS')
  })

  it('flags an unknown id too, not just a missing one', () => {
    const r = resolvedStrategy(bot({ strategy: 'Something Removed', strategyId: 'deleted-strategy' }))
    expect(r.mismatched).toBe(true)
    expect(r.name).toBe(getStrategy('deleted-strategy').name)
  })

  it('stays quiet when the label already agrees', () => {
    expect(resolvedStrategy(bot({})).mismatched).toBe(false)
    expect(resolvedStrategy(bot({})).name).toBe('Trend Regime Ensemble')
  })

  it('does not flag a bot that simply has no label stored', () => {
    // Nothing to contradict, so there is nothing to warn about -- only a disagreement is worth ink.
    expect(resolvedStrategy(bot({ strategy: '' })).mismatched).toBe(false)
  })
})
