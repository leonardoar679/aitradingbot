import type { Exchange, ExchangeQuote, MarketComparison } from '../../shared/ipc'
import { quoteOf, type BookLevels, type QuoteReads } from '../../shared/marketCompare'
import { binanceAdapter, fetchMarketData } from './exchanges/binance'
import { bitgetAdapter, fetchBitgetBook } from './exchanges/bitget'

// THE COMPARISON OF EXCHANGES (V7.1 Stage 6): Binance's and Bitget's quote of one pair, read at the
// same moment from their PUBLIC market data -- the book to a hundred levels and the day's ticker --
// and judged by shared/marketCompare.ts. Nothing here is signed, and nothing is placed.

/** Levels asked of each book: enough for half a percent of depth on a liquid pair. */
const BOOK_LEVELS = 100
const READ_TIMEOUT_MS = 10_000

interface BinanceDepth {
  bids: [string, string][]
  asks: [string, string][]
}

async function readBinance(symbol: string): Promise<QuoteReads> {
  const sentAt = Date.now()
  try {
    const [depth, ticker] = await Promise.all([
      fetchMarketData(`/depth?symbol=${encodeURIComponent(symbol)}&limit=${BOOK_LEVELS}`, READ_TIMEOUT_MS).then(async ({ response, endpoint }) => {
        if (!response.ok) throw new Error(`${endpoint.name} depth request failed: ${response.status}`)
        return (await response.json()) as BinanceDepth
      }),
      binanceAdapter.fetchTicker24h(symbol)
    ])
    const level = (row: [string, string]): [number, number] => [Number(row[0]), Number(row[1])]
    const book: BookLevels = { bids: depth.bids.map(level), asks: depth.asks.map(level) }
    // Binance's depth carries an update id, not a clock: its age is not known.
    return { book, bookTs: null, lastPrice: ticker.lastPrice, quoteVolume24h: ticker.quoteVolume, roundTripMs: Date.now() - sentAt, problem: null }
  } catch (error) {
    return { book: null, bookTs: null, lastPrice: null, quoteVolume24h: null, roundTripMs: Date.now() - sentAt, problem: error instanceof Error ? error.message : String(error) }
  }
}

async function readBitget(symbol: string): Promise<QuoteReads> {
  const sentAt = Date.now()
  try {
    const [book, ticker] = await Promise.all([fetchBitgetBook(symbol, BOOK_LEVELS), bitgetAdapter.fetchTicker24h(symbol)])
    return { book, bookTs: Number.isFinite(book.ts) ? book.ts : null, lastPrice: ticker.lastPrice, quoteVolume24h: ticker.quoteVolume, roundTripMs: Date.now() - sentAt, problem: null }
  } catch (error) {
    return { book: null, bookTs: null, lastPrice: null, quoteVolume24h: null, roundTripMs: Date.now() - sentAt, problem: error instanceof Error ? error.message : String(error) }
  }
}

const READERS: Partial<Record<Exchange, (symbol: string) => Promise<QuoteReads>>> = { binance: readBinance, bitget: readBitget }

/** The exchanges compared, in the order shown. */
export const COMPARED_EXCHANGES: Exchange[] = ['binance', 'bitget']

export async function compareMarkets(symbol: string): Promise<MarketComparison> {
  const upper = symbol.toUpperCase()
  const quotes: ExchangeQuote[] = await Promise.all(
    COMPARED_EXCHANGES.map(async (exchange) => {
      const reader = READERS[exchange]
      const reads = reader === undefined ? { book: null, bookTs: null, lastPrice: null, quoteVolume24h: null, roundTripMs: null, problem: `${exchange} is not compared` } : await reader(upper)
      return quoteOf(exchange, upper, reads, Date.now())
    })
  )
  return { symbol: upper, at: Date.now(), quotes }
}
