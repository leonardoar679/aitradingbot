import { ipcMain } from 'electron'
import { IpcChannel, type Exchange, type LiveOrderRecord } from '../../../shared/ipc'
import {
  getLiveTradingStatus,
  setLiveTradingConfig,
  engageKillSwitch,
  releaseKillSwitch,
  setSessionArmed,
  canPlaceLiveOrder,
  canCloseLivePosition,
  recordLiveOrderUsage,
  checkLossLimitAndAutoDisarm
} from '../../services/liveTradingService'
import { listOpenLivePositions, getLivePosition, recordLiveFill } from '../../services/livePositionsService'
import { createLiveOrder, listOpenLiveOrders, getLiveOrder, resolveLiveOrder } from '../../services/liveOrdersService'
import { getDecryptedCredential } from '../../services/credentialsService'
import { placeMarketOrder, placeMarketSellByQuantity, placeLimitOrder, queryOrder, cancelOrder } from '../../services/exchanges/binanceTrading'

/** Binance's own status strings, mapped onto the three-way resolution LiveOrder cares about.
 * Null means still resting (NEW/PARTIALLY_FILLED/PENDING_CANCEL) — nothing to do yet. */
function resolvedStatus(binanceStatus: string): 'filled' | 'cancelled' | 'expired' | null {
  if (binanceStatus === 'FILLED') return 'filled'
  if (binanceStatus === 'CANCELED') return 'cancelled'
  if (binanceStatus === 'EXPIRED' || binanceStatus === 'REJECTED') return 'expired'
  return null
}

