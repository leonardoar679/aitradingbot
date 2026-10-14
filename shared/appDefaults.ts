import { DEFAULT_AI_ADDITIONS, type AiAdditionsConfig } from './aiAdditions'
import { DEFAULT_AI_CALLS_PER_MINUTE } from './aiPace'
import { DEFAULT_AI_DAILY_CAP_USD, DEFAULT_AI_MODEL, DEFAULT_ENABLED_MODELS } from './aiSignal'
import { DEFAULT_AI_WATCH, type AiWatchConfig } from './aiWatch'
import { DEFAULT_AI_WATCH_PAPER, type AiWatchPaperConfig } from './aiWatchPaper'
import { DEFAULT_ALERTS } from './alerts'
import { HARD_LIMITS } from './hardLimits'
import type { AlertSettings, PaperDigestSettings, PaperPauseSettings, PaperRiskSettings } from './ipc'
import { DEFAULT_KEEP_RUNNING } from './keepRunning'
import { DEFAULT_LIVE_LIMITS } from './liveLimits'
import { DEFAULT_SCANNER_CONFIG, type ScannerConfig } from './marketScanner'
import { DEFAULT_NEWS_CONFIG, type NewsConfig } from './news'
import { DEFAULT_PAPER_DIGEST } from './paperDigest'
import { DEFAULT_PAPER_PAUSE, describePaperPause, savePaperPause } from './paperPause'
import { DEFAULT_PAPER_RISK, describePaperRisk } from './paperRisk'
import { DEFAULT_UI_MODE, type UiMode } from './uiMode'
import type { Language } from './i18n/languages'
import { DEFAULT_SOUND_SETTINGS, type SoundSettings } from './sounds'
import { DEFAULT_FORECAST_SETTINGS, type ForecastSettings } from './forecast/training'
import { DEFAULT_FORECAST_TRADER, type ForecastTraderSettings } from './forecast/trader'
import type { TargetLevel } from './forecast/tradePlan'
import { ENGLISH, msg, type I18n } from './i18n/translate'

// WHAT A FRESH INSTALL STARTS WITH, AND THE RISK LEVEL IN A WORD.
//
// The V3 document asks for "smart defaults first, advanced controls second": a DefaultConfig, and a
// ConfigResolver that gives every missing setting its default. In this app that resolver already
// exists, one heal function per store, each run on every read:
// - settings.json: healPaperRisk, healPaperPause, healPaperDigest, healAlerts;
// - aiConfig.json: the budget and models in electron/services/aiConfigService.ts, healAiWatch and
//   healAiWatchPaper;
// - scanner.json: marketScannerService.ts against DEFAULT_SCANNER_CONFIG;
// - news.json: healNewsConfig;
// - liveTrading.json: liveTradingService.ts against DEFAULT_LIVE_LIMITS.
// tests/appDefaults.test.ts reads each of the shared ones empty and checks it comes back as its
// default, so a default changes only where it is defined.
//
// THE DEFAULT CONFIGURATION (the V5 document, §6; since 8 October 2026) is every one of those
// defaults composed into one object, DEFAULT_CONFIG: the one place to read what a fresh install
// does, and what tests/hardLimits.test.ts holds the heals to -- an empty profile, healed, must equal
// it exactly. Each default is still defined beside its own heal (the thing that changes it is the
// thing that reads it); this object is where they are all seen together. Above every one of them
// stand the hard limits (shared/hardLimits.ts), which nothing in a file can exceed; and since 8
// October 2026 each settings file carries its version (shared/configMigration.ts).
//
// THE RISK MODE is how Settings says the rest in a word, as the documents ask ("Risk: Conservative"
// instead of twelve fields). Since 13 October 2026 (the V6 document, §66 and §106) there are three --
// Conservative, Balanced and Aggressive -- each a set of the settings for the paper trades the app
// opens by itself: how they are sized (a share of the paper account at the stop) and capped, what
// they stake on one side on coins that move with Bitcoin, the losing run that pauses them, and how
// many the forecast trader keeps open. Conservative is a fresh install's. Anything else is Custom.
// The limits on real orders are their own, set on Risk & Safety, and nothing here changes them.

