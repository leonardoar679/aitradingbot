import { CACHE_RETENTION_DAYS, type RecordSizes } from './retention'
import { AI_ADDITION_DAILY_LIMITS, AI_ADDITION_PROMPT_VERSIONS, AI_ADDITION_SCHEMA_VERSIONS, healAiAdditions } from './aiAdditions'
import { AI_CONFIRM_PROMPT_VERSION } from './aiConfirm'
import { AI_CONTEXT_VERSION } from './aiContext'
import {
  AI_OPPORTUNITY_MARKET_MOVE_PROMPT_VERSION,
  AI_OPPORTUNITY_MARKET_PROMPT_VERSION,
  AI_OPPORTUNITY_NEWS_PROMPT_VERSION,
  AI_OPPORTUNITY_PROMPT_VERSION,
  AI_OPPORTUNITY_SCHEMA_VERSION,
  AI_OPPORTUNITY_TAG_PROMPT_VERSION
} from './aiOpportunity'
import { AI_AGENT_PROMPT_VERSIONS, AI_AGENT_SCHEMA_VERSION, AI_PANEL_PROMPT_VERSION } from './aiPanel'
import { AI_SCHEMA_VERSION, GPT_MIN_CONFIDENCE, GPT_PROMPT_VERSION } from './aiSignal'
import { AI_WATCH_BREAKER_CALLS, AI_WATCH_FRESH_SECONDS, healAiWatch } from './aiWatch'
import { healAiWatchPaper } from './aiWatchPaper'
import { BTC_CRASH_PCT, HIGH_IMPACT, WATCH_IMPACT, healAlerts } from './alerts'
import { SOUND_SCORES, TOP_CHANGE_CHIME_SECONDS, healSoundSettings } from './sounds'
import { DEFAULT_CONFIG, type EffectiveStores } from './appDefaults'
import { CONFIG_FILE_VERSION, type ConfigFileName, type ConfigFileNote } from './configMigration'
import { FEE_RATE, SLIPPAGE_RATE } from './fees'
import { HARD_LIMITS } from './hardLimits'
import { healKeepRunning } from './keepRunning'
import { LIVE_GAP_SECONDS, LIVE_MARKET_VERSION, MAX_SPREAD_PCT, STALE_PRICE_MS } from './liveMarket'
import {
  EVENT_ACTIVE_PASSES,
  EVENT_CANDIDATE_SCORE,
  EVENT_CAUSE_NEWS_IMPACT,
  EVENT_CAUSE_NEWS_SECONDS,
  EVENT_CAUSE_ORGANIC_VOLUME,
  EVENT_CONFIRM_VOLUME_RATIO,
  EVENT_COOLDOWN_SECONDS,
  EVENT_DETECTOR_VERSION,
  EVENT_EXPIRY_SECONDS,
  EVENT_MAX_RANKED,
  EVENT_URGENT_SCORE,
  FINGERPRINT_BUCKET_SECONDS,
  FINGERPRINT_MOVE_STEP_PCT
} from './marketEvent'
import type { ScannerConfig } from './marketScanner'
import { healNewsConfig } from './news'
import { OPPORTUNITY_SCORE_VERSION } from './opportunityScore'
import { healPaperDigest } from './paperDigest'
import { healPaperPause } from './paperPause'
import { PAPER_MIN_STAKE, healPaperRisk } from './paperRisk'
import { RISK_LINES } from './dynamicRisk'
import { SESSION_REPORT_VERSION } from './shadowReport'
import { healUiMode } from './uiMode'
import { healLanguage } from './i18n/languages'
import { FORECAST_DATA_VERSION, FORECAST_HISTORY_DAYS } from './forecast/bars'
import { CALIBRATION_LINES, CALIBRATION_VERSION } from './forecast/calibration'
import { DIRECTION_LINES } from './forecast/direction'
import { ENSEMBLE_LINES, ENSEMBLE_VERSION } from './forecast/ensemble'
import { CLASS_LINES, FEATURES_VERSION, PEG_RANGE } from './forecast/features'
import { FORECAST_RECORD_DAYS, FORECAST_RECORD_VERSION } from './forecast/forecastRecord'
import { MODELS_VERSION, TRAINING } from './forecast/models'
import { NEWS_EFFECT_LINES, NEWS_EFFECT_VERSION } from './forecast/newsEffect'
import { OUTCOME_LINES, OUTCOME_VERSION } from './forecast/outcome'
import { REFRESH_LINES } from './forecast/refresh'
import { EDGE_VERSION, ROUND_TRIP_PCT } from './forecast/edge'
import { QUALITY_LINES, QUALITY_VERSION } from './forecast/quality'
import { RANK_LINES, RANK_VERSION } from './forecast/ranking'
import { CHANGE_LINES } from './forecast/predictionChange'
import { LAB_LINES, LAB_VERSION } from './forecast/lab'
import { PLAN_LINES, PLAN_VERSION } from './forecast/tradePlan'
import { CLASS_LINES as OPPORTUNITY_CLASS_LINES } from './forecast/opportunityClass'
import { DECISION_LINES, DECISION_VERSION } from './forecast/tradeDecision'
import { NEWS_FEED_VERSION } from './newsFeed'
import { PREDICTION_LINES, PREDICTION_VERSION } from './forecast/prediction'
import { RELIABILITY_LINES } from './forecast/reliability'
import { SHOCK_LINES, SHOCK_VERSION } from './forecast/shock'
import { MARKET_SHOCK_LINES, MARKET_SHOCK_STATES, MARKET_SHOCK_VERSION } from './forecast/marketShock'
import { MACRO_CALENDAR_VERSION, MACRO_KINDS, PRE_EVENT_SEC } from './calendar/macro'
import { RUN_CALIBRATION_VERSION } from './forecast/runCalibration'
import { DEGRADATION_LINES, DEGRADED_THREAD_SECONDS, DIRECTION_PROMOTION_LINES, PROMOTION_LINES } from './forecast/promotion'
import { LOGISTIC_FIT } from './forecast/ml/logistic'
import { DIRECTION_MODELS, EXCURSION_LEVELS } from './forecast/models'
import { EXCURSION_CALIBRATION_VERSION, EXCURSION_MIN_ROWS, FIRST_TOUCH, FIRST_TOUCH_VERSION } from './forecast/firstTouch'
import { MIN_READY_PAIRS, healForecastSettings } from './forecast/training'
import { LAB_RISK, LAB_STRATEGIES } from './forecast/labTrader'
import { FOLDS } from './forecast/walkForward'

