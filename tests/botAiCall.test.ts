import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { aiCallNotice, aiProposalProblem } from '../shared/aiProposal'
import type { AiSignalDecision } from '../shared/aiSignal'
import type { Bot, Candle } from '../shared/ipc'
import { announceBotAiCall, resetAnnouncedAiCalls } from '../src/bots/aiCallNotifier'
import { botAiProposal, latestBotAiCall, type BotAiCall } from '../src/bots/types'

// A RUNNING BOT'S CALL TO BUY, MADE ACTIONABLE.
//
// The order form for a call is on offer until its candle closes: fifteen minutes. A bot makes its
// call on the hour with nobody watching, so without this the only way to act on one was to be on
// the Analyze tab at the right moment. The bot's own card now offers the same form, and the
// desktop is told. Neither places anything: both end at the form a person submits.

const BAR = 900
const T0 = Date.parse('2026-10-04T02:00:00Z') / 1000
const ROOT = join(__dirname, '..')

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({ time: T0 + i * BAR, open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i, volume: 10 }))
}

function decision(candleTime: number, overrides: Partial<AiSignalDecision> = {}): AiSignalDecision {
  return {
    candleTime,
    recommendation: 'buy',
    confidence: 0.72,
    rationale: 'trend and momentum agree',
    model: 'openai/gpt-5-mini',
    cached: false,
    error: null,
    rejected: null,
    detail: { marketRegime: 'bull', riskLevel: 'medium', horizonBars: 16, stopLoss: 102, takeProfit: 106, reasonCodes: ['trend_up'], levelsNote: null },
    ...overrides
  }
}

