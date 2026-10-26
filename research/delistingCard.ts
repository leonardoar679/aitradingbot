import { readFileSync, writeFileSync } from 'fs'
import { DELISTING_CARD_LINES, delistingFiguresOf, quantileOf, type DelistingStudyCoin } from '../shared/forecast/primaryCall'

// THE DELISTING CARD'S COINS (V8 Stage 3; V8-S3-DELIST-CARD, registered before this ran). research/NEWS.md measured the
// four-hour short after a Binance spot delisting on a held-out half and printed its means; the card shows the study coin
// by coin -- its median, its 10th and 90th percentiles, its worst, and when the coins reached the median -- which were
// never computed. So the study is run again, unchanged, with ROWS_OUT writing each coin's row
// (research/announcementStudy.ts), and this reads those rows: it checks that they reproduce what the study printed, to
// the digits printed, and only then writes shared/delistingStudy.ts, the coins the app's card rests on.
//
//   npx esbuild research/news.ts --bundle --platform=node --format=esm --outfile=research/.news.mjs
//   MODE=study SET=heldout NEWS_DIR=<the study's .candles/news> ROWS_OUT=research/.delisting-rows.json node research/.news.mjs
//   npx esbuild research/delistingCard.ts --bundle --platform=node --format=esm --outfile=research/.delistingCard.mjs
//   ROWS=research/.delisting-rows.json node research/.delistingCard.mjs

interface Row {
  category: string
  articleId: number
  title: string
  ticker: string
  symbol: string
  releaseSec: number
  holdGross: number | null
  holdNet: number | null
  holdPath: number[] | null
}

const ROWS = process.env.ROWS ?? 'research/.delisting-rows.json'
const OUT = process.env.OUT ?? 'shared/delistingStudy.ts'

const read = JSON.parse(readFileSync(ROWS, 'utf-8')) as { set: string; rows: Row[] }
if (read.set !== 'heldout') throw new Error(`the rows are of the ${read.set} half; the card rests on the held-out half`)
const held = read.rows.filter((row) => row.category === 'DELISTING' && row.holdNet !== null && row.holdGross !== null && row.holdPath !== null)
const round = (value: number): number => Math.round(value * 10_000) / 10_000
const coins: DelistingStudyCoin[] = held
  .map((row) => ({ ticker: row.ticker, hour: Math.floor(row.releaseSec / 3600), grossPct: round(row.holdGross as number), netPct: round(row.holdNet as number) }))
  .sort((a, b) => a.hour - b.hour || a.ticker.localeCompare(b.ticker))
const figures = delistingFiguresOf(coins)

// What the study printed for the hold after its costs, to the digits research/news.ts printed them: the mean of hourly
// means to three decimals, the coins ahead of the coins, the hours, and the worst to two decimals.
const published = DELISTING_CARD_LINES.published
const reproduced =
  figures.hourlyMeanNetPct.toFixed(3) === published.hourlyMeanPct.toFixed(3) &&
  figures.ahead === published.ahead &&
  figures.coins === published.coins &&
  figures.hours === published.hours &&
  figures.worstNetPct.toFixed(2) === published.worstPct.toFixed(2)
console.log(`coins ${figures.coins}, hours ${figures.hours}, hourly mean net ${figures.hourlyMeanNetPct.toFixed(3)}, ahead ${figures.ahead}, worst ${figures.worstNetPct.toFixed(2)}`)
if (!reproduced) throw new Error(`the rows do not reproduce the study's printed figures (${JSON.stringify(published)}): nothing is written`)

// When the coins first reached the card's target -- the median hold before costs -- within the hold: the end of the
// minute whose low first reached it, counted from the announcement's minute (the entry is the open of its second).
const target = figures.medianGrossPct
const minutes: number[] = []
for (const row of held) {
  const k = (row.holdPath as number[]).findIndex((best) => best >= target)
  if (k >= 0) minutes.push(DELISTING_CARD_LINES.entryBars + k + 1)
}
minutes.sort((a, b) => a - b)
const touch = { targetPct: round(target), touched: minutes.length, of: held.length, p25Min: round(quantileOf(minutes, 0.25)), p75Min: round(quantileOf(minutes, 0.75)) }
console.log(`median before costs ${target.toFixed(3)}, p10 ${figures.p10GrossPct.toFixed(3)}, p90 ${figures.p90GrossPct.toFixed(3)}; touched ${touch.touched} of ${touch.of}, minutes p25 ${touch.p25Min} p75 ${touch.p75Min}`)

const body = coins.map((coin) => `    { ticker: ${JSON.stringify(coin.ticker)}, hour: ${coin.hour}, grossPct: ${coin.grossPct}, netPct: ${coin.netPct} }`).join(',\n')
writeFileSync(
  OUT,
  `import type { DelistingStudy } from './forecast/primaryCall'

// THE DELISTING STUDY'S COINS (V8 Stage 3; V8-S3-DELIST-CARD). Each coin of research/NEWS.md's held-out half (Binance
// spot delistings announced January 2025 to September 2026): the hour of its announcement, its four-hour short before
// costs -- entry at the open of the second minute after the announcement's, exit at the open 240 minutes after it --
// and after the study's costs (0.1% fee and 0.1% slippage a side); and when the coins first reached the median before
// costs, in minutes from the announcement's minute to the end of the minute that reached it. Written by
// research/delistingCard.ts from the study run again unchanged; it reproduced what the study printed (${figures.coins} coins in
// ${figures.hours} hours, ${figures.ahead} ahead, a mean of hourly means of ${figures.hourlyMeanNetPct.toFixed(2)}%, the worst ${figures.worstNetPct.toFixed(1)}%). Not edited by hand.

export const DELISTING_STUDY: DelistingStudy = {
  coins: [
${body}
  ],
  touch: { targetPct: ${touch.targetPct}, touched: ${touch.touched}, of: ${touch.of}, p25Min: ${touch.p25Min}, p75Min: ${touch.p75Min} }
}
`
)
console.log(`wrote ${OUT}`)
