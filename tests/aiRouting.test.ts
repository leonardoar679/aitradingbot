import { describe, expect, it } from 'vitest'
import { AI_ADDITION_INFO, additionsModelOf } from '../shared/aiAdditions'
import type { AiConfig } from '../shared/aiCost'
import {
  BOT_CATCHUP_HOURS,
  additionAsksNow,
  botAskFromSec,
  healAiRoles,
  medianTokensOf,
  modelsInUse,
  priceOfCall,
  readModelHistory,
  repinBot,
  roleChoiceProblem,
  rolesPlanOf,
  routingPreviewText,
  routingTableOf,
  servedFamilyOf,
  tapeModelAt,
  type RoutedBot
} from '../shared/aiRouting'

// WHO ASKS WHICH MODEL (shared/aiRouting.ts; V7.2-R Stage 1): every caller that asks by itself, with the model
// it asks now; one move to three roles, with what it changes; the models still in use; what the answering
// model says about the model asked; a bot's earlier pins.

const MINI = 'openai/gpt-5-mini'
const OPUS = 'anthropic/claude-opus-5.5'
const ARGON = 'google/gemini-4-argon@low'
const LUNA = 'openai/gpt-6-luna@minimal'

/** The user's profile as found on 20 October 2026: the default moved to Opus, everything that asks by itself on GPT-5 Mini. */
const FOUND: Pick<AiConfig, 'defaultModel' | 'watch' | 'watchPaper' | 'additions' | 'roles'> = {
  defaultModel: OPUS,
  watch: { enabled: true, models: [MINI], maxEventsPerDay: 10, minBand: 'urgent', firstModelGates: false, confirmLive: true, askAt: 'detected' },
  watchPaper: { enabled: true, model: MINI, stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 3, dropOnBtcMovePct: 1 },
  // The article reading ships off (V8 Stage 5).
  additions: { news: true, why: true, exit: true, review: true, daily: true, article: false, direction: false },
  roles: null
}
const BOTS: RoutedBot[] = [
  { id: 'gpt', name: 'GPT BTC hourly', enabled: true, strategyId: 'gpt-intraday', aiModel: MINI },
  { id: 'trend', name: 'Trend Regime BTC', enabled: true, strategyId: 'trend-regime-ensemble' },
  { id: 'old', name: 'Old GPT', enabled: true, archived: true, strategyId: 'gpt-intraday', aiModel: MINI },
  { id: 'review', name: 'Reviewed channel', enabled: false, strategyId: 'short-term-channel', aiConfirm: true }
]
const CHOICE = { decide: OPUS, gate: ARGON, summarize: LUNA }

describe('the routing table', () => {
  it('shows every caller of the profile as found asking GPT-5 Mini, whatever the default', () => {
    const table = routingTableOf(FOUND, BOTS)
    expect(table.map((row) => row.id)).toEqual(['watch', 'watch-paper', 'addition:news', 'addition:why', 'addition:exit', 'addition:review', 'addition:daily', 'addition:article', 'addition:direction', 'bot:gpt', 'bot:review'])
    for (const row of table.filter((entry) => entry.on)) expect(row.asks, row.id).toEqual([MINI])
    expect(table.find((row) => row.id === 'addition:news')).toMatchObject({ follows: "the watch's paper-trade model", role: 'summarize', on: true })
    expect(table.find((row) => row.id === 'addition:exit')!.role).toBe('decide')
    // A free strategy asks nothing, an archived bot is gone; a reviewed strategy switched off asks the default when switched on.
    expect(table.find((row) => row.id === 'bot:review')).toMatchObject({ on: false, asks: [OPUS], follows: 'the default model' })
    // The additions that ask by themselves ask only while the watch is on; the article reading, asked on a click, whenever
    // it is switched on (V8 Stage 5), and it decides.
    expect(routingTableOf({ ...FOUND, watch: { ...FOUND.watch, enabled: false } }, BOTS).filter((row) => row.kind === 'addition').every((row) => !row.on)).toBe(true)
    const clicked = routingTableOf({ ...FOUND, watch: { ...FOUND.watch, enabled: false }, additions: { ...FOUND.additions, article: true } }, BOTS)
    expect(clicked.filter((row) => row.kind === 'addition' && row.on).map((row) => row.id)).toEqual(['addition:article'])
    expect(clicked.find((row) => row.id === 'addition:article')).toMatchObject({ role: 'decide', on: true, asks: [MINI] })
  })

  it('names what still asks each model, so that disabling one says what it would strand', () => {
    const used = modelsInUse(FOUND, BOTS)
    expect(used.get(MINI)).toEqual(['The watch', "The watch's paper trades", 'News analyst', '"Why did it move?" conclusion', 'Exit check', 'Reviewer', 'Daily summary', 'Bot GPT BTC hourly'])
    expect(used.has(OPUS)).toBe(false)
    // A watch switched off still lists its models (it heals off when one is disabled); a bot switched off strands nothing.
    expect(modelsInUse({ ...FOUND, watch: { ...FOUND.watch, enabled: false }, watchPaper: { ...FOUND.watchPaper, enabled: false } }, []).get(MINI)).toEqual(['The watch'])
  })
})

