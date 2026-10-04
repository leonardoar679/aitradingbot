import { describe, expect, it } from 'vitest'
import {
  archiveBot,
  confirmsEntries,
  costsMoneyToRun,
  createBot,
  describeAiCalls,
  describeConfirmBotCost,
  describeBotRoute,
  describeBotRouteKind,
  describePaidBotCost,
  gptCadenceOf,
  gptPinsFrom,
  gptRouteOf,
  resolvedStrategy,
  withAiPins,
  type Bot
} from '../src/bots/types'
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

describe('describeAiCalls', () => {
  it('leads with failures, because an all-failed tape replays as a strategy that simply never trades', () => {
    const described = describeAiCalls({ total: 672, cached: 0, generated: 672, errors: 672 })
    expect(described.bad).toBe(true)
    expect(described.text).toBe('672 of 672 AI calls failed')
  })

  it('reports a single failure as failure, not as a healthy refresh', () => {
    expect(describeAiCalls({ total: 672, cached: 671, generated: 1, errors: 1 }).bad).toBe(true)
  })

  // The steady state: one new candle every 15 minutes, everything else served from cache. This is
  // the number that tells someone what leaving the bot on actually costs them per refresh.
  it('names cached and fresh calls separately when nothing failed', () => {
    const described = describeAiCalls({ total: 672, cached: 671, generated: 1, errors: 0 })
    expect(described.bad).toBe(false)
    expect(described.text).toBe('672 decisions · 671 cached · 1 new call last refresh')
  })

  it('says "1 decision" for a bot in its first hour', () => {
    // Seen on the first real bot: its card read "1 decisions" until the second one arrived.
    expect(describeAiCalls({ total: 1, cached: 0, generated: 1, errors: 0 }).text).toBe('1 decision · 0 cached · 1 new call last refresh')
    expect(describeAiCalls({ total: 0, cached: 0, generated: 0, errors: 0 }).text).toBe('0 decisions · 0 cached · 0 new calls last refresh')
  })

  it('pluralises fresh calls', () => {
    expect(describeAiCalls({ total: 672, cached: 0, generated: 672, errors: 0 }).text).toContain('672 new calls')
    expect(describeAiCalls({ total: 672, cached: 672, generated: 0, errors: 0 }).text).toContain('0 new calls')
  })
})

// The confirmation shown before a paid bot is switched on. It is the only consent that bot ever
// asks for -- after it, the bot spends on its own for as long as the app is open -- so what it
// says has to be the model and the money, not a general warning.
describe('describePaidBotCost', () => {
  const estimate = {
    total: 0,
    cached: 0,
    maximumApiCalls: 0,
    model: 'openai/gpt-5-mini',
    perCallCostUsd: 0.002,
    estimatedCostUsd: 0,
    costBasis: 'history' as const,
    budgetRemainingUsd: 0.82
  }

  it('names the model, the biller, a daily figure and what is left of the budget', () => {
    const text = describePaidBotCost('Trend BTC', estimate)
    expect(text).toContain('Enable "Trend BTC"?')
    expect(text).toContain('openai/gpt-5-mini')
    expect(text).toContain('OpenRouter')
    // 96 decisions a day at $0.002 each.
    expect(text).toContain('$0.19 a day')
    expect(text).toContain('$0.82')
  })

  it('never invents a price for a model it knows nothing about', () => {
    const text = describePaidBotCost('Trend BTC', { ...estimate, perCallCostUsd: null, costBasis: 'unknown' })
    expect(text).not.toMatch(/a day at what this model/)
    expect(text).toContain('96 a day')
  })

  it('says why when the cost could not be estimated at all', () => {
    const text = describePaidBotCost('Trend BTC', null, 'No OpenRouter API key configured. Add one on the Agents page.')
    expect(text).toContain('could not be estimated: No OpenRouter API key configured')
  })
})

