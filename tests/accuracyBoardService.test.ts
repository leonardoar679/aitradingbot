import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { OutcomeLine } from '../shared/forecast/forecastRecord'
import { recordMonth } from '../shared/forecast/forecastRecord'
import { expectedMove } from '../shared/forecast/size'

// THE ACCURACY BOARD, KEPT (electron/services/accuracyBoardService.ts; V10 Stage 2): each close's settled outcomes
// counted as they are written, the board kept in a small file and read back; and where none is kept, the days before
// read once from the record, each outcome given its forecast's middle and expected size.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const DAY = 86_400
const T0 = 1_795_000_000 - (1_795_000_000 % DAY)

function outcome(id: string, move: number, at: number, over: Partial<OutcomeLine> = {}): OutcomeLine {
  return { v: 'forecast-record-v1', id, pair: 'BTCUSDT', h: 'hours24', t: at - DAY, due: at, at, move, best: 0, worst: 0, below: move >= 0 ? '00011' : '00111', v1below: '', in80: true, in50: true, up: move > 0, dir: 'NEUTRAL', pUp: 0.5, cell: 'pooled', cls: 'btc', errors: [], ...over }
}

async function setup(nowSec: number): Promise<{ service: typeof import('../electron/services/accuracyBoardService'); dir: string; clock: { now: number } }> {
  vi.resetModules()
  const service = await import('../electron/services/accuracyBoardService')
  service.resetAccuracyBoard()
  const dir = mkdtempSync(join(tmpdir(), 'board-'))
  const clock = { now: nowSec }
  service.boardSeam.dir = () => dir
  service.boardSeam.nowSec = () => clock.now
  return { service, dir, clock }
}

