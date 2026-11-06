import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraderAnalysis, TraderList } from '../shared/traders/traderAnalysis'

// FINDING TRADERS (electron/services/discoveryService.ts; V9 Stage 3): the two rankings read once a day in the
// background lane, the day's picks kept as found, then each read and analysed one at a time, half an hour apart; a
// refusal kept as a skip; nothing read when it is switched off; a read that found neither tried again an hour after.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => ({}), setSettings: async () => ({}) }))
vi.mock('../electron/services/traderService', () => ({ listTraders: async () => ({ traders: [], analysed: 0 }), importTrader: async () => ({ refused: 'no' }), analyzeTrader: async () => null }))
vi.mock('../electron/services/taskWorkerService', () => ({ runInWorker: async () => ({ ok: false, reason: 'error', message: 'no worker in a test' }) }))
vi.mock('../electron/services/okxClient', () => ({ okxGet: async () => [], OKX_PATHS: { current: '/current' } }))
vi.mock('../electron/services/hyperliquidClient', () => ({ hyperliquidInfo: async () => null }))
vi.mock('../electron/services/forecastService', () => ({ latestForecasts: () => [] }))
vi.mock('../electron/services/predictionLedgerService', () => ({ recordTopTraderCalls: async () => 0 }))
vi.mock('../electron/services/effectiveConfigService', () => ({ getEffectiveConfig: async () => ({ engineVersion: 'e', configVersion: 'c' }) }))
import type { SourcePrediction } from '../shared/evaluation/predictionRecord'

