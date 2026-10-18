import { describe, expect, it } from 'vitest'
import { TAPE_VERSION, newTapeState, parseTapeLine, staleDay, tapeDay, tapeFileName, tapeLinesOf, tapeMinuteOf } from '../shared/forecast/tape'
import { emptyLiveState, type LiveBook, type LiveMinute } from '../shared/liveMarket'

// THE TAPE (shared/forecast/tape.ts; V7.2 Stage 5): one line a minute per streamed pair's book, in name
// order, and each of Bitcoin's minutes once as it closes; the lines read back whole; a day file older than
// the record keeps swept.

const T0 = Date.UTC(2026, 9, 17, 7, 20, 0) / 1000
const book = (symbol: string, bid: number, ask: number, updatedAt: number): LiveBook => ({ symbol, bid, bidQty: 3, ask, askQty: 4, updatedAt, source: 'stream' })
const minute = (time: number, closed: boolean): LiveMinute => ({ time, open: 100, high: 101, low: 99, close: 100.5, volume: 7, closed })

describe('the tape', () => {
  it("writes one line a minute per streamed pair, in name order, and each of Bitcoin's minutes once", () => {
    const state = newTapeState()
    const live = emptyLiveState()
    live.books.SOLUSDT = book('SOLUSDT', 180, 180.02, T0 * 1000 + 4000)
    live.books.BTCUSDT = book('BTCUSDT', 60_000, 60_001, T0 * 1000 + 4500)
    // A book without a price yet is not a line.
    live.books.NEWUSDT = book('NEWUSDT', 0, 0, T0 * 1000)
    live.btcMinutes = [minute(T0 - 60, true), minute(T0, false)]
    const first = tapeLinesOf(state, live, T0 * 1000 + 5000)
    expect(first.map((line) => [line.kind, line.pair, line.t])).toEqual([
      ['book', 'BTCUSDT', T0],
      ['book', 'SOLUSDT', T0],
      ['minute', 'BTCUSDT', T0 - 60]
    ])
    expect(first[0]).toEqual({ v: TAPE_VERSION, kind: 'book', t: T0, pair: 'BTCUSDT', bid: 60_000, ask: 60_001, bidQty: 3, askQty: 4, at: T0 * 1000 + 4500 })
    expect(first[2]).toEqual({ v: TAPE_VERSION, kind: 'minute', t: T0 - 60, pair: 'BTCUSDT', open: 100, high: 101, low: 99, close: 100.5, volume: 7 })
    // The same minute again: nothing, however the book moved.
    live.books.SOLUSDT = book('SOLUSDT', 181, 181.02, T0 * 1000 + 30_000)
    expect(tapeLinesOf(state, live, T0 * 1000 + 30_000)).toEqual([])
    // The next minute: every book again, and the minute that closed, once.
    live.btcMinutes = [minute(T0 - 60, true), minute(T0, true), minute(T0 + 60, false)]
    const next = tapeLinesOf(state, live, T0 * 1000 + 65_000)
    expect(next.map((line) => [line.kind, line.pair, line.t])).toEqual([
      ['book', 'BTCUSDT', T0 + 60],
      ['book', 'SOLUSDT', T0 + 60],
      ['minute', 'BTCUSDT', T0]
    ])
    expect(tapeLinesOf(state, live, T0 * 1000 + 70_000)).toEqual([])
    // Every line reads back whole; anything else does not.
    for (const line of [...first, ...next]) expect(parseTapeLine(JSON.parse(JSON.stringify(line)))).toEqual(line)
    expect(parseTapeLine({ ...first[0], v: 'tape-v0' })).toBeNull()
    expect(parseTapeLine({ ...first[0], bid: 'x' })).toBeNull()
    expect(parseTapeLine({ ...first[2], volume: Number.NaN })).toBeNull()
    expect(parseTapeLine({ v: TAPE_VERSION, kind: 'other', t: T0, pair: 'BTCUSDT' })).toBeNull()
    expect(parseTapeLine(null)).toBeNull()
  })

  it('names the day file by the UTC day, and sweeps a day older than the record keeps', () => {
    expect(tapeMinuteOf(T0 * 1000 + 59_999)).toBe(T0)
    expect(tapeDay(T0)).toBe('2026-10-17')
    expect(tapeFileName(T0)).toBe('tape-2026-10-17.jsonl')
    // 180 days before 18 October 2026 is 21 April: a day that ended before that is swept, the day that ended
    // on it is kept.
    const now = Date.UTC(2026, 9, 18) / 1000
    expect(staleDay('2026-04-01', now, 180)).toBe(true)
    expect(staleDay('2026-04-19', now, 180)).toBe(true)
    expect(staleDay('2026-04-20', now, 180)).toBe(false)
    expect(staleDay('2026-04-21', now, 180)).toBe(false)
    expect(staleDay('2026-10-17', now, 180)).toBe(false)
    expect(staleDay('not-a-day', now, 180)).toBe(false)
  })
})
