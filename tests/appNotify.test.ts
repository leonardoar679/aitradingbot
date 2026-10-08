import { beforeEach, describe, expect, it, vi } from 'vitest'

// The one service every desktop notice goes through (electron/services/noticeService.ts, reached
// from the window through electron/ipc/handlers/appHandlers.ts): it obeys the Notifications control
// on Settings (shared/alerts.ts) -- off, nothing is shown; without sound, the notice is shown
// silently -- keeps one thread per kind and pair so a repeat raises nothing, records what it told
// (shared/records.ts) and tells the window. Driven here with Electron's pieces faked, settings.json
// held in memory, and the alerts file a list.

const rig = vi.hoisted(() => {
  /** The window the notice came from, as far as flashing its taskbar entry goes. */
  const window = {
    destroyed: false,
    focused: false,
    flashed: [] as boolean[],
    sent: [] as { channel: string; record: Record<string, unknown> }[],
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
    },
    webContents: { send: (channel: string, record: Record<string, unknown>) => void window.sent.push({ channel, record }) }
  }
  return {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    shown: [] as { title: string; body: string; silent?: boolean }[],
    recorded: [] as Record<string, unknown>[],
    /** The alerts file as the service reads it back at start: what an earlier run told. */
    onFile: [] as Record<string, unknown>[],
    beeps: 0,
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
    BrowserWindow: { fromWebContents: () => rig.window, getAllWindows: () => [rig.window] },
    Notification,
    shell: { beep: () => void rig.beeps++ }
  }
})
vi.mock('../electron/services/settingsService', () => ({ getSettings: async () => ({ alerts: rig.stored.alerts }) }))
vi.mock('../electron/services/pingService', () => ({ pingService: () => 'pong' }))
vi.mock('../electron/services/recordStoreService', () => ({
  appendAlert: async (record: Record<string, unknown>) => {
    rig.recorded.push(record)
    return record
  },
  readAlertsSince: async () => ({ rows: rig.onFile, skippedLines: 0 })
}))

import { registerAppHandlers } from '../electron/ipc/handlers/appHandlers'
import { noticeLevel, resetNoticeThreads } from '../electron/services/noticeService'
import { IpcChannel } from '../shared/ipc'

registerAppHandlers()
const notify = (title: unknown, body: unknown, severity?: unknown, extra?: unknown): Promise<unknown> =>
  Promise.resolve(rig.handlers.get(IpcChannel.AppNotify)?.({ sender: {} }, title, body, severity, extra))

beforeEach(() => {
  rig.shown.length = 0
  rig.recorded.length = 0
  rig.window.sent.length = 0
  rig.onFile.length = 0
  rig.beeps = 0
  resetNoticeThreads()
  vi.useRealTimers()
})

describe('after a restart (V5 Stage 8, 8 October 2026)', () => {
  it('reads the threads told in the last day back from the file, so a daily thread is not told again', async () => {
    rig.stored.alerts = undefined
    const nowSec = Math.floor(Date.now() / 1000)
    rig.onFile.push({ id: 'a', at: nowSec - 3 * 3600, severity: 'high', title: 'old', body: 'b', kind: 'CIRCUIT_BREAKER', thread: 'model:openai/gpt-5-mini' })
    rig.onFile.push({ id: 'b', at: nowSec - 3 * 3600, severity: 'watch', title: 'old', body: 'b', kind: 'TRADE_BLOCKED', thread: 'paper-blocked' })
    // The daily thread, told three hours ago by the run before: a repeat.
    expect(await notify('degraded', 'b', 'high', { kind: 'CIRCUIT_BREAKER', thread: 'model:openai/gpt-5-mini', threadSeconds: 86_400 })).toBe(false)
    // A half-hour thread told three hours ago has run out: told.
    expect(await notify('blocked', 'b', 'watch', { kind: 'TRADE_BLOCKED', thread: 'paper-blocked' })).toBe(true)
    // Another daily thread, not on file: told.
    expect(await notify('degraded', 'b', 'high', { kind: 'CIRCUIT_BREAKER', thread: 'model:anthropic/claude-sonnet-5.5', threadSeconds: 86_400 })).toBe(true)
    expect(rig.shown.map((shown) => shown.title)).toEqual(['blocked', 'degraded'])
  })

  it("sounds the minute's reminder under the Notifications control, and shows and records nothing", async () => {
    const remind = (): Promise<unknown> => Promise.resolve(rig.handlers.get(IpcChannel.AppRemind)?.())
    rig.stored.alerts = undefined
    expect(await remind()).toBe(true)
    rig.stored.alerts = { enabled: true, sound: false }
    expect(await remind()).toBe(false)
    rig.stored.alerts = { enabled: false, sound: true }
    expect(await remind()).toBe(false)
    expect(rig.beeps).toBe(1)
    expect(rig.shown).toEqual([])
    expect(rig.recorded).toEqual([])
  })
})

