import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { holdsSecretField } from '../shared/research'
import { readZip } from '../shared/zip'

// THE RESEARCH FOLDER, IN THE MAIN PROCESS (electron/services/researchFolderService.ts; V7.2-R Stage 2): on a
// throwaway profile seeded with key files and a settings file that still holds an old key, the configuration's
// snapshots leave every secret out; a paper order's life is logged as the settings are written; a report is
// kept by its stamp; and the export packs the fortnight's records with a manifest whose checksums hold -- and
// neither a key file nor a secret, nor a model file, is anywhere in it.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA, getVersion: () => '0.1.0' } }))
vi.mock('../electron/services/effectiveConfigService', () => ({
  getEffectiveConfig: async () => ({ engineVersion: 'e123', configVersion: 'c456', engine: {}, stores: { ai: { apiKey: 'NESTED-SECRET' } }, files: [], healed: [], sizes: null })
}))
vi.mock('../electron/services/aiConfigService', () => ({
  getAiConfig: async () => ({
    defaultModel: 'anthropic/claude-opus-5.5',
    enabledModels: ['anthropic/claude-opus-5.5'],
    route: null,
    dailyCapUsd: 5,
    spentTodayUsd: 0,
    watch: { enabled: true, models: ['anthropic/claude-opus-5.5'], maxEventsPerDay: 10, minBand: 'urgent', firstModelGates: false, confirmLive: false, askAt: 'detected' },
    watchPaper: { enabled: false, model: null, stakeQuote: 100, maxOpen: 3, maxSameSide: 2, pauseAfterLosses: 3, dropOnBtcMovePct: 1 },
    callsPerMinute: 30,
    additions: { news: true, why: true, exit: true, review: true, daily: true },
    roles: null,
    // Not a field of the AI config: here so that its snapshot is seen to go through the redactor.
    token: 'AI-CONFIG-SECRET'
  })
}))

const NOW = Date.parse('2026-10-20T07:00:00Z') / 1000
const SECRETS = ['SECRET-ENC', 'SECRET-AI', 'sk-or-SECRET', 'SECRET-LS', 'LEGACY-SECRET', 'NESTED-SECRET', 'PARAM-SECRET', 'REPORT-SECRET', 'AI-CONFIG-SECRET']

const dir = (): string => process.env.AI_TEST_USER_DATA as string
function put(path: string, body: string): void {
  mkdirSync(join(dir(), path, '..'), { recursive: true })
  writeFileSync(join(dir(), path), body)
}

