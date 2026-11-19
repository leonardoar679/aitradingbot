import victimsFile from './incidentVictims.json'
import type { VictimRow } from './incidentVictimsBuild'
import { impactOf, type AssetDictionary, type ReadStory, type StoryAsset, type StoryIncident } from './newsFeed'

// A HACK, READ FOR ITS INCIDENT (V9 Stage 2, 6 November 2026).
//
// The news reader (shared/newsFeed.ts) tells a hack story by its words and names the coins it names. On the two
// alert archives on file -- the user's profile from 14 October and V8's three-day run from 29 October -- that made 24
// loud notices (HIGH or CRITICAL) of news, and nearly all were wrong:
//   - follow-ups of a theft told already: laundering ("Binance hackers move 81% of stolen Solana"), refunds and
//     recoveries ("Liquid's bitcoin IOUs are fully backed again after a $320 million exploit", told three times),
//     roundups ("Morning Minute: Tom Lee Calls the Binance Hack Bullish for Ethereum") and opinion;
//   - the coins an attacker took or the chain a theft ran on, as the story's coins (ETH for Cysic's bridge, SOL);
//   - a company's name read as a coin's: "Mercado Bitcoin" as BTC, CRITICAL for whoever held bitcoin.
// The first report of Binance's $6.4 billion theft (29 October, 21:36 UTC) came while the user's app was closed;
// open, it would have raised nothing, since the old reading gave it no coin.
//
// SO A HACK STORY IS READ FOR FOUR THINGS, FROM ITS HEADLINE:
//   1. whether it reports a theft at all: a word of a loss in the headline's main clause -- not in a clause of
//      "days after ..." that dates an old one;
//   2. its victim: who lost the funds, by the names of the exchanges below and of the protocols and chains whose
//      own token trades on Binance (shared/incidentVictims.json, compiled from DefiLlama by
//      research/fetch-incident-victims.ts; read again every week by the app, setVictims). A victim named at its loss ("Binance drained", "the Binance hack",
//      "Initia halts network") is read tightly, and only then its token is the story's coin and a top exchange's
//      hack concerns the whole market; one named only somewhere in the headline is read loosely;
//   3. the sum: the largest dollar amount of the main clause;
//   4. whether it is the first report: a headline of the aftermath -- laundering, a refund or recovery, an
//      attribution, a trial, a roundup, an opinion, a denial, a rising estimate -- is a follow-up, unless it also
//      says the loss as news ("X hacked for $50M, pledges to cover losses"); and a theft of a victim, or of a sum
//      where no victim is named, already reported in the week the feed keeps is a follow-up whatever it says.
// The coins an incident story names other than its victim's token are kept as mentioned, never as its subject.
//
// WHAT IT CANNOT DO, SAID: it reads English headlines by rules. A victim the tables do not know (Cysic, Qubic,
// Polymarket) is no victim to it, and such a theft is followed up by its sum alone; a story whose headline tells
// its theft in other words is missed. Its precision and recall are registered as V9-NEWS-CLASS and judged on the
// V9 run's stories, read by hand, not on the archives it was designed on.
//
// IT READS. Nothing here asks a model, places anything or holds a key.

export const INCIDENT_VERSION = 'incidents-v1'

export const INCIDENT_LINES = {
  /** A first report of a theft this large is HIGH, whoever lost it. */
  highUsd: 100_000_000,
  /** A first report naming at least this much is WATCH, where nothing else makes it one. */
  watchUsd: 1_000_000,
  /** A victim, or a sum, reported within this long before is the same incident told again: the week the feed keeps. */
  knownSeconds: 7 * 86_400,
  /** One loud notice per victim, or per sum, within this long (shared/alerts.ts). */
  loudOnceSeconds: 86_400
} as const

export interface Exchange {
  name: string
  /** The names a headline calls it by, in lower case. */
  names: readonly string[]
  /** Its own token, where it has one. */
  token: string | null
  /** One of the largest exchanges: a hack of it concerns the whole market. */
  top: boolean
}

/** The exchanges, by hand: the largest by spot volume and custody are the top ones. "Gate" and "Gemini" are
 * everyday names (a gate; Google's model), read only with "exchange" or their domain. */
