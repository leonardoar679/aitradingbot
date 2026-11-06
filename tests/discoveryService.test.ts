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
vi.mock('../electron/services/okxClient', () => ({ okxGet: async () => [] }))

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
    return refuse.has(id) ? { refused: 'OKX has no lead trader with that code: they may have stopped leading.' } : ({ ref: { key: id } } as never)
  }
  seam.analyze = async (key) => {
    calls.push({ what: `analyse ${key}`, lane: laneNow() })
    const analysis = { at: Math.floor(clock.now / 1000), figures: { trips: 12, money: { net: 34 } }, skill: { verdict: 'MARKET OR LUCK' }, clone: null, delay: { rows: [{ delayMin: 1, costMultiplier: 1, meanNetPct: -0.04 }] } } as unknown as TraderAnalysis
    analysed.set(key, analysis)
    return analysis
  }
  return { service, calls, dir, clock, enabled, fail, refuse }
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

  it('reads nothing when switched off, and starts again when switched on', async () => {
    const { service, calls, enabled } = await setup()
    enabled.on = false
    await service.discoveryTurn()
    expect(calls).toEqual([])
    expect(service.discoveryState().enabled).toBe(false)
    const state = await service.setDiscovery(true)
    expect(state.enabled).toBe(true)
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
