import WebSocket from 'ws'
import type { ExecutorConfig } from '../../shared/ipc'
import {
  LIVE_GAP_SECONDS,
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
import { currentDataEndpoint, dataHostSwitchCount, fetchMarketData, onDataHostChange, probeDataPartner, resolveEndpoint, type RestEndpoint } from './exchanges/binance'
import { createReconnectingSocket } from './exchanges/reconnectingSocket'
import { scanSourceFor } from './marketService'
import { getSettings } from './settingsService'
import { systemFailureNotice } from '../../shared/notices'
import { tell } from './noticeService'

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
//
// THE HOST RULE: a healthy socket stays where it is, whatever REST does; a socket that cannot connect
// three times in a row goes to the host that answers. In a 24-hour run on 7 October 2026 the socket
// was opened on binance.com at launch and kept dialling it every fifteen seconds after its name had
// stopped resolving to Binance, while REST had long moved to the mirror. Now the host REST is on is
// looked at first, then the partner is probed once; a move closes the socket here and opens one
// there, and what is shown is asked for again as it opens. A closed socket also follows a REST move at
// once, since it has nothing to lose by it.
//
// A CONNECTION IS RENEWED BEFORE BINANCE'S 24-HOUR CUT (reconnectingSocket.ts): a second socket is
// opened beside the first, and the first is closed only once the second is open, so the day's end
// is not a drop. After a drop, and after a gap closes, the minutes the stream did not deliver are
// read again over REST for every pair streamed. A frame that is not a stream's -- the answer to a
// request, or its refusal -- is counted rather than dropped, and the window is told how the socket
// stands.

const ALWAYS_MINUTES = ['BTCUSDT', 'ETHUSDT']
const BTC_MINUTES_KEPT = 130
const MINUTES_KEPT = 12
const GAPS_KEPT = 50
const OWN_TRADES_REFRESH_MS = 60_000
const REST_TIMEOUT_MS = 6_000
/** Connects in a row the socket may fail before its host is looked at again. Each takes the connect
 * timeout on a dead host, so this is about a minute. */
const SOCKET_FAILS_BEFORE_RECHECK = 3
const SYMBOL = /^[A-Z0-9]{2,30}$/
/** At most one REST read of every minute series this often: a socket that flaps would otherwise
 * ask for every pair's minutes on each reopening. */
const BACKFILL_EVERY_MS = 30_000

let state: LiveState = emptyLiveState()
let interest: string[] = []
let ownTrades: string[] = []
let socket: WebSocket | null = null
let stopSocket: (() => void) | null = null
/** The data host the socket is on, by name. */
let socketHost: string | null = null
let rechecking = false
let subscribed = new Set<string>()
let requestId = 0
let dirty = false
let started = false
let lastBackfillAt = -Infinity
/** A gap this long is the stream dead. */
const DEAD_STREAM_MS = 180_000
let deadTold = false
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
  const gapOpen = last !== undefined && last.to === null
  const closedGap = gapOpen ? [...gaps.slice(0, -1), { ...last, to: Math.floor(nowMs / 1000) }] : gaps
  state = { ...state, connection: { ...connection, lastMessageAt: nowMs, gaps: closedGap } }
  if (gapOpen) {
    deadTold = false
    backfillMinutes('a gap in the stream closed')
  }
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
  if (typeof parsed.stream !== 'string' || typeof parsed.data !== 'object' || parsed.data === null) {
    // Not a stream's frame: the answer to a request (`result`, null when it was accepted) or its
    // refusal. Either is the socket alive; a refusal is counted and said.
    const frame = parsed as { result?: unknown; error?: unknown; id?: unknown }
    if (frame.error !== undefined && frame.error !== null) {
      state = { ...state, connection: { ...state.connection, subscribeErrors: state.connection.subscribeErrors + 1 } }
      dirty = true
      console.warn(`Live market: the stream refused a request: ${JSON.stringify(frame.error)}`)
    }
    if (typeof frame.id === 'number') noteMessage(Date.now())
    return
  }
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

/** Reads again, over REST, the minutes of every pair streamed: after a drop, or a gap, the minutes
 * the stream did not deliver. seedMinutes keeps what the stream already sent. */
function backfillMinutes(why: string): void {
  const nowMs = Date.now()
  if (nowMs - lastBackfillAt < BACKFILL_EVERY_MS) return
  lastBackfillAt = nowMs
  const symbols = [...new Set([...ALWAYS_MINUTES, ...bookPairs()])]
  console.info(`Live market: ${why}; the minutes of ${symbols.length} pairs are read again.`)
  for (const symbol of symbols) void seedMinutes(symbol)
}

/** The connection's lifetime from the environment, for a check that cannot wait most of a day;
 * else the socket's own default, under Binance's 24 hours. */
function socketLifetimeMs(): number | undefined {
  const raw = Number(process.env.LIVE_SOCKET_LIFETIME_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : undefined
}

async function ensureSocket(): Promise<void> {
  if (stopSocket !== null) return
  const endpoint = await resolveEndpoint()
  if (stopSocket !== null) return
  openSocket(endpoint)
}

/** An error on the socket in a few words: its code where it has one, else its message. A dead host
 * raises one every connect, and the whole aggregate with its addresses is not news the second time. */
function describeError(error: Error): string {
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? `${code} ${error.message}`.trim() : error.message || error.name
}

/** One reconnecting socket on `endpoint`, for the streams always wanted; the rest are asked for as
 * it opens. The host rule (above) is kept here and in recheckHost. */
function openSocket(endpoint: RestEndpoint): void {
  const base = endpoint.wsBase.replace(/\/ws$/, '')
  socketHost = endpoint.name
  state = { ...state, connection: { ...state.connection, host: endpoint.name } }
  dirty = true
  stopSocket = createReconnectingSocket(
    `${base}/stream?streams=${ALWAYS_MINUTES.map((symbol) => `${lower(symbol)}@kline_1m`).join('/')}`,
    {
      onOpen: (current, renewed) => {
        socket = current
        subscribed = new Set(ALWAYS_MINUTES.map((symbol) => `${lower(symbol)}@kline_1m`))
        // Reopened after a drop: the minutes the stream did not deliver are read again. A renewal
        // missed nothing, since the socket it replaced was open until this one was.
        const reopened = !renewed && state.connection.connects > 0
        const { connection } = state
        state = {
          ...state,
          connection: { ...connection, open: true, connects: connection.connects + 1, connectedAt: Date.now(), planned: renewed ? connection.planned + 1 : connection.planned }
        }
        if (renewed) console.info(`Live market: the socket on ${endpoint.name} was renewed before its lifetime ran out.`)
        current.on('close', () => {
          if (socket !== current) return
          socket = null
          state = { ...state, connection: { ...state.connection, open: false, connectedAt: null, drops: state.connection.drops + 1 } }
          dirty = true
        })
        syncStreams()
        if (reopened) backfillMinutes('the socket reopened')
      },
      onMessage: handle,
      onError: (error) => console.error(`${endpoint.name} live market socket error: ${describeError(error)}`),
      onConnectFailed: (consecutive) => {
        if (consecutive >= SOCKET_FAILS_BEFORE_RECHECK) void recheckHost(endpoint)
      }
    },
    { lifetimeMs: socketLifetimeMs() }
  )
}

/** The socket on `from` cannot connect: is there a host that answers? First the data host as REST
 * has it now, which may have moved already; else the partner, probed once. One look at a time; the
 * socket that asked is still the one on `from`, since a socket stopped by a move asks nothing more,
 * and the listener above does not move it while this look is on. */
async function recheckHost(from: RestEndpoint): Promise<void> {
  if (rechecking) return
  rechecking = true
  try {
    const current = currentDataEndpoint()
    const next = current !== null && current.name !== from.name ? current : await probeDataPartner('the live market socket could not connect')
    if (next !== null) moveSocket(next, 'its socket could not connect')
  } catch (error) {
    console.warn('Live market: the host could not be looked at again:', error)
  } finally {
    rechecking = false
  }
}

/** Closes the socket where it is and opens one on `to`. A move is not a drop; what is wanted is
 * asked for again as the new socket opens, so nothing shown is lost. */
function moveSocket(to: RestEndpoint, why: string): void {
  const from = socketHost ?? 'nowhere'
  const stop = stopSocket
  stopSocket = null
  socket = null
  subscribed = new Set()
  stop?.()
  state = { ...state, connection: { ...state.connection, open: false, connectedAt: null, hostSwitches: state.connection.hostSwitches + 1 } }
  console.warn(`Live market: the socket moves from ${from} to ${to.name}: ${why}.`)
  openSocket(to)
}

/** Watches for a stream that has gone quiet: a minute with no message while streams are wanted is
 * written down as a gap, and closed by the next message. */
function checkGap(): void {
  const { connection } = state
  const nowMs = Date.now()
  const last = connection.gaps[connection.gaps.length - 1]
  if (last !== undefined && last.to === null) {
    // A gap open this long is the stream dead, told once per gap (SYSTEM_FAILURE).
    if (!deadTold && nowMs - last.from * 1000 >= DEAD_STREAM_MS) {
      deadTold = true
      const quietS = Math.round((nowMs - last.from * 1000) / 1000)
      tell((i18n) =>
        systemFailureNotice(
          'stream',
          i18n.t("No frame from the live-price socket for {seconds} s. No paper trade of the app's own opens on a stale price, and new live entries pause while REST fails too.", { seconds: quietS }),
          i18n
        )
      )
    }
    return
  }
  const since = connection.lastMessageAt
  if (since === null || nowMs - since < LIVE_GAP_SECONDS * 1000) return
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
  onDataHostChange((to) => {
    state = { ...state, connection: { ...state.connection, dataHostSwitches: dataHostSwitchCount() } }
    dirty = true
    // A closed socket, failing to connect, follows at once; one that is open and receiving stays.
    // While its host is being looked at (recheckHost), that look makes the move, with its reason.
    if (!rechecking && socket === null && stopSocket !== null && to.name !== socketHost) moveSocket(to, 'the data host moved while its socket was closed')
  })
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
