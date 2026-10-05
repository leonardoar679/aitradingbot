import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ORDINARY_SLIPPAGE, THIN_BOOK_SLIPPAGE, spotSymbolCandidates } from '../shared/newsRules'
import { checkOrStudy, daysAround, splitOf, type Kind, type StudyPair } from './announcementStudy'
import { classifyUpbitTitle, type UpbitCategory } from './upbitTitles'

// Do Upbit's trading notices move a coin's price on Binance, by enough to trade after them? See
// research/UPBIT.md for the question, the rule and the result. The moves and the trades are scored
// by research/announcementStudy.ts, the code research/news.ts scored Binance's announcements with.
//
//   node research/fetch-upbit-notices.mjs
//   npx esbuild research/upbit.ts --bundle --platform=node --format=esm --outfile=research/.upbit.mjs
//   MODE=plan node research/.upbit.mjs                       sort every title; list what to read
//   NEWS_DIR=.candles/upbit node research/fetch-news-candles.mjs
//   MODE=check SET=discovery node research/.upbit.mjs        notice minutes against the candles
//   MODE=study SET=discovery node research/.upbit.mjs        score them
//
// SET=heldout, for either, only once UPBIT.md holds the rule and it is committed.

const DIR = process.env.UPBIT_DIR ?? '.candles/upbit'
const MODE = process.env.MODE ?? 'plan'
const SET = process.env.SET ?? 'discovery'

/** Each kind of notice, the side it is traded on, and what one side of a trade in it is charged in
 * slippage. Every price is the coin's Binance spot USDT pair: the market this app trades. A coin
 * Upbit warns about or drops is small and troubled, and is charged as Binance's own delisted and
 * tagged coins were. */
const KINDS: Record<UpbitCategory, Kind> = {
  KRW_LISTING: { side: 1, market: 'spot', slippage: ORDINARY_SLIPPAGE, label: 'Upbit KRW listing, long, on its Binance spot USDT pair' },
  CAUTION: { side: -1, market: 'spot', slippage: THIN_BOOK_SLIPPAGE, label: 'Upbit caution, short (paper only), on its Binance spot USDT pair' },
  DELISTING: { side: -1, market: 'spot', slippage: THIN_BOOK_SLIPPAGE, label: 'Upbit delisting, short (paper only), on its Binance spot USDT pair' }
}
const CATEGORIES: UpbitCategory[] = ['KRW_LISTING', 'CAUTION', 'DELISTING']

/** Which coins a listing gave a won market, where its title gives several coins one list of markets
 * (research/upbitTitles.ts `shared`): read by hand from each of these twelve notices on 5 October
 * 2026, before any price was. Each of the coins left out had a won market added by a notice of its
 * own later (GAL, IMX, ALT, POKT, YGG, OMNI, BIGTIME, MASK). */
const WON_BY_NOTICE: Record<number, string[]> = {
  2217: ['SOL', 'MATIC', 'NU'], // "오늘 (10/15) 업비트 KRW, BTC 마켓에 SOL, MATIC, NU가 추가됩니다."
  2239: ['1INCH', 'AAVE'], // "KRW 마켓 : 1INCH, AAVE / BTC 마켓 : 1INCH, AAVE, MASK"
  2268: ['ALGO'], // "KRW 마켓 : ALGO / BTC 마켓 : AUDIO"
  2327: ['NEAR'], // "KRW 마켓 : NEAR / BTC 마켓 : YGG"
  2429: ['AVAX'], // "KRW 마켓 : AVAX / BTC 마켓 : AVAX, IMX"
  3266: ['SHIB'], // "KRW 마켓 : SHIB / BTC 마켓 : GAL"
  3362: ['MASK'], // "KRW 마켓 : MASK / BTC 마켓 : ACS"
  4070: ['PYTH'], // "ALT : BTC 마켓 / PYTH : KRW, BTC 마켓"
  4133: ['MNT'], // "MNT : KRW 마켓, BTC 마켓, USDT 마켓 / POKT : BTC 마켓, USDT 마켓"
  4172: ['AKT'], // the market table: BIGTIME "BTC, USDT", AKT "KRW, BTC, USDT"
  4192: ['ZETA'], // the market table: ZETA "KRW, BTC, USDT", OMNI "BTC, USDT"
  6102: ['SKY'] // the market table: SKY and USDS "KRW, USDT"; USDS is a dollar
}

