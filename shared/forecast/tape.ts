import type { LiveState } from '../liveMarket'
import { FORECAST_RECORD_DAYS } from './forecastRecord'

// THE TAPE (V7.2 Stage 5, 18 October 2026): a forward record of what the stream showed, one line a
// minute per streamed pair -- its best bid and ask with their sizes, and when the book was last received
// -- and each of Bitcoin's minutes as it closes, in forecasts/tape-YYYY-MM-DD.jsonl, swept with the record
// (FORECAST_RECORD_DAYS). The forecast's record keeps no spread: a replay (Stage 6) reads the tape for the
// spread and the staleness at each moment where it exists, and assumes the pair's usual spread where it does
// not, said on every report. The clock of the series begins only when it starts; about two megabytes a day
// for a dozen pairs. Arithmetic on what the stream holds: no request, no key, no order.

export const TAPE_VERSION = 'tape-v1'

export interface TapeBookLine {
  v: string
  kind: 'book'
  /** Unix seconds: the start of the minute the book was read in. */
  t: number
  pair: string
  bid: number
  ask: number
  bidQty: number
  askQty: number
  /** Unix milliseconds: when the book was last received, so that a stale one reads as stale. */
  at: number
}

export interface TapeMinuteLine {
  v: string
  kind: 'minute'
  /** Unix seconds: the minute's open. */
  t: number
  pair: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export type TapeLine = TapeBookLine | TapeMinuteLine

/** What the writer keeps between readings: each pair's last minute written, and Bitcoin's last minute. */
export interface TapeState {
  minutes: Map<string, number>
  btcMinute: number
}

export const newTapeState = (): TapeState => ({ minutes: new Map(), btcMinute: 0 })

/** The start of the minute a moment falls in, in seconds. */
export const tapeMinuteOf = (nowMs: number): number => Math.floor(nowMs / 60_000) * 60

/** The day file a line belongs in. */
export const tapeDay = (tSec: number): string => new Date(tSec * 1000).toISOString().slice(0, 10)

export const tapeFileName = (tSec: number): string => `tape-${tapeDay(tSec)}.jsonl`

/** The lines the stream's state adds at a moment: a book line for each pair whose book is held and has
 * not been written this minute (pairs in name order), and a minute line for each of Bitcoin's minutes
 * closed since the last written. The state moves on. */
export function tapeLinesOf(state: TapeState, live: Pick<LiveState, 'books' | 'btcMinutes'>, nowMs: number): TapeLine[] {
  const minute = tapeMinuteOf(nowMs)
  const out: TapeLine[] = []
  for (const symbol of Object.keys(live.books).sort()) {
    const book = live.books[symbol]
    if (!(book.bid > 0) || !(book.ask > 0) || state.minutes.get(symbol) === minute) continue
    state.minutes.set(symbol, minute)
    out.push({ v: TAPE_VERSION, kind: 'book', t: minute, pair: symbol, bid: book.bid, ask: book.ask, bidQty: book.bidQty, askQty: book.askQty, at: book.updatedAt })
  }
  for (const candle of live.btcMinutes) {
    if (!candle.closed || candle.time <= state.btcMinute) continue
    state.btcMinute = candle.time
    out.push({ v: TAPE_VERSION, kind: 'minute', t: candle.time, pair: 'BTCUSDT', open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume })
  }
  return out
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** A tape line read back; null for anything that is not one. */
export function parseTapeLine(value: unknown): TapeLine | null {
  const raw = value as Record<string, unknown> | null
  if (typeof raw !== 'object' || raw === null || raw.v !== TAPE_VERSION || !finite(raw.t) || typeof raw.pair !== 'string') return null
  if (raw.kind === 'book') return finite(raw.bid) && finite(raw.ask) && finite(raw.bidQty) && finite(raw.askQty) && finite(raw.at) ? (raw as unknown as TapeBookLine) : null
  if (raw.kind === 'minute') return finite(raw.open) && finite(raw.high) && finite(raw.low) && finite(raw.close) && finite(raw.volume) ? (raw as unknown as TapeMinuteLine) : null
  return null
}

/** Whether a day file (`YYYY-MM-DD`) is older than the record keeps: its day ended more than `days` ago.
 * A name that is not a day is never stale. */
export function staleDay(day: string, nowSec: number, days: number = FORECAST_RECORD_DAYS): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (match === null) return false
  const ended = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1) / 1000
  return Number.isFinite(ended) && ended < nowSec - days * 86_400
}
