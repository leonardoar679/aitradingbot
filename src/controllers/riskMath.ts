/** Drawdown of a controller's session, as a percentage of the capital behind it.
 *
 * It used to be measured as a fraction of peak P&L -- `(peak - current) / peak` -- which is the
 * one denominator the surrounding function's own comment rules out, on the grounds that "P&L has
 * no natural zero-point to take a percentage of". That broke in both directions at once:
 *
 *   peak $1  -> now $0     reported 100%  and stopped every attached executor
 *   peak -$10 -> now -$400  reported   0%  and never fired at all
 *
 * The first is a tenth of a percent of $1000 of capital treated as a total loss. The second is
 * 40% of that capital gone while the control sat silent, because `peak > 0` is false for a
 * controller that has never been in profit -- precisely when a max-drawdown limit matters most.
 *
 * Measured against peak EQUITY instead (capital plus peak P&L), which is the ordinary definition
 * and is stable regardless of how small or negative the P&L is. Starting equity counts as a peak,
 * so a controller that only ever loses still has a drawdown from where it began. */
export function controllerDrawdownPct(
  pnlHistory: number[],
  currentPnlQuote: number,
  allocatedQuote: number
): number {
  const peakPnl = pnlHistory.reduce((max, pnl) => Math.max(max, pnl), Math.max(0, currentPnlQuote))
  const peakEquity = allocatedQuote + peakPnl
  if (!(peakEquity > 0)) return 0
  // No clamp at zero: peakPnl is built as max(0, current, ...history), so it is never below
  // current and the difference is never negative. A Math.max(0, ...) here survived every test
  // because nothing can reach it.
  return ((peakPnl - currentPnlQuote) / peakEquity) * 100
}
