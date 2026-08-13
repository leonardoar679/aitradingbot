import { ipcMain } from 'electron'
import { IpcChannel, type Exchange } from '../../../shared/ipc'
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
import { getDecryptedCredential } from '../../services/credentialsService'
import { placeMarketOrder, placeMarketSellByQuantity } from '../../services/exchanges/binanceTrading'

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
}
