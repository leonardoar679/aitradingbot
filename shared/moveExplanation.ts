import type { Candle } from './ipc'
import { expectedDirection, type ReadStory } from './newsFeed'
import { ENGLISH, msg, type I18n } from './i18n/translate'

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

/** What part a cause played (the V4 document, §25; since 8 October 2026), beside the label:
 * - PRIMARY CATALYST: a story that names the coin directly, published before the move began, at
 *   a relevance of 70 or more;
 * - SECONDARY: a story before the move that names it directly or reads at 40 or more; a volume
 *   surge, which confirms a move and does not cause it;
 * - MARKET AMPLIFIER: Bitcoin having made half or more of the move, the same way;
 * - UNRELATED: a story published after the move began, which cannot have caused it;
 * - UNKNOWN: a story that only mentions the coin, faintly. */
export type CauseRole = 'PRIMARY CATALYST' | 'SECONDARY' | 'MARKET AMPLIFIER' | 'UNRELATED' | 'UNKNOWN'

/** Each label and role as the window shows it, in a language (V6 Stage 14). */
export const LABEL_WORDS: Record<CauseLabel, string> = { KNOWN: msg('KNOWN'), PROBABLE: msg('PROBABLE'), POSSIBLE: msg('POSSIBLE'), UNKNOWN: msg('UNKNOWN') }
export const ROLE_WORDS: Record<CauseRole, string> = {
  'PRIMARY CATALYST': msg('PRIMARY CATALYST'),
  SECONDARY: msg('SECONDARY'),
  'MARKET AMPLIFIER': msg('MARKET AMPLIFIER'),
  UNRELATED: msg('UNRELATED'),
  UNKNOWN: msg('UNKNOWN@@a role')
}

export interface MoveCause {
  kind: 'news' | 'market' | 'volume'
  text: string
  /** 0 to 100. */
  relevance: number
  role: CauseRole
  storyId?: string
  url?: string
}

/** One thing that happened, in the order it did: what is shown as the timeline. */
export interface MoveTimelineEntry {
  at: number
  kind: 'story' | 'volume' | 'price' | 'market' | 'reading'
  text: string
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
  /** The minute the move began: where it had come half its way, the same way. Null for no move. */
  moveStartAt: number | null
  /** In the order things happened (since 8 October 2026). */
  timeline: MoveTimelineEntry[]
}

/** How far back a story may be from the start of the window and still be its cause. */
const LEAD_SECONDS = 2 * 3600
/** A move smaller than this either way is not one to explain. */
export const NOTABLE_MOVE_PCT = 0.5
/** Bitcoin having made this share of the pair's move, the same way, is the market moving. */
const MARKET_SHARE = 0.5
/** Volume this many times its usual is a surge. */
const SURGE = 2
/** A direct story at this relevance or more, before the move, is its primary catalyst. */
const PRIMARY_RELEVANCE = 70
/** A story before the move at this relevance or more is secondary, where it is not direct. */
const SECONDARY_RELEVANCE = 40

