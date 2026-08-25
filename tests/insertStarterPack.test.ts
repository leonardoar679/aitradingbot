import { beforeEach, describe, expect, it } from 'vitest'
import { insertPreset, insertStarterPack } from '../src/presets/insertStarterPack'
import { STARTER_PACKS, findPreset } from '../src/presets/starterPresets'
import { settingsWrites } from '../src/utils/settingsWrites'
import { emptyAccount, fund } from '../src/account/paperAccount'
import type { ControllerConfig, ExecutorConfig } from '../shared/ipc'

// Adding a preset writes to the same two settings arrays every other page writes, and
// settings.set replaces whole top-level arrays. So the risk here is not that the preset is wrong
// -- it is that adding one quietly deletes executors or controllers the user already had.

const opts = { referencePrice: 50_000, now: 1_700_000_000 }

let stored: { executors: ExecutorConfig[]; controllers: ControllerConfig[]; paperAccount: null }
let setCalls: number

const existingExecutor = { id: 'mine-1', name: 'My Own Grid' } as ExecutorConfig
const existingController = { id: 'ctrl-1', name: 'My Own Desk', executorIds: ['mine-1'] } as ControllerConfig

beforeEach(() => {
  // No paper account: presets must keep working for anyone who never set one up.
  stored = { executors: [existingExecutor], controllers: [existingController], paperAccount: null }
  setCalls = 0
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      settings: {
        get: async () => {
          await Promise.resolve()
          return { executors: [...stored.executors], controllers: [...stored.controllers], paperAccount: stored.paperAccount }
        },
        set: async (patch: Partial<typeof stored>) => {
          await Promise.resolve()
          setCalls++
          stored = { ...stored, ...patch }
        }
      }
    }
  }
})

describe('insertStarterPack', () => {
  const pack = STARTER_PACKS[0]

  it('adds the executors and the controller that supervises them', async () => {
    const created = await insertStarterPack(pack, opts)

    expect(created).toHaveLength(pack.presetIds.length)
    const controller = stored.controllers.find((c) => c.name === pack.name)
    expect(controller).toBeDefined()
    expect(controller!.executorIds).toEqual(created.map((e) => e.id))
    // The attached ids must actually resolve, or ControllerScheduler ticks against a group whose
    // members it cannot find.
    for (const id of controller!.executorIds) {
      expect(stored.executors.some((e) => e.id === id)).toBe(true)
    }
  })

  it('writes both arrays in one call, so the controller is never briefly orphaned', async () => {
    await insertStarterPack(pack, opts)

    expect(setCalls).toBe(1)
  })

  it('keeps what the user already had', async () => {
    await insertStarterPack(pack, opts)

    expect(stored.executors.some((e) => e.id === 'mine-1')).toBe(true)
    expect(stored.controllers.some((c) => c.id === 'ctrl-1')).toBe(true)
  })

  it('adds only paper executors', async () => {
    const created = await insertStarterPack(pack, opts)

    expect(created.every((e) => e.mode === 'paper')).toBe(true)
  })

  it('appends to a write that lands mid-insert instead of overwriting it', async () => {
    // Another page saving an edit at the same moment. Both go through the shared settings queue,
    // so neither can read-modify-write on top of the other.
    await Promise.all([
      insertStarterPack(pack, opts),
      settingsWrites(async () => {
        const fresh = await window.api.settings.get()
        await window.api.settings.set({ executors: [...fresh.executors, { id: 'other-1' } as ExecutorConfig] })
      })
    ])

    expect(stored.executors.some((e) => e.id === 'other-1')).toBe(true)
    expect(stored.executors.some((e) => e.id === 'mine-1')).toBe(true)
    expect(stored.executors).toHaveLength(1 + pack.presetIds.length + 1)
  })
})

describe('insertPreset', () => {
  it('adds one executor and no controller', async () => {
    const preset = findPreset('twap-accumulate')!
    const created = await insertPreset(preset, opts)

    expect(stored.executors.some((e) => e.id === created.id)).toBe(true)
    expect(stored.controllers).toHaveLength(1)
    expect(created.mode).toBe('paper')
  })

  it('keeps the executors already there', async () => {
    await insertPreset(findPreset('dca-dip-ladder')!, opts)

    expect(stored.executors.some((e) => e.id === 'mine-1')).toBe(true)
    expect(stored.executors).toHaveLength(2)
  })
})

describe('the paper account gates what can be added', () => {
  const pack = STARTER_PACKS[0]

  it('refuses a pack the account cannot cover, and writes nothing', async () => {
    stored.paperAccount = fund(emptyAccount(1_700_000_000), {
      asset: 'USDT',
      amount: 100,
      now: 1_700_000_000,
      id: 'f1'
    }) as never

    await expect(insertStarterPack(pack, opts)).rejects.toThrow(/short/)
    // Refusing after a partial write would be worse than not checking at all.
    expect(stored.executors).toHaveLength(1)
    expect(stored.controllers).toHaveLength(1)
    expect(setCalls).toBe(0)
  })

  it('allows a pack the account can cover', async () => {
    stored.paperAccount = fund(emptyAccount(1_700_000_000), {
      asset: 'USDT',
      amount: 50_000,
      now: 1_700_000_000,
      id: 'f1'
    }) as never

    await expect(insertStarterPack(pack, opts)).resolves.toHaveLength(pack.presetIds.length)
  })

  it('counts strategies already running against the same balance', async () => {
    // The pack fits an empty account but not one already holding most of it.
    stored.paperAccount = fund(emptyAccount(1_700_000_000), {
      asset: 'USDT',
      amount: 1_500,
      now: 1_700_000_000,
      id: 'f1'
    }) as never
    stored.executors = [
      { id: 'running', quoteAsset: 'USDT', status: 'active', mode: 'paper', type: 'position', params: { amountQuote: 1_400 } } as unknown as ExecutorConfig
    ]

    await expect(insertStarterPack(pack, opts)).rejects.toThrow(/short/)
  })

  it('refuses a single preset the same way', async () => {
    stored.paperAccount = fund(emptyAccount(1_700_000_000), {
      asset: 'USDT',
      amount: 10,
      now: 1_700_000_000,
      id: 'f1'
    }) as never

    await expect(insertPreset(findPreset('twap-accumulate')!, opts)).rejects.toThrow(/short/)
    expect(stored.executors).toHaveLength(1)
  })
})