const BOT = { id: 'bot-1', name: 'GPT BTC hourly', exchange: 'binance', symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' } as Bot

describe('the call a bot made last', () => {
  it('is the newest decision of its tape, with the close the model was shown and whether the paper bot entered on it', () => {
    const series = candles(6)
    const entries = [false, false, false, false, true, false]
    const call = latestBotAiCall(series, [decision(T0 + 1 * BAR, { recommendation: 'hold' }), decision(T0 + 4 * BAR)], entries, '15m')
    expect(call).toMatchObject({ interval: '15m', entered: true, referencePrice: series[3].close })
    expect(call?.decision.candleTime).toBe(T0 + 4 * BAR)
  })

  it('is nothing before the bot has decided anything, or when its candle is not in the window', () => {
    expect(latestBotAiCall(candles(6), [], [], '15m')).toBeNull()
    expect(latestBotAiCall(candles(6), [decision(T0 + 60 * BAR)], [], '15m')).toBeNull()
    // The first candle has no bar before it, and so no price to measure the levels from.
    expect(latestBotAiCall(candles(6), [decision(T0)], [true], '15m')).toBeNull()
  })

  it('marks a call made while the bot was already long as one that opened nothing', () => {
    const call = latestBotAiCall(candles(6), [decision(T0 + 4 * BAR)], [false, false, false, false, false, false], '15m')
    expect(call?.entered).toBe(false)
  })
})

describe('the order form a bot’s call is on offer as', () => {
  const entered: BotAiCall = { decision: decision(T0 + 4 * BAR), interval: '15m', referencePrice: 104, entered: true }
  const open = T0 + 4 * BAR + 60

  it('is the same form Analyze offers, on the bot’s own market', () => {
    expect(botAiProposal(BOT, entered, open)).toEqual({
      exchange: 'binance',
      pair: { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT' },
      model: 'openai/gpt-5-mini',
      candleTime: T0 + 4 * BAR,
      interval: '15m',
      confidence: 0.72,
      referencePrice: 104,
      stopLossPct: 1.92,
      takeProfitPct: 1.92,
      timeLimitSec: 16 * BAR
    })
  })

  it('is offered only for a call the paper bot itself acted on', () => {
    // Already long: the model was asked about holding, and its "buy" opens nothing.
    expect(botAiProposal(BOT, { ...entered, entered: false }, open)).toBeNull()
    expect(aiProposalProblem(entered.decision, '15m', open, false)).toMatch(/already held/)
    expect(botAiProposal(BOT, { ...entered, decision: decision(T0 + 4 * BAR, { recommendation: 'hold' }) }, open)).toBeNull()
    expect(botAiProposal(BOT, { ...entered, decision: decision(T0 + 4 * BAR, { confidence: 0.6 }) }, open)).toBeNull()
    expect(botAiProposal(BOT, null, open)).toBeNull()
  })

  it('is withdrawn when the call’s candle closes', () => {
    expect(botAiProposal(BOT, entered, T0 + 5 * BAR - 1)).not.toBeNull()
    expect(botAiProposal(BOT, entered, T0 + 5 * BAR)).toBeNull()
  })
})

describe('telling the desktop', () => {
  const entered: BotAiCall = { decision: decision(T0 + 4 * BAR), interval: '15m', referencePrice: 104, entered: true }
  const open = T0 + 4 * BAR + 60
  let notify: ReturnType<typeof vi.fn>

  beforeEach(() => {
    resetAnnouncedAiCalls()
    notify = vi.fn(async () => true)
    vi.stubGlobal('window', { api: { notify } })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('says what was called, until when, and that nothing has been placed', () => {
    const notice = aiCallNotice('GPT BTC hourly', botAiProposal(BOT, entered, open)!)
    expect(notice.title).toBe('GPT BTC hourly: BUY BTCUSDT')
    expect(notice.body).toBe(
      'openai/gpt-5-mini at 72% confidence. Nothing has been placed. An order form is on offer until 03:15 UTC: open Bots and press Prepare an order from this call.'
    )
  })

  it('raises one notice for one call, however many times it is seen', () => {
    // The portfolio poller sees the same call on every pass while its candle is open.
    expect(announceBotAiCall(BOT, entered, open)).toBe(true)
    expect(announceBotAiCall(BOT, entered, open + 120)).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
    // With its kind and its thread (shared/notices.ts), since 8 October 2026.
    expect(notify).toHaveBeenCalledWith('GPT BTC hourly: BUY BTCUSDT', expect.stringContaining('Nothing has been placed'), undefined, { kind: 'TRADE_OPPORTUNITY', thread: expect.any(String) })

    // The next call is a different one.
    const next: BotAiCall = { ...entered, decision: decision(T0 + 8 * BAR) }
    expect(announceBotAiCall(BOT, next, T0 + 8 * BAR + 30)).toBe(true)
    expect(notify).toHaveBeenCalledTimes(2)
  })

  it('stays quiet for a hold, for a call that opened nothing, and for one whose candle has closed', () => {
    expect(announceBotAiCall(BOT, { ...entered, decision: decision(T0 + 4 * BAR, { recommendation: 'hold' }) }, open)).toBe(false)
    expect(announceBotAiCall(BOT, { ...entered, entered: false }, open)).toBe(false)
    expect(announceBotAiCall(BOT, entered, T0 + 5 * BAR)).toBe(false)
    expect(announceBotAiCall(BOT, null, open)).toBe(false)
    expect(notify).not.toHaveBeenCalled()
  })

  it('does not fail the poll that noticed the call when the desktop cannot show it', () => {
    notify.mockImplementation(async () => {
      throw new Error('no notification service')
    })
    expect(() => announceBotAiCall(BOT, entered, open)).not.toThrow()
  })
})

describe('the notice is words on the desktop and nothing more', () => {
  it('the handler shows text and focuses the window: it is handed nothing to act on', () => {
    const handler = readFileSync(join(ROOT, 'electron', 'ipc', 'handlers', 'appHandlers.ts'), 'utf-8')
    // Its inputs are a title, a body, how loud, and the notice's kind and thread, and it hands them
    // to the one service that tells every notice (since 8 October 2026); it reads nothing itself.
    expect(handler).toContain('ipcMain.handle(IpcChannel.AppNotify, (event, title: unknown, body: unknown, severity?: unknown, extra?: unknown): Promise<boolean> =>')
    expect(handler).toContain('tellNotice(healNoticeRequest(title, body, severity, extra), event.sender)')
    expect(handler).not.toMatch(/placeLive|liveTrading|executor|settings/i)
    // The service reads one thing, the Notifications control (shared/alerts.ts): whether to show the
    // notice at all, and with sound; and it writes one thing, the record of what it told
    // (shared/records.ts). Those lines are the only mention of settings and of a write it may have;
    // the only thing a click does is show the window, and it reads no executor.
    const service = readFileSync(join(ROOT, 'electron', 'services', 'noticeService.ts'), 'utf-8')
    const reads = ["import { getSettings } from './settingsService'", 'healAlerts((await getSettings()).alerts)', "import { appendAlert, readAlertsSince } from './recordStoreService'"]
    for (const line of reads) expect(service).toContain(line)
    expect(reads.reduce((rest, line) => rest.replace(line, ''), service)).not.toMatch(/placeLive|liveTrading|executor|settings/i)
  })

  it('the notifier and the bot views reach for no order path', () => {
    for (const file of ['aiCallNotifier.ts', 'BotCard.tsx', 'BotDetailView.tsx']) {
      const source = readFileSync(join(ROOT, 'src', 'bots', file), 'utf-8')
      expect(source, file).not.toMatch(/liveTrading|LiveTrading|liveOrders|placeLive|window\.api\.executors/)
    }
  })
})