/** Every store as the app reads it, healed: what a fresh install starts with where a file says
 * nothing. The live limits are the stored ones; the hard ceiling on a real order is a hard limit
 * and is shown beside them. */
export interface EffectiveStores {
  paperRisk: PaperRiskSettings
  paperPause: Pick<PaperPauseSettings, 'lossR' | 'trades'>
  paperDigest: PaperDigestSettings
  alerts: AlertSettings
  /** How the four sounds play (shared/sounds.ts; V6 Stage 13). */
  sounds: SoundSettings
  /** What closing the window does (shared/keepRunning.ts), and which groups of the sidebar start open
   * (shared/uiMode.ts). */
  app: { keepRunningWhenClosed: boolean; uiMode: UiMode; language: Language | null }
  /** The price forecast's nightly refit (shared/forecast/training.ts). */
  forecast: ForecastSettings
  watch: AiWatchConfig
  watchPaper: AiWatchPaperConfig
  additions: AiAdditionsConfig
  ai: { defaultModel: string; enabledModels: string[]; dailyCapUsd: number; callsPerMinute: number }
  scanner: ScannerConfig
  news: NewsConfig
  live: { maxOrderQuote: number; hardMaxOrderQuote: number; dailyCapQuote: number; dailyLossLimitQuote: number; allocationQuote: number | null; riskPct: number }
}

/** What a fresh install's stores are: every default, composed. Nothing real is traded, no model is
 * asked and nothing is opened by itself; the scanner and the four feeds read public data. */
export const DEFAULT_CONFIG: EffectiveStores = {
  paperRisk: DEFAULT_PAPER_RISK,
  paperPause: { lossR: DEFAULT_PAPER_PAUSE.lossR, trades: DEFAULT_PAPER_PAUSE.trades },
  paperDigest: DEFAULT_PAPER_DIGEST,
  alerts: DEFAULT_ALERTS,
  sounds: DEFAULT_SOUND_SETTINGS,
  // No language until one is chosen: the first launch asks, offering the computer's (shared/i18n).
  app: { keepRunningWhenClosed: DEFAULT_KEEP_RUNNING, uiMode: DEFAULT_UI_MODE, language: null },
  forecast: DEFAULT_FORECAST_SETTINGS,
  watch: DEFAULT_AI_WATCH,
  watchPaper: DEFAULT_AI_WATCH_PAPER,
  additions: DEFAULT_AI_ADDITIONS,
  // The models sorted, as the effective configuration lists them.
  ai: { defaultModel: DEFAULT_AI_MODEL, enabledModels: [...DEFAULT_ENABLED_MODELS].sort(), dailyCapUsd: DEFAULT_AI_DAILY_CAP_USD, callsPerMinute: DEFAULT_AI_CALLS_PER_MINUTE },
  scanner: DEFAULT_SCANNER_CONFIG,
  news: DEFAULT_NEWS_CONFIG,
  live: { ...DEFAULT_LIVE_LIMITS, hardMaxOrderQuote: HARD_LIMITS.liveMaxOrderQuote }
}

export type RiskMode = 'conservative' | 'balanced' | 'aggressive' | 'custom'
export type PresetRiskMode = Exclude<RiskMode, 'custom'>
export const RISK_MODES: readonly PresetRiskMode[] = ['conservative', 'balanced', 'aggressive']

/** What each mode holds the app's own paper trades to (the V6 document, §66 and §106; V6 Stage 12):
 * the risk a trade takes at its stop, a share of the paper account's equity (and a fixed amount
 * without one), what they stake together, what they stake on one side on coins that move with
 * Bitcoin, the losing run that pauses them, how many the forecast trader keeps open, on one side,
 * and the level its target is set at. Conservative is a fresh install's. */
export const RISK_MODE_PRESETS: Record<
  PresetRiskMode,
  { paperRisk: PaperRiskSettings; pause: Pick<PaperPauseSettings, 'lossR' | 'trades'>; trader: Pick<ForecastTraderSettings, 'maxOpen' | 'maxSameSide'>; targetLevel: TargetLevel }
