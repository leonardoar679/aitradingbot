import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutorConfig, PaperAccount } from '../shared/ipc'

// A strategy can be stopped from the Executors page, by a Controller hitting a risk limit, or by
// a live run finishing. The account has to end up the same whichever pressed stop -- the same
// problem that once decided whether a kept position survived.

let pnl: number
const pnlCalls: string[] = []

vi.mock('../src/executors/computeSnapshot', () => ({
  computeExecutorPnl: async (executor: ExecutorConfig) => {
    pnlCalls.push(executor.id)
    return pnl
  }
}))

const { settleExecutorOnStop } = await import('../src/account/settleExecutor')
const { emptyAccount, fund, totalBalance } = await import('../src/account/paperAccount')

const T = 1_700_000_000

const executor = (over: Partial<ExecutorConfig> = {}): ExecutorConfig =>
  ({
    id: 'e1',
    name: 'Dip Ladder',
    quoteAsset: 'USDT',
    mode: 'paper',
    ...over
  }) as unknown as ExecutorConfig

let stored: { paperAccount: PaperAccount | null }
let setCalls: number

beforeEach(() => {
  pnl = 0
  pnlCalls.length = 0
  setCalls = 0
  stored = { paperAccount: fund(emptyAccount(T), { asset: 'USDT', amount: 10_000, now: T, id: 'f1' }) }
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      settings: {
        get: async () => {
          await Promise.resolve()
          return { paperAccount: stored.paperAccount }
        },
        set: async (patch: { paperAccount: PaperAccount }) => {
          await Promise.resolve()
          setCalls++
          stored = { ...stored, ...patch }
        }
      }
    }
  }
})

describe('settling a stopped strategy', () => {
  it('adds a profit to the balance', async () => {
    pnl = 42
    const settled = await settleExecutorOnStop({ executor: executor(), handedOverToInventory: false, now: T })

    expect(settled).toBe(42)
    expect(totalBalance(stored.paperAccount!, 'USDT')).toBe(10_042)
  })

  it('subtracts a loss', async () => {
    pnl = -30
    await settleExecutorOnStop({ executor: executor(), handedOverToInventory: false, now: T })

    expect(totalBalance(stored.paperAccount!, 'USDT')).toBe(9_970)
  })

  it('books it against the strategy quote asset, not a default', async () => {
    pnl = 5_000
    await settleExecutorOnStop({
      executor: executor({ quoteAsset: 'KRW', symbol: 'BTC_KRW' }),
      handedOverToInventory: false,
      now: T
    })

    expect(totalBalance(stored.paperAccount!, 'KRW')).toBe(5_000)
    expect(totalBalance(stored.paperAccount!, 'USDT')).toBe(10_000)
  })

  it('names the strategy in the ledger so the movement can be traced', async () => {
    pnl = 42
    await settleExecutorOnStop({ executor: executor(), handedOverToInventory: false, now: T })

    const entry = stored.paperAccount!.ledger.at(-1)!
    expect(entry.executorId).toBe('e1')
    expect(entry.note).toContain('Dip Ladder')
  })
})

describe('what settling deliberately skips', () => {
  it('skips a live executor, which keeps its own real ledger', async () => {
    pnl = 42
    const settled = await settleExecutorOnStop({ executor: executor({ mode: 'live' }), handedOverToInventory: false, now: T })

    expect(settled).toBeNull()
    expect(totalBalance(stored.paperAccount!, 'USDT')).toBe(10_000)
    // Not even computed -- a live executor's result has no business being asked for here.
    expect(pnlCalls).toEqual([])
  })

  it('skips a position handed over to Inventory, which would otherwise count twice', async () => {
    pnl = 42
    const settled = await settleExecutorOnStop({ executor: executor(), handedOverToInventory: true, now: T })

    expect(settled).toBeNull()
    expect(totalBalance(stored.paperAccount!, 'USDT')).toBe(10_000)
  })

  it('does nothing when there is no account', async () => {
    stored.paperAccount = null
    pnl = 42

    expect(await settleExecutorOnStop({ executor: executor(), handedOverToInventory: false, now: T })).toBeNull()
    expect(stored.paperAccount).toBeNull()
  })

  it('writes no movement for a strategy that broke even', async () => {
    // A ledger full of zero entries explains nothing. settle() would also ignore a zero, but
    // stopping earlier means no settings write happens at all -- worth asserting, or the guard
    // here is untestable and looks removable.
    pnl = 0
    await settleExecutorOnStop({ executor: executor(), handedOverToInventory: false, now: T })

    expect(stored.paperAccount!.ledger).toHaveLength(1)
    expect(setCalls).toBe(0)
  })

  it('refuses a non-finite result rather than poisoning the balance', async () => {
    // JSON cannot store NaN, so one that reached settings.json would come back as null and the
    // balance would silently read as zero on the next launch.
    pnl = Number.NaN
    await settleExecutorOnStop({ executor: executor(), handedOverToInventory: false, now: T })

    expect(totalBalance(stored.paperAccount!, 'USDT')).toBe(10_000)
    // And no write at all: settle() would refuse the NaN anyway, but rewriting the whole account
    // to store an unchanged copy is a pointless risk on the file that holds the balance.
    expect(setCalls).toBe(0)
  })
})
