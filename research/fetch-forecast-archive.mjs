// A YEAR OF FIVE-MINUTE BARS FROM BINANCE'S PUBLIC ARCHIVE (V7.2-R Stage 6, 22 October 2026), for the long walk
// forward and the direction hypotheses -- written into a SCRATCH folder, never a profile's forecastData/: the live
// forecast keeps its ninety days and never reads this.
//
//   OUT=<scratch>/archive-profile FROM=2025-10 TO=2026-09 node research/fetch-forecast-archive.mjs
//   [TOP=40] [STEP=universe|bars|all] [SYMBOLS=BTCUSDT,ETHUSDT]
//
// THE PAIRS OF EACH MONTH, READ FROM THE ARCHIVE ITSELF, so that a coin delisted since or listed late is in the months
// it was large in, and today's winners are not chosen with hindsight: every USDT spot pair Binance has ever archived
// (the bucket's listing), less the stable, fiat, wrapped and pegged coins, the leveraged tokens and the tokens that track a
// stock (as the app's scanner leaves them out), ranked at each month's start by its
// quote volume over the month before (its daily klines, a few kilobytes a month); the TOP of them, with Bitcoin and ether
// always, are the month's universe (universe.json, with the pairs that entered and left). Then the five-minute klines of
// every pair for every month it is in the universe and the month before it (the features' warm-up), each zip checked
// against the SHA-256 Binance publishes beside it, its one CSV read with zlib, written as the app's bar lines
// (shared/forecast/bars.ts barToLine: [time, open, high, low, close, volume, quoteVolume, takerBuyVolume, trades]) in
// <OUT>/forecastArchive/<PAIR>-YYYY-MM.jsonl. A manifest (archive-manifest.json) records every file asked for and what
// came back, so a run resumes where it stopped. Times are seconds; the archive's own are milliseconds, or microseconds
// in its files since 2025, told apart by size. Public data, no key.

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { crc32, inflateRawSync } from 'zlib'

const BASE = 'https://data.binance.vision/data/spot/monthly/klines'
const LISTING = 'https://s3-ap-northeast-1.amazonaws.com/data.binance.vision'
const OUT = process.env.OUT
if (!OUT) throw new Error('OUT is the scratch folder to write into')
const FROM = process.env.FROM || '2025-10'
const TO = process.env.TO || '2026-09'
const TOP = Number(process.env.TOP || 40)
const STEP = process.env.STEP || 'all'
/** KEEP_DAILY=1 keeps each pair's daily klines the ranking reads, as bar lines in <OUT>/daily/<PAIR>-YYYY-MM.jsonl: every
 * USDT pair of every month, delisted ones included, for the daily direction studies (V10 Stage 5, 19 November 2026). */
const KEEP_DAILY = process.env.KEEP_DAILY === '1'
const WORKERS = 6
/** Bitcoin and ether are in every month: the market's figures are read from them. */
const ALWAYS = ['BTCUSDT', 'ETHUSDT']
/** Bases that are a currency, a stable coin or a wrapped or pegged one, not a coin whose price is forecast: the
 * scanner's own (shared/marketEvent.ts SCAN_EXCLUDED_BASES, BNSOL and U among them) and the older ones the archive
 * still lists. */
