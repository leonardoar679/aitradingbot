import type { AlertSettings, Candle } from './ipc'
import { SAME_STORY_SECONDS, describeEventType, titleSimilarity, type ReactionVerdict, type ReadStory, type SourceClass, type StoryReaction } from './newsFeed'

// THE APP'S DESKTOP NOTICES: WHETHER THEY ARE RAISED AT ALL, WITH SOUND, AND HOW LOUD EACH IS.
//
// Everything that tells the desktop something -- a call from the watch, a paper trade opened or
// paused, the daily digest, an announcement about a coin held -- goes through one main-process
// handler (the main process's appHandlers.ts), and that handler reads this setting before it
// shows anything. Since 6 October 2026 it is one of the six controls at the top of Settings, as the
// V3 document asks ("Notifications: Enabled"). On, with sound, until it is changed.
//
// NEWS AND THE MARKET HAVE A SEVERITY (the document's §28-29), by fixed rules:
// - CRITICAL: a hack or a delisting of a coin you hold, or Bitcoin down 5% within an hour;
// - HIGH: a story of impact 70 or more (shared/newsFeed.ts), or one the price has confirmed;
// - WATCH: impact 45 or more;
// - INFO: the rest, and anything old.
// INFO is shown on its page only; WATCH raises a silent notice; HIGH and CRITICAL a notice with
// sound, where sound is on; CRITICAL also stays as a banner until it is dismissed.
//
// THE SAME NEWS IS NOT TOLD TWICE AT WATCH. Outlets tell the same news in their own words, hours
// apart, and a story is folded into another only when their titles are close: in a twelve-hour run of
// the app on 6 October 2026 one Zcash ETF filing raised three notices, from The Block, Decrypt and
// Cointelegraph, over four hours. So a WATCH notice is held back when a story told or held back in the
// last NOTICE_REPEAT_SECONDS named a coin it names and has a title at least SAME_NEWS_SIMILARITY
// alike. Other news about the same coin is told. The story is still kept on its page, and HIGH and
// CRITICAL are always told.

export const DEFAULT_ALERTS: AlertSettings = { enabled: true, sound: true }

/** A stored setting, read as one: settings.json is written by the renderer, so it is healed rather
 * than obeyed. Only `false` switches either off. */
export function healAlerts(value: unknown): AlertSettings {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Partial<Record<keyof AlertSettings, unknown>>
  return { enabled: raw.enabled !== false, sound: raw.sound !== false }
}

export type AlertSeverity = 'info' | 'watch' | 'high' | 'critical'

export const HIGH_IMPACT = 70
export const WATCH_IMPACT = 45
/** Bitcoin down this far within the last hour is a crash. */
export const BTC_CRASH_PCT = -5

/** A story's severity, given the coins held. */
export function storySeverity(story: Pick<ReadStory, 'impact' | 'eventType' | 'assets' | 'stale'> & Partial<Pick<ReadStory, 'repeat'>>, held: ReadonlySet<string>, reaction: ReactionVerdict | null = null): AlertSeverity {
  if (story.stale) return 'info'
  // Recycled news (shared/newsFeed.ts, since 8 October 2026) was told once already: never HIGH.
  if (story.repeat === true) return story.impact >= WATCH_IMPACT ? 'watch' : 'info'
  const heldDirect = story.assets.some((asset) => asset.relationship === 'DIRECT' && held.has(asset.ticker))
  if (heldDirect && (story.eventType === 'HACK' || story.eventType === 'DELISTING')) return 'critical'
  if (story.impact >= HIGH_IMPACT || reaction === 'CONFIRMED') return 'high'
  return story.impact >= WATCH_IMPACT ? 'watch' : 'info'
}

/** A crash is told once; it is told again only after Bitcoin has come back above this. */
export const BTC_CRASH_REARM_PCT = -2.5

/** Bitcoin's move over the last hour of its closed minutes, in percent; null when the hour is not
 * all there. */
export function btcHourMovePct(btcMinutes: readonly Candle[], nowSec: number): number | null {
  const closed = btcMinutes.filter((bar) => bar.time + 60 <= nowSec)
  if (closed.length < 61) return null
  const last = closed[closed.length - 1]
  const hourAgo = closed[closed.length - 61]
  if (last.time - hourAgo.time !== 3600 || !(hourAgo.close > 0)) return null
  return (last.close / hourAgo.close - 1) * 100
}

/** Whether to tell a crash now, given whether one is being told already: told when the hour's move
 * reaches BTC_CRASH_PCT, and not again until it has come back above BTC_CRASH_REARM_PCT. */
export function crashStep(movePct: number | null, telling: boolean): { tell: boolean; telling: boolean } {
  if (movePct === null) return { tell: false, telling }
  if (!telling && movePct <= BTC_CRASH_PCT) return { tell: true, telling: true }
  if (telling && movePct > BTC_CRASH_REARM_PCT) return { tell: false, telling: false }
  return { tell: false, telling }
}

