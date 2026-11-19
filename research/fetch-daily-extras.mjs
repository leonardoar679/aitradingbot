// THE MARKET-WIDE READINGS OF V10-EXPL (V10 Stage 5, 19 November 2026): four public series, keyless, written into a
// scratch folder for research/v10Direction.mjs and nowhere else.
//   fng.json         alternative.me's Fear and Greed index, every day since February 2018: [[daySec, value], ...]
//   stablecoins.json DefiLlama's total stablecoin supply in dollars, daily: [[daySec, usd], ...]
//   dvol-btc.json    Deribit's DVOL for Bitcoin, daily closes since April 2021: [[daySec, close], ...]
//   funding-btc.json Binance's BTCUSDT perpetual funding since September 2019: [[sec, rate], ...]
//
//   OUT=<scratch>/daily-extras node research/fetch-daily-extras.mjs
//
// Public data, no key; a generic client name.
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const OUT = process.env.OUT
if (!OUT) throw new Error('OUT is the scratch folder to write into')
mkdirSync(OUT, { recursive: true })
const HEADERS = { 'User-Agent': 'research-client' }
const DAY = 86_400

async function json(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}`)
      return await response.json()
    } catch (error) {
      if (attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt))
    }
  }
}

const dayOf = (sec) => Math.floor(sec / DAY) * DAY

// Fear and Greed: the whole history in one answer, newest first.
const fng = (await json('https://api.alternative.me/fng/?limit=0&format=json')).data.map((row) => [dayOf(Number(row.timestamp)), Number(row.value)]).sort((a, b) => a[0] - b[0])
writeFileSync(join(OUT, 'fng.json'), JSON.stringify(fng))
console.log(`fear and greed: ${fng.length} days`)

// The stablecoins' total supply, every day.
const stable = (await json('https://stablecoins.llama.fi/stablecoincharts/all')).map((row) => [dayOf(Number(row.date)), Number(row.totalCirculatingUSD?.peggedUSD ?? row.totalCirculating?.peggedUSD ?? Number.NaN)]).filter((row) => Number.isFinite(row[1]))
writeFileSync(join(OUT, 'stablecoins.json'), JSON.stringify(stable))
console.log(`stablecoins: ${stable.length} days`)

// Deribit's DVOL, a year a request.
const dvol = []
for (let from = Date.UTC(2021, 2, 1); from < Date.now(); from += 365 * DAY * 1000) {
  const to = Math.min(Date.now(), from + 365 * DAY * 1000)
  const answer = await json(`https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=BTC&start_timestamp=${from}&end_timestamp=${to}&resolution=1D`)
  for (const row of answer.result.data) dvol.push([dayOf(Math.floor(row[0] / 1000)), Number(row[4])])
}
const dvolByDay = [...new Map(dvol.map((row) => [row[0], row])).values()].sort((a, b) => a[0] - b[0])
writeFileSync(join(OUT, 'dvol-btc.json'), JSON.stringify(dvolByDay))
console.log(`dvol: ${dvolByDay.length} days`)

// Binance's BTCUSDT funding, a thousand settlements a request.
const funding = []
let cursor = Date.UTC(2019, 8, 1)
for (let pages = 0; pages < 100 && cursor < Date.now(); pages++) {
  const rows = await json(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&startTime=${cursor}&limit=1000`)
  if (rows.length === 0) break
  for (const row of rows) funding.push([Math.floor(row.fundingTime / 1000), Number(row.fundingRate)])
  cursor = rows[rows.length - 1].fundingTime + 1
  if (rows.length < 1000) break
}
writeFileSync(join(OUT, 'funding-btc.json'), JSON.stringify(funding))
console.log(`funding: ${funding.length} settlements`)
