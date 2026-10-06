import type { Candle } from './ipc'

// NEWS FROM THE WHOLE MARKET, MATCHED TO COINS AND JUDGED BY WHAT THE PRICE DID (the second V3
// document, §11-14 and §53).
//
// The app already reads Binance's own announcements (shared/news.ts). Since 6 October 2026 it also
// reads four free media feeds -- CoinDesk, Cointelegraph, Decrypt and The Block -- with no key and
// at no cost (the user chose free sources; CoinGecko's news needs a paid plan). The main process's
// newsFeedService.ts reads them every three minutes; this file is the arithmetic on what it read:
// each item made a story, the coins it names, what kind of news it is, how much it might matter,
// whether the same story came from another source, and -- from the coin's own minutes -- what the
// price did around it.
//
// COINS ARE MATCHED BY RULES, NEVER GUESSED. A ticker counts as a whole word in capitals or as
// $TICKER; a ticker that is also a common word (ONE, GAS, AI...) counts only as $TICKER or by its
// name. Named in the title, the coin is the story's subject (DIRECT); named only in the summary, it
// is mentioned (INDIRECT). A model's reading of the same story is a separate, paid step.
//
// WHAT HISTORY SAYS IS SHOWN ONLY WHEN THERE IS ENOUGH OF IT. The reaction of each kind of news is
// gathered as stories age, and its median is shown from thirty stories; below that, "Insufficient
// historical evidence".
//
// IT READS. Nothing here asks a model, places anything or holds a key.

export const NEWS_FEED_VERSION = 'feed-v1'
export const FEED_READ_MS = 3 * 60_000
/** Stories kept on screen and in memory: a week of them. */
export const FEED_KEEP_SECONDS = 7 * 86_400
/** A story published this long before it was first read is old news reposted, or a backlog. */
export const STALE_STORY_SECONDS = 86_400
/** Two titles this alike within this long are one story from several sources. */
export const SAME_STORY_SIMILARITY = 0.6
export const SAME_STORY_SECONDS = 6 * 3600
/** Reactions are measured up to four hours after; one this old is final. */
export const REACTION_FINAL_SECONDS = 4 * 3600 + 120
/** Fewer stories of a kind than this, and no history is shown for it. */
export const IMPACT_MIN_STORIES = 30

export type SourceClass = 'official' | 'exchange' | 'media'

export interface FeedSource {
  id: string
  name: string
  url: string
  sourceClass: SourceClass
  /** How far a story from it is taken at its word, 0 to 1. */
  credibility: number
}

export const FEED_SOURCES: readonly FeedSource[] = [
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss', sourceClass: 'media', credibility: 0.85 },
  { id: 'theblock', name: 'The Block', url: 'https://www.theblock.co/rss.xml', sourceClass: 'media', credibility: 0.85 },
  { id: 'cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', sourceClass: 'media', credibility: 0.8 },
  { id: 'decrypt', name: 'Decrypt', url: 'https://decrypt.co/feed', sourceClass: 'media', credibility: 0.8 }
]

/** Binance's own announcements, read by the news reader, as stories beside the feeds. */
export const BINANCE_SOURCE: Omit<FeedSource, 'url'> = { id: 'binance', name: 'Binance', sourceClass: 'exchange', credibility: 1 }

/** The hosts a story's link may open in the browser: the sources', and nothing else. */
export const FEED_HOSTS: readonly string[] = ['www.coindesk.com', 'coindesk.com', 'www.theblock.co', 'theblock.co', 'cointelegraph.com', 'decrypt.co', 'www.binance.com']

export type NewsEventType = 'HACK' | 'DELISTING' | 'LISTING' | 'ETF' | 'REGULATION' | 'TOKEN_UNLOCK' | 'MACRO' | 'UPGRADE' | 'PARTNERSHIP' | 'OTHER'
export type Relationship = 'DIRECT' | 'INDIRECT'

export interface RawFeedItem {
  title: string
  link: string
  guid: string | null
  pubDate: string | null
  description: string
}

export interface FeedStory {
  /** The source's id and a hash of the item's own id or link: the same item is kept once. */
  id: string
  source: string
  sourceName: string
  sourceClass: SourceClass
  title: string
  url: string
  /** Seconds. */
  publishedAt: number
  seenAt: number
  /** The item's summary as plain text, cut to 400 characters. */
  summary: string
  /** Set on a story from Binance's announcements: the coins it names, by its own title rules. */
  tickers?: string[]
  /** Set on a story from Binance's announcements: its kind, by the news reader's patterns. */
  binanceCategory?: string | null
}

