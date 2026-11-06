// V9-MACRO-2'S CALENDAR (V9 Stage 6, 6 November 2026; registered 6 November 2026 before anything was read). The U.S.
// releases from 2018 to the end of Bitcoin's 15-minute bars on file, at the times they were actually made, written to
// research/v9-macro-calendar.json -- a research folder, not shared/calendar -- and committed with the study before its
// held-out half is read:
//   CPI, PPI, JOBS  BLS's yearly schedules of releases, 2018 to 2025, read from the Internet Archive's copy of each
//                   (www.bls.gov answers a program with 403 since November 2026); the copy of 2025 was taken on
//                   19 December 2025, after the shutdown's postponed releases were rescheduled, so September's CPI is at
//                   24 October and its jobs report at 20 November, as they were made; 2026 from shared/calendar/
//                   macro-2026.json (read from BLS's own page in a browser on 16 October 2026).
//   FOMC            the Federal Reserve's own pages: its meetings of 2018 to 2020 (fomchistorical<year>.htm), and of 2021
//                   on (fomccalendars.htm); each scheduled meeting's statement at 2:00 PM Eastern on its last day.
//                   Unscheduled meetings and conference calls (March 2020's two among them) are left out: their
//                   statements came at other hours, and a scheduled meeting's is the question.
// Eastern times become UTC by the U.S. daylight-saving rule (research/fetch-macro-calendar.mjs).
//
//   node research/v9MacroCalendar.mjs
//
// It reads public pages and writes one file.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { easternToUtcSec, parseBlsRows } from './fetch-macro-calendar.mjs'

const OUT = process.env.OUT ?? 'research/v9-macro-calendar.json'
const BARS = process.env.BARS ?? 'E:/Code/newtradingbot/.candles/BTCUSDT-15m.json'
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The Internet Archive's copy of each year's BLS schedule: a snapshot taken after the year's last release was set. */
const BLS_SNAPSHOTS = {
  2018: '20181203192447',
  2019: '20200404073844',
  2020: '20210416190556',
  2021: '20220315042744',
  2022: '20221220043602',
  2023: '20240327094954',
  2024: '20250315051743',
  2025: '20251219183941'
}

async function page(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90_000), headers: { 'User-Agent': 'Mozilla/5.0 (research)' } })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.text()
}

const event = (kind, year, month, day, hour, minute, extra = {}) => ({
  kind,
  date: `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  timeEt: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  at: easternToUtcSec(year, month, day, hour, minute),
  ...extra
})

/** A historical year's page: each "January 29-30 Meeting - 2019" (or "October 31-November 1 Meeting - 2018"), its last
 * day. The page of 2018 writes its July 31-August 1 meeting "Aug 31-1": a short month name is read, and the last day is
 * in the month named last. */
function fomcHistorical(html, year) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
  const names = [...MONTHS, ...SHORT].join('|')
  const monthOf = (name) => (MONTHS.includes(name) ? MONTHS.indexOf(name) : SHORT.indexOf(name))
  const out = []
  for (const match of text.matchAll(new RegExp(`\\b(${names})\\s+(\\d{1,2})-(?:(${names})\\s+)?(\\d{1,2})\\s+Meeting\\s+-\\s+${year}\\b`, 'g'))) {
    out.push(event('FOMC', year, monthOf(match[3] ?? match[1]), Number(match[4]), 14, 0))
  }
  return out
}

/** The current page's meetings of a year: each month cell ("Jan/Feb") and date cell ("31-1*"), its last day. */
function fomcCurrent(html, year) {
  const start = html.indexOf(`${year} FOMC Meetings`)
  if (start < 0) return []
  const next = html.indexOf('FOMC Meetings</', start + 20)
  const section = html.slice(start, next > start ? next : start + 20_000)
  const out = []
  for (const match of section.matchAll(/fomc-meeting__month[^>]*>([\s\S]*?)<\/div>[\s\S]*?fomc-meeting__date[^>]*>([\s\S]*?)<\/div>/g)) {
    const months = match[1].replace(/<[^>]+>/g, '').trim().split('/')
    const days = /(\d{1,2})(?:-(\d{1,2}))?/.exec(match[2].replace(/<[^>]+>/g, ''))
    if (days === null || /notation|unscheduled|conference/i.test(match[2])) continue
    const last = months[months.length - 1].slice(0, 3)
    const month = SHORT.indexOf(last)
    if (month < 0) continue
    out.push(event('FOMC', year, month, Number(days[2] ?? days[1]), 14, 0))
  }
  return out
}

const bars = JSON.parse(readFileSync(BARS, 'utf-8'))
const barsEnd = bars[bars.length - 1][0] + 900
const events = []
for (const [year, stamp] of Object.entries(BLS_SNAPSHOTS)) {
  const rows = parseBlsRows(await page(`https://web.archive.org/web/${stamp}id_/https://www.bls.gov/schedule/${year}/home.htm`), Number(year))
  events.push(...rows.map((row) => ({ kind: row.kind, date: row.date, timeEt: row.timeEt, at: row.at, reference: row.reference ?? null, source: `bls-${year}@${stamp}` })))
}
const calendar2026 = JSON.parse(readFileSync('shared/calendar/macro-2026.json', 'utf-8'))
for (const row of calendar2026.events) if (row.kind !== 'FOMC') events.push({ kind: row.kind, date: row.date, timeEt: row.timeEt, at: row.at, reference: null, source: 'shared/calendar/macro-2026.json' })
for (const year of [2018, 2019, 2020]) events.push(...fomcHistorical(await page(`https://www.federalreserve.gov/monetarypolicy/fomchistorical${year}.htm`), year).map((row) => ({ ...row, reference: null, source: `fed-historical-${year}` })))
const current = await page('https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm')
for (const year of [2021, 2022, 2023, 2024, 2025, 2026]) events.push(...fomcCurrent(current, year).map((row) => ({ ...row, reference: null, source: 'fed-fomccalendars' })))

const kept = events.filter((row) => row.at >= Date.UTC(2018, 0, 1) / 1000 && row.at + 900 <= barsEnd).sort((a, b) => a.at - b.at || a.kind.localeCompare(b.kind))
const unique = kept.filter((row, index) => index === 0 || !(row.at === kept[index - 1].at && row.kind === kept[index - 1].kind))
const counts = {}
for (const row of unique) counts[`${row.date.slice(0, 4)} ${row.kind}`] = (counts[`${row.date.slice(0, 4)} ${row.kind}`] ?? 0) + 1
const file = { version: 'v9-macro-calendar-v1', readAt: new Date().toISOString(), barsEnd, counts, events: unique }
const text = `${JSON.stringify(file, null, 1)}\n`
writeFileSync(OUT, text)
console.log(`${unique.length} releases to ${new Date(barsEnd * 1000).toISOString().slice(0, 16)}; sha256 ${createHash('sha256').update(text).digest('hex')}`)
console.log(Object.entries(counts).map(([key, count]) => `${key} ${count}`).join(', '))
