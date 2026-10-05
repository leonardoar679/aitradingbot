import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Candle } from '../shared/ipc'
import { readEventAt } from '../shared/marketEvent'
import {
  ROUND_TRIP_FEE_PCT,
  bracketNet,
  fillMinutes,
  holdNet,
  ruleReadyAt,
  scoreDelistingRule,
  scoreTagRule,
  spotSymbolCandidates
} from '../shared/newsRules'

// shared/newsRules.ts: the trades research/NEWS.md measured after Binance's announcements, which
// the study and the app's record of the rules since both score with.

const bar = (time: number, open: number, high = open, low = open, close = open): Candle => ({ time, open, high, low, close, volume: 1 })
const flat = (from: number, count: number, price: number): Candle[] => Array.from({ length: count }, (_, k) => bar(from + k * 60, price))

describe('the hold', () => {
  it('is short from one open to another, after fees and slippage on both', () => {
    const bars = [bar(0, 10), bar(60, 9.5), bar(120, 9)]
    expect(ROUND_TRIP_FEE_PCT).toBeCloseTo(0.2, 12)
    expect(holdNet(bars, 0, 2, -1, 0.001)).toBeCloseTo(-((9 * 1.001) / (10 * 0.999) - 1) * 100 - 0.2, 12)
    expect(holdNet(bars, 0, 2, 1, 0.0005)).toBeCloseTo(((9 * 0.9995) / (10 * 1.0005) - 1) * 100 - 0.2, 12)
    expect(holdNet(bars, 0, 3, -1, 0.001)).toBeNull()
  })
})

describe('the bracket', () => {
  // A short at 10 with a usual move of 1%: stop at 10.15, target at 9.7, an hour otherwise.
  const entry = 10 * 0.999
  it('takes its target', () => {
    const bars = [bar(0, 10, 10.05, 9.95, 10), bar(60, 10, 10, 9.65, 9.66), ...flat(120, 70, 9.66)]
    expect(bracketNet(bars, 0, -1, 1, 0.001)).toBeCloseTo(-(9.7 / entry - 1) * 100 - 0.2, 12)
  })

  it('takes its stop first in a minute that reaches both, and fills a gap at the open', () => {
    const both = [bar(0, 10, 10.2, 9.6, 10), ...flat(60, 70, 10)]
    expect(bracketNet(both, 0, -1, 1, 0.001)).toBeCloseTo(-((10.15 * 1.001) / entry - 1) * 100 - 0.2, 12)
    const gapped = [bar(0, 10), bar(60, 10.5, 10.6, 10.4, 10.5), ...flat(120, 70, 10.5)]
    expect(bracketNet(gapped, 0, -1, 1, 0.001)).toBeCloseTo(-((10.5 * 1.001) / entry - 1) * 100 - 0.2, 12)
  })

  it('is out at the close of its sixtieth minute otherwise, and needs all sixty', () => {
    const bars = [...flat(0, 59, 10), bar(59 * 60, 10, 10, 10, 9.9)]
    expect(bracketNet(bars, 0, -1, 1, 0.001)).toBeCloseTo(-((9.9 * 1.001) / entry - 1) * 100 - 0.2, 12)
    expect(bracketNet(bars.slice(0, 59), 0, -1, 1, 0.001)).toBeNull()
  })
})

describe('a series of minutes', () => {
  it('carries a minute with no trade at the last close, and counts it', () => {
    const { bars, filled } = fillMinutes([bar(0, 1), bar(180, 2), bar(60, 1.5), bar(60, 9)], 0)
    expect(bars.map((entry) => [entry.time, entry.close, entry.volume])).toEqual([
      [0, 1, 1],
      [60, 1.5, 1],
      [120, 1.5, 0],
      [180, 2, 1]
    ])
    expect(filled).toBe(1)
  })

  it('is cut at a hole of more than half an hour, keeping the part that holds the minute asked about', () => {
    const rows = [bar(0, 1), bar(60, 2), bar(60 + 1860, 3), bar(60 + 1920, 4)]
    expect(fillMinutes(rows, 0).bars.map((entry) => entry.time)).toEqual([0, 60])
    expect(fillMinutes(rows, 1920).bars.map((entry) => entry.time)).toEqual([1920, 1980])
    // Ten minutes with no trade is a quiet coin, not a halt: filled.
    expect(fillMinutes([bar(0, 1), bar(600, 2)], 0)).toMatchObject({ filled: 9, bars: expect.arrayContaining([expect.objectContaining({ time: 540, close: 1, volume: 0 })]) })
  })
})

describe('the rules, on one coin', () => {
  const MINUTE = Date.parse('2026-10-20T08:00:00Z') / 1000

  it("scores a delisting's: short at the second bar after its minute, out at the open four hours after it", () => {
    const bars = flat(MINUTE - 600, 300, 10).map((entry, k) => ({ ...entry, open: 10 - k * 0.01 }))
    expect(scoreDelistingRule(bars, MINUTE + 2)).toEqual({ netPct: holdNet(bars, 12, 250, -1, 0.001) })
    expect(scoreDelistingRule(bars.slice(0, 250), MINUTE)).toEqual({ skipped: 'under four hours of candles after it' })
    expect(scoreDelistingRule(bars, MINUTE + 86_400)).toEqual({ skipped: 'no candle at the announcement minute' })
  })

  it("scores a tag's: the bracket at the second bar, its usual move read at the minute before", () => {
    const bars = flat(MINUTE - 740 * 60, 820, 10).map((entry, k) => {
      const price = 10 * (1 + 0.003 * Math.sin(k / 7))
      return { ...entry, open: price, high: price * 1.001, low: price * 0.999, close: price }
    })
    const reading = readEventAt(bars, 739)
    expect(reading).not.toBeNull()
    expect(scoreTagRule(bars, MINUTE)).toEqual({ netPct: bracketNet(bars, 742, -1, reading!.sigma15Pct, 0.001) })
    expect(scoreTagRule(bars.slice(30), MINUTE)).toEqual({ skipped: 'under twelve hours of candles before it' })
    expect(scoreTagRule(bars.slice(0, 790), MINUTE)).toEqual({ skipped: 'under an hour of candles after it' })
  })

  it('is ready to score once the last minute it reads has closed', () => {
    expect(ruleReadyAt('DELISTING', MINUTE + 30)).toBe(MINUTE + 241 * 60)
    expect(ruleReadyAt('MONITORING_TAG', MINUTE + 30)).toBe(MINUTE + 62 * 60)
  })

  it('tries a prefixed ticker bare as well', () => {
    expect(spotSymbolCandidates('SATS')).toEqual(['SATSUSDT'])
    expect(spotSymbolCandidates('1000SATS')).toEqual(['1000SATSUSDT', 'SATSUSDT'])
  })
})

describe('one module for the study and the app', () => {
  // research/announcementStudy.ts scores every announcement study; research/news.ts (Binance's) and
  // research/upbit.ts (Upbit's) bring their own kinds and costs.
  it('is what the studies score with: none of them keeps a copy of its own', () => {
    for (const file of ['news.ts', 'announcementStudy.ts', 'upbit.ts']) {
      const study = readFileSync(join(__dirname, '..', 'research', file), 'utf-8')
      expect(study, file).toContain("from '../shared/newsRules'")
      for (const copy of [/function bracket\(/, /function hold\(/, /LONGEST_FILLED_SECONDS\s*=/, /STOP_SIGMAS\s*=/, /ROUND_TRIP_FEE_PCT\s*=/, /slippage: 0\.\d/]) {
        expect(study, `${file} ${String(copy)}`).not.toMatch(copy)
      }
    }
  })
})
