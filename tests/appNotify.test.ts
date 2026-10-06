import { beforeEach, describe, expect, it, vi } from 'vitest'

// The one handler every desktop notice goes through (electron/ipc/handlers/appHandlers.ts) obeys the
// Notifications control on Settings (shared/alerts.ts): off, nothing is shown; without sound, the
// notice is shown silently. Driven here with Electron's pieces faked, and settings.json held in
// memory.

const rig = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  shown: [] as { title: string; body: string; silent?: boolean }[],
  stored: { alerts: undefined as unknown }
}))

vi.mock('electron', () => {
  class Notification {
    static isSupported(): boolean {
      return true
    }
    constructor(private readonly options: { title: string; body: string; silent?: boolean }) {}
    /** Click, close and failure are not what is tested here. */
    on(): this {
      return this
    }
    show(): void {
      rig.shown.push(this.options)
    }
  }
  return {
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => rig.handlers.set(channel, handler) },
    app: { getVersion: () => '0.0.0' },
    BrowserWindow: { fromWebContents: () => null },
    Notification
  }
})
vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => ({ alerts: rig.stored.alerts }) }))
vi.mock('../electron/services/pingService', () => ({ pingService: () => 'pong' }))

import { registerAppHandlers } from '../electron/ipc/handlers/appHandlers'
import { IpcChannel } from '../shared/ipc'

registerAppHandlers()
const notify = (title: unknown, body: unknown): Promise<unknown> => Promise.resolve(rig.handlers.get(IpcChannel.AppNotify)?.({ sender: {} }, title, body))

describe('a desktop notice', () => {
  beforeEach(() => {
    rig.shown.length = 0
  })

  it('is shown, with sound, when nothing is stored', async () => {
    rig.stored.alerts = undefined
    expect(await notify('Paper trade: SOLUSDT', 'A paper position was opened.')).toBe(true)
    expect(rig.shown).toEqual([{ title: 'Paper trade: SOLUSDT', body: 'A paper position was opened.', silent: false }])
  })

  it('is shown silently without sound, and not at all when notices are off', async () => {
    rig.stored.alerts = { enabled: true, sound: false }
    expect(await notify('t', 'b')).toBe(true)
    expect(rig.shown).toEqual([{ title: 't', body: 'b', silent: true }])
    rig.stored.alerts = { enabled: false, sound: true }
    expect(await notify('t', 'b')).toBe(false)
    expect(rig.shown).toHaveLength(1)
  })

  it('shows only text, cut to its limits, and nothing that is not text', async () => {
    rig.stored.alerts = undefined
    expect(await notify({ title: 'x' }, 'b')).toBe(false)
    expect(await notify('t', 7)).toBe(false)
    await notify('x'.repeat(300), 'y'.repeat(900))
    expect(rig.shown[0].title).toHaveLength(120)
    expect(rig.shown[0].body).toHaveLength(400)
  })
})
