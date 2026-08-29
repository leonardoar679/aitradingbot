// DOES THE ADX READOUT CLOSE THE GAP TO SIMPLY HOLDING THE COIN, AND WHAT DOES COMPOUNDING DO?
//
// Two open questions left by research/shipped.ts, which established that buy-and-hold beats all
// three strategies on the mean month over 520 independent months. Both are asked on the six symbols
// that took no part in finding any rule in this repository -- DOGE, TRX, ETC, XLM, VET, EOS -- and
// on the same dumps research/expect.ts scores, so the ADX side of this is not a fresh cut of data.
//
// QUESTION ONE. README.md states the ADX <= 20 rule raises the mean month and cuts summed losses,
// and immediately flags the condition it never tested: "It is a gain only if the capital genuinely
// sits in cash while it waits and costs nothing there." The rule deploys in under a third of months.
// The other months have to be scored as SOMETHING, and scoring them as absent -- which is what
// reporting the mean of deployed months alone does -- compares 130 chosen months against 453
// unchosen ones. Here the idle months are scored as 0.00%: capital in cash, earning nothing, losing
// nothing. That is deliberately the conservative reading. Real cash earns a deposit rate, so the
// gated line below is a floor rather than an estimate.
//
// QUESTION TWO. Every result in this repository is a mean over INDEPENDENT months, each starting at
// $10,000. Nobody deploys that way. A person who leaves the money in gets the product of the monthly
// returns, and on a distribution this skewed the product is far below what the mean implies -- a
// +50% month and a -50% month average to zero and compound to -25%. That gap is not a subtlety here,
// it is most of the answer, so it is computed rather than mentioned.
//
// Chaining independent months is legitimate for THESE strategies specifically: each takes one
// all-in position at a time and pays proportional fees, so a month's percentage return does not
// depend on the balance it started with. It would not be legitimate for a strategy with a fixed
// position size or a minimum order value.
//
//   npx esbuild research/vshold.ts --bundle --platform=node --format=esm --outfile=research/.vshold.mjs
//   node research/.vshold.mjs

import { readFileSync } from 'fs'
import { join } from 'path'
import { ADX_QUIET, readMarketConditions } from '../src/backtest/marketConditions'
import type { Candle } from '../shared/ipc'

const DIR = process.env.CANDLE_DIR || '.candles'
const SYMBOLS = (process.env.SYMBOLS || 'DOGEUSDT,TRXUSDT,ETCUSDT,XLMUSDT,VETUSDT,EOSUSDT').split(',')
const FIRST_YEAR = 2019
const FIRST_MONTH0 = 8
const COUNT = 84

/** Each strategy at the interval it ships on, and the dump holding that interval. Identical to the
 *  table in research/expect.ts, because scoring the ADX rule on a different set of months than the
 *  card's own numbers were measured on is how two true statements end up contradicting each other. */
const AT: Array<[string, string, string, string[]]> = [
  ['trend-regime-ensemble', 'Trend Regime Ensemble', '4h', ['research/.adx4h.json']],
  ['short-term-channel', 'Short-Term Channel', '15m', ['research/.new-early.json', 'research/.new-late.json']],
  ['short-term-channel-regime', 'Channel + Regime', '15m', ['research/.new-early.json', 'research/.new-late.json']]
]

interface MonthResult {
  month: string
  trades: number
  finalBalance: number
  returnPct: number
  bhPct: number
}

const daily = new Map<string, Candle[] | null>()
function loadDaily(s: string): Candle[] | null {
  if (daily.has(s)) return daily.get(s) as Candle[] | null
  let out: Candle[] | null = null
  try {
    const rows = JSON.parse(readFileSync(join(DIR, s + '-1d.json'), 'utf-8')) as number[][]
    out = rows.map((r) => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4], volume: r[5] }))
  } catch {
    out = null
  }
  daily.set(s, out)
  return out
}

function monthStarts(): Array<[string, number]> {
  const out: Array<[string, number]> = []
  for (let i = 0; i < COUNT; i++) {
    const y = FIRST_YEAR + Math.floor((FIRST_MONTH0 + i) / 12)
    const m = (FIRST_MONTH0 + i) % 12
    out.push([`${y}-${String(m + 1).padStart(2, '0')}`, Date.UTC(y, m, 1) / 1000])
  }
  return out
}
const MONTHS = monthStarts()

const avg = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length
const sdev = (v: number[]): number => {
  const m = avg(v)
  return Math.sqrt(avg(v.map((x) => (x - m) ** 2)))
}
/** What $10,000 becomes if every month's return is left in. */
const compound = (v: number[]): number => v.reduce((a, b) => a * (1 + b / 100), 10_000)

interface Line {
  mean: number
  sd: number
  ratio: number
  worst: number
  /** Mean over symbols of the compounded $10,000, so one runaway symbol cannot carry the figure. */
  endMean: number
  endMedian: number
  /** How many of the symbols this line finished ahead of holding on, compounded. */
  beatsHold: number
}

function line(perSymbol: number[][], holdPerSymbol: number[][]): Line {
  const flat = perSymbol.flat()
  const ends = perSymbol.map(compound)
  const holdEnds = holdPerSymbol.map(compound)
  const sorted = [...ends].sort((a, b) => a - b)
  const h = sorted.length >> 1
  return {
    mean: avg(flat),
    sd: sdev(flat),
    ratio: avg(flat) / sdev(flat),
    worst: Math.min(...flat),
    endMean: avg(ends),
    endMedian: sorted.length % 2 ? sorted[h] : (sorted[h - 1] + sorted[h]) / 2,
    beatsHold: ends.filter((e, i) => e > holdEnds[i]).length
  }
}

