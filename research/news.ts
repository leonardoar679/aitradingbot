import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ORDINARY_SLIPPAGE, THIN_BOOK_SLIPPAGE, spotSymbolCandidates } from '../shared/newsRules'
import { classifyTitle, type NewsCategory } from '../shared/newsTitles'
import { checkOrStudy, daysAround, splitOf, type Kind, type StudyPair } from './announcementStudy'

// Do Binance's own announcements move prices, by enough to trade after them? See research/NEWS.md
// for the question, the rule and the result. The moves and the trades are scored by
// research/announcementStudy.ts, which research/upbit.ts scores Upbit's notices with too.
//
//   node research/fetch-announcements.mjs
//   npx esbuild research/news.ts --bundle --platform=node --format=esm --outfile=research/.news.mjs
//   MODE=plan node research/.news.mjs                  classify every title; list what to read
//   node research/fetch-news-candles.mjs               the 1-minute candles around each one
//   MODE=check SET=discovery node research/.news.mjs   announcement minutes against the candles
//   MODE=study SET=discovery node research/.news.mjs   score them
//
// SET=heldout, for either, only once NEWS.md holds the rule and it is committed.

const DIR = process.env.NEWS_DIR ?? '.candles/news'
const MODE = process.env.MODE ?? 'plan'
const SET = process.env.SET ?? 'discovery'

/** The kinds measured, by the app's own patterns (shared/newsTitles.ts). The Monitoring Tag was
 * measured after the other three, under the same rule; NEWS.md says why. */
type Category = NewsCategory

/** Each kind of news, the side it is traded on, where its price is read, and what one side of a
 * trade in it is charged in slippage. A coin being delisted, or marked as one that may be, has a
 * thin book; the others are ordinary small coins. */
const KINDS: Record<Category, Kind> = {
  DELISTING: { side: -1, market: 'spot', slippage: THIN_BOOK_SLIPPAGE, label: 'Delisting, short (paper only), on its spot USDT pair' },
  FUTURES_LAUNCH: { side: 1, market: 'spot', slippage: ORDINARY_SLIPPAGE, label: 'Futures launch, long, on its spot USDT pair' },
  SPOT_LISTING: { side: 1, market: 'um', slippage: ORDINARY_SLIPPAGE, label: 'Spot listing, long, on its USDT perpetual' },
  MONITORING_TAG: { side: -1, market: 'spot', slippage: THIN_BOOK_SLIPPAGE, label: 'Monitoring Tag, short (paper only), on its spot USDT pair' }
}
const CATEGORIES: Category[] = ['DELISTING', 'FUTURES_LAUNCH', 'SPOT_LISTING', 'MONITORING_TAG']

/** The lists each kind is read from. The first three keep the two they were scored on: reading the
 * news list (49) for them as well would change a study already scored. The Monitoring Tag is
 * announced in the news list, and once in the delisting list. */
const FIRST_THREE_LISTS = [48, 161]
const MONITORING_TAG_LISTS = [49, 161, 48]

/** One coin named by one announcement. */
type NewsPair = StudyPair<Category>

function candidatesFor(category: Category, ticker: string): string[] {
  if (category === 'SPOT_LISTING') return [`${ticker}USDT`, `1000${ticker}USDT`]
  return spotSymbolCandidates(ticker)
}

interface Announcement {
  id: number
  title: string
  releaseSec: number
}

function readAnnouncements(catalogs: number[]): Announcement[] {
  const rows: Announcement[] = []
  const seen = new Set<number>()
  for (const catalog of catalogs) {
    for (const row of JSON.parse(readFileSync(join(DIR, `announcements-${catalog}.json`), 'utf-8')) as Announcement[]) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      rows.push(row)
    }
  }
  return rows.sort((a, b) => a.releaseSec - b.releaseSec)
}

function plan(): NewsPair[] {
  const pairs: NewsPair[] = []
  const add = (row: Announcement, category: Category, tickers: string[]): void => {
    for (const ticker of tickers) {
      pairs.push({
        key: `${row.id}:${ticker}`,
        articleId: row.id,
        category,
        releaseSec: row.releaseSec,
        title: row.title,
        ticker,
        market: KINDS[category].market,
        candidates: candidatesFor(category, ticker),
        days: daysAround(row.releaseSec)
      })
    }
  }
  for (const row of readAnnouncements(FIRST_THREE_LISTS)) {
    const news = classifyTitle(row.title)
    // The tag is read from its own lists, below: one of its titles is in the delisting list too.
    if (news !== null && news.category !== 'MONITORING_TAG') add(row, news.category, news.tickers)
  }
  for (const row of readAnnouncements(MONITORING_TAG_LISTS)) {
    const news = classifyTitle(row.title)
    if (news?.category === 'MONITORING_TAG') add(row, news.category, news.tickers)
  }
  return pairs
}

// ---------------------------------------------------------------------------------------------

const pairs = plan()

if (MODE === 'plan') {
  writeFileSync(join(DIR, 'pairs.json'), JSON.stringify(pairs))
  for (const category of CATEGORIES) {
    const own = pairs.filter((pair) => pair.category === category)
    const articles = (split: string) => new Set(own.filter((pair) => splitOf(pair.releaseSec) === split).map((pair) => pair.articleId)).size
    const coins = (split: string) => own.filter((pair) => splitOf(pair.releaseSec) === split).length
    console.log(
      `${category.padEnd(15)} discovery: ${articles('discovery')} announcements, ${coins('discovery')} coins   held out: ${articles('heldout')} announcements, ${coins('heldout')} coins`
    )
  }
  console.log(`${pairs.length} coins in all -> ${join(DIR, 'pairs.json')}`)
}

if (MODE === 'check' || MODE === 'study') checkOrStudy({ dir: DIR, mode: MODE, set: SET, pairs, kinds: KINDS, categories: CATEGORIES })
