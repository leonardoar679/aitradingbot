import { createHash } from 'crypto'
import { effectiveConfig, healStores, type EffectiveConfig } from '../../shared/appConfig'
import { getAiConfig } from './aiConfigService'
import { getLiveTradingStatus } from './liveTradingService'
import { getScannerState } from './marketScannerService'
import { getNewsState } from './newsService'
import { getSettings } from './settingsService'

// THE EFFECTIVE CONFIGURATION AS THIS PROFILE RUNS UNDER IT (shared/appConfig.ts): every store read
// through its own service and healed, the engine's constants, and the two versions. Read by the
// Settings card, by the session report and by an experiment's record; it writes nothing and changes
// nothing.

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export async function getEffectiveConfig(): Promise<EffectiveConfig> {
  const [settings, ai, scanner, news, live] = await Promise.all([getSettings(), getAiConfig(), getScannerState(), getNewsState(), getLiveTradingStatus()])
  const stores = healStores({
    settings: { paperRisk: settings.paperRisk, paperPause: settings.paperPause, paperDigest: settings.paperDigest, alerts: settings.alerts },
    ai: {
      defaultModel: ai.defaultModel,
      enabledModels: ai.enabledModels,
      dailyCapUsd: ai.dailyCapUsd,
      callsPerMinute: ai.callsPerMinute,
      watch: ai.watch,
      watchPaper: ai.watchPaper,
      additions: ai.additions
    },
    scanner: scanner.config,
    news: news.config,
    live: {
      maxOrderQuote: live.maxOrderQuote,
      hardMaxOrderQuote: live.hardMaxOrderQuote,
      dailyCapQuote: live.dailyCapQuote,
      dailyLossLimitQuote: live.dailyLossLimitQuote,
      allocationQuote: live.allocationQuote
    }
  })
  return effectiveConfig(stores, sha256)
}

/** The configuration version alone, for a record that names it. */
export async function configVersionNow(): Promise<string> {
  return (await getEffectiveConfig()).configVersion
}
