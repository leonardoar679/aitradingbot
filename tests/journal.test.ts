import { describe, expect, it } from 'vitest'
import type { AiCallRecord } from '../shared/aiLedger'
import { AI_OPPORTUNITY_PROMPT_VERSION, AI_OPPORTUNITY_SCHEMA_VERSION } from '../shared/aiOpportunity'
import type { AiSignalDetail } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import { answerSources, filterJournal, journalCsv, journalRows, journalTotals } from '../src/agents/journal'
import { assembleFeed, describeFeedItemStatus, feedItemStatus, rightNowRows } from '../src/agents/opportunities'

// The journal, the status on each card and the "Right now" list: three readings of the same feed
// of events and answers, each worked out from the ledger and candles and stored nowhere.

const A = 'openai/gpt-5-mini'
const B = 'mistralai/mistral-small-2603'
const T = Date.parse('2026-10-05T09:07:00Z') / 1000
const LATER = T + 100_000

function event(symbol = 'SOLUSDT', time = T, overrides: Partial<MarketEvent> = {}): MarketEvent {
  return {
    id: `binance:${symbol}:${time}`,
    exchange: 'binance',
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    time,
    type: 'breakout',
    direction: 'up',
    band: 'urgent',
    score: 91,
    components: { price: 90, volume: 95, volatility: 85, pressure: 90, breakout: 95 },
    price: 100,
    returnsPct: { m1: 0.4, m5: 1.5, m15: 3, h1: 3.2, h4: 2.5 },
    moveSigmas: 6,
    volumeRatio: 4.7,
    rangeRatio: 3,
    live: { detectedAt: time + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 },
    ...overrides
  }
}

const LONG: AiSignalDetail = {
  marketRegime: 'bull',
  riskLevel: 'medium',
  horizonBars: 4,
  stopLoss: 98.5,
  takeProfit: 103,
  reasonCodes: ['breakout'],
  levelsNote: null,
  entry: { min: 99.8, max: 100.2, validMinutes: 15 }
}
const NONE: AiSignalDetail = { ...LONG, stopLoss: null, takeProfit: null, entry: null }

function call(overrides: Partial<AiCallRecord> = {}): AiCallRecord {
  const symbol = overrides.symbol ?? 'SOLUSDT'
  const time = overrides.candleTime ?? T
  return {
    id: `${overrides.model ?? A}:${symbol}:${time}`,
    at: time + 25,
    source: 'watch',
    status: 'ok',
    model: A,
    provider: 'Test',
    promptVersion: AI_OPPORTUNITY_PROMPT_VERSION,
    contextVersion: 'context-v1',
    schemaVersion: AI_OPPORTUNITY_SCHEMA_VERSION,
    exchange: 'binance',
    symbol,
    interval: '15m',
    candleTime: time,
    position: 'flat',
    referencePrice: 100,
    usage: { promptTokens: 2400, completionTokens: 500, costUsd: 0.003, latencyMs: 14_000 },
    error: null,
    recommendation: 'buy',
    confidence: 0.8,
    rationale: 'Cleared the range on volume.',
    detail: LONG,
    eventId: `binance:${symbol}:${time}`,
    eventType: 'breakout',
    ...overrides
  }
}

/** Minute bars from the event on: flat at 100, with `shape` laid over the bar at each offset. */
function bars(length: number, shape: Record<number, Partial<Candle>> = {}, from = T): Candle[] {
  return Array.from({ length }, (_, n) => ({ time: from + n * 60, open: 100, high: 100.05, low: 99.95, close: 100, volume: 1, ...shape[n] }))
}
const TO_TARGET = bars(90, { 6: { high: 103.5, close: 103.2 } })
const TO_STOP = bars(90, { 6: { low: 98, close: 98.2 } })
/** The price leaves upward before the answer arrives and never comes back to the range. */
const AWAY = Array.from({ length: 90 }, (_, n) => ({ time: T + n * 60, open: 101, high: 101.3, low: 100.8, close: 101, volume: 1 }))

