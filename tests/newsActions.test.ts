import { describe, expect, it } from 'vitest'
import { matchesAiCallFilter } from '../shared/aiLedger'
import { AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS, describeQuestionKind, questionKindOfPromptVersion } from '../shared/aiOpportunity'
import { DEFAULT_AI_WATCH, watchSkipReason } from '../shared/aiWatch'
import type { Candle, ExecutorConfig, PaperAccount, PaperPauseSettings, PaperRiskSettings, PositionExecutorParams, SymbolInfo } from '../shared/ipc'
import { DEFAULT_NEWS_CONFIG, applyNewsConfigPatch, healNewsConfig, newsActionsFor, type NewsConfig, type NewsItem } from '../shared/news'
import { DEFAULT_PAPER_PAUSE, resumePaperPause } from '../shared/paperPause'
import { paperStake, riskedAtStop } from '../shared/paperRisk'
import {
  delistingShortParams,
  describeNewsShortOrigin,
  heldPlaces,
  isFreshNews,
  newsHolderNotice,
  newsQuestionProblem,
  newsShortBlock,
  newsShortExecutors,
  newsEventKind,
  shouldRaiseNewsEvent,
  tagReading,
  tagReadingWindow,
  tagShortParams,
  tagShortWindow,
  type Holdings
} from '../shared/newsActions'
import { simulatePosition } from '../src/executors/engine'
import { exitNewsShort, newsShortExecutor, openNewsShorts, settleNewsShorts, type NewsShortDeps } from '../src/news/newsPaperShort'
import type { AiExitOrder } from '../shared/aiExit'

// What a delisting announcement does, and a coin added to the Monitoring Tag, as the user chose on
// 2026-10-05 (shared/newsActions.ts, src/news/): a notice to someone holding the coin, and a PAPER
// short by the kind's rule research/NEWS.md measured. A delisting's is out at the open four hours
// after the announcement's minute, no stop, no target; a tag's is below, at the end.

/** ICX, SCRT and STORJ: Binance's announcement of 20 August 2026, 06:00 UTC. */
const A = Date.parse('2026-08-20T06:00:00Z') / 1000

const item: NewsItem = {
  id: 301,
  catalog: 161,
  title: 'Binance Will Delist ICX, SCRT, STORJ on 2026-09-03',
  releaseSec: A,
  seenAt: A + 3,
  category: 'DELISTING',
  tickers: ['ICX', 'SCRT', 'STORJ']
}

const pair = (base: string): SymbolInfo => ({ symbol: `${base}USDT`, baseAsset: base, quoteAsset: 'USDT' })

/** The executor a delisting's short is, made the way the writer makes it. */
const delistingShort = (id: string, ticker: string, stakeQuote: number, nowSec: number): ExecutorConfig =>
  newsShortExecutor({ id, item, ticker, pair: pair(ticker), nowSec, params: delistingShortParams({ releaseSec: item.releaseSec, createdAt: nowSec, stakeQuote }) })

describe("the rule's short", () => {
  it('is out at the open four hours after the announcement, whenever in the minute it is opened', () => {
    // Opened in the minute after the announcement's: in at the next open, two minutes after it.
    expect(delistingShortParams({ releaseSec: A + 2, createdAt: A + 63, stakeQuote: 100 })).toEqual({
      side: 'sell',
      entryPrice: null,
      amountQuote: 100,
      takeProfitPct: null,
      stopLossPct: null,
      timeLimitSec: 237 * 60,
      trailingStop: null
    })
    // Opened in the announcement's own minute: in a minute sooner, held a minute longer.
    expect(delistingShortParams({ releaseSec: A, createdAt: A + 3, stakeQuote: 100 }).timeLimitSec).toBe(238 * 60)
    expect(delistingShortParams({ releaseSec: A, createdAt: A + 60, stakeQuote: 100 }).timeLimitSec).toBe(238 * 60)
  })

  it('is closed by the engine at the close of the minute before the four hours are up', () => {
    const params = delistingShortParams({ releaseSec: A, createdAt: A + 63, stakeQuote: 100 })
    // In at 10 at A+2min; the coin rises to 11 at A+200min and stays there.
    const bars: Candle[] = []
    for (let t = A + 120; t <= A + 250 * 60; t += 60) {
      const price = t < A + 200 * 60 ? 10 : 11
      bars.push({ time: t, open: price, high: price, low: price, close: price, volume: 1 })
    }
    const state = simulatePosition(bars, params as PositionExecutorParams)
    expect(state).toMatchObject({ status: 'closed', exitReason: 'time_limit', entryPrice: 10, enteredAt: A + 120, closedAt: A + 239 * 60 })
    // A short of a coin that rose: it lost the rise and the fees.
    expect(state.realizedPnl).toBeCloseTo(-10 - (100 + 110) * 0.001, 6)
  })

  it('opens only on a delisting of that coin, within five minutes, once', () => {
    const base = { item, ticker: 'ICX', nowSec: A + 63, executors: [] as ExecutorConfig[] }
    expect(newsShortBlock(base)).toBeNull()
    expect(newsShortBlock({ ...base, ticker: 'BTC' })).toMatch(/not a delisting or a Monitoring Tag of this coin/)
    expect(newsShortBlock({ ...base, item: { ...item, category: 'FUTURES_LAUNCH' } })).toMatch(/not a delisting/)
    expect(newsShortBlock({ ...base, nowSec: A + 5 * 60 })).toBeNull()
    expect(newsShortBlock({ ...base, nowSec: A + 5 * 60 + 1 })).toMatch(/more than five minutes ago/)
    const opened = delistingShort('x', 'ICX', 100, A + 63)
    expect(newsShortBlock({ ...base, executors: [opened] })).toMatch(/already opened its short on this coin/)
    expect(newsShortBlock({ ...base, ticker: 'SCRT', executors: [opened] })).toBeNull()
  })

  it('is paper, unlevered and kept nowhere when it stops, and its card says where it came from', () => {
    const made = delistingShort('x', 'ICX', 250, A + 63)
    expect(made).toMatchObject({ type: 'position', mode: 'paper', exchange: 'binance', symbol: 'ICXUSDT', status: 'active', keepPosition: false, createdAt: A + 63 })
    expect(made.newsRule).toEqual({ articleId: 301, ticker: 'ICX', releaseSec: A, title: item.title, category: 'DELISTING' })
    expect((made.params as PositionExecutorParams).leverage).toBeUndefined()
    expect(made.watch).toBeUndefined()
    expect(describeNewsShortOrigin(made.newsRule as NonNullable<ExecutorConfig['newsRule']>)).toBe(
      "Opened by the news reader, with nobody pressing anything, on Binance's announcement at 06:00 UTC that it will delist ICX: a short held four hours by the rule research/NEWS.md measured. Paper."
    )
    // A live executor carrying the mark is never one of the rule's.
    expect(newsShortExecutors([made, { ...made, id: 'y', mode: 'live' }]).map((executor) => executor.id)).toEqual(['x'])
  })
})

