import { describe, expect, it } from 'vitest'
import type { ExecutorConfig } from '../shared/ipc'
import { describeBatchFunding, describeExecutorFunding } from '../src/account/executorFunding'
import { emptyAccount, fund } from '../src/account/paperAccount'

const T = 1_700_000_000
const account = fund(emptyAccount(T), { asset: 'USDT', amount: 10_000, now: T, id: 'f1' })

const running = (amountQuote: number, over: Partial<ExecutorConfig> = {}): ExecutorConfig =>
  ({
    id: `e-${Math.random()}`,
    type: 'position',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    status: 'active',
    mode: 'paper',
    params: { side: 'buy', amountQuote },
    ...over
  }) as unknown as ExecutorConfig

describe('funding a single strategy', () => {
  const check = (amountQuote: number, executors: ExecutorConfig[] = [], over: Record<string, unknown> = {}) =>
    describeExecutorFunding({ account, executors, mode: 'paper', quoteAsset: 'USDT', amountQuote, ...over })

  it('allows one the account can cover', () => {
    expect(check(600)).toBeNull()
  })

  it('refuses one it cannot, and says how short', () => {
    const why = check(12_000)
    expect(why).toContain('short')
  })

  it('counts what is already running', () => {
    // 6,000 alone is fine; alongside 5,000 already committed it is not.
    expect(check(6_000)).toBeNull()
    expect(check(6_000, [running(5_000)])).not.toBeNull()
  })

  it('ignores a stopped strategy, whose money is not committed', () => {
    expect(check(6_000, [running(5_000, { status: 'stopped' })])).toBeNull()
  })
})

describe('the exemptions', () => {
  it('never limits anything when no account has been set up', () => {
    // The account is opt-in. Blocking creation for someone who never adopted it would break a
    // working app to enforce bookkeeping they never asked for.
    expect(describeBatchFunding({ account: null, executors: [], requests: [{ quoteAsset: 'USDT', amountQuote: 1e9 }] })).toBeNull()
  })

  it('never limits a live executor', () => {
    // Real money, gated by liveTradingService. Charging it against a simulated balance would
    // block a real order over imaginary funds.
    expect(
      describeExecutorFunding({ account, executors: [], mode: 'live', quoteAsset: 'USDT', amountQuote: 1e9 })
    ).toBeNull()
  })

  it('does not count live executors against the simulated balance either', () => {
    expect(describeExecutorFunding({ account, executors: [running(9_000, { mode: 'live' })], mode: 'paper', quoteAsset: 'USDT', amountQuote: 6_000 })).toBeNull()
  })
})

describe('funding a whole pack at once', () => {
  it('judges the pack on what it costs together', () => {
    // Each of these fits on its own. Checking them one at a time is exactly how three affordable
    // strategies add up to one the account cannot cover.
    const requests = [
      { quoteAsset: 'USDT', amountQuote: 4_000 },
      { quoteAsset: 'USDT', amountQuote: 4_000 },
      { quoteAsset: 'USDT', amountQuote: 4_000 }
    ]
    expect(describeBatchFunding({ account, executors: [], requests: [requests[0]] })).toBeNull()
    expect(describeBatchFunding({ account, executors: [], requests })).not.toBeNull()
  })

  it('allows a pack that fits exactly', () => {
    const requests = [
      { quoteAsset: 'USDT', amountQuote: 6_000 },
      { quoteAsset: 'USDT', amountQuote: 4_000 }
    ]
    expect(describeBatchFunding({ account, executors: [], requests })).toBeNull()
  })

  it('checks each asset against its own balance', () => {
    // A pack quoting in KRW must not be waved through because the account happens to hold USDT.
    const requests = [
      { quoteAsset: 'USDT', amountQuote: 600 },
      { quoteAsset: 'KRW', amountQuote: 500_000 }
    ]
    const why = describeBatchFunding({ account, executors: [], requests })
    expect(why).toContain('KRW')
  })

  it('ignores a nonsense request rather than refusing the whole pack over it', () => {
    const requests = [
      { quoteAsset: 'USDT', amountQuote: 600 },
      { quoteAsset: 'USDT', amountQuote: Number.NaN }
    ]
    expect(describeBatchFunding({ account, executors: [], requests })).toBeNull()
  })

  it('allows an empty request list', () => {
    expect(describeBatchFunding({ account, executors: [], requests: [] })).toBeNull()
  })
})
