import { describe, expect, it } from 'vitest'
import { BOARD_LINES, accuracyBoardOf, addToTally, boardDayOf, boardEntryOf, boardHorizonOf, emptyTally, pointsOf, sumTallies, type BoardDay, type BoardTally } from '../shared/evaluation/accuracyBoard'
import type { OutcomeLine } from '../shared/forecast/forecastRecord'
import { expectedMove, levelAt } from '../shared/forecast/size'
import { N, scaled } from './forecastRecords'

// THE ACCURACY BOARD (shared/evaluation/accuracyBoard.ts; V10 Stage 2): the forecast's settled outcomes read the way the
// person asked -- the way it pointed, on the rises and the falls apart, the real size against the expected, the range --
// day by day, with intervals from resampling whole days. And the size it expects (shared/forecast/size.ts).

const DAY = 86_400
const T0 = 1_795_000_000 - (1_795_000_000 % DAY)

/** An outcome: its move, the middle and size its forecast had, where the close fell, and the way the app called. */
function outcome(move: number, over: Partial<OutcomeLine> = {}): OutcomeLine {
  return {
    v: 'forecast-record-v1',
    id: `X:${over.t ?? T0}`,
    pair: 'BTCUSDT',
    h: 'hours24',
    t: T0,
    due: T0 + DAY,
    move,
    best: Math.max(move, 0),
    worst: Math.min(move, 0),
    below: move > 3 ? '00000' : move < -3 ? '11111' : move >= 0 ? '00011' : '00111',
    v1below: '',
    in80: Math.abs(move) <= 3,
    in50: Math.abs(move) <= 1,
    up: move > 0,
    dir: 'NEUTRAL',
    pUp: 0.5,
    cell: 'pooled',
    cls: 'btc',
    errors: [],
    mid: 0,
    size: 2,
    ...over
  }
}

function tallyOf(outcomes: readonly OutcomeLine[]): BoardTally {
  const tally = emptyTally()
  for (const entry of outcomes) addToTally(tally, entry)
  return tally
}

describe('the way a forecast pointed', () => {
  it('is read on the rises and the falls apart, so a forecast always pointing down is right on every fall, no rise, and 50% balanced', () => {
    // The seven-day run's 24-hour middles: every one below no move, in a week that mostly fell.
    const week = [...Array.from({ length: 30 }, () => outcome(-2, { mid: -1.7 })), ...Array.from({ length: 10 }, () => outcome(2, { mid: -1.7 }))]
    const tally = tallyOf(week)
    expect(tally).toMatchObject({ n: 40, ups: 10, downs: 30, upPointed: 10, upPointedRight: 0, downPointed: 30, downPointedRight: 30 })
    const board = boardHorizonOf('hours24', [tally])
    expect(board.pointedShare).toBe(1)
    expect(board.pointed.rightOnRising?.value).toBe(0)
    expect(board.pointed.rightOnFalling?.value).toBe(1)
    expect(board.pointed.balanced?.value).toBe(0.5)
    // Its share right overall would have read 75%: the board never shows that figure.
    expect(JSON.stringify(board)).not.toContain('0.75')
    // A forecast that knew the way scores high on both.
    const knew = boardHorizonOf('hours24', [tallyOf([outcome(2, { mid: 1 }), outcome(-2, { mid: -1 }), outcome(3, { mid: 0.5 }), outcome(-1, { mid: -0.2 })])])
    expect(knew.pointed.balanced?.value).toBe(1)
  })

  it('points nowhere from a middle at no move, and counts an outcome written before V10 in the range and the size alone', () => {
    expect(pointsOf(0)).toBeNull()
    expect(pointsOf(BOARD_LINES.pointsFromPct / 2)).toBeNull()
    expect(pointsOf(-0.01)).toBe('down')
    expect(pointsOf(undefined)).toBeNull()
    const tally = tallyOf([outcome(2, { mid: 0 }), outcome(-2, { mid: 0 }), outcome(1, { mid: undefined, size: undefined }), outcome(0, { mid: 1 })])
    expect(tally).toMatchObject({ n: 4, ups: 2, downs: 1, upPointed: 0, downPointed: 0, sized: 3 })
    const board = boardHorizonOf('hours24', [tally])
    expect(board.pointedShare).toBe(0)
    expect(board.pointed.balanced).toBeNull()
    expect(board.pointed.rightOnRising).toBeNull()
  })

  it("counts the app's UP and DOWN calls apart from where the middle pointed", () => {
    const tally = tallyOf([outcome(2, { dir: 'BULLISH', mid: 0 }), outcome(-2, { dir: 'BULLISH', mid: 0 }), outcome(-1, { dir: 'BEARISH', mid: 0 }), outcome(1, { dir: 'NEUTRAL', mid: 0 })])
    expect(tally).toMatchObject({ upCalled: 1, upCalledRight: 1, downCalled: 2, downCalledRight: 1 })
    const board = boardHorizonOf('hours24', [tally])
    expect(board.called.n).toBe(3)
    expect(board.called.rightOnRising?.value).toBe(1)
    expect(board.called.rightOnFalling?.value).toBe(0.5)
    expect(board.called.balanced?.value).toBe(0.75)
  })
})