describe('the notice to someone holding the coin', () => {
  const nothing: Holdings = { live: null, paperAccount: null, heldPositions: [], executors: [] }

  it('says nothing to someone who holds none of the coins', () => {
    expect(newsHolderNotice(item, nothing)).toBeNull()
    expect(newsHolderNotice(item, { ...nothing, live: [{ asset: 'BTC', free: 1, locked: 0 }] })).toBeNull()
    expect(newsHolderNotice({ ...item, category: 'SPOT_LISTING' }, { ...nothing, live: [{ asset: 'ICX', free: 1, locked: 0 }] })).toBeNull()
  })

  it('names each place a coin is held, and says nothing was sold', () => {
    const account: PaperAccount = { balances: { USDT: 500, SCRT: 12.5 }, initialBalances: { USDT: 1000 }, createdAt: A - 86_400, ledger: [] }
    const running = delistingShort('r', 'ICX', 100, A)
    const holdings: Holdings = {
      live: [{ asset: 'ICX', free: 100, locked: 20.5 }],
      paperAccount: account,
      heldPositions: [],
      executors: [{ ...running, id: 'mine', newsRule: undefined }, running]
    }
    expect(heldPlaces('ICX', holdings)).toEqual(['120.5 ICX on Binance', 'an executor running on ICX'])
    expect(heldPlaces('SCRT', holdings)).toEqual(['12.5 SCRT in the paper account'])
    expect(heldPlaces('STORJ', holdings)).toEqual([])
    expect(newsHolderNotice(item, holdings)).toEqual({
      title: 'Binance will delist ICX, SCRT, which you hold',
      body:
        'You hold 120.5 ICX on Binance and an executor running on ICX; 12.5 SCRT in the paper account. Nothing has been sold. ' +
        'Coins Binance announced it would delist were on average 13% lower four hours later (research/NEWS.md). Announced 06:00 UTC: "Binance Will Delist ICX, SCRT, STORJ on 2026-09-03"'
    })
    // What must survive a notice cut at 400 characters comes first.
    const long = newsHolderNotice({ ...item, title: 'x'.repeat(600) }, holdings)
    expect(long?.body.slice(0, 400)).toContain('Nothing has been sold.')
  })

  it('is given only for a delisting read in this session, and not a day after it', () => {
    const at = { sessionStartSec: A - 60, nowSec: A + 60, latestSeconds: 24 * 3600 }
    expect(isFreshNews(item, at)).toBe(true)
    expect(isFreshNews({ ...item, seenAt: A - 61 }, at)).toBe(false)
    expect(isFreshNews(item, { ...at, nowSec: A + 24 * 3600 + 1 })).toBe(false)
    expect(isFreshNews({ ...item, category: null }, at)).toBe(false)
  })
})

describe('a delisting put to the models', () => {
  it('is raised only when it was released, and read, minutes ago', () => {
    expect(shouldRaiseNewsEvent(item, A + 63)).toBe(true)
    expect(shouldRaiseNewsEvent(item, A + 5 * 60)).toBe(true)
    expect(shouldRaiseNewsEvent(item, A + 5 * 60 + 1)).toBe(false)
    // Kept the first time the reader was switched on, a day after its release: history.
    expect(shouldRaiseNewsEvent({ ...item, seenAt: A + 86_400 }, A + 63)).toBe(false)
    expect(shouldRaiseNewsEvent({ ...item, category: 'FUTURES_LAUNCH' }, A + 63)).toBe(false)
    // A coin added to the Monitoring Tag is raised the same way, as an event of its own kind.
    expect(shouldRaiseNewsEvent({ ...item, category: 'MONITORING_TAG' }, A + 63)).toBe(true)
    expect(newsEventKind(item)).toBe('delisting')
    expect(newsEventKind({ ...item, category: 'MONITORING_TAG' })).toBe('monitoring_tag')
    expect(newsEventKind({ ...item, category: 'SPOT_LISTING' })).toBeNull()
  })

  it('is asked about only as a delisting, naming the pair, around its minute', () => {
    expect(newsQuestionProblem(item, 'ICXUSDT', A + 60)).toBeNull()
    expect(newsQuestionProblem({ ...item, category: 'MONITORING_TAG' }, 'ICXUSDT', A + 60)).toBeNull()
    expect(newsQuestionProblem(item, 'ICXUSDT', A - 120)).toBeNull()
    expect(newsQuestionProblem(item, 'ICXUSDT', A + 30 * 60)).toBeNull()
    expect(newsQuestionProblem(null, 'ICXUSDT', A + 60)).toBe('This app has read no such announcement.')
    expect(newsQuestionProblem({ ...item, category: 'SPOT_LISTING' }, 'ICXUSDT', A + 60)).toBe('Only a delisting or a Monitoring Tag is put to the models.')
    expect(newsQuestionProblem(item, 'ICXBTC', A + 60)).toBe('The announcement does not name ICXBTC.')
    expect(newsQuestionProblem(item, 'ICXUSDT', A - 121)).toBe('The question is not about the minutes after the announcement.')
    expect(newsQuestionProblem(item, 'ICXUSDT', A + 30 * 60 + 1)).toBe('The question is not about the minutes after the announcement.')
  })

  it('is taken up by the watch whatever band its candles read, and is otherwise held to the watch rules', () => {
    const watch = { ...DEFAULT_AI_WATCH, enabled: true, models: ['acme/a'], minBand: 'urgent' as const }
    const quiet = {
      id: `binance:ICXUSDT:${A + 60}`,
      exchange: 'binance' as const,
      symbol: 'ICXUSDT',
      baseAsset: 'ICX',
      quoteAsset: 'USDT',
      time: A + 60,
      type: 'delisting' as const,
      direction: 'down' as const,
      band: 'quiet' as const,
      score: 12,
      components: { price: 10, volume: 10, volatility: 10, pressure: 10, breakout: 10 },
      price: 0.1,
      returnsPct: { m1: 0, m5: 0, m15: 0, h1: 0, h4: 0 },
      moveSigmas: 0.2,
      volumeRatio: 1,
      rangeRatio: 1,
      live: { detectedAt: A + 63, quoteVolume24h: null, spreadPct: null, candidateScore: 12, rank: 1 },
      news: { articleId: item.id, title: item.title, releaseSec: A }
    }
    const state = { nowSec: A + 70, takenToday: new Set<string>() }
    expect(watchSkipReason(quiet, watch, state)).toBeNull()
    // The same reading with no announcement behind it is below the band.
    expect(watchSkipReason({ ...quiet, news: undefined }, watch, state)).toBe('It is below the urgent band the watch asks about.')
    // And it is still the watch's: fresh, within the day's limit, with the watch on.
    expect(watchSkipReason(quiet, watch, { ...state, nowSec: A + 60 + 181 })).toMatch(/more than 3 minutes old/)
    expect(watchSkipReason(quiet, { ...watch, enabled: false }, state)).toBe('The watch is off.')
  })

  it("is read back with the scanner's question by the pages that show what the watch asked", () => {
    expect(AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS).toEqual(['opportunity-v1', 'opportunity-news-v1', 'opportunity-tag-v1'])
    expect(questionKindOfPromptVersion('opportunity-news-v1')).toBe('news')
    expect(questionKindOfPromptVersion('opportunity-tag-v1')).toBe('news')
    expect(describeQuestionKind('news')).toBe('with the announcement')
    const row = { promptVersion: 'opportunity-news-v1' } as Parameters<typeof matchesAiCallFilter>[0]
    expect(matchesAiCallFilter({ ...row, symbol: 'ICXUSDT' }, { promptVersions: AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS })).toBe(true)
    expect(matchesAiCallFilter({ ...row, symbol: 'ICXUSDT', promptVersion: 'opportunity-v2' }, { promptVersions: AI_OPPORTUNITY_LIVE_PROMPT_VERSIONS })).toBe(false)
    // Over the bridge, a filter that is not a list matches nothing rather than matching by substring.
    expect(matchesAiCallFilter({ ...row, symbol: 'ICXUSDT' }, { promptVersions: 'opportunity-news-v1-and-more' as never })).toBe(false)
  })
})

