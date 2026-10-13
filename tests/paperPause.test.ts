import { describe, expect, it } from 'vitest'
import type { ExecutorConfig, PaperPauseSettings, PositionExecutorParams } from '../shared/ipc'
import {
  DEFAULT_PAPER_PAUSE,
  PAPER_PAUSE_LOSS_CHOICES,
  PAPER_PAUSE_TRADE_CHOICES,
  describePaperPause,
  describePaperPauseStanding,
  healPaperPause,
  paperPauseBlock,
  paperPauseProblem,
  paperRun,
  planPaperPause,
  resumePaperPause,
  savePaperPause
} from '../shared/paperPause'
import { riskedAtStop } from '../shared/paperRisk'

// shared/paperPause.ts: a losing run in R pauses the watch's paper trades, or the news rules',
// until they are resumed on Risk & Safety. src/risk/PaperPauseScheduler.tsx writes the pause down
// and says so; the two writers refuse by it (tests/aiWatchPaper.test.ts, tests/newsActions.test.ts);
// tests/aiNoLivePath.test.ts holds the scheduler to writing the pause and nothing else.

const D = Date.parse('2026-10-05T00:00:00Z') / 1000
const H = 3600

const params = (amountQuote: number, stopLossPct: number | null, side: 'buy' | 'sell' = 'buy'): PositionExecutorParams => ({
  side,
  entryPrice: null,
  amountQuote,
  takeProfitPct: stopLossPct === null ? null : stopLossPct * 2,
  stopLossPct,
  timeLimitSec: 3600,
  trailingStop: null
})

function position(id: string, overrides: Partial<ExecutorConfig> = {}): ExecutorConfig {
  return {
    id,
    name: id,
    type: 'position',
    exchange: 'binance',
    symbol: 'SOLUSDT',
    baseAsset: 'SOL',
    quoteAsset: 'USDT',
    createdAt: D,
    status: 'stopped',
    stoppedAt: null,
    keepPosition: false,
    mode: 'paper',
    liveOrder: null,
    pendingLiveOrderIds: [],
    liveWatcherId: null,
    liveWatcherError: null,
    liveExitResult: null,
    liveDcaBasePrice: null,
    liveTwapRunId: null,
    liveTwapResult: null,
    params: params(100, 1.5),
    ...overrides
  }
}

type Exit = NonNullable<NonNullable<ExecutorConfig['watch']>['result']>['exit']

/** What one of the watch's risks at its stop: 100 staked, the stop 1.5% away, a round trip's fees. */
const RISKED = riskedAtStop({ amountQuote: 100, stopLossPct: 1.5 }) as number

/** One of the watch's, closed at `closedAt` having made `pnlQuote`. */
function watchedQuote(id: string, closedAt: number, pnlQuote: number, exit: Exit = pnlQuote < 0 ? 'stop_loss' : 'take_profit'): ExecutorConfig {
  return position(id, {
    createdAt: closedAt - H,
    watch: { eventId: `binance:SOLUSDT:${id}`, eventTime: closedAt - H, model: 'openai/gpt-5-mini', confidence: 0.8, result: { exit, pnlQuote, closedAt } }
  })
}

/** One of the watch's, closed at `closedAt` having made `r` R. */
const watched = (id: string, closedAt: number, r: number, exit?: Exit): ExecutorConfig => watchedQuote(id, closedAt, r * RISKED, exit)

/** One of the news rules': a tag's short of 50 with its stop 2% away, having made `r` R; or, with
 * `r` null, a delisting's, which has no stop, having lost 40. */
function shorted(id: string, closedAt: number, r: number | null): ExecutorConfig {
  const stop = r === null ? null : 2
  const risked = riskedAtStop({ amountQuote: 50, stopLossPct: stop })
  return position(id, {
    params: params(50, stop, 'sell'),
    newsRule: {
      articleId: 7,
      ticker: 'SOL',
      releaseSec: closedAt - H,
      title: 't',
      category: r === null ? 'DELISTING' : 'MONITORING_TAG',
      result: { exit: r === null ? 'time_limit' : r < 0 ? 'stop_loss' : 'take_profit', pnlQuote: r === null ? -40 : r * (risked as number), closedAt }
    }
  })
}

/** `n` of the watch's stopped out at 1 R each, an hour apart from `from`. */
const losses = (n: number, from = D, prefix = 'loss'): ExecutorConfig[] => Array.from({ length: n }, (_, k) => watched(`${prefix}-${k}`, from + k * H, -1))

const ON: PaperPauseSettings = DEFAULT_PAPER_PAUSE
const block = (executors: ExecutorConfig[], setting: PaperPauseSettings = ON, source: 'watch' | 'news' = 'watch'): string | null =>
  paperPauseBlock({ setting, executors, source })

