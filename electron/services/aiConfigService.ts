import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { AI_ADDITION_DAILY_LIMITS, AI_ADDITION_KINDS, AI_ADDITION_PROMPT_VERSIONS, DEFAULT_AI_ADDITIONS, healAiAdditions, type AiAdditionsConfig } from '../../shared/aiAdditions'
import { DEFAULT_AI_DAILY_CAP_USD, DEFAULT_AI_MODEL, DEFAULT_ENABLED_MODELS, GPT_INTRADAY_STRATEGY_ID, GPT_PROMPT_VERSION } from '../../shared/aiSignal'
import {
  healAiRoles,
  medianTokensOf,
  modelsInUse,
  paidBot,
  priceOfCall,
  repinBot,
  roleChoiceProblem,
  rolesPlanOf,
  routingPreviewText,
  type RoleChoice,
  type RoutedBot,
  type RoutingCost,
  type RoutingPreview
} from '../../shared/aiRouting'
import type { AiCallRecord } from '../../shared/aiLedger'
import type { Bot } from '../../shared/ipc'
import { aiModelSlugOf, isAiModelId, splitAiModelId } from '../../shared/aiEffort'
import { deciderModel, isPanelId, panelModelOf } from '../../shared/aiPanel'
import { parseAiRoute, type AiRoute } from '../../shared/aiRoute'
import { aiWatchProblem, healAiWatch, sameWatchTerms, type AiWatchConfig } from '../../shared/aiWatch'
import { DEFAULT_AI_WATCH_PAPER, aiWatchPaperProblem, healAiWatchPaper, type AiWatchPaperConfig } from '../../shared/aiWatchPaper'
import { AI_CALLS_PER_MINUTE_CHOICES, DEFAULT_AI_CALLS_PER_MINUTE, isCallsPerMinute } from '../../shared/aiPace'
import { budgetProblem, type AiConfig, type AiConfigPatch, type AiModelCatalogue, type AiModelInfo, type AiRoles } from '../../shared/aiCost'
import { writeJsonAtomic } from './atomicWrite'
import { stampedConfig } from '../../shared/configMigration'
import { HARD_LIMITS, hardLimitProblem } from '../../shared/hardLimits'
import { readConfigFile } from './configFiles'
import { getDecryptedAiCredential } from './aiCredentialsService'
import { nextDailyUsage, usageForDay, utcDayKey, type DailyUsageBucket } from './dailyUsage'
import { listAiCalls } from './aiLedgerService'
import { fetchModelCatalogue } from './openRouterClient'
import { getSettings, setSettings } from './settingsService'

// Which model is asked, and how much may be spent asking.
//
// Its own file, owned by the main process, for the reason liveTrading.json is: the daily budget is
// a limit on real money, and a limit the renderer could rewrite through a general settings patch
// is a limit in name only. Everything here is changed through setAiConfig, which validates, and is
// enforced in assertAiBudget, which runs immediately before every paid request.

interface AiConfigState {
  defaultModel: string
  enabledModels: string[]
  /** See AiConfig.route. Its second model is always an enabled one, and never the default. */
  route: AiRoute | null
  dailyCapUsd: number
  /** Reuses the live-trading cap's bucket (dailyUsage.ts), so `usedQuote` here is US dollars
   * spent on AI calls today. Same arithmetic, same UTC day boundary, one tested implementation. */
  dailyUsage: DailyUsageBucket | null
  /** See AiConfig.watch. It is here, in the file the renderer cannot write wholesale, for the
   * reason the budget is: it is the one setting that lets a model be asked with nobody pressing
   * anything, and it changes only through setAiConfig. */
  watch: AiWatchConfig
  /** See AiConfig.watchPaper. Here for the same reason: it is the one setting that lets a position
   * be opened with nobody pressing anything, and though the position is paper, what switches it
   * on should not be a general settings patch. */
  watchPaper: AiWatchPaperConfig
  /** See AiConfig.callsPerMinute. */
  callsPerMinute: number
  /** See AiConfig.additions. Here, not in settings.json, for the reason the watch is: each lets a
   * model be asked, and is changed only through setAiConfig. */
  additions: AiAdditionsConfig
  /** See AiConfig.roles (V7.2-R Stage 1). Set only by applyAiRoles, after its confirmation. */
  roles: AiRoles | null
}

interface StoredCatalogue {
  fetchedAt: number
  models: AiModelInfo[]
}