export type { EffectiveStores } from './appDefaults'

// THE EFFECTIVE CONFIGURATION, IN ONE PLACE, WITH A VERSION (the V4 document, §4-5 and §61; the V5
// document, §4-7 and §107).
//
// The document asks for a DefaultConfig and a ConfigResolver that give every missing setting its
// default. In this app that resolver is one heal function per store, each run on every read
// (shared/appDefaults.ts says which), and the defaults composed are DEFAULT_CONFIG there. What was
// missing was one place to see the whole of it -- every store as the app reads it, and every
// constant the engine runs on -- and a version of that whole, so a report or a benchmark says which
// configuration it was made under and two of them can be told apart.
//
// TWO VERSIONS. The ENGINE version hashes the constants alone: the detector, the bands, the costs,
// the prompts and schemas, and since 8 October 2026 the hard limits above every setting
// (shared/hardLimits.ts) and the settings files' version (shared/configMigration.ts). It changes
// only when the code does, and a test pins today's, so a change is a deliberate one. The
// CONFIGURATION version hashes the constants and the stores together: what this profile runs
// under, now. The stores are read by the main process, which hashes with its own crypto
// (electron/services/effectiveConfigService.ts); this module only composes.
//
// WHAT THE HEAL DID is told as well (the V5 document, §107: "undefined → safe default" must be
// seen, not guessed at): healNote sets each file as read against the stores as healed and names
// every value that was missing, repaired or clamped, for the card and for the log at start.
//
// NOTHING HERE IS EDITABLE (the user's choice on 8 October 2026): the engine's thresholds stay
// pinned constants, shown read-only, so every record stays comparable.

