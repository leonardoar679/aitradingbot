import type { Candle } from './ipc'
import { expectedDirection, type ReadStory } from './newsFeed'

// "WHY DID IT MOVE?" (the second V3 document, §30): a pair's move set against Bitcoin's over the
// same minutes, its volume against its usual, and the news that names it -- and a label for how sure
// that is, by fixed rules:
// - KNOWN: Binance announced something about the coin in the window;
// - PROBABLE: a news story is about the coin, in the window, and nothing in it points the other way;
// - POSSIBLE: a story only mentions it, or the whole market moved with Bitcoin, or the volume is
//   several times its usual with no story found;
// - UNKNOWN: none of these.
//
// IT NEVER INVENTS A CAUSE. A cause named is a story found or a figure measured, and when none is
// found it says so. A model's reading of the same evidence is a separate, paid step that may only
// cite what is listed here.

export type CauseLabel = 'KNOWN' | 'PROBABLE' | 'POSSIBLE' | 'UNKNOWN'

export interface MoveCause {
  kind: 'news' | 'market' | 'volume'
  text: string
  /** 0 to 100. */
  relevance: number
  storyId?: string
  url?: string
}

export interface MoveExplanation {
  symbol: string
  windowMinutes: number
  movePct: number | null
  volumeRatio: number | null
  btcMovePct: number | null
  /** Bitcoin's move as a share of the pair's when they went the same way; 0 when they did not. */
  marketShare: number | null
  label: CauseLabel
  causes: MoveCause[]
  summary: string
}

/** How far back a story may be from the start of the window and still be its cause. */
const LEAD_SECONDS = 2 * 3600
/** A move smaller than this either way is not one to explain. */
export const NOTABLE_MOVE_PCT = 0.5
/** Bitcoin having made this share of the pair's move, the same way, is the market moving. */
const MARKET_SHARE = 0.5
/** Volume this many times its usual is a surge. */
const SURGE = 2

