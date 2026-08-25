/** Reading a real perpetual-futures position, and saying what it means.
 *
 * The paper side of this app can already simulate leverage, liquidate a position and charge it
 * funding (shared/perp.ts). This is the other half: what the exchange says about a position that
 * really exists. It is READ-ONLY in the strongest sense available -- the module that fetches it
 * contains no order endpoint at all, so there is no code path from here to placing anything.
 *
 * The number worth reading it for is the liquidation price. A beginner who has opened a
 * leveraged position somewhere else has one whether they know it or not, and this app can at
 * least show them how close it is. */

export interface FuturesPosition {
  symbol: string
  /** Positive for a long, negative for a short. Never zero -- flat rows are dropped. */
  positionAmt: number
  entryPrice: number
  markPrice: number
  /** What the exchange itself says, not what shared/perp.ts would estimate. Null when the
   * exchange reports none, which it does for a position that cannot be liquidated. */
  liquidationPrice: number | null
  leverage: number
  unrealizedPnl: number
  /** 'isolated' risks only this position's margin; 'cross' risks the whole futures wallet, which
   * is a materially different thing to own and is never presented as the same. */
  marginType: 'isolated' | 'cross'
}

export interface FuturesReadout {
  positions: FuturesPosition[]
  /** Symbols the exchange reported in a form that could not be read as numbers. Surfaced rather
   * than dropped: a position that exists and cannot be displayed is the one thing worse than no
   * position list, because the user concludes they are flat. */
  unreadable: string[]
}

/** The raw shape of one Binance /fapi/v2/positionRisk row. Every numeric field arrives as a
 * decimal string. */
export interface RawFuturesPosition {
  symbol?: string
  positionAmt?: string
  entryPrice?: string
  markPrice?: string
  liquidationPrice?: string
  leverage?: string
  unRealizedProfit?: string
  marginType?: string
}

/** How far the price has to move from here to reach liquidation, as a percentage of the mark.
 *
 * The number that makes a position's danger legible. Signed positive throughout: it is a
 * distance, and "3% away" means the same urgent thing whichever side the position is on. Null
 * when there is no liquidation price to measure against, or when the mark is unusable. */
export function distanceToLiquidationPct(position: FuturesPosition): number | null {
  if (position.liquidationPrice === null) return null
  if (!(position.markPrice > 0)) return null
  const distance = (Math.abs(position.markPrice - position.liquidationPrice) / position.markPrice) * 100
  return Number.isFinite(distance) ? distance : null
}

/** Turns what the exchange sent into what can be shown, or into an admission that it could not be.
 *
 * Binance returns a row for every symbol the account has ever touched, almost all of them flat,
 * so the flat ones are dropped -- a list of two hundred zero-size positions hides the one real
 * one. Everything else that cannot be parsed is reported rather than coerced: a NaN silently
 * becoming 0 would draw a position with an entry price of zero and a liquidation price to match. */
export function readableFuturesPositions(rows: readonly RawFuturesPosition[]): FuturesReadout {
  const positions: FuturesPosition[] = []
  const unreadable: string[] = []

  for (const row of rows) {
    const symbol = typeof row.symbol === 'string' ? row.symbol : ''
    if (symbol === '') continue

    const positionAmt = Number(row.positionAmt)
    // Flat, and flat is not an error: it is the ordinary state of almost every row in the list.
    if (Number.isFinite(positionAmt) && positionAmt === 0) continue

    const entryPrice = Number(row.entryPrice)
    const markPrice = Number(row.markPrice)
    const leverage = Number(row.leverage)
    const unrealizedPnl = Number(row.unRealizedProfit)

    if (![positionAmt, entryPrice, markPrice, leverage, unrealizedPnl].every((n) => Number.isFinite(n))) {
      unreadable.push(symbol)
      continue
    }

    // Binance sends "0" for a position it will not liquidate rather than omitting the field, and
    // a zero here would be drawn as a liquidation at a price of nothing -- which reads as
    // infinitely far away, the exact opposite of what a zero usually warns about.
    const rawLiquidation = Number(row.liquidationPrice)
    const liquidationPrice = Number.isFinite(rawLiquidation) && rawLiquidation > 0 ? rawLiquidation : null

    positions.push({
      symbol,
      positionAmt,
      entryPrice,
      markPrice,
      liquidationPrice,
      leverage,
      unrealizedPnl,
      // Anything that is not explicitly isolated is treated as cross, because cross is the
      // answer that risks more: guessing "isolated" about a cross position would tell someone
      // only this position's margin is at stake when their whole futures wallet is.
      marginType: row.marginType === 'isolated' ? 'isolated' : 'cross'
    })
  }

  // Closest to liquidation first. The ordering is the warning: whatever is about to be taken
  // should not be below the fold.
  positions.sort((a, b) => {
    const da = distanceToLiquidationPct(a)
    const db = distanceToLiquidationPct(b)
    if (da === null && db === null) return a.symbol.localeCompare(b.symbol)
    if (da === null) return 1
    if (db === null) return -1
    return da - db
  })

  return { positions, unreadable }
}

/** What to tell someone about a position they are holding, in one sentence.
 *
 * Written for a person who has not met liquidation before, so it says what happens rather than
 * naming it: "closed for you, and the margin is gone" is the fact; "liquidation" is the jargon. */
export function describeFuturesPosition(position: FuturesPosition, quoteAsset = 'USDT'): string {
  const side = position.positionAmt > 0 ? 'long' : 'short'
  const distance = distanceToLiquidationPct(position)
  const base = `${position.leverage}x ${side}, entered at ${position.entryPrice}, now ${position.markPrice} (${position.unrealizedPnl >= 0 ? '+' : ''}${position.unrealizedPnl.toFixed(2)} ${quoteAsset}).`

  if (position.liquidationPrice === null || distance === null) {
    return `${base} This exchange reports no liquidation price for it.`
  }
  const scope =
    position.marginType === 'cross'
      ? 'Cross margin, so your whole futures wallet is backing it, not just this position.'
      : 'Isolated margin, so only the margin on this position is at stake.'
  return `${base} A ${distance.toFixed(2)}% move against it reaches ${position.liquidationPrice}, where the exchange closes it for you and that margin is gone. ${scope}`
}