describe('feedItemStatus', () => {
  const one = (calls: AiCallRecord[]): ReturnType<typeof assembleFeed>[number] => assembleFeed([event()], calls)[0]

  it('says an event nobody has answered is not asked', () => {
    expect(feedItemStatus(one([]), undefined, T + 30)).toBe('waiting')
    expect(describeFeedItemStatus('waiting')).toBe('Not asked')
  })

  it('says an event with no call to act on is no trade', () => {
    expect(feedItemStatus(one([call({ recommendation: 'hold', detail: NONE })]), [], T + 30)).toBe('asked')
    expect(feedItemStatus(one([call({ confidence: 0.6 })]), TO_TARGET, LATER)).toBe('asked')
    expect(feedItemStatus(one([call({ status: 'rejected', error: 'The stop is not below the entry range' })]), TO_TARGET, LATER)).toBe('asked')
    expect(describeFeedItemStatus('asked')).toBe('No trade')
  })

  it('follows a call to act on from its entry being on offer to its trade being over', () => {
    const item = one([call()])
    // Answered at T + 25: nothing can fill before the minute that opens at T + 60.
    expect(feedItemStatus(item, bars(1), T + 50)).toBe('valid')
    // Entered at T + 60, target not yet reached.
    expect(feedItemStatus(item, bars(4), T + 240)).toBe('open')
    expect(feedItemStatus(item, TO_TARGET, LATER)).toBe('closed')
    expect(feedItemStatus(item, TO_STOP, LATER)).toBe('closed')
  })

  it('says expired when the price never came to the entry', () => {
    const item = one([call()])
    expect(feedItemStatus(item, AWAY.slice(0, 5), T + 300)).toBe('valid')
    expect(feedItemStatus(item, AWAY, LATER)).toBe('expired')
    expect(describeFeedItemStatus('expired')).toBe('Expired')
  })

  it('is named by the most alive thing on the card', () => {
    // One model's entry never filled; the other, with a wider range, is in a trade.
    const wide = { ...LONG, entry: { min: 99.5, max: 101.5, validMinutes: 15 }, takeProfit: 108, stopLoss: 96 }
    const item = one([call(), call({ model: B, detail: wide })])
    expect(feedItemStatus(item, AWAY.slice(0, 30), T + 1800)).toBe('open')
    // And a closed trade outranks an entry that expired.
    const closedToo = one([call(), call({ model: B, detail: { ...wide, takeProfit: 101.2 } })])
    expect(feedItemStatus(closedToo, AWAY, LATER)).toBe('closed')
  })

  it('does not guess where the candles that would say have not been read', () => {
    const item = one([call()])
    expect(feedItemStatus(item, undefined, T + 30)).toBeNull()
    // Past its expiry, with candles that stop short of it: it may have traded in a minute nobody read.
    expect(feedItemStatus(item, AWAY.slice(0, 5), LATER)).toBeNull()
  })
})

describe('rightNowRows', () => {
  it('lists an event whose call to act on can still be taken, with every model\'s call beside it', () => {
    const feed = assembleFeed([event()], [call(), call({ model: B, recommendation: 'hold', confidence: 0.55, detail: NONE })])
    const rows = rightNowRows(feed, new Map(), T + 120)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ model: A, side: 'long', entryMin: 99.8, entryMax: 100.2, expiresAt: T + 900 })
    expect(rows[0].calls).toEqual([
      { model: A, side: 'long', confidence: 0.8, refused: false, acted: true },
      { model: B, side: null, confidence: 0.55, refused: false, acted: false }
    ])
  })

  it('drops it the second its entry runs out', () => {
    const feed = assembleFeed([event()], [call()])
    expect(rightNowRows(feed, new Map(), T + 899)).toHaveLength(1)
    expect(rightNowRows(feed, new Map(), T + 900)).toEqual([])
  })

  it('leaves out an entry that has already filled: that is a position, on its card', () => {
    const feed = assembleFeed([event()], [call()])
    expect(rightNowRows(feed, new Map([[event().id, bars(4)]]), T + 240)).toEqual([])
    // Still waiting, with candles that say so, it stays.
    expect(rightNowRows(feed, new Map([[event().id, AWAY.slice(0, 4)]]), T + 240)).toHaveLength(1)
  })

  it('lists nothing for no trade, a call under 65%, or a refused answer', () => {
    const feed = assembleFeed(
      [event('AUSDT'), event('BUSDT'), event('CUSDT')],
      [
        call({ symbol: 'AUSDT', recommendation: 'hold', detail: NONE }),
        call({ symbol: 'BUSDT', confidence: 0.6 }),
        call({ symbol: 'CUSDT', status: 'rejected', error: 'refused' })
      ]
    )
    expect(rightNowRows(feed, new Map(), T + 120)).toEqual([])
  })

  it('offers the surest call\'s entry, and ranks the strongest candidate first', () => {
    const sure = { ...LONG, entry: { min: 99.9, max: 100.1, validMinutes: 30 } }
    const strong = event('ETHUSDT', T, { live: { detectedAt: T + 8, quoteVolume24h: 9e8, spreadPct: 0.01, candidateScore: 97, rank: 1 } })
    const weak = event('ADAUSDT', T, { live: { detectedAt: T + 8, quoteVolume24h: 2e6, spreadPct: 0.1, candidateScore: 71, rank: 2 } })
    const feed = assembleFeed([weak, strong], [call({ symbol: 'ADAUSDT' }), call({ symbol: 'ETHUSDT' }), call({ symbol: 'ETHUSDT', model: B, confidence: 0.9, detail: sure })])
    const rows = rightNowRows(feed, new Map(), T + 120)
    expect(rows.map((row) => row.item.event.symbol)).toEqual(['ETHUSDT', 'ADAUSDT'])
    expect(rows[0]).toMatchObject({ model: B, entryMin: 99.9, entryMax: 100.1, expiresAt: T + 1800 })
  })
})