export interface StoryAsset {
  ticker: string
  relationship: Relationship
}

export interface ReadStory extends FeedStory {
  assets: StoryAsset[]
  /** No coin named, but about the whole market: macro, regulation, an ETF. */
  marketWide: boolean
  eventType: NewsEventType
  credibility: number
  /** 0 to 100: how much it might matter, by its kind, how directly it names a coin, its source and
   * how fresh it is. */
  impact: number
  stale: boolean
  /** The other sources that carried the same story. */
  alsoIn: string[]
}

export interface FeedSourceStatus {
  id: string
  name: string
  lastReadAt: number | null
  /** Null before it was first read. */
  ok: boolean | null
  error: string | null
  /** Items in its feed when last read. */
  items: number
}

export interface NewsFeedState {
  version: string
  sources: FeedSourceStatus[]
  /** A week of stories, the same story from several sources carried once, newest first. */
  stories: ReadStory[]
  /** What the price did around each story measured, by story id: the latest reading. */
  reactions: Record<string, StoryReaction>
  impact: TypeImpact[]
  /** Reactions measured to their end, all told: what `impact` rests on. */
  measured: number
  updatedAt: number | null
}

// ---------------------------------------------------------------------------------------------
// Reading a feed.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : whole
    }
    return ENTITIES[code.toLowerCase()] ?? whole
  })
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block)
  if (match === null) return null
  const inner = match[1].trim()
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner)
  return cdata !== null ? cdata[1].trim() : decodeEntities(inner)
}

