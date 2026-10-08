import { describe, expect, it } from 'vitest'
import {
  NEAR_STOP_SHARE,
  actionableRefusal,
  breakerNotice,
  confirmNotice,
  disagreementNotice,
  liveExitNotice,
  marketEventNotice,
  nearStopNotice,
  paperCloseNotice,
  stopProgress,
  systemFailureNotice,
  tradeBlockedNotice
} from '../shared/notices'

// THE NOTICES THE V4 DOCUMENT NAMES (§47-48), each in words (shared/notices.ts): what is said, how
// loud, of what kind, and on which thread. The handler that tells them is tested in appNotify.

const EVENT = { id: 'binance:SOLUSDT:1791500000', symbol: 'SOLUSDT', type: 'breakout' as const, band: 'urgent' as const, score: 88.4, returnsPct: { m1: 0.4, m5: 1.2, m15: 3.1, h1: 3, h4: 2 }, time: 1_791_500_000 }

describe('a market event the watch left', () => {
  it('says what moved, how far, and why the watch did not ask, on the pair\'s thread, silently', () => {
    const notice = marketEventNotice(EVENT, 'the watch is off.')
    expect(notice.title).toBe('SOLUSDT: breakout (urgent)')
    expect(notice.body).toBe('Score 88, +3.10% in fifteen minutes at 22:53 UTC. The watch did not ask about it: the watch is off. Nothing was placed.')
    expect(notice.extra).toEqual({ kind: 'MARKET_EVENT', thread: 'SOLUSDT', severity: 'watch' })
  })
})

describe('models on opposite sides', () => {
  it('names who said BUY and who said SELL, on the event\'s thread', () => {
    const notice = disagreementNotice(EVENT, [
      { model: 'GPT-5 mini', side: 'long' },
      { model: 'Claude', side: 'short' },
      { model: 'Gemini', side: 'long' }
    ])
    expect(notice.title).toBe('SOLUSDT: the models disagree')
    expect(notice.body).toBe('On the breakout: BUY from GPT-5 mini, Gemini; SELL from Claude. The paper trade, if any, follows the model it is set to.')
    expect(notice.extra).toEqual({ kind: 'MODEL_DISAGREEMENT', thread: EVENT.id, severity: 'watch' })
  })
})

describe('a paper trade closed', () => {
  const trade = { id: 'paper-1', symbol: 'SOLUSDT', side: 'buy' as const, quoteAsset: 'USDT' }

  it('is the target reached, the stop triggered, or a trade run out, in money and R', () => {
    expect(paperCloseNotice(trade, { exit: 'take_profit', pnlQuote: 2.4, r: 2.1 })).toEqual({
      title: 'SOLUSDT: paper BUY reached its target',
      body: '+2.4 USDT (+2.10 R) after fees, on paper. Nothing real was placed or sold.',
      extra: { kind: 'TARGET_REACHED', thread: 'paper-1', severity: 'high' }
    })
    expect(paperCloseNotice(trade, { exit: 'stop_loss', pnlQuote: -1.05, r: -1 })).toMatchObject({ title: 'SOLUSDT: paper BUY hit its stop', body: '-1.05 USDT (-1.00 R) after fees, on paper. Nothing real was placed or sold.', extra: { kind: 'STOP_TRIGGERED', severity: 'high' } })
    expect(paperCloseNotice(trade, { exit: 'trailing_stop', pnlQuote: 0.8, r: null }).extra.kind).toBe('STOP_TRIGGERED')
    expect(paperCloseNotice(trade, { exit: 'liquidation', pnlQuote: -100, r: null }).title).toBe('SOLUSDT: paper BUY was liquidated')
    expect(paperCloseNotice({ ...trade, side: 'sell' }, { exit: 'time_limit', pnlQuote: 0.3, r: null })).toEqual({
      title: 'SOLUSDT: paper SELL ran out its time limit',
      body: '+0.3 USDT after fees, on paper. Nothing real was placed or sold.',
      extra: { kind: 'TRADE_EXECUTED', thread: 'paper-1', severity: 'watch' }
    })
    expect(paperCloseNotice(trade, { exit: 'ai_exit', pnlQuote: 0, r: 0 }).title).toBe('SOLUSDT: paper BUY was closed by the exit check')
  })
})

