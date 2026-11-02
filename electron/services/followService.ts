import { app } from 'electron'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { ruleHolds, featuresAt, CLONE_LINES } from '../../shared/traders/clone'
import { DEFAULT_COPY_TRADING, healCopyTrading, type CloneCoin, type CopyTradingSettings } from '../../shared/traders/copyTrading'
import { FOLLOW_LINES, followMaxHoldSec, leaderEventOfFill, okxLeaderEventsOf, readLeaderEvent, type CloneSignal, type FollowStatus, type LeaderEvent, type OkxSeen } from '../../shared/traders/follow'
import { hyperliquidFillOf, type TraderFill } from '../../shared/traders/hyperliquid'
import { okxCoinOf } from '../../shared/traders/okx'
import { coinVenueOf, seriesOf, type TraderAnalysis } from '../../shared/traders/traderAnalysis'
import { traderRefOfKey } from '../../shared/traders/traderRef'
import { hyperliquidInfo } from './hyperliquidClient'
import { streamHyperliquidFills } from './hyperliquidStream'
import { appendJsonLines, listMonthFiles } from './jsonlStore'
import { okxGet, OKX_PATHS } from './okxClient'
import { perpBars, perpSymbols, type PerpVenue } from './perpMarketService'
import { getSettings, setSettings } from './settingsService'
import { listTraders } from './traderService'

// FOLLOWING TRADERS AND RUNNING CLONES ON PAPER, THE READING HALF (V8 Stage 8, 27 October 2026). For each trader a
// person follows on Copy Traders, their trades are read as they are made -- Hyperliquid's through one public stream
// for up to five addresses (hyperliquidStream.ts), the rest and every OKX lead trader's read once a minute -- and each
// is written to traders/<key>/events-YYYY-MM.jsonl, once, before anything acts on it; then it is pushed to the
// window, where the follow's writer acts (src/traders/paperFollow.ts) and the executor it writes, carrying the event's
// key, is the event's acknowledgement. A trader read twice in a row without an answer is "lost", and their follows
// close. For each clone running, at each 15-minute close its rule is read on each of its coins' perpetuals, and where
// it holds a signal is written to traders/<key>/clone-signals-YYYY-MM.jsonl and pushed (src/traders/paperClone.ts).
// Public data only: no key, no model, no order. The only setting written is `copyTrading`, from a person's button.


/** What the service reads the world through: a test hands in its own. */
export const followSeam = {
  dir: (): string => join(app.getPath('userData'), 'traders'),
  nowMs: (): number => Date.now(),
  settings: async (): Promise<CopyTradingSettings> => healCopyTrading((await getSettings()).copyTrading),
  saveSettings: async (copyTrading: CopyTradingSettings): Promise<void> => void (await setSettings({ copyTrading })),
  fillsSince: (user: string, fromMs: number): Promise<unknown> => hyperliquidInfo<unknown>('userFillsByTime', { user, startTime: fromMs, aggregateByTime: false }),
  accountValue: async (user: string): Promise<number | null> => {
    const state = (await hyperliquidInfo<{ marginSummary?: { accountValue?: string } }>('clearinghouseState', { user })) ?? {}
    const value = Number(state.marginSummary?.accountValue)
    return Number.isFinite(value) && value > 0 ? value : null
  },
  okxCurrent: (code: string): Promise<unknown[]> => okxGet(OKX_PATHS.current, { instType: 'SWAP', uniqueCode: code, limit: '100' }),
  symbols: (venue: PerpVenue): Promise<Set<string>> => perpSymbols(venue),
  bars: perpBars,
  analyses: async (): Promise<Map<string, TraderAnalysis>> => new Map((await listTraders()).traders.flatMap((entry) => (entry.latest === null ? [] : [[entry.meta.ref.key, entry.latest] as const]))),
  stream: streamHyperliquidFills,
  setInterval: (run: () => void, ms: number): ReturnType<typeof setInterval> => setInterval(run, ms),
  clearInterval: (timer: ReturnType<typeof setInterval>): void => clearInterval(timer)
}

interface Followed {
  key: string
  venue: 'hyperliquid' | 'okx'
  id: string
  since: number
  mode: 'stream' | 'poll'
  lastReadMs: number | null
  cursorMs: number
  missedReads: number
  hidden: boolean
  accountValue: number | null
  accountReadMs: number
  seen: Set<string>
  okxSeen: Map<string, OkxSeen> | null
  eventsToday: number
  eventsDay: number
}