export const EXCHANGES: readonly Exchange[] = [
  { name: 'Binance', names: ['binance', 'binance.us'], token: 'BNB', top: true },
  { name: 'Coinbase', names: ['coinbase'], token: null, top: true },
  { name: 'OKX', names: ['okx'], token: 'OKB', top: true },
  { name: 'Bybit', names: ['bybit'], token: null, top: true },
  { name: 'Upbit', names: ['upbit'], token: null, top: true },
  { name: 'Kraken', names: ['kraken'], token: null, top: true },
  { name: 'Bitget', names: ['bitget'], token: 'BGB', top: true },
  { name: 'KuCoin', names: ['kucoin'], token: 'KCS', top: false },
  { name: 'Crypto.com', names: ['crypto.com'], token: 'CRO', top: false },
  { name: 'HTX', names: ['htx', 'huobi'], token: 'HT', top: false },
  { name: 'Gate', names: ['gate.io', 'gate exchange', 'exchange gate'], token: 'GT', top: false },
  { name: 'MEXC', names: ['mexc'], token: 'MX', top: false },
  { name: 'WOO X', names: ['woo x', 'woox'], token: 'WOO', top: false },
  { name: 'CoinEx', names: ['coinex'], token: 'CET', top: false },
  { name: 'Bitfinex', names: ['bitfinex'], token: 'LEO', top: false },
  { name: 'BitMart', names: ['bitmart'], token: 'BMX', top: false },
  { name: 'Bithumb', names: ['bithumb'], token: null, top: false },
  { name: 'Mercado Bitcoin', names: ['mercado bitcoin'], token: null, top: false },
  { name: 'CoinDCX', names: ['coindcx'], token: null, top: false },
  { name: 'WazirX', names: ['wazirx'], token: null, top: false },
  { name: 'Unocoin', names: ['unocoin'], token: null, top: false },
  { name: 'BtcTurk', names: ['btcturk'], token: null, top: false },
  { name: 'Bitstamp', names: ['bitstamp'], token: null, top: false },
  { name: 'Deribit', names: ['deribit'], token: null, top: false },
  { name: 'Phemex', names: ['phemex'], token: null, top: false },
  { name: 'BingX', names: ['bingx'], token: null, top: false },
  { name: 'LBank', names: ['lbank'], token: null, top: false },
  { name: 'Poloniex', names: ['poloniex'], token: null, top: false },
  { name: 'DMM Bitcoin', names: ['dmm bitcoin'], token: null, top: false },
  { name: 'Coincheck', names: ['coincheck'], token: null, top: false },
  { name: 'bitFlyer', names: ['bitflyer'], token: null, top: false },
  { name: 'Indodax', names: ['indodax'], token: null, top: false },
  { name: 'Nobitex', names: ['nobitex'], token: null, top: false },
  { name: 'Gemini', names: ['gemini exchange'], token: null, top: false }
]

/** A name a victim is read by. */
export interface VictimName {
  /** In lower case, as a headline's lower case holds it. */
  name: string
  /** How a notice names it: the exchange's own name, or the protocol's as the headline wrote it. */
  label: string | null
  token: string | null
  kind: 'exchange' | 'protocol' | 'chain'
  top: boolean
}

/** The committed table (shared/incidentVictims.json) and the day its lists were read. */
export const COMMITTED_VICTIMS: readonly VictimRow[] = victimsFile.victims as unknown as VictimRow[]
export const COMMITTED_VICTIMS_READ_AT: string = victimsFile.readAt

/** The names: every exchange's, then the protocols' and chains' from the compiled file, an exchange's name first. */
export function victimNames(rows: readonly VictimRow[] = COMMITTED_VICTIMS): VictimName[] {
  const names: VictimName[] = EXCHANGES.flatMap((exchange) => exchange.names.map((name) => ({ name, label: exchange.name, token: exchange.token, kind: 'exchange' as const, top: exchange.top })))
  const taken = new Set(names.map((entry) => entry.name))
  for (const [name, token, kind] of rows) {
    if (taken.has(name)) continue
    taken.add(name)
    names.push({ name, label: null, token, kind: kind === 'chain' ? 'chain' : 'protocol', top: false })
  }
  // Longest first, so that "aave v3" is read before "aave" and a name inside another is not read again.
  return names.sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name))
}

