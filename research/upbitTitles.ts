import { PEGGED } from '../shared/newsTitles'

// How an Upbit trading notice is read: which of the three kinds research/UPBIT.md measures its title
// is, and which coins it names. By fixed patterns on the title alone, as shared/newsTitles.ts reads
// Binance's -- never by a model, and never from the notice's body. A title that fits none of them
// reads as null. Pinned by tests/upbitTitles.test.ts on titles copied from Upbit's list.
//
//   KRW_LISTING  A coin gets a market in Korean won, new to Upbit or added beside its BTC or USDT
//                market: "돌핀(POD) 신규 거래지원 안내 (KRW, BTC, USDT 마켓)", "KRW 마켓 디지털 자산
//                추가 (ID)", "원화마켓 신규 상장 (샌드박스 SAND)", and, in 2019, the notice that a won
//                market will open, which came before the one saying it had. Not a listing in Upbit's
//                BTC or USDT market alone: Upbit's trading is in won.
//   CAUTION      Upbit designates the coin for caution, its warning that it may stop supporting it:
//                "블라스트(BLAST) 거래 유의 종목 지정 안내", before 2024 "유의 종목 지정 안내". Not
//                the designation lifted (해제) or extended (기간 연장), not a temporary one for a
//                token swap (일시 지정), and not Upbit urging caution (유의 촉구), a lighter notice.
//   DELISTING    Upbit stops supporting the coin: "아이콘(ICX) 거래지원 종료 안내 (10/19 15:00)".
//                Not the end of one market or pair of a coin that stays (BTC 마켓 거래 지원 종료),
//                and not a closure with a buyback or a swap, which holders are paid out of.
//
// A title that counts its coins rather than naming them ("디지털 자산 유의 종목 지정 안내 (25종)")
// names none here: only the title is read. So does one naming coins in Korean alone (2017).
//
// Pegged coins are dropped, as for Binance's: news cannot move what is held to a price.

export type UpbitCategory = 'KRW_LISTING' | 'CAUTION' | 'DELISTING'

export interface UpbitTitle {
  category: UpbitCategory
  /** Upper case, as Upbit spells them. */
  tickers: string[]
  /** A listing whose title gives several coins one list of markets, the won market and another:
   * "KRW, BTC 마켓 디지털 자산 추가 (SHIB, GAL)". Such a title does not say which coin got the won
   * market -- GAL was given its own a year later -- so research/upbit.ts takes that from the
   * notice. */
  shared?: true
}

/** Pegged coins Upbit lists that Binance's titles had not named. */
const MORE_PEGGED: ReadonlySet<string> = new Set(['PYUSD', 'EURC', 'JPYC', 'USDG', 'TRUEUSD'])

const TICKER = /^[A-Z0-9]{1,15}$/

/** A market list: "KRW, BTC, USDT", "원화마켓, BTC". */
function hasWon(markets: string): boolean {
  return /\bKRW\b|원화/.test(markets)
}

function result(category: UpbitCategory, tickers: string[]): UpbitTitle | null {
  const kept = [...new Set(tickers.map((ticker) => ticker.toUpperCase()))].filter((ticker) => TICKER.test(ticker) && !PEGGED.has(ticker) && !MORE_PEGGED.has(ticker))
  return kept.length === 0 ? null : { category, tickers: kept }
}

/** The coins of a list that names each as Upbit does: "돌핀(POD)", "헤데라해시그래프 (HBAR)",
 * "PUFFER(퍼퍼)", "샌드박스 SAND" (before 2022, inside brackets), or a bare "ALT". Each comes with
 * the markets the list gives it, if it gives it its own: "셀레스티아(TIA)(KRW, BTC, USDT 마켓)",
 * "인피닛(IN) BTC, USDT 마켓". */
function coinsOf(list: string): { ticker: string; markets: string | null }[] {
  const coins: { ticker: string; markets: string | null }[] = []
  // A comma inside "(KRW, USDT 마켓)" does not end a coin.
  for (const raw of list.split(/,(?!\s*(?:KRW|BTC|USDT|ETH)(?:\s*,\s*(?:KRW|BTC|USDT|ETH))*\s*마켓)\s*/)) {
    const part = raw.trim()
    if (part === '') continue
    const own = /\(([^()]*마켓)\)\s*$/.exec(part) ?? /\s((?:[A-Z]+,\s*)*[A-Z]+) 마켓$/.exec(part)
    const coin = own === null ? part : part.slice(0, own.index).trim()
    const markets = own === null ? null : own[1]
    const named =
      /^[^()]*?\s*\(([A-Z0-9]{1,15})\)$/.exec(coin) ?? // 돌핀(POD)
      /^([A-Z0-9]{1,15})\([^()]+\)$/.exec(coin) ?? // PUFFER(퍼퍼)
      /^[^\sA-Z0-9][^()]*?\s([A-Z0-9]{1,15})$/.exec(coin) ?? // 샌드박스 SAND
      /^([A-Z0-9]{1,15})$/.exec(coin) // ALT
    if (named !== null) coins.push({ ticker: named[1], markets })
  }
  return coins
}

const ANOTHER_MARKET = /\b(?:BTC|USDT|ETH)\b/

/** A listing of the coins it gives a won market: those with their own markets by theirs, the rest
 * by the title's `joint` list. */
function listing(coins: { ticker: string; markets: string | null }[], joint: string): UpbitTitle | null {
  const read = result(
    'KRW_LISTING',
    coins.filter((coin) => hasWon(coin.markets ?? joint)).map((coin) => coin.ticker)
  )
  const sharing = coins.filter((coin) => coin.markets === null).length
  return read !== null && sharing > 1 && hasWon(joint) && ANOTHER_MARKET.test(joint) ? { ...read, shared: true } : read
}

