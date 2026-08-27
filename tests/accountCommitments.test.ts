import { beforeEach, describe, expect, it } from 'vitest'
import type { ExecutorConfig, HeldPosition, PaperAccount } from '../shared/ipc'
import { assetsInPlay, committedByAsset, committedFor, heldCostByAsset } from '../src/account/accountCommitments'
import { updateAccount } from '../src/account/persistAccount'
import { emptyAccount, fund, totalBalance } from '../src/account/paperAccount'
import { settingsWrites } from '../src/utils/settingsWrites'

const T = 1_700_000_000

const exec = (over: Partial<ExecutorConfig> & { params: unknown }): ExecutorConfig =>
  ({
    id: `e-${Math.random()}`,
    type: 'position',
    exchange: 'binance',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    status: 'active',
    mode: 'paper',
    ...over
  }) as unknown as ExecutorConfig

const position = (amountQuote: number, over: Partial<ExecutorConfig> = {}) =>
  exec({ type: 'position', params: { side: 'buy', amountQuote }, ...over })

describe('what the account currently has out working', () => {
  it('adds up the running paper strategies', () => {
    const committed = committedByAsset([position(600), position(400)])
    expect(committed.USDT).toBe(1_000)
  })

  it('ignores stopped strategies, which have already returned their money', () => {
    expect(committedFor([position(600, { status: 'stopped' })], 'USDT')).toBe(0)
  })

  it('ignores live strategies, which spend real money on a real exchange', () => {
    // Charging a live executor against the simulated balance would show funds leaving an account
    // its orders never touched.
    expect(committedFor([position(600, { mode: 'live' })], 'USDT')).toBe(0)
  })

  it('keeps quote assets apart', () => {
    const committed = committedByAsset([position(600), position(500_000, { quoteAsset: 'KRW', symbol: 'BTC_KRW' })])
    expect(committed.USDT).toBe(600)
    expect(committed.KRW).toBe(500_000)
  })

  it('skips a malformed executor instead of poisoning the whole total', () => {
    // One bad row would otherwise make every figure on the Account page NaN rather than just
    // its own.
    const committed = committedByAsset([position(600), position(Number.NaN)])
    expect(committed.USDT).toBe(600)
  })

  it('adds up a DCA ladder across its levels', () => {
    const dca = exec({ type: 'dca', params: { side: 'buy', levels: [{ amountQuote: 100 }, { amountQuote: 250 }] } })
    expect(committedFor([dca], 'USDT')).toBe(350)
  })
})

describe('which assets to show', () => {
  it('lists an asset that is fully committed with nothing free', () => {
    // Leaving it out would make money that is out working look as though it had vanished.
    expect(assetsInPlay({}, { USDT: 600 })).toEqual(['USDT'])
  })

  it('leaves out an asset that is neither held nor committed', () => {
    expect(assetsInPlay({ USDT: 0 }, { USDT: 0 })).toEqual([])
  })

  it('puts the biggest free balance first', () => {
    expect(assetsInPlay({ BTC: 1, USDT: 9_000 }, {})).toEqual(['USDT', 'BTC'])
  })
})

describe('writing the account back', () => {
  let stored: { paperAccount: PaperAccount | null }
  let setCalls: number

  beforeEach(() => {
    stored = { paperAccount: null }
    setCalls = 0
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

  it('creates an account on the first write', async () => {
    const account = await updateAccount((a) => fund(a, { asset: 'USDT', amount: 10_000, now: T, id: 'f1' }), T)

    expect(totalBalance(account, 'USDT')).toBe(10_000)
    expect(stored.paperAccount).not.toBeNull()
    expect(setCalls).toBe(1)
  })

  it('applies the change to the CURRENT stored account, not a stale copy', async () => {
    stored.paperAccount = fund(emptyAccount(T), { asset: 'USDT', amount: 10_000, now: T, id: 'f1' })

    await updateAccount((a) => fund(a, { asset: 'BTC', amount: 0.5, now: T, id: 'f2' }), T)

    expect(totalBalance(stored.paperAccount!, 'USDT')).toBe(10_000)
    expect(totalBalance(stored.paperAccount!, 'BTC')).toBe(0.5)
  })

  it('does not lose a movement that lands mid-write', async () => {
    // Two writers at once is the case where a balance silently gains or loses money. Both go
    // through the shared settings queue, so one cannot read-modify-write on top of the other.
    stored.paperAccount = emptyAccount(T)

    await Promise.all([
      updateAccount((a) => fund(a, { asset: 'USDT', amount: 1_000, now: T, id: 'a' }), T),
      settingsWrites(async () => {
        const fresh = await window.api.settings.get()
        await window.api.settings.set({
          paperAccount: fund(fresh.paperAccount!, { asset: 'USDT', amount: 2_000, now: T, id: 'b' })
        })
      })
    ])

    // 3,000, not 1,000 or 2,000 -- neither write may overwrite the other.
    expect(totalBalance(stored.paperAccount!, 'USDT')).toBe(3_000)
  })
})

describe('what Inventory positions cost the account', () => {
  // Unlike a running strategy's commitment, this money really has left the balance: handing a
  // position over books -amountQuote. A balance on its own therefore understates the account, and
  // "since funded" read as a loss the size of the position the moment one was kept.
  const held = (over: Partial<HeldPosition> = {}): HeldPosition =>
    ({ id: 'h1', quoteAsset: 'USDT', amountQuote: 1_000, ...over }) as HeldPosition

  it('adds up what each quote asset has tied up', () => {
    expect(heldCostByAsset([held(), held({ id: 'h2', amountQuote: 250 })])).toEqual({ USDT: 1_250 })
  })

  it('keeps currencies apart, so a KRW row never lands in the dollar figure', () => {
    expect(heldCostByAsset([held(), held({ id: 'h2', quoteAsset: 'KRW', amountQuote: 5_000_000 })])).toEqual({
      USDT: 1_000,
      KRW: 5_000_000
    })
  })

  it('is empty when nothing is held', () => {
    expect(heldCostByAsset([])).toEqual({})
  })

  it('skips a malformed row rather than turning the whole figure into NaN', () => {
    // One bad row must not make every number on the Account page unreadable -- the same rule
    // committedByAsset already follows.
    const result = heldCostByAsset([held(), held({ id: 'h2', amountQuote: NaN }), held({ id: 'h3', amountQuote: -5 })])

    expect(result).toEqual({ USDT: 1_000 })
  })
})
