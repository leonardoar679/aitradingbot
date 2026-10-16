import { ipcMain } from 'electron'
import { IpcChannel, canTradeDemoOn, type Exchange, type LiveOrderRecord } from '../../../shared/ipc'
import { listOpenLivePositions, listClosedLivePositions, getLivePosition, recordLiveFill } from '../../services/livePositionsService'
import { createLiveOrder, listOpenLiveOrders } from '../../services/liveOrdersService'
import { singleFlight } from '../../services/singleFlight'
import { assertLiveOrderAffordable, executeLiveClose, cancelLiveOrderById, cancelSiblingLiveOrders, placeLiveLimitOrderOn, placeLiveMarketOrder, pollLiveOrder, type LiveOrderResolution } from '../../services/liveExecutionService'
import { drainStreamResolutions } from '../../services/liveUserStreamService'
import { getReconciliationState } from '../../services/liveReconcileService'
import { createWatcher, listActiveWatchers, deactivateWatcher, drainResolvedWatcherEvents } from '../../services/livePositionWatchersService'

// THE DEMO BOOK'S BRIDGE (V7.1 Stage 8, 16 October 2026). Every call here names the book 'demo'
// and nothing else: an exchange's demo account (DEMO_EXCHANGES), its own ledgers, its own
// watchers, no live gate -- play money the exchange gives, which no order here can turn into real
// money. The real book's bridge is liveTradingHandlers.ts; a renderer file allowed this bridge
// (the paper laboratory's writer) is held off that one by tests/aiNoLivePath.test.ts.

const BOOK = 'demo' as const

