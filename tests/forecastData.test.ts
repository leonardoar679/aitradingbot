import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FORECAST_BAR_SECONDS, barToLine, lastClosedBarTime, type ForecastBar } from '../shared/forecast/bars'

// THE FORECAST'S BARS, KEPT (electron/services/forecastDataService.ts; the V6 document, §15 and §40):
// ninety days of five-minute klines read from the public data host into month files, a page a pair
// at each close after, gaps asked for again once, and a rate limit obeyed. The host is faked here:
// it serves a made-up market whose bars are a function of time, and counts what it was asked.

vi.mock('electron', () => ({ app: { getPath: () => process.env.AI_TEST_USER_DATA } }))

interface Asked {
  symbol: string
  startSec: number
  at: number
}
const asked: Asked[] = []
let limitNext: { status: number; retryAfter: string | null } | null = null
/** Bars the fake exchange never had: a gap. */
let holes = new Set<number>()
/** The data host the fake answers as. */
let hostName = 'data-api.binance.vision'

function fakeBar(symbol: string, time: number): ForecastBar {
  const base = symbol === 'BTCUSDT' ? 60_000 : 2_000
  const close = base * (1 + 0.01 * Math.sin(time / 7200))
  return { time, open: close, high: close * 1.001, low: close * 0.999, close, volume: 5, quoteVolume: 5 * close, takerBuyVolume: 3, trades: 40 }
}

function kline(bar: ForecastBar): unknown[] {
  return [bar.time * 1000, String(bar.open), String(bar.high), String(bar.low), String(bar.close), String(bar.volume), bar.time * 1000 + 299_999, String(bar.quoteVolume), bar.trades, String(bar.takerBuyVolume), '0', '0']
}

vi.mock('../electron/services/exchanges/binance', () => ({
  fetchMarketData: vi.fn(async (path: string) => {
    const url = new URL(`https://data.example${path}`)
    const symbol = url.searchParams.get('symbol') as string
    const startSec = Number(url.searchParams.get('startTime')) / 1000
    const limit = Number(url.searchParams.get('limit'))
    asked.push({ symbol, startSec, at: Date.now() })
    const endpoint = { name: hostName, restRoot: 'https://data.example' }
    if (limitNext !== null) {
      const { status, retryAfter } = limitNext
      limitNext = null
      return { response: new Response('limited', { status, headers: retryAfter === null ? {} : { 'retry-after': retryAfter } }), endpoint }
    }
    // Bars from the start, the one forming included, as Binance answers.
    const nowSec = Math.floor(Date.now() / 1000)
    const rows: unknown[] = []
    for (let time = Math.ceil(startSec / FORECAST_BAR_SECONDS) * FORECAST_BAR_SECONDS; rows.length < limit && time <= nowSec; time += FORECAST_BAR_SECONDS) {
      if (!holes.has(time)) rows.push(kline(fakeBar(symbol, time)))
    }
    return { response: new Response(JSON.stringify(rows), { status: 200 }), endpoint }
  }),
  servesBinanceComMarket: (endpoint: { name: string }) => endpoint.name === 'binance.com' || endpoint.name === 'data-api.binance.vision'
}))

vi.mock('../electron/services/marketResearchService', () => ({
  getResearchState: () => ({ pairs: [] }),
  onResearchUpdate: () => () => undefined
}))

async function service() {
  const mod = await import('../electron/services/forecastDataService')
  mod.forecastDataForTest.reset()
  mod.forecastDataForTest.setPacing(0)
  return mod
}

const dir = (): string => join(process.env.AI_TEST_USER_DATA as string, 'forecastData')

