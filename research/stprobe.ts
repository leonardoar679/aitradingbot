import { load } from './harness'
import { FEE_RATE } from '../shared/fees'
import { SLIPPAGE_RATE } from '../shared/fees'

const c15 = load('BTCUSDT', '15m')
const COST = (FEE_RATE + SLIPPAGE_RATE) * 2 * 100
console.log(`break-even per round trip: ${COST.toFixed(3)}%  (fee ${(FEE_RATE*200).toFixed(2)}% + slippage ${(SLIPPAGE_RATE*200).toFixed(2)}%)\n`)

const close = c15.map((x) => x.close)
const ret = (i: number, h: number): number => (close[i + h] - close[i]) / close[i] * 100

function summarise(label: string, xs: number[]): string {
  if (xs.length < 30) return `${label.padEnd(34)} (only ${xs.length} samples)`
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length)
  const t = mean / (sd / Math.sqrt(xs.length))
  const edge = mean - COST
  return `${label.padEnd(34)} n=${String(xs.length).padStart(6)}  mean=${mean.toFixed(4)}%  t=${t.toFixed(1).padStart(6)}  after cost=${edge.toFixed(4)}%${edge > 0 ? '  <-- CLEARS' : ''}`
}

// 1. Time of day. Crypto has real session structure; if any hour carries drift it is free to use.
console.log('=== 1. forward 4h return by UTC hour of entry ===')
for (const H of [16]) { // 16 bars of 15m = 4h
  for (let hour = 0; hour < 24; hour += 3) {
    const xs: number[] = []
    for (let i = 0; i + H < close.length; i++) {
      if (new Date(c15[i].time * 1000).getUTCHours() === hour) xs.push(ret(i, H))
    }
    console.log(summarise(`  hour ${String(hour).padStart(2)}:00 -> +4h`, xs))
  }
}

// 2. Continuation vs reversal after a large move -- the core short-term question.
console.log('\n=== 2. forward return after a large 1h move (continuation or reversal?) ===')
const H1 = 4 // 1h in 15m bars
for (const thresh of [0.5, 1.0, 2.0]) {
  for (const H of [4, 16, 96]) {
    const up: number[] = []
    const down: number[] = []
    for (let i = H1; i + H < close.length; i++) {
      const move = (close[i] - close[i - H1]) / close[i - H1] * 100
      if (move >= thresh) up.push(ret(i, H))
      else if (move <= -thresh) down.push(ret(i, H))
    }
    console.log(summarise(`  after +${thresh}% in 1h -> +${H / 4}h`, up))
    console.log(summarise(`  after -${thresh}% in 1h -> +${H / 4}h`, down))
  }
}

// 3. Volume. Completely unused by every strategy in this app so far.
console.log('\n=== 3. forward 4h return after a volume spike ===')
const vol = c15.map((x) => x.volume)
for (const mult of [2, 3, 5]) {
  const xs: number[] = []
  for (let i = 96; i + 16 < close.length; i++) {
    let sum = 0
    for (let j = i - 96; j < i; j++) sum += vol[j]
    const avg = sum / 96
    if (avg > 0 && vol[i] >= avg * mult) xs.push(ret(i, 16))
  }
  console.log(summarise(`  volume >= ${mult}x its 24h average`, xs))
}

// 4. Volatility regime: is the drift different when the market is calm vs wild?
console.log('\n=== 4. forward 4h return by recent volatility ===')
const absr: number[] = []
for (let i = 1; i < close.length; i++) absr.push(Math.abs((close[i] - close[i - 1]) / close[i - 1]))
for (const [lo, hi, name] of [[0, 0.25, 'calmest quartile'], [0.25, 0.5, '2nd'], [0.5, 0.75, '3rd'], [0.75, 1, 'wildest quartile']] as [number, number, string][]) {
  const window = 96
  const vols: { i: number; v: number }[] = []
  for (let i = window; i + 16 < close.length; i++) {
    let s = 0
    for (let j = i - window; j < i; j++) s += absr[j]
    vols.push({ i, v: s / window })
  }
  const sorted = [...vols].sort((a, b) => a.v - b.v)
  const slice = sorted.slice(Math.floor(sorted.length * lo), Math.floor(sorted.length * hi))
  console.log(summarise(`  ${name}`, slice.map((s) => ret(s.i, 16))))
}