/** What the desktop is told of a crash. */
export function crashNotice(movePct: number): { title: string; body: string } {
  return {
    title: `CRITICAL: Bitcoin ${movePct.toFixed(2)}% in an hour`,
    body: `Bitcoin has fallen ${Math.abs(movePct).toFixed(2)}% within the last hour. Nothing was placed or sold; what is open is on Positions and Strategies.`
  }
}

/** The coins a story's notice is about: the ones it names as its subject. */
export function noticeCoins(story: Pick<ReadStory, 'assets'>): string[] {
  return story.assets.filter((asset) => asset.relationship === 'DIRECT').map((asset) => asset.ticker)
}

/** How long a story told stays one that the same news is held back against: the six hours inside
 * which close titles are one story (shared/newsFeed.ts). */
export const NOTICE_REPEAT_SECONDS = SAME_STORY_SECONDS

/** How alike two titles about a coin in common must be (titleSimilarity) to be the same news: well
 * under the line a story is folded at, because the coin is already shared. Measured on the four
 * feeds on 7 October 2026, on the 113 pairs of stories from different outlets that named a coin in
 * common within six hours. Fifteen came to 0.15 or more. Thirteen of them were one piece of news told
 * again: a Zcash ETF filing at 0.20 to 0.29, a Bitcoin Fog ruling at 0.31, a layer 2 shutting down at
 * 0.29 to 0.73. The other two were Bitcoin going under $84,000 twice, six hours apart, under headlines
 * 0.19 and 0.24 alike, and the rule takes the second fall for the first. Below 0.15, the most alike
 * two different pieces of news came to 0.125, and one piece of news told by two outlets, Bitmine's,
 * came to 0.11 and is told twice. */
export const SAME_NEWS_SIMILARITY = 0.15

/** A story a notice was raised or held back for: its coins, its title, and when. */
export interface NoticedStory {
  coins: readonly string[]
  title: string
  at: number
}

/** Whether a story's notice would only repeat news already told: a WATCH notice for which a story in
 * `noticed` less than NOTICE_REPEAT_SECONDS old names a coin it names and has a title at least
 * SAME_NEWS_SIMILARITY alike. HIGH and CRITICAL are never held back. */
export function repeatsNotice(story: Pick<ReadStory, 'assets' | 'title'>, severity: AlertSeverity, noticed: readonly NoticedStory[], nowSec: number): boolean {
  if (severity !== 'watch') return false
  const coins = noticeCoins(story)
  return noticed.some(
    (earlier) => nowSec - earlier.at < NOTICE_REPEAT_SECONDS && earlier.coins.some((coin) => coins.includes(coin)) && titleSimilarity(earlier.title, story.title) >= SAME_NEWS_SIMILARITY
  )
}

/** What is known of a story at the moment it is told (the V5 document's example notice, §50; since
 * 8 October 2026): the coin's price and its move since the story's minute, the source's class, what
 * the price did (shared/newsFeed.ts reactions), the analyst's reading where it answered already, and
 * the watch's call on the matching event where there is one. Each is said only where it is known;
 * none is a call of the notice's own. */
export interface StoryFacts {
  price?: { last: number; movePct: number | null; over: string } | null
  sourceClass?: SourceClass | null
  reaction?: Pick<StoryReaction, 'verdict' | 'pricedIn'> | null
  reading?: { relationship: string; direction: string; impact: number } | null
  watchCall?: { side: 'BUY' | 'SELL' | 'NO TRADE'; confidence: number; model: string } | null
}