let NAMES = victimNames()

/** The table the stories are read by from now on: the app's weekly reading of DefiLlama's lists
 * (the main process's incidentVictimsService.ts), or, given null, the committed one. */
export function setVictims(rows: readonly VictimRow[] | null): void {
  NAMES = victimNames(rows ?? COMMITTED_VICTIMS)
}

// ---------------------------------------------------------------------------------------------
// The words.

/** A loss: a theft, an attack, a breach, or a sum lost; since 19 November 2026 also funds moved out unasked, said as
 * transfers that are suspect or unauthorized, or outgoing ones flagged (Unocoin's, missed in v9-7d's fourth try). */
const LOSS =
  /\b(hack(s|ed|er|ers|ing)?|exploit(s|ed|er|ers)?|drain(s|ed|er|ing)?|stolen|steal(s|ing)?|stole|thefts?|heist|breach(es|ed)?|attack(s|ed|er|ers)?|compromised|security incident|loot(s|ed)?|rug ?pull(s|ed)?)\b|\blos(es|ing|t)\s+(more than |over |about |nearly |almost |at least |up to )?\$|\$[\d.,]+\s*(k|m|mn|b|bn|million|billion)?\s+(loss|lost)\b|\b(suspicious|suspect|unauthori[sz]ed)\s+(\w+\s+){0,2}(transfers?|transactions?|withdrawals?|outflows?)\b|\bflags?\s+(outgoing|suspicious)\b[^,;:]{0,40}\b(transactions?|transfers?)\b/i
/** The loss said as news: what a first report says, which no word of the aftermath turns into a follow-up. */
const NEWS_OF_LOSS =
  /\b(hacked|exploited|drained|breached|robbed|suffers?|suffered|hit by|halts?|halted|paus(es|ed)|suspends?|suspended|freezes\s+(its\s+)?(chain|network|bridge|withdrawals|deposits|contracts|trading)|loses|losing|lost\s+(more than |over |about |nearly |almost )?\$|(confirms?|discloses?|reports?|admits?)\b[^,;:]{0,40}\b(loss|hack|breach|exploit|attack|theft|leak)|investigat\w*\b[^,;:]{0,30}\b(hack|breach|exploit|incident|attack|theft)|(attackers?|hackers?|exploiters?)\s+(drains?|mints?|steals?|stole|loots?|siphons?)|loots?\s+\$|stole\s+\$|steals?\s+\$|security incident|flags?\s+(outgoing|suspicious))\b/i

/** The aftermath, by what it is. A roundup is never a first report, even where it tells the loss again ("Inside the
 * largest crypto hack on record: How attackers breached Binance"); any other is one only where the headline does not
 * also say the loss as news; a denial only where it names no sum (CoinDCX confirmed a $16M loss "days after CEO called
 * breach reports a 'false alarm'"). */
