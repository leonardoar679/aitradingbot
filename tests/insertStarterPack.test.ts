import { beforeEach, describe, expect, it } from 'vitest'
import { insertPreset, insertStarterPack } from '../src/presets/insertStarterPack'
import { STARTER_PACKS, findPreset } from '../src/presets/starterPresets'
import { settingsWrites } from '../src/utils/settingsWrites'
import type { ControllerConfig, ExecutorConfig } from '../shared/ipc'

// Adding a preset writes to the same two settings arrays every other page writes, and
// settings.set replaces whole top-level arrays. So the risk here is not that the preset is wrong
// -- it is that adding one quietly deletes executors or controllers the user already had.

const opts = { referencePrice: 50_000, now: 1_700_000_000 }

let stored: { executors: ExecutorConfig[]; controllers: ControllerConfig[] }
let setCalls: number

const existingExecutor = { id: 'mine-1', name: 'My Own Grid' } as ExecutorConfig
const existingController = { id: 'ctrl-1', name: 'My Own Desk', executorIds: ['mine-1'] } as ControllerConfig

beforeEach(() => {
  stored = { executors: [existingExecutor], controllers: [existingController] }
  setCalls = 0
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      settings: {
        get: async () => {
          await Promise.resolve()
          return { executors: [...stored.executors], controllers: [...stored.controllers] }
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
