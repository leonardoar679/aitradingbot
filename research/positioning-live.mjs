// Does the archive say what the live endpoints say? research/positioning.ts is scored on
// data.binance.vision's archive; an app would read fapi.binance.com's public endpoints at the
// moment of an event. This compares the two over the last month, value by value at the same
// timestamps, and measures how long after its timestamp each live series is published -- which is
// what research/POSITIONING.md's rule against looking ahead has to match.
//
//   SYMBOLS=BTCUSDT,DOTUSDT FROM=<29 days ago> TO=<yesterday> OUT=.candles/positioning-check node research/fetch-positioning.mjs
//   CHECK_DIR=.candles/positioning-check SYMBOLS=BTCUSDT,DOTUSDT node research/positioning-live.mjs
//
// Each live series is tried against its archive column at offsets of -5, 0 and +5 minutes, so a
// series stamped at the other end of its period shows up as a match at an offset rather than as
// no match at all. Public endpoints only; no key.

import { readFileSync } from 'fs'
import { join } from 'path'

const DIR = process.env.CHECK_DIR || '.candles/positioning-check'
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,DOTUSDT').split(',')
const FAPI = 'https://fapi.binance.com'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function json(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url)
    if (res.ok) return res.json()
    if (res.status === 429 || res.status >= 500) {
      await sleep(2 ** attempt * 2000)
      continue
    }
    throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200) + ' -- ' + url)
  }
  throw new Error('gave up on ' + url)
}

/** A /futures/data series over [start, end], paged 500 rows at a time. Given a range, these
 * endpoints return its NEWEST 500 rows, so the paging walks backwards from the end. */
async function history(path, symbol, start, end) {
  const rows = []
  let to = end
  while (to > start) {
    const page = await json(`${FAPI}/futures/data/${path}?symbol=${symbol}&period=5m&limit=500&startTime=${start}&endTime=${to}`)
    if (page.length === 0) break
    rows.unshift(...page)
    const first = Number(page[0].timestamp)
    if (first - 1 >= to) break
    to = first - 1
    await sleep(150)
  }
  return rows
}

async function premiumHistory(symbol, start, end) {
  const rows = []
  let from = start
  while (from < end) {
    const page = await json(`${FAPI}/fapi/v1/premiumIndexKlines?symbol=${symbol}&interval=5m&limit=1500&startTime=${from}&endTime=${end}`)
    if (page.length === 0) break
    rows.push(...page)
    const last = Number(page[page.length - 1][0])
    if (last + 1 <= from) break
    from = last + 1
    await sleep(150)
  }
  return rows
}

/** How many live values the archive matches at each offset. The live ratios carry four decimals
 * where the archive carries eight, and an account ratio is a quotient of two shares each already
 * rounded to four, which moves it by up to a few parts in ten thousand: "close" allows for that,
 * "exact" does not. The median and largest differences are given at the best offset. */
function compare(label, live, archive) {
  const offsets = [-300, 0, 300]
  const results = offsets.map((offset) => {
    let close = 0
    let exact = 0
    const differences = []
    for (const [time, value] of live) {
      const other = archive.get(time + offset)
      if (other === undefined || other === null || value === null) continue
      const scale = Math.max(Math.abs(value), Math.abs(other), 1e-12)
      const difference = Math.abs(value - other) / scale
      differences.push(difference)
      if (difference <= 1e-6) exact++
      if (difference <= 1e-3) close++
    }
    differences.sort((a, b) => a - b)
    return { offset, close, exact, compared: differences.length, differences }
  })
  const best = results.reduce((a, b) => (b.close > a.close ? b : a))
  const median = best.differences[Math.floor(best.differences.length / 2)] ?? NaN
  const worst = best.differences[best.differences.length - 1] ?? NaN
  const cells = results.map((r) => `${r.offset >= 0 ? '+' : ''}${r.offset / 60}m ${r.close}/${r.compared} (exact ${r.exact})`).join('  ')
  console.log(`  ${label.padEnd(26)} live ${String(live.length).padStart(5)}  close at ${cells}  | best ${best.offset >= 0 ? '+' : ''}${best.offset / 60}m: median difference ${median.toExponential(1)}, largest ${worst.toExponential(1)}`)
}

const serverTime = async () => Number((await json(`${FAPI}/fapi/v1/time`)).serverTime)

for (const symbol of SYMBOLS) {
  const metrics = JSON.parse(readFileSync(join(DIR, `${symbol}-metrics.json`), 'utf-8'))
  const premium = JSON.parse(readFileSync(join(DIR, `${symbol}-premium-5m.json`), 'utf-8'))
  const column = (index) => new Map(metrics.map((row) => [row[0], row[index]]))
  const archiveEnd = metrics[metrics.length - 1][0]

  const now = await serverTime()
  const start = now - 29.5 * 86_400_000
  const end = Math.min(now, (archiveEnd + 600) * 1000)
  console.log(`\n${symbol}: live from ${new Date(start).toISOString().slice(0, 16)} to ${new Date(end).toISOString().slice(0, 16)}, archive to ${new Date(archiveEnd * 1000).toISOString().slice(0, 16)}`)

  const at = (row) => Math.floor(Number(row.timestamp) / 1000)
  const oi = await history('openInterestHist', symbol, start, end)
  compare('open interest (contracts)', oi.map((r) => [at(r), Number(r.sumOpenInterest)]), column(1))
  compare('open interest (value)', oi.map((r) => [at(r), Number(r.sumOpenInterestValue)]), column(2))
  const topAccounts = await history('topLongShortAccountRatio', symbol, start, end)
  compare('top traders, accounts', topAccounts.map((r) => [at(r), Number(r.longShortRatio)]), column(3))
  const topPositions = await history('topLongShortPositionRatio', symbol, start, end)
  compare('top traders, positions', topPositions.map((r) => [at(r), Number(r.longShortRatio)]), column(4))
  const accounts = await history('globalLongShortAccountRatio', symbol, start, end)
  compare('all accounts', accounts.map((r) => [at(r), Number(r.longShortRatio)]), column(5))
  const taker = await history('takerlongshortRatio', symbol, start, end)
  compare('taker buy/sell volume', taker.map((r) => [at(r), Number(r.buySellRatio)]), column(6))
  const bars = await premiumHistory(symbol, start, end)
  compare('premium index, 5m close', bars.map((r) => [Math.floor(Number(r[0]) / 1000), Number(r[4])]), new Map(premium.map((row) => [row[0], row[4]])))

  // How old the newest row of each series is when asked for: what an app could have at a moment.
  const lags = []
  for (const path of ['openInterestHist', 'topLongShortAccountRatio', 'topLongShortPositionRatio', 'globalLongShortAccountRatio', 'takerlongshortRatio']) {
    const clock = await serverTime()
    const latest = await json(`${FAPI}/futures/data/${path}?symbol=${symbol}&period=5m&limit=1`)
    lags.push(`${path} ${((clock - Number(latest[0].timestamp)) / 1000).toFixed(0)}s`)
  }
  const clock = await serverTime()
  const latestBars = await json(`${FAPI}/fapi/v1/premiumIndexKlines?symbol=${symbol}&interval=5m&limit=1`)
  lags.push(`premiumIndexKlines newest bar (still forming) opened ${((clock - Number(latestBars[0][0])) / 1000).toFixed(0)}s ago`)
  console.log(`  newest row, against the server clock: ${lags.join('; ')}`)
}
