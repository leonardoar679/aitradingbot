import type { PortfolioSnapshotData } from '../portfolio/computePortfolioSnapshot'

type Valued = Pick<PortfolioSnapshotData, 'totalValue' | 'costOutsideQuote' | 'hasPaperAccount'>

function formatUsd(value: number): string {
  const sign = value < 0 ? '-' : ''
  return `${sign}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const signed = (value: number): string => `${value >= 0 ? '+' : ''}${formatUsd(value)}`

/** What the positions in a snapshot have made, rather than what was put into them: its total less
 * what its positions cost from outside it (computePortfolioSnapshot's costOutsideQuote). */
export function madeIn(snapshot: Valued): number {
  return snapshot.totalValue - snapshot.costOutsideQuote
}

/** Overview's "Portfolio value": the total, and how it has done.
 *
 * WITH A PAPER ACCOUNT the total is the account's: its cash and what its strategies hold. Its change
 * since the first snapshot of the session is what the session made, less the stake of any position
 * opened with money from outside it (a real one), which is money moved, not made.
 *
 * WITHOUT ONE the total is only what the open positions are worth, and a position opening adds its
 * whole stake to it: the first paper trade the watch opened read "+$54.20 this session" on an
 * account that had made nothing. So it says what the positions are worth and what they are up or
 * down, and nothing about a session. What closed trades made is on Performance. */
export function portfolioValueLine(first: Valued | null, latest: Valued): string {
  if (!latest.hasPaperAccount) {
    return `${formatUsd(latest.totalValue)} in open positions${latest.costOutsideQuote > 0 ? `, ${signed(madeIn(latest))} on them` : ''}`
  }
  if (first === null || first === latest) return formatUsd(latest.totalValue)
  return `${formatUsd(latest.totalValue)}, ${signed(madeIn(latest) - madeIn(first))} this session`
}
