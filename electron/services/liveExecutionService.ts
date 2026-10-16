import { canTradeDemoOn, canTradeOn, type Exchange, type LiveOrder, type LiveOrderRecord, type LivePosition, type TradingBook } from '../../shared/ipc'
import { describeLiveShortfall } from '../../shared/liveBalances'
import { resolvedOrderStatus } from '../../shared/userStream'
import { canCloseLivePosition, canPlaceLiveOrder, recordLiveOrderUsage, checkLossLimitAndAutoDisarm } from './liveTradingService'
import { recordLiveFill } from './livePositionsService'
import { credentialAccountType, freeBalanceFor, getDecryptedCredential } from './credentialsService'
import type { LiveOrderResult } from './exchanges/binanceTrading'
import { venueFor, type TradingVenue, type VenueCredentials } from './exchanges/venues'
import { listOpenLiveOrders, getLiveOrder, resolveLiveOrder } from './liveOrdersService'

// EVERY ORDER ON AN EXCHANGE GOES THROUGH HERE, by its venue (exchanges/venues.ts) and its book:
// the real book under every live gate, as it always was; the demo book (V7.1 Stage 8) on an
// exchange's demo account, in ledgers of its own, with no live gate -- it is play money -- and no
// way to the real venue, since the venue is chosen by the book.

/** The venue an exchange and a book trade on, or a refusal in the user's words. */
export function venueOrRefuse(exchange: Exchange, book: TradingBook): TradingVenue {
  if (book === 'real' && !canTradeOn(exchange)) throw new Error(`This app cannot place orders on ${exchange} — its key is read-only here`)
  if (book === 'demo' && !canTradeDemoOn(exchange)) throw new Error(`This app has no demo account on ${exchange}`)
  const venue = venueFor(exchange, book)
  if (venue === null) throw new Error(`This app cannot place ${book} orders on ${exchange} yet`)
  return venue
}

async function credentialsOf(venue: TradingVenue): Promise<VenueCredentials> {
  return getDecryptedCredential(venue.exchange, venue.slot)
}

/** Refuses a real order on an account the stored key cannot place one on -- a Bitget key made on a
 * Classic account, which Bitget would refuse with 40084 -- before anything is sent, in words that say
 * the way: the exchange's own words name the mode and nothing else. A placement alone is refused here;
 * a close, a cancel or a query is never held back by this app (the exchange answers those itself), so
 * that no one is trapped inside a position by a check meant to bound new exposure. */
export async function assertAccountCanTrade(venue: TradingVenue): Promise<void> {
  if (venue.book !== 'real') return
  if ((await credentialAccountType(venue.exchange, venue.slot)) !== 'classic') return
  throw new Error(
    `This ${venue.label} key is for a Classic account, which this app reads but cannot place an order on: switch the account to the Unified Trading Account on ${venue.label}, then test the key again on Connections.`
  )
}

/** Refuses a buy the account cannot pay for, in words that say what is wrong.
 *
 * The exchange refuses it too -- with "Account has insufficient balance for requested action",
 * which does not say which asset, how much was needed, how much there is, or that the missing
 * amount may be sitting in a resting order. For a live ladder (DCA, TWAP, Grid) that message
 * arrives once per slice with nothing to act on.
 *
 * Never blocks on a balance it could not read. The exchange remains the authority on whether
 * there is money; this exists so that when there isn't, the person is told something useful. */
export async function assertLiveOrderAffordable(
  exchange: Exchange,
  quoteAsset: string,
  side: 'buy' | 'sell',
  quoteAmount: number,
  book: TradingBook = 'real'
): Promise<void> {
  const free = await freeBalanceFor(exchange, quoteAsset, book === 'demo' ? 'demo' : 'real')
  if (free === null) return
  const problem = describeLiveShortfall({
    side,
    quoteAsset,
    quoteAmount,
    free,
    exchangeLabel: venueFor(exchange, book)?.label ?? exchange
  })
  if (problem !== null) throw new Error(problem)
}

/** The one place a real market order actually executes — called both by the
 * ExecutorPlaceLiveOrder IPC handler (Order/Position's synchronous entry) and, from Phase 5 on,
 * directly by the live TWAP loop (liveTwapService.ts) for every slice after the first. Every gate
 * is re-checked here, in-process, immediately before the network call — same guarantee as the IPC
 * handler had, just callable without a round trip for a background loop that isn't a renderer.
 * On the demo book the same call places a demo order, with no gate and no cap usage. */
