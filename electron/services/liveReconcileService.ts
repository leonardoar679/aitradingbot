import { reconciliationNotice } from '../../shared/notices'
import { describeDiscrepancy, describeUnknownOrder, reconcileLivePositions, type ReconciliationReadout } from '../../shared/reconcileLive'
import type { TradingBook } from '../../shared/ipc'
import { getDecryptedCredential, listCredentialStatus, readLiveBalances } from './credentialsService'
import { venuesOf, type TradingVenue } from './exchanges/venues'
import { resolveOrderFromExchange } from './liveExecutionService'
import { listOpenLiveOrders } from './liveOrdersService'
import { listOpenLivePositions } from './livePositionsService'
import { queueStreamResolution } from './liveUserStreamService'
import { tell } from './noticeService'

// THE RECONCILIATION (the V5 document, §102; V5 Stage 11, 8 October 2026). Once a minute while a
// key is stored: the orders resting on the exchange against the ledger -- a resting order the
// ledger does not know is told, as RECONCILIATION on its own thread; a ledger order the exchange
// no longer rests is asked about and resolved as the poll resolves it -- and the balances against
// the open positions, by the rule the Positions page applied (shared/reconcileLive.ts), moved here
// so that no page need be open: a shortfall is told on the asset's thread. The ledger is never
// rewritten by any of it. Read-only against the exchange: it places, cancels and sizes nothing.
//
// Since V7.1 Stage 8 each BOOK is reconciled on its own, each venue of it against its own ledgers
// and its own key (exchanges/venues.ts): Binance's real account as before, and an exchange's demo
// account while its demo key is stored, its notices named for the demo. A demo discrepancy is told
// on a thread of its own, so it never stands in for a real one.

export const RECONCILE_EVERY_MS = 60_000

export type ReconciliationState = ReconciliationReadout

const EMPTY: ReconciliationState = { at: null, unknownOrders: [], discrepancies: [], unchecked: [], resolvedByCheck: 0, keyStored: false, error: null }
const states: Record<TradingBook, ReconciliationState> = { real: { ...EMPTY }, demo: { ...EMPTY } }
let timer: ReturnType<typeof setInterval> | null = null
const running: Record<TradingBook, boolean> = { real: false, demo: false }

export function getReconciliationState(book: TradingBook = 'real'): ReconciliationState {
  const state = states[book]
  return { ...state, unknownOrders: [...state.unknownOrders], discrepancies: [...state.discrepancies], unchecked: [...state.unchecked] }
}

/** The one key of a venue, where it is stored. */
async function keyStoredFor(venue: TradingVenue): Promise<boolean> {
  const keys = await listCredentialStatus()
  return keys.some((key) => key.exchange === venue.exchange && (key.slot ?? 'real') === venue.slot && key.configured)
}

/** One look at one book. Exported for its test and the check. */
export async function reconcileOnce(book: TradingBook = 'real'): Promise<ReconciliationState> {
  if (running[book]) return getReconciliationState(book)
  running[book] = true
  const nowSec = Math.floor(Date.now() / 1000)
  const thread = (name: string): string => (book === 'demo' ? `demo:${name}` : name)
  try {
    const venues = venuesOf(book)
    const stored: TradingVenue[] = []
    for (const venue of venues) if (await keyStoredFor(venue)) stored.push(venue)
    if (stored.length === 0) {
      states[book] = { ...states[book], at: nowSec, unknownOrders: [], discrepancies: [], unchecked: [], keyStored: false, error: null }
      return getReconciliationState(book)
    }
    states[book] = { ...states[book], keyStored: true }
    const unknownAll: ReconciliationState['unknownOrders'] = []
    const discrepanciesAll: ReconciliationState['discrepancies'] = []
    const uncheckedAll: string[] = []
    let resolved = 0
    for (const venue of stored) {
      const credentials = await getDecryptedCredential(venue.exchange, venue.slot)
      const [onExchange, ledger] = await Promise.all([venue.fetchOpenOrders(credentials), listOpenLiveOrders(book)])
      const keyOf = (order: { symbol: string; orderId: number | string }): string => `${order.symbol}:${order.orderId}`
      const known = new Set(ledger.filter((order) => order.exchange === venue.exchange).map(keyOf))
      const unknown = onExchange.filter((order) => !known.has(keyOf(order)))
      for (const order of unknown) {
        tell((i18n) => reconciliationNotice('order', describeUnknownOrder(order, venue.label, i18n), thread(`order:${keyOf(order)}`), i18n))
      }
      unknownAll.push(...unknown)
      // A ledger order the exchange no longer rests: filled, cancelled or expired while nothing heard
      // it. Asked about one by one and resolved as the poll resolves it.
      const resting = new Set(onExchange.map(keyOf))
      for (const order of ledger) {
        if (order.exchange !== venue.exchange || resting.has(keyOf(order))) continue
        try {
          const resolution = await resolveOrderFromExchange(order, await venue.queryOrder(credentials, order.symbol, order.orderId), book)
          if (resolution !== null) {
            queueStreamResolution(resolution, book)
            resolved++
          }
        } catch (error) {
          console.error(`The reconciliation could not ask about ${book} order ${order.id}:`, error)
        }
      }
      const [positions, balances] = await Promise.all([listOpenLivePositions(book), readLiveBalances(venue.exchange, true, venue.slot)])
      const reconciled = reconcileLivePositions(
        positions.filter((position) => position.exchange === venue.exchange),
        balances
      )
      for (const discrepancy of reconciled.discrepancies) tell((i18n) => reconciliationNotice('asset', describeDiscrepancy(discrepancy, venue.label, i18n), thread(`asset:${discrepancy.asset}`), i18n))
      discrepanciesAll.push(...reconciled.discrepancies)
      uncheckedAll.push(...reconciled.unchecked)
    }
    states[book] = { at: nowSec, unknownOrders: unknownAll, discrepancies: discrepanciesAll, unchecked: uncheckedAll, resolvedByCheck: states[book].resolvedByCheck + resolved, keyStored: true, error: null }
  } catch (error) {
    states[book] = { ...states[book], at: nowSec, error: error instanceof Error ? error.message : String(error) }
  } finally {
    running[book] = false
  }
  return getReconciliationState(book)
}

async function reconcileBoth(): Promise<void> {
  await reconcileOnce('real')
  await reconcileOnce('demo')
}

export function startLiveReconcile(): void {
  if (timer === null) timer = setInterval(() => void reconcileBoth(), RECONCILE_EVERY_MS)
  void reconcileBoth()
}

/** Test seam. */
export function resetLiveReconcile(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  running.real = false
  running.demo = false
  states.real = { ...EMPTY }
  states.demo = { ...EMPTY }
}
