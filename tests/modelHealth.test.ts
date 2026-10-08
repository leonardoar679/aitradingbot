import { beforeEach, describe, expect, it } from 'vitest'
import type { AiConfig } from '../shared/aiCost'
import type { EventTrade } from '../shared/aiEventBenchmark'
import { matchesAiCallFilter, type AiCallFilter, type AiCallRecord } from '../shared/aiLedger'
import { AI_OPPORTUNITY_PROMPT_VERSION, AI_OPPORTUNITY_SCHEMA_VERSION } from '../shared/aiOpportunity'
import { describeDecider } from '../shared/aiPanel'
import type { AiSignalDetail } from '../shared/aiSignal'
import type { Candle, ExecutorConfig } from '../shared/ipc'
import type { MarketEvent } from '../shared/marketEvent'
import { matchesMarketEventFilter } from '../shared/marketScanner'
import {
  HEALTH_CONFIDENCE_SLACK_POINTS,
  HEALTH_ROLLING_TRADES,
  PROMOTION_MAX_DRAWDOWN_R,
  PROMOTION_PAPER_PF_SLACK,
  PROMOTION_TRADES,
  closedTrades,
  describeModelHealth,
  drawdownR,
  modelHealth,
  paperRecordOf,
  promotionChecklist,
  type LiveRowForHealth
} from '../shared/modelHealth'
import type { NoticeExtra } from '../shared/notices'
import { clearLiveBars } from '../src/agents/liveBoard'
import { HEALTH_EVENTS_READ, getModelHealthReport, lookAtModelHealth, resetModelHealth, subscribeModelHealth, type ModelHealthDeps } from '../src/agents/modelHealthWatch'

// shared/modelHealth.ts and the daily look (src/agents/modelHealthWatch.ts): the promotion
// checklist and the DEGRADED mark, from a model's row on the live board. Ticks and a mark; the
// look tells once a day; nothing is promoted, rested or unticked by either.

const A = 'openai/gpt-5-mini'
const T0 = Date.parse('2026-09-01T00:00:00Z') / 1000

/** A closed trade: `net` percent, closed `n` hours after T0, at `confidence`. */
function trade(n: number, net: number, confidence = 0.8, r: number | null = net / 1.5, status: EventTrade['outcome']['status'] = 'closed'): EventTrade {
  const time = T0 + n * 3600
  return {
    index: n,
    time,
    type: 'breakout',
    side: 'long',
    confidence,
    holdSeconds: 3600,
    outcome: { status, entryTime: time + 60, entryPrice: 100, exit: net > 0 ? 'take_profit' : 'stop_loss', exitTime: time + 600, exitPrice: 100 + net, netPct: net, r, bestPct: Math.max(net, 0), worstPct: Math.min(net, 0), heldMinutes: 9 }
  }
}
const fill = (count: number, net: number, confidence = 0.8, from = 0): EventTrade[] => Array.from({ length: count }, (_, k) => trade(from + k, net, confidence))

describe('the trades of a row', () => {
  it('keeps the closed ones, the most recently closed first', () => {
    const open = trade(5, 0, 0.8, null, 'open')
    const list = closedTrades([trade(1, 1), open, trade(3, -1), trade(2, 2)])
    expect(list.map((entry) => entry.index)).toEqual([3, 2, 1])
  })

  it('measures the deepest fall of the running total in R, in the order the trades closed', () => {
    // +1, -2, -1, +3: the running total peaks at 1 and falls to -2.
    const list = [trade(0, 1.5, 0.8, 1), trade(1, -3, 0.8, -2), trade(2, -1.5, 0.8, -1), trade(3, 4.5, 0.8, 3)]
    expect(drawdownR(list)).toBe(3)
    expect(drawdownR([...list].reverse())).toBe(3)
    expect(drawdownR([trade(0, 1, 0.8, null)])).toBeNull()
    expect(drawdownR([])).toBeNull()
  })
})

