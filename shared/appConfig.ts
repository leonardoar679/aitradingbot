import { AI_ADDITION_DAILY_LIMITS, AI_ADDITION_PROMPT_VERSIONS, AI_ADDITION_SCHEMA_VERSIONS, DEFAULT_AI_ADDITIONS, healAiAdditions, type AiAdditionsConfig } from './aiAdditions'
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
import { DEFAULT_AI_CALLS_PER_MINUTE } from './aiPace'
import { AI_AGENT_PROMPT_VERSIONS, AI_AGENT_SCHEMA_VERSION, AI_PANEL_PROMPT_VERSION } from './aiPanel'
import { AI_SCHEMA_VERSION, DEFAULT_AI_DAILY_CAP_USD, DEFAULT_AI_MODEL, GPT_MIN_CONFIDENCE, GPT_PROMPT_VERSION } from './aiSignal'
import { AI_WATCH_BREAKER_CALLS, AI_WATCH_FRESH_SECONDS, DEFAULT_AI_WATCH, healAiWatch, type AiWatchConfig } from './aiWatch'
import { DEFAULT_AI_WATCH_PAPER, healAiWatchPaper, type AiWatchPaperConfig } from './aiWatchPaper'
import { BTC_CRASH_PCT, DEFAULT_ALERTS, HIGH_IMPACT, WATCH_IMPACT, healAlerts } from './alerts'
import { FEE_RATE, SLIPPAGE_RATE } from './fees'
import type { AlertSettings, PaperDigestSettings, PaperPauseSettings, PaperRiskSettings } from './ipc'
import { LIVE_GAP_SECONDS, LIVE_MARKET_VERSION, MAX_SPREAD_PCT, STALE_PRICE_MS } from './liveMarket'
import { EVENT_CANDIDATE_SCORE, EVENT_COOLDOWN_SECONDS, EVENT_DETECTOR_VERSION, EVENT_MAX_RANKED, EVENT_URGENT_SCORE } from './marketEvent'
import { DEFAULT_SCANNER_CONFIG, type ScannerConfig } from './marketScanner'
import { DEFAULT_NEWS_CONFIG, healNewsConfig, type NewsConfig } from './news'
import { OPPORTUNITY_SCORE_VERSION } from './opportunityScore'
import { DEFAULT_PAPER_DIGEST, healPaperDigest } from './paperDigest'
import { DEFAULT_PAPER_PAUSE, healPaperPause } from './paperPause'
import { DEFAULT_PAPER_RISK, PAPER_MIN_STAKE, healPaperRisk } from './paperRisk'
import { SESSION_REPORT_VERSION } from './shadowReport'

// THE EFFECTIVE CONFIGURATION, IN ONE PLACE, WITH A VERSION (the V4 document, §4-5 and §61).
//
// The document asks for a DefaultConfig and a ConfigResolver that give every missing setting its
// default. In this app that resolver is one heal function per store, each run on every read
// (shared/appDefaults.ts says which). What was missing was one place to see the whole of it -- every
// store as the app reads it, and every constant the engine runs on -- and a version of that whole,
// so a report or a benchmark says which configuration it was made under and two of them can be told
// apart.
//
// TWO VERSIONS. The ENGINE version hashes the constants alone: the detector, the bands, the costs,
// the prompts and schemas. It changes only when the code does, and a test pins today's, so a change
// is a deliberate one. The CONFIGURATION version hashes the constants and the stores together: what
// this profile runs under, now. The stores are read by the main process, which hashes with its own
// crypto (electron/services/effectiveConfigService.ts); this module only composes.
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
    maxRanked: EVENT_MAX_RANKED
  },
  opportunityScore: { version: OPPORTUNITY_SCORE_VERSION },
  liveMarket: { version: LIVE_MARKET_VERSION, maxSpreadPct: MAX_SPREAD_PCT, stalePriceMs: STALE_PRICE_MS, gapSeconds: LIVE_GAP_SECONDS },
  fees: { feeRate: FEE_RATE, slippageRate: SLIPPAGE_RATE },
  paperRisk: { minStake: PAPER_MIN_STAKE },
  alerts: { highImpact: HIGH_IMPACT, watchImpact: WATCH_IMPACT, btcCrashPct: BTC_CRASH_PCT },
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
  sessionReport: { version: SESSION_REPORT_VERSION }
} as const