/** A price list a day old is still a price list. Refreshed on demand from the models list under Settings › AI. */
const CATALOGUE_MAX_AGE_SEC = 24 * 60 * 60

let cache: AiConfigState | null = null
let catalogue: StoredCatalogue | null | undefined

/** Thrown when the daily budget stops a call. A distinct class so a run can tell "stop, and say
 * why" from a failed request that is worth carrying on past.
 *
 * `name` is deliberately left as 'Error'. Electron serialises a rejected IPC call as
 * "<name>: <message>", and the renderer strips only the standard "Error: " prefix, so a custom
 * name was printed to the user: "AiBudgetError: AI calls are switched off". The class is told
 * apart with instanceof, which never needed the name. */
export class AiBudgetError extends Error {
  /** The cap and the day's spend it was refused on, so a notice can say it in the person's language
   * (V6 Stage 14). */
  constructor(
    message: string,
    readonly capUsd: number = 0,
    readonly spentUsd: number = 0
  ) {
    super(message)
  }
}

function configPath(): string {
  return join(app.getPath('userData'), 'aiConfig.json')
}

function cataloguePath(): string {
  return join(app.getPath('userData'), 'aiModels.json')
}

function today(): string {
  return utcDayKey(Math.floor(Date.now() / 1000))
}

/** A panel of agents is never in this list: it is not a model, and enabling the model it runs on
 * is the permission it needs (shared/aiPanel.ts). */
function cleanModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && isAiModelId(entry) && !isPanelId(entry)))]
}

/** Why a route could not run under these settings, or null when it could. Its second step is a
 * model that is enabled, or a panel on one, and is never the default itself. */
function routeProblem(route: AiRoute, defaultModel: string, enabledModels: string[]): 'same' | 'malformed' | 'disabled' | null {
  if (route.model === defaultModel) return 'same'
  if (isPanelId(route.model) && panelModelOf(route.model) === null) return 'malformed'
  return enabledModels.includes(deciderModel(route.model)) ? null : 'disabled'
}

async function load(): Promise<AiConfigState> {
  if (cache) return cache
  // Read once, through the migration steps it is behind (configFiles.ts).
  const raw = (await readConfigFile('aiConfig')) as Partial<AiConfigState>
  // Heals a file holding something unusable rather than letting it through to the gate, the same
  // way liveTradingService does: a cap of NaN compares false against everything and would stop
  // nothing. A cap over the hard limit (shared/hardLimits.ts) is held to it.
  // Never a panel: "the default" is asked by things that were promised one call a question.
  const defaultModel =
    typeof raw.defaultModel === 'string' && isAiModelId(raw.defaultModel) && !isPanelId(raw.defaultModel) ? raw.defaultModel : DEFAULT_AI_MODEL
  // A fresh install enables the default three (shared/aiSignal.ts DEFAULT_ENABLED_MODELS); a file
  // that named models keeps exactly those, the default model among them.
  const enabledModels = raw.enabledModels === undefined ? [...DEFAULT_ENABLED_MODELS] : cleanModels(raw.enabledModels)
  if (!enabledModels.includes(defaultModel)) enabledModels.unshift(defaultModel)
  // A route that could not run -- unreadable, pointing at a model that is not enabled, or at the
  // default itself -- is dropped rather than carried. A setting that cannot run must not read as
  // switched on, and dropping it only ever makes a run cheaper.
  let route: AiRoute | null = null
  try {
    route = parseAiRoute(raw.route)
  } catch {
    route = null
  }
  if (route && routeProblem(route, defaultModel, enabledModels) !== null) route = null
  const cap = raw.dailyCapUsd
  const usage = raw.dailyUsage
  cache = {
    defaultModel,
    enabledModels,
    route,
    dailyCapUsd: typeof cap === 'number' && Number.isFinite(cap) && cap >= 0 ? Math.min(cap, HARD_LIMITS.aiDailyCapUsdMax) : DEFAULT_AI_DAILY_CAP_USD,
    dailyUsage:
      usage && typeof usage.date === 'string' && typeof usage.usedQuote === 'number' && Number.isFinite(usage.usedQuote)
        ? { date: usage.date, usedQuote: usage.usedQuote }
        : null,
    // Healed like the rest, and strictly: a stored watch that is not exactly one that could have
    // been switched on -- a model no longer enabled, a limit that is not one of the choices -- is
    // off, not running in some repaired shape nobody agreed to the price of.
    watch: healAiWatch(raw.watch, enabledModels),
    watchPaper: DEFAULT_AI_WATCH_PAPER,
    callsPerMinute: isCallsPerMinute(raw.callsPerMinute) ? raw.callsPerMinute : DEFAULT_AI_CALLS_PER_MINUTE,
    // On unless switched off: the user chose them on (6 October 2026), within the daily budget.
    additions: raw.additions === undefined ? { ...DEFAULT_AI_ADDITIONS } : healAiAdditions(raw.additions),
    // Healed like the watch: a role whose model is no longer enabled is no role, and its callers ask the decider.
    roles: healAiRoles(raw.roles, enabledModels)
  }
  // Healed against the watch as it was just healed: paper trades follow one of ITS models.
  cache.watchPaper = healAiWatchPaper(raw.watchPaper, cache.watch.models)
  return cache
}

