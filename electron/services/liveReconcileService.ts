import { reconciliationNotice } from '../../shared/notices'
import { describeDiscrepancy, describeUnknownOrder, reconcileLivePositions, type ReconciliationReadout } from '../../shared/reconcileLive'
import { getDecryptedCredential, listCredentialStatus, readLiveBalances } from './credentialsService'
import { fetchOpenOrders, queryOrder } from './exchanges/binanceTrading'
import { resolveOrderFromExchange } from './liveExecutionService'
import { listOpenLiveOrders } from './liveOrdersService'
import { listOpenLivePositions } from './livePositionsService'
import { queueStreamResolution } from './liveUserStreamService'
import { tell } from './noticeService'

// THE RECONCILIATION (the V5 document, §102; V5 Stage 11, 8 October 2026). Once a minute while a
// Binance key is stored: the orders resting on the exchange against the ledger -- a resting order
// the ledger does not know is told, as RECONCILIATION on its own thread; a ledger order the exchange
// no longer rests is asked about and resolved as the poll resolves it -- and the balances against
// the open positions, by the rule the Positions page applied (shared/reconcileLive.ts), moved here
// so that no page need be open: a shortfall is told on the asset's thread. The ledger is never
// rewritten by any of it. Read-only against the exchange: it places, cancels and sizes nothing.

export const RECONCILE_EVERY_MS = 60_000

export type ReconciliationState = ReconciliationReadout

let state: ReconciliationState = { at: null, unknownOrders: [], discrepancies: [], unchecked: [], resolvedByCheck: 0, keyStored: false, error: null }
let timer: ReturnType<typeof setInterval> | null = null
let running = false

export function getReconciliationState(): ReconciliationState {
  return { ...state, unknownOrders: [...state.unknownOrders], discrepancies: [...state.discrepancies], unchecked: [...state.unchecked] }
}

/** One look. Exported for its test and the check. */
export async function reconcileOnce(): Promise<ReconciliationState> {
  if (running) return getReconciliationState()
  running = true
  const nowSec = Math.floor(Date.now() / 1000)
  try {
    const keys = await listCredentialStatus()
    const keyStored = keys.some((key) => key.exchange === 'binance' && key.configured)
    if (!keyStored) {
      state = { ...state, at: nowSec, unknownOrders: [], discrepancies: [], unchecked: [], keyStored: false, error: null }
      return getReconciliationState()
    }
    state = { ...state, keyStored: true }
    const { apiKey, apiSecret } = await getDecryptedCredential('binance')
    const [onExchange, ledger] = await Promise.all([fetchOpenOrders(apiKey, apiSecret), listOpenLiveOrders()])
    const keyOf = (order: { symbol: string; orderId: number }): string => `${order.symbol}:${order.orderId}`
    const known = new Set(ledger.filter((order) => order.exchange === 'binance').map(keyOf))
    const unknown = onExchange.filter((order) => !known.has(keyOf(order)))
    for (const order of unknown) {
      tell((i18n) => reconciliationNotice('order', describeUnknownOrder(order, 'Binance', i18n), `order:${keyOf(order)}`, i18n))
    }
    // A ledger order the exchange no longer rests: filled, cancelled or expired while nothing heard
    // it. Asked about one by one and resolved as the poll resolves it.
    const resting = new Set(onExchange.map(keyOf))
    let resolved = 0
    for (const order of ledger) {
      if (order.exchange !== 'binance' || resting.has(keyOf(order))) continue
      try {
        const resolution = await resolveOrderFromExchange(order, await queryOrder(apiKey, apiSecret, order.symbol, order.orderId))
        if (resolution !== null) {
          queueStreamResolution(resolution)
          resolved++
        }
      } catch (error) {
        console.error(`The reconciliation could not ask about order ${order.id}:`, error)
      }
    }
    const [positions, balances] = await Promise.all([listOpenLivePositions(), readLiveBalances('binance', true)])
    const reconciled = reconcileLivePositions(
      positions.filter((position) => position.exchange === 'binance'),
      balances
    )
    for (const discrepancy of reconciled.discrepancies) tell((i18n) => reconciliationNotice('asset', describeDiscrepancy(discrepancy, 'Binance', i18n), `asset:${discrepancy.asset}`, i18n))
    state = { at: nowSec, unknownOrders: unknown, discrepancies: reconciled.discrepancies, unchecked: reconciled.unchecked, resolvedByCheck: state.resolvedByCheck + resolved, keyStored: true, error: null }
  } catch (error) {
    state = { ...state, at: nowSec, error: error instanceof Error ? error.message : String(error) }
  } finally {
    running = false
  }
  return getReconciliationState()
}

export function startLiveReconcile(): void {
  if (timer === null) timer = setInterval(() => void reconcileOnce(), RECONCILE_EVERY_MS)
  void reconcileOnce()
}

/** Test seam. */
export function resetLiveReconcile(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  running = false
  state = { at: null, unknownOrders: [], discrepancies: [], unchecked: [], resolvedByCheck: 0, keyStored: false, error: null }
}
