import { AI_ADDITION_INFO, AI_ADDITION_KINDS, AI_ADDITION_ROLES, additionsModelOf, type AiAdditionKind } from './aiAdditions'
import type { AiConfig, AiRoles } from './aiCost'
import { aiModelSlugOf } from './aiEffort'
import { isPanelId } from './aiPanel'
import { GPT_INTRADAY_STRATEGY_ID } from './aiSignal'
import type { AiWatchConfig } from './aiWatch'
import type { AiWatchPaperConfig } from './aiWatchPaper'

// WHO ASKS WHICH MODEL (V7.2-R Stage 1, 20 October 2026).
//
// Until now the model chosen as the default under Settings › AI reached only what a person starts: a
// backtest, the chart, a bot being switched on. Everything that asks by itself kept the model it was
// switched on with, by design, because a model is part of what it is and of what it was agreed to
// cost: the watch its own list, its paper trades one model of that list, the AI additions the model
// the paper trades follow, and every paid bot the model it was pinned to. On 20 October 2026 the
// user's default was Claude Opus 5.5 and every one of 367 calls since 16 October had gone to GPT-5
// Mini, which nothing on the page said and nothing could change short of switching four things off
// and on again.
//
// ROLES make the choice one decision. The user picks three models: DECIDE (the default model: the
// watch's deciding model, the model its paper trades follow, every paid bot, the entry review and the
// exit check), GATE (the watch's first look at each event, the decider asked only when it sees a
// trade) and SUMMARIZE (the additions that read or write and judge no trade: the news analyst, the
// "why did it move?" conclusion, the daily summary). One move, confirmed once at its stated price,
// sets every caller: rolesPlanOf says what changes. A bot moved keeps its earlier decisions as the
// model that made them; only the bars from the move on are asked of the new model (tapeModelAt).
//
// Until roles are applied nothing changes: every caller asks what it asked before.

export const AI_ROUTING_VERSION = 'ai-routing-v1'

export const AI_ROLES = ['decide', 'gate', 'summarize'] as const
export type AiRole = (typeof AI_ROLES)[number]

/** After the app was closed, how far back a paid bot's dry run buys the decisions it missed: the
 * user's choice of 20 October 2026. Older missed bars are gaps, held as they stood, not purchases (on
 * 16 October a restart bought 275 answers about candles up to eleven days old). */
export const BOT_CATCHUP_HOURS = 2

/** The three models a move to roles sets: `decide` becomes the default model. */
export interface RoleChoice {
  decide: string
  gate: string | null
  summarize: string | null
}

/** Stored roles, healed: a model no longer enabled, or a panel, is no role. Null where none was applied. */
export function healAiRoles(value: unknown, enabledModels: readonly string[]): AiRoles | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const pick = (entry: unknown): string | null => (typeof entry === 'string' && enabledModels.includes(entry) && !isPanelId(entry) ? entry : null)
  return { gate: pick(raw.gate), summarize: pick(raw.summarize) }
}

/** Why a choice of roles cannot be applied, or null when it can. Every role's model must be enabled
 * and be a model, never a panel. */
export function roleChoiceProblem(choice: RoleChoice, enabledModels: readonly string[]): string | null {
  if (typeof choice !== 'object' || choice === null) return 'Choose a model for each role.'
  if (typeof choice.decide !== 'string' || choice.decide.trim() === '') return 'Choose the model that decides.'
  for (const [role, model] of [
    ['decide', choice.decide],
    ['gate', choice.gate],
    ['summarize', choice.summarize]
  ] as const) {
    if (model === null) continue
    if (typeof model !== 'string') return `The ${role} role names no model.`
    if (isPanelId(model)) return `A panel of agents cannot take the ${role} role: it runs on a model, and is chosen where it is used.`
    if (!enabledModels.includes(model)) return `${model} is not enabled. Enable it above before giving it a role.`
  }
  return null
}

/** A bot as routing reads it (shared/ipc.ts Bot). */
export interface RoutedBot {
  id: string
  name: string
  enabled: boolean
  archived?: boolean
  strategyId: string
  aiModel?: string
  aiConfirm?: boolean
}

/** Whether a bot asks a model at all: GPT Intraday decides with one, a reviewed strategy has one
 * confirm its entries. */
export const paidBot = (bot: Pick<RoutedBot, 'strategyId' | 'aiConfirm'>): boolean => bot.strategyId === GPT_INTRADAY_STRATEGY_ID || bot.aiConfirm === true

export type CallerKind = 'watch' | 'watch-paper' | 'addition' | 'bot'

