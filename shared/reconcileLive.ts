import { ENGLISH, type I18n } from './i18n/translate'
import type { LivePosition } from './ipc'
import type { BalanceReadout } from './liveBalances'

/** Compares what this app's live-position ledger believes it holds against what the exchange says
 * is actually in the account.
 *
 * The ledger is built from fills this app saw. Several ordinary things put it out of step with
 * reality, and none of them announce themselves:
 *
 * - Selling the coin on the exchange's own site or app. The position stays open here forever.
 * - A fill that came back with an unusable quantity or price. recordLiveFill refuses those on
 *   purpose and tells the user to reconcile -- this is what it means to be able to.
 * - Withdrawing or transferring the asset out.
 *
 * It matters because the ledger is not decoration: it prices the Positions page, and Close sells
 * the quantity it names. A position the exchange does not back is one whose reported P&L is about
 * coins that are not there, and whose Close will be rejected.
 *
 * Nothing here changes the ledger. A balance cannot say where it came from -- the same BTC could
 * be a tracked position, a manual buy, a deposit or an airdrop -- so silently rewriting real-money
 * records to match it would be guessing with someone's account. This reports; the person decides. */

/** Only shortfalls above this fraction of the ledger quantity are reported.
 *
 * It has to clear the fee, which is the systematic reason a balance is legitimately below the
 * ledger. This app records a fill at the exchange's executed quantity -- deliberately, so avgCost
 * keeps matching what the exchange shows -- but a BUY's commission is charged in the BASE asset
 * unless the BNB discount is on. Buy 0.01 BTC at 0.1% and 0.00999 BTC arrives. Reporting that as
 * a discrepancy would flag every ordinary position and teach the user to ignore the panel, which
 * costs more than the check is worth.
 *
 * 1% is roughly ten times the usual taker fee and far below any real divergence -- a coin sold
 * elsewhere, a withdrawal, an untracked fill -- which move the balance by a large fraction of
 * the position or all of it. */
const TOLERANCE_FRACTION = 0.01

export interface LedgerHolding {
  asset: string
  qty: number
  /** Every symbol contributing to it, so the report can point at the positions involved. */
  symbols: string[]
}

export interface LiveDiscrepancy {
  asset: string
  /** What the open positions add up to. */
  ledgerQty: number
  /** Free plus locked on the exchange -- funds in a resting order are still held. */
  exchangeQty: number
  /** How much of the ledger's claim the account does not back. Always positive. */
  shortfall: number
  symbols: string[]
}

export interface ReconcileResult {
  discrepancies: LiveDiscrepancy[]
  /** Assets the ledger claims but whose balance could not be read, so nothing can be said about
   * them either way. Reported rather than treated as agreeing -- an unchecked position must not
   * look like a checked one. */
  unchecked: string[]
}

/** What the open live positions claim, totalled per base asset.
 *
 * Per ASSET rather than per position, because that is the level a balance exists at. Two open
 * positions on BTCUSDT and BTCFDUSD are backed by one BTC balance, and checking either alone
 * against the whole of it would call a real shortfall fine. */
export function ledgerHoldings(positions: readonly LivePosition[]): LedgerHolding[] {
  const byAsset = new Map<string, LedgerHolding>()
  for (const position of positions) {
    if (position.closedAt !== null) continue
    if (!Number.isFinite(position.qty) || position.qty <= 0) continue
    const existing = byAsset.get(position.baseAsset)
    if (existing) {
      existing.qty += position.qty
      if (!existing.symbols.includes(position.symbol)) existing.symbols.push(position.symbol)
    } else {
      byAsset.set(position.baseAsset, { asset: position.baseAsset, qty: position.qty, symbols: [position.symbol] })
    }
  }
  return [...byAsset.values()].sort((a, b) => a.asset.localeCompare(b.asset))
}

/** Ledger against reality. Reports only what the account does not back.
 *
 * Holding MORE than the ledger claims is not reported, and that is not an oversight: a manual
 * buy, a deposit, staking rewards and a coin the app never traded all land there, and none of
 * them is a problem with the ledger. Only the short direction can misprice a position or make a
 * Close fail. */
export function reconcileLivePositions(
  positions: readonly LivePosition[],
  readout: BalanceReadout
): ReconcileResult {
  const discrepancies: LiveDiscrepancy[] = []
  const unchecked: string[] = []

  for (const holding of ledgerHoldings(positions)) {
    if (readout.unreadable.includes(holding.asset)) {
      unchecked.push(holding.asset)
      continue
    }
    const row = readout.rows.find((r) => r.asset === holding.asset)
    const exchangeQty = row ? row.free + row.locked : 0
    // A balance that is not a usable number cannot be compared. Reported as unchecked rather than
    // read as zero, which would announce a total shortfall on every position the app holds.
    if (!Number.isFinite(exchangeQty)) {
      unchecked.push(holding.asset)
      continue
    }
    const shortfall = holding.qty - exchangeQty
    if (shortfall <= holding.qty * TOLERANCE_FRACTION) continue
    discrepancies.push({
      asset: holding.asset,
      ledgerQty: holding.qty,
      exchangeQty,
      shortfall,
      symbols: holding.symbols
    })
  }

  return { discrepancies, unchecked }
}

