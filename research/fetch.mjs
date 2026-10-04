// Downloads klines from data-api.binance.vision (Binance's public market-data mirror;
// api.binance.com is geo-blocked from some regions, including wherever this was run).
//
// Writes SYMBOL-INTERVAL.json as [[openTimeSeconds, open, high, low, close, volume], ...].
// SECONDS, not the milliseconds the API returns: everything downstream compares candle.time
// against Date.parse(...)/1000, and a millisecond timestamp there silently matches nothing.
//
// This file existed once, was never committed, and the candle set went with it. It is committed
// now, because a study whose data cannot be regenerated is a study nobody can check.
//
//   node fetch.mjs '[["BTCUSDT","15m"],["ETHUSDT","1h"]]'
//   START=2017-08-01 OUT=../.candles node fetch.mjs '[["BTCUSDT","1d"]]'
//
// COLS=flow adds a seventh column, the taker-buy share of the bar's volume in base units: what
// was bought by someone lifting the offer rather than by a resting bid. Everything that reads
// these files takes the first six columns and ignores the rest, so a file with the seventh is
// still a candle file. research/events.ts is what reads it.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'

const BASE = 'https://data-api.binance.vision/api/v3/klines'
const OUT = process.env.OUT || '.candles'
const START = Date.parse((process.env.START || '2017-01-01') + 'T00:00:00Z')
const END = process.env.END ? Date.parse(process.env.END + 'T00:00:00Z') : Date.now()
const PAGE = 1000
const FLOW = process.env.COLS === 'flow'

const MS = {
  '1m': 60e3, '3m': 180e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '2h': 7200e3, '4h': 14400e3, '6h': 21600e3, '12h': 43200e3,
  '1d': 86400e3, '3d': 259200e3, '1w': 604800e3
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Retries on 429 and on transport errors. A partial download that looks complete is worse than a
// slow one: a gap in the middle of a series becomes a fake flat period in every backtest built
// on it, and nothing downstream can tell that from a real one.
async function getPage(symbol, interval, startTime) {
  const url = BASE + '?symbol=' + symbol + '&interval=' + interval +
    '&startTime=' + startTime + '&limit=' + PAGE
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(url)
      if (res.status === 429 || res.status === 418) {
        const wait = Number(res.headers.get('retry-after') || 30) * 1000
        console.error('  rate limited, waiting ' + Math.round(wait / 1000) + 's')
        await sleep(wait)
        continue
      }
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200))
      return await res.json()
    } catch (err) {
      // Exponential, not linear. A linear 1+2+..+7 gives up after 28 seconds, which is shorter
      // than an ordinary DNS blip -- both overnight downloads died on getaddrinfo with hours of
      // paging still to do. This rides out about ten minutes instead.
      if (attempt === 7) throw err
      console.error('  ' + String(err).slice(0, 120) + ' -- retry ' + (attempt + 1) + ' in ' + 2 ** attempt * 5 + 's')
      await sleep(2 ** attempt * 5000)
    }
  }
  return []
}

async function download(symbol, interval) {
  const step = MS[interval]
  if (!step) throw new Error('unknown interval ' + interval)
  const file = join(OUT, symbol + '-' + interval + '.json')

  // Resume: a re-run tops up an existing file rather than re-pulling years of history.
  let rows = []
  if (existsSync(file)) {
    rows = JSON.parse(readFileSync(file, 'utf-8'))
    if (rows.length && rows[rows.length - 1][0] * 1000 >= END - step) {
      console.log(symbol + ' ' + interval + ': already current (' + rows.length + ' candles)')
      return
    }
  }

  const seen = new Set(rows.map((r) => r[0]))
  let cursor = rows.length ? rows[rows.length - 1][0] * 1000 + step : START
  let pages = 0

  while (cursor < END) {
    const batch = await getPage(symbol, interval, cursor)
    if (!batch.length) break
    for (const k of batch) {
      const t = Math.floor(k[0] / 1000)
      if (seen.has(t)) continue
      seen.add(t)
      const row = [t, Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]), Number(k[5])]
      if (FLOW) row.push(Number(k[9]))
      rows.push(row)
    }
    const last = batch[batch.length - 1][0]
    if (last + step <= cursor) break // no forward progress: listing began after START
    cursor = last + step
    if (++pages % 25 === 0) {
      console.log('  ' + symbol + ' ' + interval + ': ' + rows.length + ' candles, at ' +
        new Date(cursor).toISOString().slice(0, 10))
      // Checkpoint. Writing only at the end meant a crash 900 pages into a 990-page symbol threw
      // all of it away, and the resume path above then restarted that symbol from scratch.
      rows.sort((a, b) => a[0] - b[0])
      writeFileSync(file, JSON.stringify(rows))
    }
    await sleep(120)
  }

  rows.sort((a, b) => a[0] - b[0])
  writeFileSync(file, JSON.stringify(rows))
  const span = rows.length
    ? new Date(rows[0][0] * 1000).toISOString().slice(0, 10) + ' to ' +
      new Date(rows[rows.length - 1][0] * 1000).toISOString().slice(0, 10)
    : 'empty'
  console.log(symbol + ' ' + interval + ': ' + rows.length + ' candles, ' + span)
}

const jobs = JSON.parse(process.argv[2])
mkdirSync(OUT, { recursive: true })
for (const [symbol, interval] of jobs) {
  await download(symbol, interval)
}