async function persist(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(configPath(), cache === null ? cache : stampedConfig(cache))
}

async function loadCatalogue(): Promise<StoredCatalogue | null> {
  if (catalogue !== undefined) return catalogue
  try {
    const raw = JSON.parse(await readFile(cataloguePath(), 'utf-8')) as Partial<StoredCatalogue> | null
    if (raw !== null && typeof raw.fetchedAt === 'number' && Array.isArray(raw.models)) {
      // A list stored before models carried `reasoning` cannot say which of them take an effort.
      // Its prices are still good, so it is kept, but dated to the epoch so the next free listing
      // replaces it instead of waiting out the day.
      const dated = raw.models.every((model) => typeof model.reasoning === 'boolean')
      catalogue = {
        fetchedAt: dated ? raw.fetchedAt : 0,
        models: raw.models.map((model) => ({ ...model, reasoning: model.reasoning === true }))
      }
    } else {
      catalogue = null
    }
  } catch {
    catalogue = null
  }
  return catalogue
}

function statusFor(state: AiConfigState): AiConfig {
  return {
    defaultModel: state.defaultModel,
    enabledModels: [...state.enabledModels],
    route: state.route ? { ...state.route } : null,
    dailyCapUsd: state.dailyCapUsd,
    spentTodayUsd: usageForDay(state.dailyUsage, today()),
    watch: { ...state.watch, models: [...state.watch.models] },
    watchPaper: { ...state.watchPaper },
    callsPerMinute: state.callsPerMinute,
    additions: { ...state.additions },
    roles: state.roles === null ? null : { ...state.roles }
  }
}

export async function getAiConfig(): Promise<AiConfig> {
  return statusFor(await load())
}

/** Checks a model against the catalogue when one is held. Without a catalogue (no key yet, or
 * never online) only the id's shape can be checked, which is why the request itself still goes
 * out with `require_parameters`: OpenRouter refuses what this could not rule out. */
function assertUsableModel(id: string, known: StoredCatalogue | null): void {
  if (!isAiModelId(id)) throw new Error(`"${id}" is not a valid model id`)
  if (isPanelId(id)) {
    throw new Error(
      'A panel of agents cannot be enabled or made the default. It runs on a model that is enabled, and is chosen where it is used: Analyze, a benchmark, or the second step of a route.'
    )
  }
  if (!known) return
  // The catalogue lists the model; the effort it is asked at is this app's own (shared/aiEffort.ts).
  const { slug, effort } = splitAiModelId(id)
  const model = known.models.find((entry) => entry.id === slug)
  if (!model) throw new Error(`${slug} is not in the model catalogue. Refresh the list under Settings › AI.`)
  if (!model.structuredOutputs) {
    throw new Error(`${slug} cannot be held to a strict JSON schema, so it cannot be enabled for signals.`)
  }
  if (effort !== null && !model.reasoning) {
    throw new Error(`${slug} does not take a reasoning effort, so it cannot be asked at ${effort} effort.`)
  }
}