describe('a position near its stop', () => {
  it('measures where the price stands between the entry and the stop, either side', () => {
    expect(stopProgress({ side: 'buy', entryPrice: 100, stopPct: 2, price: 100 })).toBe(0)
    expect(stopProgress({ side: 'buy', entryPrice: 100, stopPct: 2, price: 98.5 })).toBeCloseTo(0.75, 10)
    expect(stopProgress({ side: 'buy', entryPrice: 100, stopPct: 2, price: 98 })).toBeCloseTo(1, 10)
    expect(stopProgress({ side: 'buy', entryPrice: 100, stopPct: 2, price: 101 })).toBeCloseTo(-0.5, 10)
    expect(stopProgress({ side: 'sell', entryPrice: 100, stopPct: 2, price: 101.5 })).toBeCloseTo(0.75, 10)
    expect(stopProgress({ side: 'buy', entryPrice: 100, stopPct: null, price: 90 })).toBeNull()
    expect(stopProgress({ side: 'buy', entryPrice: 0, stopPct: 2, price: 90 })).toBeNull()
    expect(NEAR_STOP_SHARE).toBe(0.75)
  })

  it('says how far along it is and that the stop still stands, on the trade\'s thread, with sound', () => {
    expect(nearStopNotice({ id: 'paper-1', symbol: 'SOLUSDT', side: 'buy', real: false }, 0.8, 98.4)).toEqual({
      title: 'SOLUSDT: near its stop',
      body: 'The paper BUY is 80% of the way from its entry to its stop, at 98.4. Its stop is still in place; nothing was done.',
      extra: { kind: 'POSITION_RISK', thread: 'paper-1', severity: 'high' }
    })
    expect(nearStopNotice({ id: 'live-1', symbol: 'BTCUSDT', side: 'buy', real: true }, 0.76, 60_000).body).toContain('real BUY is 76% of the way from its entry to its stop, at 60000. Its stop is still in place on its watcher')
  })
})

describe('a real position closed by its watcher', () => {
  it('is told as its kind, with what was realized', () => {
    const base = { executorId: 'e1', symbol: 'BTCUSDT', exitPrice: 61_000, realizedPnl: 4.2, quoteAsset: 'USDT' }
    expect(liveExitNotice({ ...base, exitReason: 'take_profit' })).toEqual({ title: 'BTCUSDT: real position reached its target', body: 'Closed by its watcher at 61000: +4.2 USDT realized. A real sell was placed.', extra: { kind: 'TARGET_REACHED', thread: 'e1', severity: 'high' } })
    expect(liveExitNotice({ ...base, exitReason: 'stop_loss', realizedPnl: -2 }).extra.kind).toBe('STOP_TRIGGERED')
    expect(liveExitNotice({ ...base, exitReason: 'trailing_stop' }).title).toBe('BTCUSDT: real position hit its trailing stop')
    expect(liveExitNotice({ ...base, exitReason: 'time_limit' }).extra.kind).toBe('TRADE_EXECUTED')
    expect(liveExitNotice({ ...base, exitReason: 'manual' })).toMatchObject({ title: 'BTCUSDT: real position was closed by hand', extra: { kind: 'TRADE_EXECUTED' } })
  })
})

