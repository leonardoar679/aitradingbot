// V9-PREMIUM's Coinbase side (registered 10 November 2026 before anything was read): Coinbase Exchange's public BTC-USD
// hourly candles from 1 January 2018 to the end of Binance's bars on file, read keyless 300 at a time, three requests a
// second, each window asked again on a refusal; written oldest first as [open time s, open, high, low, close, volume]
// to E:/Code/newtradingbot/.candles/COINBASE-BTCUSD-1h.json (outside the repository, as Binance's bars are), its SHA-256
// printed for research/v9Premium.mjs to name. It reads one public list and writes one file; nothing else.
//
//   node research/fetch-coinbase-premium.mjs

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'

const OUT = process.env.OUT ?? 'E:/Code/newtradingbot/.candles/COINBASE-BTCUSD-1h.json'
const FROM = Date.UTC(2018, 0, 1) / 1000
const TO = Date.UTC(2026, 7, 28, 14) / 1000
const STEP = 3600
const PAGE = 300
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function page(startSec, endSec) {
  const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?${new URLSearchParams({ granularity: String(STEP), start: new Date(startSec * 1000).toISOString(), end: new Date(endSec * 1000).toISOString() })}`
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'Mozilla/5.0 (TraderSpider research)' } })
      if (response.ok) return response.json()
      if (response.status !== 429 && response.status < 500) throw new Error(`Coinbase answered ${response.status}`)
    } catch (error) {
      if (attempt === 5) throw error
    }
    await sleep(1000 * 2 ** attempt)
  }
  throw new Error(`Coinbase did not answer for ${new Date(startSec * 1000).toISOString()}`)
}

const rows = new Map()
for (let start = FROM; start < TO; start += PAGE * STEP) {
  const end = Math.min(TO, start + PAGE * STEP) - STEP
  for (const [time, low, high, open, close, volume] of await page(start, end)) {
    if (time >= FROM && time < TO) rows.set(time, [time, open, high, low, close, volume])
  }
  await sleep(340)
}
const sorted = [...rows.values()].sort((a, b) => a[0] - b[0])
const text = `${JSON.stringify(sorted)}\n`
writeFileSync(OUT, text, 'utf-8')
const hours = (TO - FROM) / STEP
console.log(`${sorted.length} of ${hours} hours, ${new Date(sorted[0][0] * 1000).toISOString()} to ${new Date(sorted[sorted.length - 1][0] * 1000).toISOString()}; sha256 ${createHash('sha256').update(text).digest('hex')}`)