const NOT_COINS = new Set(['USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'PAX', 'USDS', 'USDSB', 'SUSD', 'UST', 'USTC', 'EUR', 'EURI', 'AEUR', 'GBP', 'AUD', 'TRY', 'BRL', 'RUB', 'UAH', 'NGN', 'ZAR', 'BIDR', 'IDRT', 'BVND', 'VAI', 'XUSD', 'USD1', 'RLUSD', 'BFUSD', 'PYUSD', 'USDE', 'PAXG', 'WBTC', 'WBETH', 'BETH', 'BNSOL', 'XAUT', 'U'])
/** The trading group Binance keeps its tokens that track a US stock or fund in (electron/services/exchanges/binance.ts
 * STOCK_TOKEN_GROUP): read from today's public listing, so a stock token delisted before today is not known as one. */
const STOCK_TOKEN_GROUP = 'TRD_GRP_261'
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function monthsBetween(from, to) {
  const out = []
  let [y, m] = from.split('-').map(Number)
  const [ty, tm] = to.split('-').map(Number)
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return out
}

function monthBefore(month) {
  let [y, m] = month.split('-').map(Number)
  m--
  if (m < 1) {
    m = 12
    y--
  }
  return `${y}-${String(m).padStart(2, '0')}`
}

/** The body, or null when the file does not exist; everything else retried, more slowly each time. */
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

/** The one file in a zip, from its central directory; its CRC and length checked as well as the archive's checksum. */
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

/** 'missing' where Binance holds no such file; otherwise the CSV, once its checksum has passed, and the checksum. */
async function archive(url) {
  const zip = await get(url)
  if (zip === null) return { status: 'missing' }
  const sum = await get(url + '.CHECKSUM')
  const actual = createHash('sha256').update(zip).digest('hex')
  if (sum === null) return { status: 'unchecked', sha256: actual, text: unzipOne(zip) }
  const expected = sum.toString('utf-8').trim().split(/\s+/)[0].toLowerCase()
  if (expected !== actual) throw new Error('checksum does not match: ' + url)
  return { status: 'ok', sha256: actual, text: unzipOne(zip) }
}

/** A kline CSV as the app's bar lines: the open time in seconds (the archive's milliseconds or microseconds told apart
 * by size), the prices, the volumes and the trades; the header and any short line skipped. */
export function barLinesOf(text) {
  const out = []
  for (const line of text.split('\n')) {
    const cells = line.trim().split(',')
    if (cells.length < 11 || cells[0].trim() === '') continue
    let open = Number(cells[0])
    if (!Number.isFinite(open)) continue
    if (open > 1e14) open = Math.floor(open / 1000)
    const figures = [cells[1], cells[2], cells[3], cells[4], cells[5], cells[7], cells[9]].map(Number)
    const trades = Number(cells[8])
    if (!figures.every(Number.isFinite) || !Number.isFinite(trades)) continue
    const [o, h, l, c, volume, quoteVolume, takerBuyVolume] = figures
    out.push([Math.floor(open / 1000), o, h, l, c, volume, quoteVolume, takerBuyVolume, trades])
  }
  return out
}

/** Every USDT spot pair the archive holds klines of, from the bucket's listing, a page of a thousand at a time. */
async function listedPairs() {
  const out = []
  let marker = ''
  for (;;) {
    const page = (await get(`${LISTING}?delimiter=/&prefix=data/spot/monthly/klines/${marker === '' ? '' : `&marker=${encodeURIComponent(marker)}`}`)).toString('utf-8')
    for (const match of page.matchAll(/<Prefix>data\/spot\/monthly\/klines\/([A-Z0-9]+)\/<\/Prefix>/g)) out.push(match[1])
    const next = /<NextMarker>([^<]+)<\/NextMarker>/.exec(page)?.[1]
    if (!/<IsTruncated>true<\/IsTruncated>/.test(page) || next === undefined) break
    marker = next
  }
  const stock = await stockTokens()
  return out.filter((pair) => pair.endsWith('USDT') && !LEVERAGED.test(pair) && !NOT_COINS.has(pair.slice(0, -4)) && !stock.has(pair))
}

/** The pairs Binance lists today in its stock tokens' trading group: a stock token's moves are its stock's, as the
 * scanner found (shared/marketEvent.ts isScannablePair). */
async function stockTokens() {
  const body = await get('https://data-api.binance.vision/api/v3/exchangeInfo?permissions=SPOT')
  if (body === null) throw new Error("Binance's listing could not be read for its stock tokens")
  const symbols = JSON.parse(body.toString('utf-8')).symbols ?? []
  return new Set(symbols.filter((s) => (s.permissionSets ?? []).some((set) => Array.isArray(set) && set.includes(STOCK_TOKEN_GROUP))).map((s) => s.symbol))
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : fallback
}

async function pool(tasks, onDone) {
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]
      await task()
      onDone()
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker))
}

mkdirSync(join(OUT, 'forecastArchive'), { recursive: true })
const manifestFile = join(OUT, 'archive-manifest.json')
const manifest = readJson(manifestFile, { version: 'forecast-archive-v1', from: FROM, to: TO, top: TOP, files: {} })
const saveManifest = () => writeFileSync(manifestFile, JSON.stringify(manifest, null, 1))
const months = monthsBetween(FROM, TO)

