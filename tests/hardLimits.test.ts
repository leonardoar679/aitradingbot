import { describe, expect, it } from 'vitest'
import { AI_OPPORTUNITY_MAX_MODELS } from '../shared/aiOpportunity'
import { AI_WATCH_EVENT_LIMITS, DEFAULT_AI_WATCH } from '../shared/aiWatch'
import { ENGINE_CONSTANTS, defaultStores, describeHealed, effectiveConfig, healNote, healStores, stableJson, type HealedValue } from '../shared/appConfig'
import { DEFAULT_CONFIG } from '../shared/appDefaults'
import { CONFIG_FILE_VERSION, CONFIG_MIGRATIONS, describeConfigFiles, migrateConfigFile, stampedConfig, type ConfigFileNote } from '../shared/configMigration'
import { HARD_LIMITS, clampedToHardLimit, dailyLossWithinCap, hardLimitProblem } from '../shared/hardLimits'
import { DEFAULT_LIVE_LIMITS, LIVE_RISK_PCT_CHOICES } from '../shared/liveLimits'
import { DEFAULT_SCANNER_CONFIG, SCANNER_UNIVERSE_SIZES } from '../shared/marketScanner'
import { PAPER_RISK_PCT_CHOICES } from '../shared/paperRisk'

// THE CONFIGURATION, WHOLE (the V5 document, §4-7 and §107; V5 Stage 1, 8 October 2026):
// one object of every default (shared/appDefaults.ts DEFAULT_CONFIG), the hard limits above every
// setting (shared/hardLimits.ts), a version on each settings file with the steps between versions
// (shared/configMigration.ts), and the note of what the heal changed (shared/appConfig.ts healNote).

const sha256 = (text: string): string => {
  // A hash is only needed to be deterministic here; the main process uses its own crypto.
  let h = 0
  for (const char of text) h = (h * 31 + char.charCodeAt(0)) >>> 0
  return h.toString(16).padStart(12, '0')
}

describe('the hard limits', () => {
  it('top every choice list, so a list cannot drift above a ceiling', () => {
    expect(Math.max(...PAPER_RISK_PCT_CHOICES)).toBe(HARD_LIMITS.riskPctMax)
    expect(Math.max(...LIVE_RISK_PCT_CHOICES)).toBe(HARD_LIMITS.riskPctMax)
    expect(Math.max(...AI_WATCH_EVENT_LIMITS)).toBe(HARD_LIMITS.watchEventsPerDayMax)
    expect(AI_OPPORTUNITY_MAX_MODELS).toBe(HARD_LIMITS.watchModelsMax)
    expect(Math.max(...SCANNER_UNIVERSE_SIZES)).toBe(HARD_LIMITS.scannerUniverseMax)
    expect(DEFAULT_LIVE_LIMITS.maxOrderQuote).toBeLessThanOrEqual(HARD_LIMITS.liveMaxOrderQuote)
    expect(DEFAULT_LIVE_LIMITS.dailyLossLimitQuote).toBeLessThanOrEqual(DEFAULT_LIVE_LIMITS.dailyCapQuote)
  })

  it('are engine constants, so a change moves the engine version', () => {
    expect(ENGINE_CONSTANTS.hardLimits).toBe(HARD_LIMITS)
    expect(ENGINE_CONSTANTS.configFiles.version).toBe(CONFIG_FILE_VERSION)
  })

  it('hold a loss limit within the cap, a stored number to its ceiling, and refuse a written one over it', () => {
    expect(dailyLossWithinCap(60, 50)).toBe(50)
    expect(dailyLossWithinCap(15, 50)).toBe(15)
    expect(clampedToHardLimit(500, 1, 100)).toBe(100)
    expect(clampedToHardLimit(100, 1, 100)).toBe(100)
    expect(clampedToHardLimit(7, 1, 100)).toBe(7)
    expect(clampedToHardLimit(-5, 1, 100)).toBe(0)
    expect(clampedToHardLimit(Number.NaN, 1, 100)).toBe(1)
    expect(clampedToHardLimit('500', 1, 100)).toBe(1)
    expect(hardLimitProblem('The daily AI budget', 100, 100, ' dollars a day')).toBeNull()
    expect(hardLimitProblem('The daily AI budget', 100.5, 100, ' dollars a day')).toBe('The daily AI budget cannot be over 100 dollars a day: that is a ceiling in the code, not a setting.')
  })
})

