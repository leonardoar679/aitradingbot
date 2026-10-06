import WebSocket from 'ws'
import type { ExecutorConfig } from '../../shared/ipc'
import {
  LIVE_MAX_DEPTH_PAIRS,
  LIVE_MAX_INTEREST,
  LIVE_PUSH_MS,
  emptyLiveState,
  foldMinute,
  isStale,
  type LiveBook,
  type LiveMinute,
  type LiveState
} from '../../shared/liveMarket'
import { fetchMarketData, resolveEndpoint } from './exchanges/binance'
import { createReconnectingSocket } from './exchanges/reconnectingSocket'
import { scanSourceFor } from './marketService'
import { getSettings } from './settingsService'

// THE LIVE MARKET: ONE PUBLIC SOCKET TO BINANCE'S MARKET-DATA HOST (the second V3 document, §7-8).
//
// Candles are context; this is the price now. It streams, for the pairs that matter at the moment,
// the best bid and ask and the minute forming: the pairs the window is showing a recommendation on
// (Right Now, Overview), and the pairs the app's own paper trades are open on. Bitcoin's and ether's
// minutes are always streamed, so how far Bitcoin has moved since an event is known at any moment.
// The five best levels are read for the first few pairs shown, to say how much a fill could take.
//
// Not every pair's book: a liquid pair's best bid and ask changes many times a second (Bitcoin's
// more than a hundred), and only the pairs a person or a paper trade is looking at need it.
//
// IT READS PUBLIC DATA FROM THE DATA HOST, never the one that trades, and holds no key. It asks no
// model and places nothing. What it holds is in memory, and what the window is sent of it is sent
// at most four times a second.

const ALWAYS_MINUTES = ['BTCUSDT', 'ETHUSDT']
const BTC_MINUTES_KEPT = 130
const MINUTES_KEPT = 12
/** No message for this long while streams are wanted is a gap, kept for the session report. */
const GAP_SECONDS = 60
const GAPS_KEPT = 50
const OWN_TRADES_REFRESH_MS = 60_000
const REST_TIMEOUT_MS = 6_000
const SYMBOL = /^[A-Z0-9]{2,30}$/

let state: LiveState = emptyLiveState()
let interest: string[] = []
let ownTrades: string[] = []
let socket: WebSocket | null = null
let stopSocket: (() => void) | null = null
let subscribed = new Set<string>()
let requestId = 0
let dirty = false
let started = false
const listeners = new Set<(state: LiveState) => void>()

export function onLiveUpdate(listener: (state: LiveState) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function getLiveState(): LiveState {
  return state
}

const lower = (symbol: string): string => symbol.toLowerCase()

/** The pairs whose book is streamed: those shown, then those the app's own paper trades are on. */
function bookPairs(): string[] {
  return [...new Set([...interest, ...ownTrades])].slice(0, LIVE_MAX_INTEREST + ownTrades.length)
}

function wantedStreams(): Set<string> {
  const streams = new Set<string>(ALWAYS_MINUTES.map((symbol) => `${lower(symbol)}@kline_1m`))
  for (const symbol of bookPairs()) {
    streams.add(`${lower(symbol)}@bookTicker`)
    streams.add(`${lower(symbol)}@kline_1m`)
  }
  for (const symbol of interest.slice(0, LIVE_MAX_DEPTH_PAIRS)) streams.add(`${lower(symbol)}@depth5`)
  return streams
}

/** Asks the open socket for the streams wanted now and to stop the rest, and forgets what is no
 * longer streamed. On a socket not yet open, its opening does this. */
function syncStreams(): void {
  const wanted = wantedStreams()
  const keep = new Set([...wanted].map((stream) => stream.split('@')[0].toUpperCase()))
  const prune = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([symbol]) => keep.has(symbol)))
  state = { ...state, books: prune(state.books), depth: prune(state.depth), minutes: prune(state.minutes) }
  dirty = true
  if (socket === null || socket.readyState !== WebSocket.OPEN) return
  const add = [...wanted].filter((stream) => !subscribed.has(stream))
  const drop = [...subscribed].filter((stream) => !wanted.has(stream))
  if (add.length > 0) socket.send(JSON.stringify({ method: 'SUBSCRIBE', params: add, id: ++requestId }))
  if (drop.length > 0) socket.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: drop, id: ++requestId }))
  subscribed = wanted
}