/** HTML to plain text: tags dropped, entities read, space collapsed. */
export function plainText(html: string): string {
  return decodeEntities(html.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/** The items of an RSS 2.0 feed. A feed that is not one gives none. */
export function parseRss(xml: string): RawFeedItem[] {
  const items: RawFeedItem[] = []
  for (const match of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const block = match[1]
    const title = tag(block, 'title')
    const link = tag(block, 'link')
    if (title === null || link === null || title === '' || link === '') continue
    items.push({ title: plainText(title), link: link.trim(), guid: tag(block, 'guid'), pubDate: tag(block, 'pubDate'), description: plainText(tag(block, 'description') ?? '') })
  }
  return items
}

/** FNV-1a, 32 bits, as hex: a short stable id for a link. */
function hash(text: string): string {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value.toString(16).padStart(8, '0')
}

/** An item of a source's feed as a story, or null when it has no time or no https link. */
export function toStory(item: RawFeedItem, source: FeedSource, seenAt: number): FeedStory | null {
  const published = item.pubDate === null ? Number.NaN : Date.parse(item.pubDate)
  if (!Number.isFinite(published) || !/^https:\/\//i.test(item.link)) return null
  return {
    id: `${source.id}:${hash(item.guid ?? item.link)}`,
    source: source.id,
    sourceName: source.name,
    sourceClass: source.sourceClass,
    title: item.title,
    url: item.link,
    publishedAt: Math.floor(published / 1000),
    seenAt,
    summary: item.description.slice(0, 400)
  }
}

// ---------------------------------------------------------------------------------------------
// Which coins a story names.

/** Names a story may use for a coin, beside its ticker: the coins most traded on Binance. Longer
 * names are matched first, so "Bitcoin Cash" is not also Bitcoin. */
export const COIN_NAMES: Readonly<Record<string, readonly string[]>> = {
  BTC: ['bitcoin'],
  ETH: ['ethereum', 'ether'],
  BNB: ['bnb chain', 'binance coin'],
  SOL: ['solana'],
  XRP: ['ripple'],
  DOGE: ['dogecoin'],
  ADA: ['cardano'],
  TRX: ['tron'],
  TON: ['toncoin'],
  AVAX: ['avalanche'],
  DOT: ['polkadot'],
  LINK: ['chainlink'],
  BCH: ['bitcoin cash'],
  LTC: ['litecoin'],
  SHIB: ['shiba inu'],
  NEAR: ['near protocol'],
  UNI: ['uniswap'],
  APT: ['aptos'],
  ARB: ['arbitrum'],
  OP: ['optimism'],
  SUI: ['sui network'],
  ATOM: ['cosmos hub'],
  XLM: ['stellar'],
  ICP: ['internet computer'],
  FIL: ['filecoin'],
  AAVE: ['aave'],
  INJ: ['injective'],
  TIA: ['celestia'],
  HBAR: ['hedera'],
  ETC: ['ethereum classic'],
  ALGO: ['algorand'],
  VET: ['vechain'],
  EGLD: ['multiversx'],
  SAND: ['the sandbox'],
  MANA: ['decentraland'],
  AXS: ['axie infinity'],
  GRT: ['the graph'],
  LDO: ['lido dao'],
  CRV: ['curve finance'],
  ENA: ['ethena'],
  WLD: ['worldcoin'],
  JUP: ['jupiter exchange'],
  WIF: ['dogwifhat'],
  TAO: ['bittensor'],
  ONDO: ['ondo finance'],
  ZEC: ['zcash'],
  XMR: ['monero'],
  PEPE: ['pepecoin'],
  FET: ['fetch.ai'],
  RENDER: ['render network'],
  SEI: ['sei network'],
  PENGU: ['pudgy penguins'],
  HYPE: ['hyperliquid']
}

/** Tickers that are also words or common abbreviations: counted only as $TICKER or by name. */
export const WORD_TICKERS: ReadonlySet<string> = new Set([
  'AI', 'ONE', 'GAS', 'NOT', 'ACT', 'BIG', 'HOT', 'KEY', 'UP', 'IO', 'OM', 'WIN', 'FUN', 'SUN', 'PEOPLE', 'TRUMP', 'MEME', 'NFT', 'DATA', 'REAL',
  'GAME', 'MOVE', 'BAND', 'BOND', 'COS', 'EDU', 'ID', 'LIT', 'MASK', 'PORTAL', 'RARE', 'SAFE', 'SIGN', 'USUAL', 'ZK', 'ME', 'OG', 'GO', 'CAT',
  'DOGS', 'PUMP', 'BANK', 'BOME', 'HOOK', 'CYBER', 'HIGH', 'ALT', 'TRU', 'SCR', 'NEIRO', 'ORDI', 'SAGA', 'VIRTUAL', 'MAGIC', 'FORM', 'NIL', 'TST',
  'SHELL', 'LAYER', 'KAITO', 'RED', 'BABY', 'GPS', 'PROM', 'POWER', 'LUMIA', 'CHESS', 'ARK', 'MBOX', 'FIS', 'ACE', 'ANIME', 'USD', 'CEO', 'SEC',
  // "OP-ED", an IP address: Optimism and Story are matched by name, or as $OP and $IP.
  'OP', 'IP', 'OK', 'NEW', 'ALL', 'ANY', 'HOME', 'JOE', 'TURBO'
])

export interface AssetDictionary {
  tickers: ReadonlySet<string>
  /** Lowercase name to ticker, longest first. */
  names: readonly [string, string][]
}

/** What a story can be matched against: the base assets of Binance's USDT pairs, and the names
 * above of those among them. */
export function assetDictionary(baseAssets: readonly string[]): AssetDictionary {
  const tickers = new Set(baseAssets.map((asset) => asset.toUpperCase()).filter((asset) => asset.length >= 2))
  const names = Object.entries(COIN_NAMES)
    .filter(([ticker]) => tickers.has(ticker))
    .flatMap(([ticker, list]) => list.map((name) => [name, ticker] as [string, string]))
    .sort((a, b) => b[0].length - a[0].length)
  return { tickers, names }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The coins a text names, in the order first named. */
export function namedTickers(text: string, dictionary: AssetDictionary): string[] {
  const found: { ticker: string; at: number }[] = []
  // Names, longest first; the stretch a name covers is not read again by a shorter one.
  const lower = text.toLowerCase()
  const covered: [number, number][] = []
  for (const [name, ticker] of dictionary.names) {
    for (const match of lower.matchAll(new RegExp(`(?<![a-z0-9])${escapeRegExp(name)}(?![a-z0-9])`, 'g'))) {
      const start = match.index ?? 0
      const end = start + name.length
      if (covered.some(([from, to]) => start < to && end > from)) continue
      covered.push([start, end])
      found.push({ ticker, at: start })
    }
  }
  // Tickers: $TICKER always; a bare one only in capitals, as a whole word, and not a word itself.
  for (const match of text.matchAll(/(?<![A-Za-z0-9$])(\$?)([A-Z][A-Z0-9]{1,9})(?![A-Za-z0-9])/g)) {
    const ticker = match[2]
    if (!dictionary.tickers.has(ticker)) continue
    if (match[1] === '' && WORD_TICKERS.has(ticker)) continue
    found.push({ ticker, at: match.index ?? 0 })
  }
  const order = new Map<string, number>()
  for (const entry of found.sort((a, b) => a.at - b.at)) if (!order.has(entry.ticker)) order.set(entry.ticker, entry.at)
  return [...order.keys()]
}

/** The coins a story names: in its title, its subject; only in its summary, mentioned. */
export function storyAssets(story: Pick<FeedStory, 'title' | 'summary' | 'tickers'>, dictionary: AssetDictionary): StoryAsset[] {
  const direct = new Set([...(story.tickers ?? []), ...namedTickers(story.title, dictionary)])
  const mentioned = namedTickers(story.summary, dictionary).filter((ticker) => !direct.has(ticker))
  return [...[...direct].map((ticker) => ({ ticker, relationship: 'DIRECT' as const })), ...mentioned.map((ticker) => ({ ticker, relationship: 'INDIRECT' as const }))]
}

// ---------------------------------------------------------------------------------------------
// What kind of news, and how much it might matter.

const TYPE_RULES: readonly [NewsEventType, RegExp][] = [
  ['HACK', /\b(hack(ed|er|ers|s)?|exploit(ed|s)?|drain(ed|s)?|stolen|breach(ed)?|heist|attacker)\b/i],
  ['DELISTING', /\b(delist(s|ed|ing)?|monitoring tag)\b/i],
  ['LISTING', /\b(will list|lists|listing|to list|launch(es)? trading|futures launch)\b/i],
  ['ETF', /\betfs?\b/i],
  ['REGULATION', /\b(sec|cftc|regulat\w*|rules?|lawsuit|sues?|sued|court|bans?|banned|legislat\w*|senate|congress|licen[cs]e[sd]?|fined?|sanction\w*)\b/i],
  ['TOKEN_UNLOCK', /\bunlock(s|ed|ing)?\b/i],
  // Not "treasury" alone: in this news it is mostly a company's coins, not the bond market.
  ['MACRO', /\b(fed|fomc|inflation|cpi|ppi|rate cuts?|interest rates?|jobs report|payrolls|tariffs?|recession|treasury yields?|powell)\b/i],
  ['UPGRADE', /\b(upgrade[sd]?|mainnet|hard ?fork|testnet)\b/i],
  ['PARTNERSHIP', /\b(partner(s|ship|ships|ed)?|collaborat\w*|integrat\w*|teams? up)\b/i]
]

/** The kind of news: the first of the rules above the title and summary meet; Binance's own kind
 * where the story is an announcement. */
export function eventTypeOf(story: Pick<FeedStory, 'title' | 'summary' | 'binanceCategory'>): NewsEventType {
  if (story.binanceCategory === 'DELISTING' || story.binanceCategory === 'MONITORING_TAG') return 'DELISTING'
  if (story.binanceCategory === 'SPOT_LISTING' || story.binanceCategory === 'FUTURES_LAUNCH') return 'LISTING'
  const text = `${story.title} ${story.summary}`
  return TYPE_RULES.find(([, rule]) => rule.test(text))?.[0] ?? 'OTHER'
}

/** Which way a kind of news would move its coin, where it says. */
export function expectedDirection(type: NewsEventType): 'up' | 'down' | null {
  if (type === 'HACK' || type === 'DELISTING') return 'down'
  if (type === 'LISTING' || type === 'ETF' || type === 'UPGRADE' || type === 'PARTNERSHIP') return 'up'
  return null
}

const TYPE_WEIGHT: Record<NewsEventType, number> = {
  HACK: 90,
  DELISTING: 85,
  LISTING: 75,
  ETF: 70,
  REGULATION: 60,
  TOKEN_UNLOCK: 55,
  MACRO: 55,
  UPGRADE: 45,
  PARTNERSHIP: 40,
  OTHER: 20
}

/** The kinds that concern the whole market when no coin is named. */
const MARKET_WIDE: ReadonlySet<NewsEventType> = new Set(['MACRO', 'REGULATION', 'ETF'])

/** Fresh in its first hour; from there worth less, down to four tenths at a day, and no less. */
function freshness(ageSeconds: number): number {
  if (ageSeconds <= 3600) return 1
  return Math.max(0.4, 1 - (0.6 * (ageSeconds - 3600)) / (86_400 - 3600))
}

/** A story read: its coins, its kind, its impact and whether it is old news. */
export function readStory(story: FeedStory, dictionary: AssetDictionary, credibility: number, nowSec: number): Omit<ReadStory, 'alsoIn'> {
  const assets = storyAssets(story, dictionary)
  const eventType = eventTypeOf(story)
  const marketWide = assets.length === 0 && MARKET_WIDE.has(eventType)
  const relation = assets.some((asset) => asset.relationship === 'DIRECT') ? 1 : assets.length > 0 ? 0.6 : marketWide ? 0.8 : 0.4
  const impact = Math.round(TYPE_WEIGHT[eventType] * relation * credibility * freshness(Math.max(0, nowSec - story.publishedAt)))
  return { ...story, assets, marketWide, eventType, credibility, impact, stale: story.seenAt - story.publishedAt > STALE_STORY_SECONDS }
}

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'as', 'at', 'by', 'is', 'are', 'its', 'it', 'from', 'after', 'over', 'into', 'this', 'that', 'be', 'has', 'have', 'will', 'says', 'said'])

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9$ ]+/g, ' ')
      .split(/\s+/)
      .filter((word) => word.length > 2 && !STOPWORDS.has(word))
  )
}