export async function setAiConfig(patch: AiConfigPatch): Promise<AiConfig> {
  const state = await load()
  const known = await loadCatalogue()

  let enabledModels = state.enabledModels
  if (patch.enabledModels !== undefined) {
    enabledModels = [...new Set(patch.enabledModels)]
    // Only what is being ADDED is checked. A model enabled yesterday and dropped from the
    // catalogue today must still be removable, and re-validating it would block every save.
    for (const id of enabledModels) if (!state.enabledModels.includes(id)) assertUsableModel(id, known)
  }

  let defaultModel = state.defaultModel
  if (patch.defaultModel !== undefined) {
    assertUsableModel(patch.defaultModel, known)
    defaultModel = patch.defaultModel
  }
  // The default is always enabled. Otherwise disabling it would leave every run that names no
  // model pointing at one the user had just switched off.
  if (!enabledModels.includes(defaultModel)) enabledModels = [defaultModel, ...enabledModels]
  // A role's model, like the watch's, is not quietly dropped: its callers would move to the decider, at its
  // price, with nothing having said so (V7.2-R Stage 1).
  for (const [role, model] of [
    ['first look', state.roles?.gate ?? null],
    ['summaries', state.roles?.summarize ?? null]
  ] as const) {
    if (model !== null && !enabledModels.includes(model)) {
      throw new Error(`${model} takes the watch's ${role} under "Who asks which model". Choose another model for it there before disabling this one.`)
    }
  }

  let route = state.route
  if (patch.route !== undefined) {
    route = parseAiRoute(patch.route)
    const problem = route ? routeProblem(route, defaultModel, enabledModels) : null
    if (route && problem === 'same') {
      throw new Error(`A route needs two different models, and ${route.model} is already the default.`)
    }
    if (route && problem === 'malformed') {
      throw new Error(`"${route.model}" does not name a panel of agents on a model.`)
    }
    if (route && problem === 'disabled') {
      throw new Error(`${deciderModel(route.model)} is not enabled. Enable it under Settings › AI before routing to it.`)
    }
  } else if (route) {
    // A change that would strand the route is refused rather than quietly repaired. Dropping the
    // route to make the save go through would change what the next run asks, and costs, without
    // anyone having said so.
    const problem = routeProblem(route, defaultModel, enabledModels)
    if (problem === 'same') {
      throw new Error(`${route.model} is the second model of the current route. Switch routing off before making it the default.`)
    }
    if (problem !== null) {
      const used = isPanelId(route.model)
        ? `${deciderModel(route.model)} is the model the current route's panel runs on`
        : `${route.model} is the second model of the current route`
      throw new Error(`${used}. Switch routing off before disabling it.`)
    }
  }

  let dailyCapUsd = state.dailyCapUsd
  if (patch.dailyCapUsd !== undefined) {
    if (!Number.isFinite(patch.dailyCapUsd) || patch.dailyCapUsd < 0) {
      throw new Error('The daily AI budget has to be a number of dollars, 0 or more. 0 switches AI calls off.')
    }
    const over = hardLimitProblem('The daily AI budget', patch.dailyCapUsd, HARD_LIMITS.aiDailyCapUsdMax, ' dollars a day')
    if (over !== null) throw new Error(over)
    dailyCapUsd = patch.dailyCapUsd
  }

  // The watch asks only models that are enabled, and what it asks is what was agreed to when it
  // was switched on.
  let watch = state.watch
  if (patch.watch !== undefined) {
    const asked = patch.watch ?? {}
    const candidate: AiWatchConfig = {
      enabled: asked.enabled ?? state.watch.enabled,
      models: asked.models ?? state.watch.models,
      maxEventsPerDay: asked.maxEventsPerDay ?? state.watch.maxEventsPerDay,
      minBand: asked.minBand ?? state.watch.minBand,
      firstModelGates: asked.firstModelGates ?? state.watch.firstModelGates,
      confirmLive: asked.confirmLive ?? state.watch.confirmLive,
      askAt: asked.askAt ?? state.watch.askAt
    }
    const problem = aiWatchProblem(candidate, enabledModels)
    if (problem !== null) throw new Error(problem)
    // Its price was stated when it was switched on, for those models and that limit. Changing
    // either under a running watch would change what it can spend with nothing having said so.
    if (state.watch.enabled && candidate.enabled && !sameWatchTerms(state.watch, candidate)) {
      throw new Error('Switch the watch off before changing what it asks. Switching it on again states the new price first.')
    }
    watch = { ...candidate, models: [...candidate.models] }
  } else {
    // Like a route: a change that would strand a running watch is refused rather than quietly
    // repaired. Taking a model off its list could leave a dearer one asked about every event.
    const stranded = state.watch.models.find((model) => !enabledModels.includes(model))
    if (stranded !== undefined && state.watch.enabled) {
      // What else asks it, so that the way out is named (V7.2-R Stage 1).
      const users = modelsInUse(statusFor(state), ((await getSettings()).bots ?? []) as RoutedBot[]).get(stranded) ?? ['the watch']
      throw new Error(
        `${stranded} is one of the models the watch asks (asked by: ${users.join(', ')}). Move them to your choices under Settings › AI, "Who asks which model", or switch the watch off before disabling it.`
      )
    }
    if (stranded !== undefined) watch = { ...state.watch, models: state.watch.models.filter((model) => enabledModels.includes(model)) }
  }

  // Paper trades follow one of the watch's models, and what they do is what was read when they
  // were switched on.
  let watchPaper = state.watchPaper
  if (patch.watchPaper !== undefined) {
    const asked = patch.watchPaper ?? {}
    const candidate: AiWatchPaperConfig = {
      enabled: asked.enabled ?? state.watchPaper.enabled,
      model: asked.model !== undefined ? asked.model : state.watchPaper.model,
      stakeQuote: asked.stakeQuote ?? state.watchPaper.stakeQuote,
      maxOpen: asked.maxOpen ?? state.watchPaper.maxOpen,
      maxSameSide: asked.maxSameSide ?? state.watchPaper.maxSameSide,
      pauseAfterLosses: asked.pauseAfterLosses ?? state.watchPaper.pauseAfterLosses,
      dropOnBtcMovePct: asked.dropOnBtcMovePct ?? state.watchPaper.dropOnBtcMovePct
    }
    const problem = aiWatchPaperProblem(candidate, watch.models)
    if (problem !== null) throw new Error(problem)
    // The safeguards are terms like the stake: what switching them on said is what runs.
    const sameTerms =
      candidate.model === state.watchPaper.model &&
      candidate.stakeQuote === state.watchPaper.stakeQuote &&
      candidate.maxOpen === state.watchPaper.maxOpen &&
      candidate.maxSameSide === state.watchPaper.maxSameSide &&
      candidate.pauseAfterLosses === state.watchPaper.pauseAfterLosses &&
      candidate.dropOnBtcMovePct === state.watchPaper.dropOnBtcMovePct
    if (state.watchPaper.enabled && candidate.enabled && !sameTerms) {
      throw new Error('Switch paper trades off before changing them. Switching them on again says what they will do first.')
    }
    watchPaper = candidate
  } else if (watchPaper.model !== null && !watch.models.includes(watchPaper.model)) {
    // Like a route: a change that would strand them is refused rather than quietly repaired.
    if (watchPaper.enabled) {
      throw new Error(`${watchPaper.model} is the model the watch's paper trades follow. Switch paper trades off before taking it off the watch's list.`)
    }
    watchPaper = { ...watchPaper, model: null }
  }

  // A pace only spreads calls out; it never makes one more of them, so it is changed with no
  // confirmation and takes effect from the next call.
  let callsPerMinute = state.callsPerMinute
  if (patch.callsPerMinute !== undefined) {
    if (!isCallsPerMinute(patch.callsPerMinute)) throw new Error(`One model is asked at most ${AI_CALLS_PER_MINUTE_CHOICES.join(', ')} times a minute`)
    callsPerMinute = patch.callsPerMinute
  }

  // An addition switched on or off only changes whether it asks, within its own limit and the
  // budget; switching one off only ever spends less.
  let additions = state.additions
  if (patch.additions !== undefined) {
    const asked = (typeof patch.additions === 'object' && patch.additions !== null ? patch.additions : {}) as Record<string, unknown>
    additions = healAiAdditions({ ...state.additions, ...Object.fromEntries(Object.entries(asked).filter(([, value]) => typeof value === 'boolean')) })
  }

  cache = { ...state, defaultModel, enabledModels, route, dailyCapUsd, watch, watchPaper, callsPerMinute, additions, roles: state.roles }
  await persist()
  return statusFor(cache)
}

