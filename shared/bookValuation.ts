import type { ExecutorConfig } from './ipc'
import { assumedFundingAgainst, newsBookOpenNetOf } from './newsBook'
import { PERP_FEES } from './venueCosts'

// WHAT A BOOK'S OPEN TRADES STAND AT (V8 Stage 9, 27 October 2026). A book's equity is its settled equity plus its open
// trades' results now (shared/paperBooks.ts), and its daily stop and drawdown read it; until Stage 9 nothing valued an
// open trade, so a book with one open had no equity. Each of the books' writers keeps its trade's own fills on its
// stamp -- a follow's legs, a clone's entry, a news short's -- so an open trade is valued from its stamp and one price:
// its move on its size, what it has already realized, its fees with the exit's at that price, and funding assumed
// against it for each funding time crossed (the published rates are read when it closes). Pure: the main process reads
// the prices (electron/services/booksService.ts).

/** The price an open book trade is valued at: its perpetual's last price, or a spot pair's. */
export type BookPriceRef = { kind: 'perp'; venue: 'binance' | 'bitget'; symbol: string } | { kind: 'spot'; venue: 'binance'; symbol: string }

export const priceRefKey = (ref: BookPriceRef): string => `${ref.kind}:${ref.venue}:${ref.symbol}`

/** Where a book trade's price is read, or null for a trade the books do not value. */
export function bookPriceRefOf(executor: ExecutorConfig): BookPriceRef | null {
  if (executor.follow !== undefined) return { kind: 'perp', venue: executor.follow.venue, symbol: executor.follow.symbol }
  if (executor.clone !== undefined) return { kind: 'perp', venue: executor.clone.venue, symbol: executor.clone.symbol }
  if (executor.newsBook !== undefined) return { kind: 'perp', venue: executor.newsBook.venue, symbol: executor.newsBook.symbol }
  return null
}

/** An open book trade's result were it closed now at `px`, in the quote; null for a trade the books do not value. */
export function bookOpenNetOf(executor: ExecutorConfig, px: number, nowMs: number): number | null {
  if (!(px > 0)) return null
  const follow = executor.follow
  if (follow !== undefined) {
    const sign = follow.side === 'long' ? 1 : -1
    const exitFee = (PERP_FEES[follow.venue].takerPct / 100) * follow.size * px
    return follow.realizedQuote - follow.feesQuote - exitFee + sign * (px - follow.avgPx) * follow.size + assumedFundingAgainst(follow.maxStakeQuote, follow.openedAtMs, nowMs)
  }
  const clone = executor.clone
  if (clone !== undefined) {
    const sign = clone.side === 'long' ? 1 : -1
    const exitFee = (PERP_FEES[clone.venue].takerPct / 100) * clone.qty * px
    return sign * (px - clone.entryPx) * clone.qty - clone.feesQuote - exitFee + assumedFundingAgainst(clone.stakeQuote, clone.openedAtMs, nowMs)
  }
  if (executor.newsBook !== undefined) return newsBookOpenNetOf(executor.newsBook, px, nowMs)
  return null
}