const followed = new Map<string, Followed>()
const eventListeners = new Set<(event: LeaderEvent) => void>()
const signalListeners = new Set<(signal: CloneSignal) => void>()
const statusListeners = new Set<(statuses: FollowStatus[]) => void>()
let stopStream: (() => void) | null = null
let streamUsers: string[] = []
let pollTimer: ReturnType<typeof setInterval> | null = null
let lastCloneBarSec = 0
let polling = false

const tellAll = <T>(listeners: Set<(value: T) => void>, value: T): void => {
  for (const listener of listeners) {
    try {
      listener(value)
    } catch (error) {
      console.error('A follow listener failed:', error)
    }
  }
}

function listen<T>(listeners: Set<(value: T) => void>, listener: (value: T) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export const onLeaderEvent = (listener: (event: LeaderEvent) => void): (() => void) => listen(eventListeners, listener)
export const onCloneSignal = (listener: (signal: CloneSignal) => void): (() => void) => listen(signalListeners, listener)
export const onFollowStatus = (listener: (statuses: FollowStatus[]) => void): (() => void) => listen(statusListeners, listener)

const DAY_MS = 86_400_000
const monthOf = (ms: number): string => new Date(ms).toISOString().slice(0, 7)
const folderOf = (key: string): string => join(followSeam.dir(), key)

/** The follows' statuses now. */
export function followStatuses(): FollowStatus[] {
  return [...followed.values()]
    .sort((a, b) => a.since - b.since)
    .map((entry) => ({
      key: entry.key,
      venue: entry.venue,
      mode: entry.mode,
      since: entry.since,
      lastReadMs: entry.lastReadMs,
      missedReads: entry.missedReads,
      lost: entry.missedReads >= FOLLOW_LINES.missedReads,
      hidden: entry.hidden,
      eventsToday: entry.eventsToday
    }))
}

const tellStatus = (): void => tellAll(statusListeners, followStatuses())

async function readLines(dir: string, pattern: RegExp, sinceMs: number): Promise<unknown[]> {
  const out: unknown[] = []
  const fromMonth = monthOf(sinceMs)
  for (const { name, month } of await listMonthFiles(dir, pattern).catch(() => [])) {
    if (month < fromMonth) continue
    const text = await readFile(join(dir, name), 'utf-8').catch(() => '')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // A torn last line is skipped.
      }
    }
  }
  return out
}

let perpsHeld: { binance: Set<string>; bitget: Set<string>; at: number } | null = null

/** A coin's perpetual: Binance's first, Bitget's where Binance lists none. */
async function perpOfCoin(coin: string): Promise<LeaderEvent['perp']> {
  if (perpsHeld === null || followSeam.nowMs() - perpsHeld.at > 6 * 3600_000) {
    const [binance, bitget] = await Promise.all([followSeam.symbols('binance').catch(() => new Set<string>()), followSeam.symbols('bitget').catch(() => new Set<string>())])
    perpsHeld = { binance, bitget, at: followSeam.nowMs() }
  }
  const found = coinVenueOf(coin, perpsHeld.binance, perpsHeld.bitget)
  return found === null ? null : { venue: found.venue, symbol: found.symbol }
}

/** Events written, each once, then pushed: the file first, so nothing is acted on that is not on file. */
async function keepEvents(entry: Followed, events: readonly LeaderEvent[]): Promise<void> {
  const fresh = events.filter((event) => !entry.seen.has(event.key))
  if (fresh.length === 0) return
  for (const event of fresh) entry.seen.add(event.key)
  const byMonth = new Map<string, LeaderEvent[]>()
  for (const event of fresh) byMonth.set(monthOf(event.receivedMs), [...(byMonth.get(monthOf(event.receivedMs)) ?? []), event])
  for (const [month, lines] of byMonth) await appendJsonLines(join(folderOf(entry.key), `events-${month}.jsonl`), lines)
  const today = Math.floor(followSeam.nowMs() / DAY_MS)
  if (entry.eventsDay !== today) {
    entry.eventsDay = today
    entry.eventsToday = 0
  }
  // A snapshot's fills were made before the stream opened: not the trader's trades read today.
  entry.eventsToday += fresh.filter((event) => event.via !== 'snapshot').length
  for (const event of [...fresh].sort((a, b) => a.timeMs - b.timeMs)) tellAll(eventListeners, event)
}