const T0 = Date.UTC(2026, 10, 6, 6, 0, 0)
const address = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`
const hl = (n: number, name: string | null, all: number) => ({ venue: 'hyperliquid' as const, id: address(n), name, accountUsd: 1e6, pnlAllTime: all, last30d: 1e4, volume30d: 1e6, leadDays: null, copiers: null, winRatio: null })
const okxPage = (codes: string[], total: number): unknown[] => [
  {
    totalPage: String(total),
    ranks: codes.map((code, k) => ({
      uniqueCode: code,
      nickName: `okx ${code.slice(-1)}`,
      pnl: String(1e6 - k),
      aum: '200000',
      leadDays: '400',
      copyTraderNum: '10',
      winRatio: '0.5',
      pnlRatios: [
        { beginTs: String(T0), pnlRatio: '1.2' },
        { beginTs: String(T0 - 30 * 86_400_000), pnlRatio: '1.0' }
      ]
    }))
  }
]

async function setup(): Promise<{
  service: typeof import('../electron/services/discoveryService')
  calls: { what: string; lane: string }[]
  dir: string
  clock: { now: number }
  enabled: { on: boolean }
  fail: { boards: boolean }
  refuse: Set<string>
  recorded: SourcePrediction[]
  held: Map<string, { coin: string; size: number }[] | Error>
}> {
  vi.resetModules()
  const service = await import('../electron/services/discoveryService')
  const { laneNow } = await import('../electron/services/httpPacing')
  service.resetDiscovery()
  const dir = mkdtempSync(join(tmpdir(), 'discovery-'))
  const calls: { what: string; lane: string }[] = []
  const clock = { now: T0 }
  const enabled = { on: true }
  const fail = { boards: false }
  const refuse = new Set<string>()
  const recorded: SourcePrediction[] = []
  const held = new Map<string, { coin: string; size: number }[] | Error>()
  const analysed = new Map<string, TraderAnalysis>()
  const seam = service.discoverySeam
  seam.dir = () => dir
  seam.nowMs = () => clock.now
  seam.enabled = async () => enabled.on
  seam.setEnabled = async (on) => {
    enabled.on = on
  }
  seam.okxPage = async (page) => {
    calls.push({ what: `okx page ${page}`, lane: laneNow() })
    if (fail.boards) throw new Error('OKX answered 503')
    return page === 1 ? okxPage(['AAAAAAAAAAAAAAA1', 'AAAAAAAAAAAAAAA2'], 2) : okxPage(['AAAAAAAAAAAAAAA3'], 2)
  }
  seam.boardText = async () => {
    calls.push({ what: 'board', lane: laneNow() })
    if (fail.boards) throw new Error('it answered 503')
    return 'text'
  }
  seam.readBoard = async () => ({ total: 48_234, passed: [hl(1, null, 9e9), hl(2, 'Named', 1e8), hl(3, 'Known', 5e9)] })
  seam.list = async (): Promise<TraderList> => ({
    traders: [
      { meta: { ref: { key: `hyperliquid-${address(3)}` } }, latest: null },
      ...[...analysed.entries()].map(([key, latest]) => ({ meta: { ref: { key } }, latest }))
    ] as unknown as TraderList['traders'],
    analysed: analysed.size
  })
  seam.read = async (id) => {
    calls.push({ what: `read ${id}`, lane: laneNow() })
    if (refuse.has(id)) return { refused: 'OKX has no lead trader with that code: they may have stopped leading.' }
    // An address ending in f trades too fast: Hyperliquid's window of its fills covers a day.
    if (id.endsWith('f')) return { ref: { key: id }, source: 'hyperliquid', capped: true, records: 12_000, firstMs: clock.now - 86_400_000, lastMs: clock.now } as never
    return { ref: { key: id }, source: id.startsWith('0x') ? 'hyperliquid' : 'okx', capped: false, records: 500, firstMs: clock.now - 90 * 86_400_000, lastMs: clock.now } as never
  }
  seam.analyze = async (key) => {
    calls.push({ what: `analyse ${key}`, lane: laneNow() })
    const analysis = { at: Math.floor(clock.now / 1000), figures: { trips: 12, money: { net: 34 } }, skill: { verdict: 'MARKET OR LUCK' }, clone: null, delay: { rows: [{ delayMin: 1, costMultiplier: 1, meanNetPct: -0.04 }] } } as unknown as TraderAnalysis
    analysed.set(key, analysis)
    return analysis
  }
  seam.positions = async (venue, id) => {
    calls.push({ what: `positions ${id}`, lane: laneNow() })
    const answer = held.get(id) ?? []
    if (answer instanceof Error) throw answer
    return answer
  }
  seam.forecasts = () => [{ pair: 'BTCUSDT', currentPrice: 70_000 }, { pair: 'ETHUSDT', currentPrice: 2_500 }] as never
  seam.versions = async () => ({ engine: 'e', config: 'c' })
  seam.record = async (predictions) => {
    recorded.push(...predictions)
    return predictions.length
  }
  return { service, calls, dir, clock, enabled, fail, refuse, recorded, held }
}

const linesOf = (dir: string): { kind: string; key?: string; rank?: number; picked?: string[]; why?: string }[] =>
  readdirSync(dir)
    .filter((name) => name.startsWith('discovery-'))
    .flatMap((name) => readFileSync(join(dir, name), 'utf-8').split('\n').filter((line) => line.trim() !== ''))
    .map((line) => JSON.parse(line) as { kind: string })

beforeEach(() => vi.restoreAllMocks())

describe('finding traders', () => {
  it('reads both rankings in the background lane, keeps the picks of the rule, and analyses the first found', async () => {
    const { service, calls, dir } = await setup()
    await service.discoveryTurn()
    expect(calls.map((call) => call.what)).toEqual(['okx page 1', 'okx page 2', 'board', `read ${address(2)}`, `analyse hyperliquid-${address(2)}`])
    expect(new Set(calls.map((call) => call.lane))).toEqual(new Set(['background']))
    const lines = linesOf(dir)
    const boards = lines.find((line) => line.kind === 'boards')
    // Named first, then the larger profit (page 2's leader made as much as page 1's, its code after); the venues in
    // turn; the trader already on file left out.
    expect(boards?.picked).toEqual([`hyperliquid-${address(2)}`, 'okx-AAAAAAAAAAAAAAA1', `hyperliquid-${address(1)}`, 'okx-AAAAAAAAAAAAAAA3', 'okx-AAAAAAAAAAAAAAA2'])
    expect(lines.filter((line) => line.kind === 'found').map((line) => [line.rank, line.key])).toEqual(boards?.picked?.map((key, k) => [k + 1, key]))
    const state = service.discoveryState()
    expect(state).toMatchObject({ enabled: true, lastReadAt: T0 / 1000, analysed: 1, queued: 4, analysing: null, nextAnalysisAt: T0 / 1000 + 30 * 60 })
    expect(state.sources).toEqual([
      { venue: 'okx', ok: true, rows: 3, passed: 3, error: null },
      { venue: 'hyperliquid', ok: true, rows: 48_234, passed: 3, error: null }
    ])
    expect(state.found.find((entry) => entry.key === `hyperliquid-${address(2)}`)).toMatchObject({ status: 'analysed', latest: { trips: 12, netUsd: 34, skill: 'MARKET OR LUCK', followerNetPct: -0.04 } })
  })

  it('reads the rankings once a day and analyses half an hour apart, the first found first', async () => {
    const { service, calls, clock } = await setup()
    await service.discoveryTurn()
    calls.length = 0
    clock.now = T0 + 29 * 60_000
    await service.discoveryTurn()
    expect(calls).toEqual([])
    clock.now = T0 + 30 * 60_000
    await service.discoveryTurn()
    expect(calls.map((call) => call.what)).toEqual(['read AAAAAAAAAAAAAAA1', 'analyse okx-AAAAAAAAAAAAAAA1'])
    calls.length = 0
    // Two hours on: the next analysis, and not the rankings, which wait their day.
    clock.now = T0 + 2 * 3600_000
    await service.discoveryTurn()
    expect(calls.map((call) => call.what)).toEqual([`read ${address(1)}`, `analyse hyperliquid-${address(1)}`])
    calls.length = 0
    clock.now = T0 + 20 * 3600_000
    await service.discoveryTurn()
    // A day on (twenty hours): the rankings again; everyone they name is known now, so nothing new is found.
    expect(calls.map((call) => call.what).slice(0, 3)).toEqual(['okx page 1', 'okx page 2', 'board'])
  })

  it("keeps a venue's refusal as a skip, and goes on to the next", async () => {
    const { service, dir, refuse, calls, clock } = await setup()
    refuse.add(address(2))
    await service.discoveryTurn()
    expect(linesOf(dir).find((line) => line.kind === 'skipped')).toMatchObject({ key: `hyperliquid-${address(2)}`, why: 'OKX has no lead trader with that code: they may have stopped leading.' })
    expect(service.discoveryState().found.find((entry) => entry.key === `hyperliquid-${address(2)}`)).toMatchObject({ status: 'skipped' })
    calls.length = 0
    clock.now = T0 + 30 * 60_000
    await service.discoveryTurn()
    expect(calls.map((call) => call.what)).toEqual(['read AAAAAAAAAAAAAAA1', 'analyse okx-AAAAAAAAAAAAAAA1'])
  })

  it('keeps a record too short for the tests as a skip, unanalysed', async () => {
    const { service, dir, calls } = await setup()
    service.discoverySeam.readBoard = async () => ({ total: 1, passed: [hl(15, 'Too fast', 9e9)] })
    service.discoverySeam.okxPage = async () => okxPage([], 1)
    await service.discoveryTurn()
    expect(calls.some((call) => call.what.startsWith('analyse'))).toBe(false)
    expect(linesOf(dir).find((line) => line.kind === 'skipped')?.why).toContain('cover 24 hours, under the 30 days the tests need')
  })

  it('reads nothing when switched off, and starts again when switched on', async () => {
    const { service, calls, enabled } = await setup()
    enabled.on = false
    await service.discoveryTurn()
    expect(calls).toEqual([])
    expect(service.discoveryState().enabled).toBe(false)
    const state = await service.setDiscovery(true)
    expect(state.enabled).toBe(true)
  })

  it('reads what the analysed found traders hold once a UTC day, and records the calls the rule makes', async () => {
    const { service, calls, clock, recorded, held, dir } = await setup()
    // The first turn finds the ten and analyses the first: there is no one analysed to read before that.
    await service.discoveryTurn()
    expect(calls.some((call) => call.what.startsWith('positions'))).toBe(false)
    // Two more analysed, half an hour apart.
    clock.now = T0 + 30 * 60_000
    await service.discoveryTurn()
    clock.now = T0 + 60 * 60_000
    await service.discoveryTurn()
    expect(service.discoveryState().analysed).toBe(3)
    // The next UTC day: each analysed one's positions; three hold BTC, all long; ETH is held by two; DOGE is no coin of
    // the forecast's.
    held.set(address(2), [{ coin: 'BTC', size: 1 }, { coin: 'ETH', size: -1 }, { coin: 'DOGE', size: 5 }])
    held.set('AAAAAAAAAAAAAAA1', [{ coin: 'BTC', size: 2 }, { coin: 'ETH', size: 1 }])
    held.set(address(1), [{ coin: 'BTC', size: 3 }, { coin: 'DOGE', size: 1 }])
    calls.length = 0
    clock.now = Date.UTC(2026, 10, 7, 0, 4)
    await service.discoveryTurn()
    expect(calls.filter((call) => call.what.startsWith('positions')).map((call) => call.lane)).toEqual(['background', 'background', 'background'])
    expect(recorded.map((line) => [line.source, line.pair, line.side, line.refPrice])).toEqual([['top-traders', 'BTCUSDT', 'up', 70_000]])
    const holdings = service.discoveryState().holdings
    expect(holdings).toMatchObject({ kind: 'holdings', day: Date.UTC(2026, 10, 7) / 1000, traders: 3, failed: 0, calls: 1 })
    expect(holdings?.consensus).toEqual([
      { coin: 'BTC', longs: 3, shorts: 0, holders: 3, side: 'up' },
      { coin: 'ETH', longs: 1, shorts: 1, holders: 2, side: null }
    ])
    expect(linesOf(dir).filter((line) => line.kind === 'holdings')).toHaveLength(1)
    // Once a day: a turn later the same morning, or the same day, reads no positions again.
    calls.length = 0
    clock.now = Date.UTC(2026, 10, 7, 0, 45)
    await service.discoveryTurn()
    expect(calls.some((call) => call.what.startsWith('positions'))).toBe(false)
    clock.now = Date.UTC(2026, 10, 7, 3, 0)
    await service.discoveryTurn()
    expect(calls.some((call) => call.what.startsWith('positions'))).toBe(false)
    // A day whose first two hours the app missed has no read: every call is made at the same hour.
    clock.now = Date.UTC(2026, 10, 8, 2, 0)
    await service.discoveryTurn()
    expect(calls.some((call) => call.what.startsWith('positions'))).toBe(false)
  })

  it("reads the day's holdings while a long analysis runs, and starts no second analysis meanwhile", async () => {
    const { service, calls, clock, held } = await setup()
    await service.discoveryTurn()
    // The next found trader's analysis reads bars past the turn of the UTC day.
    let release = (): void => undefined
    const holding = new Promise<void>((resolve) => (release = resolve))
    let reached = (): void => undefined
    const inside = new Promise<void>((resolve) => (reached = resolve))
    const analyze = service.discoverySeam.analyze
    service.discoverySeam.analyze = async (key) => {
      reached()
      await holding
      return analyze(key)
    }
    clock.now = T0 + 30 * 60_000
    const long = service.discoveryTurn()
    await inside
    expect(service.discoveryState().analysing).toBe('okx-AAAAAAAAAAAAAAA1')
    held.set(address(2), [{ coin: 'BTC', size: 1 }])
    calls.length = 0
    clock.now = Date.UTC(2026, 10, 7, 0, 4)
    await service.discoveryTurn()
    expect(calls.map((call) => call.what)).toEqual([`positions ${address(2)}`])
    expect(service.discoveryState().holdings).toMatchObject({ day: Date.UTC(2026, 10, 7) / 1000, traders: 1, failed: 0 })
    release()
    await long
    expect(service.discoveryState()).toMatchObject({ analysing: null, analysed: 2 })
  })

  it('counts a found trader whose positions cannot be read as failed, and goes on', async () => {
    const { service, clock, held } = await setup()
    await service.discoveryTurn()
    held.set(address(2), new Error('Hyperliquid answered 500'))
    clock.now = Date.UTC(2026, 10, 7, 0, 4)
    await service.discoveryTurn()
    expect(service.discoveryState().holdings).toMatchObject({ traders: 0, failed: 1, consensus: [], calls: 0 })
  })

  it('tries a read that found neither ranking again after an hour, not before', async () => {
    const { service, calls, dir, clock, fail } = await setup()
    fail.boards = true
    await service.discoveryTurn()
    expect(linesOf(dir).find((line) => line.kind === 'boards')).toMatchObject({ picked: [] })
    expect(service.discoveryState().sources.every((source) => !source.ok)).toBe(true)
    calls.length = 0
    clock.now = T0 + 59 * 60_000
    await service.discoveryTurn()
    expect(calls).toEqual([])
    fail.boards = false
    clock.now = T0 + 60 * 60_000
    await service.discoveryTurn()
    expect(calls[0].what).toBe('okx page 1')
  })
})
