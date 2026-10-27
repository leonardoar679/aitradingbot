import type { Candle } from '../../shared/ipc'
import type { FundingRate } from '../../shared/traders/delay'
import { impactPct } from '../../shared/venueCosts'
import { binanceFundingBudget, binanceFuturesBudget, bitgetMarketBudget } from './httpPacing'

// THE PERPETUALS' PUBLIC MARKET DATA (V8 Stage 6, 26 October 2026): what a trader's coins did on the perpetuals a
// follower would trade -- Binance's USD-M futures first, Bitget's USDT perpetuals where Binance has none -- for the
// tests a trader's record is judged by: the symbols listed, one-minute, fifteen-minute and hourly bars, the funding
// rates published, and the book's impact at a stake. Public data only, each host through its budget
// (electron/services/httpPacing.ts); no key, no signed request, nothing that trades.

export type PerpVenue = 'binance' | 'bitget'
export type PerpInterval = '1m' | '15m' | '1h'

export const PERP_HOSTS: Readonly<Record<PerpVenue, string>> = { binance: 'https://fapi.binance.com', bitget: 'https://api.bitget.com' }

const INTERVAL_SEC: Readonly<Record<PerpInterval, number>> = { '1m': 60, '15m': 900, '1h': 3600 }
const BITGET_GRANULARITY: Readonly<Record<PerpInterval, string>> = { '1m': '1m', '15m': '15m', '1h': '1H' }

/** What the service reads the world through: a test hands in its own. */
export const perpMarketSeam = {
  fetch: (url: string): Promise<Response> => fetch(url, { signal: AbortSignal.timeout(15_000) }),
  now: (): number => Date.now(),
  spendBinance: (weight: number): Promise<void> => binanceFuturesBudget.spend(weight),
  takeBinanceFunding: (): Promise<void> => binanceFundingBudget.take('fundingRate'),
  takeBitget: (endpoint: string): Promise<void> => bitgetMarketBudget.take(endpoint)
}

