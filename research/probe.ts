import { load } from './harness'
import { FEE_RATE } from '../shared/fees'

const btc = load('BTCUSDT', '15m')
const c = btc.map((x) => x.close)

console.log('=== 1. What does a round trip have to beat? ===')
console.log(`round-trip fee: ${(FEE_RATE * 2 * 100).toFixed(2)}%`)
const rets: number[] = []
for (let i = 1; i < c.length; i++) rets.push((c[i] - c[i - 1]) / c[i - 1])
const absMean = rets.reduce((s, r) => s + Math.abs(r), 0) / rets.length
console.log(`mean |15m return|: ${(absMean * 100).toFixed(4)}%  -> fee = ${(FEE_RATE * 2 / absMean).toFixed(1)}x a typical bar move`)
for (const n of [500, 2000]) {
  console.log(`fee drag if a strategy takes ${n} trades over 3y: ${((1 - Math.pow(1 - FEE_RATE * 2, n)) * 100).toFixed(1)}% of capital`)
}

console.log('\n=== 2. Is there trend persistence? forward return by trend state ===')
function sma(v: number[], p: number): number[] {
  const out = new Array<number>(v.length).fill(NaN)
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    sum += v[i]
    if (i >= p) sum -= v[i - p]
    if (i >= p - 1) out[i] = sum / p
  }
  return out
}
const HORIZON = 96 // 24h ahead
console.log('lookback(bars)   above-MA fwd24h%   below-MA fwd24h%   spread   %time above')
for (const p of [96, 384, 960, 1920, 4800, 9600, 19200]) {
  const ma = sma(c, p)
  let ua = 0, na = 0, ub = 0, nb = 0
  for (let i = p; i + HORIZON < c.length; i++) {
    const fwd = (c[i + HORIZON] - c[i]) / c[i]
    if (c[i] > ma[i]) { ua += fwd; na++ } else { ub += fwd; nb++ }
  }
  const a = (ua / na) * 100, b = (ub / nb) * 100
  console.log(
    `${String(p).padStart(8)} (${(p / 96).toFixed(0).padStart(3)}d)` +
      `${a.toFixed(4).padStart(16)}%${b.toFixed(4).padStart(17)}%` +
      `${(a - b).toFixed(4).padStart(9)}%${((na / (na + nb)) * 100).toFixed(0).padStart(11)}%`
  )
}

console.log('\n=== 3. Is there mean reversion at 15m? autocorrelation of returns ===')
function acf(x: number[], lag: number): number {
  const m = x.reduce((s, v) => s + v, 0) / x.length
  let num = 0, den = 0
  for (let i = 0; i < x.length; i++) { den += (x[i] - m) ** 2; if (i >= lag) num += (x[i] - m) * (x[i - lag] - m) }
  return num / den
}
console.log('lag(bars):  ' + [1, 2, 4, 8, 16, 32, 96].map((l) => `${l}=${acf(rets, l).toFixed(4)}`).join('  '))