describe('its setting', () => {
  const kind = { notifyHeld: true, paperShort: { enabled: false, stakeQuote: 100 }, askModels: true }

  it('reads a file it cannot use as off, and keeps the notice on unless told otherwise, kind by kind', () => {
    expect(healNewsConfig(null)).toEqual(DEFAULT_NEWS_CONFIG)
    expect(DEFAULT_NEWS_CONFIG).toEqual({ enabled: false, delisting: kind, monitoringTag: kind })
    expect(
      healNewsConfig({
        enabled: 'true',
        delisting: { notifyHeld: false, paperShort: { enabled: 1, stakeQuote: 333 }, askModels: false },
        monitoringTag: { paperShort: { enabled: true, stakeQuote: 250 } }
      })
    ).toEqual({
      enabled: false,
      delisting: { notifyHeld: false, paperShort: { enabled: false, stakeQuote: 100 }, askModels: false },
      monitoringTag: { ...kind, paperShort: { enabled: true, stakeQuote: 250 } }
    })
  })

  it('reads a file written before the tag was read as what a delisting does', () => {
    expect(healNewsConfig({ enabled: true, notifyHeld: false, paperShort: { enabled: true, stakeQuote: 250 }, askModels: false })).toEqual({
      enabled: true,
      delisting: { notifyHeld: false, paperShort: { enabled: true, stakeQuote: 250 }, askModels: false },
      monitoringTag: kind
    })
  })

  it('takes a change it can use, and says why it refuses one it cannot', () => {
    const on = applyNewsConfigPatch(DEFAULT_NEWS_CONFIG, { enabled: true, monitoringTag: { paperShort: { enabled: true } } }) as NewsConfig
    expect(on).toEqual({ enabled: true, delisting: kind, monitoringTag: { ...kind, paperShort: { enabled: true, stakeQuote: 100 } } })
    expect(applyNewsConfigPatch(on, { monitoringTag: { paperShort: { stakeQuote: 500 } } })).toEqual({ ...on, monitoringTag: { ...kind, paperShort: { enabled: true, stakeQuote: 500 } } })
    expect(applyNewsConfigPatch(on, { delisting: { askModels: false, notifyHeld: false } })).toEqual({ ...on, delisting: { ...kind, askModels: false, notifyHeld: false } })
    expect(applyNewsConfigPatch(on, { enabled: 'yes' as never })).toBe('The news reader is either on or off')
    expect(applyNewsConfigPatch(on, { delisting: { notifyHeld: 1 as never } })).toBe('The notice to holders is either on or off')
    expect(applyNewsConfigPatch(on, { monitoringTag: { askModels: 'no' as never } })).toBe('Putting it to the models is either on or off')
    expect(applyNewsConfigPatch(on, { delisting: { paperShort: { stakeQuote: 7 } } })).toBe('A paper short stakes 25, 50, 100, 250, 500, 1000')
    expect(applyNewsConfigPatch(on, { delisting: { paperShort: { enabled: 'on' as never } } })).toBe('The paper short is either on or off')
    expect(applyNewsConfigPatch(on, { monitoringTag: { paperShort: null as never } })).toBe('Not a setting for the paper short')
    expect(applyNewsConfigPatch(on, { monitoringTag: 5 as never })).toBe('Not a setting for what an announcement does')
    // The config it was given is not changed, nor the default.
    expect(on.monitoringTag.paperShort.stakeQuote).toBe(100)
    expect(DEFAULT_NEWS_CONFIG.monitoringTag.paperShort.enabled).toBe(false)
    expect(newsActionsFor(on, 'MONITORING_TAG')).toBe(on.monitoringTag)
    expect(newsActionsFor(on, 'DELISTING')).toBe(on.delisting)
    expect(newsActionsFor(on, 'FUTURES_LAUNCH')).toBeNull()
    expect(newsActionsFor(on, null)).toBeNull()
  })
})

