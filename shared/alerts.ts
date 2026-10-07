import type { AlertSettings, Candle } from './ipc'
import { SAME_STORY_SECONDS, describeEventType, titleSimilarity, type ReactionVerdict, type ReadStory } from './newsFeed'

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
export function storySeverity(story: Pick<ReadStory, 'impact' | 'eventType' | 'assets' | 'stale'>, held: ReadonlySet<string>, reaction: ReactionVerdict | null = null): AlertSeverity {
  if (story.stale) return 'info'
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

/** What the desktop is told of a story. */
export function storyNotice(story: Pick<ReadStory, 'title' | 'sourceName' | 'eventType' | 'assets' | 'impact'>, severity: AlertSeverity, heldPlaces: string[] = []): { title: string; body: string } {
  const coins = noticeCoins(story)
  const head = severity === 'critical' ? 'CRITICAL' : severity === 'high' ? 'HIGH' : 'News'
  return {
    title: `${head}: ${coins.length > 0 ? `${coins.slice(0, 3).join(', ')} · ` : ''}${describeEventType(story.eventType)}`,
    body: `${story.title} (${story.sourceName}; impact ${story.impact}).${heldPlaces.length > 0 ? ` You hold it: ${heldPlaces.join('; ')}.` : ''} Nothing was placed or sold.`
  }
}

/** Severity, in the words the handler takes it in: none for INFO, which raises no notice. */
export function noticeSeverity(severity: AlertSeverity): 'watch' | 'high' | 'critical' | null {
  return severity === 'info' ? null : severity
}

/** A severity as sent over the bridge, read as one: anything else is none. */
export function healNoticeSeverity(value: unknown): 'watch' | 'high' | 'critical' | null {
  return value === 'watch' || value === 'high' || value === 'critical' ? value : null
}