describe('a failure and a breaker', () => {
  it('names what failed, on a fixed thread held for an hour', () => {
    expect(systemFailureNotice('scanner', 'No pair could be read.')).toEqual({ title: 'The scanner is failing', body: 'No pair could be read. Nothing was placed; what is open keeps its stops.', extra: { kind: 'SYSTEM_FAILURE', thread: 'scanner', severity: 'high', threadSeconds: 3600 } })
    expect(systemFailureNotice('stream', 'x').title).toBe('The live stream is dead')
    expect(systemFailureNotice('feed', 'x').title).toBe('The news feeds cannot be read')
    expect(systemFailureNotice('ai-key', 'x').title).toBe('The OpenRouter key was rejected')
  })

  it('names the breaker, held for a day for the budget, a rested model, a degraded model and a strategy, half an hour otherwise', () => {
    expect(breakerNotice('ai-budget', 'The day is spent.')).toEqual({ title: "Today's AI budget is spent", body: 'The day is spent.', extra: { kind: 'CIRCUIT_BREAKER', thread: 'ai-budget', severity: 'high', threadSeconds: 86_400 } })
    expect(breakerNotice('model', 'GPT-5 mini is rested.', 'model:openai/gpt-5-mini').extra).toEqual({ kind: 'CIRCUIT_BREAKER', thread: 'model:openai/gpt-5-mini', severity: 'high', threadSeconds: 86_400 })
    expect(breakerNotice('live-loss', 'x').extra).toEqual({ kind: 'CIRCUIT_BREAKER', thread: 'live-loss', severity: 'high', threadSeconds: 1800 })
    expect(breakerNotice('health', 'Live trading is paused: the clock is off.').title).toBe('LIVE TRADING PAUSED')
    expect(breakerNotice('health-ok', 'Resumed.', 'health-ok').extra).toEqual({ kind: 'CIRCUIT_BREAKER', thread: 'health-ok', severity: 'watch', threadSeconds: 1800 })
    // 8 October 2026: a model or a strategy whose record has degraded, once a day, with sound, switching nothing off.
    expect(breakerNotice('degraded', 'GPT-5 mini has degraded.', 'degraded:openai/gpt-5-mini')).toEqual({
      title: 'A model has degraded',
      body: 'GPT-5 mini has degraded.',
      extra: { kind: 'CIRCUIT_BREAKER', thread: 'degraded:openai/gpt-5-mini', severity: 'high', threadSeconds: 86_400 }
    })
    expect(breakerNotice('strategy', 'x', 'strategy:bot-1')).toEqual({ title: 'A strategy is not doing what was measured', body: 'x', extra: { kind: 'CIRCUIT_BREAKER', thread: 'strategy:bot-1', severity: 'high', threadSeconds: 86_400 } })
  })
})

describe('a paper trade not opened', () => {
  it('is told for a reason a person can act on, and not for the market\'s', () => {
    expect(actionableRefusal('No paper trade: the paper account has 3.20 USDT free, under the stake.')).toBe(true)
    expect(actionableRefusal('No paper trade: the money-out cap of 1000 USDT is reached.')).toBe(true)
    expect(actionableRefusal("No paper trade: the watch's paper trades are paused after a losing run.")).toBe(true)
    expect(actionableRefusal('No paper trade: the spread is 0.14%, over 0.1%.')).toBe(false)
    expect(actionableRefusal('No paper trade: no fresh price for SOLUSDT.')).toBe(false)
    expect(tradeBlockedNotice('SOLUSDT', 'No paper trade: the money-out cap of 1000 USDT is reached.')).toEqual({
      title: 'SOLUSDT: paper trade not opened',
      body: 'No paper trade: the money-out cap of 1000 USDT is reached. Nothing was placed.',
      extra: { kind: 'TRADE_BLOCKED', thread: 'paper-blocked', severity: 'watch' }
    })
  })
})

describe('a paper BUY ready to confirm (8 October 2026)', () => {
  it('names the call, says a paper trade is open, and that pressing Confirm fills in a real order a person places', () => {
    const notice = confirmNotice(EVENT, { who: 'GPT-5 mini', confidence: 0.74 })
    expect(notice.title).toBe('SOLUSDT: ready to confirm')
    expect(notice.body).toBe(
      'GPT-5 mini at 74% confidence called a BUY on the breakout at 22:53 UTC, and a paper trade is open on it. Open Opportunities and press Confirm to fill in a real order from the call, sized by your risk setting: you place it, and nothing is placed by this.'
    )
    expect(notice.extra).toEqual({ kind: 'TRADE_OPPORTUNITY', thread: 'confirm:binance:SOLUSDT:1791500000', severity: 'high' })
  })
})