// A bot whose entries a model reviews. It spends, but by the entry rather than by the candle, and
// only once it has been switched on -- so it is deliberately NOT a "costs money to run" strategy,
// which is the rule that stops a stopped bot's chart from being fetched at all.
describe('a bot with AI-confirmed entries', () => {
  const create = (strategyId: string, aiConfirm?: boolean): Bot =>
    createBot({ id: 'b1', name: 'Probe', exchange: 'binance', pair: PAIR, strategyId, aiConfirm })

  it('carries the flag only when it was asked for', () => {
    expect(create('trend-regime-ensemble', true).aiConfirm).toBe(true)
    expect(create('trend-regime-ensemble', false)).not.toHaveProperty('aiConfirm')
    expect(create('trend-regime-ensemble')).not.toHaveProperty('aiConfirm')
  })

  it('cannot be created on GPT Intraday, whose decisions already come from a model', () => {
    const bot = create(GPT_INTRADAY_STRATEGY_ID, true)
    expect(bot).not.toHaveProperty('aiConfirm')
    expect(confirmsEntries(bot)).toBe(false)
    // Nor does a record edited by hand make it one.
    expect(confirmsEntries({ strategyId: GPT_INTRADAY_STRATEGY_ID, aiConfirm: true })).toBe(false)
  })

  it('is reviewed on every other strategy, and only when the flag is set', () => {
    for (const strategy of STRATEGIES) {
      if (strategy.id === GPT_INTRADAY_STRATEGY_ID) continue
      expect(confirmsEntries(create(strategy.id, true)), strategy.id).toBe(true)
      expect(confirmsEntries(create(strategy.id)), strategy.id).toBe(false)
    }
  })

  it('is free to look at while stopped: it is not a strategy that costs money to run', () => {
    expect(costsMoneyToRun(create('trend-regime-ensemble', true).strategyId)).toBe(false)
  })

  it('keeps the flag when archived, so restoring it restores the same bot', () => {
    expect(archiveBot({ ...create('trend-regime-ensemble', true), enabled: true, enabledAt: 1_700_000_000 }).aiConfirm).toBe(true)
  })
})

describe('describeAiCalls for reviewed entries', () => {
  it('counts entries, not candles, and names the vetoes', () => {
    const described = describeAiCalls({ total: 3, cached: 3, generated: 0, errors: 0, vetoed: 1 })
    expect(described).toEqual({ text: '3 entries reviewed · 1 vetoed · 0 new calls last refresh', bad: false })
    expect(describeAiCalls({ total: 1, cached: 0, generated: 1, errors: 0, vetoed: 0 }).text).toBe(
      '1 entry reviewed · 0 vetoed · 1 new call last refresh'
    )
  })

  it('says so when the strategy has signalled nothing yet', () => {
    expect(describeAiCalls({ total: 0, cached: 0, generated: 0, errors: 0, vetoed: 0 })).toEqual({
      text: 'AI confirmation on · no entry signalled yet',
      bad: false
    })
  })

  // The one state where the bot is not doing what its strategy signalled, and nothing else on the
  // card would say why it is flat.
  it('leads with an entry that could not be reviewed, because that entry is not taken', () => {
    const described = describeAiCalls({ total: 2, cached: 2, generated: 0, errors: 1, vetoed: 0 })
    expect(described.bad).toBe(true)
    expect(described.text).toContain('could not be reached')
    expect(described.text).toContain('not taken')
  })
})

