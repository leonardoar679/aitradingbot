/** What to tell the user when the Market header has no price to show.
 *
 * The header subscribes to one ticker websocket. When that subscription fails, every stat in the
 * row renders an em dash -- and the chart directly below it keeps drawing a live, ticking price
 * for the same symbol, because candles come over a different stream. Two panels on one screen
 * disagreeing, with nothing saying which one to believe, is worse than either failing alone: a
 * newbie reads the moving chart as proof the app is fine and then cannot tell whether "--" means
 * loading, zero, or broken.
 *
 * `hasTicker` is false only while there is genuinely nothing to show. Once a price has arrived
 * from either the socket or the REST fallback, a later failure keeps the last known figures
 * rather than blanking them -- same call `useLastPrice` makes for position rows. */
export function describeTickerProblem({
  hasTicker,
  lastError,
  symbol
}: {
  hasTicker: boolean
  lastError: string | null
  symbol: string
}): string | null {
  if (hasTicker) return null
  if (lastError === null) return null
  return `Live price for ${symbol} is unavailable (${lastError}). The chart below uses a separate connection and may keep updating, so ignore it for the current price. Retrying automatically.`
}