const plainPrice = (value: number): string => Number(value.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 8 })
const signedPct = (value: number): string => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`

/** What the desktop is told of a story. */
export function storyNotice(story: Pick<ReadStory, 'title' | 'sourceName' | 'eventType' | 'assets' | 'impact'>, severity: AlertSeverity, heldPlaces: string[] = [], facts: StoryFacts = {}): { title: string; body: string } {
  const coins = noticeCoins(story)
  const head = severity === 'critical' ? 'CRITICAL' : severity === 'high' ? 'HIGH' : 'News'
  const parts = [`${story.title} (${story.sourceName}${facts.sourceClass ? `, ${facts.sourceClass}` : ''}; impact ${story.impact}).`]
  if (facts.price) parts.push(`${coins[0] ?? 'It'} at ${plainPrice(facts.price.last)}${facts.price.movePct === null ? '' : `, ${signedPct(facts.price.movePct)} over ${facts.price.over}`}.`)
  if (facts.reaction) {
    if (facts.reaction.pricedIn) parts.push('Priced in: it had moved its way before it was published.')
    else if (facts.reaction.verdict === 'CONFIRMED') parts.push('Confirmed by the price.')
    else if (facts.reaction.verdict === 'AGAINST') parts.push('The price went the other way.')
  }
  if (facts.reading) parts.push(`The analyst read it as ${facts.reading.relationship}, ${facts.reading.direction}, impact ${facts.reading.impact}.`)
  if (facts.watchCall) parts.push(`The watch said ${facts.watchCall.side} at ${Math.round(facts.watchCall.confidence * 100)}% (${facts.watchCall.model.split('/').pop() ?? facts.watchCall.model}).`)
  if (heldPlaces.length > 0) parts.push(`You hold it: ${heldPlaces.join('; ')}.`)
  parts.push('Nothing was placed or sold.')
  return {
    title: `${head}: ${coins.length > 0 ? `${coins.slice(0, 3).join(', ')} · ` : ''}${describeEventType(story.eventType)}`,
    body: parts.join(' ')
  }
}

/** How long a CRITICAL banner still up waits between reminders (the V5 document, §49). */
export const CRITICAL_REMINDER_SECONDS = 60

/** Whether a CRITICAL banner still up is due its reminder: one or more critical alerts shown and not
 * dismissed, and a minute since it last sounded -- the notice itself, when the banner came up. Never
 * before it has sounded once. */
export function criticalReminderDue(critical: number, lastSoundAt: number | null, nowSec: number): boolean {
  return critical > 0 && lastSoundAt !== null && nowSec - lastSoundAt >= CRITICAL_REMINDER_SECONDS
}

/** Severity, in the words the handler takes it in: none for INFO, which raises no notice. */
export function noticeSeverity(severity: AlertSeverity): 'watch' | 'high' | 'critical' | null {
  return severity === 'info' ? null : severity
}

/** A severity as sent over the bridge, read as one: anything else is none. */
export function healNoticeSeverity(value: unknown): 'watch' | 'high' | 'critical' | null {
  return value === 'watch' || value === 'high' || value === 'critical' ? value : null
}

// EVERY KIND THE V4 DOCUMENT NAMES (§48), IN THREADS (§49). Each notice the app raises carries a kind,
// so that Overview, the session report and the records on file can say what it was; and a kind with
// a thread -- a pair, an event, a trade, or a fixed name -- is told once per thread per half hour:
// a repeat inside the window is counted on the thread and raises nothing. The handler in the main
// process keeps the threads (the notice service there); the arithmetic is here.

export const ALERT_KINDS = [
  'MARKET_EVENT',
  'NEWS_EVENT',
  'TRADE_OPPORTUNITY',
  'TRADE_EXECUTED',
  'TRADE_BLOCKED',
  'POSITION_RISK',
  'TARGET_REACHED',
  'STOP_TRIGGERED',
  'MODEL_DISAGREEMENT',
  'SYSTEM_FAILURE',
  'CIRCUIT_BREAKER'
] as const

export type AlertKind = (typeof ALERT_KINDS)[number]

/** How loud a kind is when the notice names no severity of its own: WATCH is silent; HIGH sounds. */
export const ALERT_KIND_SEVERITY: Record<AlertKind, AlertSeverity> = {
  MARKET_EVENT: 'watch',
  NEWS_EVENT: 'watch',
  TRADE_OPPORTUNITY: 'high',
  TRADE_EXECUTED: 'watch',
  TRADE_BLOCKED: 'watch',
  POSITION_RISK: 'high',
  TARGET_REACHED: 'high',
  STOP_TRIGGERED: 'high',
  MODEL_DISAGREEMENT: 'watch',
  SYSTEM_FAILURE: 'high',
  CIRCUIT_BREAKER: 'high'
}

export function healAlertKind(value: unknown): AlertKind | null {
  return typeof value === 'string' && (ALERT_KINDS as readonly string[]).includes(value) ? (value as AlertKind) : null
}

export function describeAlertKind(kind: AlertKind): string {
  return kind.toLowerCase().replace(/_/g, ' ')
}

/** How long a thread holds repeats back. */
export const ALERT_THREAD_SECONDS = 30 * 60

export interface AlertThread {
  /** Notices on the thread in its window, the one told included. */
  count: number
  firstAt: number
  lastAt: number
}

export function threadKey(kind: AlertKind, thread: string): string {
  return `${kind}:${thread}`
}

/** One notice against its thread: a repeat when the thread was told within `windowSec`; the
 * threads updated either way, with threads whose window has passed forgotten. */
export function threadStep(
  threads: Readonly<Record<string, AlertThread>>,
  kind: AlertKind,
  thread: string,
  nowSec: number,
  windowSec: number = ALERT_THREAD_SECONDS
): { repeat: boolean; threads: Record<string, AlertThread> } {
  const key = threadKey(kind, thread)
  const kept: Record<string, AlertThread> = {}
  for (const [entry, state] of Object.entries(threads)) if (nowSec - state.firstAt < ALERT_THREAD_SECONDS * 48) kept[entry] = state
  const held = kept[key]
  if (held !== undefined && nowSec - held.firstAt < windowSec) {
    kept[key] = { ...held, count: held.count + 1, lastAt: nowSec }
    return { repeat: true, threads: kept }
  }
  kept[key] = { count: 1, firstAt: nowSec, lastAt: nowSec }
  return { repeat: false, threads: kept }
}