/** How alike two titles are: the words they share over the words either has. */
export function titleSimilarity(a: string, b: string): number {
  const left = titleWords(a)
  const right = titleWords(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const word of left) if (right.has(word)) shared++
  return shared / (left.size + right.size - shared)
}

/** Stories newest first, each carried once: a story another source published first, within six
 * hours and with a title this alike, is folded into it and named in its `alsoIn`. */
export function foldSameStories(stories: Omit<ReadStory, 'alsoIn'>[]): ReadStory[] {
  const byTime = [...stories].sort((a, b) => a.publishedAt - b.publishedAt || a.id.localeCompare(b.id))
  const kept: ReadStory[] = []
  for (const story of byTime) {
    const same = kept.find(
      (earlier) => earlier.source !== story.source && story.publishedAt - earlier.publishedAt <= SAME_STORY_SECONDS && titleSimilarity(earlier.title, story.title) >= SAME_STORY_SIMILARITY
    )
    if (same !== undefined) {
      if (!same.alsoIn.includes(story.sourceName)) same.alsoIn.push(story.sourceName)
      continue
    }
    kept.push({ ...story, alsoIn: [] })
  }
  return kept.sort((a, b) => b.publishedAt - a.publishedAt || a.id.localeCompare(b.id))
}

// ---------------------------------------------------------------------------------------------
// What the price did.

