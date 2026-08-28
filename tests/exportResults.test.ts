import { describe, expect, it } from 'vitest'
import {
  buildRunExport,
  csvField,
  exportFileName,
  runExportToCsv,
  runExportToJson,
  serializeRunExport
} from '../src/backtest/exportResults'
import { runBacktest } from '../src/backtest/engine'
import { shortTermChannel } from '../src/backtest/strategies/shortTermChannel'
import type { ResultsGeneralInfo } from '../src/backtest/BacktestResultsView'
import type { Candle } from '../shared/ipc'

// An export is a file someone keeps and later compares against another one, so the properties
// that matter are the ones that would corrupt it silently: a CSV a spreadsheet misreads, a
// timestamp in the wrong unit, a filename the OS rejects, or a run whose settings were not
// recorded and so cannot be told apart from a different run.

const M15 = 900

function path(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: 1_700_000_000 + i * M15,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 1
  }))
}

/** A sawtooth big enough to clear the 0.24% round trip, so the export has real trades in it. */
function tradedResult() {
  const closes: number[] = []
  let p = 100
  for (let c = 0; c < 4; c++) {
    for (let i = 0; i < 1200; i++) closes.push((p *= 1.003))
    for (let i = 0; i < 1200; i++) closes.push((p /= 1.003))
  }
  return runBacktest(path(closes), shortTermChannel.id, { startingBalance: 10_000 })
}

const INFO: ResultsGeneralInfo = {
  periodDays: 90,
  startDate: '2026-05-30',
  endDate: '2026-08-28',
  exchangeName: 'Binance',
  symbolLabel: 'BTC-USDT',
  intervalLabel: '15m',
  strategyLabel: 'Short-Term Channel Breakout',
  splitDate: null,
  leverage: 1
}

