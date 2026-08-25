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
export function describeDiscrepancy(discrepancy: LiveDiscrepancy, exchangeLabel: string): string {
  const { asset, ledgerQty, exchangeQty, symbols } = discrepancy
  const where = symbols.length === 1 ? symbols[0] : symbols.join(' and ')
  return (
    `This app tracks ${ledgerQty} ${asset} open on ${where}, but ${exchangeLabel} reports ${exchangeQty} ${asset} in the account. ` +
    `Closing here sells what the app tracks, so it would be rejected. The usual cause is selling or moving the ${asset} on the exchange itself; ` +
    `this app cannot tell that apart from a fill it missed, so it will not adjust the record on its own.`
  )
}