describe('describeConfirmBotCost', () => {
  const estimate = {
    quote: { decision: null, model: 'openai/gpt-5-mini', perCallCostUsd: 0.0031, costBasis: 'history' as const, budgetRemainingUsd: 0.82 },
    recentEntries: 3,
    recentDays: 100
  }

  it('prices one review, not a day of candles, and says how often the strategy has been signalling', () => {
    const text = describeConfirmBotCost('Trend BTC', 'Trend Regime Ensemble', estimate)
    expect(text).toContain('Enable "Trend BTC"?')
    expect(text).toContain('Trend Regime Ensemble decides as it always does')
    expect(text).toContain('openai/gpt-5-mini')
    expect(text).toContain('OpenRouter')
    expect(text).toContain('one call per signalled entry, about $0.0031 each at what this model has been costing')
    expect(text).toContain('Over the last 100 days it would have opened 3 positions.')
    expect(text).toContain('$0.82')
    expect(text).not.toContain('a day')
  })

  it('says what a veto does, what an unreachable model does, and that it is paper', () => {
    const text = describeConfirmBotCost('Trend BTC', 'Trend Regime Ensemble', estimate)
    expect(text).toContain('A vetoed entry is skipped')
    expect(text).toContain('If the model cannot be reached, the entry is not taken')
    expect(text).toContain('Paper only')
  })

  it('never invents a price, and says a price-list figure is one', () => {
    const unknown = describeConfirmBotCost('Trend BTC', 'Trend Regime Ensemble', {
      ...estimate,
      quote: { ...estimate.quote, perCallCostUsd: null, costBasis: 'unknown' as const }
    })
    expect(unknown).not.toMatch(/about \$/)
    const priced = describeConfirmBotCost('Trend BTC', 'Trend Regime Ensemble', {
      ...estimate,
      quote: { ...estimate.quote, costBasis: 'pricing' as const }
    })
    expect(priced).toContain('at what this model is priced at')
  })

  it('leaves out the recent count when there is no history to count over', () => {
    expect(describeConfirmBotCost('Trend BTC', 'Trend Regime Ensemble', { ...estimate, recentDays: 0 })).not.toContain('Over the last')
    expect(describeConfirmBotCost('Trend BTC', 'Trend Regime Ensemble', { ...estimate, recentEntries: 1 })).toContain('opened 1 position.')
  })

  it('says why when the cost could not be estimated at all', () => {
    const text = describeConfirmBotCost('Trend BTC', 'Trend Regime Ensemble', null, 'No OpenRouter API key configured. Add one on the Agents page.')
    expect(text).toContain('the default model')
    expect(text).toContain('could not be estimated: No OpenRouter API key configured')
  })
})

// A GPT Intraday bot that asks less often than every candle. The cadence decides which candles a
// model is asked about, so it is part of what the bot is -- and part of what switching it on costs.
describe('a GPT Intraday bot with a cadence', () => {
  const create = (strategyId: string, aiEveryBars?: number): Bot =>
    createBot({ id: 'b1', name: 'Probe', exchange: 'binance', pair: PAIR, strategyId, aiEveryBars })

  it('keeps the cadence it was created with', () => {
    expect(create(GPT_INTRADAY_STRATEGY_ID, 16).aiEveryBars).toBe(16)
    expect(create(GPT_INTRADAY_STRATEGY_ID, 4).aiEveryBars).toBe(4)
    expect(gptCadenceOf(create(GPT_INTRADAY_STRATEGY_ID, 16))).toBe(16)
  })

  it('carries no cadence when it is asked on every candle, like every bot saved before there was one', () => {
    expect(create(GPT_INTRADAY_STRATEGY_ID, 1)).not.toHaveProperty('aiEveryBars')
    expect(create(GPT_INTRADAY_STRATEGY_ID)).not.toHaveProperty('aiEveryBars')
    expect(gptCadenceOf(create(GPT_INTRADAY_STRATEGY_ID))).toBe(1)
  })

  it('is never created with a cadence nobody offered', () => {
    for (const every of [3, 0, -16, 96, Number.NaN]) expect(create(GPT_INTRADAY_STRATEGY_ID, every)).not.toHaveProperty('aiEveryBars')
  })

  it('means nothing on any other strategy, whatever was passed or stored', () => {
    // The picker is hidden for these, and a choice left over from GPT Intraday must not follow.
    expect(create('trend-regime-ensemble', 16)).not.toHaveProperty('aiEveryBars')
    expect(gptCadenceOf({ strategyId: 'trend-regime-ensemble', aiEveryBars: 16 })).toBe(1)
  })

  it('passes a stored cadence through unread, so the main process is the one to refuse a bad one', () => {
    // Falling back to "every candle" would turn an unreadable setting into ninety-six calls a day.
    expect(gptCadenceOf({ strategyId: GPT_INTRADAY_STRATEGY_ID, aiEveryBars: 3 })).toBe(3)
  })

  const estimate = {
    total: 0,
    cached: 0,
    maximumApiCalls: 0,
    model: 'openai/gpt-5-mini',
    perCallCostUsd: 0.002,
    estimatedCostUsd: 0,
    costBasis: 'history' as const,
    budgetRemainingUsd: 0.82
  }

  it('is priced by its own cadence when it is switched on', () => {
    const hourly = describePaidBotCost('GPT BTC', estimate, null, 4)
    expect(hourly).toContain('one call every hour for as long as this app stays open (24 a day, roughly $0.048 a day')
    expect(hourly).toContain('the decisions it missed, up to 28 days of them at once')
    expect(hourly).not.toContain('15-minute candle')

    const fourHourly = describePaidBotCost('GPT BTC', estimate, null, 16)
    expect(fourHourly).toContain('one call every 4 hours for as long as this app stays open (6 a day, roughly $0.012 a day')
    expect(fourHourly).toContain('up to 112 days of them at once')
  })

  it('still says how often it will ask when nothing else could be estimated', () => {
    const text = describePaidBotCost('GPT BTC', null, 'No OpenRouter API key configured. Add one on the Agents page.', 16)
    expect(text).toContain('one call every 4 hours')
    expect(text).toContain('6 a day')
    expect(text).toContain('could not be estimated: No OpenRouter API key configured')
  })

  it('reads exactly as it always did for a bot asked on every candle', () => {
    const text = describePaidBotCost('GPT BTC', estimate)
    expect(text).toContain('one call per new 15-minute candle for as long as this app stays open (96 a day, roughly $0.19 a day')
    expect(text).toContain('the candles it missed, up to a week of them at once')
    expect(describePaidBotCost('GPT BTC', estimate, null, 1)).toBe(text)
  })
})

