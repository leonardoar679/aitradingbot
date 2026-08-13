import { ipcMain } from 'electron'
import { IpcChannel, type Exchange, type LiveOrderRecord } from '../../../shared/ipc'
import {
  getLiveTradingStatus,
  setLiveTradingConfig,
  engageKillSwitch,
  releaseKillSwitch,
  setSessionArmed,
  canPlaceLiveOrder,
  recordLiveOrderUsage,
  checkLossLimitAndAutoDisarm
} from '../../services/liveTradingService'
import { listOpenLivePositions, listClosedLivePositions, getLivePosition, recordLiveFill } from '../../services/livePositionsService'
import { createLiveOrder, listOpenLiveOrders, getLiveOrder, resolveLiveOrder } from '../../services/liveOrdersService'
import { executeLiveClose } from '../../services/liveExecutionService'
import { createWatcher, listActiveWatchers, deactivateWatcher, drainResolvedWatcherEvents } from '../../services/livePositionWatchersService'
import { getDecryptedCredential } from '../../services/credentialsService'
import { placeMarketOrder, placeLimitOrder, queryOrder, cancelOrder } from '../../services/exchanges/binanceTrading'

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
  ipcMain.handle(IpcChannel.LiveTradingListClosedPositions, () => listClosedLivePositions())

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

  // Closing an existing live position — the actual execution is executeLiveClose
  // (liveExecutionService.ts), shared with the live Position watcher's automatic exits so a
  // user-initiated close and a triggered stop-loss/take-profit behave identically. `quantity`
  // lets the caller close part of a position instead of all of it.
  ipcMain.handle(IpcChannel.LiveTradingClosePosition, async (_event, positionId: string, quantity: number) => {
    const position = await getLivePosition(positionId)
    if (!position || position.closedAt !== null) throw new Error('Position not found or already closed')
    if (position.exchange !== 'binance') throw new Error('Live trading is only supported on Binance')
    return executeLiveClose(position, quantity)
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

  // Creating a watcher assumes the entry order (ExecutorPlaceLiveOrder, called just before this
  // from ExecutorsPage) already filled and landed in the live position ledger — this just finds
  // that position and starts watching it. Only one active watcher per symbol+exchange is allowed
  // (see the file-level comment in livePositionWatchersService.ts for why).
  ipcMain.handle(
    IpcChannel.LiveTradingCreateWatcher,
    async (
      _event,
      executorId: string,
      exchange: Exchange,
      symbol: string,
      entryPrice: number,
      takeProfitPct: number | null,
      stopLossPct: number | null,
      timeLimitSec: number | null,
      trailingStop: { activationPct: number; trailPct: number } | null
    ) => {
      const openPositions = await listOpenLivePositions()
      const position = openPositions.find((p) => p.exchange === exchange && p.symbol === symbol)
      if (!position) throw new Error('No open live position found to watch — did the entry order fill?')

      return createWatcher({ executorId, livePositionId: position.id, exchange, symbol, entryPrice, takeProfitPct, stopLossPct, timeLimitSec, trailingStop })
    }
  )

  // Lets the renderer check for a symbol conflict *before* spending a real entry order — the
  // real gate is still the conflict check inside createWatcher, but checking first avoids the
  // (recoverable, but unpleasant) case of a real BUY firing and then having nothing watch it.
  ipcMain.handle(IpcChannel.LiveTradingListActiveWatchers, async () => {
    const watchers = await listActiveWatchers()
    return watchers.map((w) => ({ exchange: w.exchange, symbol: w.symbol }))
  })

  // Stop on a live Position executor that's still being watched: force-exit now, for real, same
  // as the manual Close button on a live position (canCloseLivePosition inside executeLiveClose
  // — kill-switch/session-arm only, never size/cap/loss-limit, since exiting only reduces risk).
  // Returns a real LiveExitResult (read back from the ledger after closing, same as the
  // automatic watcher loop does) rather than a raw order result, so the UI never has to guess at
  // or fabricate P&L — exitReason is 'manual' to distinguish it honestly from a triggered barrier.
  ipcMain.handle(IpcChannel.LiveTradingStopWatcher, async (_event, watcherId: string) => {
    const watcher = (await listActiveWatchers()).find((w) => w.id === watcherId)
    if (!watcher) throw new Error('Watcher not found or already resolved')

    const position = await getLivePosition(watcher.livePositionId)
    if (!position || position.closedAt !== null || position.qty <= 0) {
      // Nothing left to close (e.g. the auto-watcher loop already exited it a moment ago) — safe
      // to deactivate.
      await deactivateWatcher(watcherId)
      return null
    }

    // Deactivate only AFTER the close actually succeeds — if executeLiveClose throws (e.g. the
    // kill switch is engaged), the watcher must stay active so it keeps protecting the still-open
    // real position. Deactivating first would silently abandon a real, unprotected position the
    // moment a close attempt merely failed.
    await executeLiveClose(position, position.qty)
    await deactivateWatcher(watcherId)
    const closedPosition = await getLivePosition(watcher.livePositionId)
    if (!closedPosition || closedPosition.exitPrice === null || closedPosition.realizedPnl === null) return null

    return {
      entryPrice: watcher.entryPrice,
      exitReason: 'manual' as const,
      exitPrice: closedPosition.exitPrice,
      realizedPnl: closedPosition.realizedPnl,
      closedAt: closedPosition.closedAt ?? Math.floor(Date.now() / 1000)
    }
  })

  // Polled by the same renderer-side scheduler that polls live orders — see LiveOrderScheduler.tsx.
  ipcMain.handle(IpcChannel.LiveTradingDrainWatcherEvents, () => drainResolvedWatcherEvents())
}