/** Each short at its kind's stake, with no cap: how the rules are held here. Sizing by risk and the
 * cap on what the app's own paper trades have out (shared/paperRisk.ts) are held under their own
 * heading. */
const STAKE: PaperRiskSettings = { sizing: 'stake', riskQuote: 1, maxOutQuote: null }

interface Rig {
  deps: NewsShortDeps
  /** `risk` is settings.json's paperRisk, and `pause` its paperPause, as stored. */
  /** `correlation` is the pair's with Bitcoin (shared/paperExposure.ts): 0.3 unless said, a pair
   * that does not track it, so that only the tests of that cap meet it. */
  state: {
    executors: ExecutorConfig[]
    account: PaperAccount | null
    risk: unknown
    pause: unknown
    now: number
    candles: Candle[]
    pairs: SymbolInfo[]
    correlation: number | null | Error
  }
  notices: { title: string; body: string }[]
  settled: string[]
}

function rig(initial: Partial<Rig['state']> = {}): Rig {
  const state: Rig['state'] = {
    executors: [],
    account: null,
    risk: STAKE,
    pause: undefined,
    now: A + 63,
    candles: [],
    pairs: [pair('ICX'), pair('SCRT'), { symbol: 'STORJBTC', baseAsset: 'STORJ', quoteAsset: 'BTC' }],
    correlation: 0.3,
    ...initial
  }
  const made: Rig = { deps: undefined as unknown as NewsShortDeps, state, notices: [], settled: [] }
  let tail: Promise<unknown> = Promise.resolve()
  let ids = 0
  made.deps = {
    getSettings: async () => ({
      executors: [...state.executors],
      paperAccount: state.account,
      paperRisk: state.risk as PaperRiskSettings | undefined,
      paperPause: state.pause as PaperPauseSettings | undefined
    }),
    setExecutors: async (executors) => {
      state.executors = executors
    },
    listPairs: async () => state.pairs,
    fetchCandles: async () => state.candles,
    btcCorrelation: async () => {
      if (state.correlation instanceof Error) throw state.correlation
      return state.correlation
    },
    settle: async (target) => {
      made.settled.push(target.id)
    },
    notify: (title, body) => {
      made.notices.push({ title, body })
    },
    nowSec: () => state.now,
    newId: () => `short-${++ids}`,
    queue: <T>(work: () => Promise<T>): Promise<T> => {
      const run = tail.then(work)
      tail = run.catch(() => undefined)
      return run
    }
  }
  return made
}

const ON = { paperShort: { enabled: true, stakeQuote: 100 } }

describe('opening the shorts', () => {
  it('opens nothing while it is switched off', async () => {
    const r = rig()
    expect(await openNewsShorts(item, { paperShort: { enabled: false, stakeQuote: 100 } }, r.deps)).toEqual([])
    expect(r.state.executors).toEqual([])
  })

  it('opens one paper short on each coin with a USDT pair, and says why not on the others', async () => {
    const r = rig()
    expect(await openNewsShorts(item, ON, r.deps)).toEqual([
      'ICX: a paper short of 100 USDT was opened.',
      'SCRT: a paper short of 100 USDT was opened.',
      'STORJ: no paper short, as it has no USDT pair on Binance.'
    ])
    expect(r.state.executors.map((executor) => [executor.symbol, executor.mode, (executor.params as PositionExecutorParams).side, executor.newsRule?.ticker])).toEqual([
      ['ICXUSDT', 'paper', 'sell', 'ICX'],
      ['SCRTUSDT', 'paper', 'sell', 'SCRT']
    ])
    expect(r.notices.map((notice) => notice.title)).toEqual(['Paper short: ICXUSDT', 'Paper short: SCRTUSDT'])
    expect(r.notices[0].body).toContain('Paper: nothing real was placed.')

    // Read again -- the same announcement opens nothing more.
    expect(await openNewsShorts(item, ON, r.deps)).toEqual([
      'ICX: no paper short. The rule has already opened its short on this coin for this announcement.',
      'SCRT: no paper short. The rule has already opened its short on this coin for this announcement.',
      'STORJ: no paper short, as it has no USDT pair on Binance.'
    ])
    expect(r.state.executors).toHaveLength(2)
  })

  it('opens none it is too late for, and none the paper account cannot fund', async () => {
    const late = rig({ now: A + 6 * 60 })
    expect((await openNewsShorts(item, ON, late.deps))[0]).toMatch(/^ICX: no paper short. It was announced more than five minutes ago/)
    expect(late.state.executors).toEqual([])

    const poor = rig({ account: { balances: { USDT: 150 }, initialBalances: { USDT: 150 }, createdAt: A - 86_400, ledger: [] } })
    const lines = await openNewsShorts(item, ON, poor.deps)
    expect(lines[0]).toBe('ICX: a paper short of 100 USDT was opened.')
    expect(lines[1]).toMatch(/^SCRT: no paper short. /)
    expect(poor.state.executors).toHaveLength(1)
  })
})