// A GPT Intraday bot switched on with a route: a second model asked whenever the first one's
// answer is passed on. The confirmation is the only consent the bot asks for, so the second model
// and what it can add to the bill have to be in it, and the pin has to survive being stored.
describe('a routed GPT Intraday bot', () => {
  const route = { model: 'acme/frontier', when: 'acting' as const }
  const estimate = {
    total: 0,
    cached: 0,
    maximumApiCalls: 0,
    model: 'openai/gpt-5-mini',
    route: { ...route, maximumApiCalls: 0, perCallCostUsd: 0.013 as number | null, costBasis: 'pricing' as 'pricing' | 'history' | 'unknown' },
    perCallCostUsd: 0.002,
    estimatedCostUsd: 0,
    costBasis: 'history' as const,
    budgetRemainingUsd: 0.82
  }

  it('is told about the second model, when it is asked, and the most it can add in a day', () => {
    const text = describePaidBotCost('GPT BTC', estimate, null, 16)
    expect(text).toContain('one call every 4 hours for as long as this app stays open (6 a day, roughly $0.012 a day')
    expect(text).toContain(
      'When openai/gpt-5-mini wants to open or close a position, acme/frontier is asked the same question and its answer is ' +
        'the one that counts: up to 6 more calls a day, up to $0.078 a day at what that model is priced at.'
    )
  })

  it('says where the second model\'s price came from, and prints none it does not have', () => {
    const measured = describePaidBotCost('GPT BTC', { ...estimate, route: { ...estimate.route, costBasis: 'history' } })
    expect(measured).toContain('up to 96 more calls a day, up to $1.25 a day at what that model has been costing.')
    const unknown = describePaidBotCost('GPT BTC', { ...estimate, route: { ...estimate.route, when: 'unsure', perCallCostUsd: null, costBasis: 'unknown' } })
    expect(unknown).toContain('When openai/gpt-5-mini answers with less than 65% confidence, acme/frontier is asked the same question')
    expect(unknown).toContain('up to 96 more calls a day.')
    expect(unknown).not.toContain('at what that model')
  })

  it('says nothing about a second model to a bot that has none', () => {
    expect(describePaidBotCost('GPT BTC', { ...estimate, route: undefined })).not.toContain('same question')
    expect(describePaidBotCost('GPT BTC', null, 'no key')).not.toContain('same question')
  })

  it('is never routed by being created: the route is pinned when the bot is switched on', () => {
    const bot = createBot({ id: 'b1', name: 'Probe', exchange: 'binance', pair: PAIR, strategyId: GPT_INTRADAY_STRATEGY_ID })
    expect(bot).not.toHaveProperty('aiRoute')
    expect(gptRouteOf(bot)).toBeNull()
  })

  it('carries its pin through to the request unread, and has none on any other strategy', () => {
    expect(gptRouteOf({ strategyId: GPT_INTRADAY_STRATEGY_ID, aiRoute: route })).toEqual(route)
    expect(gptRouteOf({ strategyId: 'trend-regime-ensemble', aiRoute: route })).toBeNull()
    // Unreadable is passed on as it is: the main process refuses it, and the bot stops with the
    // reason instead of quietly running on one model or on two.
    const broken = { model: 'acme/frontier', when: 'always' } as unknown as Bot['aiRoute']
    expect(gptRouteOf({ strategyId: GPT_INTRADAY_STRATEGY_ID, aiRoute: broken })).toBe(broken)
  })

  it('names both models on its header, and prints nothing it cannot read', () => {
    const bot = { strategyId: GPT_INTRADAY_STRATEGY_ID, aiModel: 'openai/gpt-5-mini', aiRoute: route }
    expect(describeBotRoute(bot)).toBe('openai/gpt-5-mini, then acme/frontier when it wants to open or close a position')
    expect(describeBotRoute({ ...bot, aiModel: undefined })).toBe('the default model, then acme/frontier when it wants to open or close a position')
    expect(describeBotRoute({ ...bot, aiRoute: undefined })).toBeNull()
    expect(describeBotRoute({ ...bot, strategyId: 'trend-regime-ensemble' })).toBeNull()
    expect(describeBotRoute({ ...bot, aiRoute: { model: 'acme/frontier', when: 'always' } as unknown as Bot['aiRoute'] })).toBeNull()
  })

  it('reports calls, and how many decisions went to the second model', () => {
    expect(describeAiCalls({ total: 672, cached: 660, generated: 14, errors: 0, escalated: 31 })).toEqual({
      text: '672 decisions · 660 cached · 14 new calls last refresh · 31 passed on to the second model',
      bad: false
    })
    expect(describeAiCalls({ total: 672, cached: 660, generated: 14, errors: 0, escalated: 0 }).text).toContain('0 passed on to the second model')
    // A failure still leads, routed or not.
    expect(describeAiCalls({ total: 672, cached: 0, generated: 9, errors: 3, escalated: 2 })).toEqual({ text: '3 of 672 AI calls failed', bad: true })
  })
})

