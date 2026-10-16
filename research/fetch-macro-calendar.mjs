// THE MACRO CALENDAR (V7.1 Stage 12, 16 October 2026): the U.S. releases that move every market at once,
// compiled from the public schedules into shared/calendar/macro-2026.json -- versioned data, no key.
//
//   CPI   the Consumer Price Index          BLS, 8:30 AM Eastern
//   PPI   the Producer Price Index          BLS, 8:30 AM Eastern
//   JOBS  the Employment Situation          BLS, 8:30 AM Eastern
//   FOMC  the FOMC statement                 the Federal Reserve, 2:00 PM Eastern on the meeting's last day
//
// ETF decisions and token unlocks have no free, dated source and are left out, said so on the page.
//
//   node research/fetch-macro-calendar.mjs                       the Fed's page read live; BLS tried live
//   BLS_FROM=<a text file> node research/fetch-macro-calendar.mjs   the BLS schedule from a saved reading
//
// www.bls.gov answered curl with 403 (Akamai's "Access Denied") and Node's fetch with the page, on 16
// October 2026; should it refuse, its schedule is read in a browser and kept as text, one line a report:
//     CPI: January 13, February 13, March 11, ...        (dates of 2026, 8:30 AM Eastern)
// as research/macro-2026-bls.txt holds it, read from https://www.bls.gov/schedule/2026/home.htm on 16
// October 2026. The year's page lists every release in a table (a date cell, a time cell, the report and
// its reference month); the script turns each Eastern time into UTC seconds by the U.S. daylight-saving
// rule (the second Sunday of March to the first Sunday of November) and writes the file sorted by time. A
// re-run replaces the file. It reads two public pages and writes one file; nothing else.

import { readFileSync, writeFileSync } from 'fs'

const YEAR = Number(process.env.YEAR ?? 2026)
const OUT = process.env.OUT ?? 'shared/calendar/macro-2026.json'
const BLS_FROM = process.env.BLS_FROM ?? 'research/macro-2026-bls.txt'
const FED_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'
const BLS_URL = `https://www.bls.gov/schedule/${YEAR}/home.htm`
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const KINDS = { CPI: 'Consumer Price Index', PPI: 'Producer Price Index', JOBS: 'Employment Situation', FOMC: 'FOMC statement' }

/** The nth Sunday of a month, as a UTC day. */
function nthSunday(year, month, n) {
  const first = new Date(Date.UTC(year, month, 1))
  const offset = (7 - first.getUTCDay()) % 7
  return 1 + offset + (n - 1) * 7
}

/** Eastern time to UTC seconds: EDT (UTC-4) from the second Sunday of March to the first Sunday of
 * November, EST (UTC-5) otherwise. */
export function easternToUtcSec(year, month, day, hour, minute) {
  const dstStart = Date.UTC(year, 2, nthSunday(year, 2, 2), 7)
  const dstEnd = Date.UTC(year, 10, nthSunday(year, 10, 1), 6)
  const naive = Date.UTC(year, month, day, hour, minute)
  const daylight = naive + 4 * 3600_000 >= dstStart && naive + 4 * 3600_000 < dstEnd
  return Math.floor((naive + (daylight ? 4 : 5) * 3600_000) / 1000)
}

const event = (kind, year, month, day, hour, minute, extra = {}) => ({
  kind,
  name: KINDS[kind],
  date: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  timeEt: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  at: easternToUtcSec(year, month, day, hour, minute),
  ...extra
})

/** "CPI: January 13, February 13, ..." lines into events at 8:30 AM Eastern (the saved reading). */
export function parseBlsLines(text, year) {
  const out = []
  for (const line of text.split('\n')) {
    const match = /^\s*(CPI|PPI|JOBS)\s*:\s*(.+)$/.exec(line)
    if (match === null) continue
    for (const part of match[2].split(',')) {
      const date = /([A-Z][a-z]+)\s+(\d{1,2})/.exec(part.trim())
      if (date === null) continue
      const month = MONTHS.indexOf(date[1])
      if (month < 0) throw new Error(`unknown month in "${part}"`)
      out.push(event(match[1], year, month, Number(date[2]), 8, 30))
    }
  }
  return out
}

