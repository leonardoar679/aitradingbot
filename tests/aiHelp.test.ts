import { describe, expect, it } from 'vitest'
import { EVENT_BUY_AND_HOLD, hybridName, quantRuleName, type EventBenchmarkRow, type EventBenchmarkSummary, type EventTrade } from '../shared/aiEventBenchmark'
import { AI_HELP_MIN_TRADES, AI_HELP_NEWS_SECONDS, compareTrades, doesAiHelp, eventNewsOf } from '../shared/aiHelp'
import type { MarketEvent } from '../shared/marketEvent'
import type { StoryMark } from '../shared/newsFeed'

// shared/aiHelp.ts: "Does AI help?" -- the rows side by side, and three verdicts that say yes only
// beyond the 95% margin, and wait for thirty closed trades a side.

const T = Date.parse('2026-10-06T12:00:00Z') / 1000

const nets = (count: number, at: number, swing = 0.5): number[] => Array.from({ length: count }, (_, k) => at + (k % 2 === 0 ? swing : -swing))

describe('comparing two sets of trades', () => {
  it('waits for thirty closed trades a side', () => {
    expect(AI_HELP_MIN_TRADES).toBe(30)
    expect(compareTrades(nets(29, 1), nets(40, 0))).toMatchObject({ answer: 'not enough', a: 29, b: 40, difference: null, margin: null })
    expect(compareTrades(nets(30, 1), nets(30, 0)).answer).not.toBe('not enough')
  })

  it('says yes only beyond the 95% margin around the difference', () => {
    const clear = compareTrades(nets(40, 1), nets(40, 0))
    expect(clear.answer).toBe('yes')
    expect(clear.difference).toBeCloseTo(1, 10)
    // Each side's spread is about half a point: the margin is 1.96 times the root of the two variances over n.
    const variance = (values: number[]): number => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    }
    expect(clear.margin).toBeCloseTo(1.96 * Math.sqrt(variance(nets(40, 1)) / 40 + variance(nets(40, 0)) / 40), 10)
    // Better, but not by more than the noise: no.
    expect(compareTrades(nets(40, 0.1, 3), nets(40, 0, 3)).answer).toBe('no')
    // Worse: no.
    expect(compareTrades(nets(40, -1), nets(40, 0)).answer).toBe('no')
  })
})

describe("each event's news", () => {
  const event = (id: string, baseAsset: string, time: number, news?: MarketEvent['news']): Pick<MarketEvent, 'id' | 'baseAsset' | 'time' | 'news'> => ({ id, baseAsset, time, news })
  const mark = (over: Partial<StoryMark>): StoryMark => ({ id: 'm', publishedAt: T - 3600, tickers: ['SOL'], eventType: 'LISTING', stale: false, ...over })

  it('says whether a fresh story on the coin pointed up, down, or named it at all, in the hours before', () => {
    const marks = [
      mark({ id: 'first', publishedAt: T - 10 * 3600, tickers: [] }),
      mark({ id: 'listing' }),
      mark({ id: 'hack', tickers: ['XRP'], eventType: 'HACK' }),
      mark({ id: 'old', tickers: ['ADA'], eventType: 'HACK', stale: true }),
      mark({ id: 'macro', tickers: ['DOGE'], eventType: 'MACRO' }),
      mark({ id: 'later', tickers: ['LTC'], publishedAt: T + 60 }),
      mark({ id: 'early', tickers: ['DOT'], publishedAt: T - AI_HELP_NEWS_SECONDS - 1 })
    ]
    const news = eventNewsOf(
      [event('sol', 'SOL', T), event('xrp', 'XRP', T), event('ada', 'ADA', T), event('doge', 'DOGE', T), event('ltc', 'LTC', T), event('dot', 'DOT', T), event('btc', 'BTC', T)],
      marks
    )
    expect(news).toEqual({
      sol: { up: true, down: false, any: true },
      xrp: { up: false, down: true, any: true },
      // Old news is not news; a kind with no way of its own names the coin and points nowhere.
      ada: { up: false, down: false, any: false },
      doge: { up: false, down: false, any: true },
      // After the event, or more than three hours before it, it is not the event's news.
      ltc: { up: false, down: false, any: false },
      dot: { up: false, down: false, any: false },
      btc: { up: false, down: false, any: false }
    })
  })

  it('is not known before the first story on file, and an announcement is news pointing down', () => {
    const marks = [mark({ id: 'first', publishedAt: T - 2 * 3600 })]
    const news = eventNewsOf([event('early', 'SOL', T), event('delist', 'PEPE', T - 86_400, { articleId: 1, title: 'Binance Will Delist PEPE', releaseSec: T - 86_400 })], marks)
    expect(news.early).toBeNull()
    expect(news.delist).toEqual({ up: false, down: true, any: true })
    expect(eventNewsOf([event('any', 'SOL', T)], [])).toEqual({ any: null })
  })
})