function seed(): void {
  put('credentials.json', JSON.stringify({ binance: { apiKeyEnc: 'SECRET-ENC' } }))
  put('aiCredentials.json', JSON.stringify({ apiKeyEnc: 'SECRET-AI' }))
  put('aiCredentials.json.bak-openai-20261003-182504', JSON.stringify({ apiKey: 'sk-or-SECRET' }))
  put('Local State', JSON.stringify({ os_crypt: { encrypted_key: 'SECRET-LS' } }))
  put('settings.json', JSON.stringify({ apiKey: 'LEGACY-SECRET', theme: 'dark', bots: [{ id: 'gpt', name: 'GPT BTC hourly', enabled: true, strategyId: 'gpt-intraday', aiModel: 'anthropic/claude-opus-5.5' }], executors: [], paperAccount: { balances: { USDT: 10000 }, initialBalances: { USDT: 10000 }, createdAt: 1, ledger: [] } }))
  put('forecasts/predictions-2026-10.jsonl', '{"v":"forecast-record-v1","id":"a"}\n')
  put('forecasts/outcomes-2026-10.jsonl', '{"v":"forecast-record-v1","id":"a","h":"hour1"}\n')
  put('forecasts/passes-2026-10.jsonl', '{"t":1}\n')
  put('forecasts/predictions-2026-08.jsonl', '{"old":true}\n')
  put('forecasts/tape-2026-10-19.jsonl', '{"v":"tape-v1"}\n')
  put('forecasts/tape-2026-09-01.jsonl', '{"v":"tape-v1","old":true}\n')
  put('forecasts/aci.json', '{"calibrationRun":"run-20261017-0030","levels":{},"updatedAt":0}')
  const row = (at: number, model: string): string =>
    JSON.stringify({ id: `r${at}`, at, source: 'watch', status: 'ok', model, provider: 'Test', servedModel: model, promptVersion: 'p', contextVersion: 'c', schemaVersion: 's', exchange: 'binance', symbol: 'SOLUSDT', interval: '1m', candleTime: at, position: 'flat', referencePrice: 1, usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.001, latencyMs: 100 }, error: null, recommendation: 'hold', confidence: 0.5, rationale: 'x', detail: null })
  put('aiLedger/calls-2026-10.jsonl', [row(NOW - 3600, 'anthropic/claude-opus-5.5'), row(Date.parse('2026-10-01T00:00:00Z') / 1000, 'openai/gpt-5-mini')].join('\n') + '\n')
  put('forecastData/BTCUSDT-2026-10.jsonl', '[1,2,3]\n')
  put('forecastData/BTCUSDT-2026-08.jsonl', '[0,0,0]\n')
  put('forecastModels/current.json', JSON.stringify({ runId: 'run-20261017-0030', foldsRunId: 'run-20261017-0030', fittedAt: 1, promotions: [] }))
  put('forecastModels/training-2026-10.jsonl', '{"kind":"fit"}\n')
  put('forecastModels/run-20261017-0030/calibration.json', '{"file":"calibration"}')
  put('forecastModels/run-20261017-0030/hour1.json', '{"file":"models"}')
  put('marketEvents/events-2026-10.jsonl', '{"e":1}\n')
  put('news/feed-2026-10.jsonl', '{"n":1}\n')
  put('alerts/alerts-2026-10.jsonl', '{"a":1}\n')
  put('paperRefusals/refusals-2026-10.jsonl', '{"r":1}\n')
}

async function services() {
  const research = await import('../electron/services/researchFolderService')
  const settings = await import('../electron/services/settingsService')
  research.researchForTest.reset()
  return { ...research, ...settings }
}

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'research-folder-'))
  seed()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW * 1000))
})

afterEach(() => vi.useRealTimers())

const research = (path: string): string => join(dir(), 'trader-spider-research', path)

describe('the configuration as the app runs under it', () => {
  it('is written with every secret field left out, and who asks which model beside it', async () => {
    const { writeConfigSnapshots } = await services()
    await writeConfigSnapshots()
    for (const name of ['effective-config.json', 'ai-config.json', 'settings.json', 'model-routing.json']) {
      const body = readFileSync(research(`config/${name}`), 'utf-8')
      expect(holdsSecretField(JSON.parse(body)), name).toBe(false)
      for (const secret of SECRETS) expect(body, `${name} holds ${secret}`).not.toContain(secret)
    }
    expect(JSON.parse(readFileSync(research('config/settings.json'), 'utf-8'))).toMatchObject({ theme: 'dark', bots: [{ id: 'gpt' }] })
    const routing = JSON.parse(readFileSync(research('config/model-routing.json'), 'utf-8'))
    expect(routing.callers.find((caller: { id: string }) => caller.id === 'bot:gpt')).toMatchObject({ asks: ['anthropic/claude-opus-5.5'] })
  })
})

