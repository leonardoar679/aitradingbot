// Downloads Binance's futures positioning archives from data.binance.vision (free, no key): the
// five-minute metrics -- open interest, the long/short ratios of accounts and of top traders, the
// taker buy/sell volume ratio on the perpetual -- the five-minute premium index the funding rate
// is computed from, and the settled funding rate itself. research/POSITIONING.md says what for.
//
//   SET=large node research/fetch-positioning.mjs     the discovery and confirm pairs
//   SET=small node research/fetch-positioning.mjs     the smaller pairs that have a perpetual
//   SYMBOLS=BTCUSDT,DOTUSDT FROM=2026-09-01 TO=2026-10-03 OUT=.candles/positioning-check node research/fetch-positioning.mjs
//
// Writes into OUT (default .candles/positioning), per pair:
//   SYMBOL-metrics.json     [[timeSec, openInterest, openInterestValue, topAccountRatio,
//                             topPositionRatio, accountRatio, takerRatio], ...]
//   SYMBOL-premium-5m.json  [[openTimeSec, open, high, low, close], ...]
//   SYMBOL-funding.json     [[timeSec, rate, intervalHours], ...]
//   SYMBOL-manifest.json    every file asked for and what came back, so a re-run resumes
//
// Times are SECONDS, as in research/fetch.mjs. A ratio is longs over shorts (or buys over sells),
// as Binance publishes it; a missing cell is null, never 0. Every zip is checked against the
// SHA-256 Binance publishes beside it before it is read, and unzipped with zlib: each archive holds
// one CSV, so no zip library is needed. The run ends with a list of every gap it found.

import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { crc32, inflateRawSync } from 'zlib'

const BASE = 'https://data.binance.vision/data/futures/um'
const OUT = process.env.OUT || '.candles/positioning'
const WORKERS = 6

// One month before the candles start, so the first events have a day of history behind them and
// the first readings are not taken on an empty series.
const SETS = {
  large: {
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT', 'BNBUSDT', 'LINKUSDT', 'LTCUSDT', 'XRPUSDT'],
    from: '2023-05-01',
    to: '2026-08-29'
  },
  // RAYUSDT, the eighth smaller pair in research/EVENTS.md, has no USDT-margined perpetual.
  small: {
    symbols: ['STRKUSDT', 'FETUSDT', 'SUPERUSDT', 'AXSUSDT', 'DOTUSDT', 'ICPUSDT', 'ARKUSDT'],
    from: '2025-08-01',
    to: '2026-10-01'
  }
}

const preset = SETS[process.env.SET || 'large']
if (!preset && !process.env.SYMBOLS) throw new Error('SET must be large or small, or SYMBOLS, FROM and TO given')
const SYMBOLS = process.env.SYMBOLS ? process.env.SYMBOLS.split(',') : preset.symbols
const FROM = process.env.FROM || preset.from
const TO = process.env.TO || preset.to

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function daysBetween(from, to) {
  const days = []
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10))
  }
  return days
}

function monthsBetween(from, to) {
  return [...new Set(daysBetween(from, to).map((day) => day.slice(0, 7)))]
}

/** The body, or null when the file does not exist. Retries on everything else, exponentially, as
 * research/fetch.mjs does: a run that gives up on a DNS blip loses hours of paging. */
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

/** The one file in a zip, read from the central directory, which (unlike the local header) always
 * carries the sizes. Its CRC and length are checked as well as the archive's checksum. */
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

/** 'missing' when Binance has no such file; otherwise the CSV, after its checksum has passed. */
async function archive(url) {
  const zip = await get(url)
  if (zip === null) return { status: 'missing' }
  const sum = await get(url + '.CHECKSUM')
  if (sum === null) return { status: 'unchecked', text: unzipOne(zip) }
  const expected = sum.toString('utf-8').trim().split(/\s+/)[0].toLowerCase()
  const actual = createHash('sha256').update(zip).digest('hex')
  if (expected !== actual) throw new Error('checksum does not match: ' + url)
  return { status: 'ok', text: unzipOne(zip) }
}

const cell = (value) => {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/** create_time is a UTC wall-clock string; anything that does not parse as one (the header) is
 * not a row. */
function parseMetrics(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const cells = line.trim().split(',')
    if (cells.length < 8) continue
    const time = Date.parse(cells[0].trim().replace(' ', 'T') + 'Z')
    if (!Number.isFinite(time)) continue
    rows.push([time / 1000, cell(cells[2]), cell(cells[3]), cell(cells[4]), cell(cells[5]), cell(cells[6]), cell(cells[7])])
  }
  return rows
}