// What a bot is pinned to at the moment it is switched on. The confirmation is written from an
// estimate, and the pins are taken from the same estimate, so the bot that starts running is the
// one that was just described -- including when what was described had no second model in it.
describe('pinning a paid bot when it is switched on', () => {
  const route = { model: 'acme/frontier', when: 'unsure' as const }
  const estimate = {
    total: 0,
    cached: 0,
    maximumApiCalls: 0,
    model: 'openai/gpt-5-mini',
    route: { ...route, maximumApiCalls: 0, perCallCostUsd: 0.013, costBasis: 'pricing' as const },
    perCallCostUsd: 0.002,
    estimatedCostUsd: 0,
    costBasis: 'history' as const,
    budgetRemainingUsd: 0.82
  }
  const bot = (over: Partial<Bot> = {}): Bot => ({
    ...createBot({ id: 'b1', name: 'Probe', exchange: 'binance', pair: PAIR, strategyId: GPT_INTRADAY_STRATEGY_ID }),
    ...over
  })

  it('takes the model and the route from the estimate the confirmation was written from', () => {
    // The route as two fields, with none of the estimate's own figures stored beside them.
    expect(gptPinsFrom(estimate)).toEqual({ model: 'openai/gpt-5-mini', route })
    expect(withAiPins(bot(), gptPinsFrom(estimate))).toMatchObject({ aiModel: 'openai/gpt-5-mini', aiRoute: route })
  })

  it('removes an older route when the confirmation named none', () => {
    const routedLastMonth = bot({ aiModel: 'acme/old', aiRoute: { model: 'acme/frontier', when: 'acting' } })
    // No route is set any more.
    const unrouted = withAiPins(routedLastMonth, gptPinsFrom({ ...estimate, route: undefined }))
    expect(unrouted.aiModel).toBe('openai/gpt-5-mini')
    expect(unrouted).not.toHaveProperty('aiRoute')
    // Nothing could be estimated, so the confirmation described one default model and no more.
    expect(gptPinsFrom(null)).toEqual({ model: undefined, route: null })
    const unpriced = withAiPins(routedLastMonth, gptPinsFrom(null))
    expect(unpriced).not.toHaveProperty('aiRoute')
    expect(unpriced.aiModel).toBe('acme/old')
  })

  it('replaces an older route with the one that is set now', () => {
    const before = bot({ aiModel: 'acme/old', aiRoute: { model: 'acme/other', when: 'acting' } })
    expect(withAiPins(before, gptPinsFrom(estimate))).toMatchObject({ aiModel: 'openai/gpt-5-mini', aiRoute: route })
  })

  it('leaves the pins alone when a bot is switched without any', () => {
    const before = bot({ aiModel: 'acme/old', aiRoute: route, enabled: true, enabledAt: 1_700_000_000 })
    expect(withAiPins(before)).toEqual(before)
    // A bot whose entries a model confirms is pinned to a model, and has no route to touch.
    expect(withAiPins(bot({ strategyId: 'trend-regime-ensemble', aiConfirm: true }), { model: 'acme/reviewer' })).toMatchObject({
      aiModel: 'acme/reviewer'
    })
    expect(withAiPins(bot(), { model: 'acme/reviewer' })).not.toHaveProperty('aiRoute')
  })
})

