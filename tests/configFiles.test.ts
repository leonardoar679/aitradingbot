import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NEWS_CONFIG } from '../shared/news'
import { DEFAULT_SCANNER_CONFIG } from '../shared/marketScanner'

// THE SETTINGS FILES AT START (electron/services/configFiles.ts; the V5 document, §5 and §107):
// each store's service reads its file through one reader that takes it to this code's version and
// writes it back stamped; the hard limits (shared/hardLimits.ts) are applied where each file is
// healed and where each setting is written; and the effective configuration says what the start
// read. The files are real, in a scratch folder; what the services reach beyond their files is
// mocked.

vi.mock('electron', () => ({ app: { getPath: () => process.env.CONFIG_TEST_USER_DATA } }))
vi.mock('../electron/services/aiCredentialsService', () => ({
  getDecryptedAiCredential: async () => {
    throw new Error('no key in this test')
  }
}))
vi.mock('../electron/services/livePositionsService', () => ({
  listOpenLivePositions: async () => [],
  getRealizedPnlToday: async () => 0,
  getLastObservedFeeRate: async () => null
}))
vi.mock('../electron/services/liveOrdersService', () => ({ listOpenLiveOrders: async () => [] }))
vi.mock('../electron/services/exchangeHealthService', () => ({ liveHealthReasons: () => [] }))
vi.mock('../electron/services/noticeService', () => ({ tell: () => undefined, tellNotice: async () => true }))
// The scanner and the news reader reach the exchange; the effective configuration needs only their config.
vi.mock('../electron/services/marketScannerService', () => ({ getScannerState: async () => ({ config: { ...DEFAULT_SCANNER_CONFIG } }) }))
vi.mock('../electron/services/newsService', () => ({ getNewsState: async () => ({ config: DEFAULT_NEWS_CONFIG }) }))

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'config-files-'))
  process.env.CONFIG_TEST_USER_DATA = dir
  vi.resetModules()
})

afterEach(() => {
  vi.resetModules()
})

const read = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, name), 'utf-8')) as Record<string, unknown>

describe('a settings file at start', () => {
  it('is stamped with its version on its first read, and left alone once stamped', async () => {
    writeFileSync(join(dir, 'liveTrading.json'), JSON.stringify({ dailyCapQuote: 20 }))
    const live = await import('../electron/services/liveTradingService')
    expect((await live.getLiveTradingStatus()).dailyCapQuote).toBe(20)
    expect(read('liveTrading.json')).toEqual({ dailyCapQuote: 20, configVersion: 1 })
    const files = await import('../electron/services/configFiles')
    expect(files.configFileNotes()).toEqual([{ file: 'liveTrading', basename: 'liveTrading.json', present: true, from: 0, to: 1, applied: ['stamped with its version'], newer: false }])
    expect(files.rawConfigFiles()).toEqual({ liveTrading: { dailyCapQuote: 20, configVersion: 1 } })

    vi.resetModules()
    const again = await import('../electron/services/liveTradingService')
    await again.getLiveTradingStatus()
    expect((await import('../electron/services/configFiles')).configFileNotes()[0]).toMatchObject({ from: 1, to: 1, applied: [] })
  })

  it('is left as written when it is from a newer version of the app', async () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ configVersion: 99, theme: 'light' }))
    const settings = await import('../electron/services/settingsService')
    expect((await settings.getSettings()).theme).toBe('light')
    expect(read('settings.json')).toEqual({ configVersion: 99, theme: 'light' })
    expect((await import('../electron/services/configFiles')).configFileNotes()).toEqual([
      { file: 'settings', basename: 'settings.json', present: true, from: 99, to: 99, applied: [], newer: true }
    ])
    // Written by this app, it is this app's shape, and carries this app's version.
    await settings.setSettings({ theme: 'dark' })
    expect(read('settings.json')).toMatchObject({ theme: 'dark', configVersion: 1 })
  })

  it('reads as its defaults when it is not there, and says it was not there', async () => {
    const settings = await import('../electron/services/settingsService')
    expect((await settings.getSettings()).theme).toBe('dark')
    const files = await import('../electron/services/configFiles')
    expect(files.configFileNotes()).toEqual([{ file: 'settings', basename: 'settings.json', present: false, from: null, to: 1, applied: [], newer: false }])
    expect(files.rawConfigFiles()).toEqual({})
    // Written for the first time, it carries its version.
    await settings.setSettings({ theme: 'light' })
    expect(read('settings.json')).toMatchObject({ theme: 'light', configVersion: 1 })
  })
})