export async function placeLiveMarketOrder(
  exchange: Exchange,
  symbol: string,
  baseAsset: string,
  quoteAsset: string,
  side: 'buy' | 'sell',
  quoteAmount: number,
  book: TradingBook = 'real'
): Promise<LiveOrderRecord> {
  // The trading list, not the credential store: an exchange this app can read an account from
  // is not thereby an exchange it can place an order on.
  const venue = venueOrRefuse(exchange, book)

  if (book === 'real') {
    const gate = await canPlaceLiveOrder(quoteAmount)
    if (!gate.allowed) throw new Error(gate.reason ?? 'Live order blocked')
  }
  await assertAccountCanTrade(venue)
  await assertLiveOrderAffordable(exchange, quoteAsset, side, quoteAmount, book)

  const result = await venue.placeMarketOrder(await credentialsOf(venue), symbol, side === 'buy' ? 'BUY' : 'SELL', quoteAmount)
  if (book === 'real') await recordLiveOrderUsage(quoteAmount)
  await recordLiveFill(exchange, symbol, baseAsset, quoteAsset, side, result.filledQty, result.avgFillPrice, result.commissions, undefined, book)
  if (book === 'real' && side === 'sell') await checkLossLimitAndAutoDisarm()
  return { ...result, placedAt: Math.floor(Date.now() / 1000) }
}

/** A resting limit order on a venue, gated on the real book as a market order is. Resolved at once
 * where the exchange filled it on the spot. */
export async function placeLiveLimitOrderOn(
  exchange: Exchange,
  symbol: string,
  side: 'buy' | 'sell',
  quantity: number,
  limitPrice: number,
  book: TradingBook = 'real'
): Promise<LiveOrderResult> {
  const venue = venueOrRefuse(exchange, book)
  await assertAccountCanTrade(venue)
  return venue.placeLimitOrder(await credentialsOf(venue), symbol, side === 'buy' ? 'BUY' : 'SELL', quantity, limitPrice)
}

/** The one place a real closing sell actually executes — called both by the
 * LiveTradingClosePosition IPC handler (a user clicking Close) and, from Phase 3 on, directly by
 * the live Position watcher loop (an automatic take-profit/stop-loss/trailing-stop/time-limit
 * exit) — same gate, same ledger writes, same behavior regardless of who triggered it. Gated by
 * canCloseLivePosition, not canPlaceLiveOrder: closing only ever reduces risk, so it's never
 * subject to the size/cap/loss-limit gates that bound new exposure. A demo close has no gate. */
export async function executeLiveClose(position: LivePosition, quantity: number, book: TradingBook = 'real'): Promise<LiveOrderResult & { placedAt: number }> {
  if (!(quantity > 0) || quantity > position.qty) throw new Error(`Close quantity must be between 0 and ${position.qty}`)

  if (book === 'real') {
    const gate = await canCloseLivePosition()
    if (!gate.allowed) throw new Error(gate.reason ?? 'Close blocked')
  }

  const venue = venueOrRefuse(position.exchange, book)
  const credentials = await credentialsOf(venue)
  const result = await venue.placeMarketSellByQuantity(credentials, position.symbol, quantity)
  if (book === 'real') await recordLiveOrderUsage(result.cummulativeQuoteQty)
  // The step size decides what counts as fully closed: the sell above was floored onto it, so a
  // remainder smaller than one step is dust no exchange will trade. Read from the same cached
  // rules the order itself used; if it cannot be read the ledger falls back to its own floor.
  const stepQty = await venue
    .fetchSymbolRules(position.symbol)
    .then((rules) => Number(rules.stepSize))
    .catch(() => undefined)
  await recordLiveFill(position.exchange, position.symbol, position.baseAsset, position.quoteAsset, 'sell', result.filledQty, result.avgFillPrice, result.commissions, stepQty, book)
  if (book === 'real') await checkLossLimitAndAutoDisarm()
  return { ...result, placedAt: Math.floor(Date.now() / 1000) }
}

export interface LiveOrderResolution {
  executorId: string
  liveOrderId: string
  liveOrder: LiveOrderRecord
  status: 'filled' | 'cancelled' | 'expired'
}

/** One at a time: the poll and the user-data stream can hear the same fill within the same
 * second, and the second to arrive must read the ledger the first already wrote. */
let turn: Promise<unknown> = Promise.resolve()
function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = turn.then(work, work)
  turn = run.catch(() => undefined)
  return run
}

