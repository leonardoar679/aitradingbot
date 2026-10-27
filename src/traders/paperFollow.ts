import type { AppSettings, ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import { MISS_VERSION, type MissRecord, type MissStage } from '../../shared/misses'
import { bookExecutors, bookRoomProblem, healPaperBooks, type BookMark, type BookStanding } from '../../shared/paperBooks'
import { healCopyTrading } from '../../shared/traders/copyTrading'
import type { FundingRate } from '../../shared/traders/delay'
import {
  followDecisionsOf,
  followDueOf,
  followFundingOf,
  followGateOf,
  followResultOf,
  followStakeOf,
  followWithLeg,
  type FollowCloseReason,
  type FollowStamp,
  type FollowStatus,
  type LeaderEvent
} from '../../shared/traders/follow'
import { PERP_FEES } from '../../shared/venueCosts'
import { settingsWrites } from '../utils/settingsWrites'

// FOLLOWING A TRADER ON PAPER, THE WRITING HALF (V8 Stage 8, 27 October 2026). Each leader event the main process
// reads and keeps (electron/services/followService.ts) is acted on here, once: the executor a follow writes carries the
// event's key -- its opening's, or a leg's -- and that is the event's acknowledgement. A leader's new position, opened
// after the follow began, is entered in the copy book on the same perpetual at 1x, sized as the leader's share of
// their account where it is known; an add or a partial close resizes the follow in the same proportion; a close or a
// flip closes it; each at the perpetual's own price, paying the taker fee. An entry the gates refuse -- too late, a
// price more than 2% from the leader's, five open for this trader, ten opened in the hour, or no room in the copy
// book -- is written as a missed opportunity with why. A follow also closes at its time limit (the leader's longest
// hold, at most seven days), at the loss of its whole stake, when the leader is lost, or when its follow is switched
// off; its result -- the perpetual's prices, the fees, the funding the perpetual published over its hold -- is written
// on its book's mark. A follow settled a day ago is moved out of the settings into the books' archive.
//
// PAPER IS WRITTEN HERE AS A LITERAL. followPaperExecutor takes no mode and has no way to be given one. Nothing in this
// file mentions the bridge a real order travels over, and tests/aiNoLivePath.test.ts reads this file to make sure of
// both. A follow never trades.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on executors read inside it.

export interface FollowDeps {
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperBooks' | 'copyTrading'>>
  setExecutors: (executors: ExecutorConfig[]) => Promise<void>
  queue: <T>(work: () => Promise<T>) => Promise<T>
  /** The copy book's standing as the books keep it, its settled trades moved out of the settings counted. */
  copyStanding: () => Promise<BookStanding | null>
  perpPrice: (venue: 'binance' | 'bitget', symbol: string) => Promise<number>
  perpFunding: (venue: 'binance' | 'bitget', symbol: string, fromSec: number, toSec: number) => Promise<FundingRate[]>
  miss: (miss: MissRecord) => Promise<unknown>
  archive: (executors: ExecutorConfig[]) => Promise<number>
  nowMs: () => number
  newId: () => string
}

/** The follows on file: paper Positions carrying a follow's mark. */
export function followExecutors(executors: readonly ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter((executor) => executor.follow !== undefined && executor.mode === 'paper' && executor.type === 'position')
}

/** A follow's executor: paper, unlevered, in the copy book, its parameters those of its opening. */
export function followPaperExecutor(input: { id: string; stamp: FollowStamp; book: BookMark; nowSec: number }): ExecutorConfig {
  const { stamp } = input
  const params: PositionExecutorParams = {
    side: stamp.side === 'long' ? 'buy' : 'sell',
    entryPrice: stamp.avgPx,
    amountQuote: stamp.size * stamp.avgPx,
    takeProfitPct: null,
    stopLossPct: null,
    timeLimitSec: stamp.maxHoldSec,
    trailingStop: null,
    feeRate: PERP_FEES[stamp.venue].takerPct / 100
  }
  return {
    id: input.id,
    name: `Follow · ${stamp.coin} ${stamp.side}`,
    type: 'position',
    exchange: stamp.venue,
    symbol: stamp.symbol,
    baseAsset: stamp.symbol.replace(/USDT$/, ''),
    quoteAsset: 'USDT',
    createdAt: input.nowSec,
    status: 'active',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    book: input.book,
    follow: stamp,
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params
  }
}

/** A missed entry, for the copy book's record of what it did not take, carrying the key of the event or signal it was
 * missed on. */
export function followMiss(input: { event: Pick<LeaderEvent, 'px' | 'after' | 'perp' | 'coin'>; eventKey: string; nowMs: number; stage: MissStage; reason: string; writer?: string }): MissRecord {
  return {
    v: MISS_VERSION,
    at: Math.floor(input.nowMs / 1000),
    book: 'copy',
    writer: input.writer ?? 'follow',
    pair: input.event.perp?.symbol ?? `${input.event.coin}USDT`,
    side: input.event.after > 0 ? 'up' : 'down',
    refPrice: input.event.px > 0 ? input.event.px : null,
    stage: input.stage,
    reason: input.reason,
    predictionId: null,
    shadow: false,
    eventKey: input.eventKey
  }
}

/** The copy book's trades opened in the last hour, follows and clones: the hour's cap counts them all. */
export function copyOpensLastHour(executors: readonly ExecutorConfig[], nowMs: number): number {
  const since = nowMs / 1000 - 3600
  return executors.filter((executor) => executor.mode === 'paper' && executor.book?.id === 'copy' && executor.createdAt >= since).length
}

/** A follow closed at a price: the closing leg, the funding over its hold, its result on its book's mark. */
async function closed(executor: ExecutorConfig, px: number, reason: FollowCloseReason, eventKey: string, deps: Pick<FollowDeps, 'perpFunding' | 'nowMs'>): Promise<ExecutorConfig> {
  const stamp = executor.follow as FollowStamp
  const nowMs = deps.nowMs()
  const sign = stamp.side === 'long' ? 1 : -1
  const last = stamp.size > 0 ? followWithLeg(stamp, { qty: -sign * stamp.size, px, atMs: nowMs, eventKey }, PERP_FEES[stamp.venue].takerPct) : stamp
  let funding = 0
  try {
    const rates = await deps.perpFunding(stamp.venue, stamp.symbol, Math.floor(stamp.openedAtMs / 1000) - 8 * 3600, Math.ceil(nowMs / 1000))
    funding = followFundingOf(last, rates, nowMs)
  } catch {
    // No published rate read: the assumed rate against it, at each funding time crossed.
    const crossed = Math.floor(nowMs / 28_800_000) - Math.floor(stamp.openedAtMs / 28_800_000)
    funding = -crossed * 0.0001 * last.maxStakeQuote
  }
  const nowSec = Math.floor(nowMs / 1000)
  return {
    ...executor,
    status: 'stopped',
    stoppedAt: nowSec,
    follow: { ...last, closeReason: reason },
    book: { ...(executor.book as BookMark), result: followResultOf(last, funding, nowSec) }
  }
}

/** The leader event acted on: the follow it asks for entered, resized or closed, or a miss written. Once: an event
 * whose key an executor already carries is passed over. Returns what came of it. */
export async function followEvent(event: LeaderEvent, deps: FollowDeps): Promise<string> {
  // The perpetual's price, read before the queue: what the follow would enter, resize or close at.
  let px: number | null = null
  if (event.perp !== null) px = await deps.perpPrice(event.perp.venue, event.perp.symbol).catch(() => null)
  const standing = await deps.copyStanding().catch(() => null)
  const misses: MissRecord[] = []
  const outcome = await deps.queue(async (): Promise<string> => {
    const fresh = await deps.getSettings()
    const setting = healCopyTrading(fresh.copyTrading).follows[event.traderKey]
    if (setting === undefined) return 'not followed'
    const mine = followExecutors(fresh.executors)
    // Each leg carries the event it was made on, the opening's among them.
    if (mine.some((executor) => executor.follow?.legs.some((leg) => leg.eventKey === event.key))) return 'already acted on'
    const nowMs = deps.nowMs()
    const held = mine.find((executor) => executor.status === 'active' && executor.follow?.traderKey === event.traderKey && executor.follow.positionId === event.positionId) ?? null
    let executors = [...fresh.executors]
    const notes: string[] = []
    for (const decision of followDecisionsOf(event, setting.since, held?.follow ?? null)) {
      if (decision.kind === 'ignore') {
        notes.push(decision.reason)
        continue
      }
      const current = executors.find((executor) => executor.id === held?.id && executor.status === 'active') ?? null
      if (decision.kind === 'close') {
        if (current === null) continue
        const ended = await closed(current, px ?? event.px, decision.reason, event.key, deps)
        executors = executors.map((executor) => (executor.id === current.id ? ended : executor))
        notes.push(`closed: ${decision.reason}`)
        continue
      }
      if (decision.kind === 'resize') {
        if (current === null) continue
        const stamp = current.follow as FollowStamp
        const at = px ?? event.px
        const sign = stamp.side === 'long' ? 1 : -1
        // An add no larger than the book's stake allows: the follow's size held to it.
        const stakeQuote = standing === null ? Infinity : healPaperBooks(fresh.paperBooks).books.copy.maxStakeShare * standing.settledEquity
        const target = Math.min(decision.targetSize, stakeQuote / at)
        const delta = target - stamp.size
        if (Math.abs(delta) * at < 0.01) continue
        const resized = followWithLeg({ ...stamp, leaderSize: event.after }, { qty: sign * delta, px: at, atMs: nowMs, eventKey: event.key }, PERP_FEES[stamp.venue].takerPct)
        executors = executors.map((executor) => (executor.id === current.id ? { ...current, follow: resized } : executor))
        notes.push(`resized to ${resized.size}`)
        continue
      }
      // A new position: the gates, the book's room, then the entry.
      if (event.perp === null) {
        misses.push(followMiss({ event, eventKey: event.key, nowMs, stage: 'gate', reason: `${event.coin} has no USDT perpetual on Binance or Bitget` }))
        continue
      }
      const openForTrader = followExecutors(executors).filter((executor) => executor.status === 'active' && executor.follow?.traderKey === event.traderKey).length
      const gate = followGateOf({ event, nowMs, venuePx: px, openForTrader, opensLastHour: copyOpensLastHour(executors, nowMs) })
      if (gate !== null) {
        misses.push(followMiss({ event, eventKey: event.key, nowMs, stage: gate.stage, reason: gate.reason }))
        continue
      }
      const books = healPaperBooks(fresh.paperBooks)
      const open = bookExecutors(executors, 'copy', books.startedAt ?? 0).filter((executor) => executor.status === 'active')
      const room = standing === null ? null : { ...standing, open: open.length }
      const bookStake = room === null ? 0 : books.books.copy.maxStakeShare * room.settledEquity
      const stakeQuote = room === null ? 0 : followStakeOf({ leaderNotional: Math.abs(event.after) * event.px, accountValue: event.accountValue, bookEquity: room.settledEquity, bookStake })
      const problem = room === null ? "the copy book's standing could not be read" : bookRoomProblem({ books, id: 'copy', standing: room, stakeQuote, dayStartEquity: null })
      if (problem !== null) {
        misses.push(followMiss({ event, eventKey: event.key, nowMs, stage: books.running ? 'cap' : 'off', reason: problem }))
        continue
      }
      const venuePx = px as number
      const side = decision.side
      const empty: FollowStamp = {
        traderKey: event.traderKey,
        positionId: event.positionId,
        coin: event.coin,
        venue: event.perp.venue,
        symbol: event.perp.symbol,
        side,
        leaderSize: event.after,
        size: 0,
        avgPx: venuePx,
        maxStakeQuote: 0,
        legs: [],
        realizedQuote: 0,
        feesQuote: 0,
        openedOnKey: event.key,
        openedAtMs: nowMs,
        delaySec: Math.max(0, (nowMs - event.timeMs) / 1000),
        maxHoldSec: setting.maxHoldSec,
        closeReason: null
      }
      const stamp = followWithLeg(empty, { qty: (side === 'long' ? 1 : -1) * (stakeQuote / venuePx), px: venuePx, atMs: nowMs, eventKey: event.key }, PERP_FEES[event.perp.venue].takerPct)
      const book: BookMark = { id: 'copy', startedAt: books.startedAt as number, ledger: 'follow' }
      executors = [...executors, followPaperExecutor({ id: deps.newId(), stamp, book, nowSec: Math.floor(nowMs / 1000) })]
      notes.push(`entered ${side} ${stamp.size} ${event.coin} at ${venuePx}`)
    }
    if (executors.length !== fresh.executors.length || executors.some((executor, k) => executor !== fresh.executors[k])) await deps.setExecutors(executors)
    return notes.join('; ') || 'nothing to do'
  })
  for (const miss of misses) await deps.miss(miss).catch((error) => console.error('A missed follow could not be recorded:', error))
  return misses.length > 0 ? `${outcome}; missed: ${misses.map((miss) => miss.reason).join('; ')}` : outcome
}

/** Each open follow closed where it must be -- its time, the loss of its stake, its leader lost, its follow switched
 * off -- each stopped elsewhere given its result, and each settled a day ago moved to the books' archive. Returns the
 * names of those it closed. */
export async function settleFollows(statuses: readonly FollowStatus[], deps: FollowDeps): Promise<string[]> {
  const { executors, copyTrading } = await deps.getSettings()
  const followed = healCopyTrading(copyTrading).follows
  const lost = new Set(statuses.filter((status) => status.lost).map((status) => status.key))
  const done: string[] = []
  for (const executor of followExecutors(executors)) {
    const stamp = executor.follow as FollowStamp
    const stoppedElsewhere = executor.status === 'stopped' && executor.book?.result === undefined
    if (executor.status !== 'active' && !stoppedElsewhere) continue
    const px = await deps.perpPrice(stamp.venue, stamp.symbol).catch(() => null)
    const nowMs = deps.nowMs()
    const reason: FollowCloseReason | null = stoppedElsewhere
      ? 'stopped'
      : lost.has(stamp.traderKey)
        ? 'leader lost'
        : followed[stamp.traderKey] === undefined
          ? 'stopped'
          : followDueOf(stamp, px, nowMs)
    if (reason === null || px === null) continue
    const wrote = await deps.queue(async (): Promise<boolean> => {
      const fresh = await deps.getSettings()
      const current = fresh.executors.find((entry) => entry.id === executor.id)
      if (current?.follow === undefined || current.book?.result !== undefined) return false
      const ended = await closed({ ...current, status: 'active' }, px, reason, `${executor.id}:${reason}`, deps)
      await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? ended : entry)))
      return true
    })
    if (wrote) done.push(executor.name)
  }
  await archiveSettled(deps)
  return done
}