// WHO ASKS WHICH MODEL, AND ONE MOVE TO THE ROLES CHOSEN (V7.2-R Stage 1, 20 October 2026; shared/aiRouting.ts).
// The preview is free: it reads the settings, the bots, the ledger and the price list. The move changes what
// asks by itself -- the watch's list and gate, the model its paper trades follow, the additions' models, every
// running paid bot -- and is applied only with the token of the preview its confirmation was written from: a
// setting or a price that changed in between refuses it, and the next preview says the new figures.

const DAY_SEC = 86_400
/** The days of the ledger a caller's recent rate and token counts are read from. */
const RECENT_DAYS = 7

/** A caller's recent calls a day and the token counts its question takes, from the ledger's last week. */
function recentOf(rows: readonly AiCallRecord[], match: (row: AiCallRecord) => boolean): { callsADay: number; tokens: { prompt: number; completion: number } | null } {
  const mine = rows.filter(match)
  const days = new Set(mine.map((row) => Math.floor(row.at / DAY_SEC))).size
  return { callsADay: days === 0 ? 0 : mine.length / Math.max(1, Math.min(RECENT_DAYS, days)), tokens: medianTokensOf(mine) }
}

/** One call of `model` for a caller: its own calls under the caller's question, else the price list at the
 * caller's token counts. */