// 1. THE UNIVERSE: each month's pairs by the quote volume of the month before it, from the daily klines.
const universeFile = join(OUT, 'universe.json')
let universe = readJson(universeFile, null)
if ((STEP === 'universe' || STEP === 'all') && universe === null) {
  const pairs = process.env.SYMBOLS ? process.env.SYMBOLS.split(',') : await listedPairs()
  console.log(`${pairs.length} USDT pairs in the archive's listing (stable and fiat coins and leveraged tokens left out)`)
  const volumeOf = {}
  const tasks = []
  for (const month of months.map(monthBefore)) {
    for (const pair of pairs) {
      tasks.push(async () => {
        const key = `1d/${pair}-${month}`
        const held = manifest.files[key]
        if (held !== undefined && held.status !== 'error') {
          if (held.quoteVolume !== undefined) (volumeOf[month] ??= {})[pair] = held.quoteVolume
          return
        }
        try {
          const read = await archive(`${BASE}/${pair}/1d/${pair}-1d-${month}.zip`)
          if (read.status === 'missing') {
            manifest.files[key] = { status: 'missing' }
            return
          }
          const rows = barLinesOf(read.text)
          if (KEEP_DAILY) {
            mkdirSync(join(OUT, 'daily'), { recursive: true })
            writeFileSync(join(OUT, 'daily', `${pair}-${month}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
          }
          const quoteVolume = rows.reduce((sum, row) => sum + row[6], 0)
          manifest.files[key] = { status: read.status, sha256: read.sha256, rows: rows.length, quoteVolume }
          ;(volumeOf[month] ??= {})[pair] = quoteVolume
        } catch (err) {
          manifest.files[key] = { status: 'error', error: String(err).slice(0, 200) }
        }
      })
    }
  }
  let done = 0
  await pool(tasks, () => {
    done++
    if (done % 500 === 0 || done === tasks.length) {
      console.error(`  daily klines: ${done} of ${tasks.length}`)
      saveManifest()
    }
  })
  saveManifest()
  universe = { version: 'forecast-archive-universe-v1', top: TOP, rule: 'the TOP USDT pairs by the quote volume of the month before, Bitcoin and ether always', months: {} }
  let previous = []
  for (const month of months) {
    const volumes = volumeOf[monthBefore(month)] ?? {}
    const ranked = Object.entries(volumes)
      .filter(([, volume]) => volume > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([pair]) => pair)
    const chosen = [...new Set([...ALWAYS, ...ranked])].slice(0, Math.max(TOP, ALWAYS.length))
    universe.months[month] = { pairs: chosen, entered: chosen.filter((pair) => !previous.includes(pair)), left: previous.filter((pair) => !chosen.includes(pair)), volumes: Object.fromEntries(chosen.map((pair) => [pair, Math.round(volumes[pair] ?? 0)])) }
    previous = chosen
  }
  writeFileSync(universeFile, JSON.stringify(universe, null, 1))
  for (const month of months) {
    const entry = universe.months[month]
    console.log(`  ${month}: ${entry.pairs.length} pairs${entry.entered.length > 0 && month !== months[0] ? `; entered ${entry.entered.join(' ')}` : ''}${entry.left.length > 0 ? `; left ${entry.left.join(' ')}` : ''}`)
  }
}

// 2. THE BARS: every pair's five-minute klines for each month it is in the universe and the month before it.
if ((STEP === 'bars' || STEP === 'all') && universe !== null) {
  const wanted = new Map()
  for (const month of months) {
    for (const pair of universe.months[month].pairs) {
      for (const m of [monthBefore(month), month]) {
        if (!wanted.has(pair)) wanted.set(pair, new Set())
        wanted.get(pair).add(m)
      }
    }
  }
  const tasks = []
  for (const [pair, set] of wanted) {
    for (const month of [...set].sort()) {
      tasks.push(async () => {
        const key = `5m/${pair}-${month}`
        const file = join(OUT, 'forecastArchive', `${pair}-${month}.jsonl`)
        const held = manifest.files[key]
        if (held !== undefined && (held.status === 'missing' || ((held.status === 'ok' || held.status === 'unchecked') && existsSync(file)))) return
        try {
          const read = await archive(`${BASE}/${pair}/5m/${pair}-5m-${month}.zip`)
          if (read.status === 'missing') {
            manifest.files[key] = { status: 'missing' }
            return
          }
          const rows = barLinesOf(read.text)
          writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''))
          manifest.files[key] = { status: read.status, sha256: read.sha256, rows: rows.length, first: rows[0]?.[0] ?? null, last: rows[rows.length - 1]?.[0] ?? null }
        } catch (err) {
          manifest.files[key] = { status: 'error', error: String(err).slice(0, 200) }
        }
      })
    }
  }
  console.log(`${wanted.size} pairs, ${tasks.length} month files of five-minute bars`)
  let done = 0
  await pool(tasks, () => {
    done++
    if (done % 25 === 0 || done === tasks.length) {
      console.error(`  five-minute klines: ${done} of ${tasks.length}`)
      saveManifest()
    }
  })
  saveManifest()
  const files = Object.entries(manifest.files).filter(([key]) => key.startsWith('5m/'))
  const by = (status) => files.filter(([, entry]) => entry.status === status).length
  console.log(`five-minute files: ${by('ok')} checked, ${by('unchecked')} without a published checksum, ${by('missing')} not in the archive, ${by('error')} failed${by('error') > 0 ? ' (run again to retry them)' : ''}`)
}