describe('the setting', () => {
  it('pauses after 5 R lost over the last 20 until it is changed, and is healed rather than obeyed', () => {
    const none = { countFrom: null, paused: null }
    expect(DEFAULT_PAPER_PAUSE).toEqual({ lossR: 5, trades: 20, watch: none, news: none, forecast: none })
    expect(healPaperPause(undefined)).toEqual(DEFAULT_PAPER_PAUSE)
    expect(healPaperPause('5 R')).toEqual(DEFAULT_PAPER_PAUSE)
    for (const lossR of PAPER_PAUSE_LOSS_CHOICES) for (const trades of PAPER_PAUSE_TRADE_CHOICES) expect(healPaperPause({ lossR, trades })).toMatchObject({ lossR, trades })
    // Never is a choice of its own; a loss or a run that is not one of the choices takes its default.
    expect(healPaperPause({ lossR: null, trades: 50 })).toMatchObject({ lossR: null, trades: 50 })
    expect(healPaperPause({ lossR: 4, trades: 30 })).toMatchObject({ lossR: 5, trades: 20 })
    expect(healPaperPause({ lossR: '3', trades: '10' })).toMatchObject({ lossR: 5, trades: 20 })
  })

  it('keeps each side\'s pause as written, and drops one it cannot read', () => {
    const paused = { at: D + H, r: -5.2, trades: 9 }
    expect(healPaperPause({ watch: { countFrom: D, paused }, news: { countFrom: null, paused: null } })).toMatchObject({
      watch: { countFrom: D, paused },
      news: { countFrom: null, paused: null }
    })
    for (const unreadable of [{ at: 'today', r: -5, trades: 9 }, { at: D, r: Number.NaN, trades: 9 }, { at: D, r: -5, trades: 0 }, { at: D, r: -5, trades: 2.5 }, 'paused']) {
      expect(healPaperPause({ watch: { countFrom: D, paused: unreadable } }).watch).toEqual({ countFrom: D, paused: null })
    }
    expect(healPaperPause({ watch: { countFrom: 'yesterday' } }).watch).toEqual({ countFrom: null, paused: null })
  })

  it('says why a setting cannot be saved', () => {
    expect(paperPauseProblem({ lossR: 5, trades: 20 })).toBeNull()
    expect(paperPauseProblem({ lossR: null, trades: 20 })).toBeNull()
    expect(paperPauseProblem({ lossR: 4, trades: 20 })).toBe('A losing run of 3, 5, 8, 10 R pauses them, or none does')
    expect(paperPauseProblem({ lossR: 5, trades: 15 })).toBe('The run is their last 10, 20, 50 closed trades')
  })

  it('says itself in the words the watch\'s other limits use', () => {
    expect(describePaperPause(ON)).toBe('Once the last 20 of them to close have lost 5 R together, none is opened until they are resumed on Risk & Safety.')
    expect(describePaperPause({ lossR: null, trades: 20 })).toBe('No losing run pauses them.')
  })
})

describe('the run', () => {
  it('is the last trades to close of those that entered and had a stop, added up in R, and the side\'s own', () => {
    const executors = [
      ...losses(3),
      watched('won', D + 3 * H, 2),
      // Never entered, or dropped before entering: made nothing, not counted.
      watched('unfilled', D + 4 * H, 0, 'entry_expired'),
      watched('dropped', D + 5 * H, 0, 'btc_moved'),
      // Stopped by hand: no result. Still open: none yet.
      { ...watched('by hand', D + 6 * H, -1), watch: { eventId: 'binance:SOLUSDT:hand', eventTime: D, model: 'm', confidence: 0.8 } },
      { ...watched('open', D + 7 * H, -1), status: 'active' as const },
      // Not the watch's: a paper position made by hand, a real one carrying the watch's mark, and the news rules'.
      position('mine', { params: params(100, 1.5) }),
      { ...watched('real', D + 8 * H, -3), mode: 'live' as const },
      shorted('tag', D + 9 * H, -1),
      shorted('delisting', D + 10 * H, null)
    ]
    expect(paperRun(executors, 'watch', ON)).toEqual({ trades: 4, r: -1 })
    // The news rules' run: the tag's short, and not the delisting's, which has no stop.
    expect(paperRun(executors, 'news', ON)).toEqual({ trades: 1, r: -1 })
    // Over the last 3 to close: the win and the two losses before it.
    expect(paperRun(executors, 'watch', { ...ON, trades: 3 })).toEqual({ trades: 3, r: 0 })
  })

  it('reads them in the order they closed, not the order they are on file', () => {
    const inOrder = [...losses(5), watched('won', D + 6 * H, 3)]
    const shuffled = [inOrder[5], inOrder[2], inOrder[0], inOrder[4], inOrder[1], inOrder[3]]
    for (const executors of [inOrder, shuffled]) {
      expect(paperRun(executors, 'watch', { ...ON, trades: 10 })).toEqual({ trades: 6, r: -2 })
      // The last 3 to close are the last two losses and the win, wherever they are on file.
      expect(paperRun(executors, 'watch', { ...ON, trades: 3 })).toEqual({ trades: 3, r: 1 })
    }
  })

  it('counts only what closed after it was last resumed', () => {
    const resumed = { ...ON, watch: { countFrom: D + 1 * H, paused: null } }
    // Closed at D, D+1h, D+2h and D+3h: the first two closed at or before the resume.
    expect(paperRun(losses(4), 'watch', resumed)).toEqual({ trades: 2, r: -2 })
  })
})