/** The constants the engine runs on, by the module that defines each. Read-only, pinned by hash. */
export const ENGINE_CONSTANTS = {
  marketEvent: {
    detector: EVENT_DETECTOR_VERSION,
    candidateScore: EVENT_CANDIDATE_SCORE,
    urgentScore: EVENT_URGENT_SCORE,
    cooldownSeconds: EVENT_COOLDOWN_SECONDS,
    maxRanked: EVENT_MAX_RANKED,
    /** The event's life, its fingerprint and its cause (the V5 document, §19-21; since 8 October 2026). */
    activePasses: EVENT_ACTIVE_PASSES,
    expirySeconds: EVENT_EXPIRY_SECONDS,
    confirmVolumeRatio: EVENT_CONFIRM_VOLUME_RATIO,
    causeNewsSeconds: EVENT_CAUSE_NEWS_SECONDS,
    causeNewsImpact: EVENT_CAUSE_NEWS_IMPACT,
    causeOrganicVolume: EVENT_CAUSE_ORGANIC_VOLUME,
    fingerprintBucketSeconds: FINGERPRINT_BUCKET_SECONDS,
    fingerprintMoveStepPct: FINGERPRINT_MOVE_STEP_PCT
  },
  opportunityScore: { version: OPPORTUNITY_SCORE_VERSION },
  liveMarket: { version: LIVE_MARKET_VERSION, maxSpreadPct: MAX_SPREAD_PCT, stalePriceMs: STALE_PRICE_MS, gapSeconds: LIVE_GAP_SECONDS },
  fees: { feeRate: FEE_RATE, slippageRate: SLIPPAGE_RATE },
  paperRisk: { minStake: PAPER_MIN_STAKE },
  /** Risk by the conditions (the V5 document, §46-47; since 8 October 2026). */
  dynamicRisk: RISK_LINES,
  alerts: { highImpact: HIGH_IMPACT, watchImpact: WATCH_IMPACT, btcCrashPct: BTC_CRASH_PCT },
  /** The four sounds' scores, and the chime for a new top prediction (V6 Stage 13). */
  sounds: { scores: SOUND_SCORES, topChangeChimeSeconds: TOP_CHANGE_CHIME_SECONDS },
  aiWatch: { freshSeconds: AI_WATCH_FRESH_SECONDS, breakerCalls: AI_WATCH_BREAKER_CALLS, minConfidence: GPT_MIN_CONFIDENCE },
  aiAdditions: { dailyLimits: AI_ADDITION_DAILY_LIMITS, prompts: AI_ADDITION_PROMPT_VERSIONS, schemas: AI_ADDITION_SCHEMA_VERSIONS },
  prompts: {
    opportunity: AI_OPPORTUNITY_PROMPT_VERSION,
    opportunityMarket: AI_OPPORTUNITY_MARKET_PROMPT_VERSION,
    opportunityNews: AI_OPPORTUNITY_NEWS_PROMPT_VERSION,
    opportunityTag: AI_OPPORTUNITY_TAG_PROMPT_VERSION,
    marketMove: AI_OPPORTUNITY_MARKET_MOVE_PROMPT_VERSION,
    intraday: GPT_PROMPT_VERSION,
    confirm: AI_CONFIRM_PROMPT_VERSION,
    panel: AI_PANEL_PROMPT_VERSION,
    agents: AI_AGENT_PROMPT_VERSIONS
  },
  schemas: { signal: AI_SCHEMA_VERSION, opportunity: AI_OPPORTUNITY_SCHEMA_VERSION, agent: AI_AGENT_SCHEMA_VERSION, context: AI_CONTEXT_VERSION },
  sessionReport: { version: SESSION_REPORT_VERSION },
  /** The ceilings above every setting (the V5 document, §5): in code, never in a file. */
  hardLimits: HARD_LIMITS,
  configFiles: { version: CONFIG_FILE_VERSION },
  /** The records' retention (the V5 document, §93; since 8 October 2026): the answer cache is swept
   * of files older than this at start; the monthly files are kept. */
  retention: { answerCacheDays: CACHE_RETENTION_DAYS },
  /** The price forecast (the V6 document; since 13 October 2026): its bars, its figures, its models,
   * what they are fitted at, the walk forward, and the lines a model is promoted and degraded at. */
  forecast: {
    data: FORECAST_DATA_VERSION,
    historyDays: FORECAST_HISTORY_DAYS,
    features: FEATURES_VERSION,
    pegRange: PEG_RANGE,
    classLines: CLASS_LINES,
    models: MODELS_VERSION,
    training: TRAINING,
    folds: FOLDS,
    minReadyPairs: MIN_READY_PAIRS,
    promotion: PROMOTION_LINES,
    degradation: DEGRADATION_LINES,
    // The direction models (V7.1 Stage 2): which there are, their checklist's lines, the logistic fit's.
    directionModels: { models: DIRECTION_MODELS, promotion: DIRECTION_PROMOTION_LINES, logistic: LOGISTIC_FIT },
    // The path (V7.1 Stage 3): the excursion levels and their calibration's lines, and the first-touch table's.
    path: { excursion: { levels: EXCURSION_LEVELS, version: EXCURSION_CALIBRATION_VERSION, minRows: EXCURSION_MIN_ROWS }, touch: { version: FIRST_TOUCH_VERSION, ...FIRST_TOUCH } },
    ensemble: { version: ENSEMBLE_VERSION, ...ENSEMBLE_LINES },
    calibration: { version: CALIBRATION_VERSION, run: RUN_CALIBRATION_VERSION, ...CALIBRATION_LINES },
    direction: DIRECTION_LINES,
    reliability: RELIABILITY_LINES,
    prediction: { version: PREDICTION_VERSION, ...PREDICTION_LINES },
    shock: { version: SHOCK_VERSION, ...SHOCK_LINES },
    // The market's shock states (V7.1 Stage 11): their lines, fixed before anything was measured by them.
    marketShock: { version: MARKET_SHOCK_VERSION, states: MARKET_SHOCK_STATES, ...MARKET_SHOCK_LINES },
    // The macro calendar (V7.1 Stage 12): its version and what it holds; the dates themselves are data.
    calendar: { version: MACRO_CALENDAR_VERSION, kinds: MACRO_KINDS, preEventSec: PRE_EVENT_SEC },
    refresh: REFRESH_LINES,
    outcome: { version: OUTCOME_VERSION, ...OUTCOME_LINES },
    record: { version: FORECAST_RECORD_VERSION, days: FORECAST_RECORD_DAYS },
    news: { version: NEWS_EFFECT_VERSION, feed: NEWS_FEED_VERSION, ...NEWS_EFFECT_LINES },
    quality: { version: QUALITY_VERSION, ...QUALITY_LINES },
    edge: { version: EDGE_VERSION, roundTripPct: ROUND_TRIP_PCT },
    rank: { version: RANK_VERSION, ...RANK_LINES },
    decision: { version: DECISION_VERSION, ...DECISION_LINES },
    change: CHANGE_LINES,
    degradedThreadSeconds: DEGRADED_THREAD_SECONDS,
    lab: { version: LAB_VERSION, ...LAB_LINES },
    // The $10,000 paper laboratory (V7.1 Stage 4): its strategies and the risk lines every one of them keeps.
    paperLab: { strategies: LAB_STRATEGIES, ...LAB_RISK },
    plan: { version: PLAN_VERSION, ...PLAN_LINES },
    classes: OPPORTUNITY_CLASS_LINES
  }
} as const

