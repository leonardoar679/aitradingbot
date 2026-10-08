import { describe, expect, it } from 'vitest'
import { aiContextJson, aiPromptVersion, aiSchemaVersion, buildEventContext, buildMarketMoveContext } from '../shared/aiContext'
import { AI_OPPORTUNITY_MARKET_MOVE_PROMPT_VERSION, AI_OPPORTUNITY_SCHEMA_VERSION, describeQuestionKind, questionKindOfPromptVersion } from '../shared/aiOpportunity'
import type { MarketMoveMember } from '../shared/marketEvent'
import { eventQuestionCandles } from './eventCandles'

// The question about a market-wide move (8 October 2026): Bitcoin's pair read as an event's is, named
// market_move and pointing the way most of the market moved, with the members as breadth. Its own
// prompt version and cache bytes; the answer's shape and schema are every opportunity's.

const META = { exchange: 'binance' as const, symbol: 'BTCUSDT' }
const MEMBERS: MarketMoveMember[] = [
  { symbol: 'SOLUSDT', direction: 'up', score: 91, returnM15Pct: 3.1, volumeRatio: 4.7 },
  { symbol: 'XRPUSDT', direction: 'up', score: 84, returnM15Pct: 2.2, volumeRatio: null }
]

describe('the market-wide move question', () => {
  const fixture = eventQuestionCandles({ pct: 1.5, volume: 4 })

  it('is Bitcoin\'s pair as an event of its own kind, with the members last, under its own version', () => {
    const context = buildMarketMoveContext(fixture.candles15m, fixture.candles1m, META, { direction: 'up', members: MEMBERS })
    expect(context).not.toBeNull()
    expect(context?.event).toMatchObject({ type: 'market_move', direction: 'up', time: fixture.eventTime })
    expect(context?.marketMove).toEqual({ members: MEMBERS })
    expect(context?.market).toBeUndefined()
    expect(context?.news).toBeUndefined()
    expect(Object.keys(context ?? {}).slice(-2)).toEqual(['event', 'marketMove'])
    expect(aiPromptVersion(context ?? {})).toBe(AI_OPPORTUNITY_MARKET_MOVE_PROMPT_VERSION)
    expect(aiSchemaVersion(context ?? {})).toBe(AI_OPPORTUNITY_SCHEMA_VERSION)
    expect(questionKindOfPromptVersion(AI_OPPORTUNITY_MARKET_MOVE_PROMPT_VERSION)).toBe('marketMove')
    expect(describeQuestionKind('marketMove')).toBe('the market-wide move')
  })

  it("takes the move's direction, not the candles', and is a different question from the pair's own", () => {
    const down = buildMarketMoveContext(fixture.candles15m, fixture.candles1m, META, { direction: 'down', members: [] })
    expect(down?.event).toMatchObject({ type: 'market_move', direction: 'down' })
    const own = buildEventContext(fixture.candles15m, fixture.candles1m, META)
    expect(own).not.toBeNull()
    expect(aiContextJson(own as NonNullable<typeof own>)).not.toBe(aiContextJson(down as NonNullable<typeof down>))
    expect(aiPromptVersion(own ?? {})).not.toBe(AI_OPPORTUNITY_MARKET_MOVE_PROMPT_VERSION)
  })

  it('is nothing without twelve hours of minutes or the seven-day snapshot', () => {
    expect(buildMarketMoveContext(fixture.candles15m, fixture.candles1m.slice(-100), META, { direction: 'up', members: MEMBERS })).toBeNull()
    expect(buildMarketMoveContext(fixture.candles15m.slice(-10), fixture.candles1m, META, { direction: 'up', members: MEMBERS })).toBeNull()
  })
})
