import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  AI_OPPORTUNITY_MARKET_SYSTEM_PROMPT,
  AI_OPPORTUNITY_SCHEMA,
  AI_OPPORTUNITY_SYSTEM_PROMPT,
  AI_RESPONSE_SCHEMA,
  AI_SYSTEM_PROMPT,
  buildAgentMessages,
  buildAiMessages,
  responseSchemaFor
} from '../electron/services/aiPrompt'
import {
  aiContextJson,
  aiPromptVersion,
  aiSchemaVersion,
  buildAiContext,
  buildEventContext,
  eventBarTime,
  withAgentReports,
  withMarketBlock,
  type AiMarketContext
} from '../shared/aiContext'
import { referenceReturns, type EventReference } from '../shared/aiEventMarket'
import {
  AI_OPPORTUNITY_MARKET_PROMPT_VERSION,
  AI_OPPORTUNITY_PROMPT_VERSION,
  AI_OPPORTUNITY_SCHEMA_VERSION,
  describeQuestionKind,
  questionKindOfPromptVersion
} from '../shared/aiOpportunity'
import { AI_SCHEMA_VERSION, GPT_LOOKBACK_BARS, GPT_PROMPT_VERSION } from '../shared/aiSignal'
import type { Candle } from '../shared/ipc'
import { EVENT_LOOKBACK_BARS, readEventAt } from '../shared/marketEvent'
import { eventQuestionCandles, fifteenMinuteBars, quiet, referenceCandles, T0 } from './eventCandles'

const MARKET = { exchange: 'binance' as const, symbol: 'SOLUSDT' }

function context(candles15m: Candle[], candles1m: Candle[]): AiMarketContext {
  const built = buildEventContext(candles15m, candles1m, MARKET)
  if (!built) throw new Error('expected an event context')
  return built
}