/** One value the heal changed on the way from a file to the store the app runs on. */
export interface HealedValue {
  file: ConfigFileName
  /** The value's path in the effective stores, e.g. `ai.dailyCapUsd`. */
  path: string
  /** `missing`: not in the file, so its default; `clamped`: a number over a ceiling, held to it;
   * `repaired`: anything else the heal would not take as written. */
  how: 'missing' | 'repaired' | 'clamped'
  /** The value as the file held it (JSON), or `—` when it held none. */
  stored: string
  /** The value the app runs on (JSON). */
  effective: string
}

export interface EffectiveConfig {
  /** A short hash of the constants alone: changes only with the code. */
  engineVersion: string
  /** A short hash of the constants and the stores together: what this profile runs under now. */
  configVersion: string
  engine: typeof ENGINE_CONSTANTS
  stores: EffectiveStores
  /** Each settings file as read at start: there or not, its version, what was migrated. */
  files: ConfigFileNote[]
  /** Every value the heal changed at start. */
  healed: HealedValue[]
  /** What the records weigh and what the start swept (shared/retention.ts); null where not measured. */
  sizes: RecordSizes | null
}

/** What a fresh install's stores are: every default, composed (shared/appDefaults.ts). */
export function defaultStores(): EffectiveStores {
  return DEFAULT_CONFIG
}