describe('settling the shorts', () => {
  it('stops and settles a short once its four hours are up, once, with how it ended written on it', async () => {
    const r = rig()
    await openNewsShorts(item, ON, r.deps)
    const bars: Candle[] = []
    for (let t = A + 120; t <= A + 245 * 60; t += 60) bars.push({ time: t, open: 10, high: 10, low: 9, close: t < A + 100 * 60 ? 10 : 9, volume: 1 })
    r.state.candles = bars

    // Still inside the four hours: nothing.
    r.state.now = A + 200 * 60
    expect(await settleNewsShorts(r.deps)).toEqual([])

    r.state.now = A + 241 * 60
    expect(await settleNewsShorts(r.deps)).toEqual(['Delisting short · ICXUSDT', 'Delisting short · SCRTUSDT'])
    expect(r.settled).toEqual(['short-1', 'short-2'])
    const ended = r.state.executors[0]
    expect(ended).toMatchObject({ status: 'stopped', stoppedAt: A + 241 * 60 })
    expect(ended.newsRule?.result).toMatchObject({ exit: 'time_limit', closedAt: A + 239 * 60 })
    expect(ended.newsRule?.result?.pnlQuote).toBeGreaterThan(0)

    // Settled once.
    expect(await settleNewsShorts(r.deps)).toEqual([])
    expect(r.settled).toHaveLength(2)
  })

  it('is settled once by two passes that overlap, and not at all once someone stopped it first', async () => {
    const r = rig()
    await openNewsShorts({ ...item, tickers: ['ICX'] }, ON, r.deps)
    r.state.candles = Array.from({ length: 126 * 4 }, (_, i) => ({ time: A + 120 + i * 60, open: 10, high: 10, low: 10, close: 10, volume: 1 }))
    r.state.now = A + 241 * 60
    const [first, second] = await Promise.all([settleNewsShorts(r.deps), settleNewsShorts(r.deps)])
    expect([...first, ...second]).toEqual(['Delisting short · ICXUSDT'])
    expect(r.settled).toEqual(['short-1'])

    // Stopped by hand while its candles were being read: whoever stopped it booked it.
    const byHand = rig()
    await openNewsShorts({ ...item, tickers: ['ICX'] }, ON, byHand.deps)
    byHand.state.candles = r.state.candles
    byHand.state.now = A + 241 * 60
    const read = byHand.deps.fetchCandles
    byHand.deps.fetchCandles = async (...args) => {
      byHand.state.executors = byHand.state.executors.map((executor) => ({ ...executor, status: 'stopped' as const, stoppedAt: A + 100 * 60 }))
      return read(...args)
    }
    expect(await settleNewsShorts(byHand.deps)).toEqual([])
    expect(byHand.settled).toEqual([])
    expect(byHand.state.executors[0].newsRule?.result).toBeUndefined()
  })

  it("leaves alone every executor that is not one of the rule's shorts", async () => {
    const r = rig()
    await openNewsShorts(item, ON, r.deps)
    r.state.executors = r.state.executors.map((executor) => ({ ...executor, newsRule: undefined }))
    r.state.candles = [{ time: A + 120, open: 10, high: 10, low: 10, close: 10, volume: 1 }]
    r.state.now = A + 300 * 60
    expect(await settleNewsShorts(r.deps)).toEqual([])
  })
})

describe("the exit check's EXIT on a rule's short (shared/aiExit.ts)", () => {
  const order = (over: Partial<AiExitOrder> = {}): AiExitOrder => ({
    executorId: 'short-1',
    enteredAt: A + 120,
    model: 'openai/gpt-5-mini',
    triggers: ['opposite_move'],
    confidence: 0.7,
    reason: 'It bounced hard against the short.',
    ...over
  })
  /** Shorted at 10 in the minute after it was opened; at 10.4 from the thirty-first minute on. */
  const minutes = (): Candle[] =>
    Array.from({ length: 245 }, (_, i) => {
      const time = A + 120 + i * 60
      const price = time < A + 31 * 60 ? 10 : 10.4
      return { time, open: price, high: price, low: price, close: price, volume: 1 }
    })

  it("brings forward an open short's time limit and nothing else, once, and only on the rules' own", async () => {
    const r = rig()
    await openNewsShorts({ ...item, tickers: ['ICX'] }, ON, r.deps)
    const opened = r.state.executors[0]
    const plan = (opened.params as PositionExecutorParams).timeLimitSec
    expect(plan).toBe(239 * 60 - 120)
    r.state.now = A + 30 * 60 + 25
    expect(await exitNewsShort(order(), r.deps)).toBe(true)
    const written = r.state.executors[0]
    expect(written.params).toEqual({ ...opened.params, timeLimitSec: 31 * 60 - 120 })
    expect(written.newsRule).toEqual({
      ...opened.newsRule,
      aiExit: { at: A + 30 * 60 + 25, closeAt: A + 31 * 60, enteredAt: A + 120, planTimeLimitSec: plan, model: 'openai/gpt-5-mini', triggers: ['opposite_move'], confidence: 0.7, reason: 'It bounced hard against the short.' }
    })
    expect(written.status).toBe('active')
    expect(await exitNewsShort(order({ reason: 'Again.' }), r.deps)).toBe(false)
    // Even with the clock gone back a minute, the plan it was closed against is not written over.
    r.state.now = A + 29 * 60 + 25
    expect(await exitNewsShort(order({ reason: 'Again.' }), r.deps)).toBe(false)
    expect(r.state.executors[0].newsRule?.aiExit).toMatchObject({ reason: 'It bounced hard against the short.', planTimeLimitSec: plan })
    for (const other of [{ ...opened, mode: 'live' as const }, { ...opened, newsRule: undefined }, { ...opened, status: 'stopped' as const, stoppedAt: A + 600 }]) {
      const s = rig({ executors: [other], now: A + 30 * 60 + 25 })
      expect(await exitNewsShort(order(), s.deps)).toBe(false)
      expect(s.state.executors).toEqual([other])
    }
  })

  it("is stopped at the next minute as the check's exit, and set against its plan once the four hours are up", async () => {
    const r = rig()
    await openNewsShorts({ ...item, tickers: ['ICX'] }, ON, r.deps)
    r.state.candles = minutes()
    r.state.now = A + 30 * 60 + 25
    await exitNewsShort(order(), r.deps)
    r.state.now = A + 32 * 60 + 1
    expect(await settleNewsShorts(r.deps)).toEqual(['Delisting short · ICXUSDT'])
    const ended = r.state.executors[0]
    expect(ended.newsRule?.result).toMatchObject({ exit: 'ai_exit', closedAt: A + 31 * 60 })
    // Shorted at 10, out at 10.4.
    expect(ended.newsRule?.result?.pnlQuote).toBeLessThan(-3.5)
    expect(ended.newsRule?.aiExit?.plan).toBeUndefined()
    r.state.now = A + 241 * 60
    await settleNewsShorts(r.deps)
    expect(r.state.executors[0].newsRule?.aiExit?.plan).toEqual({
      exit: 'time_limit',
      // The short as it was opened, on the same minutes.
      pnlQuote: simulatePosition(minutes(), { ...(ended.params as PositionExecutorParams), timeLimitSec: 239 * 60 - 120 }).realizedPnl,
      closedAt: A + 239 * 60
    })
    expect(r.settled).toEqual(['short-1'])
  })

  it('writes the plan once when two passes overlap', async () => {
    const r = rig()
    await openNewsShorts({ ...item, tickers: ['ICX'] }, ON, r.deps)
    r.state.candles = minutes()
    r.state.now = A + 30 * 60 + 25
    await exitNewsShort(order(), r.deps)
    r.state.now = A + 32 * 60 + 1
    await settleNewsShorts(r.deps)
    let writes = 0
    const write = r.deps.setExecutors
    r.deps.setExecutors = async (executors) => {
      writes++
      await write(executors)
    }
    r.state.now = A + 241 * 60
    await Promise.all([settleNewsShorts(r.deps), settleNewsShorts(r.deps)])
    expect(writes).toBe(1)
    expect(r.state.executors[0].newsRule?.aiExit?.plan).toMatchObject({ exit: 'time_limit' })
  })
})