const DAY_MS = 86_400_000

/** The copy book's trades settled a day ago moved from the settings to the books' archive, in one write. */
export async function archiveSettled(deps: Pick<FollowDeps, 'getSettings' | 'setExecutors' | 'queue' | 'archive' | 'nowMs'>): Promise<number> {
  return deps.queue(async (): Promise<number> => {
    const fresh = await deps.getSettings()
    const nowSec = deps.nowMs() / 1000
    const settled = fresh.executors.filter((executor) => executor.mode === 'paper' && executor.book?.id === 'copy' && executor.status === 'stopped' && executor.book.result !== undefined && executor.book.result.closedAt <= nowSec - DAY_MS / 1000)
    if (settled.length === 0) return 0
    await deps.archive(settled)
    const gone = new Set(settled.map((executor) => executor.id))
    await deps.setExecutors(fresh.executors.filter((executor) => !gone.has(executor.id)))
    return settled.length
  })
}

/** The same, against the running app. */
export const followBrowserDeps: FollowDeps = {
  getSettings: () => window.api.settings.get(),
  setExecutors: async (executors) => {
    await window.api.settings.set({ executors })
  },
  queue: (work) => settingsWrites(work),
  copyStanding: async () => (await window.api.books.state()).standings.find((standing) => standing.id === 'copy') ?? null,
  perpPrice: (venue, symbol) => window.api.traders.perpPrice(venue, symbol),
  perpFunding: (venue, symbol, fromSec, toSec) => window.api.traders.perpFunding(venue, symbol, fromSec, toSec),
  miss: (miss) => window.api.books.miss(miss),
  archive: (executors) => window.api.books.archive(executors),
  nowMs: () => Date.now(),
  newId: () => crypto.randomUUID()
}