/** Every store as the app reads it, healed: what a fresh install starts with where a file says
 * nothing. The live limits are the stored ones; the hard ceiling on a real order is the live trading
 * service's own code and is shown beside them. */
export interface EffectiveStores {
  paperRisk: PaperRiskSettings
  paperPause: Pick<PaperPauseSettings, 'lossR' | 'trades'>
  paperDigest: PaperDigestSettings
  alerts: AlertSettings
  watch: AiWatchConfig
  watchPaper: AiWatchPaperConfig
  additions: AiAdditionsConfig
  ai: { defaultModel: string; enabledModels: string[]; dailyCapUsd: number; callsPerMinute: number }
  scanner: ScannerConfig
  news: NewsConfig
  live: { maxOrderQuote: number; hardMaxOrderQuote: number; dailyCapQuote: number; dailyLossLimitQuote: number; allocationQuote: number | null; riskPct: number }
}

export interface EffectiveConfig {
  /** A short hash of the constants alone: changes only with the code. */
  engineVersion: string
  /** A short hash of the constants and the stores together: what this profile runs under now. */
  configVersion: string
  engine: typeof ENGINE_CONSTANTS
  stores: EffectiveStores
}

/** What a fresh install's stores are: every default, composed. */
export function defaultStores(): EffectiveStores {
  return {
    paperRisk: DEFAULT_PAPER_RISK,
    paperPause: { lossR: DEFAULT_PAPER_PAUSE.lossR, trades: DEFAULT_PAPER_PAUSE.trades },
    paperDigest: DEFAULT_PAPER_DIGEST,
    alerts: DEFAULT_ALERTS,
    watch: DEFAULT_AI_WATCH,
    watchPaper: DEFAULT_AI_WATCH_PAPER,
    additions: DEFAULT_AI_ADDITIONS,
    ai: { defaultModel: DEFAULT_AI_MODEL, enabledModels: [DEFAULT_AI_MODEL], dailyCapUsd: DEFAULT_AI_DAILY_CAP_USD, callsPerMinute: DEFAULT_AI_CALLS_PER_MINUTE },
    scanner: DEFAULT_SCANNER_CONFIG,
    news: DEFAULT_NEWS_CONFIG,
    live: { maxOrderQuote: 10, hardMaxOrderQuote: 25, dailyCapQuote: 50, dailyLossLimitQuote: 15, allocationQuote: null, riskPct: 0.25 }
  }
}

/** The raw stores as read from their files, each healed by its own rule, into the effective ones.
 * `settings` is settings.json's top level; `ai` the AI config as its service hands it out; the rest
 * as each service hands them out. */
export function healStores(input: {
  settings: { paperRisk?: unknown; paperPause?: unknown; paperDigest?: unknown; alerts?: unknown }
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
 * a test's), and the first twelve characters of what it gives are the version. */
export function effectiveConfig(stores: EffectiveStores, hash: (text: string) => string): EffectiveConfig {
  const engineVersion = hash(stableJson(ENGINE_CONSTANTS)).slice(0, 12)
  const configVersion = hash(stableJson({ engine: ENGINE_CONSTANTS, stores })).slice(0, 12)
  return { engineVersion, configVersion, engine: ENGINE_CONSTANTS, stores }
}

/** Every value as one row: its path and its value, for the read-only card. */
export function flattenConfig(value: unknown, prefix = ''): { path: string; value: string }[] {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => flattenConfig(entry, prefix === '' ? key : `${prefix}.${key}`))
  }
  return [{ path: prefix, value: Array.isArray(value) ? value.map((entry) => String(entry)).join(', ') || '(none)' : value === null ? 'none' : String(value) }]
}