/** Coins Upbit names by a ticker that is another coin's on Binance, found by setting each measured
 * coin's Korean name beside Binance's own name for its pair (Binance's public asset list), on 5
 * October 2026, before any price was read. Only the first had a Binance pair the day before its
 * notice; the other two are listed so that the check is on record. */
const NOT_THE_SAME_COIN: Record<string, string> = {
  '6335:AI': "젠신 is Gensyn; Binance's AI is Sleepless AI",
  '6504:LIT': "라이터 is Lighter; Binance's LIT is Litentry",
  '6207:PROS': "파로스 is Pharos; Binance's PROS is Prosper"
}

/** A coin named again by the same kind of notice within this long of the first is the same news:
 * in 2019 Upbit said a won market would open, then that it had, hours apart. Only the first is
 * measured. */
const SAME_NEWS_SECONDS = 30 * 86_400

interface Notice {
  id: number
  title: string
  /** When the notice was first posted. */
  releaseSec: number
}

function plan(): StudyPair<UpbitCategory>[] {
  const notices = (JSON.parse(readFileSync(join(DIR, 'notices.json'), 'utf-8')) as Notice[]).sort((a, b) => a.releaseSec - b.releaseSec)
  const pairs: StudyPair<UpbitCategory>[] = []
  const firstNamed = new Map<string, number>()
  for (const notice of notices) {
    const read = classifyUpbitTitle(notice.title)
    if (read === null) continue
    if (read.shared && WON_BY_NOTICE[notice.id] === undefined) throw new Error(`notice ${notice.id} gives several coins one list of markets; say which got the won market: ${notice.title}`)
    const tickers = read.shared ? WON_BY_NOTICE[notice.id] : read.tickers
    for (const ticker of tickers) {
      if (NOT_THE_SAME_COIN[`${notice.id}:${ticker}`] !== undefined) continue
      const first = firstNamed.get(`${read.category}:${ticker}`)
      if (first !== undefined && notice.releaseSec - first < SAME_NEWS_SECONDS) continue
      firstNamed.set(`${read.category}:${ticker}`, notice.releaseSec)
      pairs.push({
        key: `${notice.id}:${ticker}`,
        articleId: notice.id,
        category: read.category,
        releaseSec: notice.releaseSec,
        title: notice.title,
        ticker,
        market: KINDS[read.category].market,
        candidates: spotSymbolCandidates(ticker),
        days: daysAround(notice.releaseSec)
      })
    }
  }
  return pairs
}

// ---------------------------------------------------------------------------------------------

const pairs = plan()

if (MODE === 'plan') {
  writeFileSync(join(DIR, 'pairs.json'), JSON.stringify(pairs))
  for (const category of CATEGORIES) {
    const own = pairs.filter((pair) => pair.category === category)
    const notices = (split: string) => new Set(own.filter((pair) => splitOf(pair.releaseSec) === split).map((pair) => pair.articleId)).size
    const coins = (split: string) => own.filter((pair) => splitOf(pair.releaseSec) === split).length
    console.log(`${category.padEnd(12)} discovery: ${notices('discovery')} notices, ${coins('discovery')} coins   held out: ${notices('heldout')} notices, ${coins('heldout')} coins`)
  }
  console.log(`${pairs.length} coins in all -> ${join(DIR, 'pairs.json')}`)
}

if (MODE === 'check' || MODE === 'study') checkOrStudy({ dir: DIR, mode: MODE, set: SET, pairs, kinds: KINDS, categories: CATEGORIES })
