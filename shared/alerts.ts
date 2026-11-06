import { ENGLISH, msg, type I18n } from './i18n/translate'
import { INCIDENT_LINES, aboutCrypto, matchKeys } from './incidents'
import type { AlertSettings, Candle } from './ipc'
import { SAME_STORY_SECONDS, describeEventType, titleSimilarity, type ReactionVerdict, type ReadStory, type SourceClass, type StoryIncident, type StoryReaction } from './newsFeed'

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
// A hack or an exploit is judged by its incident instead (V9 Stage 2, 6 November 2026; shared/incidents.ts):
// - CRITICAL: the first report of a theft from a victim whose own token you hold;
// - HIGH: the first report of one whose token trades on Binance, of a top exchange's, or of $100 million or more;
// - WATCH: any other first report that concerns crypto;
// - INFO: every follow-up -- laundering, refunds, roundups, opinion, a theft told before -- and a story that reports
//   no theft at all. On the two archives, 24 loud news notices were nearly all follow-ups or a loot coin's.
// And one loud notice is told per victim, or per sum, a day: a second story of it is kept on its page.
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

export const DEFAULT_ALERTS: AlertSettings = { enabled: true, sound: true, desktop: true }

/** A stored setting, read as one: settings.json is written by the renderer, so it is healed rather
 * than obeyed. Only `false` switches either off. */
export function healAlerts(value: unknown): AlertSettings {
  const raw = (typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}) as Partial<Record<keyof AlertSettings, unknown>>
  return { enabled: raw.enabled !== false, sound: raw.sound !== false, desktop: raw.desktop !== false }
}

export type AlertSeverity = 'info' | 'watch' | 'high' | 'critical'

export const HIGH_IMPACT = 70
export const WATCH_IMPACT = 45
/** Bitcoin down this far within the last hour is a crash. */
export const BTC_CRASH_PCT = -5

/** A hack's or an exploit's severity by its incident (V9 Stage 2): only a first report is told, CRITICAL where its
 * victim's own token is held, HIGH where that token trades, the victim is a top exchange or the sum is $100 million
 * or more, WATCH where it concerns crypto at all; a follow-up and a story that reports no theft are INFO. */
export function incidentSeverity(story: Pick<ReadStory, 'title' | 'summary' | 'assets'> & { incident?: StoryIncident | null }, held: ReadonlySet<string>): AlertSeverity {
  const incident = story.incident ?? null
  if (incident === null || incident.report !== 'first') return 'info'
  if (incident.victimToken !== null && held.has(incident.victimToken)) return 'critical'
  if (incident.victimToken !== null || incident.topExchange || (incident.amountUsd ?? 0) >= INCIDENT_LINES.highUsd) return 'high'
  return aboutCrypto(story) ? 'watch' : 'info'
}

/** A story's severity, given the coins held. A hack or exploit story read for its incident is judged by it. */
export function storySeverity(
  story: Pick<ReadStory, 'impact' | 'eventType' | 'assets' | 'stale'> & Partial<Pick<ReadStory, 'repeat' | 'incident' | 'title' | 'summary'>>,
  held: ReadonlySet<string>,
  reaction: ReactionVerdict | null = null
): AlertSeverity {
  if (story.stale) return 'info'
  if ((story.eventType === 'HACK' || story.eventType === 'EXPLOIT') && story.incident !== undefined) return incidentSeverity({ title: story.title ?? '', summary: story.summary ?? '', assets: story.assets, incident: story.incident }, held)
  // Recycled news (shared/newsFeed.ts, since 8 October 2026) was told once already: never HIGH.
  if (story.repeat === true) return story.impact >= WATCH_IMPACT ? 'watch' : 'info'
  const heldDirect = story.assets.some((asset) => asset.relationship === 'DIRECT' && held.has(asset.ticker))
  if (heldDirect && (story.eventType === 'HACK' || story.eventType === 'EXPLOIT' || story.eventType === 'DELISTING')) return 'critical'
  if (story.impact >= HIGH_IMPACT || reaction === 'CONFIRMED') return 'high'
  return story.impact >= WATCH_IMPACT ? 'watch' : 'info'
}

/** A crash is told once; it is told again only after Bitcoin has come back above this. */
export const BTC_CRASH_REARM_PCT = -2.5