const AFTERMATH: readonly [string, RegExp][] = [
  [
    'laundering',
    /\b(launder\w*|tornado cash|mixers?|loot(?!s?\s+\$)|stolen\s+(funds|crypto|assets|tokens|coins|bitcoin|btc|ether|eth|sol|solana|usdt|usdc|stablecoins)|hack(er)?s?['’]?\s+(funds|proceeds|loot)|swap(s|ped|ping)?\s+(stolen|hacked)|mov(e|es|ed|ing)\s+(\d+%\s+of\s+)?(the\s+)?(stolen|hacked)|route[sd]?\s+(funds|proceeds|loot)|exit ramps?|cash(es|ed)?\s+out)\b/i
  ],
  [
    'recovery',
    /\b(refund\w*|reimburs\w*|compensat\w*|pledges?|vows?|to cover|cover(s|ed|ing)?\s+(all\s+)?(user\s+|customer\s+|hack\s+)?loss(es)?|restor\w*|recover\w*|replenish\w*|fully backed|backed again|reopen\w*|resum\w*|restart\w*|bounty|returns?\s+(the\s+)?(stolen\s+)?funds|returned|sets? aside)\b/i
  ],
  ['attribution', /\b(tie[sd]?|blames?|blamed|attribut\w*|denies|denied|rejects?|traces?|traced)\b/i],
  ['trial', /\b(sentenced|charged|indicted|arrested|extradit\w*|jailed|pleads?|pleaded|convicted|prosecut\w*|lawsuit|sues|sued|probe|fbi|secret service)\b/i],
  [
    'roundup',
    /\b(morning minute|hodler['’]?s digest|asia express|live updates?|week ahead|everything you need to know|what we know|explained|explainer|recap|roundup|timeline|in review|report finds?|ways|q[1-4]|quarter(ly)?|so far this year)\b|^(what|why|how|inside|is|are|when|where|who)\b/i
  ],
  [
    'opinion',
    /\?|\b(bullish|bearish|calls? for|urges?|warns?|threats?|should|must|could|would|might|lessons?|czar|alliance|muted|resilien\w*|setback|shrugs? off|shakes? off|fallout|aftermath|in the wake)\b/i
  ],
  ['past', /\b(last (year|month|week)['’]?s?|(january|february|march|april|may|june|july|august|september|october|november|december)['’]s|(earlier|previous|prior|former) (hack|exploit|breach))\b/i],
  ['denial', /\b(funds? (are |were |remain )?safe|safu|not (been )?(affected|impacted|breached|hacked|compromised)|unaffected|false alarm|no evidence|cold storage|offline|out of \S+ reach)\b/i],
  ['estimate', /\b(estimate|tally|toll)\s+(rises|grows|climbs|jumps|reaches)\b|\brises to \$|\bnow (totals?|at) \$/i],
  ['continued', /\b(deepens|widens|continued|continues|contained|fresh (analysis|data)|new details|more details)\b/i]
]
/** An old theft as the cause of another story: "after a $320 million exploit", "after Coldcard's $100M wallet thefts".
 * Case matters for the name's capital. */
const ROUNDUP = (AFTERMATH.find(([reason]) => reason === 'roundup') as [string, RegExp])[1]
const AFTER_AN_OLD_ONE = /\b(after|following|since|amid|in the wake of)\s+(a|an|the|its|their|last|this|that|[A-Z][\w.&-]*['’]s)\s[^,;:]{0,50}?\b(hack|exploit|breach|heist|theft|thefts|attack|drain)/
/** A theft named as one already known: "the" and at most a sum and three words before it, where no news of a loss is
 * told ("Solana moves to scrap the transaction feature used in the $270 million Drift hack", v9-7d's third try, 9
 * November 2026, a Drift hack older than the week the feed keeps). */
const THE_KNOWN_ONE = /\bthe\s+(\$[\d.,]+\s*(k|m|mn|b|bn|million|billion)?\s+)?([\w.&'’-]+\s+){0,3}(hack|exploit|breach|heist|theft)\b/i
/** A theft told as an authority's word -- the DOJ's, the FBI's, prosecutors', a regulator's -- is its attribution or
 * its case, whatever news of a loss it carries ("North Korea Stole $400 Million in Crypto Using Deepfake Video Calls,
 * DOJ Says", told HIGH in v9-7d, 12 November 2026); in the four archives on file every such headline is aftermath. */
const AUTHORITY_SAYS = /\b(doj|fbi|prosecutors?|justice department|department of justice|treasury|ofac|police|sec|cftc|interpol|europol)\s+(says?|said|alleges?|claims?)\b/i
/** A breach that reports data alone: what was read or exposed is data -- a customer's, a card's, a password's -- with no
 * sum and no word of funds lost ("Crypto Card Provider Gnosis Pay Says Hackers Accessed Customer Data", told HIGH in
 * v9-7d's third try; its funds were unaffected). It reports no theft. */
const DATA_ONLY = /\b((customers?|users?|clients?|buyers?|personal|account|card|kyc|identity)['’]?\s+(names?|emails?|addresses|data|info|information|details|records|numbers)|exposed\s+([\w-]+\s+){0,2}(data|records|details|information)|data\s+(breach|leak)s?|password(s|\s+hashes)?|email\s+addresses|home\s+addresses)\b/i
const FUNDS_LOST = /\b(funds|drain(s|ed|ing)?|siphon(s|ed)?|heist|loss(es)?|lost|withdrawals?|assets\s+(stolen|taken|moved))\b/i

/** Words that make a first report concern crypto at all: without one, a victim or a sum, a hack of freezers or of an
 * agency's staff list raises nothing. Mining's words since 19 November 2026: "Luxor hit by AI-enabled attack that
 * redirected client hashrate", the first report of a theft of miners' rewards in v9-7d, raised nothing. */
const CRYPTO_WORDS = /\b(crypto\w*|wallets?|exchanges?|protocols?|bridges?|defi|blockchains?|chains?|tokens?|stablecoins?|onchain|on-chain|validators?|smart contracts?|hashrate|hash rate|mining pools?|miners?)\b/i

/** The headline without a clause that dates an old theft: "... days after Binance hack", "... two months after". */
export function mainClause(title: string): string {
  return title.replace(/[,;:]?\s+((\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|few|several|many)\s+)?(hours|days|weeks|months|years)\s+(after|since)\b.*$/i, '').trim()
}

/** The dollar sums a text names, in dollars, in the order named. */
export function amountsOf(text: string): number[] {
  const scale = (unit: string | undefined): number => {
    const word = (unit ?? '').toLowerCase()
    if (word === 'k' || word === 'thousand') return 1e3
    if (word === 'm' || word === 'mn' || word === 'million') return 1e6
    if (word === 'b' || word === 'bn' || word === 'billion') return 1e9
    return 1
  }
  const out: number[] = []
  for (const match of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|mn|b|bn|million|billion|thousand)?\b|\b(\d[\d,]*(?:\.\d+)?)\s*(million|billion)\s+(usdt|usdc|dollars)\b/gi)) {
    const digits = (match[1] ?? match[3]).replace(/,/g, '')
    const value = Number(digits) * scale(match[2] ?? match[4])
    if (Number.isFinite(value) && value > 0) out.push(value)
  }
  return out
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A victim named in a headline, and whether it was named at its loss. */
export interface VictimRead {
  victim: VictimName
  /** As the headline wrote it. */
  written: string
  tight: boolean
}

/** Where a name stands at its loss, by how surely: lost by it, its incident, an incident of it, taken from it, and,
 * weakest, it halting or confirming something. */
const AFTER_NAME: readonly RegExp[] = [
  /^(['’]s)?(\s+[\w.$-]+){0,3}?\s+(is |was |gets |got |has been |have been )?(hacked|exploited|drained|breached|attacked|compromised|robbed)\b/,
  /^(['’]s)?(\s+[\w.$,-]+){0,3}?\s+(hack|exploit|breach|heist|attack|theft|drain)(s|ed|er|ers)?\b|^(['’]s)?(\s+[\w.$,-]+){0,3}?\s+security (incident|breach)\b/
]
const BEFORE_NAME: readonly RegExp[] = [
  /\b(hack|exploit|breach|attack|heist|theft|drain)(s|ed|er|ers)?\s+(of|on|at|against|hits?|targets?|from)\s+(the\s+)?$/,
  /\b(drains?|drained|steals?|stole|stolen|loots?|siphon(s|ed)?)\b[^,;:]{0,40}\bfrom\s+(the\s+)?$/
]
/** The weakest: it halting or confirming something, right after its name or after one word that only says which part
 * of it is meant ("Kava Lend loses roughly $3.8 million to hack, sending KAVA token down nearly 40%", told WATCH with no
 * victim in v9-7d, 14 November 2026, since "Lend" stood between the name and its loss). */
const AFTER_NAME_WEAK = /^(['’]s)?(\s+(lend|lending|swap|dex|bridge|finance|protocol|network|labs|exchange|vaults?|perps?|staking|earn|v\d+))?\s+(halts?|halted|paus(es|ed)|suspends?|suspended|freezes|froze|loses|lost|confirms|discloses|reports|investigat\w*|hit by|hit with|suffers?|suffered)\b/

/** The victim a headline names: the surest name at its loss, the first in the headline among equals; else, loosely,
 * the first exchange it names. Null where it names no victim the tables know. */
export function victimOf(title: string, names: readonly VictimName[] = NAMES): VictimRead | null {
  const lower = title.toLowerCase()
  const found: { victim: VictimName; start: number; end: number }[] = []
  for (const victim of names) {
    for (const match of lower.matchAll(new RegExp(`(?<![a-z0-9])${escapeRegExp(victim.name)}(?![a-z0-9])`, 'g'))) {
      const start = match.index ?? 0
      const end = start + victim.name.length
      if (found.some((other) => start < other.end && end > other.start)) continue
      found.push({ victim, start, end })
    }
  }
  if (found.length === 0) return null
  found.sort((a, b) => a.start - b.start)
  const rank = (entry: { start: number; end: number }): number => {
    const after = lower.slice(entry.end)
    const before = lower.slice(0, entry.start)
    if (AFTER_NAME[0].test(after)) return 0
    if (AFTER_NAME[1].test(after)) return 1
    if (BEFORE_NAME.some((rule) => rule.test(before))) return 2
    if (AFTER_NAME_WEAK.test(after)) return 3
    return 4
  }
  const ranked = found.map((entry) => ({ ...entry, rank: rank(entry) })).sort((a, b) => a.rank - b.rank || a.start - b.start)
  const best = ranked[0]
  const written = (entry: { start: number; end: number }): string => title.slice(entry.start, entry.end)
  if (best.rank < 4) return { victim: best.victim, written: written(best), tight: true }
  const exchange = found.find((entry) => entry.victim.kind === 'exchange')
  return exchange === undefined ? null : { victim: exchange.victim, written: written(exchange), tight: false }
}

/** What a hack or exploit story's headline says of its incident, before the week's other stories are read: null for
 * a headline that reports no theft. Its report is 'first' unless its own words make it a follow-up; whether the theft
 * was told before is the week's (incidentsOf). */
export function readIncident(story: Pick<ReadStory, 'title' | 'repeat'>, dictionary: AssetDictionary, names: readonly VictimName[] = NAMES): StoryIncident | null {
  const main = mainClause(story.title)
  if (!LOSS.test(main)) return null
  const amounts = amountsOf(main)
  const amountUsd = amounts.length === 0 ? null : Math.max(...amounts)
  // Data read or exposed, no sum and no funds: a breach of records, not a theft.
  if (amountUsd === null && DATA_ONLY.test(main) && !FUNDS_LOST.test(main)) return null
  const read = victimOf(main, names)
  const token = read !== null && read.tight && read.victim.token !== null && dictionary.tickers.has(read.victim.token) ? read.victim.token : null
  const victim = read === null ? null : (read.victim.label ?? read.written)
  const news = NEWS_OF_LOSS.test(main)
  let why: string | null = null
  if (story.repeat === true) why = 'recycled'
  else if (ROUNDUP.test(main)) why = 'roundup'
  else if (AUTHORITY_SAYS.test(story.title)) why = 'attribution'
  else if (!news) {
    why = AFTERMATH.find(([reason, rule]) => (reason !== 'denial' || amountUsd === null) && rule.test(main))?.[0] ?? null
    if (why === null && (AFTER_AN_OLD_ONE.test(main) || THE_KNOWN_ONE.test(main))) why = 'past'
  }
  return { report: why === null ? 'first' : 'follow-up', why, victim, victimToken: token, topExchange: read !== null && read.tight && read.victim.top, amountUsd }
}

/** The keys an incident is known by in the week: its victim's name, its victim's token ("Aave V3" and "Aave" are one
 * victim), and its sum where it names one of a million or more. */
export function incidentKeys(incident: Pick<StoryIncident, 'victim' | 'victimToken' | 'amountUsd'>): string[] {
  const keys: string[] = []
  if (incident.victim !== null) keys.push(`victim:${incident.victim.toLowerCase()}`)
  if (incident.victimToken !== null) keys.push(`token:${incident.victimToken}`)
  if (incident.amountUsd !== null && incident.amountUsd >= INCIDENT_LINES.watchUsd) keys.push(`sum:${Number(incident.amountUsd.toPrecision(3))}`)
  return keys
}

/** The keys a story is matched by against those told before: a named victim by its name and token alone, since two
 * victims' thefts of the same sum are two thefts (DMM Bitcoin's and Mercado Bitcoin's $40 million, in V9 Stage 2's
 * in-app check); a victim not named by its sum. */
export function matchKeys(incident: Pick<StoryIncident, 'victim' | 'victimToken' | 'amountUsd'>): string[] {
  const keys = incidentKeys(incident)
  return incident.victim === null ? keys : keys.filter((key) => !key.startsWith('sum:'))
}

/** The stories with their incidents read: each hack or exploit story's, its victim's token as its one subject and
 * every other coin it names as mentioned, its impact read again on those coins; then, in the order published, a first
 * report whose victim or sum a story of the week before already reported turned into a follow-up ("told before").
 * Every other story keeps what it had, with no incident. */
export function incidentsOf<T extends Omit<ReadStory, 'alsoIn' | 'sources'>>(stories: readonly T[], dictionary: AssetDictionary, nowSec: number, names: readonly VictimName[] = NAMES): T[] {
  const read = stories.map((story): T => {
    if (story.eventType !== 'HACK' && story.eventType !== 'EXPLOIT') return { ...story, incident: null }
    const incident = readIncident(story, dictionary, names)
    if (incident === null) return { ...story, incident }
    const assets: StoryAsset[] = [
      ...(incident.victimToken === null ? [] : [{ ticker: incident.victimToken, relationship: 'DIRECT' as const }]),
      ...story.assets.filter((asset) => asset.ticker !== incident.victimToken).map((asset) => ({ ticker: asset.ticker, relationship: 'INDIRECT' as const }))
    ]
    const marketWide = incident.topExchange || (incident.amountUsd ?? 0) >= INCIDENT_LINES.highUsd
    return { ...story, assets, marketWide, impact: impactOf({ ...story, assets, marketWide }, nowSec), incident }
  })
  const order = read.map((story, index) => ({ story, index })).filter((entry) => entry.story.incident != null).sort((a, b) => a.story.publishedAt - b.story.publishedAt || a.story.id.localeCompare(b.story.id))
  const lastSeen = new Map<string, number>()
  for (const { story, index } of order) {
    const incident = story.incident as StoryIncident
    const keys = incidentKeys(incident)
    const told = matchKeys(incident).some((key) => {
      const at = lastSeen.get(key)
      return at !== undefined && story.publishedAt - at <= INCIDENT_LINES.knownSeconds
    })
    if (incident.report === 'first' && told) read[index] = { ...story, incident: { ...incident, report: 'follow-up', why: 'told before' } }
    for (const key of keys) lastSeen.set(key, story.publishedAt)
  }
  return read
}

/** The first reports of the last `spanSec` (two days) that a notice tells HIGH whatever is held -- a victim's own token
 * that trades, a top exchange, or $100 million or more (shared/alerts.ts incidentSeverity) -- newest first: Home's
 * critical news. A story read late is kept: when the app read it does not change what it reports. */
export function loudFirstReports<T extends Pick<ReadStory, 'publishedAt'> & { incident?: StoryIncident | null }>(stories: readonly T[], nowSec: number, spanSec: number = 2 * 86_400): T[] {
  return stories
    .filter((story) => {
      const incident = story.incident ?? null
      if (incident === null || incident.report !== 'first' || nowSec - story.publishedAt > spanSec) return false
      return incident.victimToken !== null || incident.topExchange || (incident.amountUsd ?? 0) >= INCIDENT_LINES.highUsd
    })
    .sort((a, b) => b.publishedAt - a.publishedAt)
}

/** Whether a first report concerns crypto: a victim the tables know, a sum of a million or more, a coin named, or a
 * word of crypto in its headline or summary. */
export function aboutCrypto(story: Pick<ReadStory, 'title' | 'summary' | 'assets'> & { incident?: StoryIncident | null }): boolean {
  const incident = story.incident ?? null
  return (incident !== null && (incident.victim !== null || (incident.amountUsd ?? 0) >= INCIDENT_LINES.watchUsd)) || story.assets.length > 0 || CRYPTO_WORDS.test(`${story.title} ${story.summary}`)
}