async function perCallOf(model: string, match: (row: AiCallRecord) => boolean, tokens: { prompt: number; completion: number } | null): Promise<{ usd: number | null; basis: 'history' | 'pricing' | 'unknown' }> {
  const history = (await listAiCalls({ model, limit: 400 })).rows.filter((row) => match(row) && row.status !== 'failed' && row.usage.costUsd !== null)
  if (history.length > 0) return { usd: history.reduce((sum, row) => sum + (row.usage.costUsd ?? 0), 0) / history.length, basis: 'history' }
  const priced = priceOfCall(await findAiModel(model), tokens)
  return priced === null ? { usd: null, basis: 'unknown' } : { usd: priced, basis: 'pricing' }
}

/** The bots on file, as routing reads them. */
async function botsOnFile(): Promise<Bot[]> {
  return ((await getSettings()).bots ?? []) as Bot[]
}

/** What a move to these roles would change and cost. Free. */
export async function previewAiRoles(choice: RoleChoice): Promise<RoutingPreview> {
  const state = await load()
  const problem = roleChoiceProblem(choice, state.enabledModels)
  if (problem !== null) throw new Error(problem)
  const bots = await botsOnFile()
  const plan = rolesPlanOf(statusFor(state), bots as RoutedBot[], choice)
  const nowSec = Math.floor(Date.now() / 1000)
  const recent = (await listAiCalls({ sinceSec: nowSec - RECENT_DAYS * DAY_SEC, limit: 5000 })).rows
  const costs: RoutingCost[] = []
  // A caller that has not asked yet is priced at the token counts of its kind of call, else of any call here.
  const anyTokens = medianTokensOf(recent)
  const priced = async (id: string, label: string, models: string[], match: (row: AiCallRecord) => boolean, on: boolean, mostCallsADay: number | null, callsADay?: number, kindOf?: (row: AiCallRecord) => boolean): Promise<void> => {
    const rate = recentOf(recent, match)
    const tokens = rate.tokens ?? (kindOf === undefined ? null : medianTokensOf(recent.filter(kindOf))) ?? anyTokens
    const each = await Promise.all(models.map((model) => perCallOf(model, match, tokens)))
    const perEvent = each.every((entry) => entry.usd !== null) ? each.reduce((sum, entry) => sum + (entry.usd ?? 0), 0) : null
    const calls = callsADay ?? rate.callsADay
    costs.push({
      id,
      label,
      models,
      perCallUsd: each.map((entry) => entry.usd),
      basis: each.map((entry) => entry.basis),
      callsADay: calls,
      mostCallsADay,
      // A caller that asks nothing a day costs nothing a day, whatever its price.
      expectedUsd: calls === 0 ? 0 : perEvent === null ? null : perEvent * calls,
      mostUsd: mostCallsADay === null ? null : mostCallsADay === 0 ? 0 : perEvent === null ? null : perEvent * mostCallsADay,
      on
    })
  }
  // The watch: each event put to its list, at its recent events a day; at most its own limit of events.
  const watchEvents = new Set(recent.filter((row) => row.source === 'watch' && row.eventId !== undefined).map((row) => `${Math.floor(row.at / DAY_SEC)}:${row.eventId}`)).size
  const watchDays = new Set(recent.filter((row) => row.source === 'watch').map((row) => Math.floor(row.at / DAY_SEC))).size
  await priced('watch', 'The watch', plan.watch.models, (row) => row.source === 'watch', plan.watch.enabled, plan.watch.maxEventsPerDay, watchDays === 0 ? 0 : watchEvents / Math.max(1, watchDays))
  for (const kind of AI_ADDITION_KINDS) {
    const model = kind === 'exit' || kind === 'review' ? plan.defaultModel : (plan.roles.summarize ?? plan.defaultModel)
    await priced(`addition:${kind}`, kind, [model], (row) => row.source === 'addition' && row.promptVersion === AI_ADDITION_PROMPT_VERSIONS[kind], state.additions[kind] && plan.watch.enabled, AI_ADDITION_DAILY_LIMITS[kind], undefined, (row) => row.source === 'addition')
  }
  for (const bot of bots) {
    if (bot.archived || !paidBot(bot)) continue
    const model = plan.bots.some((entry) => entry.id === bot.id) ? plan.defaultModel : (bot.aiModel ?? plan.defaultModel)
    // GPT Intraday asks once a decision bar, 96 fifteen-minute bars a day over its cadence; a reviewed strategy at its recent rate.
    const intraday = bot.strategyId === GPT_INTRADAY_STRATEGY_ID
    const decisions = intraday ? 96 / Math.max(1, bot.aiEveryBars ?? 1) : undefined
    await priced(`bot:${bot.id}`, `Bot ${bot.name}`, [model], (row) => row.source === 'bot' && (intraday ? row.promptVersion === GPT_PROMPT_VERSION : row.strategyId === bot.strategyId), bot.enabled, decisions ?? null, decisions)
  }
  const on = costs.filter((entry) => entry.on)
  // A total is known only where every caller that is on has its figure: a caller without a limit of its own
  // counts at its expected rate in the most.
  const sum = (key: 'expectedUsd' | 'mostUsd'): number | null => {
    const figures = on.map((entry) => (key === 'mostUsd' && entry.mostCallsADay === null ? entry.expectedUsd : entry[key]))
    return figures.some((figure) => figure === null) ? null : figures.reduce<number>((total, figure) => total + (figure ?? 0), 0)
  }
  const body = { plan, costs, expectedDailyUsd: sum('expectedUsd'), mostDailyUsd: sum('mostUsd'), capUsd: state.dailyCapUsd }
  const round = (value: number | null): number | null => (value === null ? null : Math.round(value * 10_000) / 10_000)
  const token = createHash('sha256')
    .update(JSON.stringify({ plan, costs: costs.map((entry) => ({ ...entry, perCallUsd: entry.perCallUsd.map(round), expectedUsd: round(entry.expectedUsd), mostUsd: round(entry.mostUsd), callsADay: round(entry.callsADay) })), cap: state.dailyCapUsd }))
    .digest('hex')
    .slice(0, 16)
  return { ...body, token, text: routingPreviewText(body) }
}

