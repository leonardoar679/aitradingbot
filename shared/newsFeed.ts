import type { Candle } from './ipc'
import { ENGLISH, msg, type I18n } from './i18n/translate'

// NEWS FROM THE WHOLE MARKET, MATCHED TO COINS AND JUDGED BY WHAT THE PRICE DID (the second V3
// document, §11-14 and §53).
//
// The app already reads Binance's own announcements (shared/news.ts). Since 6 October 2026 it also
// reads four free media feeds -- CoinDesk, Cointelegraph, Decrypt and The Block -- with no key and
// at no cost (the user chose free sources; CoinGecko's news needs a paid plan). The main process's
// newsFeedService.ts reads them every minute; this file is the arithmetic on what it read:
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

/** feed-v4 since 9 November 2026: a breach that reports data alone is no theft, and a theft named as one already known
 * ("the $270 million Drift hack") is a follow-up (shared/incidents.ts). feed-v5 since 16 November 2026: a victim named
 * with a word of its part before its loss ("Kava Lend loses") is named, and a theft told as an authority's word ("..., DOJ
 * Says") is its attribution. */
export const NEWS_FEED_VERSION = 'feed-v5'
/** The media feeds are read every minute (V9 Stage 2's line, from three before): a theft's first report is told within
 * a minute of its feed carrying it. A read asks each feed only for what changed (its ETag or Last-Modified), so an
 * unchanged feed answers 304 with nothing. */
export const FEED_READ_MS = 60_000
/** What the price did around a story is measured every three minutes, as when the feeds were read so. */
export const REACTIONS_EVERY_MS = 3 * 60_000
/** Stories kept on screen and in memory: a week of them. */
export const FEED_KEEP_SECONDS = 7 * 86_400
/** A story published this long before it was first read is old news reposted, or a backlog. */
export const STALE_STORY_SECONDS = 86_400
/** Two titles this alike within this long are one story from several sources. */
export const SAME_STORY_SIMILARITY = 0.6
export const SAME_STORY_SECONDS = 6 * 3600
/** A story whose title is this alike one of the previous seven days', beyond the six hours the same
 * story is folded within, is recycled news (since 8 October 2026): its impact is halved, and no
 * alert is raised HIGH on it. */
export const REPEAT_SECONDS = 7 * 86_400
export const REPEAT_IMPACT_FACTOR = 0.5
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

/** The kinds of news (the V6 document, §19). Since 13 October 2026 (feed-v2, V6 Stage 8) an exploit is
 * told apart from a hack, a mainnet from an upgrade, and airdrops, funding, liquidations and exchange
 * outages have kinds of their own. Since 6 November 2026 (feed-v3, V9 Stage 2) a hack or an exploit is read
 * from the headline alone, and its victim and whether it is the first report from shared/incidents.ts. */
export type NewsEventType =
  | 'HACK'
  | 'EXPLOIT'
  | 'DELISTING'
  | 'LISTING'
  | 'ETF'
  | 'REGULATION'
  | 'TOKEN_UNLOCK'
  | 'MACRO'
  | 'MAINNET'
  | 'UPGRADE'
  | 'AIRDROP'
  | 'FUNDING'
  | 'LIQUIDATION'
  | 'EXCHANGE_OUTAGE'
  | 'PARTNERSHIP'
  | 'OTHER'

/** A story as the history keeps it for measuring what news did (shared/aiHelp.ts): the coins it
 * named, when, its kind, and whether it was old news when read. */
export interface StoryMark {
  id: string
  publishedAt: number
  tickers: string[]
  eventType: NewsEventType
  stale: boolean
}

/** The longest span the history is read over at once: a little more than the live board's month. */
export const STORY_HISTORY_MAX_SECONDS = 35 * 86_400

