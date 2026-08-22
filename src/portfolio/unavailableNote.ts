/** Wording for the parts of a portfolio snapshot that failed rather than being excluded on
 * purpose. The currency exclusion note next to this one already explains non-dollar holdings;
 * this one explains numbers that are wrong because something broke, which previously showed no
 * difference at all from numbers that were simply small. */
export function describeUnavailable(unavailable: {
  unpricedPositions: number
  failedExecutors: number
  failedBots: number
}): string | null {
  const { unpricedPositions, failedExecutors, failedBots } = unavailable
  const parts: string[] = []

  if (unpricedPositions > 0) {
    parts.push(
      `${unpricedPositions} position${unpricedPositions === 1 ? '' : 's'} could not be priced, so ${unpricedPositions === 1 ? 'it is' : 'they are'} missing from Total Value`
    )
  }
  if (failedExecutors > 0) {
    parts.push(`${failedExecutors} paper executor${failedExecutors === 1 ? '' : 's'} could not be read`)
  }
  if (failedBots > 0) {
    parts.push(`${failedBots} bot${failedBots === 1 ? '' : 's'} could not be included in Bot P&L`)
  }

  if (parts.length === 0) return null
  return `${parts.join('; ')}. This is a temporary fetch problem, not a change in what you hold — retrying automatically.`
}
