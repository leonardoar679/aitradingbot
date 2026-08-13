import type { LivePosition } from '../../shared/ipc'
import { canCloseLivePosition, recordLiveOrderUsage, checkLossLimitAndAutoDisarm } from './liveTradingService'
import { recordLiveFill } from './livePositionsService'
import { getDecryptedCredential } from './credentialsService'
import { placeMarketSellByQuantity, type LiveOrderResult } from './exchanges/binanceTrading'

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