function noteMessage(nowMs: number): void {
  const connection = state.connection
  const gaps = connection.gaps
  const last = gaps[gaps.length - 1]
  const closedGap = last !== undefined && last.to === null ? [...gaps.slice(0, -1), { ...last, to: Math.floor(nowMs / 1000) }] : gaps
  state = { ...state, connection: { ...connection, lastMessageAt: nowMs, gaps: closedGap } }
}

function asNumber(value: unknown): number {
  return typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN
}

function handle(raw: Buffer): void {
  let parsed: { stream?: unknown; data?: Record<string, unknown> }
  try {
    parsed = JSON.parse(raw.toString()) as typeof parsed
  } catch {
    return
  }
  if (typeof parsed.stream !== 'string' || typeof parsed.data !== 'object' || parsed.data === null) return
  const nowMs = Date.now()
  noteMessage(nowMs)
  const [name, kind] = parsed.stream.split('@')
  const symbol = name.toUpperCase()
  const data = parsed.data
  if (kind === 'bookTicker') {
    const book: LiveBook = { symbol, bid: asNumber(data.b), bidQty: asNumber(data.B), ask: asNumber(data.a), askQty: asNumber(data.A), updatedAt: nowMs, source: 'stream' }
    if ([book.bid, book.ask, book.bidQty, book.askQty].every(Number.isFinite)) state = { ...state, books: { ...state.books, [symbol]: book } }
  } else if (kind === 'kline_1m') {
    const k = data.k as Record<string, unknown> | undefined
    if (k === undefined) return
    const minute: LiveMinute = {
      time: Math.floor(asNumber(k.t) / 1000),
      open: asNumber(k.o),
      high: asNumber(k.h),
      low: asNumber(k.l),
      close: asNumber(k.c),
      volume: asNumber(k.v),
      closed: k.x === true
    }
    if (![minute.time, minute.open, minute.close].every(Number.isFinite)) return
    if (symbol === 'BTCUSDT') state = { ...state, btcMinutes: foldMinute(state.btcMinutes, minute, BTC_MINUTES_KEPT) }
    state = { ...state, minutes: { ...state.minutes, [symbol]: foldMinute(state.minutes[symbol] ?? [], minute, MINUTES_KEPT) } }
  } else if (kind === 'depth5') {
    const levels = (value: unknown): [number, number][] =>
      Array.isArray(value) ? value.map((level) => [asNumber((level as unknown[])[0]), asNumber((level as unknown[])[1])] as [number, number]).filter(([price, qty]) => price > 0 && qty >= 0) : []
    state = { ...state, depth: { ...state.depth, [symbol]: { symbol, bids: levels(data.bids), asks: levels(data.asks), updatedAt: nowMs } } }
  } else return
  dirty = true
}

async function seedMinutes(symbol: string): Promise<void> {
  try {
    const bars = await scanSourceFor('binance').fetchRecentCandles(symbol, '1m', symbol === 'BTCUSDT' ? BTC_MINUTES_KEPT : MINUTES_KEPT)
    const nowSec = Math.floor(Date.now() / 1000)
    let minutes = symbol === 'BTCUSDT' ? state.btcMinutes : state.minutes[symbol] ?? []
    for (const bar of bars) {
      // What the stream already sent is newer than a fetch of the same minute.
      if (minutes.some((minute) => minute.time === bar.time)) continue
      minutes = foldMinute(minutes, { ...bar, closed: bar.time + 60 <= nowSec }, symbol === 'BTCUSDT' ? BTC_MINUTES_KEPT : MINUTES_KEPT)
    }
    state = symbol === 'BTCUSDT' ? { ...state, btcMinutes: minutes } : { ...state, minutes: { ...state.minutes, [symbol]: minutes } }
    dirty = true
  } catch (error) {
    console.warn(`Live market: ${symbol}'s recent minutes could not be read:`, error)
  }
}