/** "+1.25%", "-0.40%", and nothing as "0.00%", never "-0.00%". */
const signed = (value: number): string => (Math.abs(value) < 0.005 ? '0.00%' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`)

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** The change over the last `minutes` of closed 1-minute bars, and the volume in them against the
 * mean of the same stretch over the three hours before. */
function windowOf(bars: Candle[], minutes: number, nowSec: number): { movePct: number | null; volumeRatio: number | null } {
  const closed = bars.filter((bar) => bar.time + 60 <= nowSec)
  if (closed.length <= minutes) return { movePct: null, volumeRatio: null }
  const last = closed[closed.length - 1]
  const from = closed[closed.length - 1 - minutes]
  const movePct = from.close > 0 ? (last.close / from.close - 1) * 100 : null
  const recent = closed.slice(-minutes).reduce((sum, bar) => sum + bar.volume, 0)
  const before = closed.slice(Math.max(0, closed.length - minutes - 180), closed.length - minutes)
  const stretches = before.length / minutes
  const usual = stretches >= 1 ? before.reduce((sum, bar) => sum + bar.volume, 0) / stretches : null
  return { movePct, volumeRatio: usual !== null && usual > 0 ? recent / usual : null }
}

/** Why a pair moved over the last `windowMinutes` (an hour unless said), from its minutes and
 * Bitcoin's, and the stories read. */
export function explainMove(input: {
  symbol: string
  ticker: string
  bars: Candle[]
  btcBars: Candle[]
  stories: readonly ReadStory[]
  windowMinutes?: number
  nowSec: number
}): MoveExplanation {
  const minutes = input.windowMinutes ?? 60
  const { movePct, volumeRatio } = windowOf(input.bars, minutes, input.nowSec)
  const btcMovePct = input.ticker === 'BTC' ? movePct : windowOf(input.btcBars, minutes, input.nowSec).movePct
  // Bitcoin's share of a move that is not one is not a share of anything.
  const notable = movePct !== null && Math.abs(movePct) >= NOTABLE_MOVE_PCT
  const marketShare =
    !notable || movePct === null || btcMovePct === null || input.ticker === 'BTC' ? null : Math.sign(movePct) === Math.sign(btcMovePct) ? Math.min(1, btcMovePct / movePct) : 0
  const windowStart = input.nowSec - minutes * 60
  const moveWay: 'up' | 'down' | null = movePct === null || movePct === 0 ? null : movePct > 0 ? 'up' : 'down'

  const causes: MoveCause[] = []
  const found = input.stories.filter(
    (story) => story.publishedAt >= windowStart - LEAD_SECONDS && story.publishedAt <= input.nowSec && story.assets.some((asset) => asset.ticker === input.ticker)
  )
  let known = false
  let probable = false
  let possible = false
  for (const story of found) {
    const relationship = story.assets.find((asset) => asset.ticker === input.ticker)?.relationship ?? 'INDIRECT'
    const direction = expectedDirection(story.eventType)
    const against = direction !== null && moveWay !== null && direction !== moveWay
    const relevance = Math.round(Math.min(100, story.impact * (relationship === 'DIRECT' ? 1 : 0.6) * (against ? 0.5 : 1) + (story.sourceClass === 'exchange' ? 10 : 0)))
    if (relationship === 'DIRECT' && story.sourceClass === 'exchange') known = true
    else if (relationship === 'DIRECT' && !against) probable = true
    else possible = true
    causes.push({
      kind: 'news',
      text: `${story.title} (${story.sourceName}${story.alsoIn.length > 0 ? ` and ${story.alsoIn.length} more` : ''}, ${utcClock(story.publishedAt)} UTC)${against ? ' — it would have moved it the other way' : ''}`,
      relevance,
      storyId: story.id,
      url: story.url
    })
  }
  if (marketShare !== null && marketShare >= MARKET_SHARE && btcMovePct !== null) {
    possible = true
    causes.push({ kind: 'market', text: `Bitcoin moved ${signed(btcMovePct)} over the same ${minutes} minutes: about ${Math.round(marketShare * 100)}% of this move.`, relevance: Math.round(marketShare * 80) })
  }
  if (volumeRatio !== null && volumeRatio >= SURGE) {
    if (found.length === 0) possible = true
    causes.push({ kind: 'volume', text: `Volume ${volumeRatio.toFixed(1)}× its usual over those minutes.`, relevance: Math.round(Math.min(70, 20 * volumeRatio)) })
  }
  causes.sort((a, b) => b.relevance - a.relevance)

  const what =
    movePct === null
      ? `${input.symbol}'s last ${minutes} minutes could not be read.`
      : `${input.symbol} moved ${signed(movePct)} in ${minutes} minutes${volumeRatio === null ? '' : ` on ${volumeRatio.toFixed(1)}× its usual volume`}.`
  // A move too small to be one, or one that could not be read, has nothing to explain: what was
  // found is still listed, and no cause is named.
  if (movePct === null || Math.abs(movePct) < NOTABLE_MOVE_PCT) {
    const quiet = movePct === null ? '' : ` That is under ${NOTABLE_MOVE_PCT}% either way: not a move to explain.`
    return { symbol: input.symbol, windowMinutes: minutes, movePct, volumeRatio, btcMovePct, marketShare, label: 'UNKNOWN', causes, summary: `${what}${quiet}` }
  }

  const label: CauseLabel = known ? 'KNOWN' : probable ? 'PROBABLE' : possible ? 'POSSIBLE' : 'UNKNOWN'
  // The cause named is the one the label rests on: a story for KNOWN and PROBABLE, the strongest
  // of what was found for POSSIBLE. Bitcoin's share, where it made most of the move, is said too.
  const named = label === 'KNOWN' || label === 'PROBABLE' ? causes.find((cause) => cause.kind === 'news') : causes[0]
  const market = causes.find((cause) => cause.kind === 'market')
  const why =
    label === 'UNKNOWN' || named === undefined
      ? `No cause found: no story names ${input.ticker} in the last ${minutes / 60 + LEAD_SECONDS / 3600} hours${btcMovePct === null ? '' : `, and Bitcoin moved ${signed(btcMovePct)}`}.`
      : `${label === 'KNOWN' ? 'Known cause' : label === 'PROBABLE' ? 'Probable cause' : 'Possible cause'}: ${named.text}${/[.!?]$/.test(named.text) ? '' : '.'}${market !== undefined && market !== named ? ` ${market.text}` : ''}`
  return { symbol: input.symbol, windowMinutes: minutes, movePct, volumeRatio, btcMovePct, marketShare, label, causes, summary: `${what} ${why}` }
}