describe('does AI help?', () => {
  /** A closed trade at event `index` on `side` that made `net`. */
  const trade = (index: number, net: number, side: 'long' | 'short' = 'long'): EventTrade =>
    ({ index, time: T + index, type: 'pump', side, confidence: 0.8, holdSeconds: 3600, outcome: { status: 'closed', netPct: net, r: net } }) as unknown as EventTrade
  const row = (name: string, trades: EventTrade[]): EventBenchmarkRow => ({ name, trades, closed: trades.length }) as unknown as EventBenchmarkRow
  const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, k) => from + k)
  const events = range(0, 200).map((index) => ({ id: `e${index}`, live: index < 120 ? { detectedAt: T, quoteVolume24h: 1e8, spreadPct: index < 80 ? 0.01 : 0.2, candidateScore: 80, rank: 1 } : null }))

  // The model: 120 trades. 0-39 with a supporting story at +1.5, 40-79 with none at -0.5;
  // 80-119 on a wide spread at -1.0.
  const ai = row('m', [
    ...range(0, 40).map((index) => trade(index, 1.5 + (index % 2 === 0 ? 0.3 : -0.3))),
    ...range(40, 40).map((index) => trade(index, -0.5 + (index % 2 === 0 ? 0.3 : -0.3))),
    ...range(80, 40).map((index) => trade(index, -1 + (index % 2 === 0 ? 0.3 : -0.3)))
  ])
  const summary = {
    models: [ai],
    quant: [row(quantRuleName('trend4h'), range(120, 40).map((index) => trade(index, 0 + (index % 2 === 0 ? 0.4 : -0.4)))), row(quantRuleName('channel15m'), range(160, 20).map((index) => trade(index, 0)))],
    hybrids: [
      { model: 'm', quant: 'trend4h' as const, row: row(hybridName('m', 'trend4h'), range(0, 40).map((index) => trade(index, 1.5 + (index % 2 === 0 ? 0.3 : -0.3)))) },
      { model: 'm', quant: 'channel15m' as const, row: row(hybridName('m', 'channel15m'), range(0, 35).map((index) => trade(index, 0))) }
    ],
    buyAndHold: row(EVENT_BUY_AND_HOLD, [])
  } as unknown as EventBenchmarkSummary
  const news = Object.fromEntries(events.map(({ id }, index) => [id, index < 40 ? { up: true, down: false, any: true } : index < 80 ? { up: false, down: false, any: false } : null]))

  it('sets the quant rows, holding, the model and its hybrids side by side', () => {
    const { rows } = doesAiHelp({ summary, model: 'm', events, news })
    expect(rows.map((entry) => [entry.kind, entry.label])).toEqual([
      ['quant', 'Quant: Trend Regime 4h, following the move'],
      ['quant', 'Quant: Short-Term Channel 15m, following the move'],
      ['hold', EVENT_BUY_AND_HOLD],
      ['ai', 'AI: m'],
      ['hybrid', 'Hybrid: m when Trend Regime 4h agrees'],
      ['hybrid', 'Hybrid: m when Short-Term Channel 15m agrees']
    ])
  })

  it('says whether the model improved each strategy, whether news helped, and whether the live price did', () => {
    const { verdicts } = doesAiHelp({ summary, model: 'm', events, news })
    const byId = Object.fromEntries(verdicts.map((verdict) => [verdict.id, verdict]))
    expect(byId['quant-trend4h']).toMatchObject({ question: 'Did m improve Trend Regime 4h?', answer: 'yes' })
    expect(byId['quant-trend4h'].text).toMatch(/^Yes: \+1\.50% a trade over 40 trades by the model where Trend Regime 4h agreed, against 0\.00% over 40 /)
    // The channel's rule has 20 trades: not enough to say.
    expect(byId['quant-channel15m']).toMatchObject({ answer: 'not enough' })
    expect(byId['quant-channel15m'].text).toBe(
      'Not enough trades yet: 30 are needed on each side, and there are 35 by the model where Short-Term Channel 15m agreed and 20 by the strategy following every move it agreed with.'
    )
    // News: the 40 with a story pointing their way beat the 40 with none; the 40 not known are left out.
    expect(byId.news).toMatchObject({ question: 'Did news help?', answer: 'yes' })
    expect(byId.news.text).toMatch(/over 40 trades on events with a story pointing the trade's way, against -0\.50% over 40 on events no story named/)
    // Live: the 80 within the line beat the 40 on a wider spread.
    expect(byId.live).toMatchObject({ question: 'Did the live price help?', answer: 'yes' })
  })

  it('counts a trade against the news only where a story pointed its way, and leaves out unknown events', () => {
    const shorts = { ...summary, models: [row('m', range(0, 40).map((index) => trade(index, 1, 'short')))] } as unknown as EventBenchmarkSummary
    // A story pointing up does not support a short.
    const { verdicts } = doesAiHelp({ summary: shorts, model: 'm', events, news })
    expect(verdicts.find((verdict) => verdict.id === 'news')?.text).toBe(
      "Not enough trades yet: 30 are needed on each side, and there are 0 on events with a story pointing the trade's way and 0 on events no story named."
    )
    // Without the stories on file, nothing is known.
    expect(doesAiHelp({ summary, model: 'm', events, news: null }).verdicts.find((verdict) => verdict.id === 'news')?.answer).toBe('not enough')
  })

  it('reads the live verdict from the spread the scanner saw at each event', () => {
    const wide = { ...summary, models: [row('m', [...range(0, 40).map((index) => trade(index, 1 + (index % 2 === 0 ? 0.2 : -0.2))), ...range(80, 40).map((index) => trade(index, -1 + (index % 2 === 0 ? 0.2 : -0.2)))])] } as unknown as EventBenchmarkSummary
    const live = doesAiHelp({ summary: wide, model: 'm', events, news }).verdicts.find((verdict) => verdict.id === 'live')
    expect(live?.answer).toBe('yes')
    expect(live?.text).toMatch(/on events with a spread within 0\.1%, against -1\.00% over 40 on wider ones, which the live check refuses/)
    // A spread exactly at the line is one the live check enters at.
    const atLine = range(200, 60).map((index) => ({ id: `l${index}`, live: { detectedAt: T, quoteVolume24h: 1e8, spreadPct: index < 230 ? 0.1 : 0.2, candidateScore: 80, rank: 1 } }))
    const lineSummary = { ...summary, models: [row('m', range(0, 60).map((index) => trade(index, index < 30 ? 1 + (index % 2 === 0 ? 0.2 : -0.2) : -1 + (index % 2 === 0 ? 0.2 : -0.2))))] } as unknown as EventBenchmarkSummary
    expect(doesAiHelp({ summary: lineSummary, model: 'm', events: atLine, news }).verdicts.find((verdict) => verdict.id === 'live')?.answer).toBe('yes')
    // Events with no spread on record are left out: with only those, nothing can be said.
    const unread = { ...summary, models: [row('m', range(120, 40).map((index) => trade(index, 1)))] } as unknown as EventBenchmarkSummary
    expect(doesAiHelp({ summary: unread, model: 'm', events, news }).verdicts.find((verdict) => verdict.id === 'live')?.text).toBe(
      'Not enough trades yet: 30 are needed on each side, and there are 0 on events with a spread within 0.1% and 0 on wider ones, which the live check refuses.'
    )
  })

  it('has no rows to set beside a model that is not there', () => {
    expect(doesAiHelp({ summary, model: 'other', events, news }).rows.map((entry) => entry.kind)).toEqual(['quant', 'quant', 'hold'])
  })
})