> = {
  conservative: { paperRisk: DEFAULT_PAPER_RISK, pause: { lossR: DEFAULT_PAPER_PAUSE.lossR, trades: DEFAULT_PAPER_PAUSE.trades }, trader: { maxOpen: DEFAULT_FORECAST_TRADER.maxOpen, maxSameSide: DEFAULT_FORECAST_TRADER.maxSameSide }, targetLevel: 'P75' },
  balanced: { paperRisk: { sizing: 'equity', riskQuote: 2, riskPct: 0.5, maxOutQuote: 2500, correlatedShare: 0.25 }, pause: { lossR: 8, trades: 20 }, trader: { maxOpen: 4, maxSameSide: 2 }, targetLevel: 'P80' },
  aggressive: { paperRisk: { sizing: 'equity', riskQuote: 5, riskPct: 1, maxOutQuote: 5000, correlatedShare: 0.35 }, pause: { lossR: 10, trades: 20 }, trader: { maxOpen: 6, maxSameSide: 3 }, targetLevel: 'P90' }
}

export const RISK_MODE_NAMES: Record<RiskMode, string> = { conservative: msg('Conservative'), balanced: msg('Balanced'), aggressive: msg('Aggressive'), custom: msg('Custom') }

interface ModeInput {
  paperRisk: PaperRiskSettings
  paperPause: Pick<PaperPauseSettings, 'lossR' | 'trades'>
  trader: Pick<ForecastTraderSettings, 'maxOpen' | 'maxSameSide'>
}

/** The mode every one of those settings is at; Custom when any is not at one mode's, whichever way. */
export function riskModeOf(input: ModeInput): RiskMode {
  for (const mode of RISK_MODES) {
    const { paperRisk, pause, trader } = RISK_MODE_PRESETS[mode]
    const same =
      input.paperRisk.sizing === paperRisk.sizing &&
      input.paperRisk.riskQuote === paperRisk.riskQuote &&
      input.paperRisk.riskPct === paperRisk.riskPct &&
      input.paperRisk.maxOutQuote === paperRisk.maxOutQuote &&
      (input.paperRisk.correlatedShare ?? 0.15) === paperRisk.correlatedShare &&
      input.paperPause.lossR === pause.lossR &&
      input.paperPause.trades === pause.trades &&
      input.trader.maxOpen === trader.maxOpen &&
      input.trader.maxSameSide === trader.maxSameSide
    if (same) return mode
  }
  return 'custom'
}

/** The settings a mode writes. Whether the watch, the news rules or the forecast trader is paused is
 * kept as it is (a mode is not a Resume), and so is whether the forecast trader is on. The limits on
 * real orders are not among them: a mode never touches them. */
export function riskModePatch(mode: PresetRiskMode, stored: { paperPause: PaperPauseSettings; forecast: ForecastSettings }): { paperRisk: PaperRiskSettings; paperPause: PaperPauseSettings; forecast: ForecastSettings } {
  const preset = RISK_MODE_PRESETS[mode]
  return {
    paperRisk: { ...preset.paperRisk },
    paperPause: savePaperPause(stored.paperPause, preset.pause),
    forecast: { ...stored.forecast, trader: { ...stored.forecast.trader, ...preset.trader } }
  }
}

/** The level the forecast trader's target is set at: the mode's, and Conservative's when Custom. */
export function targetLevelOf(mode: RiskMode): TargetLevel {
  return RISK_MODE_PRESETS[mode === 'custom' ? 'conservative' : mode].targetLevel
}

/** The mode in a word, and what it holds the app's own paper trades to, as set, in a language: English
 * unless handed another (V6 Stage 14). */
export function describeRiskMode(input: ModeInput, i18n: I18n = ENGLISH): { mode: RiskMode; label: string; detail: string } {
  const { t } = i18n
  const mode = riskModeOf(input)
  return {
    mode,
    label: t(RISK_MODE_NAMES[mode]),
    detail: t(
      'For the paper trades the app opens by itself: {sizing} {pause} The forecast trader keeps at most {open} open, {side} on one side, its target at {level}. The limits on real orders are their own, on Risk & Safety: a mode never changes them.',
      { sizing: describePaperRisk(input.paperRisk, i18n), pause: describePaperPause(input.paperPause, i18n), open: input.trader.maxOpen, side: input.trader.maxSameSide, level: targetLevelOf(mode) }
    )
  }
}