async function hyperliquidEvents(entry: Followed, rows: unknown[], via: LeaderEvent['via']): Promise<LeaderEvent[]> {
  const fills = rows.map(hyperliquidFillOf).filter((fill): fill is TraderFill => fill !== null)
  const out: LeaderEvent[] = []
  for (const fill of fills) {
    if (entry.seen.has(`${entry.key}:${fill.tid}`)) continue
    out.push(leaderEventOfFill(fill, entry.key, followSeam.nowMs(), via, entry.accountValue, await perpOfCoin(fill.coin)))
    entry.cursorMs = Math.max(entry.cursorMs, fill.timeMs)
  }
  return out
}

const read = (entry: Followed): void => {
  entry.lastReadMs = followSeam.nowMs()
  entry.missedReads = 0
}
const missed = (entry: Followed): void => {
  entry.missedReads++
}

/** One reading of a followed trader by poll: Hyperliquid's fills since the last read, or OKX's open sub-positions. */
async function poll(entry: Followed): Promise<void> {
  try {
    if (entry.venue === 'hyperliquid') {
      if (entry.accountValue === null || followSeam.nowMs() - entry.accountReadMs > 15 * 60_000) {
        entry.accountValue = await followSeam.accountValue(entry.id).catch(() => entry.accountValue)
        entry.accountReadMs = followSeam.nowMs()
      }
      if (entry.mode === 'poll') {
        const rows = await followSeam.fillsSince(entry.id, entry.cursorMs)
        await keepEvents(entry, await hyperliquidEvents(entry, Array.isArray(rows) ? rows : [], 'poll'))
        read(entry)
      }
    } else {
      const rows = await followSeam.okxCurrent(entry.id)
      const current = new Map<string, OkxSeen>()
      let hidden = 0
      for (const row of rows) {
        const position = row as Record<string, unknown>
        const coin = okxCoinOf(position.instId)
        const size = Number(position.subPos)
        const px = Number(position.markPx) || Number(position.openAvgPx)
        if (coin === null || !Number.isFinite(size) || size === 0 || !(px > 0) || typeof position.subPosId !== 'string') {
          hidden++
          continue
        }
        current.set(position.subPosId, { coin, size: position.posSide === 'short' ? -Math.abs(size) : position.posSide === 'net' ? size : Math.abs(size), px, openedMs: Number(position.openTime) || followSeam.nowMs() })
      }
      entry.hidden = rows.length > 0 && hidden === rows.length
      // The first read is what the trader held when the follow began: never entered.
      if (entry.okxSeen !== null) {
        const perps = new Map<string, LeaderEvent['perp']>()
        for (const seen of current.values()) if (!perps.has(seen.coin)) perps.set(seen.coin, await perpOfCoin(seen.coin))
        for (const seen of entry.okxSeen.values()) if (!perps.has(seen.coin)) perps.set(seen.coin, await perpOfCoin(seen.coin))
        await keepEvents(entry, okxLeaderEventsOf(entry.key, entry.okxSeen, current, followSeam.nowMs(), 'poll', (coin) => perps.get(coin) ?? null))
      }
      entry.okxSeen = current
      read(entry)
    }
  } catch (error) {
    missed(entry)
    console.error(`Following ${entry.key} could not read them:`, error instanceof Error ? error.message : error)
  }
}

/** The stream carries the first five Hyperliquid follows; it is opened again when they change. */
function restream(): void {
  const users = [...followed.values()].filter((entry) => entry.venue === 'hyperliquid').sort((a, b) => a.since - b.since).slice(0, FOLLOW_LINES.maxStreams)
  const ids = users.map((entry) => entry.id)
  for (const entry of followed.values()) if (entry.venue === 'hyperliquid') entry.mode = ids.includes(entry.id) ? 'stream' : 'poll'
  if (ids.join(',') === streamUsers.join(',')) return
  stopStream?.()
  stopStream = null
  streamUsers = ids
  if (ids.length === 0) return
  stopStream = followSeam.stream(ids, {
    onOpen: () => {
      for (const entry of followed.values()) if (entry.mode === 'stream') read(entry)
      tellStatus()
    },
    onFills: (user, rows, snapshot) => {
      const entry = [...followed.values()].find((candidate) => candidate.venue === 'hyperliquid' && candidate.id === user)
      if (entry === undefined) return
      read(entry)
      void hyperliquidEvents(entry, rows, snapshot ? 'snapshot' : 'stream')
        .then((events) => keepEvents(entry, events))
        .catch((error) => console.error(`Following ${entry.key}: the stream's fills could not be kept:`, error))
    },
    onConnectFailed: (consecutive) => {
      for (const entry of followed.values()) if (entry.mode === 'stream') entry.missedReads = Math.max(entry.missedReads, consecutive)
      tellStatus()
    }
  })
}