function linesIn(symbol: string): number[][] {
  return readdirSync(dir())
    .filter((name) => name.startsWith(`${symbol}-`))
    .flatMap((name) =>
      readFileSync(join(dir(), name), 'utf-8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as number[])
    )
}

beforeEach(() => {
  vi.resetModules()
  process.env.AI_TEST_USER_DATA = mkdtempSync(join(tmpdir(), 'forecast-data-'))
  asked.length = 0
  limitNext = null
  holes = new Set()
  hostName = 'data-api.binance.vision'
})

describe('a first start', () => {
  it('reads ninety days of closed bars a page at a time into month files, counted', async () => {
    const data = await service()
    data.forecastDataForTest.setUniverse(['BTCUSDT'])
    await data.forecastDataForTest.pass()
    const last = lastClosedBarTime(Math.floor(Date.now() / 1000))
    const stored = linesIn('BTCUSDT').map((line) => line[0])
    // Every bar of the ninety days, once, oldest first in time, and none still forming.
    expect(stored.length).toBe(new Set(stored).size)
    expect(Math.max(...stored)).toBe(last)
    expect(Math.min(...stored)).toBeLessThanOrEqual(last - 89 * 86_400)
    expect(stored.length).toBeGreaterThanOrEqual(90 * 288 - 1)
    // 26 or 27 pages, depending on where in its five minutes the test runs; each page past the last.
    expect(asked.length).toBeGreaterThanOrEqual(26)
    expect(asked.length).toBeLessThanOrEqual(27)
    expect(asked.every((entry, index) => index === 0 || entry.startSec > asked[index - 1].startSec)).toBe(true)
    const status = data.getForecastDataStatus()
    expect(status).toMatchObject({ requests: asked.length, weight: asked.length * 2, failures: 0, pairs: 1, ready: 1 })
    expect(status.barsWritten).toBe(stored.length)
    // Each bar in the file of the UTC month it opened in.
    for (const name of readdirSync(dir())) {
      const month = /^BTCUSDT-(\d{4}-\d{2})\.jsonl$/.exec(name)?.[1]
      expect(month, name).toBeDefined()
      const lines = readFileSync(join(dir(), name), 'utf-8').split('\n').filter((line) => line.trim() !== '')
      expect(lines.every((line) => new Date((JSON.parse(line) as number[])[0] * 1000).toISOString().slice(0, 7) === month), name).toBe(true)
    }
  })

  it('reads across a gap the exchange left without leaving a hole of its own after it', async () => {
    // Two hours the exchange never had, forty days back: the page across them reaches further in time.
    const last = lastClosedBarTime(Math.floor(Date.now() / 1000))
    const gapFrom = last - 40 * 86_400 - ((last - 40 * 86_400) % 3600)
    for (let time = gapFrom; time < gapFrom + 7200; time += FORECAST_BAR_SECONDS) holes.add(time)
    const data = await service()
    data.forecastDataForTest.setUniverse(['ETHUSDT'])
    await data.forecastDataForTest.pass()
    const stored = linesIn('ETHUSDT').map((line) => line[0]).sort((a, b) => a - b)
    const first = stored[0]
    const expected: number[] = []
    for (let time = first; time <= last; time += FORECAST_BAR_SECONDS) if (!holes.has(time)) expected.push(time)
    expect(stored).toEqual(expected)
  })

  it('paces its requests, at most about eight a second', async () => {
    const data = await service()
    data.forecastDataForTest.reset()
    const last = lastClosedBarTime(Math.floor(Date.now() / 1000))
    // A thousand and one bars behind: two pages.
    const from = last - 1001 * FORECAST_BAR_SECONDS
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir(), { recursive: true })
    writeFileSync(join(dir(), `BTCUSDT-${new Date(from * 1000).toISOString().slice(0, 7)}.jsonl`), JSON.stringify(barToLine(fakeBar('BTCUSDT', from))) + '\n')
    data.forecastDataForTest.setUniverse(['BTCUSDT'])
    await data.forecastDataForTest.pass()
    expect(asked).toHaveLength(2)
    expect(asked[1].at - asked[0].at).toBeGreaterThanOrEqual(120)
  })

  it('holds three days of five-minute bars and a month of whole hours built from them', async () => {
    const data = await service()
    data.forecastDataForTest.setUniverse(['ETHUSDT'])
    await data.forecastDataForTest.pass()
    const held = data.forecastSeries('ETHUSDT')
    expect(held).not.toBeNull()
    const nowSec = Math.floor(Date.now() / 1000)
    expect(held!.m5.length).toBeGreaterThan(3 * 288 - 2)
    expect(held!.m5[0].time).toBeGreaterThanOrEqual(nowSec - 3 * 86_400)
    expect(held!.h1.length).toBeGreaterThanOrEqual(32 * 24 - 2)
    expect(held!.h1.every((hour) => hour.parts === 12 && hour.time % 3600 === 0 && hour.time + 3600 <= nowSec)).toBe(true)
    // An hour reads as the sum of its bars.
    const hour = held!.h1[held!.h1.length - 1]
    expect(hour.volume).toBeCloseTo(60)
    expect(hour.trades).toBe(480)
  })
})