/** One caller that asks a model by itself, and what it asks now. */
export interface RoutedCaller {
  /** `watch`, `watch-paper`, `addition:<kind>`, `bot:<id>`. */
  id: string
  kind: CallerKind
  label: string
  /** The models it asks now, in order (the watch's list; one model for the rest). */
  asks: string[]
  /** Whether it is asking by itself now: the watch or its paper trades on, an addition on with the
   * watch on, a bot switched on. */
  on: boolean
  /** Where the model it asks comes from. */
  follows: 'its own list' | 'one of the watch\'s models' | 'its role' | 'the watch\'s paper-trade model' | 'its pin' | 'the default model'
  /** The role it plays once roles are applied. */
  role: AiRole
}

type RoutingConfig = Pick<AiConfig, 'defaultModel' | 'watch' | 'watchPaper' | 'additions' | 'roles'>

/** Whether an addition can be asked now (V8 Stage 0): switched on, and, for one that asks by itself, with the
 * watch on; one asked only on a click is on whenever it is switched on, whatever the watch. */
export function additionAsksNow(config: Pick<AiConfig, 'additions' | 'watch'>, kind: AiAdditionKind): boolean {
  return config.additions[kind] && (config.watch.enabled || !AI_ADDITION_INFO[kind].automatic)
}

/** Every caller that asks a model by itself, with the model it asks now. */
export function routingTableOf(config: RoutingConfig, bots: readonly RoutedBot[]): RoutedCaller[] {
  const rows: RoutedCaller[] = []
  const rolesSet = config.roles !== null && config.roles !== undefined
  rows.push({ id: 'watch', kind: 'watch', label: 'The watch', asks: [...config.watch.models], on: config.watch.enabled, follows: 'its own list', role: 'decide' })
  rows.push({
    id: 'watch-paper',
    kind: 'watch-paper',
    label: "The watch's paper trades",
    asks: config.watchPaper.model === null ? [] : [config.watchPaper.model],
    on: config.watchPaper.enabled,
    follows: "one of the watch's models",
    role: 'decide'
  })
  for (const kind of AI_ADDITION_KINDS) {
    rows.push({
      id: `addition:${kind}`,
      kind: 'addition',
      label: AI_ADDITION_INFO[kind].name,
      asks: [additionsModelOf(config, kind)],
      on: additionAsksNow(config, kind),
      follows: rolesSet ? 'its role' : "the watch's paper-trade model",
      role: AI_ADDITION_ROLES[kind]
    })
  }
  for (const bot of bots) {
    if (bot.archived === true || !paidBot(bot)) continue
    rows.push({
      id: `bot:${bot.id}`,
      kind: 'bot',
      label: `Bot ${bot.name}`,
      asks: [bot.aiModel ?? config.defaultModel],
      on: bot.enabled,
      follows: bot.aiModel === undefined ? 'the default model' : 'its pin',
      role: 'decide'
    })
  }
  return rows
}

/** The model a role names under a choice: the gate and the summaries fall back to the decider. */
export function roleModelOf(choice: RoleChoice, role: AiRole): string {
  if (role === 'gate') return choice.gate ?? choice.decide
  if (role === 'summarize') return choice.summarize ?? choice.decide
  return choice.decide
}

/** What a move to roles changes: the default model, the roles stored, the watch's list and gate, the
 * model its paper trades follow, and every running paid bot re-pinned. Every other term of the watch
 * and of its paper trades -- on or off, the limit, the band, the stake, the caps -- is kept. */
export interface RolesPlan {
  version: string
  choice: RoleChoice
  defaultModel: string
  roles: AiRoles
  watch: AiWatchConfig
  watchPaper: AiWatchPaperConfig
  /** Running paid bots asking another model: moved to the decider from now on. */
  bots: { id: string; name: string; from: string; to: string }[]
  /** Each caller's model before and after, for the confirmation. */
  callers: { id: string; label: string; on: boolean; from: string[]; to: string[] }[]
}