describe('the journal', () => {
  const events = [event('SOLUSDT', T), event('ETHUSDT', T + 3600), event('ADAUSDT', T - 86_400)]
  const calls = [
    call(),
    call({ model: B, source: 'opportunity', at: T + 400, recommendation: 'sell', confidence: 0.7, detail: { ...LONG, stopLoss: 101.5, takeProfit: 97 } }),
    call({ symbol: 'ETHUSDT', candleTime: T + 3600, recommendation: 'hold', confidence: 0.5, detail: NONE }),
    call({ symbol: 'ADAUSDT', candleTime: T - 86_400, confidence: 0.6 }),
    call({ symbol: 'ADAUSDT', candleTime: T - 86_400, model: B, status: 'rejected', error: 'The stop is not below the entry range', source: 'benchmark' }),
    // A call that never reached a model is no line: nothing was said.
    call({ symbol: 'ETHUSDT', candleTime: T + 3600, model: B, status: 'failed', error: 'overloaded' })
  ]
  const feed = assembleFeed(events, calls)
  // Candles for two of the events: the one with calls to act on, and the one whose call was
  // under 65%, which rose to its target all the same and is not credited with it.
  const scored = new Map([
    [event().id, TO_TARGET],
    [event('ADAUSDT', T - 86_400).id, bars(90, { 6: { high: 103.5, close: 103.2 } }, T - 86_400)]
  ])
  const rows = journalRows(feed, scored, LATER, answerSources(calls), new Set([`${event().id}:${A}`]))

  it('has one line an answer, newest event first', () => {
    expect(rows.map((row) => `${row.symbol}:${row.model === A ? 'A' : 'B'}`)).toEqual(['ETHUSDT:A', 'SOLUSDT:B', 'SOLUSDT:A', 'ADAUSDT:B', 'ADAUSDT:A'])
  })

  it('says what was called, with what levels, by whom it was asked, and what it did', () => {
    const line = rows.find((row) => row.symbol === 'SOLUSDT' && row.model === A)
    expect(line).toMatchObject({
      call: 'BUY',
      confidence: 0.8,
      source: 'watch',
      entryMin: 99.8,
      entryMax: 100.2,
      stopLoss: 98.5,
      takeProfit: 103,
      expiresAt: T + 900,
      holdSeconds: 3600,
      status: 'closed',
      exit: 'take_profit',
      entryTime: T + 60,
      paperTrade: true,
      costUsd: 0.003,
      latencyMs: 14_000
    })
    expect(line?.netPct).toBeGreaterThan(2.5)
    // In R as well: the target's net over what the call's own stop would have lost.
    expect(line?.r).toBeGreaterThan(1)
    expect(rows.find((row) => row.status === 'not acted on')?.r).toBeNull()
    // The short was asked for by a click, minutes later: it arrived after the rise, entered on a
    // flat market, and its hour ran out. Scored from when it arrived, not from the event.
    expect(rows.find((row) => row.symbol === 'SOLUSDT' && row.model === B)).toMatchObject({
      call: 'SELL',
      source: 'opportunity',
      status: 'closed',
      exit: 'time',
      entryTime: T + 420,
      paperTrade: false
    })
  })

  it('does not score what this app would not have acted on, and says when candles have not been read', () => {
    expect(rows.find((row) => row.symbol === 'ETHUSDT')).toMatchObject({ call: 'NO TRADE', status: 'no trade', entryMin: null, stopLoss: null, netPct: null })
    expect(rows.find((row) => row.symbol === 'ADAUSDT' && row.model === A)).toMatchObject({ call: 'BUY', status: 'not acted on', netPct: null, entryTime: null, exit: null })
    expect(rows.find((row) => row.symbol === 'ADAUSDT' && row.model === B)).toMatchObject({ call: 'REFUSED', status: 'no trade', source: 'benchmark' })
    const unscored = journalRows(feed, new Map(), LATER)
    expect(unscored.find((row) => row.symbol === 'SOLUSDT' && row.model === A)).toMatchObject({ status: 'not scored', netPct: null, source: null, paperTrade: false })
  })

  it('filters by model, pair, call and day', () => {
    expect(filterJournal(rows, {})).toHaveLength(5)
    expect(filterJournal(rows, { model: B }).map((row) => row.symbol)).toEqual(['SOLUSDT', 'ADAUSDT'])
    expect(filterJournal(rows, { symbol: ' sol ' }).map((row) => row.model)).toEqual([B, A])
    expect(filterJournal(rows, { call: 'BUY' }).map((row) => row.symbol)).toEqual(['SOLUSDT', 'ADAUSDT'])
    expect(filterJournal(rows, { call: 'REFUSED' })).toHaveLength(1)
    const day = Date.parse('2026-10-05T00:00:00Z') / 1000
    // From a day, inclusive; to a time, exclusive.
    expect(filterJournal(rows, { fromSec: day }).map((row) => row.symbol)).toEqual(['ETHUSDT', 'SOLUSDT', 'SOLUSDT'])
    expect(filterJournal(rows, { toSec: day }).map((row) => row.symbol)).toEqual(['ADAUSDT', 'ADAUSDT'])
    expect(filterJournal(rows, { fromSec: T, toSec: T + 3600 }).map((row) => row.symbol)).toEqual(['SOLUSDT', 'SOLUSDT'])
    expect(filterJournal(rows, { model: A, call: 'BUY', symbol: 'ada' })).toHaveLength(1)
  })

  it('adds up the lines on screen: a sum and a count, never a rate', () => {
    const totals = journalTotals(rows)
    expect(totals).toMatchObject({ rows: 5, acted: 2, closed: 2, wins: 1 })
    const buy = rows.find((row) => row.symbol === 'SOLUSDT' && row.model === A)?.netPct ?? 0
    const short = rows.find((row) => row.symbol === 'SOLUSDT' && row.model === B)?.netPct ?? 0
    expect(totals.netSumPct).toBeCloseTo(buy + short, 10)
    const rOf = (model: string): number => rows.find((row) => row.symbol === 'SOLUSDT' && row.model === model)?.r ?? Number.NaN
    expect(totals.rSum).toBeCloseTo(rOf(A) + rOf(B), 10)
    expect(totals.costUsd).toBeCloseTo(0.015, 10)
    expect('winRatePct' in totals).toBe(false)
  })

  it('saves as a spreadsheet with a header, one row a line, and nothing a spreadsheet would run', () => {
    const csv = journalCsv(rows)
    const lines = csv.trimEnd().split('\r\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe(
      'event_time_utc,pair,event,band,event_score,model,asked_by,answered_utc,call,confidence,entry_min,entry_max,stop,target,entry_valid_until_utc,hold_minutes,status,' +
        'entered_minute_utc,entry_price,exit,exited_minute_utc,net_pct,r,best_pct,worst_pct,held_minutes,answer_cost_usd,answer_seconds,paper_trade_by_watch'
    )
    const sol = lines.find((line) => line.includes('SOLUSDT') && line.includes(A) && line.includes(',BUY,'))
    expect(sol).toContain('2026-10-05T09:07:00Z,SOLUSDT,breakout,urgent,91,openai/gpt-5-mini,watch,2026-10-05T09:07:25Z,BUY,0.8,99.8,100.2,98.5,103,2026-10-05T09:22:00Z,60,closed,2026-10-05T09:08:00Z')
    expect(sol?.endsWith(',yes')).toBe(true)
    // Every row has the header's number of cells, and an unknown is an empty cell, not a zero.
    const width = lines[0].split(',').length
    for (const line of lines) expect(line.split(',')).toHaveLength(width)
    expect(lines.find((line) => line.includes('ETHUSDT'))).toContain(',NO TRADE,0.5,,,,,,,no trade,,,,,,,,')
    // A pair whose name begins like a formula is written so that it is not one.
    const evil = journalRows(assembleFeed([event('=CMD()', T)], [call({ symbol: '=CMD()' })]), new Map(), LATER)
    expect(journalCsv(evil).split('\r\n')[1]).toContain(",'=CMD(),")
  })

  it('knows who asked first, which is whose answer the line is', () => {
    const sources = answerSources([call({ at: T + 500, source: 'opportunity' }), call({ at: T + 25, source: 'watch' }), call({ status: 'failed', at: T + 5, source: 'benchmark' })])
    expect(sources.get(`${event().id}:${A}`)).toBe('watch')
    expect(sources.size).toBe(1)
  })
})