// A bot whose second step is a panel of agents: four calls for each decision passed on. What it
// is told when it is switched on has to carry that multiple, in calls and in dollars.
describe('a GPT Intraday bot routed to a panel', () => {
  const route = { model: 'panel:openai/gpt-5-mini', when: 'acting' as const }
  const estimate = {
    total: 0,
    cached: 0,
    maximumApiCalls: 0,
    model: 'openai/gpt-5-mini',
    route: { ...route, maximumApiCalls: 0, perCallCostUsd: 0.002, costBasis: 'history' as const, callsPerDecision: 4 },
    perCallCostUsd: 0.002,
    estimatedCostUsd: 0,
    costBasis: 'history' as const,
    budgetRemainingUsd: 0.82
  }

  it('is told the panel takes four calls for each decision passed on, and what that could come to', () => {
    const text = describePaidBotCost('GPT BTC', estimate, null, 16)
    expect(text).toContain(
      'When openai/gpt-5-mini wants to open or close a position, the agent panel on openai/gpt-5-mini is asked the same question ' +
        'and its answer is the one that counts: up to 24 more calls a day (4 for each decision passed on), up to $0.048 a day at ' +
        'what that model has been costing.'
    )
    // Asked on every candle the ceiling is four times ninety-six.
    expect(describePaidBotCost('GPT BTC', estimate)).toContain('up to 384 more calls a day (4 for each decision passed on), up to $0.77 a day')
  })

  it('is named on its header and its card as a model and a panel', () => {
    const bot = { strategyId: GPT_INTRADAY_STRATEGY_ID, aiModel: 'openai/gpt-5-mini', aiRoute: route }
    expect(describeBotRoute(bot)).toBe('openai/gpt-5-mini, then the agent panel on openai/gpt-5-mini when it wants to open or close a position')
    expect(describeBotRouteKind(bot)).toBe('model and panel')
    expect(describeBotRouteKind({ ...bot, aiRoute: { model: 'acme/frontier', when: 'unsure' } })).toBe('two models')
    expect(describeBotRouteKind({ ...bot, aiRoute: undefined })).toBeNull()
    expect(describeBotRouteKind({ ...bot, strategyId: 'trend-regime-ensemble' })).toBeNull()
    expect(describeBotRouteKind({ ...bot, aiRoute: { model: 'acme/frontier', when: 'always' } as unknown as Bot['aiRoute'] })).toBeNull()
  })

  it('is pinned to the panel by its id, exactly as it would be to a model', () => {
    expect(gptPinsFrom(estimate)).toEqual({ model: 'openai/gpt-5-mini', route })
  })
})
