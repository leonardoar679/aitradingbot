import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../shared/ipc'
import { DEFAULT_PAPER_BOOKS } from '../shared/paperBooks'

// A WINDOW'S PATCH OF THE SETTINGS (electron/ipc/handlers/settingsHandlers.ts; V8 Stage 9): the paper books are started
// and stopped by Start and Stop paper testing alone, which write what they turned on first -- so a window's patch may
// carry the books only as they are, and is written without them; one that would start, stop or change them is refused,
// and nothing of it is written.

const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
let settings: Record<string, unknown> = {}
const written: unknown[] = []

vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => handlers.set(channel, handler) } }))
vi.mock('../electron/services/settingsService', () => ({
  getSettings: async () => settings,
  setSettings: async (patch: Record<string, unknown>) => {
    written.push(patch)
    settings = { ...settings, ...patch }
    return settings
  }
}))

beforeEach(() => {
  handlers.clear()
  written.length = 0
})

describe("a window's patch of the settings", () => {
  it('is written as it is without the books, and without them where it carries them as they are', async () => {
    settings = { paperBooks: { ...DEFAULT_PAPER_BOOKS, running: true, startedAt: 5 }, executors: [] }
    const { windowSettingsPatch } = await import('../electron/ipc/handlers/settingsHandlers')
    expect(await windowSettingsPatch({ executors: [] })).toEqual({ executors: [] })
    expect(await windowSettingsPatch({ ...settings, executors: [] } as never)).toEqual({ executors: [] })
  })

  it('is refused where it would start, stop or change the books, and nothing of it is written', async () => {
    settings = { paperBooks: DEFAULT_PAPER_BOOKS, executors: [] }
    const { registerSettingsHandlers } = await import('../electron/ipc/handlers/settingsHandlers')
    registerSettingsHandlers()
    const set = handlers.get(IpcChannel.SettingsSet) as (event: unknown, patch: unknown) => Promise<unknown>
    const refusal = 'The paper books are started and stopped by Start and Stop paper testing on Paper Trading, not by a setting.'
    await expect(set({}, { executors: [], paperBooks: { ...DEFAULT_PAPER_BOOKS, running: true, startedAt: 9 } })).rejects.toThrow(refusal)
    await expect(set({}, { paperBooks: { ...DEFAULT_PAPER_BOOKS, books: { ...DEFAULT_PAPER_BOOKS.books, news: { ...DEFAULT_PAPER_BOOKS.books.news, maxOpen: 50 } } } })).rejects.toThrow(refusal)
    expect(written).toEqual([])
    await set({}, { executors: [] })
    expect(written).toEqual([{ executors: [] }])
  })
})