/** One resting order's fate, as the exchange reports it, written into the ledgers: the order
 * resolved, the daily cap's reservation settled against what executed, the fill recorded on the
 * position, and the loss limit looked at after a sell. Shared by the 5-second poll
 * (liveTradingHandlers.ts), the user-data stream (liveUserStreamService.ts) and the reconciliation
 * (liveReconcileService.ts), so a fill is booked once whichever hears it first: the next to hear
 * it reads the order as resolved and does nothing. Null while the order still rests, and for an
 * order already resolved. */
export async function resolveOrderFromExchange(order: LiveOrder, result: LiveOrderResult, book: TradingBook = 'real'): Promise<LiveOrderResolution | null> {
  const status = resolvedOrderStatus(result.status)
  if (status === null) return null
  return inTurn(async () => {
    const current = await getLiveOrder(order.id, book)
    if (current === null || current.status !== 'open') return null
    await resolveLiveOrder(order.id, status, result.filledQty, result.filledQty > 0 ? result.avgFillPrice : null, book)
    const reserved = order.quantity * order.limitPrice
    if (book === 'real') await recordLiveOrderUsage(result.cummulativeQuoteQty - reserved, order.placedAt)
    if (result.filledQty > 0) {
      await recordLiveFill(order.exchange, order.symbol, order.baseAsset, order.quoteAsset, order.side, result.filledQty, result.avgFillPrice, result.commissions, undefined, book)
      if (book === 'real' && order.side === 'sell') await checkLossLimitAndAutoDisarm()
    }
    return { executorId: order.executorId, liveOrderId: order.id, liveOrder: { ...result, placedAt: order.placedAt }, status }
  })
}

/** A ledger order asked about on its venue, and resolved where the exchange says it is done. */
export async function pollLiveOrder(order: LiveOrder, book: TradingBook = 'real'): Promise<LiveOrderResolution | null> {
  const venue = venueOrRefuse(order.exchange, book)
  const result = await venue.queryOrder(await credentialsOf(venue), order.symbol, order.orderId)
  return resolveOrderFromExchange(order, result, book)
}

/** Cancels one resting live limit order by its ledger id — ungated (cancelling only ever reduces
 * risk, never subject to session-arm/kill-switch/size/cap/loss-limit). Shared by the manual
 * LiveTradingCancelOrder IPC handler and cancelSiblingLiveOrders below, so both go through the
 * exact same refund/fill-recording bookkeeping. */
export async function cancelLiveOrderById(liveOrderId: string, book: TradingBook = 'real'): Promise<LiveOrderRecord> {
  const order = await getLiveOrder(liveOrderId, book)
  if (!order || order.status !== 'open') throw new Error('Order not found or already resolved')

  const venue = venueOrRefuse(order.exchange, book)
  const result = await venue.cancelOrder(await credentialsOf(venue), order.symbol, order.orderId)
  await resolveLiveOrder(order.id, 'cancelled', result.filledQty, result.filledQty > 0 ? result.avgFillPrice : null, book)
  const reserved = order.quantity * order.limitPrice
  if (book === 'real') await recordLiveOrderUsage(result.cummulativeQuoteQty - reserved, order.placedAt)
  if (result.filledQty > 0) {
    await recordLiveFill(order.exchange, order.symbol, order.baseAsset, order.quoteAsset, order.side, result.filledQty, result.avgFillPrice, result.commissions, undefined, book)
    if (book === 'real' && order.side === 'sell') await checkLossLimitAndAutoDisarm()
  }
  return { ...result, placedAt: order.placedAt }
}

/** Called when a live DCA executor's exit watcher resolves (automatic trigger or manual Stop):
 * any of that executor's still-unfilled ladder levels must be cancelled too, since continuing to
 * average into a position that just closed makes no sense (mirrors paper DCA, which stops
 * evaluating remaining levels the instant it closes). Best-effort and generic — a safe no-op for
 * Order/Position, which never have leftover resting orders once their one order resolves. One
 * failed cancellation never blocks the others. */
export async function cancelSiblingLiveOrders(executorId: string, book: TradingBook = 'real'): Promise<void> {
  const open = await listOpenLiveOrders(book)
  const siblings = open.filter((o) => o.executorId === executorId)
  for (const order of siblings) {
    try {
      await cancelLiveOrderById(order.id, book)
    } catch (error) {
      console.error(`Failed to cancel sibling ${book} order ${order.id} for executor ${executorId}:`, error)
    }
  }
}