export type ReactionVerdict = 'CONFIRMED' | 'AGAINST' | 'NONE' | 'PENDING'

export interface StoryReaction {
  storyId: string
  ticker: string
  symbol: string
  eventType: NewsEventType
  publishedAt: number
  /** The move over the fifteen minutes before the minute it was published in, in percent. */
  before15mPct: number | null
  /** The moves from the close of the minute it was published in. */
  after: { m5: number | null; m15: number | null; h1: number | null; h4: number | null }
  /** Volume in the fifteen minutes after, against the mean fifteen minutes of the hour before. */
  volumeRatio: number | null
  verdict: ReactionVerdict
  /** It had already moved its way before it was published. */
  pricedIn: boolean
  measuredAt: number
}

/** A move this large in the fifteen minutes after is a reaction. */
const REACTION_PCT = 1
/** With no direction to expect, a reaction is this large a move on this much volume. */
const UNDIRECTED_REACTION_PCT = 1.5
const UNDIRECTED_VOLUME = 2

/** What a coin did around a story, from its 1-minute candles, oldest first; those not yet closed at
 * `nowSec` are not read. */
export function storyReaction(input: { storyId: string; ticker: string; symbol: string; eventType: NewsEventType; publishedAt: number; bars: Candle[]; nowSec: number }): StoryReaction {
  const closed = input.bars.filter((bar) => bar.time + 60 <= input.nowSec)
  const byTime = new Map(closed.map((bar) => [bar.time, bar]))
  const minute = Math.floor(input.publishedAt / 60) * 60
  const base = byTime.get(minute)?.close ?? null
  const at = (offsetMinutes: number): number | null => byTime.get(minute + offsetMinutes * 60)?.close ?? null
  const change = (to: number | null, from: number | null): number | null => (to === null || from === null || !(from > 0) ? null : (to / from - 1) * 100)
  const after = { m5: change(at(5), base), m15: change(at(15), base), h1: change(at(60), base), h4: change(at(240), base) }
  const before15mPct = change(base, at(-15))
  const volumeOver = (fromMinute: number, minutes: number): number | null => {
    let sum = 0
    for (let offset = 0; offset < minutes; offset++) {
      const bar = byTime.get(minute + (fromMinute + offset) * 60)
      if (bar === undefined) return null
      sum += bar.volume
    }
    return sum
  }
  const afterVolume = volumeOver(1, 15)
  const hourBefore = volumeOver(-60, 60)
  const volumeRatio = afterVolume === null || hourBefore === null || !(hourBefore > 0) ? null : afterVolume / (hourBefore / 4)
  const direction = expectedDirection(input.eventType)
  let verdict: ReactionVerdict
  if (after.m15 === null) verdict = 'PENDING'
  else if (direction === null) verdict = Math.abs(after.m15) >= UNDIRECTED_REACTION_PCT && (volumeRatio ?? 0) >= UNDIRECTED_VOLUME ? 'CONFIRMED' : 'NONE'
  else {
    const signed = direction === 'up' ? after.m15 : -after.m15
    verdict = signed >= REACTION_PCT ? 'CONFIRMED' : signed <= -REACTION_PCT ? 'AGAINST' : 'NONE'
  }
  const pricedIn = direction !== null && before15mPct !== null && (direction === 'up' ? before15mPct : -before15mPct) >= REACTION_PCT
  return {
    storyId: input.storyId,
    ticker: input.ticker,
    symbol: input.symbol,
    eventType: input.eventType,
    publishedAt: input.publishedAt,
    before15mPct,
    after,
    volumeRatio,
    verdict,
    pricedIn,
    measuredAt: input.nowSec
  }
}

