// Downloads Upbit's trading notices (free, no key): every page of the list Upbit's notice board
// shows under 거래 (trading) -- new listings, its caution designation and its delistings among them.
// research/UPBIT.md says what for.
//
//   node research/fetch-upbit-notices.mjs
//
// Writes .candles/upbit/notices.json: [{ id, title, releaseSec, listedSec }], newest first, as Upbit
// lists them. releaseSec is when the notice was first posted; listedSec is the time the list shows,
// which moves when a notice is edited. Only the list is read -- the title and those two times --
// never a notice's body. A re-run replaces the file.

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const OUT = process.env.OUT || '.candles/upbit'
/** Upbit answers no larger page. */
const PAGE_SIZE = 20
/** Upbit answers 429 to a list read faster than about one page every few seconds. */
const PAUSE_MS = 3000
const ATTEMPTS = 10

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function page(pageNo) {
  const url = `https://api-manager.upbit.com/api/v1/announcements?os=web&page=${pageNo}&per_page=${PAGE_SIZE}&category=trade`
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let waitMs = Math.min(2 ** attempt * 2000, 60_000)
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } })
      const retryAfter = Number(res.headers.get('retry-after'))
      if (Number.isFinite(retryAfter) && retryAfter > 0) waitMs = Math.max(waitMs, retryAfter * 1000)
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      if (body?.success !== true || !Array.isArray(body?.data?.notices)) throw new Error('no notices in the answer: ' + JSON.stringify(body).slice(0, 200))
      return { totalPages: body.data.total_pages, total: body.data.total_count, notices: body.data.notices }
    } catch (err) {
      if (attempt === ATTEMPTS - 1) throw err
      console.error(`  page ${pageNo}: ${String(err).slice(0, 120)}, retry in ${waitMs / 1000}s`)
      await sleep(waitMs)
    }
  }
  return null
}

const toSec = (text) => {
  const ms = Date.parse(text)
  if (!Number.isFinite(ms)) throw new Error('not a time: ' + text)
  return Math.floor(ms / 1000)
}

mkdirSync(OUT, { recursive: true })
const rows = []
const seen = new Set()
let total = null
for (let pageNo = 1; ; pageNo++) {
  const result = await page(pageNo)
  total = result.total
  for (const notice of result.notices) {
    if (seen.has(notice.id)) continue
    seen.add(notice.id)
    rows.push({ id: notice.id, title: notice.title, releaseSec: toSec(notice.first_listed_at), listedSec: toSec(notice.listed_at) })
  }
  if (pageNo >= result.totalPages || result.notices.length < PAGE_SIZE) break
  await sleep(PAUSE_MS)
}
const file = join(OUT, 'notices.json')
writeFileSync(file, JSON.stringify(rows))
const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
console.log(`Upbit trading notices: ${rows.length} of ${total} listed, ${day(rows[rows.length - 1].releaseSec)} to ${day(rows[0].releaseSec)} UTC -> ${file}`)
