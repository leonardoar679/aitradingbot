import { describe, expect, it } from 'vitest'
import {
  DISCOVERY_LINES,
  boardKeyOf,
  foundTradersOf,
  hyperliquidBoardOf,
  hyperliquidBoardRead,
  okxBoardOf,
  okxMonthReturnOf,
  passesRule,
  pickCandidates,
  queueOf,
  readDiscoveryLine,
  shortRecordOf,
  skillBeyondChance,
  type BoardRow,
  type DiscoveryLine,
  type FoundAnalysis
} from '../shared/traders/discovery'

// TRADERS FOUND BY THE APP (shared/traders/discovery.ts; V9 Stage 3, V9-COPY-FORWARD's rule): OKX's ranking and
// Hyperliquid's leaderboard read into rows as the venues wrote them on 6 November 2026, the rule that picks from them,
// and the record of what was found.

const DAY = 86_400_000
const NEWEST = Date.UTC(2026, 10, 5)

/** A Hyperliquid leaderboard row as the site writes it. */
const hlRow = (address: string, account: number, all: number, month: number, volume: number, name: string | null = null): unknown => ({
  ethAddress: address,
  accountValue: String(account),
  windowPerformances: [
    ['day', { pnl: '1', roi: '0', vlm: '1' }],
    ['week', { pnl: '1', roi: '0', vlm: '1' }],
    ['month', { pnl: String(month), roi: '0', vlm: String(volume) }],
    ['allTime', { pnl: String(all), roi: '0', vlm: '1' }]
  ],
  prize: 0,
  displayName: name
})

/** An OKX ranking entry as its endpoint writes it: its return series every five days, newest first. */
const okxRank = (code: string, name: string, pnl: number, aum: number, leadDays: number, ratioNow: number, ratio30dAgo: number): unknown => ({
  uniqueCode: code,
  nickName: name,
  pnl: String(pnl),
  aum: String(aum),
  leadDays: String(leadDays),
  copyTraderNum: '72',
  winRatio: '0.5645',
  pnlRatio: String(ratioNow),
  pnlRatios: Array.from({ length: 19 }, (_, k) => ({ beginTs: String(NEWEST - k * 5 * DAY), pnlRatio: String(k === 0 ? ratioNow : k === 6 ? ratio30dAgo : ratioNow - 0.01 * k) }))
})

const address = (n: number): string => `0x${n.toString(16).padStart(40, '0')}`

const row = (over: Partial<BoardRow>): BoardRow => ({ venue: 'hyperliquid', id: address(1), name: null, accountUsd: 100_000, pnlAllTime: 1_000_000, last30d: 10_000, volume30d: 1_000_000, leadDays: null, copiers: null, winRatio: null, ...over })

describe("Hyperliquid's leaderboard", () => {
  it('is read into rows of each address, its account, its all-time and month profit and month volume, and its name', () => {
    const rows = hyperliquidBoardOf({
      leaderboardRows: [hlRow('0x7FDAFDE5CFB5465924316ECED2D3715494C517D1', 47_859_298, 159_854_473, 33_262_401, 2_460_000_000, 'BobbyBigSize'), hlRow('not an address', 1, 1, 1, 1), hlRow(address(2), Number.NaN, 1, 1, 1)]
    })
    expect(rows).toEqual([
      { venue: 'hyperliquid', id: '0x7fdafde5cfb5465924316eced2d3715494c517d1', name: 'BobbyBigSize', accountUsd: 47_859_298, pnlAllTime: 159_854_473, last30d: 33_262_401, volume30d: 2_460_000_000, leadDays: null, copiers: null, winRatio: null }
    ])
    expect(hyperliquidBoardOf({})).toEqual([])
    expect(hyperliquidBoardOf(null)).toEqual([])
  })

  it('is read in the worker from its text: how many rows, and those who pass', () => {
    const text = JSON.stringify({ leaderboardRows: [hlRow(address(1), 100_000, 5_000, 100, 1_000), hlRow(address(2), 100_000, -5_000, 100, 1_000)] })
    expect(hyperliquidBoardRead(text)).toMatchObject({ total: 2, passed: [{ id: address(1) }] })
  })
})

describe("OKX's lead-trader ranking", () => {
  it('is read into rows with the return over about thirty days from its ninety days, and its pages', () => {
    const read = okxBoardOf([{ dataVer: '1', totalPage: '11', ranks: [okxRank('F6476365DB0D09A3', 'maomao12345', 2_755_220.34, 15_600.5, 1132, 1.1218, 1.3736), okxRank('bad', 'x', 1, 1, 1, 1, 1)] }])
    expect(read.totalPages).toBe(11)
    expect(read.rows).toHaveLength(1)
    expect(read.rows[0]).toMatchObject({ venue: 'okx', id: 'F6476365DB0D09A3', name: 'maomao12345', accountUsd: 15_600.5, pnlAllTime: 2_755_220.34, volume30d: null, leadDays: 1132, copiers: 72, winRatio: 0.5645 })
    expect(read.rows[0].last30d).toBeCloseTo(1.1218 - 1.3736, 10)
    expect(okxBoardOf([]).rows).toEqual([])
  })

  it('has no thirty days where its series does not reach back that far', () => {
    expect(okxMonthReturnOf([{ beginTs: String(NEWEST), pnlRatio: '1' }, { beginTs: String(NEWEST - 10 * DAY), pnlRatio: '0.5' }])).toBeNaN()
    expect(okxMonthReturnOf(null)).toBeNaN()
    expect(okxMonthReturnOf([{ beginTs: String(NEWEST), pnlRatio: '1.2' }, { beginTs: String(NEWEST - 30 * DAY), pnlRatio: '1' }])).toBeCloseTo(0.2, 10)
  })
})