describe('the trades as the settings are written', () => {
  it("logs a paper order's opening and end, and the account's money, once each, without a secret", async () => {
    const { setSettings, onSettingsWritten, researchForTest, researchWritesSettled } = await services()
    onSettingsWritten(researchForTest.noteSettings)
    const executor = { id: 'p1', name: 'x', type: 'position', exchange: 'binance', symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', createdAt: NOW - 60, status: 'active', stoppedAt: null, keepPosition: false, mode: 'paper', params: { side: 'buy', amountQuote: 25, apiKey: 'PARAM-SECRET' }, lab: { strategy: 'strict', qualified: ['strict'] } }
    const ledger = [{ id: 'l1', at: NOW - 60, asset: 'USDT', delta: -25, reason: 'allocate', executorId: 'p1', note: '' }]
    await setSettings({ executors: [executor] as never, paperAccount: { balances: { USDT: 9975 }, initialBalances: { USDT: 10000 }, createdAt: 1, ledger } as never })
    await setSettings({ executors: [{ ...executor, status: 'stopped', stoppedAt: NOW, lab: { ...executor.lab, result: { exit: 'stop_loss', pnlQuote: -0.3, closedAt: NOW } } }] as never })
    await researchWritesSettled()
    const orders = readFileSync(research('trades/paper-orders-2026-10.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
    expect(orders.map((entry) => entry.kind)).toEqual(['opened', 'closed'])
    expect(orders[0]).toMatchObject({ origin: 'lab', strategy: 'strict', params: { side: 'buy', amountQuote: 25 } })
    expect(orders[1].result).toEqual({ exit: 'stop_loss', pnlQuote: -0.3, closedAt: NOW })
    expect(readFileSync(research('trades/paper-orders-2026-10.jsonl'), 'utf-8')).not.toContain('PARAM-SECRET')
    expect(readFileSync(research('trades/paper-account-2026-10.jsonl'), 'utf-8').trim().split('\n')).toHaveLength(1)
  })
})

describe('the reports', () => {
  it('are kept by their stamp with the latest of each kind, and refuse a kind or a stamp that is not one', async () => {
    const { writeResearchReport, getResearchStatus } = await services()
    await writeResearchReport({ kind: 'hour', stamp: '2026-10-20-06', report: { session: { passed: true }, forecast: { horizons: {} }, paper: { lab: [] }, apiKey: 'REPORT-SECRET' } })
    const kept = readFileSync(research('reports/hour-2026-10-20-06.json'), 'utf-8')
    expect(kept).not.toContain('REPORT-SECRET')
    expect(JSON.parse(kept)).toMatchObject({ kind: 'hour', stamp: '2026-10-20-06', session: { passed: true } })
    expect(existsSync(research('reports/forecast-accuracy.json'))).toBe(true)
    expect(existsSync(research('reports/paper-performance.json'))).toBe(true)
    await writeResearchReport({ kind: 'day', stamp: '2026-10-19', report: { daily: { day: '2026-10-19' } } })
    expect(JSON.parse(readFileSync(research('reports/daily-summary.json'), 'utf-8'))).toMatchObject({ kind: 'day', stamp: '2026-10-19' })
    await expect(writeResearchReport({ kind: 'week', stamp: '2026-10-19', report: {} })).rejects.toThrow(/an hour's or a day's/)
    await expect(writeResearchReport({ kind: 'hour', stamp: '../../x', report: {} })).rejects.toThrow(/Not a stamp/)
    expect(await getResearchStatus()).toMatchObject({ latestHour: '2026-10-20-06', latestDay: '2026-10-19' })
  })
})

describe('the export', () => {
  it("packs the fortnight's records, the derived AI log and the calibration in use, with a manifest whose checksums hold, and no key file, secret or model file anywhere", async () => {
    const { exportResearchBundle, writeResearchReport } = await services()
    await writeResearchReport({ kind: 'hour', stamp: '2026-10-20-06', report: { session: {} } })
    const made = await exportResearchBundle('manual')
    expect(made.name).toBe('trader-spider-report-2026-10-20-0700.zip')
    const entries = readZip(new Uint8Array(readFileSync(made.path)), (data) => new Uint8Array(inflateRawSync(data)))
    const names = entries.map((entry) => entry.name).sort()
    expect(names).toEqual(
      [
        'config/ai-config.json',
        'config/effective-config.json',
        'config/model-routing.json',
        'config/settings.json',
        'forecasts/aci.json',
        'forecasts/models/calibration.json',
        'forecasts/models/current.json',
        'forecasts/models/training-2026-10.jsonl',
        'forecasts/outcomes-2026-10.jsonl',
        'forecasts/passes-2026-10.jsonl',
        'forecasts/predictions-2026-10.jsonl',
        'logs/ai-ledger/calls-2026-10.jsonl',
        'logs/ai-requests.csv',
        'logs/ai-requests.jsonl',
        'logs/alerts/alerts-2026-10.jsonl',
        'manifest.json',
        'market/events/events-2026-10.jsonl',
        'market/news/feed-2026-10.jsonl',
        'market/price-history/BTCUSDT-2026-10.jsonl',
        'market/tape/tape-2026-10-19.jsonl',
        'reports/hour-2026-10-20-06.json',
        'trades/paper-trades.csv',
        'trades/refusals/refusals-2026-10.jsonl'
      ].sort()
    )
    // No secret, in any file, in any form.
    for (const entry of entries) {
      const body = new TextDecoder().decode(entry.data)
      for (const secret of SECRETS) expect(body, `${entry.name} holds ${secret}`).not.toContain(secret)
    }
    // The AI log holds the window's calls only, with the model asked and the one that answered.
    const ai = new TextDecoder().decode(entries.find((entry) => entry.name === 'logs/ai-requests.jsonl')!.data).trim().split('\n').map((line) => JSON.parse(line))
    expect(ai).toEqual([expect.objectContaining({ component: 'watch', asked: 'anthropic/claude-opus-5.5', served: 'anthropic/claude-opus-5.5', fallback: null })])
    // Every file is in the manifest, each checksum its file's.
    const manifest = JSON.parse(new TextDecoder().decode(entries.find((entry) => entry.name === 'manifest.json')!.data))
    expect(manifest).toMatchObject({ version: 'research-v1', reason: 'manual', windowDays: 14, app: { version: '0.1.0', engineVersion: 'e123', configVersion: 'c456' } })
    expect(manifest.files.map((file: { path: string }) => file.path).sort()).toEqual(names.filter((name) => name !== 'manifest.json'))
    for (const file of manifest.files as { path: string; bytes: number; sha256: string }[]) {
      const data = entries.find((entry) => entry.name === file.path)!.data
      expect(file.bytes).toBe(data.length)
      expect(file.sha256).toBe(createHash('sha256').update(data).digest('hex'))
    }
  })

  it('lists the AI requests and the paper trades as tables', async () => {
    const { exportResearchBundle, setSettings, onSettingsWritten, researchForTest } = await services()
    onSettingsWritten(researchForTest.noteSettings)
    const executor = { id: 'p1', name: 'x', type: 'position', exchange: 'binance', symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', createdAt: NOW - 600, status: 'active', stoppedAt: null, keepPosition: false, mode: 'paper', params: { side: 'buy', amountQuote: 25 }, forecast: { predictionId: 'f1', horizon: 'hour1' } }
    await setSettings({ executors: [executor] as never })
    await setSettings({ executors: [{ ...executor, status: 'stopped', stoppedAt: NOW - 60, forecast: { ...executor.forecast, result: { exit: 'take_profit', pnlQuote: 0.42, closedAt: NOW - 60 } } }] as never })
    const made = await exportResearchBundle('manual')
    const entries = readZip(new Uint8Array(readFileSync(made.path)), (data) => new Uint8Array(inflateRawSync(data)))
    const table = (name: string): string[] => new TextDecoder().decode(entries.find((entry) => entry.name === name)!.data).trim().split('\r\n')
    expect(table('trades/paper-trades.csv')).toEqual([
      'id,origin,strategy,mode,exchange,symbol,side,stakeQuote,openedAt,endedAt,end,exit,pnlQuote',
      'p1,forecast,,paper,binance,SOLUSDT,buy,25,2026-10-20T06:50:00Z,2026-10-20T06:59:00Z,closed,take_profit,0.42'
    ])
    const requests = table('logs/ai-requests.csv')
    expect(requests[0]).toBe('time,component,role,asked,served,servedMismatch,fallback,provider,status,latencyMs,promptTokens,completionTokens,costUsd,error')
    expect(requests.slice(1)).toEqual(['2026-10-20T06:00:00Z,watch,,anthropic/claude-opus-5.5,anthropic/claude-opus-5.5,,,Test,ok,100,10,5,0.001,'])
  })

  it('keeps the newest fourteen', async () => {
    const { exportResearchBundle } = await services()
    mkdirSync(research('exports'), { recursive: true })
    for (let k = 1; k <= 15; k++) writeFileSync(research(`exports/trader-spider-report-2026-10-${String(k).padStart(2, '0')}-0005.zip`), 'old')
    await exportResearchBundle('daily')
    const kept = readdirSync(research('exports')).sort()
    expect(kept).toHaveLength(14)
    expect(kept[kept.length - 1]).toBe('trader-spider-report-2026-10-20-0700.zip')
    expect(kept[0]).toBe('trader-spider-report-2026-10-03-0005.zip')
  })
})

describe('the AI request log', () => {
  it('is written as the ledger appends each call: who asked, the model asked and the one that answered', async () => {
    const { researchForTest, researchWritesSettled } = await services()
    const ledger = await import('../electron/services/aiLedgerService')
    ledger.onAiCallAppended(researchForTest.noteAiCall)
    const row = { id: 'n1', at: NOW, source: 'bot', botId: 'gpt', role: 'decide', status: 'ok', model: 'anthropic/claude-opus-5.5', provider: 'Anthropic', servedModel: 'anthropic/claude-opus-5.5', promptVersion: 'p', contextVersion: 'c', schemaVersion: 's', exchange: 'binance', symbol: 'BTCUSDT', interval: '1h', candleTime: NOW - 3600, position: 'flat', referencePrice: 1, usage: { promptTokens: 3000, completionTokens: 900, costUsd: 0.04, latencyMs: 8000 }, error: null, recommendation: 'hold', confidence: 0.5, rationale: 'x', detail: null }
    await ledger.appendAiCall(row as never)
    await researchWritesSettled()
    const lines = readFileSync(research('logs/ai-requests.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
    expect(lines).toEqual([{ at: NOW, component: 'bot:gpt', role: 'decide', asked: 'anthropic/claude-opus-5.5', served: 'anthropic/claude-opus-5.5', servedMismatch: null, fallback: null, provider: 'Anthropic', status: 'ok', latencyMs: 8000, promptTokens: 3000, completionTokens: 900, costUsd: 0.04, error: null }])
    // The ledger's own row is there too: the log is beside it, not in its place.
    expect(readFileSync(join(dir(), 'aiLedger/calls-2026-10.jsonl'), 'utf-8')).toContain('"id":"n1"')
  })
})

describe('the logs', () => {
  it('are rotated past their limit into gzip files, the newest kept', async () => {
    const { rotateLog } = await services()
    mkdirSync(research('logs'), { recursive: true })
    const path = research('logs/errors.jsonl')
    writeFileSync(path, '{"line":1}\n'.repeat(20))
    expect(await rotateLog(path, 10_000, 2)).toBe(false)
    expect(await rotateLog(path, 100, 2)).toBe(true)
    expect(readFileSync(path, 'utf-8')).toBe('')
    expect(gunzipSync(readFileSync(research('logs/errors.1.jsonl.gz'))).toString()).toBe('{"line":1}\n'.repeat(20))
    writeFileSync(path, '{"line":2}\n'.repeat(20))
    await rotateLog(path, 100, 2)
    writeFileSync(path, '{"line":3}\n'.repeat(20))
    await rotateLog(path, 100, 2)
    expect(gunzipSync(readFileSync(research('logs/errors.1.jsonl.gz'))).toString()).toContain('"line":3')
    expect(gunzipSync(readFileSync(research('logs/errors.2.jsonl.gz'))).toString()).toContain('"line":2')
    expect(existsSync(research('logs/errors.3.jsonl.gz'))).toBe(false)
  })
})