/** "+1.25%", "-0.40%", and nothing as "0.00%", never "-0.00%". */
const signed = (value: number): string => (Math.abs(value) < 0.005 ? '0.00%' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`)

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** The change over the last `minutes` of closed 1-minute bars, and the volume in them against the
 * mean of the same stretch over the three hours before. */
interface MoveWindow {
  movePct: number | null
  volumeRatio: number | null
  /** The first minute of the window at whose close the move had come half its way, the same way. */
  moveStartAt: number | null
  /** The minute of the window with the most volume, and that against the usual minute's. */
  volumePeak: { at: number; ratio: number } | null
}

function windowOf(bars: Candle[], minutes: number, nowSec: number): MoveWindow {
  const closed = bars.filter((bar) => bar.time + 60 <= nowSec)
  if (closed.length <= minutes) return { movePct: null, volumeRatio: null, moveStartAt: null, volumePeak: null }
  const last = closed[closed.length - 1]
  const from = closed[closed.length - 1 - minutes]
  const movePct = from.close > 0 ? (last.close / from.close - 1) * 100 : null
  const span = closed.slice(-minutes)
  const recent = span.reduce((sum, bar) => sum + bar.volume, 0)
  const before = closed.slice(Math.max(0, closed.length - minutes - 180), closed.length - minutes)
  const stretches = before.length / minutes
  const usual = stretches >= 1 ? before.reduce((sum, bar) => sum + bar.volume, 0) / stretches : null
  let moveStartAt: number | null = null
  if (movePct !== null && movePct !== 0) {
    const half = from.close * (1 + movePct / 200)
    moveStartAt = span.find((bar) => (movePct > 0 ? bar.close >= half : bar.close <= half))?.time ?? null
  }
  let volumePeak: MoveWindow['volumePeak'] = null
  if (usual !== null && usual > 0) {
    const peak = span.reduce((best, bar) => (bar.volume > best.volume ? bar : best), span[0])
    volumePeak = { at: peak.time, ratio: peak.volume / (usual / minutes) }
  }
  return { movePct, volumeRatio: usual !== null && usual > 0 ? recent / usual : null, moveStartAt, volumePeak }
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
  /** The analyst's conclusion on file, for the timeline; null or absent for none. */
  reading?: { at: number; text: string } | null
  /** The language its sentences are in (V6 Stage 14): English, as a model is shown them, unless the
   * window hands the person's. Its labels and figures are the same in every one. */
  i18n?: I18n
}): MoveExplanation {
  const i18n = input.i18n ?? ENGLISH
  const { t, num, utcTime } = i18n
  const signedIn = (value: number): string => (i18n.language === 'en' ? signed(value) : Math.abs(value) < 0.005 ? i18n.pct(0, 2) : i18n.pct(value, 2))
  const clock = (sec: number): string => (i18n.language === 'en' ? utcClock(sec) : utcTime(sec * 1000))
  const minutes = input.windowMinutes ?? 60
  const { movePct, volumeRatio, moveStartAt, volumePeak } = windowOf(input.bars, minutes, input.nowSec)
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
  const timeline: MoveTimelineEntry[] = []
  for (const story of found) {
    const relationship = story.assets.find((asset) => asset.ticker === input.ticker)?.relationship ?? 'INDIRECT'
    const direction = expectedDirection(story.eventType)
    const against = direction !== null && moveWay !== null && direction !== moveWay
    const relevance = Math.round(Math.min(100, story.impact * (relationship === 'DIRECT' ? 1 : 0.6) * (against ? 0.5 : 1) + (story.sourceClass === 'exchange' ? 10 : 0)))
    // A story published after the move began cannot have caused it: listed, and named as such,
    // and no label rests on it.
    const late = moveStartAt !== null && story.publishedAt > moveStartAt
    const role: CauseRole = late
      ? 'UNRELATED'
      : relationship === 'DIRECT' && relevance >= PRIMARY_RELEVANCE
        ? 'PRIMARY CATALYST'
        : relationship === 'DIRECT' || relevance >= SECONDARY_RELEVANCE
          ? 'SECONDARY'
          : 'UNKNOWN'
    if (late) possible = true
    else if (relationship === 'DIRECT' && story.sourceClass === 'exchange') known = true
    else if (relationship === 'DIRECT' && !against) probable = true
    else possible = true
    const source = story.alsoIn.length > 0 ? t('{source} and {count} more', { source: story.sourceName, count: story.alsoIn.length }) : story.sourceName
    const told = t('{title} ({source}, {time} UTC)', { title: story.title, source, time: clock(story.publishedAt) })
    causes.push({
      kind: 'news',
      text: `${told}${against ? t(' — it would have moved it the other way') : ''}${late ? t(' — published after the move began') : ''}`,
      relevance,
      role,
      storyId: story.id,
      url: story.url
    })
    timeline.push({ at: story.publishedAt, kind: 'story', text: t('{title} ({source}): {role}.', { title: story.title, source: story.sourceName, role: i18n.language === 'en' ? role.toLowerCase() : t(ROLE_WORDS[role]) }) })
  }
  if (marketShare !== null && marketShare >= MARKET_SHARE && btcMovePct !== null) {
    possible = true
    causes.push({
      kind: 'market',
      text: t('Bitcoin moved {move} over the same {minutes} minutes: about {share} of this move.', { move: signedIn(btcMovePct), minutes, share: i18n.pctPlain(Math.round(marketShare * 100), 0) }),
      relevance: Math.round(marketShare * 80),
      role: 'MARKET AMPLIFIER'
    })
  }
  if (volumeRatio !== null && volumeRatio >= SURGE) {
    if (found.length === 0) possible = true
    causes.push({ kind: 'volume', text: t('Volume {ratio}× its usual over those minutes.', { ratio: num(volumeRatio, 1, 1) }), relevance: Math.round(Math.min(70, 20 * volumeRatio)), role: 'SECONDARY' })
  }
  causes.sort((a, b) => b.relevance - a.relevance)
  // The rest of the timeline: the market's move over the window, the volume's peak, the move
  // beginning, and the analyst's reading where there is one.
  if (btcMovePct !== null && input.ticker !== 'BTC') timeline.push({ at: windowStart, kind: 'market', text: t('Bitcoin {move} over the same {minutes} minutes.', { move: signedIn(btcMovePct), minutes }) })
  if (volumePeak !== null && volumePeak.ratio >= SURGE) timeline.push({ at: volumePeak.at, kind: 'volume', text: t('Volume peaks at {ratio}× its usual minute.', { ratio: num(volumePeak.ratio, 1, 1) }) })
  if (moveStartAt !== null && movePct !== null && Math.abs(movePct) >= NOTABLE_MOVE_PCT) timeline.push({ at: moveStartAt, kind: 'price', text: t('The move is half made: {move} by {time} UTC.', { move: signedIn(movePct), time: clock(input.nowSec) }) })
  if (input.reading !== undefined && input.reading !== null) timeline.push({ at: input.reading.at, kind: 'reading', text: t('The analyst: {words}', { words: input.reading.text }) })
  timeline.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind))

  const what =
    movePct === null
      ? t("{pair}'s last {minutes} minutes could not be read.", { pair: input.symbol, minutes })
      : volumeRatio === null
        ? t('{pair} moved {move} in {minutes} minutes.', { pair: input.symbol, move: signedIn(movePct), minutes })
        : t('{pair} moved {move} in {minutes} minutes on {ratio}× its usual volume.', { pair: input.symbol, move: signedIn(movePct), minutes, ratio: num(volumeRatio, 1, 1) })
  // A move too small to be one, or one that could not be read, has nothing to explain: what was
  // found is still listed, and no cause is named.
  if (movePct === null || Math.abs(movePct) < NOTABLE_MOVE_PCT) {
    const quiet = movePct === null ? '' : ` ${t('That is under {line} either way: not a move to explain.', { line: i18n.share(NOTABLE_MOVE_PCT) })}`
    return { symbol: input.symbol, windowMinutes: minutes, movePct, volumeRatio, btcMovePct, marketShare, label: 'UNKNOWN', causes, summary: `${what}${quiet}`, moveStartAt, timeline }
  }

  const label: CauseLabel = known ? 'KNOWN' : probable ? 'PROBABLE' : possible ? 'POSSIBLE' : 'UNKNOWN'
  // The cause named is the one the label rests on: a story for KNOWN and PROBABLE, the strongest
  // of what was found for POSSIBLE. Bitcoin's share, where it made most of the move, is said too.
  const named = label === 'KNOWN' || label === 'PROBABLE' ? causes.find((cause) => cause.kind === 'news') : causes[0]
  const market = causes.find((cause) => cause.kind === 'market')
  const hours = minutes / 60 + LEAD_SECONDS / 3600
  const which = label === 'KNOWN' ? t('Known cause') : label === 'PROBABLE' ? t('Probable cause') : t('Possible cause')
  const why =
    label === 'UNKNOWN' || named === undefined
      ? btcMovePct === null
        ? t('No cause found: no story names {coin} in the last {hours} hours.', { coin: input.ticker, hours })
        : t('No cause found: no story names {coin} in the last {hours} hours, and Bitcoin moved {move}.', { coin: input.ticker, hours, move: signedIn(btcMovePct) })
      : `${t('{which}: {cause}', { which, cause: named.text })}${/[.!?。！？।؟]$/.test(named.text) ? '' : t('.@@end of a sentence')}${market !== undefined && market !== named ? ` ${market.text}` : ''}`
  return { symbol: input.symbol, windowMinutes: minutes, movePct, volumeRatio, btcMovePct, marketShare, label, causes, summary: `${what} ${why}`, moveStartAt, timeline }
}
