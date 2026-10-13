import { createHash } from 'crypto'
import { describeHealed, effectiveConfig, healNote, healStores, type EffectiveConfig } from '../../shared/appConfig'
import { describeConfigFiles } from '../../shared/configMigration'
import { describeRecordSizes } from '../../shared/retention'
import { recordSizes } from './recordRetentionService'
import { getAiConfig } from './aiConfigService'
import { configFileNotes, rawConfigFiles } from './configFiles'
import { getLiveTradingStatus } from './liveTradingService'
import { getScannerState } from './marketScannerService'
import { getNewsState } from './newsService'
import { getSettings } from './settingsService'

// THE EFFECTIVE CONFIGURATION AS THIS PROFILE RUNS UNDER IT (shared/appConfig.ts): every store read
// through its own service and healed, the engine's constants, and the two versions. Read by the
// Settings card, by the session report and by an experiment's record; it writes nothing and changes
// nothing. Since 8 October 2026 (the V5 document, §107) it also says what reading the files did:
// each file's version and what was migrated (configFiles.ts), and every value the heal changed.

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

export async function getEffectiveConfig(): Promise<EffectiveConfig> {
  const [settings, ai, scanner, news, live, sizes] = await Promise.all([getSettings(), getAiConfig(), getScannerState(), getNewsState(), getLiveTradingStatus(), recordSizes()])
  const stores = healStores({
    settings: { paperRisk: settings.paperRisk, paperPause: settings.paperPause, paperDigest: settings.paperDigest, alerts: settings.alerts, keepRunningWhenClosed: settings.keepRunningWhenClosed, uiMode: settings.uiMode, forecast: settings.forecast },
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
      allocationQuote: live.allocationQuote,
      riskPct: live.riskPct
    }
  })
  // Every store's service has read its file by now, so the notes are whole.
  return effectiveConfig(stores, sha256, { files: configFileNotes(), healed: healNote(rawConfigFiles(), stores), sizes })
}

/** The configuration version alone, for a record that names it. */
export async function configVersionNow(): Promise<string> {
  return (await getEffectiveConfig()).configVersion
}

/** What the start read, in one line for the log: the files, the heal, the versions. A value that
 * was missing is the usual case for a file written before the value existed, and is counted; one
 * repaired or clamped is named, since someone wrote it and it was not taken as written. */
export async function describeConfigurationAtStart(): Promise<string> {
  const config = await getEffectiveConfig()
  const changed = config.healed.filter((entry) => entry.how !== 'missing').map((entry) => `${entry.path} ${entry.how} (${entry.stored} → ${entry.effective})`)
  return (
    `Configuration ${config.configVersion} (engine ${config.engineVersion}). ${describeConfigFiles(config.files)} ${describeHealed(config.healed)}` +
    (changed.length > 0 ? ` ${changed.join('; ')}.` : '') +
    (config.sizes === null ? '' : ` ${describeRecordSizes(config.sizes)}`)
  )
}