describe('csvField', () => {
  it('quotes and doubles embedded quotes', () => {
    expect(csvField('a"b')).toBe('"a""b"')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('a\nb')).toBe('"a\nb"')
  })

  it('leaves ordinary values alone', () => {
    expect(csvField('long')).toBe('long')
    expect(csvField('stop_loss')).toBe('stop_loss')
  })

  it('neutralises a value a spreadsheet would run as a formula', () => {
    // The real risk in any CSV export: a leading =, +, - or @ makes Excel treat the cell as a
    // formula, so a string arriving from an exchange can execute when the file is opened.
    expect(csvField('=1+1')).toBe("'=1+1")
    expect(csvField('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvField('+cmd')).toBe("'+cmd")
  })

  it('does not disguise a negative NUMBER as text', () => {
    // The guard above keys on strings only. If it caught numbers too, every losing trade would
    // arrive in the spreadsheet as text and no column of P&L would sum.
    expect(csvField(-125.5)).toBe('-125.5')
    expect(csvField(0)).toBe('0')
  })

  it('emits an empty cell for a non-finite number rather than the word NaN', () => {
    expect(csvField(NaN)).toBe('')
    expect(csvField(Infinity)).toBe('')
  })
})

describe('buildRunExport', () => {
  it('records the run settings, so two exports can be told apart', () => {
    const x = buildRunExport(tradedResult(), INFO, 5.25, 3)
    expect(x.run.symbol).toBe('BTC-USDT')
    expect(x.run.interval).toBe('15m')
    expect(x.run.strategy).toBe('Short-Term Channel Breakout')
    expect(x.run.startDate).toBe('2026-05-30')
    expect(x.run.leverage).toBe(3)
    expect(x.run.startingBalance).toBe(10_000)
    expect(x.run.elapsedSec).toBe(5.25)
  })

  it('carries the warmup, which the date range alone hides', () => {
    const r = tradedResult()
    expect(buildRunExport(r, INFO, 1, 1).run.warmupBars).toBe(r.stats.warmupBars)
  })

  it('converts times to ISO while keeping the raw unix seconds', () => {
    const r = tradedResult()
    const x = buildRunExport(r, INFO, 1, 1)
    expect(x.trades.length).toBeGreaterThan(0)
    const t = x.trades[0]
    expect(t.entryTimestamp).toBe(r.trades[0].entryTime)
    expect(t.entryTime).toBe(new Date(r.trades[0].entryTime * 1000).toISOString())
    // The unit trap: these timestamps are SECONDS, and reading them as milliseconds puts every
    // export in January 1970. Anchor on a real year rather than just "is a string".
    expect(t.entryTime.startsWith('20')).toBe(true)
  })

  it('exports every trade and every equity point, not a truncated view', () => {
    const r = tradedResult()
    const x = buildRunExport(r, INFO, 1, 1)
    expect(x.trades).toHaveLength(r.trades.length)
    expect(x.equityCurve).toHaveLength(r.equityCurve.length)
    expect(x.benchmarkCurve).toHaveLength(r.benchmarkCurve.length)
    expect(x.monthlyBreakdown).toHaveLength(r.monthlyBreakdown.length)
  })

  it('computes holding time from the trade, in hours', () => {
    const r = tradedResult()
    const x = buildRunExport(r, INFO, 1, 1)
    const t = r.trades[0]
    expect(x.trades[0].holdingHours).toBeCloseTo((t.exitTime - t.entryTime) / 3600, 9)
  })
})

describe('runExportToCsv', () => {
  it('writes one header row plus one row per trade', () => {
    const x = buildRunExport(tradedResult(), INFO, 1, 1)
    const lines = runExportToCsv(x).trim().split('\r\n')
    expect(lines).toHaveLength(x.trades.length + 1)
    expect(lines[0]).toBe('#,side,entry_time_utc,exit_time_utc,holding_hours,entry_price,exit_price,qty,pnl,return_pct,exit_reason')
  })

  it('gives every row the same column count as the header', () => {
    // A ragged CSV is the failure that survives a glance and breaks every consumer.
    const x = buildRunExport(tradedResult(), INFO, 1, 1)
    const lines = runExportToCsv(x).trim().split('\r\n')
    const width = lines[0].split(',').length
    for (const line of lines) expect(line.split(',')).toHaveLength(width)
  })

  it('uses CRLF line endings', () => {
    const csv = runExportToCsv(buildRunExport(tradedResult(), INFO, 1, 1))
    expect(csv.includes('\r\n')).toBe(true)
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  it('trims floating-point noise from prices without touching the JSON copy', () => {
    // Slippage is applied as a multiplication, so an entry price prints as 64012.78999799999 --
    // correct, and indistinguishable from a bug to anyone opening the spreadsheet. The rounding
    // is display-only: the JSON stays exact so the file remains a faithful record.
    const x = buildRunExport(tradedResult(), INFO, 1, 1)
    const priceCol = runExportToCsv(x)
      .trim()
      .split('\r\n')
      .slice(1)
      .map((l) => l.split(',')[5])
    expect(priceCol.length).toBeGreaterThan(0)
    for (const cell of priceCol) {
      const decimals = cell.split('.')[1] ?? ''
      expect(decimals.length).toBeLessThanOrEqual(8)
    }
    const back = JSON.parse(runExportToJson(x))
    expect(back.trades[0].entryPrice).toBe(x.trades[0].entryPrice)
  })

  it('produces a header-only file for a run that took no trades', () => {
    const flat = path(Array.from({ length: 1500 }, () => 100))
    const r = runBacktest(flat, shortTermChannel.id, { startingBalance: 10_000 })
    expect(r.trades).toHaveLength(0)
    const csv = runExportToCsv(buildRunExport(r, INFO, 1, 1))
    expect(csv.trim().split('\r\n')).toHaveLength(1)
  })
})

describe('runExportToJson', () => {
  it('round-trips through JSON.parse with the numbers intact', () => {
    const x = buildRunExport(tradedResult(), INFO, 1, 1)
    const back = JSON.parse(runExportToJson(x))
    expect(back.run.symbol).toBe('BTC-USDT')
    expect(back.trades).toHaveLength(x.trades.length)
    expect(back.stats.totalNetProfitPct).toBeCloseTo(x.stats.totalNetProfitPct, 10)
  })

  it('carries a schema version, so an old file stays identifiable', () => {
    expect(buildRunExport(tradedResult(), INFO, 1, 1).app.schema).toBe(1)
  })
})

describe('serializeRunExport', () => {
  it('picks the format asked for', () => {
    const x = buildRunExport(tradedResult(), INFO, 1, 1)
    expect(serializeRunExport(x, 'json')).toBe(runExportToJson(x))
    expect(serializeRunExport(x, 'csv')).toBe(runExportToCsv(x))
  })
})

describe('exportFileName', () => {
  it('names the file after the run', () => {
    const x = buildRunExport(tradedResult(), INFO, 1, 1)
    expect(exportFileName(x, 'csv')).toBe(
      'backtest_BTC-USDT_15m_Short-Term-Channel-Breakout_2026-05-30_to_2026-08-28.csv'
    )
    expect(exportFileName(x, 'json').endsWith('.json')).toBe(true)
  })

  it('strips characters a filesystem would reject', () => {
    const x = buildRunExport(tradedResult(), { ...INFO, symbolLabel: 'BTC/USDT:swap*' }, 1, 1)
    const name = exportFileName(x, 'json')
    for (const bad of ['/', '\\', ':', '*', '?', '"', '<', '>', '|']) {
      expect(name.includes(bad)).toBe(false)
    }
  })

  it('still produces a usable name when a label is entirely unusable', () => {
    const x = buildRunExport(tradedResult(), { ...INFO, strategyLabel: '///' }, 1, 1)
    expect(exportFileName(x, 'json')).toContain('_run_')
  })
})