describe('the pause', () => {
  it('refuses once the run has lost the loss, and not a hair before', () => {
    expect(block(losses(4))).toBeNull()
    expect(block(losses(5))).toBe("The watch's last 5 closed paper trades lost 5.00 R together, so it opens none until they are resumed on Risk & Safety.")
    // Five stop-outs booked at -1.7 each are -4.999999999999999 R in floating point: that is five.
    const booked = Array.from({ length: 5 }, (_, k) => watchedQuote(`booked-${k}`, D + k * H, -1.7))
    expect(paperRun(booked, 'watch', ON).r).toBeGreaterThan(-5)
    expect(block(booked)).not.toBeNull()
    // 4.99 R lost is short of it.
    expect(block([...losses(4), watched('nearly', D + 5 * H, -0.99)])).toBeNull()
    // A loss a single trade's gap took past the stop counts as much as it lost.
    expect(block([watched('gapped', D, -5.5)])).toBe("The watch's last closed paper trade lost 5.50 R, so it opens none until they are resumed on Risk & Safety.")
  })

  it('looks at the last trades only: losses the window has moved past do not count', () => {
    const level = Array.from({ length: 20 }, (_, k) => watched(`level-${k}`, D + (10 + k) * H, 0, 'time_limit'))
    expect(block([...losses(5), ...level])).toBeNull()
    expect(block([...losses(5), ...level], { ...ON, trades: 50 })).not.toBeNull()
  })

  it('is as tight as it is set, and never when it is off', () => {
    expect(block(losses(3), { ...ON, lossR: 3 })).not.toBeNull()
    expect(block(losses(5), { ...ON, lossR: 8 })).toBeNull()
    expect(block(losses(20), { ...ON, lossR: null })).toBeNull()
  })

  it("judges each side on its own record", () => {
    const executors = [...losses(5), shorted('tag-1', D + H, 1)]
    expect(block(executors, ON, 'watch')).not.toBeNull()
    expect(block(executors, ON, 'news')).toBeNull()
    // Three tags' shorts stopped out past their stops: the news rules pause, and the watch does not.
    const shorts = [shorted('tag-1', D, -2), shorted('tag-2', D + H, -2), shorted('tag-3', D + 2 * H, -2), shorted('delisting', D + 3 * H, null), watched('won', D, 1)]
    expect(block(shorts, ON, 'news')).toBe(
      "The news rules' last 3 closed paper shorts with a stop lost 6.00 R together, so they open none until they are resumed on Risk & Safety."
    )
    expect(block(shorts, ON, 'watch')).toBeNull()
  })

  it('is written down once, with one notice, and holds whatever closes after it until it is resumed', () => {
    const run = losses(5)
    const plan = planPaperPause({ setting: ON, executors: run, nowSec: D + 6 * H })
    expect(plan?.setting.watch).toEqual({ countFrom: null, paused: { at: D + 6 * H, r: expect.closeTo(-5, 9), trades: 5 } })
    expect(plan?.setting.news).toEqual(ON.news)
    expect(plan?.notices).toEqual([
      {
        title: "The watch's paper trades are paused",
        body: "The watch's last 5 closed paper trades lost 5.00 R together: Risk & Safety pauses them at 5 R. It opens none until they are resumed there, and any still open run to their end. Nothing real was placed or closed."
      }
    ])
    const paused = plan?.setting as PaperPauseSettings
    // A second look at the same record neither writes nor tells it again.
    expect(planPaperPause({ setting: paused, executors: run, nowSec: D + 7 * H })).toBeNull()
    // Trades still open when it paused end ahead: the run read now is +1 R, and it holds anyway.
    const after = [...run, watched('won-1', D + 7 * H, 3), watched('won-2', D + 8 * H, 3)]
    expect(paperRun(after, 'watch', paused).r).toBeCloseTo(1, 9)
    expect(block(after, paused)).toBe(
      "The watch's last 5 closed paper trades had lost 5.00 R together by 06:00 UTC on 5 Oct, so it opens none until they are resumed on Risk & Safety."
    )
    // A second look neither writes nor tells it again.
    expect(planPaperPause({ setting: paused, executors: after, nowSec: D + 9 * H })).toBeNull()

    // Resumed: what closed before is not held against it, and a new run pauses it again.
    const resumed = resumePaperPause(paused, 'watch', D + 10 * H)
    expect(resumed.watch).toEqual({ countFrom: D + 10 * H, paused: null })
    expect(block(after, resumed)).toBeNull()
    expect(planPaperPause({ setting: resumed, executors: after, nowSec: D + 11 * H })).toBeNull()
    const again = [...after, ...losses(5, D + 12 * H, 'later')]
    expect(planPaperPause({ setting: resumed, executors: again, nowSec: D + 18 * H })?.setting.watch.paused).toMatchObject({ at: D + 18 * H, trades: 5 })
  })

  it('pauses both sides in one look when both have lost it, and nothing when it is off', () => {
    const both = [...losses(5), shorted('tag-1', D, -3), shorted('tag-2', D + H, -3)]
    const plan = planPaperPause({ setting: ON, executors: both, nowSec: D + 6 * H })
    expect(plan?.notices.map((notice) => notice.title)).toEqual(["The watch's paper trades are paused", "The news rules' paper shorts are paused"])
    expect(plan?.notices[1].body).toBe(
      "The news rules' last 2 closed paper shorts with a stop lost 6.00 R together: Risk & Safety pauses them at 5 R. They open none until they are resumed there, and any still open run to their end. Nothing real was placed or closed."
    )
    expect(plan?.setting.watch.paused).not.toBeNull()
    expect(plan?.setting.news.paused).not.toBeNull()
    // Off: nothing is written down, and a pause written earlier refuses nothing.
    const off = { ...(plan?.setting as PaperPauseSettings), lossR: null }
    expect(planPaperPause({ setting: off, executors: both, nowSec: D + 7 * H })).toBeNull()
    expect(block(both, off)).toBeNull()
  })

  it('is saved as chosen, keeping each side\'s pause, and switched off lifts it', () => {
    const stored: PaperPauseSettings = { ...ON, watch: { countFrom: D, paused: { at: D + H, r: -5, trades: 5 } } }
    expect(savePaperPause(stored, { lossR: 8, trades: 50 })).toEqual({ ...stored, lossR: 8, trades: 50 })
    expect(savePaperPause(stored, { lossR: null, trades: 20 })).toEqual({ lossR: null, trades: 20, watch: { countFrom: D, paused: null }, news: ON.news, forecast: ON.forecast })
  })
})