describe('an addition asked only on a click (V8 Stage 0)', () => {
  it('asks whenever it is switched on, whatever the watch, where one that asks by itself needs the watch on', () => {
    const off = { ...FOUND, watch: { ...FOUND.watch, enabled: false } }
    expect(additionAsksNow(FOUND, 'daily')).toBe(true)
    expect(additionAsksNow(off, 'daily')).toBe(false)
    expect(additionAsksNow({ ...FOUND, additions: { ...FOUND.additions, daily: false } }, 'daily')).toBe(false)
    const was = AI_ADDITION_INFO.daily.automatic
    try {
      AI_ADDITION_INFO.daily.automatic = false
      expect(additionAsksNow(off, 'daily')).toBe(true)
      expect(additionAsksNow({ ...off, additions: { ...off.additions, daily: false } }, 'daily')).toBe(false)
      expect(routingTableOf(off, []).find((row) => row.id === 'addition:daily')!.on).toBe(true)
    } finally {
      AI_ADDITION_INFO.daily.automatic = was
    }
  })
})

describe('a move to roles', () => {
  it('puts the watch, its paper trades, the additions and the running paid bot on the roles, every other term kept', () => {
    const plan = rolesPlanOf(FOUND, BOTS, CHOICE)
    expect(plan.defaultModel).toBe(OPUS)
    expect(plan.roles).toEqual({ gate: ARGON, summarize: LUNA })
    expect(plan.watch).toEqual({ ...FOUND.watch, models: [ARGON, OPUS], firstModelGates: true })
    expect(plan.watchPaper).toEqual({ ...FOUND.watchPaper, model: OPUS })
    expect(plan.bots).toEqual([{ id: 'gpt', name: 'GPT BTC hourly', from: MINI, to: OPUS }])
    const to = Object.fromEntries(plan.callers.map((row) => [row.id, row.to]))
    expect(to).toEqual({
      watch: [ARGON, OPUS],
      'watch-paper': [OPUS],
      'addition:news': [LUNA],
      'addition:why': [LUNA],
      'addition:exit': [OPUS],
      'addition:review': [OPUS],
      'addition:daily': [LUNA],
      'addition:article': [OPUS],
      'addition:direction': [OPUS],
      'bot:gpt': [OPUS],
      'bot:review': [OPUS]
    })
    // After it, nothing asks GPT-5 Mini.
    const after = { defaultModel: plan.defaultModel, watch: plan.watch, watchPaper: plan.watchPaper, additions: FOUND.additions, roles: plan.roles }
    expect(modelsInUse(after, BOTS.map((bot) => (bot.id === 'gpt' ? { ...bot, aiModel: OPUS } : bot))).has(MINI)).toBe(false)
  })

  it('takes a gate or a summarizer equal to the decider as none, and one model asks alone', () => {
    const plan = rolesPlanOf(FOUND, BOTS, { decide: OPUS, gate: OPUS, summarize: null })
    expect(plan.watch).toMatchObject({ models: [OPUS], firstModelGates: false })
    expect(plan.roles).toEqual({ gate: null, summarize: null })
    expect(rolesPlanOf(FOUND, BOTS, { decide: OPUS, gate: null, summarize: OPUS }).roles.summarize).toBeNull()
    // A bot already on the decider is not moved, nor a paid bot switched off (switching it on pins the default then).
    expect(rolesPlanOf(FOUND, [{ ...BOTS[0], aiModel: OPUS }], CHOICE).bots).toEqual([])
    expect(rolesPlanOf(FOUND, [{ ...BOTS[0], enabled: false }], CHOICE).bots).toEqual([])
  })

  it('refuses a role on a model not enabled, a panel, or no decider', () => {
    const enabled = [MINI, OPUS, ARGON, LUNA]
    expect(roleChoiceProblem(CHOICE, enabled)).toBeNull()
    expect(roleChoiceProblem({ ...CHOICE, gate: 'google/gemini-9' }, enabled)).toMatch(/is not enabled/)
    expect(roleChoiceProblem({ ...CHOICE, summarize: `panel:${OPUS}` }, enabled)).toMatch(/panel of agents/)
    expect(roleChoiceProblem({ ...CHOICE, decide: '' }, enabled)).toMatch(/model that decides/)
  })

  it('says each caller before and after, the bots kept as they were, and the totals with the budget', () => {
    const plan = rolesPlanOf(FOUND, BOTS, CHOICE)
    const text = routingPreviewText({
      plan,
      costs: plan.callers.map((row) => ({ id: row.id, label: row.label, models: row.to, perCallUsd: [0.03], basis: ['pricing'], callsADay: 2, mostCallsADay: 10, expectedUsd: 0.06, mostUsd: 0.3, on: row.on })),
      expectedDailyUsd: 1.02,
      mostDailyUsd: 4.5,
      capUsd: 5
    })
    expect(text).toContain(`The watch: ${MINI} -> ${ARGON} then ${OPUS}. About $0.0600 a day at its recent rate, at most $0.30.`)
    expect(text).toContain(`Bot GPT BTC hourly: ${MINI} -> ${OPUS}.`)
    expect(text).toContain(`Reviewed channel (off): ${OPUS}, as now.`)
    expect(text).toContain('keeps its earlier decisions as the model that made them')
    expect(text).toContain('Altogether about $1.02 a day at the recent rates, at most $4.50 a day at every limit. The daily AI budget of $5.00 still applies')
  })
})