/** Bitcoin's move over the last `minutes` of its closed minutes, in percent; null when they are not all there. */
export function btcMovePct(btcMinutes: readonly Candle[], nowSec: number, minutes: number): number | null {
  const closed = btcMinutes.filter((bar) => bar.time + 60 <= nowSec)
  if (closed.length < minutes + 1) return null
  const last = closed[closed.length - 1]
  const before = closed[closed.length - 1 - minutes]
  if (last.time - before.time !== minutes * 60 || !(before.close > 0)) return null
  return (last.close / before.close - 1) * 100
}

/** Bitcoin's move over the last hour of its closed minutes, in percent; null when the hour is not
 * all there. */
export function btcHourMovePct(btcMinutes: readonly Candle[], nowSec: number): number | null {
  return btcMovePct(btcMinutes, nowSec, 60)
}

/** Whether to tell a crash now, given whether one is being told already: told when the hour's move
 * reaches BTC_CRASH_PCT, and not again until it has come back above BTC_CRASH_REARM_PCT. */
export function crashStep(movePct: number | null, telling: boolean): { tell: boolean; telling: boolean } {
  if (movePct === null) return { tell: false, telling }
  if (!telling && movePct <= BTC_CRASH_PCT) return { tell: true, telling: true }
  if (telling && movePct > BTC_CRASH_REARM_PCT) return { tell: false, telling: false }
  return { tell: false, telling }
}