describe('where each side stands, for Risk & Safety', () => {
  it('says whether it is paused and since when, or what its run adds up to', () => {
    const stand = (executors: ExecutorConfig[], setting: PaperPauseSettings = ON, source: 'watch' | 'news' = 'watch') =>
      describePaperPauseStanding({ setting, executors, source })
    expect(stand([])).toEqual({ paused: false, text: 'The watch has closed no paper trade yet.' })
    expect(stand([], ON, 'news')).toEqual({ paused: false, text: 'The news rules have closed no paper short with a stop yet.' })
    expect(stand([watched('lost', D, -1)])).toEqual({ paused: false, text: "The watch's last closed paper trade made -1.00 R." })
    expect(stand([...losses(2), watched('won', D + 3 * H, 0.5)])).toEqual({ paused: false, text: "The watch's last 3 closed paper trades add up to -1.50 R." })
    expect(stand(losses(5))).toEqual({ paused: true, text: "The watch is paused: its last 5 closed paper trades have lost 5.00 R together." })
    const paused: PaperPauseSettings = { ...ON, news: { countFrom: null, paused: { at: D + 14 * H + 20 * 60, r: -6, trades: 3 } } }
    expect(stand([], paused, 'news')).toEqual({
      paused: true,
      text: "The news rules have been paused since 14:20 UTC on 5 Oct: their last 3 closed paper shorts with a stop had lost 6.00 R together."
    })
    const resumed = resumePaperPause(ON, 'watch', D + 2 * H + 30 * 60)
    expect(stand(losses(4), resumed)).toEqual({ paused: false, text: "The watch's last closed paper trade since it was resumed at 02:30 UTC on 5 Oct made -1.00 R." })
    expect(stand([], resumePaperPause(ON, 'news', D), 'news')).toEqual({
      paused: false,
      text: 'The news rules have closed no paper short with a stop since they were resumed at 00:00 UTC on 5 Oct.'
    })
    // Off, a run is still told, and nothing is paused.
    expect(stand(losses(5), { ...ON, lossR: null })).toEqual({ paused: false, text: "The watch's last 5 closed paper trades add up to -5.00 R." })
  })
})