describe('the hard limits where the files are read and written', () => {
  it('hold the daily loss limit within the cap on read, refuse one above it on write, and take it down with a lowered cap', async () => {
    writeFileSync(join(dir, 'liveTrading.json'), JSON.stringify({ dailyCapQuote: 20, dailyLossLimitQuote: 60, maxOrderQuote: 40 }))
    const live = await import('../electron/services/liveTradingService')
    const status = await live.getLiveTradingStatus()
    expect(status.dailyLossLimitQuote).toBe(20)
    expect(status.maxOrderQuote).toBe(25)
    await expect(live.setLiveTradingConfig({ dailyLossLimitQuote: 30 })).rejects.toThrow('A daily loss limit of 30 is above the daily cap of 20')
    expect((await live.setLiveTradingConfig({ dailyLossLimitQuote: 15 })).dailyLossLimitQuote).toBe(15)
    expect((await live.setLiveTradingConfig({ dailyCapQuote: 10 })).dailyLossLimitQuote).toBe(10)
    // Raised together: the cap first, so the loss limit is checked against the new cap.
    const both = await live.setLiveTradingConfig({ dailyCapQuote: 100, dailyLossLimitQuote: 80 })
    expect([both.dailyCapQuote, both.dailyLossLimitQuote]).toEqual([100, 80])
    expect(read('liveTrading.json')).toMatchObject({ dailyCapQuote: 100, dailyLossLimitQuote: 80, maxOrderQuote: 25, configVersion: 1 })
  })

  it('hold the AI budget to its ceiling on read, and refuse one over it on write', async () => {
    writeFileSync(join(dir, 'aiConfig.json'), JSON.stringify({ dailyCapUsd: 500 }))
    const ai = await import('../electron/services/aiConfigService')
    expect((await ai.getAiConfig()).dailyCapUsd).toBe(100)
    await expect(ai.setAiConfig({ dailyCapUsd: 200 })).rejects.toThrow('The daily AI budget cannot be over 100 dollars a day: that is a ceiling in the code, not a setting.')
    expect((await ai.setAiConfig({ dailyCapUsd: 100 })).dailyCapUsd).toBe(100)
    expect(read('aiConfig.json')).toMatchObject({ dailyCapUsd: 100, configVersion: 1 })
  })
})

describe('the effective configuration at start', () => {
  it('names each file read and every value the heal changed, and says so in one line for the log', async () => {
    writeFileSync(join(dir, 'aiConfig.json'), JSON.stringify({ dailyCapUsd: 500, defaultModel: 'openai/gpt-5-mini', enabledModels: ['openai/gpt-5-mini'] }))
    writeFileSync(join(dir, 'liveTrading.json'), JSON.stringify({ dailyCapQuote: 20, dailyLossLimitQuote: 60, configVersion: 1 }))
    const service = await import('../electron/services/effectiveConfigService')
    const config = await service.getEffectiveConfig()
    expect(config.files.map((file) => [file.file, file.present, file.from, file.applied.length])).toEqual([
      ['settings', false, null, 0],
      ['aiConfig', true, 0, 1],
      ['liveTrading', true, 1, 0]
    ])
    expect(config.healed).toContainEqual({ file: 'aiConfig', path: 'ai.dailyCapUsd', how: 'clamped', stored: '500', effective: '100' })
    expect(config.healed).toContainEqual({ file: 'liveTrading', path: 'live.dailyLossLimitQuote', how: 'clamped', stored: '60', effective: '20' })
    expect(config.healed).toContainEqual({ file: 'liveTrading', path: 'live.maxOrderQuote', how: 'missing', stored: '—', effective: '10' })
    expect(config.healed.filter((entry) => entry.file === 'settings')).toEqual([])
    const line = await service.describeConfigurationAtStart()
    expect(line).toContain(`Configuration ${config.configVersion} (engine ${config.engineVersion}).`)
    expect(line).toContain('aiConfig.json stamped with its version (from 0 to 1)')
    expect(line).toContain('2 were clamped to a hard limit')
    expect(line).toContain('ai.dailyCapUsd clamped (500 → 100)')
  })
})