describe('the default configuration', () => {
  it('is what an empty profile heals to, exactly, and what the effective configuration starts from', () => {
    expect(defaultStores()).toBe(DEFAULT_CONFIG)
    const healed = healStores({
      settings: {},
      ai: { defaultModel: DEFAULT_CONFIG.ai.defaultModel, enabledModels: [...DEFAULT_CONFIG.ai.enabledModels], dailyCapUsd: DEFAULT_CONFIG.ai.dailyCapUsd, callsPerMinute: DEFAULT_CONFIG.ai.callsPerMinute, watch: undefined, watchPaper: undefined, additions: undefined },
      scanner: { ...DEFAULT_SCANNER_CONFIG },
      news: undefined,
      live: { ...DEFAULT_CONFIG.live }
    })
    expect(healed).toEqual(DEFAULT_CONFIG)
    expect(DEFAULT_CONFIG.live).toEqual({ ...DEFAULT_LIVE_LIMITS, hardMaxOrderQuote: HARD_LIMITS.liveMaxOrderQuote })
    // Public data on, money and models off.
    expect(DEFAULT_CONFIG.scanner.enabled).toBe(true)
    expect(DEFAULT_CONFIG.watch.enabled).toBe(false)
    expect(DEFAULT_CONFIG.watchPaper.enabled).toBe(false)
    expect(DEFAULT_CONFIG.news.enabled).toBe(false)
    expect(DEFAULT_CONFIG.ai.dailyCapUsd).toBe(1)
  })

  it('composes with no note of a start when none is given', () => {
    const config = effectiveConfig(DEFAULT_CONFIG, sha256)
    expect(config.files).toEqual([])
    expect(config.healed).toEqual([])
    expect(stableJson(config.engine.hardLimits)).toBe(stableJson(HARD_LIMITS))
  })
})

describe('a settings file and its version', () => {
  it('is stamped on its first read, left alone once stamped, and left as written from a newer app', () => {
    const first = migrateConfigFile('scanner', { enabled: true })
    expect(first).toEqual({ file: 'scanner', raw: { enabled: true, configVersion: 1 }, from: 0, to: 1, applied: ['stamped with its version'], newer: false })
    const again = migrateConfigFile('scanner', first.raw)
    expect(again).toEqual({ file: 'scanner', raw: { enabled: true, configVersion: 1 }, from: 1, to: 1, applied: [], newer: false })
    const newer = migrateConfigFile('scanner', { enabled: true, configVersion: 2 })
    expect(newer).toEqual({ file: 'scanner', raw: { enabled: true, configVersion: 2 }, from: 2, to: 2, applied: [], newer: true })
  })

  it('reads anything that is not an object as an empty file, and a version that is not a whole number as none', () => {
    for (const junk of ['x', null, undefined, 42, [1]]) expect(migrateConfigFile('news', junk).raw, JSON.stringify(junk)).toEqual({ configVersion: 1 })
    expect(migrateConfigFile('news', { configVersion: 'two' }).from).toBe(0)
    expect(migrateConfigFile('news', { configVersion: 1.5 }).from).toBe(0)
    expect(migrateConfigFile('news', { configVersion: -1 }).from).toBe(0)
  })

  it('has its steps in order, the last of them being the version the code writes', () => {
    expect(CONFIG_MIGRATIONS.map((step) => step.to)).toEqual(CONFIG_MIGRATIONS.map((_step, index) => index + 1))
    expect(CONFIG_MIGRATIONS[CONFIG_MIGRATIONS.length - 1].to).toBe(CONFIG_FILE_VERSION)
    expect(stampedConfig({ enabled: false })).toEqual({ enabled: false, configVersion: CONFIG_FILE_VERSION })
  })

  it('is described in one line: fresh, absent, migrated, newer, or nothing to do', () => {
    const note = (file: ConfigFileNote['file'], extra: Partial<ConfigFileNote>): ConfigFileNote => ({
      file,
      basename: `${file}.json`,
      present: true,
      from: 1,
      to: 1,
      applied: [],
      newer: false,
      ...extra
    })
    expect(describeConfigFiles([note('settings', { present: false, from: null }), note('aiConfig', { present: false, from: null })])).toBe(
      'A fresh install: every settings file is new, written at version 1 when first set.'
    )
    expect(describeConfigFiles([note('settings', { present: false, from: null }), note('aiConfig', { from: 0, applied: ['stamped with its version'] })])).toBe(
      '1 settings file was not there yet and starts at the defaults. aiConfig.json stamped with its version (from 0 to 1).'
    )
    expect(describeConfigFiles([note('settings', {}), note('scanner', { from: 3, to: 3, newer: true })])).toBe('scanner.json is from a newer version of the app and was left as written.')
    expect(describeConfigFiles([note('settings', {}), note('news', {})])).toBe('Every settings file is at version 1; nothing was migrated.')
  })
})