const pc = (v: number, d = 2): string => (v >= 0 ? '+' : '') + v.toFixed(d) + '%'
const dl = (v: number): string => '$' + Math.round(v).toLocaleString('en-US')

console.log('THE ADX READOUT AGAINST SIMPLY HOLDING, ON SIX SYMBOLS THAT CHOSE NOTHING')
console.log(SYMBOLS.map((s) => s.replace('USDT', '')).join(' ') + ', months from ' +
  FIRST_YEAR + '-' + String(FIRST_MONTH0 + 1).padStart(2, '0') + ', ADX(14) <= ' + ADX_QUIET)
console.log('idle months are scored as 0.00% -- cash earning nothing, which understates the gated line\n')

for (const [sid, name, iv, files] of AT) {
  const dumps = files
    .map((f) => {
      try {
        return JSON.parse(readFileSync(f, 'utf-8')) as Record<string, MonthResult[]>
      } catch {
        return null
      }
    })
    .filter((x): x is Record<string, MonthResult[]> => x !== null)
  if (!dumps.length) {
    console.log(name + ': no dump for ' + iv)
    continue
  }

  const holdSeq: number[][] = []
  const allSeq: number[][] = []
  const gateSeq: number[][] = []
  let deployed = 0
  let scored = 0

  for (const sym of SYMBOLS) {
    const bars = loadDaily(sym)
    if (!bars) continue
    const rows = new Map<string, MonthResult>()
    for (const d of dumps) for (const r of d[sym + '|' + sid + '|' + iv] ?? []) rows.set(r.month, r)

    const hs: number[] = []
    const as: number[] = []
    const gs: number[] = []
    for (const [label, startSec] of MONTHS) {
      const r = rows.get(label)
      if (!r) continue
      // Strictly before the 1st: the last daily bar that had closed when the decision was made.
      let end = -1
      for (let i = 0; i < bars.length; i++) {
        if (bars[i].time < startSec) end = i
        else break
      }
      if (end < 0) continue
      const adx = readMarketConditions(bars.slice(0, end + 1), sid).adx
      // A month with no ADX reading belongs to none of the three sequences. Dropping it from the
      // gated line alone would compare that line against months it was never offered.
      if (!Number.isFinite(adx)) continue
      scored++
      hs.push(r.bhPct)
      as.push(r.returnPct)
      if (adx <= ADX_QUIET) {
        gs.push(r.returnPct)
        deployed++
      } else {
        gs.push(0)
      }
    }
    if (!hs.length) continue
    holdSeq.push(hs)
    allSeq.push(as)
    gateSeq.push(gs)
  }

  const H = line(holdSeq, holdSeq)
  const A = line(allSeq, holdSeq)
  const G = line(gateSeq, holdSeq)

  console.log(name + '  (' + iv + ', ' + scored + ' symbol-months, deployed in ' + deployed +
    ' of them = ' + ((deployed / scored) * 100).toFixed(0) + '%)')
  console.log(
    '  line'.padEnd(26) + 'mean'.padStart(9) + 'sd'.padStart(8) + 'mean/sd'.padStart(9) +
    'worst'.padStart(9) + '$10k becomes'.padStart(14) + 'median sym'.padStart(12) + 'beats hold'.padStart(12)
  )
  const LINES: Array<[string, Line, number[][]]> = [
    ['simply holding', H, holdSeq],
    ['strategy, every month', A, allSeq],
    ['strategy, ADX <= ' + ADX_QUIET + ' only', G, gateSeq]
  ]
  for (const [label, L] of LINES) {
    console.log(
      ('  ' + label).padEnd(26) + pc(L.mean).padStart(9) + L.sd.toFixed(1).padStart(8) +
      L.ratio.toFixed(3).padStart(9) + pc(L.worst, 1).padStart(9) + dl(L.endMean).padStart(14) +
      dl(L.endMedian).padStart(12) +
      (L === H ? '--' : L.beatsHold + ' of ' + holdSeq.length).padStart(12)
    )
  }

  // A mean over six compounded results can be one runaway symbol. Printing the columns is the only
  // way to see whether it is, and on a spread this wide the mean is not the number to quote.
  const kept = SYMBOLS.filter((s) => loadDaily(s))
  console.log(
    '  $10,000 by symbol'.padEnd(26) + kept.map((s) => s.replace('USDT', '').padStart(11)).join('')
  )
  for (const [label, , seq] of LINES) {
    console.log(
      ('    ' + label).padEnd(26) + seq.map((v) => dl(compound(v)).padStart(11)).join('')
    )
  }

  // Stated by the code, because this is the sentence a reader will quote and it must not drift.
  const verdict =
    G.endMean > H.endMean && A.endMean > H.endMean
      ? 'both beat holding compounded'
      : G.endMean > H.endMean
        ? 'the gated line beats holding compounded; running every month does not'
        : A.endMean > H.endMean
          ? 'running every month beats holding compounded; the gated line does not'
          : 'neither beats holding compounded'
  console.log('  => ' + verdict + ', and gating ' +
    (G.endMean > A.endMean ? 'improves on' : 'costs against') + ' running every month (' +
    dl(G.endMean) + ' vs ' + dl(A.endMean) + ')\n')
}

console.log('The mean-vs-compounded gap is the point of the last two columns. A mean month is what an')
console.log('independent $10,000 earns on average; the compounded figure is what one account that was')
console.log('never topped up actually ends with, and volatility takes the difference. Any line whose')
console.log('mean is positive and whose compounded result is not is a line that looks profitable only')
console.log('because the losing months are being measured against a balance they never had.')