export function registerLiveTradingHandlers(): void {
  ipcMain.handle(IpcChannel.LiveTradingGetStatus, () => getLiveTradingStatus())
  ipcMain.handle(
    IpcChannel.LiveTradingSetConfig,
    (_event, patch: { maxOrderQuote?: number; dailyCapQuote?: number; dailyLossLimitQuote?: number }) => setLiveTradingConfig(patch)
  )
  ipcMain.handle(IpcChannel.LiveTradingEngageKillSwitch, () => engageKillSwitch())
  ipcMain.handle(IpcChannel.LiveTradingReleaseKillSwitch, () => releaseKillSwitch())
  ipcMain.handle(IpcChannel.LiveTradingSetSessionArmed, (_event, armed: boolean) => setSessionArmed(armed))
  ipcMain.handle(IpcChannel.LiveTradingListPositions, () => listOpenLivePositions())

  // The only path in this app that ever places a real order. Every gate is re-checked here,
  // server-side, immediately before the network call — a renderer-side check is a UX nicety,
  // never the actual gate. Only Binance has a trading adapter; only market orders are supported.
  ipcMain.handle(
    IpcChannel.ExecutorPlaceLiveOrder,
    async (
      _event,
      exchange: Exchange,
      symbol: string,
      baseAsset: string,
      quoteAsset: string,
      side: 'buy' | 'sell',
      quoteAmount: number
    ) => {
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
  )

  // Closing an existing live position — gated by canCloseLivePosition, not canPlaceLiveOrder:
  // closing only ever reduces risk, so it's never subject to the size/cap/loss-limit gates that
  // bound new exposure (see liveTradingService.canCloseLivePosition for the full reasoning).
  ipcMain.handle(IpcChannel.LiveTradingClosePosition, async (_event, positionId: string) => {
    const position = await getLivePosition(positionId)
    if (!position || position.closedAt !== null) throw new Error('Position not found or already closed')
    if (position.exchange !== 'binance') throw new Error('Live trading is only supported on Binance')

    const gate = await canCloseLivePosition()
    if (!gate.allowed) throw new Error(gate.reason ?? 'Close blocked')

    const { apiKey, apiSecret } = await getDecryptedCredential(position.exchange)
    const result = await placeMarketSellByQuantity(apiKey, apiSecret, position.symbol, position.qty)
    await recordLiveOrderUsage(result.cummulativeQuoteQty)
    await recordLiveFill(position.exchange, position.symbol, position.baseAsset, position.quoteAsset, 'sell', result.filledQty, result.avgFillPrice)
    await checkLossLimitAndAutoDisarm()
    return { ...result, placedAt: Math.floor(Date.now() / 1000) }
  })

  // Placing a real resting limit order — gated exactly like a market order (canPlaceLiveOrder):
  // a resting order is new committed exposure the instant it's placed, same as a market fill.
  ipcMain.handle(
    IpcChannel.ExecutorPlaceLiveLimitOrder,
    async (
      _event,
      executorId: string,
      exchange: Exchange,
      symbol: string,
      baseAsset: string,
      quoteAsset: string,
      side: 'buy' | 'sell',
      amountQuote: number,
      limitPrice: number
    ): Promise<{ resolved: true; liveOrder: LiveOrderRecord } | { resolved: false; pendingLiveOrderId: string }> => {
      if (exchange !== 'binance') throw new Error('Live trading is only supported on Binance')

      const gate = await canPlaceLiveOrder(amountQuote)
      if (!gate.allowed) throw new Error(gate.reason ?? 'Live order blocked')

      const quantity = amountQuote / limitPrice
      const { apiKey, apiSecret } = await getDecryptedCredential(exchange)
      const result = await placeLimitOrder(apiKey, apiSecret, symbol, side === 'buy' ? 'BUY' : 'SELL', quantity, limitPrice)

      if (result.status === 'FILLED') {
        await recordLiveOrderUsage(result.cummulativeQuoteQty)
        await recordLiveFill(exchange, symbol, baseAsset, quoteAsset, side, result.filledQty, result.avgFillPrice)
        if (side === 'sell') await checkLossLimitAndAutoDisarm()
        return { resolved: true, liveOrder: { ...result, placedAt: Math.floor(Date.now() / 1000) } }
      }

      // Still resting — reserve the full notional against the daily cap now (LiveTradingPollOpenOrders /
      // LiveTradingCancelOrder refund whatever doesn't end up executing once the order resolves).
      await recordLiveOrderUsage(amountQuote)
      const liveOrder = await createLiveOrder({ executorId, exchange, symbol, baseAsset, quoteAsset, side, orderId: result.orderId, limitPrice, quantity })
      return { resolved: false, pendingLiveOrderId: liveOrder.id }
    }
  )

  // Polled by LiveOrderScheduler every few seconds — the only place a resting live limit order's
  // fate is discovered. No gate check: querying status is read-only and changes nothing.
  ipcMain.handle(IpcChannel.LiveTradingPollOpenOrders, async (): Promise<{ executorId: string; liveOrder: LiveOrderRecord }[]> => {
    const open = await listOpenLiveOrders()
    const resolutions: { executorId: string; liveOrder: LiveOrderRecord }[] = []

    for (const order of open) {
      try {
        const { apiKey, apiSecret } = await getDecryptedCredential(order.exchange)
        const result = await queryOrder(apiKey, apiSecret, order.symbol, order.orderId)
        const status = resolvedStatus(result.status)
        if (status === null) continue // still resting

        await resolveLiveOrder(order.id, status, result.filledQty, result.filledQty > 0 ? result.avgFillPrice : null)
        const reserved = order.quantity * order.limitPrice
        await recordLiveOrderUsage(result.cummulativeQuoteQty - reserved)
        if (result.filledQty > 0) {
          await recordLiveFill(order.exchange, order.symbol, order.baseAsset, order.quoteAsset, order.side, result.filledQty, result.avgFillPrice)
          if (order.side === 'sell') await checkLossLimitAndAutoDisarm()
        }
        resolutions.push({ executorId: order.executorId, liveOrder: { ...result, placedAt: order.placedAt } })
      } catch (error) {
        console.error(`Failed to poll live order ${order.id}:`, error)
      }
    }
    return resolutions
  })

  // Cancelling a resting order — deliberately ungated. Cancellation only ever reduces risk, so
  // it's never blocked by session-arm, the kill switch, or any cap (see the Phase 2c plan).
  ipcMain.handle(IpcChannel.LiveTradingCancelOrder, async (_event, liveOrderId: string): Promise<LiveOrderRecord> => {
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
  })
}