/** The board once it is no longer reading the days before. */
async function settled(service: typeof import('../electron/services/accuracyBoardService')): Promise<Awaited<ReturnType<typeof service.accuracyBoard>>> {
  for (let tries = 0; tries < 200; tries++) {
    const board = await service.accuracyBoard()
    if (!board.filling) return board
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('the board never ended reading the days before')
}

describe('the accuracy board, kept', () => {
  it('counts each settled outcome as it is written, keeps the board, and reads it back without reading the record again', async () => {
    const { service, dir, clock } = await setup(T0 + 2 * DAY)
    expect((await settled(service)).horizons.every((row) => row.n === 0)).toBe(true)
    service.takeBoardOutcomes([outcome('a', 2, T0 + DAY + 60, { mid: 0, size: 2 }), outcome('b', -3, T0 + DAY + 120, { mid: 0, size: 2 }), { v: 'forecast-record-v1', id: 'c', pair: 'BTCUSDT', h: 'hours24', t: T0, due: T0 + DAY, missing: 'no bars' }])
    const board = await service.accuracyBoard()
    const day = board.horizons.find((row) => row.h === 'hours24')!
    expect(day).toMatchObject({ n: 2, pointedShare: 0 })
    expect(day.sizeRatio?.value).toBeCloseTo(5 / 4, 12)
    expect(board.recent.map((entry) => entry.move)).toEqual([-3, 2])
    expect(board.updatedAt).toBe(clock.now)
    await service.flushAccuracyBoard()
    expect(existsSync(join(dir, 'accuracy-board.json'))).toBe(true)
    // A new session: what was kept, read back; nothing read from the record (there is none here to read).
    vi.resetModules()
    const again = await import('../electron/services/accuracyBoardService')
    again.resetAccuracyBoard()
    again.boardSeam.dir = () => dir
    again.boardSeam.nowSec = () => clock.now
    const back = await settled(again)
    expect(back.horizons.find((row) => row.h === 'hours24')).toMatchObject({ n: 2 })
    expect(back.recent).toHaveLength(2)
  })

  it('leaves out days older than the thirty it keeps', async () => {
    const { service } = await setup(T0 + 40 * DAY)
    await settled(service)
    service.takeBoardOutcomes([outcome('old', 1, T0 + DAY, { mid: 0, size: 1 }), outcome('new', 1, T0 + 39 * DAY, { mid: 0, size: 1 })])
    expect((await service.accuracyBoard()).horizons.find((row) => row.h === 'hours24')?.n).toBe(1)
  })

  it("reads the days before once where none is kept, each outcome given its forecast's middle and expected size", async () => {
    const now = T0 + 3 * DAY
    const { service, dir } = await setup(now)
    const q = [-6, -3, -1, 2, 5]
    const forecast = (id: string, t: number): unknown => ({ v: 'forecast-record-v1', id, pair: 'BTCUSDT', t, at: t * 1000, price: 70_000, cls: 'btc', h: { hours24: { q, pUp: 0.45, dir: 'NEUTRAL', cell: 'pooled', parts: [['gbt-price', 1, 0]] } } })
    const lines = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
    const t1 = T0 + DAY
    const t2 = T0 + DAY + 3600
    writeFileSync(join(dir, `predictions-${recordMonth(t1)}.jsonl`), lines([forecast('one', t1), forecast('two', t2), forecast('later', now)]))
    writeFileSync(join(dir, `outcomes-${recordMonth(t1)}.jsonl`), lines([
      // Written before V10: no middle, no size.
      outcome('one', -2, t1 + DAY, { t: t1 }),
      outcome('two', 4, t2 + DAY, { t: t2 }),
      { v: 'forecast-record-v1', id: 'gone', pair: 'BTCUSDT', h: 'hours24', t: t1, due: t1 + DAY, missing: 'no bars' },
      // Settled after the board started: counted when the forecast hands it in, not by the reading.
      outcome('later', 1, now + DAY, { t: now })
    ]) + '{torn')
    const board = await settled(service)
    const day = board.horizons.find((row) => row.h === 'hours24')!
    expect(day.n).toBe(2)
    expect(day.pointedShare).toBe(1)
    expect(day.pointed.rightOnFalling?.value).toBe(1)
    expect(day.pointed.rightOnRising?.value).toBe(0)
    expect(day.sizeRatio?.value).toBeCloseTo(6 / (2 * Math.round(expectedMove(q) * 10_000) / 10_000), 9)
    expect(board.recent.map((entry) => entry.mid)).toEqual([-1, -1])
    await service.flushAccuracyBoard()
    // Read once: a new session reads what was kept, not the record.
    writeFileSync(join(dir, `outcomes-${recordMonth(t1)}.jsonl`), '')
    vi.resetModules()
    const again = await import('../electron/services/accuracyBoardService')
    again.resetAccuracyBoard()
    again.boardSeam.dir = () => dir
    again.boardSeam.nowSec = () => now
    expect((await settled(again)).horizons.find((row) => row.h === 'hours24')?.n).toBe(2)
  })
})

describe('the accuracy board, kept through a quit and a crash (V10 Stage 8)', () => {
  type Service = typeof import('../electron/services/accuracyBoardService')
  const lines = (rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
  async function session(dir: string, now: number): Promise<Service> {
    vi.resetModules()
    const service = await import('../electron/services/accuracyBoardService')
    service.resetAccuracyBoard()
    service.boardSeam.dir = () => dir
    service.boardSeam.nowSec = () => now
    return service
  }
  const day = async (service: Service): Promise<number | undefined> => (await settled(service)).horizons.find((row) => row.h === 'hours24')?.n
  const kept = (dir: string): { countedTo: number | null; dailyCountedTo: number | null; days: { h: string; tally: { n: number } }[] } => JSON.parse(readFileSync(join(dir, 'accuracy-board.json'), 'utf-8'))

  it('is written at once as the app quits, with the latest settle moment it counted', async () => {
    const now = T0 + 2 * DAY
    const { service, dir } = await setup(now)
    await settled(service)
    service.takeBoardOutcomes([outcome('a', 2, T0 + DAY + 900, { mid: 0, size: 2 }), outcome('b', -1, T0 + DAY + 1800, { mid: 0, size: 2 })])
    service.flushAccuracyBoardSync()
    expect(kept(dir).countedTo).toBe(T0 + DAY + 1800)
    expect(kept(dir).days.find((entry) => entry.h === 'hours24')?.tally.n).toBe(2)
  })

  it('counts once, at the next start, what a crash left in the record and off the board', async () => {
    const now = T0 + 2 * DAY
    const { service, dir } = await setup(now)
    await settled(service)
    const a = outcome('a', 2, T0 + DAY + 900, { mid: 0, size: 2 })
    const b = outcome('b', -1, T0 + DAY + 1800, { mid: 0, size: 2 })
    service.takeBoardOutcomes([a])
    await service.flushAccuracyBoard()
    // The record holds both; the board was written before b, and the app crashed before the minute's write.
    writeFileSync(join(dir, `outcomes-${recordMonth(a.at!)}.jsonl`), lines([a, { v: 'forecast-record-v1', id: 'm', pair: 'BTCUSDT', h: 'hours24', t: T0, due: T0 + DAY, missing: 'no bars' }, b]))
    const after = await session(dir, now + 600)
    expect(await day(after)).toBe(2)
    expect((await after.accuracyBoard()).recent.map((entry) => entry.move).sort()).toEqual([-1, 2])
    expect(kept(dir).countedTo).toBe(b.at)
    // And not again at the start after.
    const again = await session(dir, now + 1200)
    expect(await day(again)).toBe(2)
  })

  it("counts the daily forecast's outcomes a crash left, once", async () => {
    const now = T0 + 10 * DAY
    const { service, dir } = await setup(now)
    await settled(service)
    const daily = (id: string, at: number): unknown => ({ v: 'daily-forecast-v1', id, pair: 'BTCUSDT', h: 'day1', day: at - DAY - 300, due: at - 300, at, move: 1.5, below: '00011', in80: true, mid: 0, size: 2 })
    const first = daily('d1', T0 + 8 * DAY + 300) as Parameters<Service['takeBoardDailyOutcomes']>[0][number]
    service.takeBoardDailyOutcomes([first])
    await service.flushAccuracyBoard()
    expect(kept(dir).dailyCountedTo).toBe(T0 + 8 * DAY + 300)
    const year = new Date(now * 1000).getUTCFullYear()
    writeFileSync(join(dir, `daily-outcomes-${year}.jsonl`), lines([first, daily('d2', T0 + 9 * DAY + 300)]))
    const after = await session(dir, now)
    expect((await settled(after)).horizons.find((row) => row.h === 'day1')?.n).toBe(2)
    const again = await session(dir, now)
    expect((await settled(again)).horizons.find((row) => row.h === 'day1')?.n).toBe(2)
  })

  it("keeps each forecast's mark apart: a daily outcome settled later hides no five-minute outcome a crash left", async () => {
    const now = T0 + 10 * DAY
    const { service, dir } = await setup(now)
    await settled(service)
    const open = T0 + 9 * DAY
    const before = outcome('a', 2, open - 900, { mid: 0, size: 2 })
    const lost = outcome('b', -1, open, { mid: 0, size: 2 })
    service.takeBoardOutcomes([before])
    service.takeBoardDailyOutcomes([{ v: 'daily-forecast-v1', id: 'd1', pair: 'BTCUSDT', h: 'day1', day: open - DAY, due: open, at: open + 360, move: 1, below: '00011', in80: true, mid: 0, size: 2 }])
    await service.flushAccuracyBoard()
    writeFileSync(join(dir, `outcomes-${recordMonth(open)}.jsonl`), lines([before, lost]))
    const after = await session(dir, now)
    expect(await day(after)).toBe(2)
  })

  it('counts no outcome twice that is counted live while the record is read at a start', async () => {
    const now = T0 + 2 * DAY
    const { service, dir } = await setup(now)
    await settled(service)
    const a = outcome('a', 2, T0 + DAY + 900, { mid: 0, size: 2 })
    const b = outcome('b', -1, now - 300, { mid: 0, size: 2 })
    service.takeBoardOutcomes([a])
    await service.flushAccuracyBoard()
    writeFileSync(join(dir, `outcomes-${recordMonth(a.at!)}.jsonl`), lines([a, b]))
    const after = await session(dir, now)
    // b reaches the board live while the kept board and the record are still being read.
    const loading = after.startAccuracyBoard()
    after.takeBoardOutcomes([b])
    await loading
    expect(await day(after)).toBe(2)
  })

  it('makes the write held back while the record was read, even where the reading counted nothing', async () => {
    const now = T0 + 3 * DAY
    const { service, dir } = await setup(now)
    await settled(service)
    service.takeBoardOutcomes([outcome('a', 1, T0 + 2 * DAY, { mid: 0, size: 1 })])
    await service.flushAccuracyBoard()
    // A long record, every outcome counted already, its end a missing line settled later: read, and nothing caught.
    const rows: unknown[] = Array.from({ length: 30_000 }, (_, index) => outcome(`r${index}`, 1, T0 + DAY + (index % 3600), { mid: 0, size: 1 }))
    rows.push({ v: 'forecast-record-v1', id: 'm', pair: 'BTCUSDT', h: 'hours24', t: T0 + DAY, due: T0 + 2 * DAY + 600, missing: 'no bars' })
    writeFileSync(join(dir, `outcomes-${recordMonth(T0 + DAY)}.jsonl`), lines(rows))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const after = await session(dir, now)
      const loading = after.startAccuracyBoard()
      after.takeBoardOutcomes([outcome('live', -1, now - 60, { mid: 0, size: 1 })])
      // The minute's write comes due while the record is still being read: held back.
      vi.advanceTimersByTime(61_000)
      await loading
      expect(kept(dir).days.filter((entry) => entry.h === 'hours24').reduce((sum, entry) => sum + entry.tally.n, 0)).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('writes nothing while the days before are read, and the whole board once they are', async () => {
    const now = T0 + 3 * DAY
    const { service, dir } = await setup(now)
    const rows = Array.from({ length: 30_000 }, (_, index) => outcome(`r${index}`, index % 2 === 0 ? 1 : -1, T0 + DAY + (index % 80_000), { mid: 0, size: 1 }))
    writeFileSync(join(dir, `outcomes-${recordMonth(T0 + DAY)}.jsonl`), lines(rows))
    const first = await service.accuracyBoard()
    expect(first.filling).toBe(true)
    service.takeBoardOutcomes([outcome('live', 1, now - 60, { mid: 0, size: 1 })])
    await service.flushAccuracyBoard()
    service.flushAccuracyBoardSync()
    expect(existsSync(join(dir, 'accuracy-board.json'))).toBe(false)
    expect(await day(service)).toBe(30_001)
    // Written once the reading is done: the board says so a moment before its write lands.
    for (let tries = 0; tries < 200 && !existsSync(join(dir, 'accuracy-board.json')); tries++) await new Promise((resolve) => setTimeout(resolve, 10))
    expect(kept(dir).days.filter((entry) => entry.h === 'hours24').reduce((sum, entry) => sum + entry.tally.n, 0)).toBe(30_001)
  })
})