/** One discrepancy, said plainly, including what it means for the buttons on the page. */
export function describeDiscrepancy(discrepancy: LiveDiscrepancy, exchangeLabel: string, i18n: I18n = ENGLISH): string {
  const { asset, ledgerQty, exchangeQty, symbols } = discrepancy
  const where = symbols.length === 1 ? symbols[0] : i18n.language === 'en' ? symbols.join(' and ') : i18n.list(symbols)
  return i18n.t(
    'This app tracks {ledger} {asset} open on {where}, but {exchange} reports {held} {asset} in the account. Closing here sells what the app tracks, so it would be rejected. The usual cause is selling or moving the {asset} on the exchange itself; this app cannot tell that apart from a fill it missed, so it will not adjust the record on its own.',
    { ledger: String(ledgerQty), asset, where, exchange: exchangeLabel, held: String(exchangeQty) }
  )
}

/** An order resting on the exchange, as the reconciliation reads it (GET /openOrders). */
export interface OpenOrderOnExchange {
  orderId: number | string
  symbol: string
  side: 'buy' | 'sell'
  status: string
  origQty: number
  executedQty: number
  price: number
  /** Seconds. */
  placedAt: number
}

/** What the main process's reconciliation last found (electron/services/liveReconcileService.ts;
 * the V5 document, S102), for Live Trading and Positions to show. */
export interface ReconciliationReadout {
  /** Seconds; null before the first look. */
  at: number | null
  /** Resting on the exchange with no record here. */
  unknownOrders: OpenOrderOnExchange[]
  /** Assets the ledger claims more of than the account holds. */
  discrepancies: LiveDiscrepancy[]
  /** Assets whose balance could not be read as a number. */
  unchecked: string[]
  /** Ledger orders the exchange no longer rested, resolved by the check since the app started. */
  resolvedByCheck: number
  /** Whether a key was stored at the last look: without one there is nothing to reconcile. */
  keyStored: boolean
  error: string | null
}

/** "07:45 UTC", in a language. */
const clockOf = (sec: number, i18n: I18n = ENGLISH): string => i18n.t('{time} UTC', { time: i18n.language === 'en' ? new Date(sec * 1000).toISOString().slice(11, 16) : i18n.utcTime(sec * 1000) })

/** The words for a resting order the ledger does not know: the notice's and the card's. */
export function describeUnknownOrder(order: OpenOrderOnExchange, exchangeLabel: string, i18n: I18n = ENGLISH): string {
  const values = { pair: order.symbol, qty: String(order.origQty), price: String(order.price), exchange: exchangeLabel, id: String(order.orderId), time: clockOf(order.placedAt, i18n) }
  return order.side === 'sell'
    ? i18n.t('{pair}: a SELL of {qty} at {price} is resting on {exchange} (order {id}, placed {time}), and this app has no record of it.', values)
    : i18n.t('{pair}: a BUY of {qty} at {price} is resting on {exchange} (order {id}, placed {time}), and this app has no record of it.', values)
}

/** One line for the reconciliation's state, and one for each thing it found, in a language. */
export function describeReconciliation(readout: ReconciliationReadout, exchangeLabel: string, i18n: I18n = ENGLISH): { line: string; tone: 'up' | 'down' | 'muted'; findings: string[] } {
  const { t } = i18n
  if (readout.at === null) return { line: t('Not checked yet: the first look comes within a minute of the start.'), tone: 'muted', findings: [] }
  if (!readout.keyStored) return { line: t('No {exchange} key is connected, so there is nothing to check.', { exchange: exchangeLabel }), tone: 'muted', findings: [] }
  if (readout.error !== null) return { line: t('Could not check at {time}: {error}', { time: clockOf(readout.at, i18n), error: readout.error }), tone: 'muted', findings: [] }
  const findings = [
    ...readout.unknownOrders.map((order) => describeUnknownOrder(order, exchangeLabel, i18n)),
    ...readout.discrepancies.map((discrepancy) => describeDiscrepancy(discrepancy, exchangeLabel, i18n))
  ]
  const resolved = readout.resolvedByCheck > 0 ? ` ${t('{count} orders the exchange no longer rested were resolved by the check.', { count: readout.resolvedByCheck })}` : ''
  if (findings.length === 0) {
    const unchecked =
      readout.unchecked.length > 0
        ? ` ${
            readout.unchecked.length === 1
              ? t('{assets} could not be read, so that holding was not checked.', { assets: readout.unchecked.join(', ') })
              : t('{assets} could not be read, so those holdings were not checked.', { assets: readout.unchecked.join(', ') })
          }`
        : ''
    return {
      line: `${t("Checked at {time}: the orders resting on {exchange} and the account's balances agree with the ledger.", { time: clockOf(readout.at, i18n), exchange: exchangeLabel })}${resolved}${unchecked}`,
      tone: 'up',
      findings: []
    }
  }
  return { line: `${t('Checked at {time}: {count} things the ledger does not agree with. Nothing was changed.', { time: clockOf(readout.at, i18n), count: findings.length })}${resolved}`, tone: 'down', findings }
}
