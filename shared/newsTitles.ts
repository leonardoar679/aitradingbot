// How a Binance announcement is read: which of the four kinds of news its title is, and which
// coins it names. By fixed patterns on the title alone -- never by a model (the V3 document's
// section 14), and never from the article's body. A title that fits none of them reads as null.
//
// ONE MODULE FOR THE STUDY AND THE APP. research/news.ts measured what each kind did with these
// patterns (research/NEWS.md), and the app's reader (electron/services/newsService.ts) sorts what
// it reads with the same ones, so the news the app shows is the news that was measured. A change
// here is a change to both.
//
//   DELISTING       "Binance Will Delist ACX, HFT, PIVX on 2026-08-17": the coins leave Binance's
//                   spot market. Not a margin, futures, options, earn or loans delisting, and not
//                   the removal of some trading pairs of a coin that stays listed.
//   FUTURES_LAUNCH  "Binance Futures Will Launch USDⓈ-Margined CTUSDT Perpetual Contract": a USDT
//                   perpetual. Not coin-, USDC- or BUSD-margined, not a quarterly, not a pre-IPO,
//                   pre-market or TradFi contract, and not "Multiple", whose title names no coin.
//   SPOT_LISTING    "Binance Will List Hyperliquid (HYPE) with Seed Tag Applied": the tickers in
//                   brackets. Not leveraged tokens, not a community vote's winner.
//   MONITORING_TAG  "Binance Will Extend the Monitoring Tag to Include AVA, GNS, SCR & TOWNS on
//                   2026-09-04": the coins added to Binance's mark on the coins it may delist.
//                   Measured after the other three (written as research/monitoringTitles.ts, and
//                   moved here unchanged once the app read it). Not the coins the same title takes
//                   the tag, or a Seed Tag, off.
//
// Coins held to a price -- a currency, gold, or another coin -- are dropped from every list: news
// cannot move what is pegged.

export type NewsCategory = 'DELISTING' | 'FUTURES_LAUNCH' | 'SPOT_LISTING' | 'MONITORING_TAG'

export interface NewsTitle {
  category: NewsCategory
  /** Upper case, as Binance's symbols spell them: `1000CAT`, not `1000CATUSDT`. */
  tickers: string[]
}

/** Stablecoins, currency tokens, gold and wrapped coins. */
export const PEGGED: ReadonlySet<string> = new Set([
  'USDT',
  'USDC',
  'BUSD',
  'TUSD',
  'USDP',
  'PAX',
  'FDUSD',
  'DAI',
  'USDE',
  'USD1',
  'XUSD',
  'RLUSD',
  'U',
  'BFUSD',
  'KGST',
  'AEUR',
  'EURI',
  'EUR',
  'IDRT',
  'BIDR',
  'BVND',
  'GYEN',
  'SUSD',
  'VAI',
  'UST',
  'USDS',
  'USDD',
  'FRAX',
  'LUSD',
  'PAXG',
  'XAUT',
  'RENBTC',
  'WBTC',
  'WBETH',
  'BETH'
])

const TICKER = /^[A-Z0-9]{1,15}$/

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function listed(list: string): string[] {
  return list
    .split(/,|&|\s+and\s+/)
    .map((part) => part.trim())
    .filter((part) => TICKER.test(part))
}

function bracketed(text: string): string[] {
  return [...text.matchAll(/\(([^()]+)\)/g)].map((match) => match[1].trim().toUpperCase()).filter((part) => TICKER.test(part))
}

function result(category: NewsCategory, tickers: string[]): NewsTitle | null {
  const kept = unique(tickers).filter((ticker) => !PEGGED.has(ticker))
  return kept.length === 0 ? null : { category, tickers: kept }
}

const DELIST = /\bWill Delist (.+?)(?: on \d{4}-\d{2}-\d{2}.*)?$/
const NOT_SPOT_DELISTING = /\b(Margin|Futures|Options|Earn|Staking|Loans?|Leveraged|Perpetual|Contracts?|Pairs?|Products?)\b/i

const LAUNCH = /^Binance Futures Will Launch (.+?) Perpetual Contracts?\b/i
const NOT_USDT_PERPETUAL = /Coin-Margined|COIN-M\b|USDC-Margined|BUSD-Margined|Quarterly|Delivery|Pre-IPO|Pre-Market|TradFi|Multiple/i
const MARGIN_WORDS = /USDⓈ-Margined|USDⓈ-M\b|USDT-Margined/g

const LIST = /^Binance Will List\b/
const NOT_A_COIN_LISTING = /Leveraged Tokens|Community Coin Vote/i

const EXTEND_TAG = /^Binance Will\b.*?\bExtend the Monitoring Tag to (?:Include )?(.+)$/
/** Where the list of coins being added to the tag ends: the next clause, or the date. */
const TAG_LIST_END = /(?:,\s*(?:and\s+)?|\s+and\s+)Remove\b|\s+on\s+\d{4}-\d{2}-\d{2}\b/

export function classifyTitle(title: string): NewsTitle | null {
  const text = title.replace(/\s+/g, ' ').trim()

  if (/^Binance\b/.test(text) && !NOT_SPOT_DELISTING.test(text)) {
    const delist = DELIST.exec(text)
    if (delist !== null) return result('DELISTING', listed(delist[1]))
  }

  const tag = EXTEND_TAG.exec(text)
  if (tag !== null) {
    const end = tag[1].search(TAG_LIST_END)
    return result('MONITORING_TAG', listed(end < 0 ? tag[1] : tag[1].slice(0, end)))
  }

  const launch = LAUNCH.exec(text)
  if (launch !== null) {
    if (NOT_USDT_PERPETUAL.test(text)) return null
    const middle = launch[1]
    const named = /\(/.test(middle) ? bracketed(middle) : listed(middle.replace(MARGIN_WORDS, ' ').replace(/\/USDT\b/g, ' ').replace(/\s+/g, ' ').trim())
    const bases = named.filter((symbol) => !symbol.endsWith('USDC')).map((symbol) => (symbol.length > 4 && symbol.endsWith('USDT') ? symbol.slice(0, -4) : symbol))
    return result('FUTURES_LAUNCH', bases)
  }

  if (LIST.test(text) && !NOT_A_COIN_LISTING.test(text)) return result('SPOT_LISTING', bracketed(text))
  return null
}