/** What the desktop is told of a crash, in a language. */
export function crashNotice(movePct: number, i18n: I18n = ENGLISH): { title: string; body: string } {
  const { t } = i18n
  return {
    title: t('CRITICAL: Bitcoin {move} in an hour', { move: i18n.language === 'en' ? `${movePct.toFixed(2)}%` : i18n.pct(movePct, 2) }),
    body: t('Bitcoin has fallen {move} within the last hour. Nothing was placed or sold; what is open is on Positions and Strategies.', { move: i18n.pctPlain(Math.abs(movePct), 2) })
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

/** A source's class, a reading's relationship and its way, as a story's notice says them. */
const SOURCE_CLASS_WORDS: Record<string, string> = { exchange: msg('exchange@@a source'), media: msg('media@@a source'), official: msg('official@@a source') }
const RELATIONSHIP_WORDS: Record<string, string> = { DIRECT: msg('DIRECT'), INDIRECT: msg('INDIRECT'), NONE: msg('NONE@@a relationship') }
const WAY_WORDS: Record<string, string> = { up: msg('up'), down: msg('down'), none: msg('no direction') }
const CALL_WORDS: Record<string, string> = { BUY: msg('BUY'), SELL: msg('SELL'), 'NO TRADE': msg('NO TRADE') }

/** A sum in dollars, short: "$5.5B", "$106M", "$727K". */
export function sumWords(value: number, i18n: I18n = ENGLISH): string {
  // The least decimals said, or a runtime's older ICU keeps a currency's two and writes "$223.0M" (V9 Stage 2's check).
  return new Intl.NumberFormat(`${i18n.language}-u-nu-latn`, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol', notation: 'compact', minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(value)
}

/** What a notice says of an incident's first report: who lost the funds, the sum, the victim's own token, and that
 * which way a hack moves anything is not measured. Nothing for a follow-up or a story that is no incident. */
export function incidentLines(incident: StoryIncident | null | undefined, i18n: I18n = ENGLISH): string[] {
  const { t } = i18n
  if (incident == null || incident.report !== 'first') return []
  const lines = [incident.victim === null ? t('First report of a theft; who lost the funds is not named.') : t('First report of a theft from {victim}.', { victim: incident.victim })]
  if (incident.amountUsd !== null) lines.push(t('The sum named: {sum}.', { sum: sumWords(incident.amountUsd, i18n) }))
  if (incident.victimToken !== null) lines.push(t("The victim's own token: {token}.", { token: incident.victimToken }))
  lines.push(t('Which way: unknown. What prices do after a hack is not measured yet.'))
  return lines
}

/** What the desktop is told of a story, in a language. The headline is the feed's own. */
export function storyNotice(
  story: Pick<ReadStory, 'title' | 'sourceName' | 'eventType' | 'assets' | 'impact'> & { incident?: StoryIncident | null },
  severity: AlertSeverity,
  heldPlaces: string[] = [],
  facts: StoryFacts = {},
  i18n: I18n = ENGLISH
): { title: string; body: string } {
  const { t } = i18n
  const word = (table: Record<string, string>, value: string): string => (table[value] === undefined ? value : t(table[value]))
  const plainPrice = (value: number): string => i18n.num(Number(value.toPrecision(7)), 0, 8)
  const signedPct = (value: number): string => (i18n.language === 'en' ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : i18n.pct(value, 2))
  const coins = noticeCoins(story)
  const head = severity === 'critical' ? t('CRITICAL') : severity === 'high' ? t('HIGH') : t('News')
  const source = facts.sourceClass ? t('{source}, {kind}', { source: story.sourceName, kind: word(SOURCE_CLASS_WORDS, facts.sourceClass) }) : story.sourceName
  const parts = [t('{title} ({source}; impact {impact}).', { title: story.title, source, impact: story.impact }), ...incidentLines(story.incident, i18n)]
  if (facts.price) {
    const coin = coins[0] ?? t('It')
    parts.push(
      facts.price.movePct === null
        ? t('{coin} at {price}.', { coin, price: plainPrice(facts.price.last) })
        : t('{coin} at {price}, {move} over {over}.', { coin, price: plainPrice(facts.price.last), move: signedPct(facts.price.movePct), over: t(facts.price.over) })
    )
  }
  if (facts.reaction) {
    if (facts.reaction.pricedIn) parts.push(t('Priced in: it had moved its way before it was published.'))
    else if (facts.reaction.verdict === 'CONFIRMED') parts.push(t('Confirmed by the price.'))
    else if (facts.reaction.verdict === 'AGAINST') parts.push(t('The price went the other way.'))
  }
  if (facts.reading) {
    parts.push(t('The analyst read it as {relationship}, {way}, impact {impact}.', { relationship: word(RELATIONSHIP_WORDS, facts.reading.relationship), way: word(WAY_WORDS, facts.reading.direction), impact: facts.reading.impact }))
  }
  if (facts.watchCall) {
    parts.push(
      t('The watch said {call} at {confidence} ({model}).', {
        call: word(CALL_WORDS, facts.watchCall.side),
        confidence: i18n.pctPlain(Math.round(facts.watchCall.confidence * 100), 0),
        model: facts.watchCall.model.split('/').pop() ?? facts.watchCall.model
      })
    )
  }
  if (heldPlaces.length > 0) parts.push(t('You hold it: {places}.', { places: heldPlaces.join(t('; ')) }))
  parts.push(t('Nothing was placed or sold.'))
  const kind = describeEventType(story.eventType, i18n)
  // A first report is named by its victim, with its token where it has one; a story of no incident by its coins.
  const victim = story.incident?.report === 'first' ? story.incident.victim : null
  const named = victim === null ? null : story.incident?.victimToken ? t('{victim} ({token})', { victim, token: story.incident.victimToken }) : victim
  return {
    title:
      named !== null
        ? t('{head}: {coins} · {kind}', { head, coins: named, kind })
        : coins.length > 0
          ? t('{head}: {coins} · {kind}', { head, coins: coins.slice(0, 3).join(', '), kind })
          : t('{head}: {kind}', { head, kind }),
    body: parts.join(' ')
  }
}

/** A loud incident told: the keys it is known by (shared/incidents.ts incidentKeys), when, and how loud. */
export interface LoudIncident {
  keys: readonly string[]
  at: number
  severity: AlertSeverity
}

/** Whether a loud incident notice would tell again a victim, or an unnamed victim's sum, told loud in the last day
 * (INCIDENT_LINES.loudOnceSeconds): the second report a day of the same theft is kept on its page. A CRITICAL one is
 * still told where what was told was not CRITICAL: a coin held is never hidden behind a notice for a coin not held. */
export function repeatsLoudIncident(story: { incident?: StoryIncident | null }, severity: AlertSeverity, told: readonly LoudIncident[], nowSec: number): boolean {
  if (severity !== 'high' && severity !== 'critical') return false
  const incident = story.incident ?? null
  if (incident === null) return false
  const keys = matchKeys(incident)
  return told.some((entry) => nowSec - entry.at < INCIDENT_LINES.loudOnceSeconds && entry.keys.some((key) => keys.includes(key)) && !(severity === 'critical' && entry.severity !== 'critical'))
}

// THE MARKET BEFORE THE NEWS (V9 Stage 2; registered as V9-SHOCK). On 29 October 2026 BNB fell about 7% and Bitcoin
// 2.5% between 19:30 and 21:00 UTC, before the first story of Binance's hack at 21:36. The forecast reads the market's
// shock state every few minutes (shared/forecast/marketShock.ts); when it enters one of the three states of a sharp
// fifteen minutes -- Bitcoin past 2.5 of its usual fifteen-minute moves, a break, a trend or a cascade -- a HIGH
// notice says so, and a loud story told in the two hours after says how long after the shock it came.

/** The states a shock notice is told for: Bitcoin's fifteen minutes past the line, whatever came before them. */
export const SHOCK_NOTICE_STATES: readonly string[] = ['POST_EVENT_SHOCK', 'TRENDING_SHOCK', 'LIQUIDATION_SHOCK']
/** A loud story within this long after a shock notice is told with it. */
export const SHOCK_ATTACH_SECONDS = 2 * 3600

/** Whether the market's state now opens a shock: it is a shock state and the state before it, read last, was none. */
export function shockStarts(previous: string | null, current: string | null): boolean {
  return current !== null && SHOCK_NOTICE_STATES.includes(current) && (previous === null || !SHOCK_NOTICE_STATES.includes(previous))
}

/** What the desktop is told of a shock, in a language: the state's words, Bitcoin's fifteen minutes in percent where
 * the stream has them, and in its usual moves. */
export function shockNotice(input: { stateWord: string; btc15: number; movePct: number | null }, i18n: I18n = ENGLISH): { title: string; body: string } {
  const { t } = i18n
  const times = i18n.num(Math.abs(input.btc15), 1, 1)
  const move = input.movePct === null ? null : i18n.language === 'en' ? `${input.movePct >= 0 ? '+' : ''}${input.movePct.toFixed(2)}%` : i18n.pct(input.movePct, 2)
  return {
    title: t('HIGH: market shock · {state}', { state: input.stateWord }),
    body: [
      move === null ? t("Bitcoin's last fifteen minutes moved {times} times its usual fifteen minutes.", { times }) : t('Bitcoin moved {move} in fifteen minutes, {times} times its usual fifteen minutes.', { move, times }),
      t('No story on file explains it yet; a loud story in the next two hours is told with it.'),
      t('Nothing was placed or sold.')
    ].join(' ')
  }
}

/** What a loud story's notice adds within two hours after a shock notice: how long after it the story came. Null
 * outside the two hours, or for a story published before the shock. */
export function shockAttachLine(story: Pick<ReadStory, 'publishedAt'>, shockAtSec: number | null, i18n: I18n = ENGLISH): string | null {
  if (shockAtSec === null) return null
  const gap = story.publishedAt - shockAtSec
  if (gap < 0 || gap > SHOCK_ATTACH_SECONDS) return null
  const clock = i18n.language === 'en' ? new Date(shockAtSec * 1000).toISOString().slice(11, 16) : i18n.utcTime(shockAtSec * 1000)
  return i18n.t('It came {count} minutes after the market shock told at {time} UTC.', { count: Math.round(gap / 60), time: clock })
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
  'CIRCUIT_BREAKER',
  /** The V5 document's §102 (8 October 2026): what the exchange holds against what the ledger
   * knows -- a resting order the app has no record of, or an asset it claims more of than the
   * account holds. One notice an order or an asset; the ledger is never rewritten by it. */
  'RECONCILIATION',
  /** The V6 document's §71 (13 October 2026): a watched coin's forecast turned from BULLISH to BEARISH,
   * or back, and held (shared/forecast/predictionChange.ts). */
  'PREDICTION_CHANGED',
  /** The V6 document's §105: a forecast model whose last week went wrong, told once a day. */
  'MODEL_DEGRADED'
] as const

/** Each kind by name, as Settings › Notifications lists them (V6 Stage 14): keys, said in a language. */
export const ALERT_KIND_NAMES: Record<AlertKind, string> = {
  MARKET_EVENT: msg('market event'),
  NEWS_EVENT: msg('news event'),
  TRADE_OPPORTUNITY: msg('trade opportunity'),
  TRADE_EXECUTED: msg('trade executed'),
  TRADE_BLOCKED: msg('trade blocked'),
  POSITION_RISK: msg('position risk'),
  TARGET_REACHED: msg('target reached@@a kind of notice'),
  STOP_TRIGGERED: msg('stop triggered'),
  MODEL_DISAGREEMENT: msg('model disagreement'),
  SYSTEM_FAILURE: msg('system failure'),
  CIRCUIT_BREAKER: msg('circuit breaker'),
  RECONCILIATION: msg('reconciliation'),
  PREDICTION_CHANGED: msg('prediction changed'),
  MODEL_DEGRADED: msg('model degraded')
}

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
  CIRCUIT_BREAKER: 'high',
  RECONCILIATION: 'high',
  PREDICTION_CHANGED: 'high',
  MODEL_DEGRADED: 'watch'
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
