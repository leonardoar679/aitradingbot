import { beforeEach, describe, expect, it, vi } from 'vitest'
import { barToLine, type ForecastBar } from '../shared/forecast/bars'
import { dayMoveRatesOf } from '../shared/forecast/bigMovers'
import { moveRatesOf } from '../shared/forecast/moveRates'
import { pairRatesOf } from '../shared/forecast/pairRates'
import { runTask } from '../shared/tasks'

// A PAIR'S NINETY DAYS (shared/forecast/pairRates.ts, electron/services/pairRatesService.ts; V8 Stage 10): the live
// forecast holds three days of bars, so a pair's ninety-day move rates and day moves are read once an hour from its
// files, as text handed to a worker that reads the bars as the data service does; the pass and the Forecast Lab read
// what it last worked out.

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const T0 = 1_790_000_000 - (1_790_000_000 % 86_400)
const DAY_BARS = 288

/** Forty days of five-minute bars stepping 6% a day, 12% every fourth. */
function bars(days = 40): ForecastBar[] {
  const out: ForecastBar[] = []
  let price = 100
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < DAY_BARS; k++) {
      const time = T0 + (d * DAY_BARS + k) * 300
      out.push({ time, open: price, high: price, low: price, close: price, volume: 1, quoteVolume: price, takerBuyVolume: 0.5, trades: 1 })
    }
    price *= d % 4 === 3 ? 1.12 : 1.06
  }
  return out
}
const textOf = (list: readonly ForecastBar[]): string => list.map((bar) => JSON.stringify(barToLine(bar))).join('\n') + '\n'

describe("a pair's files read", () => {
  it('reads both rates from the months merged as the data service reads them, a torn line skipped and a bar kept once', () => {
    const all = bars()
    const atSec = all[all.length - 1].time + 300
    const split = 20 * DAY_BARS
    // The second month's file starts with a bar the first ends with, read again, holds a line short of a figure, and a
    // torn last line.
    const texts = [textOf(all.slice(0, split)), textOf(all.slice(split - 1)) + '[1790000000,1,2,1,2]\n[1790000000,1,2']
    const read = pairRatesOf(texts, atSec)
    expect(read.bars).toBe(all.length)
    expect(read.moveRates).toEqual(moveRatesOf(all, atSec))
    expect(read.dayMoves).toEqual(dayMoveRatesOf(all, atSec))
    expect(read.dayMoves!.rates[5]).toBeCloseTo(1, 9)
    // Under thirty days of hours: neither is said.
    expect(pairRatesOf([textOf(all.slice(0, 20 * DAY_BARS))], atSec)).toEqual({ bars: 20 * DAY_BARS, moveRates: null, dayMoves: null })
  })

  it('is a task of the worker, which refuses a payload that is not texts and a moment', () => {
    const all = bars()
    const atSec = all[all.length - 1].time + 300
    expect(runTask({ id: 1, task: 'pairRates', payload: { texts: [textOf(all)], atSec } })).toEqual({ id: 1, ok: true, result: pairRatesOf([textOf(all)], atSec) })
    const refusal = "A pair's rates are read from its files' texts and the moment they are read at."
    expect(runTask({ id: 2, task: 'pairRates', payload: { texts: 'one', atSec } })).toEqual({ id: 2, ok: false, message: refusal })
    expect(runTask({ id: 3, task: 'pairRates', payload: { texts: [1], atSec } })).toEqual({ id: 3, ok: false, message: refusal })
    expect(runTask({ id: 4, task: 'pairRates', payload: { texts: [] } })).toEqual({ id: 4, ok: false, message: refusal })
    expect(runTask({ id: 5, task: 'pairRates', payload: null })).toEqual({ id: 5, ok: false, message: refusal })
  })
})

describe('the hourly refresh', () => {
  type Service = typeof import('../electron/services/pairRatesService')
  let service: Service
  let asked: { pair: string; atSec: number }[]
  let answers: Map<string, () => Promise<unknown>>

  beforeEach(async () => {
    vi.resetModules()
    service = await import('../electron/services/pairRatesService')
    service.resetPairRates()
    asked = []
    answers = new Map()
    service.pairRatesSeam.texts = async (pair: string) => (pair === 'NONEUSDT' ? [] : [`${pair} text`])
    service.pairRatesSeam.run = (async (_task: string, payload: unknown) => {
      const { texts, atSec } = payload as { texts: string[]; atSec: number }
      const pair = texts[0].split(' ')[0]
      asked.push({ pair, atSec })
      const answer = answers.get(pair)
      if (answer !== undefined) return answer()
      return { ok: true, result: { bars: 1, moveRates: null, dayMoves: { moments: 720, rates: { 5: 0.5, 10: 0.1 } } } }
    }) as Service['pairRatesSeam']['run']
  })

  it("reads every pair at the hour's close, one after another, once an hour, and keeps each one's", async () => {
    const hour = 1_790_002_800
    await service.refreshPairRates(['AAAUSDT', 'NONEUSDT', 'BBBUSDT'], hour + 300)
    // Read at the whole hour the close falls in; a pair with no files is not asked.
    expect(asked).toEqual([
      { pair: 'AAAUSDT', atSec: hour },
      { pair: 'BBBUSDT', atSec: hour }
    ])
    expect(service.heldPairRates('AAAUSDT')).toEqual({ bars: 1, moveRates: null, dayMoves: { moments: 720, rates: { 5: 0.5, 10: 0.1 } }, atSec: hour })
    expect(service.heldPairRates('NONEUSDT')).toBeUndefined()
    // Later closes of the same hour read nothing again; the next hour's first does.
    await service.refreshPairRates(['AAAUSDT', 'BBBUSDT'], hour + 3300)
    expect(asked).toHaveLength(2)
    await service.refreshPairRates(['AAAUSDT', 'BBBUSDT'], hour + 3600)
    expect(asked.slice(2)).toEqual([
      { pair: 'AAAUSDT', atSec: hour + 3600 },
      { pair: 'BBBUSDT', atSec: hour + 3600 }
    ])
  })

  it('keeps what a pair had when its worker fails, drops a pair no longer read, and runs one refresh at a time', async () => {
    const hour = 1_790_002_800
    await service.refreshPairRates(['AAAUSDT', 'BBBUSDT'], hour)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    answers.set('AAAUSDT', async () => ({ ok: false, reason: 'timeout', message: 'pairRates took longer than 30000 ms and was stopped' }))
    let release: () => void = () => undefined
    answers.set('CCCUSDT', () => new Promise((resolve) => (release = () => resolve({ ok: true, result: { bars: 2, moveRates: null, dayMoves: null } }))))
    const running = service.refreshPairRates(['AAAUSDT', 'CCCUSDT'], hour + 3600)
    // Told again while it runs, even for a later hour: the same refresh.
    expect(service.refreshPairRates(['AAAUSDT', 'CCCUSDT'], hour + 7200)).toBe(running)
    await vi.waitFor(() => expect(asked.at(-1)).toEqual({ pair: 'CCCUSDT', atSec: hour + 3600 }))
    release()
    await running
    expect(service.heldPairRates('AAAUSDT')?.atSec).toBe(hour)
    expect(errors.mock.calls[0][0]).toBe("AAAUSDT's ninety-day rates could not be read (timeout): pairRates took longer than 30000 ms and was stopped")
    expect(service.heldPairRates('BBBUSDT')).toBeUndefined()
    expect(service.heldPairRates('CCCUSDT')).toEqual({ bars: 2, moveRates: null, dayMoves: null, atSec: hour + 3600 })
    errors.mockRestore()
  })
})