describe('the promotion checklist', () => {
  const ready: LiveRowForHealth = { closed: 120, meanNetPct: 0.3, profitFactor: 1.4, netAfterAiCostUsd: 12, trades: [...fill(90, 0.375), ...fill(30, -0.375, 0.8, 90)] }
  const benchmark = { meanNetPct: 0.2, closed: 50 }
  const paper = { closed: 30, profitFactor: 1.2 }

  it('ticks every line for a model that meets them all', () => {
    const list = promotionChecklist({ live: ready, benchmark, paper })
    expect(list.items.map((item) => [item.label, item.ok])).toEqual([
      ['100 closed trades', true],
      ['Positive expectancy', true],
      ['Profit factor over 1', true],
      ['Drawdown under 10 R', true],
      ["Live board's sign agrees with the benchmark's", true],
      ['Live and paper agree: profit factor within 30%', true],
      ['Net after AI cost positive', true]
    ])
    expect(list).toMatchObject({ ticked: 7, ready: true })
    expect(list.items.map((item) => item.detail)).toEqual(['120 of 100', '+0.30% a trade', '1.40', '7.5 R', 'live +0.30%, benchmark +0.20% a trade', 'paper 1.20 over 30, live 1.40', '$12.00 at $1,000 a trade'])
    expect([PROMOTION_TRADES, PROMOTION_MAX_DRAWDOWN_R, PROMOTION_PAPER_PF_SLACK]).toEqual([100, 10, 0.3])
  })

  it('unticks each line at its own boundary', () => {
    const unticked = (live: Partial<LiveRowForHealth>, extra: { benchmark?: typeof benchmark | null; paper?: typeof paper | null } = {}): (boolean | null)[] =>
      promotionChecklist({ live: { ...ready, ...live }, benchmark: extra.benchmark === undefined ? benchmark : extra.benchmark, paper: extra.paper === undefined ? paper : extra.paper }).items.map((item) => item.ok)
    expect(unticked({ closed: 99 })[0]).toBe(false)
    expect(unticked({ closed: 100 })[0]).toBe(true)
    expect(unticked({ meanNetPct: 0 })[1]).toBe(false)
    expect(unticked({ profitFactor: 1 })[2]).toBe(false)
    // Ninety wins of a quarter R, then forty losses of a quarter: a drawdown of 10 R, on the line; thirty-nine is under it.
    expect(unticked({ trades: [...fill(90, 0.375), ...fill(40, -0.375, 0.8, 90)] })[3]).toBe(false)
    expect(unticked({ trades: [...fill(90, 0.375), ...fill(39, -0.375, 0.8, 90)] })[3]).toBe(true)
    expect(unticked({}, { benchmark: { meanNetPct: -0.1, closed: 50 } })[4]).toBe(false)
    // |0.98 - 1.4| / 1.4 is exactly 30%: within. A paper factor of 0.97 is not.
    expect(unticked({}, { paper: { closed: 30, profitFactor: 0.98 } })[5]).toBe(true)
    expect(unticked({}, { paper: { closed: 30, profitFactor: 0.97 } })[5]).toBe(false)
    expect(unticked({ netAfterAiCostUsd: 0 })[6]).toBe(false)
    expect(promotionChecklist({ live: { ...ready, closed: 99 }, benchmark, paper }).ready).toBe(false)
  })

  it('leaves a line open where the record cannot say', () => {
    const open = promotionChecklist({ live: { ...ready, meanNetPct: null, profitFactor: null, closed: 20, netAfterAiCostUsd: null, trades: [trade(0, 1, 0.8, null)] }, benchmark: null, paper: null })
    expect(open.items.map((item) => item.ok)).toEqual([false, null, null, null, null, null, null])
    expect(open.items.map((item) => item.detail)).toEqual(['20 of 100', 'under 30 closed trades', 'under 30 closed trades', 'no closed trade with a stop', 'no benchmark scored this session', 'no paper trade on its calls', 'not a model'])
    expect(open).toMatchObject({ ticked: 0, ready: false })
    // Thirty closed trades and no losing one: a profit factor there is nothing to divide by, and the line is ticked.
    expect(promotionChecklist({ live: { ...ready, profitFactor: null, closed: 30 }, benchmark, paper }).items[2]).toMatchObject({ ok: true, detail: 'no losing trade' })
    expect(promotionChecklist({ live: ready, benchmark: { meanNetPct: null, closed: 10 }, paper }).items[4]).toMatchObject({ ok: null, detail: 'under 30 closed trades on one of them' })
  })
})