describe('the additions by role', () => {
  it('follow the paper trades until roles are applied, then the summarizer or the decider', () => {
    expect(additionsModelOf(FOUND, 'news')).toBe(MINI)
    expect(additionsModelOf({ ...FOUND, watchPaper: { ...FOUND.watchPaper, model: null } }, 'exit')).toBe(MINI)
    expect(additionsModelOf({ ...FOUND, watchPaper: { ...FOUND.watchPaper, model: null }, watch: { ...FOUND.watch, models: [] } }, 'daily')).toBe(OPUS)
    const roles = { ...FOUND, roles: { gate: ARGON, summarize: LUNA } }
    expect(['news', 'why', 'daily'].map((kind) => additionsModelOf(roles, kind as 'news'))).toEqual([LUNA, LUNA, LUNA])
    expect(['exit', 'review'].map((kind) => additionsModelOf(roles, kind as 'exit'))).toEqual([OPUS, OPUS])
    expect(additionsModelOf({ ...FOUND, roles: { gate: null, summarize: null } }, 'news')).toBe(OPUS)
  })

  it('heals stored roles: a model no longer enabled, a panel, or nothing at all is no role', () => {
    expect(healAiRoles({ gate: ARGON, summarize: LUNA }, [ARGON, LUNA])).toEqual({ gate: ARGON, summarize: LUNA })
    expect(healAiRoles({ gate: ARGON, summarize: LUNA }, [ARGON])).toEqual({ gate: ARGON, summarize: null })
    expect(healAiRoles({ gate: `panel:${OPUS}`, summarize: 7 }, [OPUS])).toEqual({ gate: null, summarize: null })
    expect(healAiRoles(undefined, [OPUS])).toBeNull()
    expect(healAiRoles([ARGON], [ARGON])).toBeNull()
  })
})