// ---------------------------------------------------------------------------------------------
// A coin added to the Monitoring Tag: the bracket research/NEWS.md measured -- short at the second
// minute after the announcement's, a stop 1.5 and a target 3 of the coin's usual fifteen-minute
// moves read from the twelve hours before it, out at the close of the sixtieth minute otherwise.

/** AVA, GNS, SCR and TOWNS: Binance's news of 4 September 2026, 08:00 UTC. */
const G = Date.parse('2026-09-04T08:00:00Z') / 1000

const tag: NewsItem = {
  id: 401,
  catalog: 49,
  title: 'Binance Will Extend the Monitoring Tag to Include AVA, GNS, SCR & TOWNS on 2026-09-04',
  releaseSec: G,
  seenAt: G + 3,
  category: 'MONITORING_TAG',
  tickers: ['AVA', 'GNS', 'SCR', 'TOWNS']
}

/** Twelve hours of minutes ending with the one before the announcement's, gently moving. */
function hoursBefore(releaseSec: number): Candle[] {
  const last = Math.floor(releaseSec / 60) * 60 - 60
  const bars: Candle[] = []
  for (let k = 719; k >= 0; k--) {
    const time = last - k * 60
    const price = 10 * (1 + 0.004 * Math.sin(time / 420))
    bars.push({ time, open: price, high: price * 1.001, low: price * 0.999, close: price, volume: 5 })
  }
  return bars
}

/** Seventy minutes from `from`, at `price` until `turnAt`, and at `after` from then on. */
function hourFrom(from: number, price: number, turnAt: number, after: number): Candle[] {
  return Array.from({ length: 70 }, (_, k) => {
    const time = from + k * 60
    const p = time < turnAt ? price : after
    return { time, open: p, high: p, low: p, close: p, volume: 1 }
  })
}

