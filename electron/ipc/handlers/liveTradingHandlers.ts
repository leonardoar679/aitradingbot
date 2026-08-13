import { ipcMain } from 'electron'
import { IpcChannel, type Exchange } from '../../../shared/ipc'
import {
  getLiveTradingStatus,
  setLiveTradingConfig,
  engageKillSwitch,
  releaseKillSwitch,
  setSessionArmed,
  canPlaceLiveOrder,
  recordLiveOrderUsage
} from '../../services/liveTradingService'
import { getDecryptedCredential } from '../../services/credentialsService'
import { placeMarketOrder } from '../../services/exchanges/binanceTrading'

export function registerLiveTradingHandlers(): void {
  ipcMain.handle(IpcChannel.LiveTradingGetStatus, () => getLiveTradingStatus())
  ipcMain.handle(IpcChannel.LiveTradingSetConfig, (_event, patch: { maxOrderQuote?: number; dailyCapQuote?: number }) =>
    setLiveTradingConfig(patch)
  )
  ipcMain.handle(IpcChannel.LiveTradingEngageKillSwitch, () => engageKillSwitch())
  ipcMain.handle(IpcChannel.LiveTradingReleaseKillSwitch, () => releaseKillSwitch())
  ipcMain.handle(IpcChannel.LiveTradingSetSessionArmed, (_event, armed: boolean) => setSessionArmed(armed))

  // The only path in this app that ever places a real order. Every gate is re-checked here,
  // server-side, immediately before the network call — a renderer-side check is a UX nicety,
  // never the actual gate. Only Binance has a trading adapter; only market orders are supported.
  ipcMain.handle(
    IpcChannel.ExecutorPlaceLiveOrder,
    async (_event, exchange: Exchange, symbol: string, side: 'buy' | 'sell', quoteAmount: number) => {
      if (exchange !== 'binance') throw new Error('Live trading is only supported on Binance')

      const gate = await canPlaceLiveOrder(quoteAmount)
      if (!gate.allowed) throw new Error(gate.reason ?? 'Live order blocked')

      const { apiKey, apiSecret } = await getDecryptedCredential(exchange)
      const result = await placeMarketOrder(apiKey, apiSecret, symbol, side === 'buy' ? 'BUY' : 'SELL', quoteAmount)
      await recordLiveOrderUsage(quoteAmount)
      return { ...result, placedAt: Math.floor(Date.now() / 1000) }
    }
  )
}