/** The move to roles, with the token of the preview its confirmation stated. What it changes, it changes
 * together: the default model, the roles, the watch's list and gate (on or off as it was, its limit and band
 * kept), the model its paper trades follow (their stake and caps kept), and every running paid bot re-pinned
 * from now on, its earlier decisions kept as the model that made them. */
export async function applyAiRoles(request: { choice: RoleChoice; token: string }): Promise<{ config: AiConfig; movedBots: { id: string; name: string; from: string; to: string }[] }> {
  const preview = await previewAiRoles(request.choice)
  if (typeof request.token !== 'string' || request.token !== preview.token) {
    throw new Error('Something changed since this move was priced: a setting, a bot or a price. Look at the move again; nothing was changed.')
  }
  const state = await load()
  const { plan } = preview
  const watchProblem = aiWatchProblem(plan.watch, state.enabledModels)
  if (watchProblem !== null) throw new Error(watchProblem)
  const paperProblem = aiWatchPaperProblem(plan.watchPaper, plan.watch.models)
  if (paperProblem !== null) throw new Error(paperProblem)
  const nowSec = Math.floor(Date.now() / 1000)
  if (plan.bots.length > 0) {
    const moving = new Set(plan.bots.map((entry) => entry.id))
    const bots = await botsOnFile()
    await setSettings({ bots: bots.map((bot) => (moving.has(bot.id) ? repinBot(bot, plan.defaultModel, state.defaultModel, nowSec) : bot)) })
  }
  cache = { ...state, defaultModel: plan.defaultModel, roles: plan.roles, watch: { ...plan.watch, models: [...plan.watch.models] }, watchPaper: { ...plan.watchPaper } }
  await persist()
  return { config: statusFor(cache), movedBots: plan.bots }
}