/** Follows started and stopped as the setting says, each one's kept events read back so none is pushed twice. */
export async function syncFollows(): Promise<void> {
  const settings = await followSeam.settings()
  for (const key of [...followed.keys()]) if (settings.follows[key] === undefined) followed.delete(key)
  for (const [key, follow] of Object.entries(settings.follows)) {
    if (followed.has(key)) continue
    const ref = traderRefOfKey(key)
    if (ref === null || ref.venue === 'file') continue
    const kept = (await readLines(folderOf(key), /^events-(\d{4}-\d{2})\.jsonl$/, follow.since - DAY_MS)).map(readLeaderEvent).filter((event): event is LeaderEvent => event !== null)
    followed.set(key, {
      key,
      venue: ref.venue,
      id: ref.id,
      since: follow.since,
      mode: 'poll',
      lastReadMs: null,
      cursorMs: Math.max(follow.since, ...kept.map((event) => event.timeMs)),
      missedReads: 0,
      hidden: false,
      accountValue: null,
      accountReadMs: 0,
      seen: new Set(kept.map((event) => event.key)),
      okxSeen: null,
      eventsToday: 0,
      eventsDay: -1
    })
  }
  restream()
  tellStatus()
}

/** One minute's turn: each trader read by poll; the clones read at a new 15-minute close. */
async function turn(): Promise<void> {
  if (polling) return
  polling = true
  try {
    for (const entry of followed.values()) await poll(entry)
    tellStatus()
    await cloneTurn()
  } finally {
    polling = false
  }
}

/** At each new 15-minute close, each running clone's rule read on each of its coins. */
async function cloneTurn(): Promise<void> {
  const barSec = CLONE_LINES.barMinutes * 60
  const nowSec = Math.floor(followSeam.nowMs() / 1000)
  const barCloseSec = Math.floor(nowSec / barSec) * barSec
  if (barCloseSec <= lastCloneBarSec || nowSec - barCloseSec < 20) return
  lastCloneBarSec = barCloseSec
  const settings = await followSeam.settings()
  const clones = Object.entries(settings.clones)
  if (clones.length === 0) return
  let btc: ReturnType<typeof seriesOf> = null
  try {
    btc = seriesOf(await followSeam.bars('binance', 'BTCUSDT', '1h', barCloseSec - 27 * 3600, barCloseSec), 3600)
  } catch (error) {
    console.error("The clones could not read Bitcoin's hours:", error instanceof Error ? error.message : error)
    return
  }
  for (const [traderKey, clone] of clones) {
    const signals: CloneSignal[] = []
    for (const coin of clone.coins) {
      try {
        const series = seriesOf(await followSeam.bars(coin.venue, coin.symbol, '15m', barCloseSec - 26 * 3600, barCloseSec), barSec)
        const row = series === null || btc === null ? null : featuresAt(series, btc, barCloseSec)
        if (row === null || series === null || !ruleHolds(clone.rule.conditions, row)) continue
        signals.push({ v: 'clone-signal-v1', key: `${traderKey}:clone:${coin.coin}:${barCloseSec}`, traderKey, coin: coin.coin, venue: coin.venue, symbol: coin.symbol, side: clone.rule.side, holdBars: clone.rule.holdBars, px: series.closes[series.closes.length - 1], barCloseSec, receivedMs: followSeam.nowMs() })
      } catch (error) {
        console.error(`The clone of ${traderKey} could not read ${coin.symbol}:`, error instanceof Error ? error.message : error)
      }
    }
    if (signals.length === 0) continue
    await appendJsonLines(join(folderOf(traderKey), `clone-signals-${monthOf(followSeam.nowMs())}.jsonl`), signals)
    for (const signal of signals) tellAll(signalListeners, signal)
  }
}

/** Starts reading the followed traders and the clones: at the app's start, and on a setting's change. */
export async function startFollowing(): Promise<void> {
  await syncFollows()
  if (pollTimer === null) pollTimer = followSeam.setInterval(() => void turn().catch((error) => console.error('A follow turn failed:', error)), FOLLOW_LINES.pollSec * 1000)
}

export function stopFollowing(): void {
  if (pollTimer !== null) followSeam.clearInterval(pollTimer)
  pollTimer = null
  stopStream?.()
  stopStream = null
  streamUsers = []
}

