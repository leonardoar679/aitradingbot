import type { AppSettings, ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import { liquidityVerdictOf } from '../../shared/liquidityGate'
import type { MissRecord } from '../../shared/misses'
import { bookExecutors, bookRoomProblem, healPaperBooks, type BookMark, type BookStanding } from '../../shared/paperBooks'
import { CLONE_LINES } from '../../shared/traders/clone'
import { healCopyTrading, type CloneTradeStamp } from '../../shared/traders/copyTrading'
import type { FundingRate } from '../../shared/traders/delay'
import { FOLLOW_LINES, followFundingOf, type CloneSignal } from '../../shared/traders/follow'
import { PERP_FEES } from '../../shared/venueCosts'
import { settingsWrites } from '../utils/settingsWrites'
import { copyOpensLastHour, followMiss } from './paperFollow'

// A TRADER'S CLONE ON PAPER (V8 Stage 8, 27 October 2026). The rule a trader's analysis fitted (V8-S7-CLONE) is read
// at each 15-minute close on each of its coins' perpetuals by the main process (electron/services/followService.ts);
// where it holds, the signal is kept and pushed, and acted on here, once -- the executor carries the signal's key.
// The clone enters on the rule's side in the copy book at 1x, at the perpetual's price, staking the most the book lets
// one trade stake, one trade a coin at a time; it closes at the rule's hold, or at the loss of its whole stake, or when
// the clone is switched off; its result -- the perpetual's prices, the taker fee each way, the funding the perpetual
// published over its hold -- is written on its book's mark. An entry refused -- late, ten opened in the hour, no room
// in the book -- is written as a missed opportunity with why. It is the forward test of a rule fitted in sample.
//
// PAPER IS WRITTEN HERE AS A LITERAL. clonePaperExecutor takes no mode and has no way to be given one. Nothing in this
// file mentions the bridge a real order travels over, and tests/aiNoLivePath.test.ts reads this file to make sure of
// both. A clone never trades.
//
// EVERY WRITE GOES THROUGH THE ONE QUEUE (src/utils/settingsWrites.ts), on executors read inside it.

export interface CloneDeps {
  getSettings: () => Promise<Pick<AppSettings, 'executors' | 'paperBooks' | 'copyTrading'>>
  setExecutors: (executors: ExecutorConfig[]) => Promise<void>
  queue: <T>(work: () => Promise<T>) => Promise<T>
  copyStanding: () => Promise<BookStanding | null>
  perpPrice: (venue: 'binance' | 'bitget', symbol: string) => Promise<number>
  /** The perpetual's book now, for the liquidity gate on an entry (V8 Stage 9). */
  perpBook: (venue: 'binance' | 'bitget', symbol: string) => Promise<{ bids: [number, number][]; asks: [number, number][]; atMs: number }>
  perpFunding: (venue: 'binance' | 'bitget', symbol: string, fromSec: number, toSec: number) => Promise<FundingRate[]>
  miss: (miss: MissRecord) => Promise<unknown>
  nowMs: () => number
  newId: () => string
}

/** The clones' trades on file: paper Positions carrying a clone's mark. */
export function cloneExecutors(executors: readonly ExecutorConfig[]): ExecutorConfig[] {
  return executors.filter((executor) => executor.clone !== undefined && executor.mode === 'paper' && executor.type === 'position')
}

/** A clone's trade: paper, unlevered, in the copy book, held for the rule's hold. */
export function clonePaperExecutor(input: { id: string; stamp: CloneTradeStamp; book: BookMark; nowSec: number }): ExecutorConfig {
  const { stamp } = input
  const params: PositionExecutorParams = {
    side: stamp.side === 'long' ? 'buy' : 'sell',
    entryPrice: stamp.entryPx,
    amountQuote: stamp.stakeQuote,
    takeProfitPct: null,
    stopLossPct: null,
    timeLimitSec: stamp.holdSec,
    trailingStop: null,
    feeRate: PERP_FEES[stamp.venue].takerPct / 100
  }
  return {
    id: input.id,
    name: `Clone · ${stamp.coin} ${stamp.side}`,
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
    clone: stamp,
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

/** A clone's trade closed at a price: its result on its book's mark. */
async function closedClone(executor: ExecutorConfig, px: number, reason: CloneTradeStamp['closeReason'], deps: Pick<CloneDeps, 'perpFunding' | 'nowMs'>): Promise<ExecutorConfig> {
  const stamp = executor.clone as CloneTradeStamp
  const nowMs = deps.nowMs()
  const sign = stamp.side === 'long' ? 1 : -1
  const realized = sign * (px - stamp.entryPx) * stamp.qty
  const fees = stamp.feesQuote + (PERP_FEES[stamp.venue].takerPct / 100) * stamp.qty * px
  let funding = 0
  try {
    const rates = await deps.perpFunding(stamp.venue, stamp.symbol, Math.floor(stamp.openedAtMs / 1000) - 8 * 3600, Math.ceil(nowMs / 1000))
    funding = followFundingOf({ side: stamp.side, legs: [{ qty: sign * stamp.qty, px: stamp.entryPx, atMs: stamp.openedAtMs, feeQuote: 0, eventKey: stamp.signalKey }] }, rates, nowMs)
  } catch {
    const crossed = Math.floor(nowMs / 28_800_000) - Math.floor(stamp.openedAtMs / 28_800_000)
    funding = -crossed * 0.0001 * stamp.stakeQuote
  }
  const nowSec = Math.floor(nowMs / 1000)
  const netQuote = realized - fees + funding
  return {
    ...executor,
    status: 'stopped',
    stoppedAt: nowSec,
    clone: { ...stamp, feesQuote: fees, closeReason: reason },
    book: { ...(executor.book as BookMark), result: { netQuote, netPct: stamp.stakeQuote > 0 ? (netQuote / stamp.stakeQuote) * 100 : 0, feesQuote: fees, fundingQuote: funding, closedAt: nowSec } }
  }
}

/** A trade of a coin due to end within this long of a signal is ended by it: the clone's turn and the settlement each
 * come once a minute, so a trade held one bar comes due as the next close's signal arrives. */
const CLONE_DUE_WITHIN_MS = 60_000

/** A clone's signal acted on: its trade entered, or a miss written. Once: a signal whose key a trade already carries is
 * passed over. One trade a coin at a time: where the coin's trade of an earlier close is due by now, it is closed at
 * this close, as the clone's test closes it, and the new one entered in the same write. Returns what came of it. */
export async function cloneSignal(signal: CloneSignal, deps: CloneDeps): Promise<string> {
  const px = await deps.perpPrice(signal.venue, signal.symbol).catch(() => null)
  const standing = await deps.copyStanding().catch(() => null)
  const bookLevels = await deps.perpBook(signal.venue, signal.symbol).catch(() => null)
  const event = { px: signal.px, after: signal.side === 'long' ? 1 : -1, perp: { venue: signal.venue, symbol: signal.symbol }, coin: signal.coin }
  let missed: MissRecord | null = null
  const outcome = await deps.queue(async (): Promise<string> => {
    const fresh = await deps.getSettings()
    if (healCopyTrading(fresh.copyTrading).clones[signal.traderKey] === undefined) return 'not running'
    const mine = cloneExecutors(fresh.executors)
    if (mine.some((executor) => executor.clone?.signalKey === signal.key)) return 'already acted on'
    const nowMs = deps.nowMs()
    let executors = [...fresh.executors]
    let closed = ''
    const held = mine.find((executor) => executor.status === 'active' && executor.clone?.traderKey === signal.traderKey && executor.clone.coin === signal.coin)
    if (held !== undefined) {
      const due = (held.clone as CloneTradeStamp).openedAtMs + (held.clone as CloneTradeStamp).holdSec * 1000 <= nowMs + CLONE_DUE_WITHIN_MS
      if (!due || px === null || !(px > 0)) return 'a trade of this coin is open'
      const ended = await closedClone(held, px, 'time', deps)
      executors = executors.map((executor) => (executor.id === held.id ? ended : executor))
      closed = `closed ${signal.coin} at its hold; `
    }
    const write = async (): Promise<void> => {
      if (executors !== fresh.executors) await deps.setExecutors(executors)
    }
    const miss = async (stage: MissRecord['stage'], reason: string): Promise<string> => {
      missed = followMiss({ event, eventKey: signal.key, nowMs, stage, reason, writer: 'clone' })
      await write()
      return `${closed}missed: ${reason}`
    }
    const lagSec = (nowMs - signal.receivedMs) / 1000
    if (lagSec > FOLLOW_LINES.maxEntryLagSec) return miss('late', `acted on ${Math.round(lagSec)} s after its close was read, past ${FOLLOW_LINES.maxEntryLagSec} s`)
    if (px === null || !(px > 0)) return miss('gate', "the perpetual's price could not be read")
    // A clone leaves the follows their room: the hour's last opens and the book's last places are theirs.
    const opens = copyOpensLastHour(executors, nowMs)
    if (opens >= FOLLOW_LINES.maxOpensPerHour - FOLLOW_LINES.followReserve) return miss('cap', `${opens} opened in the last hour; the hour's last ${FOLLOW_LINES.followReserve} are kept for follows`)
    const books = healPaperBooks(fresh.paperBooks)
    const open = bookExecutors(executors, 'copy', books.startedAt ?? 0).filter((executor) => executor.status === 'active')
    if (books.running && open.length >= books.books.copy.maxOpen - FOLLOW_LINES.followReserve) return miss('cap', `The copy book has ${open.length} trades open; its last ${FOLLOW_LINES.followReserve} places are kept for follows.`)
    if (standing === null) return miss('cap', "the copy book's standing could not be read")
    const room = { ...standing, open: open.length }
    const stakeQuote = books.books.copy.maxStakeShare * room.settledEquity
    const problem = bookRoomProblem({ books, id: 'copy', standing: room, stakeQuote, dayStartEquity: room.dayStartEquity })
    if (problem !== null) return miss(books.running ? 'cap' : 'off', problem)
    // The liquidity gate on the perpetual's book at the stake (V8-S2-LIQ): it refuses for V8's writers.
    const liquidity = liquidityVerdictOf({ venue: signal.venue, feePct: PERP_FEES[signal.venue].takerPct, side: signal.side === 'long' ? 'BUY' : 'SELL', stakeQuote, levels: bookLevels, bookAgeMs: bookLevels === null ? null : nowMs - bookLevels.atMs, predictedMovePct: null })
    if (!liquidity.ok) return miss('liquidity', liquidity.reason)
    const qty = stakeQuote / px
    const stamp: CloneTradeStamp = {
      traderKey: signal.traderKey,
      coin: signal.coin,
      venue: signal.venue,
      symbol: signal.symbol,
      side: signal.side,
      signalKey: signal.key,
      openedAtMs: nowMs,
      entryPx: px,
      qty,
      stakeQuote,
      holdSec: signal.holdBars * CLONE_LINES.barMinutes * 60,
      feesQuote: (PERP_FEES[signal.venue].takerPct / 100) * stakeQuote,
      closeReason: null
    }
    const book: BookMark = { id: 'copy', startedAt: books.startedAt as number, ledger: 'clone' }
    executors = [...executors, clonePaperExecutor({ id: deps.newId(), stamp, book, nowSec: Math.floor(nowMs / 1000) })]
    await write()
    return `${closed}entered ${signal.side} ${signal.coin} at ${px}`
  })
  if (missed !== null) await deps.miss(missed).catch((error) => console.error('A missed clone trade could not be recorded:', error))
  return outcome
}

/** Each open clone trade closed where it must be -- its hold, the loss of its stake, its clone switched off -- and
 * each stopped elsewhere given its result. Returns the names of those it closed. */
export async function settleClones(deps: CloneDeps): Promise<string[]> {
  const { executors, copyTrading } = await deps.getSettings()
  const running = healCopyTrading(copyTrading).clones
  const done: string[] = []
  for (const executor of cloneExecutors(executors)) {
    const stamp = executor.clone as CloneTradeStamp
    const stoppedElsewhere = executor.status === 'stopped' && executor.book?.result === undefined
    if (executor.status !== 'active' && !stoppedElsewhere) continue
    const px = await deps.perpPrice(stamp.venue, stamp.symbol).catch(() => null)
    if (px === null) continue
    const nowMs = deps.nowMs()
    const lossPct = (stamp.side === 'long' ? px / stamp.entryPx - 1 : 1 - px / stamp.entryPx) * 100
    const reason: CloneTradeStamp['closeReason'] = stoppedElsewhere || running[stamp.traderKey] === undefined ? 'stopped' : nowMs - stamp.openedAtMs >= stamp.holdSec * 1000 ? 'time' : lossPct <= -100 ? 'loss cap' : null
    if (reason === null) continue
    const wrote = await deps.queue(async (): Promise<boolean> => {
      const fresh = await deps.getSettings()
      const current = fresh.executors.find((entry) => entry.id === executor.id)
      if (current?.clone === undefined || current.book?.result !== undefined) return false
      const ended = await closedClone(current, px, reason, deps)
      await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? ended : entry)))
      return true
    })
    if (wrote) done.push(executor.name)
  }
  return done
}

