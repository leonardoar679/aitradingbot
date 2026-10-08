import { DEFAULT_AI_ADDITIONS, type AiAdditionsConfig } from './aiAdditions'
import { DEFAULT_AI_CALLS_PER_MINUTE } from './aiPace'
import { DEFAULT_AI_DAILY_CAP_USD, DEFAULT_AI_MODEL } from './aiSignal'
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
// THE RISK LEVEL is how Settings says the rest in a word, as the document asks ("Risk:
// Conservative" instead of twelve fields). Conservative is the shipped defaults of the two
// settings for the app's own paper trades that may be changed at any time -- how they are sized and
// capped, and the losing run that pauses them -- every one of which only ever opens less. Anything
// else is Custom. The limits on real orders are their own, set on Risk & Safety, and nothing here
// changes them.

/** Every store as the app reads it, healed: what a fresh install starts with where a file says
 * nothing. The live limits are the stored ones; the hard ceiling on a real order is a hard limit
 * and is shown beside them. */
export interface EffectiveStores {
  paperRisk: PaperRiskSettings
  paperPause: Pick<PaperPauseSettings, 'lossR' | 'trades'>
  paperDigest: PaperDigestSettings
  alerts: AlertSettings
  /** What closing the window does (shared/keepRunning.ts). */
  app: { keepRunningWhenClosed: boolean }
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
  app: { keepRunningWhenClosed: DEFAULT_KEEP_RUNNING },
  watch: DEFAULT_AI_WATCH,
  watchPaper: DEFAULT_AI_WATCH_PAPER,
  additions: DEFAULT_AI_ADDITIONS,
  ai: { defaultModel: DEFAULT_AI_MODEL, enabledModels: [DEFAULT_AI_MODEL], dailyCapUsd: DEFAULT_AI_DAILY_CAP_USD, callsPerMinute: DEFAULT_AI_CALLS_PER_MINUTE },
  scanner: DEFAULT_SCANNER_CONFIG,
  news: DEFAULT_NEWS_CONFIG,
  live: { ...DEFAULT_LIVE_LIMITS, hardMaxOrderQuote: HARD_LIMITS.liveMaxOrderQuote }
}

export type RiskLevel = 'conservative' | 'custom'

/** What Conservative is: the paper sizing and cap, and the pause's loss and run, at their defaults. */
export const CONSERVATIVE_PAPER: { paperRisk: PaperRiskSettings; pause: Pick<PaperPauseSettings, 'lossR' | 'trades'> } = {
  paperRisk: DEFAULT_PAPER_RISK,
  pause: { lossR: DEFAULT_PAPER_PAUSE.lossR, trades: DEFAULT_PAPER_PAUSE.trades }
}

/** Conservative when every one of those is at its default; Custom otherwise, whichever way it was
 * changed. */
export function riskLevelOf(input: { paperRisk: PaperRiskSettings; paperPause: Pick<PaperPauseSettings, 'lossR' | 'trades'> }): RiskLevel {
  const { paperRisk, pause } = CONSERVATIVE_PAPER
  const same =
    input.paperRisk.sizing === paperRisk.sizing &&
    input.paperRisk.riskQuote === paperRisk.riskQuote &&
    input.paperRisk.maxOutQuote === paperRisk.maxOutQuote &&
    input.paperPause.lossR === pause.lossR &&
    input.paperPause.trades === pause.trades
  return same ? 'conservative' : 'custom'
}

/** The paper settings put back to Conservative. Whether the watch or the news rules are paused is
 * kept as it is: a reset is not a Resume. */
export function conservativePaper(stored: PaperPauseSettings): { paperRisk: PaperRiskSettings; paperPause: PaperPauseSettings } {
  return { paperRisk: { ...CONSERVATIVE_PAPER.paperRisk }, paperPause: savePaperPause(stored, CONSERVATIVE_PAPER.pause) }
}

/** The level in a word, and what it holds the app's own paper trades to, as set. */
export function describeRiskLevel(input: { paperRisk: PaperRiskSettings; paperPause: Pick<PaperPauseSettings, 'lossR' | 'trades'> }): { label: string; detail: string } {
  const level = riskLevelOf(input)
  return {
    label: level === 'conservative' ? 'Conservative' : 'Custom',
    detail: `For the paper trades the app opens by itself: ${describePaperRisk(input.paperRisk)} ${describePaperPause(input.paperPause)}`
  }
}
