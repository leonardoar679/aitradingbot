import { PEGGED } from '../shared/newsTitles'

// Which coins a Binance announcement adds to its Monitoring Tag: Binance's mark, since July 2023,
// on a coin it may delist ("Introducing Seed Tags & Monitoring Tags for Tokens with High Volatility
// and Risks"). By a fixed pattern on the title alone, as shared/newsTitles.ts reads the other kinds.
//
// FOR THE STUDY ONLY (research/NEWS.md). The app's reader does not use it: whether it should is
// decided once the study is in, as it was for a delisting.
//
//   "Binance Will Extend the Monitoring Tag to Include AVA, GNS, SCR & TOWNS on 2026-09-04"
//
// Only the coins being added are named. One title often also takes the tag, or a Seed Tag, off
// others ("…, Remove the Monitoring Tag for FLOW, and Remove the Seed Tag for ONDO & VIRTUAL"):
// those coins are not the news measured here, and are left out. So are pegged coins.

const TICKER = /^[A-Z0-9]{1,15}$/
const EXTEND = /^Binance Will\b.*?\bExtend the Monitoring Tag to (?:Include )?(.+)$/
/** Where the list of coins being added ends: the next clause, or the date. */
const LIST_END = /(?:,\s*(?:and\s+)?|\s+and\s+)Remove\b|\s+on\s+\d{4}-\d{2}-\d{2}\b/

/** The coins a title adds to the Monitoring Tag, or null for a title that adds none. */
export function monitoringTagTickers(title: string): string[] | null {
  const text = title.replace(/\s+/g, ' ').trim()
  const extend = EXTEND.exec(text)
  if (extend === null) return null
  const end = extend[1].search(LIST_END)
  const list = end < 0 ? extend[1] : extend[1].slice(0, end)
  const named = list
    .split(/,|&|\s+and\s+/)
    .map((part) => part.trim())
    .filter((part) => TICKER.test(part) && !PEGGED.has(part))
  const tickers = [...new Set(named)]
  return tickers.length === 0 ? null : tickers
}