describe('the rule', () => {
  it('takes profit all time and over thirty days, an account of $50,000, no market maker, and on OKX ninety days leading', () => {
    expect(passesRule(row({}))).toBe(true)
    expect(passesRule(row({ pnlAllTime: 0 }))).toBe(false)
    expect(passesRule(row({ last30d: -1 }))).toBe(false)
    expect(passesRule(row({ last30d: Number.NaN }))).toBe(false)
    expect(passesRule(row({ accountUsd: DISCOVERY_LINES.minAccountUsd - 1 }))).toBe(false)
    expect(passesRule(row({ accountUsd: DISCOVERY_LINES.minAccountUsd }))).toBe(true)
    expect(passesRule(row({ volume30d: 100 * 100_000 }))).toBe(true)
    expect(passesRule(row({ volume30d: 100 * 100_000 + 1 }))).toBe(false)
    // OKX publishes no volume: the volume rule is not read there; ninety days leading is.
    expect(passesRule(row({ venue: 'okx', id: 'F6476365DB0D09A3', volume30d: null, leadDays: 90 }))).toBe(true)
    expect(passesRule(row({ venue: 'okx', id: 'F6476365DB0D09A3', volume30d: null, leadDays: 89 }))).toBe(false)
  })

  it('picks those with a name first, then the larger profit, the venues in turn, none known, at most ten', () => {
    const rows: BoardRow[] = [
      row({ id: address(1), pnlAllTime: 9e9 }),
      row({ id: address(2), name: 'Named small', pnlAllTime: 1e5 }),
      row({ id: address(3), name: 'Named big', pnlAllTime: 1e8 }),
      row({ id: address(4), name: 'Known', pnlAllTime: 5e9 }),
      row({ id: address(5), name: 'Fails', pnlAllTime: 7e9, accountUsd: 10 }),
      row({ venue: 'okx', id: 'AAAAAAAAAAAAAAA1', name: 'okx one', pnlAllTime: 2e6, volume30d: null, leadDays: 400 }),
      row({ venue: 'okx', id: 'AAAAAAAAAAAAAAA2', name: 'okx two', pnlAllTime: 3e6, volume30d: null, leadDays: 400 })
    ]
    const known = new Set([boardKeyOf(rows[3])])
    const picked = pickCandidates(rows, known)
    expect(picked.map((entry) => entry.name ?? entry.id)).toEqual(['Named big', 'okx two', 'Named small', 'okx one', address(1)])
    expect(pickCandidates(rows, known, 3)).toHaveLength(3)
    const many = Array.from({ length: 30 }, (_, k) => row({ id: address(100 + k), pnlAllTime: 1e6 + k }))
    expect(pickCandidates(many, new Set())).toHaveLength(DISCOVERY_LINES.newPerDay)
    expect(boardKeyOf(rows[0])).toBe(`hyperliquid-${address(1)}`)
    expect(boardKeyOf(rows[5])).toBe('okx-AAAAAAAAAAAAAAA1')
  })
})

describe('a record too short to analyse', () => {
  it("is a Hyperliquid account's capped window under the tests' days, said with its fills and its span", () => {
    const now = Date.UTC(2026, 10, 6, 4, 22)
    expect(shortRecordOf({ source: 'hyperliquid', capped: true, records: 17_892, firstMs: now - 20 * 3_600_000, lastMs: now })).toBe(
      "Hyperliquid gives only an account's most recent fills: this one's last 17892 cover 20 hours, under the 30 days the tests need. An account this fast cannot be analysed here, nor copied on paper."
    )
    expect(shortRecordOf({ source: 'hyperliquid', capped: true, records: 10_000, firstMs: now - 9 * 86_400_000, lastMs: now })).toContain('cover 9 days')
    // Long enough, not capped, or not Hyperliquid's: analysed.
    expect(shortRecordOf({ source: 'hyperliquid', capped: true, records: 10_000, firstMs: now - 30 * 86_400_000, lastMs: now })).toBeNull()
    expect(shortRecordOf({ source: 'hyperliquid', capped: false, records: 50, firstMs: now - 86_400_000, lastMs: now })).toBeNull()
    expect(shortRecordOf({ source: 'okx', capped: true, records: 900, firstMs: now - 86_400_000, lastMs: now })).toBeNull()
  })
})