export function registerDemoTradingHandlers(): void {
  const demoOnly = (exchange: Exchange): void => {
    if (!canTradeDemoOn(exchange)) throw new Error(`This app has no demo account on ${exchange}`)
  }

  // A demo market order: Order's one order, Position's entry.
  ipcMain.handle(
    IpcChannel.DemoTradingPlaceOrder,
    (_event, exchange: Exchange, symbol: string, baseAsset: string, quoteAsset: string, side: 'buy' | 'sell', quoteAmount: number): Promise<LiveOrderRecord> => {
      demoOnly(exchange)
      return placeLiveMarketOrder(exchange, symbol, baseAsset, quoteAsset, side, quoteAmount, BOOK)
    }
  )

  // A demo resting limit order, resolved at once where the exchange filled it on the spot, else
  // kept in the demo order ledger and polled.
  ipcMain.handle(
    IpcChannel.DemoTradingPlaceLimitOrder,
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
      demoOnly(exchange)
      await assertLiveOrderAffordable(exchange, quoteAsset, side, amountQuote, BOOK)
      const quantity = amountQuote / limitPrice
      const result = await placeLiveLimitOrderOn(exchange, symbol, side, quantity, limitPrice, BOOK)
      if (result.status === 'FILLED') {
        await recordLiveFill(exchange, symbol, baseAsset, quoteAsset, side, result.filledQty, result.avgFillPrice, result.commissions, undefined, BOOK)
        return { resolved: true, liveOrder: { ...result, placedAt: Math.floor(Date.now() / 1000) } }
      }
      const liveOrder = await createLiveOrder({ executorId, exchange, symbol, baseAsset, quoteAsset, side, orderId: result.orderId, limitPrice, quantity }, BOOK)
      return { resolved: false, pendingLiveOrderId: liveOrder.id }
    }
  )

  ipcMain.handle(IpcChannel.DemoTradingClosePosition, async (_event, positionId: string, quantity: number) => {
    const position = await getLivePosition(positionId, BOOK)
    if (!position || position.closedAt !== null) throw new Error('Position not found or already closed')
    demoOnly(position.exchange)
    return executeLiveClose(position, quantity, BOOK)
  })

  ipcMain.handle(IpcChannel.DemoTradingCancelOrder, (_event, liveOrderId: string): Promise<LiveOrderRecord> => cancelLiveOrderById(liveOrderId, BOOK))

  ipcMain.handle(IpcChannel.DemoTradingListPositions, () => listOpenLivePositions(BOOK))
  ipcMain.handle(IpcChannel.DemoTradingListClosedPositions, () => listClosedLivePositions(BOOK))
  ipcMain.handle(IpcChannel.DemoTradingReconciliation, () => getReconciliationState(BOOK))

  ipcMain.handle(
    IpcChannel.DemoTradingCreateWatcher,
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
      demoOnly(exchange)
      const openPositions = await listOpenLivePositions(BOOK)
      const position = openPositions.find((p) => p.exchange === exchange && p.symbol === symbol)
      if (!position) throw new Error('No open demo position found to watch — did the entry order fill?')
      return createWatcher({ executorId, livePositionId: position.id, exchange, symbol, entryPrice, takeProfitPct, stopLossPct, timeLimitSec, trailingStop }, BOOK)
    }
  )

  ipcMain.handle(IpcChannel.DemoTradingListActiveWatchers, async () => {
    const watchers = await listActiveWatchers(BOOK)
    return watchers.map((w) => ({
      executorId: w.executorId,
      livePositionId: w.livePositionId,
      exchange: w.exchange,
      symbol: w.symbol,
      entryPrice: w.entryPrice,
      trailingPeakPrice: w.trailingPeakPrice,
      takeProfitPct: w.takeProfitPct,
      stopLossPct: w.stopLossPct,
      timeLimitSec: w.timeLimitSec,
      trailingStop: w.trailingStop,
      enteredAt: w.enteredAt,
      consecutiveFailures: w.consecutiveFailures,
      lastError: w.lastError
    }))
  })

  // Stop on a demo Position still being watched: closed now on the demo account, the result read
  // back from the demo ledger, never made up here.
  ipcMain.handle(IpcChannel.DemoTradingStopWatcher, async (_event, watcherId: string) => {
    const watcher = (await listActiveWatchers(BOOK)).find((w) => w.id === watcherId)
    if (!watcher) throw new Error('Watcher not found or already resolved')
    const position = await getLivePosition(watcher.livePositionId, BOOK)
    if (!position || position.closedAt !== null || position.qty <= 0) {
      await deactivateWatcher(watcherId, BOOK)
      return null
    }
    await executeLiveClose(position, position.qty, BOOK)
    await deactivateWatcher(watcherId, BOOK)
    await cancelSiblingLiveOrders(watcher.executorId, BOOK)
    const closedPosition = await getLivePosition(watcher.livePositionId, BOOK)
    if (!closedPosition || closedPosition.exitPrice === null || closedPosition.realizedPnl === null) return null
    return {
      entryPrice: watcher.entryPrice,
      exitReason: 'manual' as const,
      exitPrice: closedPosition.exitPrice,
      realizedPnl: closedPosition.realizedPnl,
      closedAt: closedPosition.closedAt ?? Math.floor(Date.now() / 1000)
    }
  })

  // One poll for the demo book: its resting orders asked about, its watchers' exits and what its
  // reconciliation resolved, drained together.
  ipcMain.handle(
    IpcChannel.DemoTradingPoll,
    singleFlight(
      async (): Promise<{ orderResolutions: LiveOrderResolution[]; watcherEvents: Awaited<ReturnType<typeof drainResolvedWatcherEvents>> }> => {
        const open = await listOpenLiveOrders(BOOK)
        const resolutions: LiveOrderResolution[] = []
        for (const order of open) {
          try {
            const resolution = await pollLiveOrder(order, BOOK)
            if (resolution !== null) resolutions.push(resolution)
          } catch (error) {
            console.error(`Failed to poll demo order ${order.id}:`, error)
          }
        }
        return { orderResolutions: [...drainStreamResolutions(BOOK), ...resolutions], watcherEvents: await drainResolvedWatcherEvents(BOOK) }
      },
      // A poll that overlaps the one running hands on what the reconciliation resolved meanwhile;
      // the watchers' exits wait for the next poll, seconds away.
      () => ({ orderResolutions: drainStreamResolutions(BOOK), watcherEvents: [] })
    )
  )
}