/** A story read, as a mark. */
export function storyMark(story: Pick<ReadStory, 'id' | 'publishedAt' | 'assets' | 'eventType' | 'stale'>): StoryMark {
  return { id: story.id, publishedAt: story.publishedAt, tickers: story.assets.map((asset) => asset.ticker), eventType: story.eventType, stale: story.stale }
}
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
  /** Set at read time since 8 October 2026: its title is like one of the previous seven days',
   * beyond the six hours the same story is folded within. Recycled news. */
  repeat?: boolean
}

/** Another source that carried a story already on file: written at read time since 8 October 2026
 * as a record of its own in the feed file, not as a story. `storyId` is the story it is part of. */
export interface StorySource {
  kind: 'source'
  storyId: string
  source: string
  sourceName: string
  url: string
  publishedAt: number
  seenAt: number
}

export function isStorySource(value: unknown): value is StorySource {
  const row = value as Partial<StorySource> | null
  return typeof row === 'object' && row !== null && row.kind === 'source' && typeof row.storyId === 'string' && typeof row.source === 'string' && typeof row.sourceName === 'string' && typeof row.publishedAt === 'number'
}

export interface StoryAsset {
  ticker: string
  relationship: Relationship
}

/** What a hack or exploit story says of its incident (V9 Stage 2, 6 November 2026; read by shared/incidents.ts).
 * Of the 24 loud news notices of the two archives on file -- the user's profile and V8's three-day run -- only a
 * few told a new theft: the rest told laundering, refunds, roundups and opinion of one already told, named the coins
 * an attacker took as the story's coins ("Binance hackers move 81% of stolen Solana" as SOL), or read a company's
 * name as a coin's ("Mercado Bitcoin" as BTC). So a hack is read for its first report, its victim and its sum. */