async function ensureSocket(): Promise<void> {
  if (stopSocket !== null) return
  const endpoint = await resolveEndpoint()
  if (stopSocket !== null) return
  const base = endpoint.wsBase.replace(/\/ws$/, '')
  stopSocket = createReconnectingSocket(`${base}/stream?streams=${ALWAYS_MINUTES.map((symbol) => `${lower(symbol)}@kline_1m`).join('/')}`, {
    onOpen: (current) => {
      socket = current
      subscribed = new Set(ALWAYS_MINUTES.map((symbol) => `${lower(symbol)}@kline_1m`))
      state = { ...state, connection: { ...state.connection, open: true, connects: state.connection.connects + 1 } }
      current.on('close', () => {
        if (socket !== current) return
        socket = null
        state = { ...state, connection: { ...state.connection, open: false, drops: state.connection.drops + 1 } }
        dirty = true
      })
      syncStreams()
    },
    onMessage: handle,
    onError: (error) => console.error(`${endpoint.name} live market socket error:`, error)
  })
}

/** Watches for a stream that has gone quiet: a minute with no message while streams are wanted is
 * written down as a gap, and closed by the next message. */
function checkGap(): void {
  const { connection } = state
  const nowMs = Date.now()
  const last = connection.gaps[connection.gaps.length - 1]
  if (last !== undefined && last.to === null) return
  const since = connection.lastMessageAt
  if (since === null || nowMs - since < GAP_SECONDS * 1000) return
  state = { ...state, connection: { ...connection, gaps: [...connection.gaps, { from: Math.floor(since / 1000), to: null }].slice(-GAPS_KEPT) } }
  dirty = true
}

/** The pairs the app's own paper trades are open on: their books are streamed whatever is shown. */
async function readOwnTrades(): Promise<void> {
  try {
    const { executors } = await getSettings()
    const pairs = [
      ...new Set(
        executors
          .filter((executor: ExecutorConfig) => executor.status === 'active' && executor.mode === 'paper' && executor.type === 'position' && (executor.watch !== undefined || executor.newsRule !== undefined))
          .map((executor) => executor.symbol)
          .filter((symbol) => SYMBOL.test(symbol))
      )
    ].sort()
    if (pairs.join(',') !== ownTrades.join(',')) {
      ownTrades = pairs
      syncStreams()
    }
  } catch (error) {
    console.warn('Live market: the open paper trades could not be read:', error)
  }
}

/** The pairs the window is showing a recommendation on, strongest first. Replaces what it said
 * before; what is no longer wanted stops streaming. */
export async function setLiveInterest(symbols: unknown): Promise<void> {
  const next = Array.isArray(symbols) ? [...new Set(symbols.filter((symbol): symbol is string => typeof symbol === 'string' && SYMBOL.test(symbol)))].slice(0, LIVE_MAX_INTEREST) : []
  const added = next.filter((symbol) => !interest.includes(symbol))
  interest = next
  await ensureSocket()
  syncStreams()
  for (const symbol of added) void seedMinutes(symbol)
}

/** A pair's book now: the stream's while it is fresh, otherwise read once from the data host's REST
 * route. Null when neither can be had. */
export async function liveBook(symbol: unknown): Promise<LiveBook | null> {
  if (typeof symbol !== 'string' || !SYMBOL.test(symbol)) return null
  const streamed = state.books[symbol]
  if (streamed !== undefined && !isStale(streamed, Date.now())) return streamed
  try {
    const { response } = await fetchMarketData(`/ticker/bookTicker?symbol=${encodeURIComponent(symbol)}`, REST_TIMEOUT_MS)
    if (!response.ok) return null
    const row = (await response.json()) as Record<string, unknown>
    const book: LiveBook = { symbol, bid: asNumber(row.bidPrice), bidQty: asNumber(row.bidQty), ask: asNumber(row.askPrice), askQty: asNumber(row.askQty), updatedAt: Date.now(), source: 'rest' }
    return [book.bid, book.ask, book.bidQty, book.askQty].every(Number.isFinite) ? book : null
  } catch {
    return null
  }
}

/** Opens the socket and its clocks. Called once, from electron/main.ts. */
export function startLiveMarket(): void {
  if (started) return
  started = true
  void ensureSocket().catch((error) => console.error('Live market failed to start:', error))
  void seedMinutes('BTCUSDT')
  void seedMinutes('ETHUSDT')
  void readOwnTrades()
  setInterval(() => void readOwnTrades(), OWN_TRADES_REFRESH_MS)
  setInterval(checkGap, 5_000)
  setInterval(() => {
    if (!dirty) return
    dirty = false
    for (const listener of listeners) {
      try {
        listener(state)
      } catch (error) {
        console.error('A live market listener failed:', error)
      }
    }
  }, LIVE_PUSH_MS)
}