describe('the note of what the heal changed', () => {
  const model = DEFAULT_CONFIG.ai.defaultModel
  const live = { maxOrderQuote: 10, hardMaxOrderQuote: HARD_LIMITS.liveMaxOrderQuote, dailyCapQuote: 20, dailyLossLimitQuote: 20, allocationQuote: null, riskPct: 0.25 }

  function healedOf(raw: Parameters<typeof healNote>[0], ai: { watch?: unknown; dailyCapUsd?: number; enabledModels?: string[] } = {}): HealedValue[] {
    const stores = healStores({
      settings: raw.settings ?? {},
      ai: { defaultModel: model, enabledModels: ai.enabledModels ?? [model], dailyCapUsd: ai.dailyCapUsd ?? 1, callsPerMinute: 30, watch: ai.watch, watchPaper: undefined, additions: undefined },
      scanner: { ...DEFAULT_SCANNER_CONFIG },
      news: raw.news,
      live
    })
    return healNote(raw, stores)
  }

  it('names a value clamped to a ceiling, one repaired, and one missing, each with the file it came from', () => {
    const watch = { ...DEFAULT_AI_WATCH, enabled: true, models: ['x/not-enabled'] }
    const healed = healedOf(
      {
        aiConfig: { dailyCapUsd: 500, defaultModel: model, enabledModels: [model], callsPerMinute: 30, watch },
        liveTrading: { maxOrderQuote: 10, dailyCapQuote: 20, dailyLossLimitQuote: 60, allocationQuote: null, riskPct: 0.25 }
      },
      { watch, dailyCapUsd: 100 }
    )
    expect(healed).toContainEqual({ file: 'aiConfig', path: 'ai.dailyCapUsd', how: 'clamped', stored: '500', effective: '100' })
    expect(healed).toContainEqual({ file: 'liveTrading', path: 'live.dailyLossLimitQuote', how: 'clamped', stored: '60', effective: '20' })
    expect(healed).toContainEqual({ file: 'aiConfig', path: 'watch.enabled', how: 'repaired', stored: 'true', effective: 'false' })
    expect(healed).toContainEqual({ file: 'aiConfig', path: 'watch.models', how: 'repaired', stored: '["x/not-enabled"]', effective: '[]' })
    expect(healed).toContainEqual({ file: 'aiConfig', path: 'watchPaper.enabled', how: 'missing', stored: '—', effective: 'false' })
    // The ceiling on a real order is code, not a stored value; the digest's last day is a record.
    expect(healed.map((entry) => entry.path)).not.toContain('live.hardMaxOrderQuote')
    expect(healed.map((entry) => entry.path)).not.toContain('paperDigest.lastDay')
    // settings.json was not there: nothing of it is listed value by value.
    expect(healed.filter((entry) => entry.file === 'settings')).toEqual([])
    expect(describeHealed(healed)).toMatch(/^\d+ values were missing and took their defaults; 2 were repaired; 2 were clamped to a hard limit\.$/)
  })

  it('reads a value as written whatever order a list was stored in, and a stored number under its ceiling as itself', () => {
    const healed = healedOf({ aiConfig: { dailyCapUsd: 7, defaultModel: model, enabledModels: ['z/model', model], callsPerMinute: 30 } }, { dailyCapUsd: 7, enabledModels: [model, 'z/model'] })
    expect(healed.filter((entry) => entry.path.startsWith('ai.'))).toEqual([])
  })

  it('reads a news file written before the Monitoring Tag as the delisting it was', () => {
    const healed = healedOf({ news: { enabled: true, notifyHeld: false, askModels: true, paperShort: { enabled: false, stakeQuote: 100 } } })
    expect(healed.filter((entry) => entry.path.startsWith('news.delisting'))).toEqual([])
    expect(healed).toContainEqual({ file: 'news', path: 'news.monitoringTag.notifyHeld', how: 'missing', stored: '—', effective: 'true' })
  })

  it('says in one sentence what was done, and that nothing was when nothing was', () => {
    expect(describeHealed([])).toBe('Every stored value was read as written.')
    const entry = (how: HealedValue['how']): HealedValue => ({ file: 'settings', path: 'x', how, stored: '1', effective: '2' })
    expect(describeHealed([entry('missing')])).toBe('1 value was missing and took its default.')
    expect(describeHealed([entry('repaired'), entry('clamped'), entry('clamped')])).toBe('1 was repaired; 2 were clamped to a hard limit.')
  })
})
