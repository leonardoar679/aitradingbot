// Downloads Binance's own announcement lists (free, no key): new listings (catalog 48), delistings
// (catalog 161) and Binance's news (catalog 49), every page, as the public announcement pages read
// them. research/NEWS.md says what for.
//
//   node research/fetch-announcements.mjs
//   CATALOGS=49 node research/fetch-announcements.mjs     only the lists named
//
// Writes .candles/news/announcements-{48,161,49}.json: [{ id, code, title, releaseSec }], newest
// first, as Binance lists them. Only the list is read -- the title and the minute it was released
// -- never an article's body. A re-run replaces the files it reads. The news list was added for the
// Monitoring Tag, after the other two had been read and scored, and was read on its own.

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const OUT = process.env.OUT || '.candles/news'
const PAGE_SIZE = 50
const ALL_CATALOGS = { 48: 'New Cryptocurrency Listing', 161: 'Delisting', 49: 'Latest Binance News' }
const ONLY = process.env.CATALOGS ? process.env.CATALOGS.split(',').map((id) => id.trim()) : null
const CATALOGS = Object.fromEntries(Object.entries(ALL_CATALOGS).filter(([id]) => ONLY === null || ONLY.includes(id)))

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function page(catalogId, pageNo) {
  const url = `https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&catalogId=${catalogId}&pageNo=${pageNo}&pageSize=${PAGE_SIZE}`
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const body = await res.json()
      const catalog = body?.data?.catalogs?.[0]
      if (!catalog) throw new Error('no catalog in the answer: ' + JSON.stringify(body).slice(0, 200))
      return { total: catalog.total, articles: catalog.articles ?? [] }
    } catch (err) {
      if (attempt === 5) throw err
      console.error(`  catalog ${catalogId} page ${pageNo}: ${String(err).slice(0, 120)}, retry in ${2 ** attempt * 2}s`)
      await sleep(2 ** attempt * 2000)
    }
  }
  return null
}

mkdirSync(OUT, { recursive: true })
for (const [catalogId, name] of Object.entries(CATALOGS)) {
  const rows = []
  const seen = new Set()
  let total = null
  for (let pageNo = 1; ; pageNo++) {
    const result = await page(catalogId, pageNo)
    total = result.total
    for (const article of result.articles) {
      if (seen.has(article.id)) continue
      seen.add(article.id)
      rows.push({ id: article.id, code: article.code, title: article.title, releaseSec: Math.floor(Number(article.releaseDate) / 1000) })
    }
    if (result.articles.length < PAGE_SIZE || rows.length >= total) break
    await sleep(400)
  }
  const file = join(OUT, `announcements-${catalogId}.json`)
  writeFileSync(file, JSON.stringify(rows))
  const day = (sec) => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
  console.log(
    `${name} (catalog ${catalogId}): ${rows.length} of ${total} listed, ${day(rows[rows.length - 1].releaseSec)} to ${day(rows[0].releaseSec)} UTC -> ${file}`
  )
}