describe("a Monitoring Tag's short", () => {
  it('is made in the minute after the announcement, so that it enters at the second', () => {
    expect(tagShortWindow(G)).toEqual({ fromSec: G + 61, toSec: G + 120 })
    // Released partway into its minute: the minute is still the one it was released in.
    expect(tagShortWindow(G + 30)).toEqual({ fromSec: G + 61, toSec: G + 120 })
    const base = { item: tag, ticker: 'AVA', executors: [] as ExecutorConfig[] }
    expect(newsShortBlock({ ...base, nowSec: G + 60 })).toMatch(/too soon/)
    expect(newsShortBlock({ ...base, nowSec: G + 61 })).toBeNull()
    expect(newsShortBlock({ ...base, nowSec: G + 120 })).toBeNull()
    expect(newsShortBlock({ ...base, nowSec: G + 121 })).toMatch(/too late to enter at the second minute/)
    expect(newsShortBlock({ ...base, ticker: 'ICX', nowSec: G + 61 })).toMatch(/not a delisting or a Monitoring Tag of this coin/)
  })

  it("reads the coin's usual move from the twelve unbroken hours before the announcement", () => {
    expect(tagReadingWindow(G)).toEqual({ startSec: G - 60 - 719 * 60, endSec: G - 1 })
    const bars = hoursBefore(G)
    expect(bars[0].time).toBe(tagReadingWindow(G).startSec)
    const reading = tagReading(bars, G)
    expect(reading?.sigma15Pct).toBeGreaterThan(0)
    expect(reading?.barTime).toBe(G - 60)
    // A minute missing, or the one before the announcement not there: no reading, no short.
    expect(tagReading([...bars.slice(0, 300), ...bars.slice(301)], G)).toBeNull()
    expect(tagReading(bars.slice(0, -1), G)).toBeNull()
    // Candles that run on past it are read only up to it.
    expect(tagReading([...bars, ...hourFrom(G, 10, G, 10)], G)?.sigma15Pct).toBe(reading?.sigma15Pct)
  })

  it('sets its stop and target from that move, and is out at the close of its sixtieth minute', () => {
    const params = tagShortParams({ sigma15Pct: 2, stakeQuote: 100 })
    expect(params).toEqual({ side: 'sell', entryPrice: null, amountQuote: 100, takeProfitPct: 6, stopLossPct: 3, timeLimitSec: 59 * 60, trailingStop: null })
    // The engine reads candles from the second minute after the announcement: in at 10.
    const entry = G + 120
    expect(simulatePosition(hourFrom(entry, 10, entry + 20 * 60, 9.3), params)).toMatchObject({ exitReason: 'take_profit', enteredAt: entry })
    expect(simulatePosition(hourFrom(entry, 10, entry + 20 * 60, 9.3), params).exitPrice).toBeCloseTo(9.4, 9)
    expect(simulatePosition(hourFrom(entry, 10, entry + 20 * 60, 10.4), params)).toMatchObject({ exitReason: 'stop_loss', exitPrice: 10.4 })
    expect(simulatePosition(hourFrom(entry, 10, entry + 20 * 60, 10.1), params)).toMatchObject({ exitReason: 'time_limit', closedAt: entry + 59 * 60 })
  })

  it('opens one paper short on each coin with a USDT pair, from its own reading', async () => {
    const r = rig({ now: G + 61, candles: hoursBefore(G), pairs: [pair('AVA'), pair('GNS')] })
    expect(await openNewsShorts(tag, ON, r.deps)).toEqual([
      'AVA: a paper short of 100 USDT was opened.',
      'GNS: a paper short of 100 USDT was opened.',
      'SCR: no paper short, as it has no USDT pair on Binance.',
      'TOWNS: no paper short, as it has no USDT pair on Binance.'
    ])
    const sigma = tagReading(hoursBefore(G), G)?.sigma15Pct as number
    const [ava] = r.state.executors
    expect(ava).toMatchObject({ name: 'Monitoring Tag short · AVAUSDT', type: 'position', mode: 'paper', createdAt: G + 61, keepPosition: false })
    expect(ava.params).toEqual(tagShortParams({ sigma15Pct: sigma, stakeQuote: 100 }))
    // The pair's correlation with Bitcoin, read for the cap on one side, is written on it.
    expect(ava.newsRule).toEqual({ articleId: 401, ticker: 'AVA', releaseSec: G, title: tag.title, category: 'MONITORING_TAG', btcCorrelation: 0.3 })
    expect(r.notices[0].title).toBe('Paper short: AVAUSDT')
    expect(r.notices[0].body).toMatch(
      /^Binance added AVA to its Monitoring Tag \(announced 08:00 UTC\)\. A paper short of 100 USDT was opened by the rule: a stop \d+\.\d\d% above, a target \d+\.\d\d% below, out within the hour\. Paper: nothing real was placed\.$/
    )
    expect(describeNewsShortOrigin(ava.newsRule as NonNullable<ExecutorConfig['newsRule']>)).toBe(
      "Opened by the news reader, with nobody pressing anything, on Binance's announcement at 08:00 UTC that it adds AVA to its Monitoring Tag: a short with a stop and a target, out within the hour, by the rule research/NEWS.md measured. Paper."
    )
    // Read again -- the same announcement opens nothing more.
    expect((await openNewsShorts(tag, ON, r.deps))[0]).toBe('AVA: no paper short. The rule has already opened its short on this coin for this announcement.')
  })

  it('opens none too soon, too late, or on a coin whose usual move cannot be read', async () => {
    const soon = rig({ now: G + 59, candles: hoursBefore(G), pairs: [pair('AVA')] })
    expect((await openNewsShorts(tag, ON, soon.deps))[0]).toMatch(/^AVA: no paper short. It is too soon/)
    const late = rig({ now: G + 125, candles: hoursBefore(G), pairs: [pair('AVA')] })
    expect((await openNewsShorts(tag, ON, late.deps))[0]).toMatch(/^AVA: no paper short. It is too late/)
    const holed = rig({ now: G + 61, candles: hoursBefore(G).slice(1, -1), pairs: [pair('AVA')] })
    expect((await openNewsShorts(tag, ON, holed.deps))[0]).toBe('AVA: no paper short, as its usual moves could not be read from its candles before the announcement.')
    const unread = rig({ now: G + 61, pairs: [pair('AVA')] })
    unread.deps.fetchCandles = async () => {
      throw new Error('klines request failed: 503')
    }
    expect((await openNewsShorts(tag, ON, unread.deps))[0]).toMatch(/usual moves could not be read/)
    for (const rigged of [soon, late, holed, unread]) expect(rigged.state.executors).toEqual([])
  })

  it('is settled when its target is reached, with how it ended written on it', async () => {
    const r = rig({ now: G + 61, candles: hoursBefore(G), pairs: [pair('AVA')] })
    await openNewsShorts({ ...tag, tickers: ['AVA'] }, ON, r.deps)
    const target = 10 * (1 - ((r.state.executors[0].params as PositionExecutorParams).takeProfitPct as number) / 100)
    r.state.candles = hourFrom(G + 120, 10, G + 120 + 10 * 60, target * 0.99)
    r.state.now = G + 120 + 12 * 60
    expect(await settleNewsShorts(r.deps)).toEqual(['Monitoring Tag short · AVAUSDT'])
    expect(r.state.executors[0].newsRule?.result).toMatchObject({ exit: 'take_profit', closedAt: G + 120 + 10 * 60 })
    expect(r.state.executors[0].newsRule?.result?.pnlQuote).toBeGreaterThan(0)
  })

  it('tells someone holding a tagged coin, and says nothing was sold', () => {
    const holdings: Holdings = {
      live: null,
      paperAccount: { balances: { USDT: 500, AVA: 40 }, initialBalances: { USDT: 1000 }, createdAt: G - 86_400, ledger: [] },
      heldPositions: [],
      executors: []
    }
    expect(newsHolderNotice(tag, holdings)).toEqual({
      title: "Binance's Monitoring Tag now includes AVA, which you hold",
      body:
        'You hold 40 AVA in the paper account. Nothing has been sold. Coins Binance added to the tag were on average 12% lower a day later, and 84 of 97 were later delisted (research/NEWS.md). ' +
        `Announced 08:00 UTC: "${tag.title}"`
    })
    expect(newsHolderNotice(tag, { ...holdings, paperAccount: null })).toBeNull()
    expect(isFreshNews(tag, { sessionStartSec: G - 60, nowSec: G + 60, latestSeconds: 24 * 3600 })).toBe(true)
  })

  it('reads a mark with no kind on it, made before the tag was read, as a delisting', () => {
    const mark = { articleId: 301, ticker: 'ICX', releaseSec: A, title: item.title }
    expect(describeNewsShortOrigin(mark)).toMatch(/that it will delist ICX: a short held four hours/)
  })
})

describe('sized by risk, and held to what the app has out (shared/paperRisk.ts)', () => {
  const RISK: PaperRiskSettings = { sizing: 'risk', riskQuote: 1, maxOutQuote: null }
  const amountOf = (made: ExecutorConfig): number => (made.params as PositionExecutorParams).amountQuote

  it("sizes a tag's short by what its stop would lose, and leaves a delisting's, which has none, at its stake", async () => {
    const big = { paperShort: { enabled: true, stakeQuote: 1000 } }
    const tagged = rig({ now: G + 61, candles: hoursBefore(G), pairs: [pair('AVA')], risk: RISK })
    const lines = await openNewsShorts({ ...tag, tickers: ['AVA'] }, big, tagged.deps)
    const sigma = tagReading(hoursBefore(G), G)?.sigma15Pct as number
    const sized = paperStake({ risk: RISK, stakeQuote: 1000, stopPct: tagShortParams({ sigma15Pct: sigma, stakeQuote: 1000 }).stopLossPct })
    // The coin's usual move puts the stop near, so risking 1 there stakes a few hundred: under 1,000.
    expect(sized).toBeGreaterThan(5)
    expect(sized).toBeLessThan(1000)
    expect(lines).toEqual([`AVA: a paper short of ${sized} USDT was opened.`])
    expect(tagged.state.executors[0].params).toEqual({ ...tagShortParams({ sigma15Pct: sigma, stakeQuote: 1000 }), amountQuote: sized })
    expect(tagged.notices[0].body).toContain(`A paper short of ${sized} USDT was opened by the rule`)

    const delisted = rig({ risk: RISK })
    expect(await openNewsShorts({ ...item, tickers: ['ICX'] }, big, delisted.deps)).toEqual(['ICX: a paper short of 1000 USDT was opened.'])
    expect(amountOf(delisted.state.executors[0])).toBe(1000)
  })

  it("opens no short past what the app's own paper trades may have out together", async () => {
    const watched: ExecutorConfig = {
      ...newsShortExecutor({ id: 'w-1', item, ticker: 'ICX', pair: pair('ICX'), nowSec: A, params: tagShortParams({ sigma15Pct: 1, stakeQuote: 100 }) }),
      symbol: 'BTCUSDT',
      newsRule: undefined,
      watch: { eventId: 'binance:BTCUSDT:1', eventTime: 1, model: 'openai/gpt-5-mini', confidence: 0.8 }
    }
    const r = rig({ risk: { ...RISK, maxOutQuote: 1000 }, executors: [watched] })
    // 100 out in a trade of the watch's: the first short of 500 fits, the second would make 1,100.
    expect(await openNewsShorts(item, { paperShort: { enabled: true, stakeQuote: 500 } }, r.deps)).toEqual([
      'ICX: a paper short of 500 USDT was opened.',
      "SCRT: no paper short. The watch's and the news rules' open paper trades stake 600 USDT together, and 500 more would take them past the 1,000 set on Risk & Safety.",
      'STORJ: no paper short, as it has no USDT pair on Binance.'
    ])
    expect(r.state.executors.map((executor) => executor.symbol)).toEqual(['BTCUSDT', 'ICXUSDT'])
  })
})