describe('the size and the range', () => {
  it('reads the real moves against the size expected as a ratio of their sums, and the range from where each close fell', () => {
    const tally = tallyOf([outcome(2, { size: 2 }), outcome(-4, { size: 2 }), outcome(1, { size: 2 }), outcome(0.5, { size: undefined })])
    expect(tally.sized).toBe(3)
    const board = boardHorizonOf('hours24', [tally])
    expect(board.sizeRatio?.value).toBeCloseTo(7 / 6, 12)
    expect(board.in80?.value).toBe(0.75)
    expect(board.belowP10?.value).toBe(0.25)
    expect(board.aboveP90?.value).toBe(0)
  })

  it('resamples whole days for its intervals: none from one day, the same interval every reading, the value inside it', () => {
    const one = boardHorizonOf('hours24', [tallyOf([outcome(2), outcome(-2, { in80: false })])])
    expect(one.in80).toEqual({ value: 0.5, low: null, high: null })
    const days = Array.from({ length: 20 }, (_, d) => tallyOf(Array.from({ length: 10 }, (_, k) => outcome(k % 2 === 0 ? 1 : -1, { in80: k < 5 + (d % 5), mid: k % 3 === 0 ? 0.5 : -0.5 }))))
    const first = boardHorizonOf('hours24', days)
    const again = boardHorizonOf('hours24', days)
    expect(first).toEqual(again)
    expect(first.days).toBe(20)
    expect(first.in80!.low!).toBeLessThanOrEqual(first.in80!.value)
    expect(first.in80!.high!).toBeGreaterThanOrEqual(first.in80!.value)
    expect(first.in80!.low!).toBeLessThan(first.in80!.high!)
    expect(sumTallies(days).n).toBe(200)
  })
})

describe('the board', () => {
  it('counts each outcome on the day it was settled, shows the kept days and the newest alone, the latest checked first', () => {
    expect(boardDayOf({ at: T0 + 2 * DAY + 5, due: T0 + DAY })).toBe(T0 + 2 * DAY)
    expect(boardDayOf({ due: T0 + DAY + 7 })).toBe(T0 + DAY)
    const days: BoardDay[] = [
      { day: T0, h: 'hours24', tally: tallyOf([outcome(1), outcome(-1)]) },
      { day: T0 + DAY, h: 'hours24', tally: tallyOf([outcome(1)]) },
      { day: T0 + DAY, h: 'hour1', tally: tallyOf([outcome(1, { h: 'hour1' })]) }
    ]
    const recent = [boardEntryOf(outcome(1, { t: T0, at: T0 + DAY })), boardEntryOf(outcome(-3, { t: T0 + 3600, at: T0 + DAY + 3600, pair: 'ETHUSDT', dir: 'BEARISH' }))]
    const board = accuracyBoardOf(days, recent, ['hour1', 'hours24'], T0 + DAY + 3600)
    expect(board).toMatchObject({ from: T0, to: T0 + DAY, updatedAt: T0 + DAY + 3600, filling: false })
    expect(board.horizons.map((row) => [row.h, row.n])).toEqual([
      ['hour1', 1],
      ['hours24', 3]
    ])
    expect(board.lastDay.map((row) => [row.h, row.n])).toEqual([
      ['hour1', 1],
      ['hours24', 1]
    ])
    expect(board.recent.map((entry) => entry.pair)).toEqual(['ETHUSDT', 'BTCUSDT'])
    expect(board.recent[0]).toMatchObject({ called: 'down', move: -3, size: 2, mid: 0, in80: true })
    expect(accuracyBoardOf([], [], ['hour1'], null)).toMatchObject({ from: null, to: null, lastDay: [], recent: [] })
  })
})

describe('the size a forecast expects', () => {
  it('is the mean size of its levels over the chances: about 5% under a normal move, scaling with its width', () => {
    // A normal move's mean size is 0.798 of its deviation; the five levels' straight tails read 0.759 of it.
    expect(expectedMove(N)).toBeCloseTo(0.7588, 3)
    expect(expectedMove(N) / Math.sqrt(2 / Math.PI)).toBeGreaterThan(0.94)
    expect(expectedMove(N) / Math.sqrt(2 / Math.PI)).toBeLessThan(0.96)
    expect(expectedMove(scaled(3))).toBeCloseTo(3 * expectedMove(N), 9)
    // Its sign does not matter, a centre away from no move adds to it.
    expect(expectedMove(N.map((q) => -q).reverse())).toBeCloseTo(expectedMove(N), 12)
    expect(expectedMove(scaled(1, 0.5))).toBeGreaterThan(expectedMove(N))
    expect(Number.isNaN(expectedMove([1, 2]))).toBe(true)
    expect(Number.isNaN(expectedMove([1, 2, Number.NaN, 4, 5]))).toBe(true)
  })

  it('reads its levels on the line through them, the tails on the outer slopes', () => {
    const q = [-2, -1, 0, 1, 2]
    expect(levelAt(q, 0.1)).toBe(-2)
    expect(levelAt(q, 0.5)).toBe(0)
    expect(levelAt(q, 0.375)).toBeCloseTo(-0.5, 12)
    expect(levelAt(q, 0.95)).toBeCloseTo(2 + (0.05 / 0.15) * 1, 12)
    expect(levelAt(q, 0.02)).toBeCloseTo(-2 - (0.08 / 0.15) * 1, 12)
  })
})
