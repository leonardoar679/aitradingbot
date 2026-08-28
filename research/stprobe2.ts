import { load } from './harness'
import { FEE_RATE, SLIPPAGE_RATE } from '../shared/fees'

const COST = (FEE_RATE + SLIPPAGE_RATE) * 2 * 100

function analyse(sym: string, label: string): void {
  const c = load(sym, '15m')
  const close = c.map((x) => x.close)
  const H = 96 // 24h
  const ret = (i: number) => (close[i + H] - close[i]) / close[i] * 100

  // The control that decides whether any of this is real: what does an ARBITRARY 24h hold return
  // over the same window? A conditional mean only means something as an excess over this.
  const all: number[] = []
  for (let i = 0; i + H < close.length; i++) all.push(ret(i))
  const base = all.reduce((s, v) => s + v, 0) / all.length

  console.log(`\n=== ${label} ===`)
  console.log(`unconditional 24h hold: ${base.toFixed(4)}%   (this is what a coin flip earns here)`)
  console.log('condition                     n      mean     EXCESS over baseline    after cost')

  const H1 = 4
  for (const thresh of [-0.5, -1, -2, -3, 0.5, 1, 2]) {
    const xs: number[] = []
    for (let i = H1; i + H < close.length; i++) {
      const move = (close[i] - close[i - H1]) / close[i - H1] * 100
      if (thresh < 0 ? move <= thresh : move >= thresh) xs.push(ret(i))
    }
    if (xs.length < 100) continue
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length)
    const excess = mean - base
    // t against the BASELINE, not against zero -- "beats a coin flip", not "is positive".
    const t = excess / (sd / Math.sqrt(xs.length))
    console.log(
      `${(thresh < 0 ? `dip <= ${thresh}% in 1h` : `pop >= +${thresh}% in 1h`).padEnd(26)}` +
        String(xs.length).padStart(7) + mean.toFixed(3).padStart(10) + '%' +
        excess.toFixed(4).padStart(14) + '%  (t=' + t.toFixed(1) + ')' +
        (mean - COST).toFixed(3).padStart(11) + '%'
    )
  }
}

for (const [s, l] of [['BTCUSDT', 'BTCUSDT 15m, 2023-08 -> 2026-08'], ['ETHUSDT', 'ETHUSDT 15m'], ['SOLUSDT', 'SOLUSDT 15m']] as [string, string][]) analyse(s, l)

// Does the dip edge survive in a period that is not a bull market? 2022 was the worst crypto year
// available; if the effect is drift wearing a costume, it dies here.
console.log('\n\n=== the same test on 1h candles, split by era (BTCUSDT) ===')
const c1h = load('BTCUSDT', '1h')
const close = c1h.map((x) => x.close)
const H = 24 // 24h in 1h bars
for (const [from, to, name] of [
  ['2017-08-01', '2020-01-01', '2017-2019 (incl. 2018 bear)'],
  ['2020-01-01', '2022-01-01', '2020-2021 (bull)'],
  ['2022-01-01', '2023-08-01', '2022-2023 (bear)'],
  ['2023-08-01', '2026-08-28', '2023-2026 (the tuning era)']
] as [string, string, string][]) {
  const lo = Date.parse(from) / 1000, hi = Date.parse(to) / 1000
  const all: number[] = [], dip: number[] = []
  for (let i = 1; i + H < close.length; i++) {
    if (c1h[i].time < lo || c1h[i].time >= hi) continue
    const r = (close[i + H] - close[i]) / close[i] * 100
    all.push(r)
    if ((close[i] - close[i - 1]) / close[i - 1] * 100 <= -1) dip.push(r)
  }
  if (all.length < 200 || dip.length < 50) { console.log(`${name.padEnd(30)} (not enough data)`); continue }
  const base = all.reduce((s, v) => s + v, 0) / all.length
  const mean = dip.reduce((s, v) => s + v, 0) / dip.length
  const sd = Math.sqrt(dip.reduce((s, v) => s + (v - mean) ** 2, 0) / dip.length)
  console.log(
    `${name.padEnd(30)} baseline ${base.toFixed(3).padStart(7)}%   after -1% dip ${mean.toFixed(3).padStart(7)}%   excess ${(mean - base).toFixed(3).padStart(7)}%  (t=${((mean - base) / (sd / Math.sqrt(dip.length))).toFixed(1)}, n=${dip.length})`
  )
}