const BLS_KIND = { 'Consumer Price Index': 'CPI', 'Producer Price Index': 'PPI', 'Employment Situation': 'JOBS' }

/** The year's page: a table row a release -- "Friday, January 9, 2026", "08:30 AM", "Employment Situation
 * for December 2025" -- into events at the time the page gives, with the reference month. */
export function parseBlsRows(html, year) {
  const out = []
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
    if (cells.length < 3) continue
    const date = /([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/.exec(cells[0])
    const time = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(cells[1])
    const report = /^(Consumer Price Index|Producer Price Index|Employment Situation)\s+for\s+([A-Z][a-z]+ \d{4})/.exec(cells[2])
    if (date === null || time === null || report === null || Number(date[3]) !== year) continue
    const month = MONTHS.indexOf(date[1])
    if (month < 0) continue
    const hour = (Number(time[1]) % 12) + (time[3].toUpperCase() === 'PM' ? 12 : 0)
    out.push(event(BLS_KIND[report[1]], year, month, Number(date[2]), hour, Number(time[2]), { reference: report[2] }))
  }
  return out
}

/** The Fed's page: the year's meetings as "January 27-28" or "December 8-9" (a meeting may span two months,
 * "April 30-May 1"); the statement comes at 2:00 PM Eastern on the last day. */
export function parseFomc(html, year) {
  const start = html.indexOf(`${year} FOMC Meetings`)
  if (start < 0) throw new Error(`no ${year} meetings on the Fed's page`)
  const end = html.indexOf(`${year - 1} FOMC Meetings`, start)
  const text = html
    .slice(start, end > start ? end : start + 60_000)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
  const out = []
  const pattern = /\b([A-Z][a-z]+)\s+(\d{1,2})-(?:([A-Z][a-z]+)\s+)?(\d{1,2})\*?/g
  let match
  while ((match = pattern.exec(text)) !== null) {
    const month = MONTHS.indexOf(match[3] ?? match[1])
    if (month < 0 || MONTHS.indexOf(match[1]) < 0) continue
    const day = Number(match[4])
    out.push({ kind: 'FOMC', name: KINDS.FOMC, date: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`, timeEt: '14:00', at: easternToUtcSec(year, month, day, 14, 0) })
  }
  return out
}

async function page(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', Accept: 'text/html' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

async function main() {
  const sources = []
  const events = []
  const fed = await page(FED_URL)
  events.push(...parseFomc(fed, YEAR))
  sources.push({ kind: 'FOMC', url: FED_URL, how: 'read live' })
  let bls = null
  try {
    bls = await page(BLS_URL)
    sources.push({ kind: 'BLS', url: BLS_URL, how: 'read live' })
  } catch (error) {
    console.error(`BLS refused the request (${String(error)}); reading ${BLS_FROM}`)
    bls = readFileSync(BLS_FROM, 'utf-8')
    sources.push({ kind: 'BLS', url: BLS_URL, how: `read in a browser on 16 October 2026 and kept as ${BLS_FROM}` })
  }
  const blsEvents = bls.includes('<') ? parseBlsRows(bls, YEAR) : parseBlsLines(bls, YEAR)
  if (blsEvents.length < 30) throw new Error(`only ${blsEvents.length} BLS releases read: the page's shape may have changed`)
  events.push(...blsEvents)
  events.sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind))
  const file = {
    version: 'macro-calendar-v1',
    year: YEAR,
    readAt: new Date().toISOString().slice(0, 10),
    sources,
    leftOut: 'ETF decisions and token unlocks: no free, dated source.',
    kinds: KINDS,
    events
  }
  writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`)
  console.log(`${events.length} events of ${YEAR} written to ${OUT}: ${Object.keys(KINDS).map((kind) => `${kind} ${events.filter((event) => event.kind === kind).length}`).join(', ')}`)
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