describe('DEGRADED', () => {
  it('needs thirty closed trades, the most recently closed', () => {
    const few = modelHealth({ trades: fill(29, -1) })
    expect(few).toMatchObject({ degraded: false, reasons: [], closed: 29, rolling: { trades: 29, expectancyPct: null, profitFactor: null } })
    expect(HEALTH_ROLLING_TRADES).toBe(30)
    // Thirty old losers and thirty newer winners at 80%: only the newest thirty are read.
    const turned = modelHealth({ trades: [...fill(30, -1, 0.8), ...fill(30, 1, 0.8, 30)] })
    expect(turned).toMatchObject({ degraded: false, closed: 60, rolling: { trades: 30, expectancyPct: 1, profitFactor: null, meanConfidencePct: 80, hitRatePct: 100 } })
  })

  it('is losing when the expectancy is under zero and the profit factor under one, both', () => {
    // Fifteen at +1 and fifteen at -1.2, said at 50%: -0.1% a trade, factor 0.83.
    const losing = modelHealth({ trades: [...fill(15, 1, 0.5), ...fill(15, -1.2, 0.5, 15)] })
    expect(losing.degraded).toBe(true)
    expect(losing.reasons).toEqual(['losing over its last 30 closed trades: -0.10% a trade, profit factor 0.83'])
    // Fifteen at +1.2 and fifteen at -1: ahead. Fifteen at +1 and fifteen at -1: exactly even, not under.
    expect(modelHealth({ trades: [...fill(15, 1.2, 0.5), ...fill(15, -1, 0.5, 15)] }).degraded).toBe(false)
    expect(modelHealth({ trades: [...fill(15, 1, 0.5), ...fill(15, -1, 0.5, 15)] }).degraded).toBe(false)
  })

  it('is off when the confidence is more than twenty points from the hit rate, either way', () => {
    expect(HEALTH_CONFIDENCE_SLACK_POINTS).toBe(20)
    // Half the trades win at +2 against -1: ahead. Said at 71%: 21 points over a 50% hit rate.
    const over = modelHealth({ trades: [...fill(15, 2, 0.71), ...fill(15, -1, 0.71, 15)] })
    expect(over.degraded).toBe(true)
    expect(over.reasons).toEqual(['says 71% and is right 50% of the time over those trades'])
    // Twenty points exactly is not more than twenty.
    expect(modelHealth({ trades: [...fill(15, 2, 0.7), ...fill(15, -1, 0.7, 15)] }).degraded).toBe(false)
    // Said at 29% and right half the time: as far off the other way.
    expect(modelHealth({ trades: [...fill(15, 2, 0.29), ...fill(15, -1, 0.29, 15)] }).reasons).toEqual(['says 29% and is right 50% of the time over those trades'])
    // Both at once: two reasons, the losing first.
    const both = modelHealth({ trades: fill(30, -1, 0.8) })
    expect(both.reasons).toHaveLength(2)
    expect(describeModelHealth(A, both)).toBe(
      `${describeDecider(A)} has degraded: losing over its last 30 closed trades: -1.00% a trade, profit factor 0.00; says 80% and is right 0% of the time over those trades. The watch still asks it; untick it on Opportunities to stop asking it. Nothing is switched off by this.`
    )
    expect(describeModelHealth(A, modelHealth({ trades: fill(30, 1, 0.9) }))).toBe(`${describeDecider(A)}: as expected over its last 30 closed trades (+1.00% a trade, says 90% and is right 100%).`)
    expect(describeModelHealth(A, modelHealth({ trades: fill(3, 1) }))).toBe(`${describeDecider(A)}: 3 of 30 closed trades, not enough to judge.`)
  })
})

describe("the app's own paper trades on a model's calls", () => {
  it('takes the closed ones that entered, for this model, as they were settled', () => {
    const executor = (id: string, model: string, result: { exit: string; pnlQuote: number } | null): ExecutorConfig =>
      ({ id, mode: 'paper', type: 'position', status: 'stopped', params: { side: 'buy', amountQuote: 100, stopLossPct: 2, takeProfitPct: 3 }, watch: { eventId: `e-${id}`, eventTime: 1, model, confidence: 0.8, ...(result === null ? {} : { result: { ...result, closedAt: 2 } }) } }) as unknown as ExecutorConfig
    const record = paperRecordOf(
      [executor('a', A, { exit: 'take_profit', pnlQuote: 3 }), executor('b', A, { exit: 'stop_loss', pnlQuote: -2 }), executor('c', A, { exit: 'btc_moved', pnlQuote: 0 }), executor('d', A, null), executor('e', 'other/model', { exit: 'stop_loss', pnlQuote: -9 })],
      A
    )
    expect(record).toEqual({ closed: 2, profitFactor: 1.5 })
    expect(paperRecordOf([], A)).toEqual({ closed: 0, profitFactor: null })
  })
})