/** A person's button: a trader followed from now, or no longer. A follow's time limit is the leader's longest hold. */
export async function setFollow(key: unknown, on: unknown): Promise<FollowStatus[]> {
  const ref = typeof key === 'string' ? traderRefOfKey(key) : null
  if (ref === null || ref.venue === 'file') throw new Error('Only a Hyperliquid or OKX trader on file can be followed.')
  const settings = await followSeam.settings()
  const follows = { ...settings.follows }
  if (on === true) {
    const analysis = (await followSeam.analyses()).get(ref.key)
    if (analysis === undefined) throw new Error('Analyse the trader before following them.')
    follows[ref.key] = { since: followSeam.nowMs(), maxHoldSec: followMaxHoldSec(analysis.figures.holdMin?.max ?? null) }
  } else delete follows[ref.key]
  await followSeam.saveSettings({ ...settings, follows })
  await syncFollows()
  return followStatuses()
}

/** A person's button: a trader's clone run on paper from now, on the rule their last analysis fitted, or no longer. */
export async function setClone(key: unknown, on: unknown): Promise<CopyTradingSettings['clones']> {
  const ref = typeof key === 'string' ? traderRefOfKey(key) : null
  if (ref === null) throw new Error('A trader on file is named by its key.')
  const settings = await followSeam.settings()
  const clones = { ...settings.clones }
  if (on === true) {
    const analysis = (await followSeam.analyses()).get(ref.key)
    const rule = analysis?.clone?.rule ?? null
    if (analysis === undefined || rule === null) throw new Error('The trader\'s last analysis fitted no rule to run.')
    const coins: CloneCoin[] = analysis.mapping.filter((entry) => analysis.figures.coins.some((coin) => coin.coin === entry.coin)).map((entry) => ({ coin: entry.coin, venue: entry.venue, symbol: entry.symbol }))
    const ruleCoins = new Set(analysis.clone?.trades?.coins ?? coins.map((coin) => coin.coin))
    const chosen = coins.filter((coin) => ruleCoins.has(coin.coin))
    if (chosen.length === 0) throw new Error("No coin of the rule's side has a perpetual to run it on.")
    clones[ref.key] = { since: followSeam.nowMs(), rule, coins: chosen }
  } else delete clones[ref.key]
  await followSeam.saveSettings({ ...settings, clones })
  return clones
}

/** The events and signals kept since a moment: what the writers read at their start, to act on any they missed. */
export async function recentFollowRecords(sinceMs: unknown): Promise<{ events: LeaderEvent[]; signals: CloneSignal[] }> {
  const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) ? Math.max(sinceMs, followSeam.nowMs() - DAY_MS) : followSeam.nowMs() - 15 * 60_000
  const settings = await followSeam.settings().catch(() => DEFAULT_COPY_TRADING)
  const events: LeaderEvent[] = []
  for (const key of Object.keys(settings.follows)) {
    const kept = (await readLines(folderOf(key), /^events-(\d{4}-\d{2})\.jsonl$/, since)).map(readLeaderEvent).filter((event): event is LeaderEvent => event !== null && event.receivedMs >= since)
    events.push(...kept)
  }
  const signals: CloneSignal[] = []
  for (const key of Object.keys(settings.clones)) {
    const kept = (await readLines(folderOf(key), /^clone-signals-(\d{4}-\d{2})\.jsonl$/, since)) as CloneSignal[]
    signals.push(...kept.filter((signal) => signal?.v === 'clone-signal-v1' && signal.receivedMs >= since))
  }
  return { events: events.sort((a, b) => a.timeMs - b.timeMs), signals: signals.sort((a, b) => a.barCloseSec - b.barCloseSec) }
}

/** A trader's leader events kept since a moment, by their key: what the copy book's report sets each follow against
 * (V8 Stage 10). */
export async function leaderEventsOf(traderKey: string, sinceMs: number): Promise<Map<string, LeaderEvent>> {
  if (traderRefOfKey(traderKey) === null) return new Map()
  const kept = (await readLines(folderOf(traderKey), /^events-(\d{4}-\d{2})\.jsonl$/, sinceMs)).map(readLeaderEvent).filter((event): event is LeaderEvent => event !== null)
  return new Map(kept.map((event) => [event.key, event]))
}

/** Test seam. */
export function resetFollowing(): void {
  stopFollowing()
  followed.clear()
  eventListeners.clear()
  signalListeners.clear()
  statusListeners.clear()
  perpsHeld = null
  lastCloneBarSec = 0
  polling = false
}

/** A coin's perpetual, for the clone's choice of coins (test seam of perpOfCoin). */
export const followPerpOf = perpOfCoin