export function rolesPlanOf(config: RoutingConfig, bots: readonly RoutedBot[], choice: RoleChoice): RolesPlan {
  const gate = choice.gate !== null && choice.gate !== choice.decide ? choice.gate : null
  const watchModels = gate === null ? [choice.decide] : [gate, choice.decide]
  const watch: AiWatchConfig = { ...config.watch, models: watchModels, firstModelGates: watchModels.length > 1 }
  const watchPaper: AiWatchPaperConfig = { ...config.watchPaper, model: choice.decide }
  const roles: AiRoles = { gate, summarize: choice.summarize !== null && choice.summarize !== choice.decide ? choice.summarize : null }
  const after: RoutingConfig = { defaultModel: choice.decide, watch, watchPaper, additions: config.additions, roles }
  const before = routingTableOf(config, bots)
  const moved = new Map(bots.filter((bot) => bot.enabled && bot.archived !== true && paidBot(bot)).map((bot) => [bot.id, bot]))
  const afterBots = bots.map((bot) => (moved.has(bot.id) ? { ...bot, aiModel: choice.decide } : bot))
  const next = new Map(routingTableOf(after, afterBots).map((row) => [row.id, row]))
  const callers = before.map((row) => ({ id: row.id, label: row.label, on: row.on, from: row.asks, to: next.get(row.id)?.asks ?? row.asks }))
  return {
    version: AI_ROUTING_VERSION,
    choice: { decide: choice.decide, gate, summarize: roles.summarize },
    defaultModel: choice.decide,
    roles,
    watch,
    watchPaper,
    bots: [...moved.values()].map((bot) => ({ id: bot.id, name: bot.name, from: bot.aiModel ?? config.defaultModel, to: choice.decide })).filter((entry) => entry.from !== entry.to),
    callers
  }
}

/** Every model something asks by itself, with what asks it: what disabling the model would strand. */
export function modelsInUse(config: RoutingConfig, bots: readonly RoutedBot[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (model: string, label: string): void => {
    const held = out.get(model)
    if (held === undefined) out.set(model, [label])
    else if (!held.includes(label)) held.push(label)
  }
  for (const row of routingTableOf(config, bots)) {
    // A caller switched off strands nothing: the watch heals off, a bot re-pins when switched on.
    if (!row.on && row.kind !== 'watch') continue
    for (const model of row.asks) add(model, row.label)
  }
  return out
}

/** What the model that answered says about the model asked: the same (its name, or its name with a
 * dated version after it), a variant (the same provider, another name: shown, accepted), another
 * provider's (refused: OpenRouter never legitimately serves one model under another's id), or unknown
 * (no name came back). */
export function servedFamilyOf(asked: string, served: string | null | undefined): 'same' | 'variant' | 'other' | 'unknown' {
  if (served === null || served === undefined || served.trim() === '') return 'unknown'
  const slug = aiModelSlugOf(asked).toLowerCase()
  const name = served.trim().toLowerCase()
  if (name === slug) return 'same'
  if (name.startsWith(`${slug}-`) && /^-(\d{4}-?\d{2}-?\d{2}|\d{4}|v\d+(\.\d+)*|latest|preview)$/.test(name.slice(slug.length))) return 'same'
  const provider = (id: string): string => (id.includes('/') ? id.slice(0, id.indexOf('/')) : '')
  // A served name without a provider (some providers answer with the bare model name) is read by its name.
  if (!name.includes('/')) return slug.endsWith(`/${name}`) || name.startsWith(slug.slice(slug.indexOf('/') + 1)) ? 'same' : 'variant'
  return provider(name) === provider(slug) ? 'variant' : 'other'
}

/** The models a bot was pinned to before its current one, each with when it stopped (Unix seconds),
 * oldest first (shared/ipc.ts Bot.aiModelHistory). */
export type ModelHistory = readonly { model: string; untilSec: number }[]

/** The model that was pinned at `tSec`: the first earlier pin still in force then, else the current. */
export function tapeModelAt(history: ModelHistory | undefined, current: string, tSec: number): string {
  if (history === undefined) return current
  for (const entry of [...history].sort((a, b) => a.untilSec - b.untilSec)) if (tSec < entry.untilSec) return entry.model
  return current
}

/** Whether a stored history reads as one: models named, times rising. */
export function readModelHistory(value: unknown): { model: string; untilSec: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: { model: string; untilSec: number }[] = []
  for (const entry of value) {
    const raw = entry as { model?: unknown; untilSec?: unknown } | null
    if (typeof raw !== 'object' || raw === null || typeof raw.model !== 'string' || typeof raw.untilSec !== 'number' || !Number.isFinite(raw.untilSec)) return undefined
    out.push({ model: raw.model, untilSec: raw.untilSec })
  }
  return out.sort((a, b) => a.untilSec - b.untilSec)
}

/** A running bot moved to `model` from `nowSec` on: its earlier decisions stay those of the model it had. */
export function repinBot<T extends RoutedBot & { aiModelHistory?: { model: string; untilSec: number }[] }>(bot: T, model: string, defaultModel: string, nowSec: number): T {
  const from = bot.aiModel ?? defaultModel
  if (from === model) return bot
  return { ...bot, aiModel: model, aiModelHistory: [...(bot.aiModelHistory ?? []), { model: from, untilSec: nowSec }] }
}

/** The first bar a paid bot's dry run may buy now: BOT_CATCHUP_HOURS back. */
export const botAskFromSec = (nowSec: number): number => nowSec - BOT_CATCHUP_HOURS * 3600

/** Which additions follow which model under roles, in one line each, for the page. */
export function additionsByRole(config: RoutingConfig): { kind: AiAdditionKind; model: string; role: AiRole }[] {
  return AI_ADDITION_KINDS.map((kind) => ({ kind, model: additionsModelOf(config, kind), role: AI_ADDITION_ROLES[kind] }))
}

// WHAT A MOVE TO ROLES COSTS, said before it is made. Each caller's call is priced from that model's own
// calls under the caller's question where it has some, else from the price list at the token counts the
// caller's question has taken here (any model's), and counted at the caller's recent calls a day and at
// the most its limits allow. The watch and the additions are capped by their own daily limits, and
// everything by the daily AI budget, which the move does not change.

/** A model's price per token, as the catalogue gives it (shared/aiCost.ts AiModelInfo). */
export interface TokenPrice {
  promptPricePerToken: number | null
  completionPricePerToken: number | null
}

/** One call's cost from a price and the tokens a call takes; null without both. */
export function priceOfCall(price: TokenPrice | null, tokens: { prompt: number; completion: number } | null): number | null {
  if (price === null || tokens === null || price.promptPricePerToken === null || price.completionPricePerToken === null) return null
  return tokens.prompt * price.promptPricePerToken + tokens.completion * price.completionPricePerToken
}

/** The median token counts of answered calls, or null without one. */
export function medianTokensOf(rows: readonly { status: string; usage: { promptTokens: number; completionTokens: number } }[]): { prompt: number; completion: number } | null {
  const answered = rows.filter((row) => row.status !== 'failed' && row.usage.promptTokens > 0)
  if (answered.length === 0) return null
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = sorted.length >> 1
    return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }
  return { prompt: median(answered.map((row) => row.usage.promptTokens)), completion: median(answered.map((row) => row.usage.completionTokens)) }
}