describe('the daily look', () => {
  const DAY = 86_400
  const NOW = Date.parse('2026-09-28T12:00:00Z') / 1000
  const LONG: AiSignalDetail = { marketRegime: 'bull', riskLevel: 'medium', horizonBars: 4, stopLoss: 98.5, takeProfit: 102, reasonCodes: ['breakout'], levelsNote: null, entry: { min: 99.8, max: 100.2, validMinutes: 15 } }

  function event(n: number): MarketEvent {
    const time = NOW - 3 * DAY + n * 3600
    return {
      id: `binance:SOLUSDT:${time}`,
      exchange: 'binance',
      symbol: 'SOLUSDT',
      baseAsset: 'SOL',
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
      live: { detectedAt: time + 8, quoteVolume24h: 80_000_000, spreadPct: 0.01, candidateScore: 93, rank: 1 }
    }
  }
  function call(entry: MarketEvent, model = A): AiCallRecord {
    return {
      id: `${entry.id}-${model}`,
      at: entry.time + 20,
      source: 'watch',
      status: 'ok',
      model,
      provider: 'Test',
      promptVersion: AI_OPPORTUNITY_PROMPT_VERSION,
      contextVersion: 'context-v1',
      schemaVersion: AI_OPPORTUNITY_SCHEMA_VERSION,
      exchange: 'binance',
      symbol: 'SOLUSDT',
      interval: '15m',
      candleTime: entry.time,
      position: 'flat',
      referencePrice: 100,
      usage: { promptTokens: 2400, completionTokens: 500, costUsd: 0.003, latencyMs: 9000 },
      error: null,
      recommendation: 'buy',
      confidence: 0.8,
      rationale: 'Cleared the range on volume.',
      detail: LONG,
      eventId: entry.id,
      eventType: 'breakout'
    }
  }
  /** Minute bars from `time`: flat at 100 for three minutes, then at `end`. */
  function path(time: number, end: number, count = 120): Candle[] {
    return Array.from({ length: count }, (_, n) => {
      const open = n > 3 ? end : 100
      const close = n >= 3 ? end : 100
      return { time: time + n * 60, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 }
    })
  }
  function rig(end: number, models: string[] = [A]): { deps: ModelHealthDeps; notices: { title: string; body: string; extra?: NoticeExtra }[]; fetches: number } {
    const events = Array.from({ length: 35 }, (_, n) => event(n))
    const calls = events.map((entry) => call(entry))
    const notices: { title: string; body: string; extra?: NoticeExtra }[] = []
    const out = { notices, fetches: 0, deps: {} as ModelHealthDeps }
    out.deps = {
      getConfig: async () => ({ watch: { models } }) as unknown as AiConfig,
      listCalls: async (filter: AiCallFilter) => ({ rows: calls.filter((row) => matchesAiCallFilter(row, filter)).sort((a, b) => b.at - a.at), skippedLines: 0 }),
      listEvents: async (filter) => ({ rows: events.filter((entry) => matchesMarketEventFilter(entry, filter)).sort((a, b) => b.time - a.time), skippedLines: 0 }),
      fetchCandles: async (_exchange, _symbol, _interval, startSec) => {
        out.fetches++
        return path(startSec, end)
      },
      notify: (title, body, extra) => notices.push({ title, body, extra }),
      nowSec: () => NOW
    }
    return out
  }

  beforeEach(() => {
    resetModelHealth()
    clearLiveBars()
  })

  it('marks a model whose last thirty trades lost, and tells it once on its own thread, held for a day', async () => {
    const { deps, notices } = rig(97)
    const seen: string[] = []
    subscribeModelHealth((report) => seen.push(Object.keys(report.models).join(',')))
    const report = await lookAtModelHealth(deps)
    expect(report.at).toBe(NOW)
    expect(report.models[A]).toMatchObject({ degraded: true, closed: 35 })
    expect(report.models[A].reasons[0]).toMatch(/^losing over its last 30 closed trades/)
    expect(notices).toHaveLength(1)
    expect(notices[0].title).toBe('A model has degraded')
    expect(notices[0].body.startsWith(`${describeDecider(A)} has degraded: losing`)).toBe(true)
    expect(notices[0].extra).toEqual({ kind: 'CIRCUIT_BREAKER', thread: `degraded:${A}`, severity: 'high', threadSeconds: 86_400 })
    expect(getModelHealthReport()).toBe(report)
    expect(seen).toEqual([A])
  })

  it('marks nothing and tells nothing for a model that is winning as it says', async () => {
    // Every trade reaches its target: 100% right, said at 80%. Twenty points, which is not more.
    const { deps, notices } = rig(103)
    const report = await lookAtModelHealth(deps)
    expect(report.models[A]).toMatchObject({ degraded: false, reasons: [] })
    expect(report.models[A].rolling).toMatchObject({ trades: 30, meanConfidencePct: 80, hitRatePct: 100 })
    expect(notices).toEqual([])
  })

  it('reads nothing with no model on the watch, and reads only the newest events otherwise', async () => {
    const none = rig(97, [])
    expect(await lookAtModelHealth(none.deps)).toEqual({ at: NOW, models: {} })
    expect(none.fetches).toBe(0)
    expect(HEALTH_EVENTS_READ).toBe(150)
    const some = rig(97)
    await lookAtModelHealth(some.deps)
    expect(some.fetches).toBe(35)
  })
})
