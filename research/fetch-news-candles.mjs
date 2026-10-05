// Downloads the 1-minute candles around each announcement research/news.ts measures, from
// data.binance.vision's daily archives (free, no key) -- which keep the candles of coins Binance has
// since delisted, as its live API does not. research/NEWS.md says what for.
//
//   MODE=plan node research/.news.mjs        writes .candles/news/pairs.json first
//   node research/fetch-news-candles.mjs
//
// For each coin an announcement names, the symbols its price may be under are tried in order, and
// the first one that traded the whole day before the announcement is read: three days before it,
// its own day and the next. Writes, under .candles/news/:
//   klines/{spot|um}/SYMBOL/YYYY-MM-DD.json   [[openTimeSec, open, high, low, close, volume], ...]
//   klines/{spot|um}/SYMBOL/YYYY-MM-DD.missing  when Binance has no such file
//   manifest.json   for each coin: the symbol read, or every symbol tried
// Every zip is checked against the SHA-256 Binance publishes beside it, and its CRC, before it is
// read. A re-run reads nothing it already has.

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { crc32, inflateRawSync } from 'zlib'

const DIR = process.env.NEWS_DIR || '.candles/news'
const WORKERS = 6
const BASE = { spot: 'https://data.binance.vision/data/spot/daily/klines', um: 'https://data.binance.vision/data/futures/um/daily/klines' }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** The body, or null when the file does not exist; retried on anything else, as the other fetchers. */
async function get(url) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(url)
      if (res.status === 404) return null
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return Buffer.from(await res.arrayBuffer())
    } catch (err) {
      if (attempt === 7) throw err
      console.error('  ' + String(err).slice(0, 100) + ' -- ' + url.split('/').pop() + ', retry in ' + 2 ** attempt * 2 + 's')
      await sleep(2 ** attempt * 2000)
    }
  }
  return null
}

/** The one file in a zip, from its central directory; its CRC and length checked. As in
 * research/fetch-positioning.mjs. */
function unzipOne(buf) {
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('not a zip archive')
  const entries = buf.readUInt16LE(end + 10)
  if (entries !== 1) throw new Error('expected one file in the archive, found ' + entries)
  const central = buf.readUInt32LE(end + 16)
  if (buf.readUInt32LE(central) !== 0x02014b50) throw new Error('bad central directory')
  const method = buf.readUInt16LE(central + 10)
  const crc = buf.readUInt32LE(central + 16)
  const compressed = buf.readUInt32LE(central + 20)
  const size = buf.readUInt32LE(central + 24)
  const local = buf.readUInt32LE(central + 42)
  if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad local header')
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
  const data = buf.subarray(start, start + compressed)
  const out = method === 8 ? inflateRawSync(data) : method === 0 ? Buffer.from(data) : null
  if (out === null) throw new Error('unsupported compression method ' + method)
  if (out.length !== size || crc32(out) >>> 0 !== crc) throw new Error('length or CRC does not match the archive')
  return out.toString('utf-8')
}

/** Open times are milliseconds, or microseconds in newer spot files; the futures files carry a
 * header row, which does not parse as a number and is skipped. */
function parseKlines(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const cells = line.trim().split(',')
    if (cells.length < 6 || cells[0].trim() === '') continue
    let open = Number(cells[0])
    if (!Number.isFinite(open)) continue
    if (open > 1e14) open = Math.floor(open / 1000)
    const values = cells.slice(1, 6).map(Number)
    if (!values.every(Number.isFinite)) continue
    rows.push([Math.floor(open / 1000), ...values])
  }
  return rows
}

const inFlight = new Map()
let downloaded = 0

/** True when the day is on disk (fetched now or before), false when Binance has no such file. */
function day(market, symbol, date) {
  const key = `${market}/${symbol}/${date}`
  if (inFlight.has(key)) return inFlight.get(key)
  const promise = (async () => {
    const file = join(DIR, 'klines', market, symbol, `${date}.json`)
    const missing = join(DIR, 'klines', market, symbol, `${date}.missing`)
    if (existsSync(file)) return true
    if (existsSync(missing)) return false
    const url = `${BASE[market]}/${symbol}/1m/${symbol}-1m-${date}.zip`
    mkdirSync(dirname(file), { recursive: true })
    const zip = await get(url)
    if (zip === null) {
      writeFileSync(missing, '')
      return false
    }
    const sum = await get(url + '.CHECKSUM')
    if (sum !== null) {
      const expected = sum.toString('utf-8').trim().split(/\s+/)[0].toLowerCase()
      if (createHash('sha256').update(zip).digest('hex') !== expected) throw new Error('checksum does not match: ' + url)
    }
    writeFileSync(file, JSON.stringify(parseKlines(unzipOne(zip))))
    downloaded++
    return true
  })()
  inFlight.set(key, promise)
  return promise
}

const pairs = JSON.parse(readFileSync(join(DIR, 'pairs.json'), 'utf-8'))
const manifestFile = join(DIR, 'manifest.json')
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf-8')) : {}

let next = 0
let done = 0
const started = Date.now()
async function worker() {
  while (next < pairs.length) {
    const pair = pairs[next++]
    if (manifest[pair.key]?.status !== 'ok') {
      // The day before the announcement decides which symbol it is, and whether it traded at all.
      let chosen = null
      for (const symbol of pair.candidates) {
        if (await day(pair.market, symbol, pair.days[2])) {
          chosen = symbol
          break
        }
      }
      if (chosen === null) manifest[pair.key] = { status: 'none', tried: pair.candidates }
      else {
        for (const date of pair.days) await day(pair.market, chosen, date)
        manifest[pair.key] = { status: 'ok', symbol: chosen }
      }
    }
    done++
    if (done % 50 === 0) {
      console.log(`  ${done} of ${pairs.length} coins, ${downloaded} days read, ${((Date.now() - started) / 1000).toFixed(0)}s`)
      writeFileSync(manifestFile, JSON.stringify(manifest))
    }
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker))
writeFileSync(manifestFile, JSON.stringify(manifest))

const tally = {}
for (const pair of pairs) {
  const key = `${pair.category} ${manifest[pair.key].status === 'ok' ? 'read' : 'not trading the day before'}`
  tally[key] = (tally[key] || 0) + 1
}
console.log(`${pairs.length} coins, ${downloaded} days read this run, ${((Date.now() - started) / 1000).toFixed(0)}s`)
for (const [key, count] of Object.entries(tally).sort()) console.log(`  ${key}: ${count}`)