/** The raw stores as read from their files, each healed by its own rule, into the effective ones.
 * `settings` is settings.json's top level; `ai` the AI config as its service hands it out; the rest
 * as each service hands them out. */
export function healStores(input: {
  settings: { paperRisk?: unknown; paperPause?: unknown; paperDigest?: unknown; alerts?: unknown; sounds?: unknown; keepRunningWhenClosed?: unknown; uiMode?: unknown; language?: unknown; forecast?: unknown }
  ai: { defaultModel: string; enabledModels: string[]; dailyCapUsd: number; callsPerMinute: number; watch: unknown; watchPaper: unknown; additions: unknown }
  scanner: ScannerConfig
  news: unknown
  live: EffectiveStores['live']
}): EffectiveStores {
  const pause = healPaperPause(input.settings.paperPause)
  const watch = healAiWatch(input.ai.watch, input.ai.enabledModels)
  return {
    paperRisk: healPaperRisk(input.settings.paperRisk),
    paperPause: { lossR: pause.lossR, trades: pause.trades },
    paperDigest: { enabled: healPaperDigest(input.settings.paperDigest).enabled, lastDay: null },
    alerts: healAlerts(input.settings.alerts),
    sounds: healSoundSettings(input.settings.sounds),
    app: { keepRunningWhenClosed: healKeepRunning(input.settings.keepRunningWhenClosed), uiMode: healUiMode(input.settings.uiMode), language: healLanguage(input.settings.language) },
    forecast: healForecastSettings(input.settings.forecast),
    watch,
    watchPaper: healAiWatchPaper(input.ai.watchPaper, watch.models),
    additions: healAiAdditions(input.ai.additions),
    ai: { defaultModel: input.ai.defaultModel, enabledModels: [...input.ai.enabledModels].sort(), dailyCapUsd: input.ai.dailyCapUsd, callsPerMinute: input.ai.callsPerMinute },
    scanner: { enabled: input.scanner.enabled, universeSize: input.scanner.universeSize },
    news: healNewsConfig(input.news),
    live: input.live
  }
}

/** JSON with every object's keys in order, so the same configuration always hashes the same. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** The configuration composed and versioned. `hash` is the caller's (the main process's crypto, or
 * a test's), and the first twelve characters of what it gives are the version. `start` is what the
 * main process saw as it read the files; a composition made elsewhere has none. */
export function effectiveConfig(stores: EffectiveStores, hash: (text: string) => string, start: { files: ConfigFileNote[]; healed: HealedValue[]; sizes?: RecordSizes | null } = { files: [], healed: [] }): EffectiveConfig {
  const engineVersion = hash(stableJson(ENGINE_CONSTANTS)).slice(0, 12)
  const configVersion = hash(stableJson({ engine: ENGINE_CONSTANTS, stores })).slice(0, 12)
  return { engineVersion, configVersion, engine: ENGINE_CONSTANTS, stores, files: start.files, healed: start.healed, sizes: start.sizes ?? null }
}

/** Every value as one row: its path and its value, for the read-only card. */
export function flattenConfig(value: unknown, prefix = ''): { path: string; value: string }[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => flattenConfig(entry, prefix === '' ? key : `${prefix}.${key}`))
  }
  return [{ path: prefix, value: Array.isArray(value) ? value.map((entry) => String(entry)).join(', ') || '(none)' : value === null ? 'none' : String(value) }]
}

