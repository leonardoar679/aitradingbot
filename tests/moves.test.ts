import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForecastBar } from '../shared/forecast/bars'
import { MOVE_LINES, MOVES_VERSION, calledMove, closeAt, movesOf, readMoveLine, type MoveLine } from '../shared/evaluation/moves'
import { SOURCE_RECORD_VERSION, sourcePredictionId, type SourcePrediction } from '../shared/evaluation/predictionRecord'

// MOVES NOBODY CALLED (shared/evaluation/moves.ts; electron/services/predictionLedgerService.ts recordHourMoves): at a
// whole hour a close-to-close move of 2% or more over the hour, or 5% or more over the day, is written with the
// predictions that called it -- the same pair, made no later than a quarter into the span, due no earlier than a
// quarter before its end, the move's way or a size no larger than it -- once an hour, from the bars as held.

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

const HOUR = 3600
const AT = 1_792_008_000 // a whole hour: 497,780 hours

/** Five-minute bars from `from` (an open time) to the bar that closes at `to`, each closing at `price(time)`. */
function bars(from: number, to: number, price: (closeTime: number) => number): ForecastBar[] {
  const out: ForecastBar[] = []
  for (let time = from; time + 300 <= to; time += 300) {
    const close = price(time + 300)
    out.push({ time, open: close, high: close, low: close, close, volume: 1, quoteVolume: close, takerBuyVolume: 0.5, trades: 1 })
  }
  return out
}

function prediction(over: Partial<SourcePrediction> = {}): SourcePrediction {
  const madeAt = over.madeAt ?? AT - HOUR
  return {
    v: SOURCE_RECORD_VERSION,
    id: sourcePredictionId(over.source ?? 'delisting-rule', over.pair ?? 'ABCUSDT', madeAt),
    source: 'delisting-rule',
    sourceVersion: 'delisting-rule-v1',
    kind: 'direction',
    pair: 'ABCUSDT',
    venue: 'binance',
    madeAt,
    bar: null,
    horizonSec: 4 * HOUR,
    refPrice: 100,
    side: 'down',
    movePct: 3,
    targetPrice: 97,
    window: null,
    dist: { pRight: null, q: null, pMove: null },
    scenarios: null,
    cost: null,
    expectedNet: null,
    reason: 'a delisting',
    evidence: [],
    unit: Math.floor(madeAt / HOUR),
    versions: { engine: 'e', config: 'c' },
    ...over
  }
}

describe('closeAt', () => {
  const held = bars(AT - 2 * HOUR, AT, (t) => t / 1e6)
  it('reads the close of the bar that ended at the moment, the one that opened five minutes before', () => {
    expect(closeAt(held, AT)).toBe(AT / 1e6)
    expect(closeAt(held, AT - HOUR)).toBe((AT - HOUR) / 1e6)
  })
  it('is null where the bars do not hold that bar, or its close is no price', () => {
    expect(closeAt(held, AT + 300)).toBeNull()
    expect(closeAt(held, AT - 3 * HOUR)).toBeNull()
    expect(closeAt([], AT)).toBeNull()
    const zero = bars(AT - HOUR, AT, () => 0)
    expect(closeAt(zero, AT)).toBeNull()
  })
})