describe('a desktop notice', () => {
  it('is shown, with sound, when nothing is stored', async () => {
    rig.stored.alerts = undefined
    expect(await notify('Paper trade: SOLUSDT', 'A paper position was opened.')).toBe(true)
    expect(rig.shown).toEqual([{ title: 'Paper trade: SOLUSDT', body: 'A paper position was opened.', silent: false }])
  })

  it('is shown silently without sound, and not at all when notices are off, and is a record either way', async () => {
    rig.stored.alerts = { enabled: true, sound: false }
    expect(await notify('t', 'b')).toBe(true)
    expect(rig.shown).toEqual([{ title: 't', body: 'b', silent: true }])
    rig.stored.alerts = { enabled: false, sound: true }
    expect(await notify('t', 'b')).toBe(false)
    expect(rig.shown).toHaveLength(1)
    // Switched off on the desktop, it is still what the app told: on file, and in the window.
    expect(rig.recorded).toHaveLength(2)
    expect(rig.window.sent).toHaveLength(2)
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

  it('takes how loud it is from its kind when it names no severity: a blocked trade is silent, a stop sounds', async () => {
    rig.stored.alerts = undefined
    await notify('blocked', 'b', undefined, { kind: 'TRADE_BLOCKED' })
    await notify('stop', 'b', undefined, { kind: 'STOP_TRIGGERED' })
    await notify('plain', 'b')
    expect(rig.shown.map((shown) => [shown.title, shown.silent])).toEqual([
      ['blocked', true],
      ['stop', false],
      ['plain', false]
    ])
    expect(noticeLevel({ severity: null, kind: 'MARKET_EVENT' })).toBe('watch')
    expect(noticeLevel({ severity: 'critical', kind: 'MARKET_EVENT' })).toBe('critical')
    expect(noticeLevel({ severity: null, kind: null })).toBe('high')
  })

  it('shows only text, cut to its limits, and nothing that is not text', async () => {
    rig.stored.alerts = undefined
    expect(await notify({ title: 'x' }, 'b')).toBe(false)
    expect(await notify('t', 7)).toBe(false)
    expect(rig.recorded).toHaveLength(0)
    await notify('x'.repeat(300), 'y'.repeat(900))
    expect(rig.shown[0].title).toHaveLength(120)
    expect(rig.shown[0].body).toHaveLength(400)
  })
})

describe('the record and the window', () => {
  it('writes what it told, with its kind, thread, id and https link, and tells the window the same', async () => {
    rig.stored.alerts = undefined
    await notify('HIGH: SOL · hack', 'A story.', 'high', { kind: 'NEWS_EVENT', id: 'story-1', url: 'https://www.coindesk.com/a' })
    await notify('plain', 'b', undefined, { kind: 'TRADE_EXECUTED', thread: 'paper-1', url: 'javascript:alert(1)' })
    expect(rig.recorded).toHaveLength(2)
    expect(rig.recorded[0]).toMatchObject({ id: 'story-1', severity: 'high', title: 'HIGH: SOL · hack', body: 'A story.', kind: 'NEWS_EVENT', url: 'https://www.coindesk.com/a' })
    expect(rig.recorded[1]).toMatchObject({ severity: 'watch', kind: 'TRADE_EXECUTED', thread: 'paper-1' })
    expect(rig.recorded[1]).not.toHaveProperty('url')
    expect(String(rig.recorded[1].id)).toMatch(/^TRADE_EXECUTED:paper-1:\d+$/)
    expect(rig.window.sent.map((entry) => entry.channel)).toEqual([IpcChannel.AlertsTold, IpcChannel.AlertsTold])
    expect(rig.window.sent[0].record).toEqual(rig.recorded[0])
  })
})

describe('a thread', () => {
  it('tells the first notice, counts a repeat within half an hour without telling it, and tells again after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'))
    rig.stored.alerts = undefined
    expect(await notify('SOLUSDT: breakout (urgent)', 'b', undefined, { kind: 'MARKET_EVENT', thread: 'SOLUSDT' })).toBe(true)
    expect(await notify('SOLUSDT: breakout (urgent)', 'b', undefined, { kind: 'MARKET_EVENT', thread: 'SOLUSDT' })).toBe(false)
    // Another pair, and another kind on the same pair, are their own threads.
    expect(await notify('ETHUSDT: breakout (urgent)', 'b', undefined, { kind: 'MARKET_EVENT', thread: 'ETHUSDT' })).toBe(true)
    expect(await notify('SOLUSDT: near its stop', 'b', undefined, { kind: 'POSITION_RISK', thread: 'SOLUSDT' })).toBe(true)
    expect(rig.shown).toHaveLength(3)
    expect(rig.recorded).toHaveLength(3)
    vi.setSystemTime(Date.parse('2026-10-08T12:29:59Z'))
    expect(await notify('SOLUSDT: breakout (urgent)', 'b', undefined, { kind: 'MARKET_EVENT', thread: 'SOLUSDT' })).toBe(false)
    vi.setSystemTime(Date.parse('2026-10-08T12:30:00Z'))
    expect(await notify('SOLUSDT: breakout (urgent)', 'b', undefined, { kind: 'MARKET_EVENT', thread: 'SOLUSDT' })).toBe(true)
  })

  it('holds a thread for as long as the notice asks, and a notice without a thread is always told', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.parse('2026-10-08T12:00:00Z'))
    rig.stored.alerts = undefined
    expect(await notify('rested', 'b', undefined, { kind: 'CIRCUIT_BREAKER', thread: 'model:a', threadSeconds: 86_400 })).toBe(true)
    vi.setSystemTime(Date.parse('2026-10-08T23:00:00Z'))
    expect(await notify('rested', 'b', undefined, { kind: 'CIRCUIT_BREAKER', thread: 'model:a', threadSeconds: 86_400 })).toBe(false)
    vi.setSystemTime(Date.parse('2026-10-09T12:00:01Z'))
    expect(await notify('rested', 'b', undefined, { kind: 'CIRCUIT_BREAKER', thread: 'model:a', threadSeconds: 86_400 })).toBe(true)
    expect(await notify('call', 'b', undefined, { kind: 'TRADE_OPPORTUNITY' })).toBe(true)
    expect(await notify('call', 'b', undefined, { kind: 'TRADE_OPPORTUNITY' })).toBe(true)
  })
})

describe('a CRITICAL notice and the taskbar', () => {
  beforeEach(() => {
    rig.window.flashed.length = 0
    rig.window.onFocus = null
    rig.window.focused = false
    rig.window.destroyed = false
    rig.stored.alerts = undefined
  })

  it('flashes the window\'s taskbar entry until it is focused, and only at CRITICAL', async () => {
    await notify('h', 'b', 'high')
    expect(rig.window.flashed).toEqual([])
    await notify('c', 'b', 'critical')
    expect(rig.window.flashed).toEqual([true])
    rig.window.onFocus?.()
    expect(rig.window.flashed).toEqual([true, false])
  })

  it('does not flash a window that is already focused, nor one that is gone', async () => {
    rig.window.focused = true
    await notify('c', 'b', 'critical')
    expect(rig.window.flashed).toEqual([])
    rig.window.focused = false
    rig.window.destroyed = true
    await notify('c', 'b', 'critical')
    expect(rig.window.flashed).toEqual([])
  })
})
