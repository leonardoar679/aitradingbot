import type { Exchange, LiveOrderRecord, LivePosition } from '../../shared/ipc'
import { canCloseLivePosition, canPlaceLiveOrder, recordLiveOrderUsage, checkLossLimitAndAutoDisarm } from './liveTradingService'
import { recordLiveFill } from './livePositionsService'
import { getDecryptedCredential } from './credentialsService'
import { placeMarketOrder, placeMarketSellByQuantity, cancelOrder, type LiveOrderResult } from './exchanges/binanceTrading'
import { listOpenLiveOrders, getLiveOrder, resolveLiveOrder } from './liveOrdersService'

/** The one place a real market order actually executes — called both by the
 * ExecutorPlaceLiveOrder IPC handler (Order/Position's synchronous entry) and, from Phase 5 on,
 * directly by the live TWAP loop (liveTwapService.ts) for every slice after the first. Every gate
 * is re-checked here, in-process, immediately before the network call — same guarantee as the IPC
 * handler had, just callable without a round trip for a background loop that isn't a renderer. */
export async function placeLiveMarketOrder(
  exchange: Exchange,
  symbol: string,
  baseAsset: string,
  quoteAsset: string,
  side: 'buy' | 'sell',
  quoteAmount: number
): Promise<LiveOrderRecord> {
  if (exchange !== 'binance') throw new Error('Live trading is only supported on Binance')

  const gate = await canPlaceLiveOrder(quoteAmount)
  if (!gate.allowed) throw new Error(gate.reason ?? 'Live order blocked')

  const { apiKey, apiSecret } = await getDecryptedCredential(exchange)
  const result = await placeMarketOrder(apiKey, apiSecret, symbol, side === 'buy' ? 'BUY' : 'SELL', quoteAmount)
  await recordLiveOrderUsage(quoteAmount)
  await recordLiveFill(exchange, symbol, baseAsset, quoteAsset, side, result.filledQty, result.avgFillPrice)
  if (side === 'sell') await checkLossLimitAndAutoDisarm()
  return { ...result, placedAt: Math.floor(Date.now() / 1000) }
}

/** The one place a real closing sell actually executes — called both by the
 * LiveTradingClosePosition IPC handler (a user clicking Close) and, from Phase 3 on, directly by
 * the live Position watcher loop (an automatic take-profit/stop-loss/trailing-stop/time-limit
 * exit) — same gate, same ledger writes, same behavior regardless of who triggered it. Gated by
 * canCloseLivePosition, not canPlaceLiveOrder: closing only ever reduces risk, so it's never
 * subject to the size/cap/loss-limit gates that bound new exposure. */
export async function executeLiveClose(position: LivePosition, quantity: number): Promise<LiveOrderResult & { placedAt: number }> {
  if (!(quantity > 0) || quantity > position.qty) throw new Error(`Close quantity must be between 0 and ${position.qty}`)

  const gate = await canCloseLivePosition()
  if (!gate.allowed) throw new Error(gate.reason ?? 'Close blocked')

  const { apiKey, apiSecret } = await getDecryptedCredential(position.exchange)
  const result = await placeMarketSellByQuantity(apiKey, apiSecret, position.symbol, quantity)
  await recordLiveOrderUsage(result.cummulativeQuoteQty)
  await recordLiveFill(position.exchange, position.symbol, position.baseAsset, position.quoteAsset, 'sell', result.filledQty, result.avgFillPrice)
  await checkLossLimitAndAutoDisarm()
  return { ...result, placedAt: Math.floor(Date.now() / 1000) }
}

/** Cancels one resting live limit order by its ledger id — ungated (cancelling only ever reduces
 * risk, never subject to session-arm/kill-switch/size/cap/loss-limit). Shared by the manual
 * LiveTradingCancelOrder IPC handler and cancelSiblingLiveOrders below, so both go through the
 * exact same refund/fill-recording bookkeeping. */
export async function cancelLiveOrderById(liveOrderId: string): Promise<LiveOrderRecord> {
  const order = await getLiveOrder(liveOrderId)
  if (!order || order.status !== 'open') throw new Error('Order not found or already resolved')

  const { apiKey, apiSecret } = await getDecryptedCredential(order.exchange)
  const result = await cancelOrder(apiKey, apiSecret, order.symbol, order.orderId)
  await resolveLiveOrder(order.id, 'cancelled', result.filledQty, result.filledQty > 0 ? result.avgFillPrice : null)
  const reserved = order.quantity * order.limitPrice
  await recordLiveOrderUsage(result.cummulativeQuoteQty - reserved)
  if (result.filledQty > 0) {
    await recordLiveFill(order.exchange, order.symbol, order.baseAsset, order.quoteAsset, order.side, result.filledQty, result.avgFillPrice)
    if (order.side === 'sell') await checkLossLimitAndAutoDisarm()
  }
  return { ...result, placedAt: order.placedAt }
}

/** Called when a live DCA executor's exit watcher resolves (automatic trigger or manual Stop):
 * any of that executor's still-unfilled ladder levels must be cancelled too, since continuing to
 * average into a position that just closed makes no sense (mirrors paper DCA, which stops
 * evaluating remaining levels the instant it closes). Best-effort and generic — a safe no-op for
 * Order/Position, which never have leftover resting orders once their one order resolves. One
 * failed cancellation never blocks the others. */
export async function cancelSiblingLiveOrders(executorId: string): Promise<void> {
  const open = await listOpenLiveOrders()
  const siblings = open.filter((o) => o.executorId === executorId)
  for (const order of siblings) {
    try {
      await cancelLiveOrderById(order.id)
    } catch (error) {
      console.error(`Failed to cancel sibling live order ${order.id} for executor ${executorId}:`, error)
    }
  }
}
