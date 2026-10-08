import { describe, expect, it } from 'vitest'
import type { CredentialStatus, ExecutorConfig, LiveTradingStatus, PaperAccount } from '../shared/ipc'
import { livePathSteps, livePathSummary, madeFromCall, type LivePathInput } from '../shared/livePath'

// The path to live (the second V3 document, §56), read from what is on file: each step's state and
// the words beside it. Nothing here opens or arms anything.

const T = Date.parse('2026-10-08T09:00:00Z') / 1000

const key = (over: Partial<CredentialStatus> = {}): CredentialStatus => ({ exchange: 'binance', configured: true, addedAt: T - 86_400, lastTestedAt: T - 3600, lastTestOk: true, ...over })
const status = (over: Partial<LiveTradingStatus> = {}): LiveTradingStatus =>
  ({ sessionArmed: false, killSwitchEngaged: false, maxOrderQuote: 10, hardMaxOrderQuote: 25, dailyCapQuote: 50, dailyUsedQuote: 0, dailyLossLimitQuote: 15, realizedPnlToday: 0, observedFeeRate: null, allocationQuote: null, allocationCommittedQuote: 0, riskPct: 0.25, ...over }) as LiveTradingStatus
const account = (usdt: number): PaperAccount => ({ balances: { USDT: usdt }, initialBalances: { USDT: usdt }, createdAt: T, ledger: [] }) as unknown as PaperAccount
const executor = (over: Record<string, unknown>): ExecutorConfig => ({ type: 'position', mode: 'paper', name: 'Grid', params: { side: 'buy' }, ...over }) as unknown as ExecutorConfig

const all = (over: Partial<LivePathInput> = {}): LivePathInput => ({
  binance: key(),
  paperAccount: account(1000),
  watchPaperOn: true,
  executors: [executor({ name: 'AI call SOLUSDT' })],
  hour: { passed: true, fromSec: T - 3600, toSec: T },
  twelve: { passed: true, fromSec: T - 43_200, toSec: T },
  status: status({ sessionArmed: true }),
  ...over
})

const states = (input: LivePathInput): string[] => livePathSteps(input).map((step) => `${step.id}:${step.state}`)

describe('the path to live', () => {
  it('is all done when every step is', () => {
    const steps = livePathSteps(all())
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'done', 'done', 'done', 'done', 'done'])
    expect(livePathSummary(steps)).toBe('Every step is done: 7 of 7.')
    expect(steps[5].detail).toBe("One position was made from a call's filled-in form (0 of them live).")
  })

  it('is not known until read, and says what is next', () => {
    const unread: LivePathInput = { binance: undefined, paperAccount: undefined, watchPaperOn: undefined, executors: undefined, hour: undefined, twelve: undefined, status: undefined }
    const steps = livePathSteps(unread)
    expect(steps.every((step) => step.state === 'not known')).toBe(true)
    expect(livePathSummary(steps)).toBe('0 of 7 done. Next: connect binance (not read yet).')
    expect(steps[3].detail).toContain('Check the test runs')
  })

  it('reads the key: none, untested, failed, or tested', () => {
    expect(states(all({ binance: null })).slice(0, 2)).toEqual(['key:not yet', 'verified:not yet'])
    expect(states(all({ binance: key({ configured: false }) })).slice(0, 2)).toEqual(['key:not yet', 'verified:not yet'])
    expect(states(all({ binance: key({ lastTestOk: null, lastTestedAt: null }) })).slice(0, 2)).toEqual(['key:done', 'verified:not yet'])
    expect(states(all({ binance: key({ lastTestOk: false }) })).slice(0, 2)).toEqual(['key:done', 'verified:not yet'])
    expect(livePathSteps(all())[1].detail).toBe('Tested 2026-10-08: it works.')
    expect(livePathSummary(livePathSteps(all({ binance: key({ lastTestOk: false }) })))).toBe('6 of 7 done. Next: verify the key.')
  })

  it('counts paper trading from a funded account or the watch, and the test runs from their reports', () => {
    expect(states(all({ paperAccount: null, watchPaperOn: false }))[2]).toBe('paper:not yet')
    expect(states(all({ paperAccount: account(0), watchPaperOn: false }))[2]).toBe('paper:not yet')
    expect(states(all({ paperAccount: null, watchPaperOn: true }))[2]).toBe('paper:done')
    expect(livePathSteps(all({ paperAccount: account(500), watchPaperOn: true }))[2].detail).toBe("Paper trading is in use: the paper account is funded, and the watch's paper trades are on.")
    expect(states(all({ hour: { passed: false, fromSec: T - 3600, toSec: T } }))[3]).toBe('hour:not yet')
    expect(livePathSteps(all({ twelve: null }))[4]).toMatchObject({ state: 'not known', detail: 'The report over the last twelve hours could not be built.' })
    expect(livePathSteps(all())[4].detail).toBe('Every gate that applies passed over 2026-10-07 21:00 to 09:00 UTC.')
  })

  it("tells a position made from a call by its name or its entry range, never one of the app's own", () => {
    expect(madeFromCall(executor({ name: 'AI call SOLUSDT' }))).toBe(true)
    expect(madeFromCall(executor({ name: 'My SOL', params: { side: 'buy', entryRange: { min: 99, max: 101 } } }))).toBe(true)
    expect(madeFromCall(executor({ name: 'My SOL' }))).toBe(false)
    expect(madeFromCall(executor({ name: 'AI call SOLUSDT', watch: { eventId: 'e' } }))).toBe(false)
    expect(madeFromCall(executor({ name: 'AI call SOLUSDT', newsRule: { articleId: 1 } }))).toBe(false)
    expect(madeFromCall(executor({ name: 'AI call SOLUSDT', type: 'grid' }))).toBe(false)
    expect(states(all({ executors: [executor({ name: 'Grid' })] }))[5]).toBe('confirm:not yet')
    expect(livePathSteps(all({ executors: [executor({ name: 'AI call SOLUSDT', mode: 'live' }), executor({ name: 'AI call XRPUSDT' })] }))[5].detail).toBe(
      "2 positions were made from a call's filled-in form (1 of them live)."
    )
  })

  it('reads the session: armed, disarmed, or blocked by the kill switch', () => {
    expect(states(all({ status: status() }))[6]).toBe('armed:not yet')
    expect(states(all({ status: status({ sessionArmed: true, killSwitchEngaged: true }) }))[6]).toBe('armed:not yet')
    expect(livePathSteps(all({ status: status({ killSwitchEngaged: true }) }))[6].detail).toContain('kill switch')
    expect(states(all())[6]).toBe('armed:done')
  })
})
