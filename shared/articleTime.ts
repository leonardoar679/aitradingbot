import type { TimeCandidate, TimeSource } from './articleExtract'

// WHEN A PASTED ARTICLE WAS PUBLISHED (V8 Stage 4, 26 October 2026). Every price figure the News URLs page shows is
// measured from the article's publication, so its time is read with care: from the page's structured data first,
// then its Open Graph tags, then a dated byline, then any other meta tag -- never the server's Last-Modified, which
// says when a file changed -- every candidate kept with where it was read; a time after the page was read refused;
// candidates more than an hour apart said to disagree; and where Binance's own list or the news feed holds the same
// story, its time is the check, and a Binance announcement's release is the time itself. A post on X is never fetched:
// its time is in its id. Arithmetic on what it is handed.

export const ARTICLE_TIME_VERSION = 'article-time-v1'

export const ARTICLE_TIME_LINES = {
  version: ARTICLE_TIME_VERSION,
  /** A candidate this far after the page was read is in the future, and refused. */
  futureToleranceSec: 300,
  /** Candidates, or a candidate and the check, further apart than this disagree. */
  disagreeSec: 3600
} as const

/** The order the page's candidates are read in. */
export const TIME_PRECEDENCE: readonly TimeSource[] = ['jsonld', 'og', 'byline', 'meta']

export interface PublicationTime {
  /** Unix seconds; null where no time could be read. */
  sec: number | null
  source: TimeSource | 'announcement' | 'x-id' | 'feed' | null
  field: string | null
  candidates: TimeCandidate[]
  /** Candidates after the page was read, refused. */
  future: TimeCandidate[]
  /** The read candidates are more than an hour apart. */
  disagree: boolean
  /** Binance's list's or the feed's own time for the same story, and whether the time read agrees with it. */
  check: { source: 'announcement' | 'feed'; sec: number; agrees: boolean } | null
}

/** The article's publication time from the page's candidates and the check where one is held. A Binance
 * announcement's release in Binance's own list is the time itself; the feed's time is used only where the page gives
 * none. */
export function publicationTimeOf(input: {
  candidates: readonly TimeCandidate[]
  readAt: number
  check?: { source: 'announcement' | 'feed'; sec: number } | null
}): PublicationTime {
  const lines = ARTICLE_TIME_LINES
  const read = input.candidates.filter((candidate) => candidate.sec !== null)
  const future = read.filter((candidate) => (candidate.sec as number) > input.readAt + lines.futureToleranceSec)
  const valid = read.filter((candidate) => (candidate.sec as number) <= input.readAt + lines.futureToleranceSec)
  const secs = valid.map((candidate) => candidate.sec as number)
  const disagree = secs.length > 1 && Math.max(...secs) - Math.min(...secs) > lines.disagreeSec
  const chosen = TIME_PRECEDENCE.map((source) => valid.find((candidate) => candidate.source === source)).find((candidate) => candidate !== undefined) ?? null
  const check = input.check ?? null
  const base = { candidates: [...input.candidates], future, disagree }
  if (check !== null && check.source === 'announcement') {
    const agrees = chosen === null || Math.abs((chosen.sec as number) - check.sec) <= lines.disagreeSec
    return { ...base, sec: check.sec, source: 'announcement', field: 'releaseDate', check: { ...check, agrees } }
  }
  if (chosen === null) {
    return check === null ? { ...base, sec: null, source: null, field: null, check: null } : { ...base, sec: check.sec, source: 'feed', field: 'publishedAt', check: { ...check, agrees: true } }
  }
  return {
    ...base,
    sec: chosen.sec,
    source: chosen.source,
    field: chosen.field,
    check: check === null ? null : { ...check, agrees: Math.abs((chosen.sec as number) - check.sec) <= lines.disagreeSec }
  }
}

/** X's ids carry their moment: the milliseconds since X's epoch in the bits above the 22nd. */
const X_EPOCH_MS = 1_288_834_974_657n
const X_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com'])

/** A post on X, from its link alone: its author's handle, its id and its moment. Null for any other link. */
export function xPostOf(url: string): { handle: string; id: string; sec: number } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (!X_HOSTS.has(parsed.hostname.toLowerCase())) return null
  const match = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{6,25})(?:\/|$)/.exec(parsed.pathname)
  if (match === null) return null
  const ms = (BigInt(match[2]) >> 22n) + X_EPOCH_MS
  return { handle: match[1], id: match[2], sec: Number(ms / 1000n) }
}