/** The model a request will be asked of. A named model has to be one the user enabled: the
 * renderer chooses it, and "only models held to a schema" is a rule that means nothing if any id
 * arriving over IPC is simply used. */
export async function resolveAiModel(requested: string | undefined): Promise<string> {
  const state = await load()
  if (requested === undefined) return state.defaultModel
  if (!state.enabledModels.includes(requested)) {
    throw new Error(`${requested} is not enabled. Enable it under Settings › AI, or switch the bot off and on to move it to the current settings.`)
  }
  return requested
}

/** The same, for a request that may name a panel of agents instead of a model (shared/aiPanel.ts).
 * A panel needs no enabling of its own, but the model it runs on does: every one of its four calls
 * is a call to that model. Only a tape resolves through here. An entry review asks one model one
 * question, and goes on resolving through resolveAiModel, where a panel is not a model. */
export async function resolveAiDecider(requested: string | undefined): Promise<string> {
  if (requested === undefined || !isPanelId(requested)) return resolveAiModel(requested)
  const model = panelModelOf(requested)
  if (model === null) throw new Error(`"${requested}" does not name a panel of agents on a model`)
  const state = await load()
  if (!state.enabledModels.includes(model)) {
    throw new Error(`${model} is not enabled, so a panel cannot be run on it. Enable it under Settings › AI.`)
  }
  return requested
}

/** The models a tape will ask: the first, and the second when the request names a route.
 *
 * THE ROUTE IS THE REQUEST'S, NEVER THE CONFIGURED ONE. The setting above is what a backtest and a
 * bot being switched on copy into their request, after saying so in their confirmation. Read here
 * instead, it would reach every caller that names no model -- a bot switched on before routes
 * existed, the chart -- and double what they can spend without any of them having been asked.
 *
 * The second step is held to the rule the first is: a model the user enabled, or a panel on one. */
export async function resolveAiPipeline(requested: { model?: string; route?: unknown }): Promise<{ model: string; route: AiRoute | null }> {
  const model = await resolveAiDecider(requested.model)
  const route = parseAiRoute(requested.route)
  if (!route) return { model, route: null }
  if (route.model === model) throw new Error(`A route needs two different models, and ${model} is named as both.`)
  await resolveAiDecider(route.model)
  return { model, route }
}

/** Runs immediately before every paid request. Throws rather than returning a flag so that no
 * caller can forget to look at the answer. */
export async function assertAiBudget(): Promise<void> {
  const state = await load()
  const spent = usageForDay(state.dailyUsage, today())
  const problem = budgetProblem(state.dailyCapUsd, spent)
  if (problem !== null) throw new AiBudgetError(problem, state.dailyCapUsd, spent)
}

export async function budgetRemainingUsd(): Promise<number> {
  const state = await load()
  return Math.max(0, state.dailyCapUsd - usageForDay(state.dailyUsage, today()))
}

/** Records what a call cost against today's bucket. */
export async function recordAiSpend(costUsd: number): Promise<void> {
  if (!(costUsd > 0)) return
  const state = await load()
  const next = nextDailyUsage(state.dailyUsage, today(), costUsd)
  if (next === null) return
  state.dailyUsage = next
  await persist()
}

/** The catalogue, from disk unless it is stale or a refresh was asked for. A failed refresh falls
 * back to whatever is held, since an old price list is more use than an error. */
export async function listAiModels(refresh: boolean): Promise<AiModelCatalogue> {
  const held = await loadCatalogue()
  const nowSec = Math.floor(Date.now() / 1000)
  if (held && !refresh && nowSec - held.fetchedAt < CATALOGUE_MAX_AGE_SEC) return held
  try {
    const { apiKey } = await getDecryptedAiCredential()
    catalogue = { fetchedAt: nowSec, models: await fetchModelCatalogue(apiKey) }
    await mkdir(app.getPath('userData'), { recursive: true })
    await writeJsonAtomic(cataloguePath(), catalogue)
    return catalogue
  } catch (error) {
    if (held && !refresh) return held
    throw error
  }
}

/** A model's catalogue entry from what is already held. Never touches the network: it is called
 * on the way to and from a paid request, which must not wait on a second one. */
export async function findAiModel(id: string): Promise<AiModelInfo | null> {
  // One entry prices a model at every effort: what changes with the effort is how many tokens it
  // spends, which only its own call history can say.
  const slug = aiModelSlugOf(id)
  return (await loadCatalogue())?.models.find((model) => model.id === slug) ?? null
}
