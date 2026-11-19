import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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
