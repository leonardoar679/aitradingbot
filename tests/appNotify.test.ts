import { beforeEach, describe, expect, it, vi } from 'vitest'

// The one handler every desktop notice goes through (electron/ipc/handlers/appHandlers.ts) obeys the
// Notifications control on Settings (shared/alerts.ts): off, nothing is shown; without sound, the
// notice is shown silently. Driven here with Electron's pieces faked, and settings.json held in
// memory.

const rig = vi.hoisted(() => {
  /** The window the notice came from, as far as flashing its taskbar entry goes. */
  const window = {
    destroyed: false,
    focused: false,
    flashed: [] as boolean[],
    onFocus: null as null | (() => void),
    isDestroyed: () => window.destroyed,
    isFocused: () => window.focused,
    isMinimized: () => false,
    restore: () => undefined,
    show: () => undefined,
    focus: () => undefined,
    flashFrame: (on: boolean) => void window.flashed.push(on),
    once: (event: string, listener: () => void) => {
      if (event === 'focus') window.onFocus = listener
    }
  }
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    shown: [] as { title: string; body: string; silent?: boolean }[],
    stored: { alerts: undefined as unknown },
    window
  }
})

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
    BrowserWindow: { fromWebContents: () => rig.window },
    Notification
  }
})
vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => ({ alerts: rig.stored.alerts }) }))
vi.mock('../electron/services/pingService', () => ({ pingService: () => 'pong' }))

import { registerAppHandlers } from '../electron/ipc/handlers/appHandlers'
import { IpcChannel } from '../shared/ipc'

registerAppHandlers()
const notify = (title: unknown, body: unknown, severity?: unknown): Promise<unknown> =>
  Promise.resolve(rig.handlers.get(IpcChannel.AppNotify)?.({ sender: {} }, title, body, severity))

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

  it('is silent at WATCH, and with sound at HIGH and CRITICAL where sound is on', async () => {
    rig.stored.alerts = undefined
    await notify('w', 'b', 'watch')
    await notify('h', 'b', 'high')
    await notify('c', 'b', 'critical')
    await notify('x', 'b', 'loud')
    expect(rig.shown.map((shown) => [shown.title, shown.silent])).toEqual([
      ['w', true],
      ['h', false],
      ['c', false],
      ['x', false]
    ])
    rig.shown.length = 0
    rig.stored.alerts = { enabled: true, sound: false }
    await notify('c', 'b', 'critical')
    expect(rig.shown[0].silent).toBe(true)
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

describe('a CRITICAL notice and the taskbar', () => {
  beforeEach(() => {
    rig.shown.length = 0
    rig.window.flashed.length = 0
    rig.window.onFocus = null
    rig.window.focused = false
    rig.window.destroyed = false
    rig.stored.alerts = undefined
  })

  it('flashes the window until it is focused, and only for CRITICAL', async () => {
    expect(await notify('CRITICAL: SOL', 'A hack.', 'critical')).toBe(true)
    expect(rig.window.flashed).toEqual([true])
    rig.window.onFocus?.()
    expect(rig.window.flashed).toEqual([true, false])
    for (const severity of ['high', 'watch', 'info', undefined]) {
      rig.window.flashed.length = 0
      await notify('t', 'b', severity)
      expect(rig.window.flashed).toEqual([])
    }
  })

  it('flashes nothing at a window already looked at, or gone', async () => {
    rig.window.focused = true
    await notify('CRITICAL: SOL', 'A hack.', 'critical')
    expect(rig.window.flashed).toEqual([])
    rig.window.focused = false
    rig.window.destroyed = true
    await notify('CRITICAL: SOL', 'A hack.', 'critical')
    expect(rig.window.flashed).toEqual([])
  })
})