describe('a pass after', () => {
  it('asks for one page from the bar after the last stored, and writes only the new bars', async () => {
    const data = await service()
    data.forecastDataForTest.setUniverse(['BTCUSDT'])
    await data.forecastDataForTest.pass()
    const before = linesIn('BTCUSDT').length
    asked.length = 0
    await data.forecastDataForTest.pass()
    // Nothing closed since: at most the one page asked, and nothing written twice.
    expect(asked.length).toBeLessThanOrEqual(1)
    const after = linesIn('BTCUSDT').map((line) => line[0])
    expect(after.length).toBe(new Set(after).size)
    expect(after.length - before).toBeLessThanOrEqual(1)
  })
})

describe('a rate limit', () => {
  it('stops every request while its wait lasts, says until when, and the pass ends where it is', async () => {
    const data = await service()
    data.forecastDataForTest.setUniverse(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'])
    limitNext = { status: 429, retryAfter: '30' }
    const started = Date.now()
    await data.forecastDataForTest.pass()
    const status = data.getForecastDataStatus()
    expect(status.rateLimitedUntil).toBeGreaterThanOrEqual(Math.floor(started / 1000) + 29)
    expect(status.failures).toBeGreaterThanOrEqual(1)
    // The limited request, and at most the two other lanes' requests already on their way.
    expect(asked.length).toBeLessThanOrEqual(3)
    const before = asked.length
    await data.forecastDataForTest.pass()
    expect(asked).toHaveLength(before)
    expect(data.getForecastDataStatus().lastError).toMatch(/429/)
  })
})

describe('a data host that serves another market', () => {
  it("has its bars refused, every pair, and the next pass on binance.com's host keeps them", async () => {
    const data = await service()
    data.forecastDataForTest.setUniverse(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'])
    hostName = 'binance.us'
    await data.forecastDataForTest.pass()
    // The pass ends at the refusal: the refused request, and at most the two other lanes' first.
    expect(asked.length).toBeLessThanOrEqual(3)
    const refused = data.getForecastDataStatus()
    expect(refused.refusedHost).toBe('binance.us')
    expect(refused.lastError).toMatch(/binance\.us, another market/)
    expect(refused.barsWritten).toBe(0)
    const { existsSync } = await import('node:fs')
    expect(existsSync(dir()) ? readdirSync(dir()) : []).toEqual([])
    hostName = 'data-api.binance.vision'
    await data.forecastDataForTest.pass()
    const kept = data.getForecastDataStatus()
    expect(kept.refusedHost).toBeNull()
    expect(kept.barsWritten).toBeGreaterThan(4 * 25_000)
  })

  it('stops a pair\'s gap repairs at the first refusal, and loads it again once the host is binance.com\'s', async () => {
    const last = lastClosedBarTime(Math.floor(Date.now() / 1000))
    const from = last - 86_400
    // Three gaps on file.
    const missing = [from + 3600, from + 7200, from + 10_800]
    const bars: ForecastBar[] = []
    for (let time = from; time <= last; time += FORECAST_BAR_SECONDS) if (!missing.includes(time)) bars.push(fakeBar('BTCUSDT', time))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir(), { recursive: true })
    writeFileSync(join(dir(), `BTCUSDT-${new Date(from * 1000).toISOString().slice(0, 7)}.jsonl`), bars.map((entry) => JSON.stringify(barToLine(entry))).join('\n') + '\n')
    const data = await service()
    data.forecastDataForTest.setUniverse(['BTCUSDT'])
    hostName = 'binance.us'
    await data.forecastDataForTest.pass()
    expect(asked).toHaveLength(1)
    expect(data.forecastSeries('BTCUSDT')).toBeNull()
    hostName = 'data-api.binance.vision'
    asked.length = 0
    await data.forecastDataForTest.pass()
    expect(asked.filter((entry) => missing.includes(entry.startSec))).toHaveLength(3)
    expect(data.forecastSeries('BTCUSDT')).not.toBeNull()
  })
})

describe('a catch-up of a little more than three days', () => {
  it('builds every hour it brings, though its first bars are older than the five-minute window', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const last = lastClosedBarTime(nowSec)
    // Forty days on file, ending 3.3 days ago: one page of about 950 bars brings it up to date.
    const end = last - Math.round(3.3 * 288) * FORECAST_BAR_SECONDS
    const byMonth = new Map<string, string[]>()
    for (let time = end - 40 * 86_400; time <= end; time += FORECAST_BAR_SECONDS) {
      const month = new Date(time * 1000).toISOString().slice(0, 7)
      byMonth.set(month, [...(byMonth.get(month) ?? []), JSON.stringify(barToLine(fakeBar('BTCUSDT', time)))])
    }
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir(), { recursive: true })
    for (const [month, lines] of byMonth) writeFileSync(join(dir(), `BTCUSDT-${month}.jsonl`), lines.join('\n') + '\n')
    const data = await service()
    data.forecastDataForTest.setUniverse(['BTCUSDT'])
    await data.forecastDataForTest.pass()
    expect(asked).toHaveLength(1)
    const hours = data.forecastSeries('BTCUSDT')!.h1.map((hour) => hour.time)
    // Every hour of the month held, none missing, the newest ended.
    for (let index = 1; index < hours.length; index++) expect(hours[index] - hours[index - 1]).toBe(3600)
    expect(hours[hours.length - 1] + 3600).toBeGreaterThan(nowSec - 3600)
    expect(hours[0]).toBeLessThanOrEqual(nowSec - 31 * 86_400)
  })
})