/** Kline archives carry the open time in milliseconds, or in microseconds in some newer files. */
function parseKlines(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const cells = line.trim().split(',')
    if (cells.length < 5) continue
    let open = Number(cells[0])
    if (!Number.isFinite(open) || cells[0].trim() === '') continue
    if (open > 1e14) open = Math.floor(open / 1000)
    rows.push([Math.floor(open / 1000), cell(cells[1]), cell(cells[2]), cell(cells[3]), cell(cells[4])])
  }
  return rows
}

function parseFunding(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const cells = line.trim().split(',')
    if (cells.length < 3) continue
    const time = Number(cells[0])
    if (!Number.isFinite(time) || cells[0].trim() === '') continue
    rows.push([Math.floor(time / 1000), cell(cells[2]), cell(cells[1])])
  }
  return rows
}

function readJson(file, fallback) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : fallback
}

/** Runs the tasks WORKERS at a time. */
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

function ranges(days) {
  // 2024-01-01..2024-01-03, 2024-02-07 -- consecutive days collapsed.
  const out = []
  let start = null
  let previous = null
  for (const day of days) {
    if (previous !== null && Date.parse(day) - Date.parse(previous) === 86_400_000) {
      previous = day
      continue
    }
    if (start !== null) out.push(start === previous ? start : start + '..' + previous)
    start = day
    previous = day
  }
  if (start !== null) out.push(start === previous ? start : start + '..' + previous)
  return out
}

async function fetchSymbol(symbol) {
  const started = Date.now()
  const files = {
    metrics: join(OUT, symbol + '-metrics.json'),
    premium: join(OUT, symbol + '-premium-5m.json'),
    funding: join(OUT, symbol + '-funding.json'),
    manifest: join(OUT, symbol + '-manifest.json')
  }
  const manifest = readJson(files.manifest, { metrics: {}, premium: {}, premiumDaily: {}, funding: {}, unchecked: [] })
  const series = {
    metrics: new Map(readJson(files.metrics, []).map((row) => [row[0], row])),
    premium: new Map(readJson(files.premium, []).map((row) => [row[0], row])),
    funding: new Map(readJson(files.funding, []).map((row) => [row[0], row]))
  }
  const save = () => {
    for (const key of ['metrics', 'premium', 'funding']) {
      writeFileSync(files[key], JSON.stringify([...series[key].values()].sort((a, b) => a[0] - b[0])))
    }
    writeFileSync(files.manifest, JSON.stringify(manifest))
  }
  const take = (key, rows) => {
    for (const row of rows) series[key].set(row[0], row)
  }
  const done = (entry) => entry !== undefined && entry !== 'error'

  const tasks = []
  for (const day of daysBetween(FROM, TO)) {
    if (done(manifest.metrics[day])) continue
    tasks.push(async () => {
      const url = `${BASE}/daily/metrics/${symbol}/${symbol}-metrics-${day}.zip`
      try {
        const result = await archive(url)
        if (result.status === 'missing') {
          manifest.metrics[day] = 'missing'
          return
        }
        if (result.status === 'unchecked') manifest.unchecked.push(url)
        const rows = parseMetrics(result.text)
        take('metrics', rows)
        manifest.metrics[day] = rows.length
      } catch (err) {
        manifest.metrics[day] = 'error'
        console.error('  ' + symbol + ' metrics ' + day + ': ' + String(err).slice(0, 160))
      }
    })
  }
  for (const month of monthsBetween(FROM, TO)) {
    if (!done(manifest.funding[month])) {
      tasks.push(async () => {
        const url = `${BASE}/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`
        try {
          const result = await archive(url)
          if (result.status === 'missing') {
            manifest.funding[month] = 'missing'
            return
          }
          if (result.status === 'unchecked') manifest.unchecked.push(url)
          const rows = parseFunding(result.text)
          take('funding', rows)
          manifest.funding[month] = rows.length
        } catch (err) {
          manifest.funding[month] = 'error'
          console.error('  ' + symbol + ' funding ' + month + ': ' + String(err).slice(0, 160))
        }
      })
    }
    if (done(manifest.premium[month])) continue
    tasks.push(async () => {
      const url = `${BASE}/monthly/premiumIndexKlines/${symbol}/5m/${symbol}-5m-${month}.zip`
      try {
        const result = await archive(url)
        if (result.status !== 'missing') {
          if (result.status === 'unchecked') manifest.unchecked.push(url)
          const rows = parseKlines(result.text)
          take('premium', rows)
          manifest.premium[month] = rows.length
          return
        }
        // The month is not published as one file yet (the latest one, usually): take its days.
        let failed = false
        for (const day of daysBetween(FROM, TO).filter((entry) => entry.startsWith(month))) {
          if (done(manifest.premiumDaily[day])) continue
          const dayUrl = `${BASE}/daily/premiumIndexKlines/${symbol}/5m/${symbol}-5m-${day}.zip`
          try {
            const daily = await archive(dayUrl)
            if (daily.status === 'missing') {
              manifest.premiumDaily[day] = 'missing'
              continue
            }
            if (daily.status === 'unchecked') manifest.unchecked.push(dayUrl)
            const rows = parseKlines(daily.text)
            take('premium', rows)
            manifest.premiumDaily[day] = rows.length
          } catch (err) {
            failed = true
            manifest.premiumDaily[day] = 'error'
            console.error('  ' + symbol + ' premium ' + day + ': ' + String(err).slice(0, 160))
          }
        }
        manifest.premium[month] = failed ? 'error' : 'daily'
      } catch (err) {
        manifest.premium[month] = 'error'
        console.error('  ' + symbol + ' premium ' + month + ': ' + String(err).slice(0, 160))
      }
    })
  }

  let completed = 0
  await pool(tasks, () => {
    completed++
    // Checkpoint: a crash late in a pair keeps what came before it, and the manifest resumes it.
    if (completed % 300 === 0) {
      save()
      console.log('  ' + symbol + ': ' + completed + ' of ' + tasks.length + ' files')
    }
  })
  save()
  console.log(`${symbol}: ${tasks.length} files fetched in ${((Date.now() - started) / 1000).toFixed(0)}s`)
  return { symbol, manifest, series }
}

