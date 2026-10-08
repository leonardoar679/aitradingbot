import { describe, expect, it } from 'vitest'
import type { AiSignalDecision, AiSignalDetail } from '../shared/aiSignal'
import { voteOf } from '../shared/opportunityVote'

// THE VOTE THAT ACTS (shared/opportunityVote.ts; the V5 document, §39; V5 Stage 5): what the
// models' answers to one event add up to, the plan the paper trade follows, and the refusal when
// they do not agree.

const LONG: AiSignalDetail = { marketRegime: 'bull', riskLevel: 'medium', horizonBars: 4, stopLoss: 98.5, takeProfit: 103, reasonCodes: ['breakout'], levelsNote: null, entry: { min: 99.8, max: 100.2, validMinutes: 15 } }
const SHORT: AiSignalDetail = { ...LONG, stopLoss: 101.5, takeProfit: 97 }

function decision(model: string, recommendation: 'buy' | 'sell' | 'hold', confidence = 0.8, over: Partial<AiSignalDecision> = {}): AiSignalDecision {
  return {
    candleTime: 1_790_000_000,
    recommendation,
    confidence,
    rationale: 'x',
    model,
    cached: false,
    error: null,
    rejected: null,
    detail: recommendation === 'hold' ? null : recommendation === 'buy' ? LONG : SHORT,
    usage: null,
    ...over
  }
}

describe('the vote', () => {
  it('takes the side more than half of the usable answers take, with none on the other, and the plan of the surest among them', () => {
    const vote = voteOf([decision('a', 'buy', 0.7), decision('b', 'buy', 0.9), decision('c', 'hold')])
    expect(vote.side).toBe('long')
    expect(vote.chosen?.model).toBe('b')
    expect(vote.refusal).toBeNull()
    expect(vote.text).toBe('BUY 2/3')
    const sell = voteOf([decision('a', 'sell', 0.7), decision('b', 'sell', 0.75)])
    expect(sell.side).toBe('short')
    expect(sell.chosen?.model).toBe('b')
    expect(sell.text).toBe('SELL 2/2')
    // Two of three is more than half; one of two is not.
    expect(voteOf([decision('a', 'buy'), decision('b', 'hold')]).side).toBeNull()
  })

  it('refuses a split, and says who said what', () => {
    const vote = voteOf([decision('a', 'buy'), decision('b', 'sell'), decision('c', 'hold')])
    expect(vote.side).toBeNull()
    expect(vote.chosen).toBeNull()
    expect(vote.refusal).toBe('Models split: 1 BUY · 1 SELL · 1 NO TRADE.')
    expect(vote.text).toBe('split 1 BUY · 1 SELL · 1 NO TRADE')
    expect(vote.consensus.disagreement).toBe(true)
  })

  it('refuses a side without a majority, and says so', () => {
    const vote = voteOf([decision('a', 'buy'), decision('b', 'hold'), decision('c', 'hold')])
    expect(vote.refusal).toBe('Models did not agree: 1 BUY · 2 NO TRADE.')
    expect(vote.text).toBe('no majority 1 BUY · 2 NO TRADE')
    expect(voteOf([decision('a', 'buy'), decision('b', 'hold')]).refusal).toBe('Models did not agree: 1 BUY · 1 NO TRADE.')
  })

  it('is no trade, with nothing to refuse, when every usable answer says so', () => {
    const vote = voteOf([decision('a', 'hold'), decision('b', 'hold')])
    expect(vote.side).toBeNull()
    expect(vote.refusal).toBeNull()
    expect(vote.text).toBe('NO TRADE 2/2')
  })

  it('counts a refused or failed answer as not usable, and a side under the confidence this app acts on as no trade', () => {
    const refused = decision('b', 'buy', 0.9, { rejected: 'the stop is above the entry' })
    const failed = decision('c', 'hold', 0, { error: 'overloaded' })
    const vote = voteOf([decision('a', 'buy', 0.7), refused, failed])
    expect(vote.text).toBe('BUY 1/1')
    expect(vote.chosen?.model).toBe('a')
    expect(voteOf([refused, failed]).refusal).toBe('No model gave a usable answer.')
    expect(voteOf([decision('a', 'buy', 0.6), decision('b', 'buy', 0.6)]).text).toBe('NO TRADE 2/2')
    expect(voteOf([null, undefined]).text).toBe('no usable answer')
  })
})