/** What one caller would cost after the move. */
export interface RoutingCost {
  id: string
  label: string
  /** The models it would ask, in order. */
  models: string[]
  /** One call of each model, in that order. */
  perCallUsd: (number | null)[]
  basis: ('history' | 'pricing' | 'unknown')[]
  /** Calls a day at its recent rate, and at the most its limit allows (null: no limit of its own). */
  callsADay: number
  mostCallsADay: number | null
  expectedUsd: number | null
  mostUsd: number | null
  on: boolean
}

export interface RoutingPreview {
  plan: RolesPlan
  costs: RoutingCost[]
  /** Every caller that would be on, at its recent rate, and at its limits; null where a price is unknown. */
  expectedDailyUsd: number | null
  mostDailyUsd: number | null
  capUsd: number
  /** What the move is applied with: the same plan and prices, or the move is refused. */
  token: string
  /** The confirmation, in sentences. */
  text: string
}

const usd = (value: number | null): string => (value === null ? 'an unknown amount' : value < 0.1 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`)

/** The confirmation of a move: what each caller asks after it, and what that costs. */
export function routingPreviewText(preview: Omit<RoutingPreview, 'text' | 'token'>): string {
  const { plan } = preview
  const lines: string[] = [`Move every caller to these models? ${plan.choice.decide} decides${plan.choice.gate === null ? '' : `, ${plan.choice.gate} takes the watch's first look`}${plan.choice.summarize === null ? '' : `, ${plan.choice.summarize} writes the summaries`}.`, '']
  for (const caller of plan.callers) {
    const before = caller.from.join(' then ') || 'nothing'
    const after = caller.to.join(' then ') || 'nothing'
    const cost = preview.costs.find((entry) => entry.id === caller.id)
    const price = cost === undefined || !caller.on ? '' : ` About ${usd(cost.expectedUsd)} a day at its recent rate${cost.mostUsd === null ? '' : `, at most ${usd(cost.mostUsd)}`}.`
    lines.push(`${caller.label}${caller.on ? '' : ' (off)'}: ${before === after ? `${after}, as now.` : `${before} -> ${after}.`}${price}`)
  }
  if (plan.bots.length > 0) lines.push('', `${plan.bots.length === 1 ? 'The running bot keeps' : 'Each running bot keeps'} its earlier decisions as the model that made them; only bars from now on are asked of ${plan.choice.decide}.`)
  lines.push(
    '',
    `Altogether about ${usd(preview.expectedDailyUsd)} a day at the recent rates, at most ${usd(preview.mostDailyUsd)} a day at every limit. The daily AI budget of ${usd(preview.capUsd)} still applies to everything.`,
    'The watch and its paper trades stay on or off as they are, with their limits, stake and caps. Nothing real is placed.'
  )
  return lines.join('\n')
}