describe('held to what the app has out on one side on coins that move with Bitcoin (shared/paperExposure.ts)', () => {
  it('opens no short on a coin that tracks Bitcoin past the cap, and opens one that does not', async () => {
    const CAPPED: PaperRiskSettings = { sizing: 'stake', riskQuote: 1, maxOutQuote: 1000 }
    // A short of the rules' own already open, of 100, opened before correlations were written down.
    const open = delistingShort('n-1', 'AAA', 100, A - 60)
    const tracking = rig({ risk: CAPPED, executors: [open], correlation: 0.8 })
    expect(await openNewsShorts({ ...item, tickers: ['ICX'] }, ON, tracking.deps)).toEqual([
      "ICX: no paper short. Its pair moves with Bitcoin (its hourly moves over 7 days correlate at 0.80), and the app's open paper SELLs on such pairs stake 100 USDT together: 100 more would take them past 150, 15% of the money-out cap."
    ])
    expect(tracking.state.executors).toEqual([open])
    const own = rig({ risk: CAPPED, executors: [open], correlation: 0.2 })
    expect(await openNewsShorts({ ...item, tickers: ['ICX'] }, ON, own.deps)).toEqual(['ICX: a paper short of 100 USDT was opened.'])
    expect(own.state.executors[1].newsRule?.btcCorrelation).toBe(0.2)
  })
})

describe("paused after a losing run of the rules' own (shared/paperPause.ts)", () => {
  /** A tag's short on another announcement, stopped out at `closedAt` having made `r` R. */
  function closedTag(id: string, ticker: string, closedAt: number, r: number): ExecutorConfig {
    const params = tagShortParams({ sigma15Pct: 1, stakeQuote: 100 })
    const made = newsShortExecutor({ id, item: { ...item, id: 200, category: 'MONITORING_TAG', tickers: [ticker] }, ticker, pair: pair(ticker), nowSec: closedAt - 3600, params })
    const mark = made.newsRule as NonNullable<ExecutorConfig['newsRule']>
    return { ...made, status: 'stopped', stoppedAt: closedAt, newsRule: { ...mark, result: { exit: 'stop_loss', pnlQuote: r * (riskedAtStop(params) as number), closedAt } } }
  }
  const lost = [closedTag('t-1', 'AAA', A - 3 * 3600, -2), closedTag('t-2', 'BBB', A - 2 * 3600, -2), closedTag('t-3', 'CCC', A - 3600, -2)]
  const PAUSED = "The news rules' last 3 closed paper shorts with a stop lost 6.00 R together, so they open none until they are resumed on Risk & Safety."

  it('opens no short once their shorts have lost the run, by the defaults with nothing stored, and says why', async () => {
    const r = rig({ executors: lost })
    expect(await openNewsShorts(item, ON, r.deps)).toEqual([`ICX: no paper short. ${PAUSED}`, `SCRT: no paper short. ${PAUSED}`, 'STORJ: no paper short, as it has no USDT pair on Binance.'])
    expect(r.state.executors).toEqual(lost)
    expect(r.notices).toEqual([])
  })

  it('holds while it is written down, and opens again once resumed or switched off', async () => {
    const paused: PaperPauseSettings = { ...DEFAULT_PAPER_PAUSE, news: { countFrom: null, paused: { at: A - 1800, r: -6, trades: 3 } } }
    // Written down, it holds with nothing lost on file.
    const held = rig({ pause: paused })
    expect((await openNewsShorts(item, ON, held.deps))[0]).toBe(
      "ICX: no paper short. The news rules' last 3 closed paper shorts with a stop had lost 6.00 R together by 05:30 UTC on 20 Aug, so they open none until they are resumed on Risk & Safety."
    )
    expect(held.state.executors).toEqual([])
    const resumed = rig({ executors: lost, pause: resumePaperPause(paused, 'news', A - 60) })
    expect(await openNewsShorts(item, ON, resumed.deps)).toEqual([
      'ICX: a paper short of 100 USDT was opened.',
      'SCRT: a paper short of 100 USDT was opened.',
      'STORJ: no paper short, as it has no USDT pair on Binance.'
    ])
    const off = rig({ executors: lost, pause: { ...paused, lossR: null } })
    expect((await openNewsShorts(item, ON, off.deps))[0]).toBe('ICX: a paper short of 100 USDT was opened.')
  })

  it("is not paused by the watch's losing run", async () => {
    const watched = lost.map(
      (executor, k): ExecutorConfig => ({
        ...executor,
        id: `w-${k}`,
        newsRule: undefined,
        watch: { eventId: `binance:X:${k}`, eventTime: A - 7200, model: 'openai/gpt-5-mini', confidence: 0.8, result: executor.newsRule?.result }
      })
    )
    const r = rig({ executors: watched })
    expect((await openNewsShorts(item, ON, r.deps))[0]).toBe('ICX: a paper short of 100 USDT was opened.')
  })
})