describe('the model that answered', () => {
  it('is the model asked under its own name or a dated one, a variant of the same provider, or another provider', () => {
    expect(servedFamilyOf(MINI, 'openai/gpt-5-mini')).toBe('same')
    expect(servedFamilyOf(MINI, 'openai/gpt-5-mini-2025-08-07')).toBe('same')
    expect(servedFamilyOf(`${MINI}@low`, 'openai/gpt-5-mini-20250807')).toBe('same')
    expect(servedFamilyOf(OPUS, 'anthropic/claude-opus-5.5-latest')).toBe('same')
    expect(servedFamilyOf('openai/gpt-5', 'openai/gpt-5-mini-2025-08-07')).toBe('variant')
    expect(servedFamilyOf(OPUS, 'anthropic/claude-sonnet-5.5')).toBe('variant')
    expect(servedFamilyOf(OPUS, 'openai/gpt-6-luna')).toBe('other')
    expect(servedFamilyOf(OPUS, 'claude-opus-5.5-20261001')).toBe('same')
    expect(servedFamilyOf(OPUS, 'gpt-6-luna')).toBe('variant')
    expect(servedFamilyOf(OPUS, null)).toBe('unknown')
    expect(servedFamilyOf(OPUS, '  ')).toBe('unknown')
  })
})

describe('a bot moved', () => {
  it('keeps the model pinned at each earlier bar, and asks the new one only from the move on', () => {
    const history = [{ model: MINI, untilSec: 2_000 }]
    expect(tapeModelAt(history, OPUS, 1_999)).toBe(MINI)
    expect(tapeModelAt(history, OPUS, 2_000)).toBe(OPUS)
    expect(tapeModelAt(undefined, OPUS, 10)).toBe(OPUS)
    // Two moves, the history in either order.
    const twice = [
      { model: LUNA, untilSec: 5_000 },
      { model: MINI, untilSec: 2_000 }
    ]
    expect([1_000, 2_000, 4_999, 5_000].map((t) => tapeModelAt(twice, OPUS, t))).toEqual([MINI, LUNA, LUNA, OPUS])
    expect(readModelHistory(twice)).toEqual([...twice].reverse())
    expect(readModelHistory([{ model: MINI }])).toBeUndefined()
    expect(readModelHistory('x')).toBeUndefined()
  })

  it('records the model it had when it moves, the default where it had no pin, and nothing when it does not move', () => {
    const moved = repinBot({ ...BOTS[0] }, OPUS, OPUS, 3_000)
    expect(moved).toMatchObject({ aiModel: OPUS, aiModelHistory: [{ model: MINI, untilSec: 3_000 }] })
    expect(repinBot({ ...moved }, LUNA, OPUS, 4_000).aiModelHistory).toEqual([
      { model: MINI, untilSec: 3_000 },
      { model: OPUS, untilSec: 4_000 }
    ])
    expect(repinBot({ id: 'x', name: 'x', enabled: true, strategyId: 'gpt-intraday' }, OPUS, MINI, 5_000).aiModelHistory).toEqual([{ model: MINI, untilSec: 5_000 }])
    const same = { ...BOTS[0], aiModel: OPUS }
    expect(repinBot(same, OPUS, MINI, 6_000)).toBe(same)
  })

  it('buys the bars it missed only within the catch-up window', () => {
    expect(BOT_CATCHUP_HOURS).toBe(2)
    expect(botAskFromSec(100_000)).toBe(100_000 - 7_200)
  })
})

describe('the price of a call', () => {
  it('reads the median tokens of answered calls and prices them by the catalogue', () => {
    const rows = [
      { status: 'ok', usage: { promptTokens: 3000, completionTokens: 1000 } },
      { status: 'ok', usage: { promptTokens: 5000, completionTokens: 2000 } },
      { status: 'failed', usage: { promptTokens: 0, completionTokens: 0 } },
      { status: 'rejected', usage: { promptTokens: 4000, completionTokens: 1500 } }
    ]
    expect(medianTokensOf(rows)).toEqual({ prompt: 4000, completion: 1500 })
    expect(medianTokensOf([])).toBeNull()
    expect(priceOfCall({ promptPricePerToken: 4e-6, completionPricePerToken: 2e-5 }, { prompt: 4000, completion: 1500 })).toBeCloseTo(0.046, 10)
    expect(priceOfCall({ promptPricePerToken: null, completionPricePerToken: 2e-5 }, { prompt: 1, completion: 1 })).toBeNull()
    expect(priceOfCall(null, { prompt: 1, completion: 1 })).toBeNull()
  })
})