/** "(KRW, BTC, USDT 마켓)" or "BTC, USDT 마켓" at the end of a coin list. */
const MARKETS = String.raw`(?:\(([^()]*?)\s?마켓\)|((?:KRW|BTC|USDT|ETH)(?:,\s*(?:KRW|BTC|USDT|ETH))*) 마켓)`

/** 2023 on: "<coins> 신규 거래지원 안내 (<markets> 마켓)", the coins' own markets beside them, or
 * "<markets> 마켓 신규 거래지원 안내 (<tickers>)". */
const NEW_SUPPORT = /^(.+?) 신규 거래지원 안내(?: \(([^()]*?) 마켓\))?/
const NEW_SUPPORT_MARKETS_FIRST = /^((?:[A-Z]+,\s*)*[A-Z]+) 마켓 신규 거래지원 안내 \(([^()]+)\)/

/** 2020 on: "<coins> <markets> 마켓 디지털 자산 추가", "<coins with their markets> 디지털 자산
 * 추가", or "<markets> 마켓 디지털 자산 추가 (<coins>)", the markets "원화" before 2022. */
const ADDED_MARKETS_FIRST = /^((?:(?:KRW|BTC|USDT|ETH|원화)(?:,\s*)?)+) 마켓 디지털 자산 추가 \(([^()]+)\)/
const ADDED = new RegExp(String.raw`^(.+?)\s?${MARKETS}? 디지털 자산 추가`)

/** 2018 to 2021: "원화마켓 신규 상장 (<coins>)", "원화 마켓 신규 상장 : 코스모스(ATOM)", "원화 마켓
 * 신규 거래 지원 (<coins>)", "원화 마켓 코인 추가 (<coins>)". */
const WON_LISTING = /^(원화 ?마켓(?:, [A-Z]+ 마켓)?) (?:신규 상장|신규 거래 지원|코인 추가)\s*:?\s*(.+)$/

/** 2017 to 2019: "<coin> 원화 마켓 오픈", and the notice that a won market will open, before the
 * one saying it has: "<coin> 소개 및 원화마켓 오픈 예정 안내", "<coin> 입금 지원 및 원화마켓 오픈
 * 예고", "<coin> 입금 오픈 (5/3 원화마켓 오픈 예정)", "<coin> 지급 및 원화마켓 상장". */
const WON_OPENS = /^(.+?)\s(?:(?:소개|입출금 지원|입금 지원|지급) 및 )?원화 ?마켓 (?:오픈|상장)(?: 예정 안내| 예고| 안내)?(?: \(.*\))?$/
const WON_OPENS_LATER = /^(.+?) 입금 오픈 \(\d+\/\d+ 원화 ?마켓 오픈 예정\)$/

/** "<coins> 거래 유의 종목 지정 안내", before 2024 "<coins> 유의 종목 지정 안내", and in 2020
 * "디지털 자산 유의종목 지정 안내 <coin>". */
const CAUTION = /^(.+?)\s+(?:거래 )?유의 ?종목 지정 안내$/
const CAUTION_COIN_AFTER = /^디지털 자산 유의 ?종목 지정 안내 (.+)$/

/** "<coins> 거래지원 종료 안내", with its date and time, or before 2022 "거래 지원 종료 안내"; and
 * a project closing ("사업 종료에 따른"), but not one with a buyback or a swap, whose titles go on
 * past "종료". */
const DELISTING = /^(.+?)\s+(?:사업 종료에 따른 )?거래 ?지원 종료 안내(?:\s*\((?:[\d/.\s:]+|완료|[\d.]+ 종료)\))?(?:\s*\([^()]*\))?$/

/** Words that make a title something other than its kind: a count of coins in place of their
 * names, one market of a coin that stays, a temporary designation, a lifted or extended one. */
const COUNTED = /\d+종/
const NOT_THE_COIN = /마켓 거래 ?지원 종료|\/[A-Z]+ 마켓|페어 제거/
const NOT_A_DESIGNATION = /해제|연장|일시 지정/

export function classifyUpbitTitle(title: string): UpbitTitle | null {
  const text = title.replace(/\s+/g, ' ').trim()
  if (COUNTED.test(text)) return null

  const marketsFirst = NEW_SUPPORT_MARKETS_FIRST.exec(text) ?? ADDED_MARKETS_FIRST.exec(text)
  if (marketsFirst !== null) return listing(coinsOf(marketsFirst[2]), marketsFirst[1])
  const support = NEW_SUPPORT.exec(text)
  if (support !== null) return listing(coinsOf(support[1]), support[2] ?? '')
  const added = ADDED.exec(text)
  if (added !== null) return listing(coinsOf(added[1]), added[2] ?? added[3] ?? '')

  const won = WON_LISTING.exec(text)
  if (won !== null) return listing(coinsOf(won[2].replace(/^\((.*)\)$/, '$1')), won[1])
  const opens = WON_OPENS_LATER.exec(text) ?? WON_OPENS.exec(text)
  if (opens !== null) return listing(coinsOf(opens[1]), '원화')

  if (!NOT_A_DESIGNATION.test(text)) {
    const caution = CAUTION_COIN_AFTER.exec(text) ?? CAUTION.exec(text)
    if (caution !== null) return result('CAUTION', coinsOf(caution[1]).map((coin) => coin.ticker))
  }

  if (!NOT_THE_COIN.test(text)) {
    const delisting = DELISTING.exec(text)
    if (delisting !== null) return result('DELISTING', coinsOf(delisting[1]).map((coin) => coin.ticker))
  }
  return null
}