/** Which file each store is read from, and under which key of it (null: the file's top level). */
const STORE_FILES: Record<keyof EffectiveStores, { file: ConfigFileName; under: string | null }> = {
  paperRisk: { file: 'settings', under: 'paperRisk' },
  paperPause: { file: 'settings', under: 'paperPause' },
  paperDigest: { file: 'settings', under: 'paperDigest' },
  alerts: { file: 'settings', under: 'alerts' },
  sounds: { file: 'settings', under: 'sounds' },
  app: { file: 'settings', under: null },
  forecast: { file: 'settings', under: 'forecast' },
  watch: { file: 'aiConfig', under: 'watch' },
  watchPaper: { file: 'aiConfig', under: 'watchPaper' },
  additions: { file: 'aiConfig', under: 'additions' },
  ai: { file: 'aiConfig', under: null },
  scanner: { file: 'scanner', under: null },
  news: { file: 'news', under: null },
  live: { file: 'liveTrading', under: null }
}

/** Values of the stores that no file holds: the ceiling is code, and the digest's last day is a
 * record, not a setting. */
const NOT_STORED = new Set(['live.hardMaxOrderQuote', 'paperDigest.lastDay'])

/** The ceilings a clamped value lands on. */
const CEILINGS = new Set<number>(Object.values(HARD_LIMITS))

function leavesOf(value: unknown, path: string[]): { path: string[]; value: unknown }[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => leavesOf(entry, [...path, key]))
  }
  return [{ path, value }]
}

function at(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function sameValue(stored: unknown, effective: unknown): boolean {
  if (Array.isArray(stored) && Array.isArray(effective)) {
    return stableJson([...stored].sort()) === stableJson([...effective].sort())
  }
  return stored === effective
}

/** news.json written before the Monitoring Tag was read held a delisting's switches at its top
 * level; healNewsConfig reads them as the delisting's, and so does this. */
function newsAsRead(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.delisting !== undefined) return raw
  const flat = ['notifyHeld', 'paperShort', 'askModels'].filter((key) => raw[key] !== undefined)
  if (flat.length === 0) return raw
  return { ...raw, delisting: Object.fromEntries(flat.map((key) => [key, raw[key]])) }
}

/** Every value the heal changed: each file as read (migrated, not healed) against the stores as
 * healed. A file that was not there is not listed value by value -- the files note says it was not
 * there -- so a fresh install reads as nothing healed. */
export function healNote(raw: Partial<Record<ConfigFileName, Record<string, unknown>>>, stores: EffectiveStores): HealedValue[] {
  const out: HealedValue[] = []
  for (const store of Object.keys(STORE_FILES) as (keyof EffectiveStores)[]) {
    const { file, under } = STORE_FILES[store]
    const fileRaw = raw[file]
    if (fileRaw === undefined) continue
    const base = file === 'news' ? newsAsRead(fileRaw) : fileRaw
    for (const leaf of leavesOf(stores[store], [store])) {
      const path = leaf.path.join('.')
      if (NOT_STORED.has(path)) continue
      const stored = at(base, under === null ? leaf.path.slice(1) : [under, ...leaf.path.slice(1)])
      if (stored === undefined) {
        out.push({ file, path, how: 'missing', stored: '—', effective: JSON.stringify(leaf.value) ?? 'null' })
        continue
      }
      if (sameValue(stored, leaf.value)) continue
      const clamped =
        typeof stored === 'number' && typeof leaf.value === 'number' && stored > leaf.value && (CEILINGS.has(leaf.value) || path === 'live.dailyLossLimitQuote')
      out.push({ file, path, how: clamped ? 'clamped' : 'repaired', stored: JSON.stringify(stored) ?? 'null', effective: JSON.stringify(leaf.value) ?? 'null' })
    }
  }
  return out
}

/** The heal in one sentence. */
export function describeHealed(healed: HealedValue[]): string {
  const count = (how: HealedValue['how']): number => healed.filter((entry) => entry.how === how).length
  const parts: string[] = []
  const missing = count('missing')
  const repaired = count('repaired')
  const clamped = count('clamped')
  if (missing > 0) parts.push(`${missing} ${missing === 1 ? 'value was' : 'values were'} missing and took ${missing === 1 ? 'its' : 'their'} default${missing === 1 ? '' : 's'}`)
  if (repaired > 0) parts.push(`${repaired} ${repaired === 1 ? 'was' : 'were'} repaired`)
  if (clamped > 0) parts.push(`${clamped} ${clamped === 1 ? 'was' : 'were'} clamped to a hard limit`)
  return parts.length === 0 ? 'Every stored value was read as written.' : parts.join('; ') + '.'
}