/** Everything that is not a clean, complete series, so a reader of the study knows what it stood on. */
function report({ symbol, manifest, series }) {
  const lines = [symbol]
  const days = daysBetween(FROM, TO)
  const missingDays = days.filter((day) => manifest.metrics[day] === 'missing')
  const failedDays = days.filter((day) => manifest.metrics[day] === 'error')
  const shortDays = days.filter((day) => typeof manifest.metrics[day] === 'number' && manifest.metrics[day] < 288)
  lines.push(
    `  metrics: ${series.metrics.size} rows over ${days.length} days; missing ${missingDays.length}${missingDays.length ? ' (' + ranges(missingDays).join(', ') + ')' : ''}` +
      `; failed ${failedDays.length}${failedDays.length ? ' (' + ranges(failedDays).join(', ') + ')' : ''}; fewer than 288 rows on ${shortDays.length}`
  )
  const metricRows = [...series.metrics.values()].sort((a, b) => a[0] - b[0])
  const offGrid = metricRows.filter((row) => row[0] % 300 !== 0).length
  const nulls = [1, 2, 3, 4, 5, 6].map((column) => metricRows.filter((row) => row[column] === null).length)
  let holes = 0
  let longest = 0
  for (let i = 1; i < metricRows.length; i++) {
    const gap = metricRows[i][0] - metricRows[i - 1][0]
    if (gap > 300) {
      holes++
      longest = Math.max(longest, gap)
    }
  }
  lines.push(
    `  metrics: ${offGrid} rows off the five-minute grid; ${holes} holes in the series, the longest ${(longest / 60).toFixed(0)} min; ` +
      `empty cells by column (oi, oiValue, topAccount, topPosition, account, taker): ${nulls.join(', ')}`
  )
  const months = monthsBetween(FROM, TO)
  const premiumRows = [...series.premium.values()].sort((a, b) => a[0] - b[0])
  let premiumHoles = 0
  for (let i = 1; i < premiumRows.length; i++) if (premiumRows[i][0] - premiumRows[i - 1][0] > 300) premiumHoles++
  const premiumMissing = months.filter((month) => manifest.premium[month] === 'missing' || manifest.premium[month] === 'error')
  const fromDays = months.filter((month) => manifest.premium[month] === 'daily')
  lines.push(
    `  premium: ${premiumRows.length} bars; ${premiumHoles} holes; months not fetched ${premiumMissing.length ? premiumMissing.join(', ') : 'none'}` +
      `; months taken day by day ${fromDays.length ? fromDays.join(', ') : 'none'}`
  )
  const fundingMissing = months.filter((month) => manifest.funding[month] === 'missing' || manifest.funding[month] === 'error')
  lines.push(`  funding: ${series.funding.size} settlements; months not fetched ${fundingMissing.length ? fundingMissing.join(', ') : 'none'}`)
  if (manifest.unchecked.length) lines.push(`  ${manifest.unchecked.length} archives had no checksum to check against`)
  return lines.join('\n')
}

mkdirSync(OUT, { recursive: true })
console.log(`${SYMBOLS.join(', ')}: ${FROM} to ${TO}, into ${OUT}`)
const results = []
for (const symbol of SYMBOLS) results.push(await fetchSymbol(symbol))
console.log('\n--- what was fetched, and every gap in it ---')
for (const result of results) console.log(report(result))
