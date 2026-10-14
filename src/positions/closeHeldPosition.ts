import { netUnrealizedPct } from '../../shared/fees'
import type { HeldPosition } from '../../shared/ipc'
import { ENGLISH, type I18n } from '../../shared/i18n/translate'

/** What closing a position held in Inventory puts back into the cash balance.
 *
 * Closing one used to return nothing at all. The cash had already left the balance when the
 * position was handed over -- `settleExecutorOnStop` books `-amountQuote`, because that money is
 * now the position and Portfolio values the Inventory row on its own. Closing the row deleted it
 * and stopped there, so the whole position, stake and profit together, simply stopped existing:
 * measured in the running app, a 1,000 USDT position showing +1.09% went from a 10,000 total to
 * 9,000 in cash with nothing to show for it, and no error anywhere.
 *
 * The figure returned is the position marked at the current price, net of fees -- the same
 * arithmetic behind the percentage the row displays, so the money that arrives is the money the
 * user was just looking at. Never below zero: a spot holding cannot be worth less than nothing,
 * which is the same floor Portfolio uses when it values the row. */
export function heldPositionCloseValue(position: HeldPosition, markPrice: number | null): number | null {
  if (markPrice === null || !Number.isFinite(markPrice) || markPrice <= 0) return null
  if (!(position.entryPrice > 0) || !Number.isFinite(position.amountQuote) || position.amountQuote < 0) return null
  const pct = netUnrealizedPct(position.entryPrice, markPrice, position.side)
  if (!Number.isFinite(pct)) return null
  return Math.max(position.amountQuote * (1 + pct / 100), 0)
}

/** Why this position cannot be closed right now, or null if it can be.
 *
 * An unpriced position is refused rather than closed. Closing has to credit what it is worth, and
 * without a price there is no honest figure -- the old behaviour discarded the row regardless,
 * which is exactly how the money went missing. */
export function describeHeldCloseBlock(position: HeldPosition, markPrice: number | null, { t }: I18n = ENGLISH): string | null {
  if (heldPositionCloseValue(position, markPrice) !== null) return null
  if (markPrice === null || !Number.isFinite(markPrice) || markPrice <= 0) {
    return t('No current price for {pair}, so there is no honest figure to pay back. Closing is blocked until a price arrives.', { pair: position.symbol })
  }
  return t('This position is missing the entry price or size needed to value it, so it cannot be closed safely. Nothing has been changed.')
}

/** The confirmation label, which names the amount rather than asking for a blind confirmation.
 * "Confirm discard?" was both frightening and wrong: it does not discard, it sells. */
export function describeHeldCloseConfirm(position: HeldPosition, markPrice: number | null, { t, num }: I18n = ENGLISH): string {
  const value = heldPositionCloseValue(position, markPrice)
  if (value === null) return t('Cannot close')
  return t('Close for {amount} {asset}?', { amount: num(value, 2, 2), asset: position.quoteAsset })
}
