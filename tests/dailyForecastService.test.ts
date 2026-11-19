import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { DailyOutcomeLine } from '../shared/forecast/daily/dailyRecord'
import type { DayBar } from '../shared/forecast/daily/dailySize'

// THE DAILY FORECAST (electron/services/dailyForecastService.ts; V10 Stage 4): a little after each UTC day opens, the
// coins' daily bars brought up to date, the owed outcomes settled once and counted on the board, the day's forecasts made
// once; never from another market's prices.

const counted: DailyOutcomeLine[] = []
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../electron/services/accuracyBoardService', () => ({ takeBoardDailyOutcomes: (lines: DailyOutcomeLine[]) => void counted.push(...lines) }))
vi.mock('../electron/services/forecastService', () => ({ latestForecasts: () => [] }))
vi.mock('../electron/services/exchanges/binance', () => ({ fetchMarketData: async () => ({ response: new Response('[]'), endpoint: { name: 'test' } }), servesBinanceComMarket: () => true }))

const DAY = 86_400
const T0 = Date.UTC(2026, 10, 19) / 1000

/** A coin's bars from `from` to the day in progress at `nowSec`, walking by a seeded rule. */
function history(seed: number): (from: number, nowSec: number) => DayBar[] {
  const all = new Map<number, DayBar>()
  let price = 100
  let state = seed
  for (let time = T0 - 1200 * DAY; time <= T0 + 30 * DAY; time += DAY) {
    state = (state * 1103515245 + 12345) % 2147483648
    const close = price * Math.exp(((state / 2147483648) - 0.5) * 0.06)
    all.set(time, { time, open: price, high: Math.max(price, close) * 1.01, low: Math.min(price, close) * 0.99, close })
    price = close
  }
  return (from, nowSec) => [...all.values()].filter((bar) => bar.time >= from && bar.time <= nowSec).slice(0, 1000)
}

async function setup(): Promise<{ service: typeof import('../electron/services/dailyForecastService'); dir: string; clock: { now: number }; asked: string[]; other: { market: boolean } }> {
  vi.resetModules()
  counted.length = 0
  const service = await import('../electron/services/dailyForecastService')
  service.resetDailyForecast()
  const dir = mkdtempSync(join(tmpdir(), 'daily-'))
  const clock = { now: T0 + 60 }
  const asked: string[] = []
  const other = { market: false }
  const coins: Record<string, ReturnType<typeof history>> = { BTCUSDT: history(5), ETHUSDT: history(9), SOLUSDT: history(13) }
  service.dailySeam.dir = () => dir
  service.dailySeam.nowSec = () => clock.now
  service.dailySeam.pairs = () => Object.keys(coins)
  service.dailySeam.klines = async (symbol, from) => {
    asked.push(`${symbol}@${from}`)
    return other.market ? null : coins[symbol](from, clock.now)
  }
  return { service, dir, clock, asked, other }
}

const lines = (dir: string, prefix: string): { id: string; h?: string }[] =>
  readdirSync(dir)
    .filter((name) => name.startsWith(prefix))
    .flatMap((name) => readFileSync(join(dir, name), 'utf-8').split('\n').filter((line) => line.trim() !== ''))
    .map((line) => JSON.parse(line) as { id: string; h?: string })

describe('the daily forecast', () => {
  it("waits for the day to have opened ten minutes, then makes each coin's forecast once, from its open", async () => {
    const { service, dir, clock, asked } = await setup()
    await service.dailyForecastTurn()
    expect(asked).toEqual([])
    clock.now = T0 + 600
    await service.dailyForecastTurn()
    const view = service.dailyForecastView()
    expect(view.day).toBe(T0)
    expect(view.rows.map((row) => row.pair).sort()).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT'])
    expect(view.rows.every((row) => row.h.day1 !== undefined && row.h.day1.q[2] === 0)).toBe(true)
    expect(lines(dir, 'daily-predictions-')).toHaveLength(3)
    // Again the same day: nothing made twice, nothing read again.
    const before = asked.length
    clock.now = T0 + 1800
    await service.dailyForecastTurn()
    expect(asked).toHaveLength(before)
    expect(lines(dir, 'daily-predictions-')).toHaveLength(3)
  })

  it('settles each horizon once when its days are up, counted on the board, and reads only the days it lacks', async () => {
    const { service, dir, clock, asked } = await setup()
    clock.now = T0 + 600
    await service.dailyForecastTurn()
    asked.length = 0
    // The next day: yesterday's one-day outcomes, and only the day it lacked read.
    clock.now = T0 + DAY + 600
    await service.dailyForecastTurn()
    expect(asked.every((entry) => Number(entry.split('@')[1]) === T0)).toBe(true)
    expect(counted.map((line) => line.h)).toEqual(['day1', 'day1', 'day1'])
    expect(lines(dir, 'daily-outcomes-').filter((line) => line.id.endsWith(`:${T0}`))).toHaveLength(3)
    // Three days on: the first day's three-day outcomes, its one-day ones never again.
    clock.now = T0 + 3 * DAY + 600
    await service.dailyForecastTurn()
    const first = lines(dir, 'daily-outcomes-').filter((line) => line.id.endsWith(`:${T0}`))
    expect(first.map((line) => line.h).sort()).toEqual(['day1', 'day1', 'day1', 'days3', 'days3', 'days3'])
    // A new session reads what was settled and owes the rest.
    vi.resetModules()
    const again = await import('../electron/services/dailyForecastService')
    again.resetDailyForecast()
    Object.assign(again.dailySeam, service.dailySeam)
    clock.now = T0 + 4 * DAY + 600
    await again.dailyForecastTurn()
    const after = lines(dir, 'daily-outcomes-').filter((line) => line.id.endsWith(`:${T0}`))
    expect(after).toHaveLength(6)
  })

  it("keeps no bar of another market's and makes nothing from it", async () => {
    const { service, clock, other } = await setup()
    other.market = true
    clock.now = T0 + 600
    await service.dailyForecastTurn()
    expect(service.dailyForecastView()).toMatchObject({ day: null, rows: [] })
    expect(service.dailyForecastView().problem).toMatch(/thirty days of bars/)
  })
})
