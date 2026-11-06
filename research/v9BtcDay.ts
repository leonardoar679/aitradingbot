import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BTC_DAY_TARGETS, hitOf, thirdOf, trailingVolOf, wilsonInterval, type BtcDayTarget, type DayBar } from '../shared/forecast/btcDay'
import { bootstrapOverHours, UNCERTAINTY_LINES } from '../shared/forecast/uncertainty'

// V9-BTC-DAY (V9 Stage 1, 6 November 2026; research/preregistered.jsonl): the chance of a big Bitcoin day -- a close
// 2% or 4% from the open either way, or a fall to 4% below it -- as the frequency on past days in the same third of
// trailing volatility (shared/forecast/btcDay.ts). The thirds and the chances are read from 2018 to 2023 alone; the
// days from 2024 on judge them: each third's held-out frequency with its 95% Wilson interval against the chance stated
// for it, and the Brier skill over the training days' unconditional frequency with its 95% interval by month blocks.
//
//   npx esbuild research/v9BtcDay.ts --bundle --platform=node --format=esm --outfile=research/.v9BtcDay.mjs
//   [CANDLES=<folder of BTCUSDT-1d.json>] [OUT=<figures.json>] node research/.v9BtcDay.mjs

const CANDLES = process.env.CANDLES ?? 'E:/Code/newtradingbot/.candles'
const OUT = process.env.OUT ?? ''
const TRAIN_FROM = Date.UTC(2018, 0, 1) / 1000
const HELD_FROM = Date.UTC(2024, 0, 1) / 1000
const DRAWS = 10_000

const file = join(CANDLES, 'BTCUSDT-1d.json')
const rows = JSON.parse(readFileSync(file, 'utf-8')) as number[][]
// The last full day on file: a day that had ended when the file was written.
const writtenSec = Math.floor(statSync(file).mtimeMs / 1000)
const bars: DayBar[] = rows.map(([day, open, high, low, close]) => ({ day, open, high, low, close })).filter((bar) => bar.day + 86_400 <= writtenSec)

interface Day {
  bar: DayBar
  index: number
  vol: number
}
const days: Day[] = []
for (let index = 0; index < bars.length; index++) {
  const vol = trailingVolOf(bars, index)
  if (vol !== null) days.push({ bar: bars[index], index, vol })
}
const training = days.filter((day) => day.bar.day >= TRAIN_FROM && day.bar.day < HELD_FROM)
const held = days.filter((day) => day.bar.day >= HELD_FROM)

// The thirds, cut by the training days' volatility alone.
const sorted = training.map((day) => day.vol).sort((a, b) => a - b)
const quantile = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
const cuts: [number, number] = [quantile(1 / 3), quantile(2 / 3)]

const share = (list: readonly Day[], target: BtcDayTarget): number => (list.length === 0 ? Number.NaN : list.filter((day) => hitOf(day.bar, target)).length / list.length)

const result: Record<string, unknown> = {
  file,
  days: { first: new Date(bars[0].day * 1000).toISOString().slice(0, 10), last: new Date(bars[bars.length - 1].day * 1000).toISOString().slice(0, 10) },
  training: training.length,
  held: held.length,
  cuts
}
const targets: Record<string, unknown> = {}
for (const target of BTC_DAY_TARGETS) {
  const chances = [0, 1, 2].map((third) => share(training.filter((day) => thirdOf(day.vol, cuts) === third), target)) as [number, number, number]
  const unconditional = share(training, target)
  const sinceTraining = share(days.filter((day) => day.bar.day >= TRAIN_FROM), target)
  const thirds = [0, 1, 2].map((third) => {
    const list = held.filter((day) => thirdOf(day.vol, cuts) === third)
    const hits = list.filter((day) => hitOf(day.bar, target)).length
    const interval = wilsonInterval(hits, list.length, 0.95)
    return { third, stated: chances[third], n: list.length, hits, share: list.length === 0 ? null : hits / list.length, low: interval.low, high: interval.high, inside: chances[third] >= interval.low && chances[third] <= interval.high }
  })
  const samples = held.map((day) => {
    const p = chances[thirdOf(day.vol, cuts)]
    const y = hitOf(day.bar, target) ? 1 : 0
    return { hour: day.index, sample: [(p - y) ** 2, (unconditional - y) ** 2] }
  })
  const made = bootstrapOverHours(samples, [(sums: Float64Array): number => (sums[1] > 0 ? 1 - sums[0] / sums[1] : Number.NaN)], 30, { ...UNCERTAINTY_LINES, draws: DRAWS, level: 0.95 })
  const skill = made === null ? null : made.figures[0]
  const passes = thirds.every((third) => third.inside) && skill !== null && skill.low > 0
  targets[target] = { chances, unconditional, sinceTraining, thirds, brierSkill: skill, verdict: passes ? 'held' : 'failed' }
}
result.targets = targets

console.log(`V9-BTC-DAY on ${result.training as number} training days (2018-2023) and ${result.held as number} held-out days (2024 to ${(result.days as { last: string }).last})`)
console.log(`  thirds of trailing volatility cut at ${(cuts[0] * 100).toFixed(2)}% and ${(cuts[1] * 100).toFixed(2)}% a day`)
for (const target of BTC_DAY_TARGETS) {
  const t = targets[target] as { chances: number[]; unconditional: number; thirds: { third: number; stated: number; n: number; share: number | null; low: number; high: number; inside: boolean }[]; brierSkill: { value: number; low: number; high: number } | null; verdict: string }
  console.log(`  ${target}: unconditional ${(t.unconditional * 100).toFixed(1)}%; Brier skill ${t.brierSkill === null ? '-' : `${(t.brierSkill.value * 100).toFixed(2)}% [${(t.brierSkill.low * 100).toFixed(2)}, ${(t.brierSkill.high * 100).toFixed(2)}]`}; ${t.verdict.toUpperCase()}`)
  for (const third of t.thirds) console.log(`     third ${third.third}: stated ${(third.stated * 100).toFixed(1)}%, held out ${third.share === null ? '-' : (third.share * 100).toFixed(1)}% of ${third.n} [${(third.low * 100).toFixed(1)}, ${(third.high * 100).toFixed(1)}]${third.inside ? '' : '  OUTSIDE'}`)
}
if (OUT !== '') writeFileSync(OUT, JSON.stringify(result, null, 1))
