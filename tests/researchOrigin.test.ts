import { describe, expect, it } from 'vitest'
import type { ExecutorConfig } from '../shared/ipc'
import { originOf, paperOrderEvents } from '../shared/research'

// WHERE A PAPER TRADE CAME FROM, IN THE RESEARCH FOLDER (shared/research.ts; V8 Stages 8 and 9): a follow's, a clone's,
// the news book's and the baseline's trades are named as theirs, and a book's trade is logged as closed with its book's
// result.

const base = { id: 'x', type: 'position', mode: 'paper', exchange: 'binance', symbol: 'ETHUSDT', createdAt: 100, status: 'active', params: {} } as unknown as ExecutorConfig

describe("a trade's origin", () => {
  it("is a follow's, a clone's, the news book's, the baseline's, or a person's own", () => {
    expect(originOf({ ...base, follow: {} as never })).toBe('follow')
    expect(originOf({ ...base, clone: {} as never })).toBe('clone')
    expect(originOf({ ...base, newsBook: {} as never })).toBe('news')
    expect(originOf({ ...base, baseline: {} as never })).toBe('baseline')
    expect(originOf(base)).toBe('person')
  })

  it("is logged at opening with the baseline's stamp", () => {
    const stamp = { symbol: 'ETHUSDT', signalBarSec: 0, entryPx: 2000, qty: 0.625, stakeQuote: 1250, feesQuote: 1.25, openedAtMs: 100_000, stopPx: 1500, closeReason: null, exitPx: null }
    const opened = { ...base, baseline: stamp, book: { id: 'baseline', startedAt: 50, ledger: 'baseline' } } as ExecutorConfig
    const events = paperOrderEvents([], [opened], 300)
    expect(events.map((event) => [event.kind, event.origin])).toEqual([['opened', 'baseline']])
    expect(events[0].mark).toEqual(stamp)
  })

  it("is logged as closed with its book's result", () => {
    const result = { netQuote: 5, netPct: 0.5, feesQuote: 1, fundingQuote: -0.1, closedAt: 200 }
    const open = { ...base, follow: { traderKey: 'k' } as never, book: { id: 'copy', startedAt: 50, ledger: 'follow' } } as ExecutorConfig
    const closed = { ...open, status: 'stopped', stoppedAt: 200, book: { ...open.book!, result } } as ExecutorConfig
    const events = paperOrderEvents([open], [closed], 300)
    expect(events.map((event) => [event.kind, event.origin, event.at])).toEqual([['closed', 'follow', 200]])
    expect(events[0].result).toEqual(result)
  })
})