describe('buildEventContext', () => {
  const { candles1m, candles15m, eventTime } = eventQuestionCandles()

  it('lays the event the detector reads over the seven-day snapshot', () => {
    const built = context(candles15m, candles1m)
    const reading = readEventAt(candles1m, candles1m.length - 1)
    const event = built.event
    expect(event).toBeDefined()
    expect(event?.time).toBe(eventTime)
    expect(event?.type).toBe(reading?.type)
    expect(event?.direction).toBe('up')
    expect(event?.price).toBe(candles1m[candles1m.length - 1].close)
    expect(event?.score).toBeCloseTo(reading?.score ?? NaN, 3)
    expect(event?.usualMove15mPct).toBeCloseTo(reading?.sigma15Pct ?? NaN, 6)
    expect(eventBarTime(event as NonNullable<typeof event>)).toBe(candles1m[candles1m.length - 1].time)
    // The snapshot under it is the plain fifteen-minute one, asked with nothing held.
    expect(built.interval).toBe('15m')
    expect(built.position).toBe('flat')
    expect(built.timeframes.map((view) => view.interval)).toEqual(['15m', '1h', '4h'])
    expect(built.decisionTime).toBe(Math.floor(eventTime / 900) * 900)
  })

  it('spells out the last thirty minutes, and the two hours before them in whole five-minute bars', () => {
    const event = context(candles15m, candles1m).event as NonNullable<AiMarketContext['event']>
    expect(event.bars1m).toHaveLength(30)
    expect(event.bars1m[29][0]).toBe(candles1m[candles1m.length - 1].time)
    expect(event.bars5m).toHaveLength(24)
    // Counted back from the event, so the newest ends where the minute bars begin and none is partial.
    const firstMinute = event.bars1m[0][0]
    expect(event.bars5m[23][0]).toBe(firstMinute - 5 * 60)
    expect(event.bars5m[0][0]).toBe(firstMinute - 120 * 60)
    // A five-minute bar is its five minutes: first open, last close, the extremes, the volume summed.
    const five = candles1m.filter((bar) => bar.time >= firstMinute - 300 && bar.time < firstMinute)
    expect(event.bars5m[23].slice(1, 5)).toEqual([five[0].open, Math.max(...five.map((bar) => bar.high)), Math.min(...five.map((bar) => bar.low)), five[4].close])
    expect(event.bars5m[23][5]).toBeCloseTo(five.reduce((sum, bar) => sum + bar.volume, 0), 6)
  })

  it('is the same bytes however much history came before either window', () => {
    const more1m = [...quiet(500, 3, candles1m[0].time - 500 * 60), ...candles1m]
    const more15m = [...fifteenMinuteBars(300, candles15m[0].time, 9), ...candles15m]
    expect(aiContextJson(context(more15m, more1m))).toBe(aiContextJson(context(candles15m, candles1m)))
  })

  it('reads no fifteen-minute bar that had not closed when the event was read', () => {
    // Bars after the event, as a caller holding the future might send them.
    const last = candles15m[candles15m.length - 1]
    const future = [1, 2, 3].map((n) => ({ ...last, time: last.time + n * 900, close: last.close * 3, high: last.close * 3 }))
    expect(aiContextJson(context([...candles15m, ...future], candles1m))).toBe(aiContextJson(context(candles15m, candles1m)))
  })

  it('is not built from a market in which nothing was raised', () => {
    const calm = eventQuestionCandles({ pct: 0.02 })
    expect(buildEventContext(calm.candles15m, calm.candles1m, MARKET)).toBeNull()
    // A watch-level move is not put to a model either: only what the scanner would raise is.
    const mild = eventQuestionCandles({ pct: 0.4, volume: 1 })
    const reading = readEventAt(mild.candles1m, mild.candles1m.length - 1)
    if (reading?.band === 'watch' || reading?.band === 'quiet') expect(buildEventContext(mild.candles15m, mild.candles1m, MARKET)).toBeNull()
  })

  it('is not built without twelve hours of minutes and seven days of quarter hours', () => {
    expect(buildEventContext(candles15m, candles1m.slice(-(EVENT_LOOKBACK_BARS - 1)), MARKET)).toBeNull()
    expect(buildEventContext(candles15m.slice(-(GPT_LOOKBACK_BARS - 1)), candles1m, MARKET)).toBeNull()
  })

  it('is not built on a snapshot older than the event', () => {
    // The fifteen-minute series stops an hour before the event: the snapshot would be of an earlier market.
    expect(buildEventContext(fifteenMinuteBars(700, Math.floor(eventTime / 900) * 900 - 3600), candles1m, MARKET)).toBeNull()
  })

  it('is asked under its own prompt, schema and versions, and no other question changes', () => {
    const built = context(candles15m, candles1m)
    expect(aiPromptVersion(built)).toBe(AI_OPPORTUNITY_PROMPT_VERSION)
    expect(aiSchemaVersion(built)).toBe(AI_OPPORTUNITY_SCHEMA_VERSION)
    expect(buildAiMessages(built)[0].content).toBe(AI_OPPORTUNITY_SYSTEM_PROMPT)
    expect(buildAiMessages(built)[1].content).toBe(aiContextJson(built))
    expect(responseSchemaFor(built)).toBe(AI_OPPORTUNITY_SCHEMA)

    const plain = buildAiContext(fifteenMinuteBars(GPT_LOOKBACK_BARS, T0), GPT_LOOKBACK_BARS, { ...MARKET, interval: '15m', position: 'flat' })
    if (!plain) throw new Error('no plain context')
    expect('event' in plain).toBe(false)
    expect(aiPromptVersion(plain)).toBe(GPT_PROMPT_VERSION)
    expect(aiSchemaVersion(plain)).toBe(AI_SCHEMA_VERSION)
    expect(buildAiMessages(plain)[0].content).toBe(AI_SYSTEM_PROMPT)
    expect(responseSchemaFor(plain)).toBe(AI_RESPONSE_SCHEMA)
  })

  it('is not a question a panel or one of its analysts can be put', () => {
    const built = context(candles15m, candles1m)
    expect(() => buildAgentMessages('trend', built)).toThrow(/snapshot and nothing else/)
    const reports = {
      trend: { regime: 'bull' as const, confidence: 0.7, reasonCodes: [], note: '' },
      momentum: { momentum: 'up' as const, confidence: 0.6, reasonCodes: [], note: '' },
      risk: { riskLevel: 'low' as const, verdict: 'attractive' as const, confidence: 0.6, reasonCodes: [], note: '' }
    }
    expect(() => withAgentReports(built, reports)).toThrow(/standalone signal/)
  })

  it('asks for the signal with an entry range and a clock added, and nothing taken away', () => {
    const signal = Object.keys((AI_RESPONSE_SCHEMA.schema as { properties: object }).properties)
    const opportunity = Object.keys((AI_OPPORTUNITY_SCHEMA.schema as { properties: object }).properties)
    for (const field of signal) expect(opportunity).toContain(field)
    expect(opportunity.filter((field) => !signal.includes(field)).sort()).toEqual(['entryMax', 'entryMin', 'validMinutes'])
    expect((AI_OPPORTUNITY_SCHEMA.schema as { required: string[] }).required.sort()).toEqual([...opportunity].sort())
  })

  it('tells the model what an event is, and not what usually follows one', () => {
    expect(AI_OPPORTUNITY_SYSTEM_PROMPT).toContain('not a signal')
    expect(AI_OPPORTUNITY_SYSTEM_PROMPT).toContain('"sell" recommends opening a short')
    expect(AI_OPPORTUNITY_SYSTEM_PROMPT).toContain('Never provide position sizing')
    // No figure from research/EVENTS.md, and no word about where the confidence gate sits.
    expect(AI_OPPORTUNITY_SYSTEM_PROMPT).not.toMatch(/0\.65|65%|on average|historically|tend to/)
  })
})