export interface StoryIncident {
  /** 'first': the first report on file of a theft of this victim, or of this sum where no victim is named, in the
   * week kept, with no word of its aftermath. 'follow-up': all else -- told before, or told as laundering, a refund,
   * a recovery, a roundup, an opinion, a denial, its attribution or its trial. */
  report: 'first' | 'follow-up'
  /** Why a follow-up is one: the words, or the report before it. Null for a first report. */
  why: string | null
  /** Who lost the funds, by the name the tables give it (shared/incidents.ts); null where the headline names none
   * they know. */
  victim: string | null
  /** The victim's own token where it has one traded on Binance against USDT and the headline names the victim at
   * its loss, not only somewhere in it. */
  victimToken: string | null
  /** A hack of one of the largest exchanges, named at its loss: it concerns the whole market. */
  topExchange: boolean
  /** The largest sum the headline names, in dollars; null where it names none. */
  amountUsd: number | null
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
  /** The other sources that carried the same story: those recorded with it, and those folded in
   * when it is shown. */
  alsoIn: string[]
  /** The sources recorded with it (StorySource), since 8 October 2026. */
  sources: StorySource[]
  /** A hack or exploit story's incident (shared/incidents.ts, since 6 November 2026); null for a story that reports
   * no theft; absent where it was not read for one. */
  incident?: StoryIncident | null
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

/** Companies whose names hold a coin's name and are not about the coin (V9 Stage 2, 6 November 2026): "Mercado
 * Bitcoin", Brazil's largest exchange, named BTC in its hack of 2 November and raised a CRITICAL notice for whoever
 * held bitcoin. Their stretch of a text names no coin, by name or by ticker. */
export const COMPANY_NAMES: readonly string[] = [
  'mercado bitcoin',
  'dmm bitcoin',
  'bitcoin depot',
  'bitcoin suisse',
  'bitcoin.com',
  'bitcoin magazine',
  'swan bitcoin',
  'bitcoin well',
  'bitcoin ira',
  'bitcoin of america',
  'btc markets',
  'ether.fi',
  'etherfi'
]

/** Tickers that are also words or common abbreviations: counted only as $TICKER or by name. */
export const WORD_TICKERS: ReadonlySet<string> = new Set([
  'AI', 'ONE', 'GAS', 'NOT', 'ACT', 'BIG', 'HOT', 'KEY', 'UP', 'IO', 'OM', 'WIN', 'FUN', 'SUN', 'PEOPLE', 'TRUMP', 'MEME', 'NFT', 'DATA', 'REAL',
  'GAME', 'MOVE', 'BAND', 'BOND', 'COS', 'EDU', 'ID', 'LIT', 'MASK', 'PORTAL', 'RARE', 'SAFE', 'SIGN', 'USUAL', 'ZK', 'ME', 'OG', 'GO', 'CAT',
  'DOGS', 'PUMP', 'BANK', 'BOME', 'HOOK', 'CYBER', 'HIGH', 'ALT', 'TRU', 'SCR', 'NEIRO', 'ORDI', 'SAGA', 'VIRTUAL', 'MAGIC', 'FORM', 'NIL', 'TST',
  'SHELL', 'LAYER', 'KAITO', 'RED', 'BABY', 'GPS', 'PROM', 'POWER', 'LUMIA', 'CHESS', 'ARK', 'MBOX', 'FIS', 'ACE', 'ANIME', 'USD', 'CEO', 'SEC',
  // "OP-ED", an IP address: Optimism and Story are matched by name, or as $OP and $IP.
  'OP', 'IP', 'OK', 'NEW', 'ALL', 'ANY', 'HOME', 'JOE', 'TURBO',
  // Los Angeles: "off-duty LA deputies" named Lagrange's LA in a one-hour run of the app.
  'LA',
  // The GENIUS Act, the U.S. stablecoin law, written in capitals: a pasted article named it as a coin (V8 Stage 4's check).
  'GENIUS',
  // The United States, an all-time high and real-world assets, as news writes them: Bitget lists a coin of each name, and
  // "Ripple wins final US approval" named its US as a coin beside XRP (V8 Stage 5's check).
  'US',
  'ATH',
  'RWA'
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
  // A company's name is covered before any coin's, and names none.
  const blocked: [number, number][] = []
  for (const name of COMPANY_NAMES) {
    for (const match of lower.matchAll(new RegExp(`(?<![a-z0-9])${escapeRegExp(name)}(?![a-z0-9])`, 'g'))) blocked.push([match.index ?? 0, (match.index ?? 0) + name.length])
  }
  covered.push(...blocked)
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
    const at = match.index ?? 0
    if (blocked.some(([from, to]) => at < to && at + match[0].length > from)) continue
    found.push({ ticker, at })
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
  // A theft, and a sum lost from crypto (V9 Stage 2): "EU entity suspected of losing $106 million from crypto exchange
  // accounts" was the first report of the $133M theft, and said no hack.
  [
    'HACK',
    /\b(hack(ed|er|ers|s)?|stolen|steal(s|ing)?|stole|thefts?|breach(ed)?|heist|attacker|security (incident|breach))\b|\blos(es|ing|t)\s+(more than |over |about |nearly |almost |at least )?\$[\d.,]+\s*(k|m|b|bn|million|billion)?\s+(from|in|to)\s+(crypto|wallets?|exchanges?|accounts?|hacks?|exploits?|attacks?|thefts?)\b/i
  ],
  ['EXPLOIT', /\b(exploit(ed|s|er|ers)?|drain(ed|s|er)?|flash[- ]loans?|re-?entrancy|vulnerabilit(y|ies))\b/i],
  ['DELISTING', /\b(delist(s|ed|ing)?|monitoring tag)\b/i],
  ['LISTING', /\b(will list|lists|listing|to list|launch(es)? trading|futures launch)\b/i],
  ['ETF', /\betfs?\b/i],
  ['EXCHANGE_OUTAGE', /\b(outages?|downtime|(halt(s|ed)?|suspend(s|ed)?|pause[sd]?) (all )?(withdrawals|deposits|trading)|withdrawals? (halted|suspended|paused))\b/i],
  ['LIQUIDATION', /\b(liquidat(ed|es|ion|ions)|longs? (wiped|liquidated)|shorts? (squeezed|liquidated)|margin calls?)\b/i],
  ['REGULATION', /\b(sec|cftc|regulat\w*|rules?|lawsuit|sues?|sued|court|bans?|banned|legislat\w*|senate|congress|licen[cs]e[sd]?|fined?|sanction\w*)\b/i],
  ['TOKEN_UNLOCK', /\bunlock(s|ed|ing)?\b/i],
  ['AIRDROP', /\bairdrop(s|ped|ping)?\b/i],
  // Not "treasury" alone: in this news it is mostly a company's coins, not the bond market.
  ['MACRO', /\b(fed|fomc|inflation|cpi|ppi|rate cuts?|interest rates?|jobs report|payrolls|tariffs?|recession|treasury yields?|powell)\b/i],
  ['MAINNET', /\b(mainnet|main net)\b/i],
  ['UPGRADE', /\b(upgrade[sd]?|hard ?fork|testnet)\b/i],
  // "Raises" alone is a central bank's rates as often as a round; a sum after it is a round.
  ['FUNDING', /(\braise[sd]? \$|\bfunding round\b|\bseed round\b|\bseries [a-d]\b)/i],
  ['PARTNERSHIP', /\b(partner(s|ship|ships|ed)?|collaborat\w*|integrat\w*|teams? up)\b/i]
]

/** A hack or an exploit is one only where its headline says so (feed-v3, V9 Stage 2): a summary that mentions one
 * is mostly a story of something else told after it -- "Coinbase hit with 50% price target cut" over "fallout from
 * the Binance hack". */
const HEADLINE_KINDS: ReadonlySet<NewsEventType> = new Set(['HACK', 'EXPLOIT'])
/** Money leaving a fund is a drain, not a theft: a headline of an ETF's or an exchange's outflows that says "drain"
 * tells no exploit. (On 18 October 2026 "Bitcoin ETFs Shed Nearly $1 Billion in Two Weeks" raised a CRITICAL exploit
 * notice from "a $681.1 million drain" in its summary, which the headline rule alone now leaves out.) */
const OUTFLOW_WORDS = /\b(etfs?|outflows?|inflows?|redemptions?)\b/i
const DRAIN_WORDS = /\bdrain(ed|s|er)?\b/gi

/** The kind of news: the first of the rules above the title and summary meet -- the title alone for a hack or an
 * exploit, where a fund's outflow drains nothing; Binance's own kind where the story is an announcement. */
export function eventTypeOf(story: Pick<FeedStory, 'title' | 'summary' | 'binanceCategory'>): NewsEventType {
  if (story.binanceCategory === 'DELISTING' || story.binanceCategory === 'MONITORING_TAG') return 'DELISTING'
  if (story.binanceCategory === 'SPOT_LISTING' || story.binanceCategory === 'FUTURES_LAUNCH') return 'LISTING'
  const text = `${story.title} ${story.summary}`
  const meets = (type: NewsEventType, rule: RegExp): boolean => {
    if (!HEADLINE_KINDS.has(type)) return rule.test(text)
    return rule.test(type === 'EXPLOIT' && OUTFLOW_WORDS.test(story.title) ? story.title.replace(DRAIN_WORDS, ' ') : story.title)
  }
  return TYPE_RULES.find(([type, rule]) => meets(type, rule))?.[0] ?? 'OTHER'
}

/** Which way a kind of news would move its coin, where it says. */
export function expectedDirection(type: NewsEventType): 'up' | 'down' | null {
  if (type === 'HACK' || type === 'EXPLOIT' || type === 'DELISTING') return 'down'
  if (type === 'LISTING' || type === 'ETF' || type === 'MAINNET' || type === 'UPGRADE' || type === 'FUNDING' || type === 'PARTNERSHIP') return 'up'
  return null
}

const TYPE_WEIGHT: Record<NewsEventType, number> = {
  HACK: 90,
  EXPLOIT: 90,
  DELISTING: 85,
  LISTING: 75,
  ETF: 70,
  EXCHANGE_OUTAGE: 65,
  REGULATION: 60,
  TOKEN_UNLOCK: 55,
  MACRO: 55,
  LIQUIDATION: 55,
  MAINNET: 50,
  UPGRADE: 45,
  AIRDROP: 45,
  FUNDING: 40,
  PARTNERSHIP: 40,
  OTHER: 20
}

/** The kinds that concern the whole market when no coin is named. */
const MARKET_WIDE: ReadonlySet<NewsEventType> = new Set(['MACRO', 'REGULATION', 'ETF', 'LIQUIDATION', 'EXCHANGE_OUTAGE'])

/** Fresh in its first hour; from there worth less, down to four tenths at a day, and no less. */
function freshness(ageSeconds: number): number {
  if (ageSeconds <= 3600) return 1
  return Math.max(0.4, 1 - (0.6 * (ageSeconds - 3600)) / (86_400 - 3600))
}

/** How much a story might matter, 0 to 100: its kind's weight, how directly it names a coin (or the whole market),
 * its source's credibility, how fresh it is, and half of it for recycled news. */
export function impactOf(story: Pick<ReadStory, 'eventType' | 'assets' | 'marketWide' | 'credibility' | 'publishedAt'> & Pick<FeedStory, 'repeat'>, nowSec: number): number {
  const relation = story.assets.some((asset) => asset.relationship === 'DIRECT') ? 1 : story.assets.length > 0 ? 0.6 : story.marketWide ? 0.8 : 0.4
  // Recycled news is half the news: it was told once already.
  const recycled = story.repeat === true ? REPEAT_IMPACT_FACTOR : 1
  return Math.round(TYPE_WEIGHT[story.eventType] * relation * story.credibility * freshness(Math.max(0, nowSec - story.publishedAt)) * recycled)
}

/** A story read: its coins, its kind, its impact and whether it is old news. */
export function readStory(story: FeedStory, dictionary: AssetDictionary, credibility: number, nowSec: number): Omit<ReadStory, 'alsoIn' | 'sources'> {
  const assets = storyAssets(story, dictionary)
  const eventType = eventTypeOf(story)
  const marketWide = assets.length === 0 && MARKET_WIDE.has(eventType)
  const impact = impactOf({ ...story, assets, eventType, marketWide, credibility }, nowSec)
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

/** Whether two stories are the same story from two sources: different sources, within six hours of
 * each other, with titles this alike. */
export function isSameStory(a: Pick<FeedStory, 'source' | 'publishedAt' | 'title'>, b: Pick<FeedStory, 'source' | 'publishedAt' | 'title'>): boolean {
  return a.source !== b.source && Math.abs(a.publishedAt - b.publishedAt) <= SAME_STORY_SECONDS && titleSimilarity(a.title, b.title) >= SAME_STORY_SIMILARITY
}

/** Whether `story` recycles `earlier`: a title this alike, published more than six hours and at
 * most seven days after it. From any source, its own included. */
export function isRepeatOf(earlier: Pick<FeedStory, 'publishedAt' | 'title'>, story: Pick<FeedStory, 'publishedAt' | 'title'>): boolean {
  const gap = story.publishedAt - earlier.publishedAt
  return gap > SAME_STORY_SECONDS && gap <= REPEAT_SECONDS && titleSimilarity(earlier.title, story.title) >= SAME_STORY_SIMILARITY
}

/** Stories newest first, each carried once: a story another source published first, within six
 * hours and with a title this alike, is folded into it and named in its `alsoIn`. The sources
 * recorded with a story (since 8 October 2026) are set on it and named there too; folding at this
 * point is for records written before them. */
export function foldSameStories(stories: Omit<ReadStory, 'alsoIn' | 'sources'>[], sources: readonly StorySource[] = []): ReadStory[] {
  const byTime = [...stories].sort((a, b) => a.publishedAt - b.publishedAt || a.id.localeCompare(b.id))
  const kept: ReadStory[] = []
  for (const story of byTime) {
    const same = kept.find((earlier) => story.publishedAt >= earlier.publishedAt && isSameStory(earlier, story))
    if (same !== undefined) {
      if (!same.alsoIn.includes(story.sourceName)) same.alsoIn.push(story.sourceName)
      continue
    }
    const own = sources.filter((source) => source.storyId === story.id)
    const alsoIn: string[] = []
    for (const source of own) if (!alsoIn.includes(source.sourceName)) alsoIn.push(source.sourceName)
    kept.push({ ...story, alsoIn, sources: own })
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
  /** The moves from the close of the minute it was published in; the minute after since 13 October
   * 2026 (V6 Stage 8; absent on a reaction measured before). */
  after: { m1?: number | null; m5: number | null; m15: number | null; h1: number | null; h4: number | null }
  /** Volume in the fifteen minutes after, against the mean fifteen minutes of the hour before. */
  volumeRatio: number | null
  verdict: ReactionVerdict
  /** It had already moved its way before it was published. */
  pricedIn: boolean
  measuredAt: number
  /** How far the price went up and down within an hour and within four, from the close of the minute
   * it was published in, in percent (since 8 October 2026; absent on a reaction measured before).
   * Null at a horizon the minutes do not reach. */
  excursion?: StoryExcursion
}

export interface StoryExcursion {
  best1hPct: number | null
  worst1hPct: number | null
  best4hPct: number | null
  worst4hPct: number | null
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
  const after = { m1: change(at(1), base), m5: change(at(5), base), m15: change(at(15), base), h1: change(at(60), base), h4: change(at(240), base) }
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
  // The excursions: the highest high and the lowest low of the minutes after, to each horizon,
  // only where the minutes reach it.
  const excursionTo = (minutesAfter: number): { best: number | null; worst: number | null } => {
    if (base === null || !(base > 0)) return { best: null, worst: null }
    let high = Number.NEGATIVE_INFINITY
    let low = Number.POSITIVE_INFINITY
    for (let offset = 1; offset <= minutesAfter; offset++) {
      const bar = byTime.get(minute + offset * 60)
      if (bar === undefined) return { best: null, worst: null }
      high = Math.max(high, bar.high)
      low = Math.min(low, bar.low)
    }
    return { best: (high / base - 1) * 100, worst: (low / base - 1) * 100 }
  }
  const hour = excursionTo(60)
  const fourHours = excursionTo(240)
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
    measuredAt: input.nowSec,
    excursion: { best1hPct: hour.best, worst1hPct: hour.worst, best4hPct: fourHours.best, worst4hPct: fourHours.worst }
  }
}

export interface TypeImpact {
  eventType: NewsEventType
  stories: number
  /** Whether there are enough for the figures below to be shown. */
  enough: boolean
  /** The median move after, at each horizon, in percent. Null below IMPACT_MIN_STORIES. */
  medianPct: { m1: number | null; m5: number | null; m15: number | null; h1: number | null; h4: number | null } | null
  /** Of them, the share up an hour after. Null below IMPACT_MIN_STORIES. */
  shareUp1h: number | null
  /** The median excursions, from the reactions that carry them (since 8 October 2026). Null below
   * IMPACT_MIN_STORIES of those. */
  excursions: StoryExcursion | null
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
      const pick = (key: keyof StoryReaction['after']): number | null => median(rows.map((row) => row.after[key]).filter((value): value is number => typeof value === 'number'))
      const hour = rows.map((row) => row.after.h1).filter((value): value is number => value !== null)
      const measured = rows.map((row) => row.excursion).filter((value): value is StoryExcursion => value !== undefined)
      const pickExcursion = (key: keyof StoryExcursion): number | null => median(measured.map((row) => row[key]).filter((value): value is number => value !== null))
      return {
        eventType,
        stories: rows.length,
        enough,
        medianPct: enough ? { m1: pick('m1'), m5: pick('m5'), m15: pick('m15'), h1: pick('h1'), h4: pick('h4') } : null,
        shareUp1h: enough && hour.length > 0 ? hour.filter((value) => value > 0).length / hour.length : null,
        excursions:
          measured.length >= IMPACT_MIN_STORIES
            ? { best1hPct: pickExcursion('best1hPct'), worst1hPct: pickExcursion('worst1hPct'), best4hPct: pickExcursion('best4hPct'), worst4hPct: pickExcursion('worst4hPct') }
            : null
      }
    })
    .sort((a, b) => b.stories - a.stories || a.eventType.localeCompare(b.eventType))
}

const signedPct = (value: number | null): string => (value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`)

/** One sentence on a kind's excursions, once thirty reactions carry them; null before. */
export function describeTypeExcursions(row: Pick<TypeImpact, 'eventType' | 'excursions'>): string | null {
  if (row.excursions === null) return null
  const kind = describeEventType(row.eventType).toLowerCase()
  return `Within an hour of a ${kind} story, the median worst move was ${signedPct(row.excursions.worst1hPct)} and the median best ${signedPct(row.excursions.best1hPct)}; within four hours, ${signedPct(row.excursions.worst4hPct)} and ${signedPct(row.excursions.best4hPct)}.`
}

/** How a kind of news reads in words. */
const EVENT_TYPE_NAMES: Record<NewsEventType, string> = {
  HACK: msg('Hack'),
  EXPLOIT: msg('Exploit'),
  DELISTING: msg('Delisting or warning'),
  LISTING: msg('Listing'),
  ETF: msg('ETF'),
  REGULATION: msg('Regulation'),
  TOKEN_UNLOCK: msg('Token unlock'),
  MACRO: msg('Macro'),
  MAINNET: msg('Mainnet'),
  UPGRADE: msg('Upgrade'),
  AIRDROP: msg('Airdrop'),
  FUNDING: msg('Funding'),
  LIQUIDATION: msg('Liquidations'),
  EXCHANGE_OUTAGE: msg('Exchange outage'),
  PARTNERSHIP: msg('Partnership'),
  OTHER: msg('Other')
}

/** A story's kind by name, in a language: English unless handed another (V6 Stage 14). */
export function describeEventType(type: NewsEventType, { t }: I18n = ENGLISH): string {
  const name = EVENT_TYPE_NAMES[type]
  return name === undefined ? type : t(name)
}

const STORY_KIND_WORDS: Record<NewsEventType, string> = {
  HACK: msg('hack'),
  EXPLOIT: msg('exploit'),
  DELISTING: msg('delisting'),
  LISTING: msg('listing'),
  ETF: msg('ETF@@a kind of story'),
  REGULATION: msg('regulation'),
  TOKEN_UNLOCK: msg('token unlock'),
  MACRO: msg('macro'),
  MAINNET: msg('mainnet'),
  UPGRADE: msg('upgrade'),
  AIRDROP: msg('airdrop'),
  FUNDING: msg('funding'),
  LIQUIDATION: msg('liquidation'),
  EXCHANGE_OUTAGE: msg('exchange outage'),
  PARTNERSHIP: msg('partnership'),
  OTHER: msg('other')
}

/** A story's kind inside a sentence -- "a listing story" -- in a language. */
export function storyKindWord(type: NewsEventType, { t }: I18n = ENGLISH): string {
  const word = STORY_KIND_WORDS[type]
  return word === undefined ? type.toLowerCase() : t(word)
}