async function json<T>(url: string): Promise<T> {
  const response = await perpMarketSeam.fetch(url)
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`)
  return (await response.json()) as T
}

interface BitgetEnvelope<T> {
  code?: string
  msg?: string
  data?: T
}

async function bitget<T>(endpoint: string, path: string, query: Record<string, string>): Promise<T> {
  await perpMarketSeam.takeBitget(endpoint)
  const body = await json<BitgetEnvelope<T>>(`${PERP_HOSTS.bitget}${path}?${new URLSearchParams(query)}`)
  if (body.code !== '00000' || body.data === undefined) throw new Error(`Bitget answered ${body.code ?? '?'}: ${body.msg ?? 'no data'}`)
  return body.data
}

const symbolsHeld = new Map<PerpVenue, { at: number; symbols: Set<string> }>()
const SYMBOLS_MAX_AGE_MS = 6 * 3600_000

/** The USDT perpetuals a venue lists and trades now. */
export async function perpSymbols(venue: PerpVenue): Promise<Set<string>> {
  const held = symbolsHeld.get(venue)
  if (held !== undefined && perpMarketSeam.now() - held.at < SYMBOLS_MAX_AGE_MS) return held.symbols
  let symbols: Set<string>
  if (venue === 'binance') {
    await perpMarketSeam.spendBinance(1)
    const info = await json<{ symbols?: { symbol: string; contractType?: string; quoteAsset?: string; status?: string }[] }>(`${PERP_HOSTS.binance}/fapi/v1/exchangeInfo`)
    symbols = new Set((info.symbols ?? []).filter((entry) => entry.contractType === 'PERPETUAL' && entry.quoteAsset === 'USDT' && entry.status === 'TRADING').map((entry) => entry.symbol))
  } else {
    const contracts = await bitget<{ symbol: string; symbolStatus?: string }[]>('contracts', '/api/v2/mix/market/contracts', { productType: 'usdt-futures' })
    symbols = new Set(contracts.filter((entry) => entry.symbolStatus === undefined || entry.symbolStatus === 'normal').map((entry) => entry.symbol))
  }
  symbolsHeld.set(venue, { at: perpMarketSeam.now(), symbols })
  return symbols
}

/** Binance's weight for a page of klines of `limit` bars. */
export const binanceKlinesWeight = (limit: number): number => (limit < 100 ? 1 : limit < 500 ? 2 : limit <= 1000 ? 5 : 10)

/** A perpetual's bars over a span, oldest first: each bar starting at or after `fromSec` and before `toSec`. */
export async function perpBars(venue: PerpVenue, symbol: string, interval: PerpInterval, fromSec: number, toSec: number): Promise<Candle[]> {
  const step = INTERVAL_SEC[interval]
  const out = new Map<number, Candle>()
  let cursor = Math.ceil(fromSec / step) * step
  const end = toSec
  // A page each turn; a span with no bars left ends it.
  for (let pages = 0; cursor < end && pages < 2000; pages++) {
    const left = Math.ceil((end - cursor) / step)
    if (venue === 'binance') {
      const limit = Math.min(1500, Math.max(1, left))
      await perpMarketSeam.spendBinance(binanceKlinesWeight(limit))
      const rows = await json<unknown[][]>(`${PERP_HOSTS.binance}/fapi/v1/klines?${new URLSearchParams({ symbol, interval, startTime: String(cursor * 1000), endTime: String(end * 1000 - 1), limit: String(limit) })}`)
      for (const row of rows) {
        const candle = binanceRowOf(row)
        if (candle !== null && candle.time >= cursor && candle.time < end) out.set(candle.time, candle)
      }
      if (rows.length < limit) break
      cursor += limit * step
    } else {
      const limit = Math.min(200, Math.max(1, left))
      const rows = await bitget<unknown[][]>('history-candles', '/api/v2/mix/market/history-candles', {
        symbol,
        productType: 'usdt-futures',
        granularity: BITGET_GRANULARITY[interval],
        startTime: String(cursor * 1000),
        endTime: String(Math.min(end, cursor + limit * step) * 1000),
        limit: String(limit)
      })
      for (const row of rows) {
        const candle = bitgetRowOf(row)
        if (candle !== null && candle.time >= cursor && candle.time < end) out.set(candle.time, candle)
      }
      cursor += limit * step
    }
  }
  return [...out.values()].sort((a, b) => a.time - b.time)
}

const numberOf = (value: unknown): number => (typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : Number.NaN)

/** A Binance kline: [open time ms, open, high, low, close, volume, ...]. */
export function binanceRowOf(row: unknown[]): Candle | null {
  const [time, open, high, low, close, volume] = row.map(numberOf)
  if (![time, open, high, low, close].every(Number.isFinite) || !(open > 0)) return null
  return { time: Math.floor(time / 1000), open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 }
}

/** A Bitget candle: [time ms, open, high, low, close, base volume, quote volume]. */
export function bitgetRowOf(row: unknown[]): Candle | null {
  return binanceRowOf(row)
}

/** The funding rates a perpetual published over a span, oldest first. */
export async function perpFunding(venue: PerpVenue, symbol: string, fromSec: number, toSec: number): Promise<FundingRate[]> {
  const out = new Map<number, number>()
  if (venue === 'binance') {
    let cursor = fromSec * 1000
    for (let pages = 0; pages < 50; pages++) {
      await perpMarketSeam.takeBinanceFunding()
      const rows = await json<{ fundingTime?: number; fundingRate?: string }[]>(`${PERP_HOSTS.binance}/fapi/v1/fundingRate?${new URLSearchParams({ symbol, startTime: String(cursor), endTime: String(toSec * 1000), limit: '1000' })}`)
      for (const row of rows) {
        const rate = numberOf(row.fundingRate)
        if (typeof row.fundingTime === 'number' && Number.isFinite(rate)) out.set(Math.floor(row.fundingTime / 1000), rate)
      }
      if (rows.length < 1000) break
      cursor = (rows[rows.length - 1].fundingTime as number) + 1
    }
  } else {
    // Bitget pages back from now, newest first: as far back as the span asks.
    for (let pageNo = 1; pageNo <= 40; pageNo++) {
      const rows = await bitget<{ fundingTime?: string; fundingRate?: string }[]>('history-fund-rate', '/api/v2/mix/market/history-fund-rate', { symbol, productType: 'usdt-futures', pageSize: '100', pageNo: String(pageNo) })
      let oldest = Infinity
      for (const row of rows) {
        const time = Math.floor(numberOf(row.fundingTime) / 1000)
        const rate = numberOf(row.fundingRate)
        if (!Number.isFinite(time) || !Number.isFinite(rate)) continue
        oldest = Math.min(oldest, time)
        if (time >= fromSec - 8 * 3600 && time <= toSec) out.set(time, rate)
      }
      if (rows.length < 100 || oldest < fromSec - 8 * 3600) break
    }
  }
  return [...out.entries()].map(([timeSec, rate]) => ({ timeSec, rate })).sort((a, b) => a.timeSec - b.timeSec)
}

/** What a market order of `stakeQuote` pays beyond the best price, the worse of buying and selling, in percent; null
 * where the book read does not hold the stake. */
export async function perpBookImpact(venue: PerpVenue, symbol: string, stakeQuote: number): Promise<number | null> {
  let bids: [number, number][]
  let asks: [number, number][]
  if (venue === 'binance') {
    await perpMarketSeam.spendBinance(2)
    const book = await json<{ bids?: unknown[][]; asks?: unknown[][] }>(`${PERP_HOSTS.binance}/fapi/v1/depth?${new URLSearchParams({ symbol, limit: '50' })}`)
    bids = levelsOf(book.bids)
    asks = levelsOf(book.asks)
  } else {
    const book = await bitget<{ bids?: unknown[][]; asks?: unknown[][] }>('merge-depth', '/api/v2/mix/market/merge-depth', { symbol, productType: 'usdt-futures', limit: '50' })
    bids = levelsOf(book.bids)
    asks = levelsOf(book.asks)
  }
  const buying = impactPct(asks, stakeQuote)
  const selling = impactPct(bids, stakeQuote)
  return buying === null || selling === null ? null : Math.max(buying, selling)
}

function levelsOf(rows: unknown[][] | undefined): [number, number][] {
  return (rows ?? []).map((row) => [numberOf(row[0]), numberOf(row[1])] as [number, number]).filter(([price, size]) => price > 0 && size > 0)
}

/** Test seam. */
export function resetPerpMarket(): void {
  symbolsHeld.clear()
}