describe('the question with the market around the event', () => {
  const { candles1m, candles15m, eventTime } = eventQuestionCandles()
  /** Bitcoin quiet, ether a different quiet. */
  const reference = (): EventReference => ({ btc: referenceCandles(eventTime, 11), eth: referenceCandles(eventTime, 23) })
  const withMarket = (ref: EventReference = reference()): AiMarketContext => {
    const built = buildEventContext(candles15m, candles1m, MARKET, ref)
    if (!built) throw new Error('expected a question with the market')
    return built
  }

  it('leaves the question about the pair alone byte for byte as it was, so no answer already bought moves', () => {
    // The hash of this fixture's question taken before the market could be added to it.
    const alone = aiContextJson(context(candles15m, candles1m))
    expect(createHash('sha256').update(alone).digest('hex')).toBe('3c04276204e59486a78f2181dc27529f75c04883326277299ad00ca4d3b66d66')
    expect(alone).not.toContain('"market"')
    // Asked for with no reference, or a null one, it is that same question.
    expect(aiContextJson(buildEventContext(candles15m, candles1m, MARKET, null) as AiMarketContext)).toBe(alone)
  })

  it('is the same question with one block more, last, under a version and a prompt of its own', () => {
    const alone = context(candles15m, candles1m)
    const built = withMarket()
    const keys = Object.keys(built)
    expect(keys.slice(-2)).toEqual(['event', 'market'])
    // Everything else is the pair-alone question's, value for value.
    const { market, ...rest } = built
    expect(market).toBeDefined()
    expect(aiContextJson(rest as AiMarketContext)).toBe(aiContextJson(alone))
    expect(aiPromptVersion(built)).toBe(AI_OPPORTUNITY_MARKET_PROMPT_VERSION)
    expect(aiPromptVersion(alone)).toBe(AI_OPPORTUNITY_PROMPT_VERSION)
    // The answer it asks for is the same shape.
    expect(aiSchemaVersion(built)).toBe(AI_OPPORTUNITY_SCHEMA_VERSION)
    expect(responseSchemaFor(built)).toBe(AI_OPPORTUNITY_SCHEMA)
    expect(buildAiMessages(built)[0].content).toBe(AI_OPPORTUNITY_MARKET_SYSTEM_PROMPT)
    expect(buildAiMessages(built)[1].content).toBe(aiContextJson(built))
    expect(buildAiMessages(alone)[0].content).toBe(AI_OPPORTUNITY_SYSTEM_PROMPT)
  })

  it("sets the pair's own figures against each market's, over the same stretches", () => {
    const built = withMarket()
    const event = built.event as NonNullable<AiMarketContext['event']>
    const market = built.market as NonNullable<AiMarketContext['market']>
    const btc = referenceReturns(reference().btc, eventTime)
    expect(market.btc).toEqual(btc)
    expect(market.vsBtc.m15).toBeCloseTo(event.returnsPct.m15 - (btc?.m15 ?? NaN), 4)
    expect(market.vsBtc.h1).toBeCloseTo(event.returnsPct.h1 - (btc?.h1 ?? NaN), 4)
    expect(market.vsBtc.h4).toBeCloseTo(event.returnsPct.h4 - (btc?.h4 ?? NaN), 4)
    // The pair's day is the snapshot's day, up to the same quarter hour as the market's.
    expect(market.vsEth.h24).toBeCloseTo((built.changePct.h24 ?? NaN) - (market.eth.h24 ?? NaN), 4)
  })

  it('reads nothing of the market at or after the minute a call executes on', () => {
    const later = (candles: Candle[], step: number): Candle[] => {
      const last = candles[candles.length - 1]
      return [...candles, ...[1, 2, 3].map((n) => ({ ...last, time: last.time + n * step, close: last.close * 5, high: last.close * 5 }))]
    }
    const future: EventReference = {
      btc: { candles1m: later(reference().btc.candles1m, 60), candles15m: later(reference().btc.candles15m, 900) },
      eth: { candles1m: later(reference().eth.candles1m, 60), candles15m: later(reference().eth.candles15m, 900) }
    }
    expect(aiContextJson(withMarket(future))).toBe(aiContextJson(withMarket()))
  })

  it('is the same bytes however much of the market came before', () => {
    const longer: EventReference = {
      btc: { candles1m: [...quiet(400, 4, eventTime - 700 * 60), ...reference().btc.candles1m], candles15m: [...fifteenMinuteBars(50, reference().btc.candles15m[0].time, 4), ...reference().btc.candles15m] },
      eth: reference().eth
    }
    expect(aiContextJson(withMarket(longer))).toBe(aiContextJson(withMarket()))
  })

  it('is not asked with half a market: candles that stop short of the event make no question', () => {
    const short: EventReference = { ...reference(), eth: { ...reference().eth, candles1m: reference().eth.candles1m.slice(0, -1) } }
    expect(buildEventContext(candles15m, candles1m, MARKET, short)).toBeNull()
    expect(buildEventContext(candles15m, candles1m, MARKET, { ...reference(), btc: { candles1m: [], candles15m: [] } })).toBeNull()
    // While the same candles still make the question about the pair alone.
    expect(buildEventContext(candles15m, candles1m, MARKET)).not.toBeNull()
  })

  it('is added once, and only to an event', () => {
    expect(withMarketBlock(withMarket(), reference())).toBeNull()
    const plain = buildAiContext(fifteenMinuteBars(GPT_LOOKBACK_BARS, T0), GPT_LOOKBACK_BARS, { ...MARKET, interval: '15m', position: 'flat' })
    if (!plain) throw new Error('no plain context')
    expect(withMarketBlock(plain, reference())).toBeNull()
  })

  it('names the two questions by their prompt versions, and no other prompt as either', () => {
    expect(questionKindOfPromptVersion(AI_OPPORTUNITY_PROMPT_VERSION)).toBe('pair')
    expect(questionKindOfPromptVersion(AI_OPPORTUNITY_MARKET_PROMPT_VERSION)).toBe('market')
    expect(questionKindOfPromptVersion(GPT_PROMPT_VERSION)).toBeNull()
    expect(describeQuestionKind('pair')).toBe('the pair alone')
    expect(describeQuestionKind('market')).toBe('with the market')
  })

  it('tells the model what the block is, in one paragraph, and not what it means', () => {
    const v1 = AI_OPPORTUNITY_SYSTEM_PROMPT.split('\n')
    const v2 = AI_OPPORTUNITY_MARKET_SYSTEM_PROMPT.split('\n')
    expect(v2).toHaveLength(v1.length + 1)
    const added = v2.filter((line) => !v1.includes(line))
    expect(added).toHaveLength(1)
    expect(v2.filter((line) => line !== added[0])).toEqual(v1)
    expect(added[0]).toContain('"market"')
    expect(added[0]).toContain('vsBtc and vsEth')
    expect(added[0]).not.toMatch(/0\.65|65%|on average|historically|tend to|usually|likely|signal/)
  })
})