describe('a gap left on file', () => {
  it('is asked for once at the next start, and the bars it was missing are written', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const last = lastClosedBarTime(nowSec)
    // Two days on file, with an hour missing in the middle.
    const from = last - 2 * 86_400
    const missingFrom = from + 86_400
    const bars: ForecastBar[] = []
    for (let time = from; time <= last; time += FORECAST_BAR_SECONDS) if (time < missingFrom || time >= missingFrom + 3600) bars.push(fakeBar('BTCUSDT', time))
    const month = new Date(from * 1000).toISOString().slice(0, 7)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir(), { recursive: true })
    // Written in one month file, whatever months it spans: the reader sorts.
    writeFileSync(join(dir(), `BTCUSDT-${month}.jsonl`), bars.map((entry) => JSON.stringify(barToLine(entry))).join('\n') + '\n')
    const data = await service()
    data.forecastDataForTest.setUniverse(['BTCUSDT'])
    await data.forecastDataForTest.pass()
    expect(asked.some((entry) => entry.startSec === missingFrom)).toBe(true)
    const stored = new Set(linesIn('BTCUSDT').map((line) => line[0]))
    for (let time = missingFrom; time < missingFrom + 3600; time += FORECAST_BAR_SECONDS) expect(stored.has(time)).toBe(true)
  })

  it('that the exchange never had is asked for once, not at every pass', async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const last = lastClosedBarTime(nowSec)
    const from = last - 86_400
    const missingFrom = from + 3600
    for (let time = missingFrom; time < missingFrom + 1800; time += FORECAST_BAR_SECONDS) holes.add(time)
    const bars: ForecastBar[] = []
    for (let time = from; time <= last; time += FORECAST_BAR_SECONDS) if (!holes.has(time)) bars.push(fakeBar('BTCUSDT', time))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir(), { recursive: true })
    writeFileSync(join(dir(), `BTCUSDT-${new Date(from * 1000).toISOString().slice(0, 7)}.jsonl`), bars.map((entry) => JSON.stringify(barToLine(entry))).join('\n') + '\n')
    const data = await service()
    data.forecastDataForTest.setUniverse(['BTCUSDT'])
    await data.forecastDataForTest.pass()
    await data.forecastDataForTest.pass()
    expect(asked.filter((entry) => entry.startSec === missingFrom)).toHaveLength(1)
  })
})

describe('the sweep at start', () => {
  it('deletes a month file past the history kept, and keeps the rest', async () => {
    const { mkdirSync } = await import('node:fs')
    mkdirSync(dir(), { recursive: true })
    writeFileSync(join(dir(), 'BTCUSDT-2026-05.jsonl'), '')
    writeFileSync(join(dir(), 'BTCUSDT-2026-10.jsonl'), '')
    writeFileSync(join(dir(), 'notes.txt'), '')
    const data = await service()
    expect(await data.forecastDataForTest.sweepOldMonths(Date.parse('2026-10-14T00:00:00Z') / 1000)).toBe(1)
    expect(readdirSync(dir()).sort()).toEqual(['BTCUSDT-2026-10.jsonl', 'notes.txt'])
  })
})