describe('movesOf', () => {
  // Flat at 100 for the day, then a fall to 97 over the last hour: -3% in the hour, -3% in the day.
  const fall = bars(AT - 25 * HOUR, AT, (t) => (t <= AT - HOUR ? 100 : 97))
  it('writes a move of 2% or more over the hour, measured close to close', () => {
    const lines = movesOf('ABCUSDT', 'binance', fall, AT, [])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({ v: MOVES_VERSION, pair: 'ABCUSDT', venue: 'binance', span: 'hour', at: AT, fromPrice: 100, toPrice: 97, movePct: expect.closeTo(-3, 9), calledBy: [] })
  })
  it('writes a day move only at 5% or more, and an hour move at its line exactly', () => {
    const day = bars(AT - 25 * HOUR, AT, (t) => (t <= AT - 24 * HOUR ? 50 : t <= AT - HOUR ? 100 : 102))
    const lines = movesOf('ABCUSDT', 'binance', day, AT, [])
    expect(lines.map((line) => [line.span, Number(line.movePct.toFixed(4))])).toEqual([
      ['hour', 2],
      ['day', 104]
    ])
    const under = bars(AT - 25 * HOUR, AT, (t) => (t <= AT - 24 * HOUR ? 100 : t <= AT - HOUR ? 103 : 104.99))
    expect(movesOf('ABCUSDT', 'binance', under, AT, []).map((line) => line.span)).toEqual([])
    expect(MOVE_LINES.hourPct).toBe(2)
    expect(MOVE_LINES.dayPct).toBe(5)
  })
  it('writes nothing from a price that is not held: no end close, or no start close for a span', () => {
    expect(movesOf('ABCUSDT', 'binance', fall, AT + 300, [])).toEqual([])
    const short = bars(AT - 2 * HOUR, AT, (t) => (t <= AT - HOUR ? 100 : 90))
    expect(movesOf('ABCUSDT', 'binance', short, AT, []).map((line) => line.span)).toEqual(['hour'])
  })
  it('names the predictions that called the move, and only those', () => {
    const start = AT - HOUR
    const called = [
      prediction({ madeAt: start }),
      prediction({ madeAt: start + 0.25 * HOUR, horizonSec: 0.5 * HOUR }),
      prediction({ madeAt: start - 10 * HOUR, horizonSec: 24 * HOUR }),
      prediction({ madeAt: start, kind: 'size', side: null, movePct: 2.5 }),
      prediction({ madeAt: start, kind: 'size', side: null, movePct: 3 })
    ]
    const notCalled = [
      prediction({ madeAt: start + 0.25 * HOUR + 1 }),
      prediction({ madeAt: start, horizonSec: 0.75 * HOUR - 1 }),
      prediction({ madeAt: start, side: 'up' }),
      prediction({ madeAt: start, kind: 'size', side: null, movePct: 3.01 }),
      prediction({ madeAt: start, kind: 'size', side: null, movePct: null }),
      prediction({ madeAt: start, pair: 'XYZUSDT' })
    ]
    const all = [...called, ...notCalled].map((entry, i) => ({ ...entry, id: `p${i}` }))
    const [line] = movesOf('ABCUSDT', 'binance', fall, AT, all)
    expect(line.calledBy).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
  })
  it('judges a call against the move as written: early enough, late enough, its way', () => {
    const move = { pair: 'ABCUSDT', span: 'day' as const, at: AT, movePct: 6 }
    const start = AT - 24 * HOUR
    expect(calledMove(prediction({ madeAt: start + 6 * HOUR, horizonSec: 12 * HOUR, side: 'up' }), move)).toBe(true)
    expect(calledMove(prediction({ madeAt: start + 6 * HOUR + 1, horizonSec: 24 * HOUR, side: 'up' }), move)).toBe(false)
    expect(calledMove(prediction({ madeAt: start, horizonSec: 18 * HOUR - 1, side: 'up' }), move)).toBe(false)
    expect(calledMove(prediction({ madeAt: start, horizonSec: 24 * HOUR, side: 'down' }), move)).toBe(false)
    expect(MOVE_LINES.lead).toBe(0.25)
  })
})

describe('readMoveLine', () => {
  const line: MoveLine = { v: MOVES_VERSION, pair: 'ABCUSDT', venue: 'binance', span: 'hour', at: AT, fromPrice: 100, toPrice: 97, movePct: -3, calledBy: [] }
  it('reads back a whole line and refuses what this version does not know', () => {
    expect(readMoveLine(JSON.parse(JSON.stringify(line)))).toEqual(line)
    expect(readMoveLine({ ...line, v: 'moves-v0' })).toBeNull()
    expect(readMoveLine({ ...line, span: 'week' })).toBeNull()
    expect(readMoveLine({ ...line, calledBy: 'none' })).toBeNull()
    expect(readMoveLine({ ...line, movePct: '3' })).toBeNull()
    expect(readMoveLine(null)).toBeNull()
  })
})

describe('recordHourMoves', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'moves-'))
  })
  async function service() {
    const module = await import('../electron/services/predictionLedgerService')
    module.resetPredictionLedger()
    module.predictionLedgerSeam.dir = () => dir
    module.predictionLedgerSeam.now = () => AT
    return module
  }
  const fall = bars(AT - 25 * HOUR, AT, (t) => (t <= AT - HOUR ? 100 : 97))
  const flat = bars(AT - 25 * HOUR, AT, () => 50)

  it('writes the hour once, with who called it from the record on file, and reads it back', async () => {
    const ledger = await service()
    const call = prediction({ madeAt: AT - HOUR })
    await ledger.recordSourcePrediction(call)
    const barsOf = (pair: string): ForecastBar[] | null => (pair === 'ABCUSDT' ? fall : pair === 'FLATUSDT' ? flat : null)
    expect(await ledger.recordHourMoves(AT, ['ABCUSDT', 'FLATUSDT', 'GONEUSDT'], barsOf)).toBe(1)
    expect(await ledger.recordHourMoves(AT, ['ABCUSDT'], barsOf)).toBe(0)
    const file = join(dir, `moves-${new Date(AT * 1000).toISOString().slice(0, 7)}.jsonl`)
    const written = readFileSync(file, 'utf-8').trim().split('\n').map((text) => JSON.parse(text))
    expect(written).toHaveLength(1)
    expect(written[0]).toMatchObject({ pair: 'ABCUSDT', span: 'hour', at: AT, calledBy: [call.id] })
    expect(await ledger.moveRecord(AT)).toEqual(written)
    expect(await ledger.moveRecord(AT + 1)).toEqual([])
  })

  it('writes nothing at a close that is not a whole hour, and an hour on file is not written again after a start', async () => {
    const ledger = await service()
    expect(await ledger.recordHourMoves(AT - 300, ['ABCUSDT'], () => fall)).toBe(0)
    expect(await ledger.recordHourMoves(AT, ['ABCUSDT'], () => fall)).toBe(1)
    const again = await service()
    expect(await again.recordHourMoves(AT, ['ABCUSDT'], () => fall)).toBe(0)
    expect(await again.moveRecord()).toHaveLength(1)
  })
})