/** Every open clone trade closed now at its perpetual's price, as stopped: paper testing was stopped. Returns the names
 * of those it closed. */
export async function closeClones(deps: CloneDeps): Promise<string[]> {
  const { executors } = await deps.getSettings()
  const done: string[] = []
  for (const executor of cloneExecutors(executors).filter((entry) => entry.status === 'active')) {
    const stamp = executor.clone as CloneTradeStamp
    const px = await deps.perpPrice(stamp.venue, stamp.symbol).catch(() => null)
    if (px === null) continue
    const wrote = await deps.queue(async (): Promise<boolean> => {
      const fresh = await deps.getSettings()
      const current = fresh.executors.find((entry) => entry.id === executor.id)
      if (current?.clone === undefined || current.status !== 'active' || current.book?.result !== undefined) return false
      const ended = await closedClone(current, px, 'stopped', deps)
      await deps.setExecutors(fresh.executors.map((entry) => (entry.id === executor.id ? ended : entry)))
      return true
    })
    if (wrote) done.push(executor.name)
  }
  return done
}

/** The same, against the running app. */
export const cloneBrowserDeps: CloneDeps = {
  getSettings: () => window.api.settings.get(),
  setExecutors: async (executors) => {
    await window.api.settings.set({ executors })
  },
  queue: (work) => settingsWrites(work),
  copyStanding: async () => (await window.api.books.state()).standings.find((standing) => standing.id === 'copy') ?? null,
  perpPrice: (venue, symbol) => window.api.traders.perpPrice(venue, symbol),
  perpBook: (venue, symbol) => window.api.traders.perpBook(venue, symbol),
  perpFunding: (venue, symbol, fromSec, toSec) => window.api.traders.perpFunding(venue, symbol, fromSec, toSec),
  miss: (miss) => window.api.books.miss(miss),
  nowMs: () => Date.now(),
  newId: () => crypto.randomUUID()
}