describe('the record of what was found', () => {
  const board = row({ id: address(7), name: 'Seven' })
  const found = { kind: 'found', version: DISCOVERY_LINES.version, at: 1_000, key: boardKeyOf(board), rank: 1, board }

  it('reads back each kind of line, and none out of shape', () => {
    expect(readDiscoveryLine(found)).toEqual(found)
    expect(readDiscoveryLine({ kind: 'boards', version: 'discovery-v1', at: 1, sources: [], picked: [] })).not.toBeNull()
    expect(readDiscoveryLine({ kind: 'skipped', at: 1, key: 'okx-X', why: 'gone' })).not.toBeNull()
    // A found line whose key is not its board's is not one.
    expect(readDiscoveryLine({ ...found, key: 'hyperliquid-0xabc' })).toBeNull()
    expect(readDiscoveryLine({ kind: 'found', at: 'x' })).toBeNull()
    expect(readDiscoveryLine(null)).toBeNull()
  })

  it('lists each found trader with its status, newest first, those of the shown days, and queues the waiting ones', () => {
    const other = row({ id: address(8) })
    const third = row({ id: address(9) })
    const lines: DiscoveryLine[] = [
      found as DiscoveryLine,
      { kind: 'found', version: DISCOVERY_LINES.version, at: 2_000, key: boardKeyOf(other), rank: 2, board: other },
      { kind: 'found', version: DISCOVERY_LINES.version, at: 2_000, key: boardKeyOf(third), rank: 3, board: third },
      { kind: 'skipped', at: 2_500, key: boardKeyOf(third), why: 'OKX has no lead trader with that code' },
      { kind: 'found', version: DISCOVERY_LINES.version, at: 0, key: 'hyperliquid-0xold', rank: 1, board: row({ id: '0xold' }) }
    ]
    const analysis: FoundAnalysis = { at: 3_000, trips: 40, netUsd: 120, skill: 'MARKET OR LUCK', clone: null, followerNetPct: -0.05, pSkill: 0.2 }
    const now = DISCOVERY_LINES.shownDays * 86_400 + 500
    const list = foundTradersOf(lines, new Map([[found.key, analysis]]), boardKeyOf(other), now)
    expect(list.map((entry) => [entry.key, entry.status])).toEqual([
      [boardKeyOf(other), 'analysing'],
      [boardKeyOf(third), 'skipped'],
      [found.key, 'analysed']
    ])
    expect(list[1].why).toBe('OKX has no lead trader with that code')
    expect(list[2].latest).toEqual(analysis)
    // Waiting: neither analysed, nor analysing, nor skipped, nor tried too often.
    const waiting = foundTradersOf(lines, new Map(), null, now)
    expect(queueOf(waiting, new Map())).toEqual([found.key, boardKeyOf(other)])
    expect(queueOf(waiting, new Map([[found.key, DISCOVERY_LINES.maxAttempts]]))).toEqual([boardKeyOf(other)])
    // Found again after a skip, a trader waits again.
    const again = foundTradersOf([...lines, { kind: 'found', version: DISCOVERY_LINES.version, at: 3_000, key: boardKeyOf(third), rank: 1, board: third }], new Map(), null, now)
    expect(again.find((entry) => entry.key === boardKeyOf(third))).toMatchObject({ status: 'queued', why: null })
  })
})

describe('the found traders taken together', () => {
  const analysis = (skill: string | null, pSkill: number | null): FoundAnalysis => ({ at: 1, trips: 100, netUsd: 1, skill, clone: null, followerNetPct: null, pSkill })
  it("counts a SKILL as beyond chance only where its p, adjusted across all of them analysed, is within the test's line", () => {
    // One SKILL among a hundred analysed: its p of 0.0001 adjusts to 0.01, within the line; 0.0002 adjusts to 0.02.
    const rest = Array.from({ length: 99 }, () => analysis('MARKET OR LUCK', 0.5))
    expect(skillBeyondChance([analysis('SKILL', 0.0001), ...rest])).toBe(1)
    expect(skillBeyondChance([analysis('SKILL', 0.0002), ...rest])).toBe(0)
    // Alone, the same SKILL stands; a trader the test could not judge counts among them all, at a p of 1.
    expect(skillBeyondChance([analysis('SKILL', 0.0002)])).toBe(1)
    expect(skillBeyondChance([analysis('SKILL', 0.006), analysis('TOO FEW', null)])).toBe(0)
    // Two at 0.006: the larger's own 0.006 carries down to the smaller, whose 0.012 alone would be over the line.
    expect(skillBeyondChance([analysis('SKILL', 0.006), analysis('SKILL', 0.006)])).toBe(2)
    // Of two, the smaller p doubles to 0.008, within the line; a small p of another verdict is not counted.
    expect(skillBeyondChance([analysis('SKILL', 0.004), analysis('MARKET OR LUCK', 0.01)])).toBe(1)
    expect(skillBeyondChance([analysis('MARKET OR LUCK', 0.00001)])).toBe(0)
    expect(skillBeyondChance([])).toBe(0)
  })
})