export interface TypeImpact {
  eventType: NewsEventType
  stories: number
  /** Whether there are enough for the figures below to be shown. */
  enough: boolean
  /** The median move after, at each horizon, in percent. Null below IMPACT_MIN_STORIES. */
  medianPct: { m5: number | null; m15: number | null; h1: number | null; h4: number | null } | null
  /** Of them, the share up an hour after. Null below IMPACT_MIN_STORIES. */
  shareUp1h: number | null
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** What each kind of news did, from the reactions measured to their end. Kinds with fewer than
 * IMPACT_MIN_STORIES are listed with their count and no figures. */
export function impactByType(reactions: readonly StoryReaction[]): TypeImpact[] {
  const final = reactions.filter((reaction) => reaction.after.h4 !== null)
  const kinds = [...new Set(final.map((reaction) => reaction.eventType))]
  return kinds
    .map((eventType) => {
      const rows = final.filter((reaction) => reaction.eventType === eventType)
      const enough = rows.length >= IMPACT_MIN_STORIES
      const pick = (key: keyof StoryReaction['after']): number | null => median(rows.map((row) => row.after[key]).filter((value): value is number => value !== null))
      const hour = rows.map((row) => row.after.h1).filter((value): value is number => value !== null)
      return {
        eventType,
        stories: rows.length,
        enough,
        medianPct: enough ? { m5: pick('m5'), m15: pick('m15'), h1: pick('h1'), h4: pick('h4') } : null,
        shareUp1h: enough && hour.length > 0 ? hour.filter((value) => value > 0).length / hour.length : null
      }
    })
    .sort((a, b) => b.stories - a.stories || a.eventType.localeCompare(b.eventType))
}

/** How a kind of news reads in words. */
export function describeEventType(type: NewsEventType): string {
  const words: Record<NewsEventType, string> = {
    HACK: 'Hack or exploit',
    DELISTING: 'Delisting or warning',
    LISTING: 'Listing',
    ETF: 'ETF',
    REGULATION: 'Regulation',
    TOKEN_UNLOCK: 'Token unlock',
    MACRO: 'Macro',
    UPGRADE: 'Upgrade',
    PARTNERSHIP: 'Partnership',
    OTHER: 'Other'
  }
  return words[type]
}
