import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// The main-process half of the export: dialog, then write. It could not be covered by driving
// the app, because a native save dialog is not scriptable -- so `electron` is mocked and the
// write goes to a real temp directory, which leaves the bytes on disk genuinely asserted rather
// than assumed. The BOM in particular is invisible in every text editor and is exactly the kind
// of detail that rots silently.

const state = vi.hoisted(() => ({
  saveResult: { canceled: false, filePath: '' } as { canceled: boolean; filePath?: string },
  saveOptions: null as Record<string, unknown> | null,
  handlers: new Map<string, (event: unknown, ...args: never[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: never[]) => unknown) => {
      state.handlers.set(channel, fn)
    }
  },
  dialog: {
    showSaveDialog: async (_window: unknown, options: Record<string, unknown>) => {
      state.saveOptions = options
      return state.saveResult
    }
  },
  BrowserWindow: class {}
}))

const { registerBacktestHandlers } = await import('../electron/ipc/handlers/backtestHandlers')
const { IpcChannel } = await import('../shared/ipc')
type ExportRequest = import('../shared/ipc').BacktestExportRequest
type ExportResult = import('../shared/ipc').BacktestExportResult

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bt-export-'))
  state.handlers.clear()
  state.saveOptions = null
  registerBacktestHandlers({} as never)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function invoke(request: ExportRequest): Promise<ExportResult> {
  const fn = state.handlers.get(IpcChannel.BacktestExportSave)
  if (!fn) throw new Error('handler was never registered')
  return (await fn(null, request as never)) as ExportResult
}

describe('backtest export handler', () => {
  it('registers on the export channel', () => {
    expect(state.handlers.has(IpcChannel.BacktestExportSave)).toBe(true)
  })

  it('writes JSON exactly as given, with no BOM', async () => {
    const target = join(dir, 'run.json')
    state.saveResult = { canceled: false, filePath: target }
    const content = '{"a":1}'
    const outcome = await invoke({ defaultFileName: 'run.json', content, format: 'json' })

    expect(outcome).toEqual({ status: 'saved', filePath: target })
    const bytes = await readFile(target)
    // A BOM here breaks strict JSON parsers, so the first byte must be the brace.
    expect(bytes[0]).toBe(0x7b)
    expect(bytes.toString('utf-8')).toBe(content)
    expect(JSON.parse(bytes.toString('utf-8'))).toEqual({ a: 1 })
  })

  it('prefixes CSV with a UTF-8 BOM so Excel does not use the ANSI code page', async () => {
    const target = join(dir, 'run.csv')
    state.saveResult = { canceled: false, filePath: target }
    await invoke({ defaultFileName: 'run.csv', content: 'a,b\r\n1,2\r\n', format: 'csv' })

    const bytes = await readFile(target)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    // The content itself must survive untouched after the BOM.
    expect(bytes.subarray(3).toString('utf-8')).toBe('a,b\r\n1,2\r\n')
  })

  it('keeps a non-ASCII symbol name intact through the BOM path', async () => {
    const target = join(dir, 'won.csv')
    state.saveResult = { canceled: false, filePath: target }
    await invoke({ defaultFileName: 'won.csv', content: 'symbol\r\n비트코인\r\n', format: 'csv' })

    const text = await readFile(target, 'utf-8')
    expect(text).toContain('비트코인')
  })

  it('reports cancelled without writing anything', async () => {
    state.saveResult = { canceled: true }
    const target = join(dir, 'never.json')
    const outcome = await invoke({ defaultFileName: 'never.json', content: '{}', format: 'json' })

    expect(outcome).toEqual({ status: 'cancelled' })
    await expect(readFile(target)).rejects.toThrow()
  })

  it('honours the cancelled flag even when a path comes back with it', async () => {
    // The discriminating case, and the one a naive `if (!filePath)` check gets wrong: the dialog
    // can report cancelled AND still hand back a path. Trusting the path there writes a file the
    // user explicitly declined to save, silently overwriting whatever was already at it.
    const target = join(dir, 'declined.json')
    await writeFile(target, 'must survive', 'utf-8')
    state.saveResult = { canceled: true, filePath: target }

    const outcome = await invoke({ defaultFileName: 'declined.json', content: '{"new":1}', format: 'json' })

    expect(outcome).toEqual({ status: 'cancelled' })
    expect(await readFile(target, 'utf-8')).toBe('must survive')
  })

  it('treats an empty path as cancelled rather than writing to nowhere', async () => {
    // Some platforms return canceled:false with no path. Writing to undefined would throw a
    // confusing error at the user instead of quietly doing nothing.
    state.saveResult = { canceled: false, filePath: '' }
    expect(await invoke({ defaultFileName: 'x.json', content: '{}', format: 'json' })).toEqual({
      status: 'cancelled'
    })
  })

  it('returns an error instead of throwing when the write fails', async () => {
    // A directory where a file should be: writeFile fails with EISDIR. The renderer needs a
    // message it can show, not a rejected promise that surfaces as an unhandled error.
    state.saveResult = { canceled: false, filePath: dir }
    const outcome = await invoke({ defaultFileName: 'x.json', content: '{}', format: 'json' })

    expect(outcome.status).toBe('error')
    if (outcome.status === 'error') expect(outcome.message.length).toBeGreaterThan(0)
  })

  it('offers the filter matching the requested format', async () => {
    state.saveResult = { canceled: true }
    await invoke({ defaultFileName: 'a.csv', content: '', format: 'csv' })
    expect(state.saveOptions?.filters).toEqual([{ name: 'CSV spreadsheet', extensions: ['csv'] }])

    await invoke({ defaultFileName: 'a.json', content: '', format: 'json' })
    expect(state.saveOptions?.filters).toEqual([{ name: 'JSON', extensions: ['json'] }])
  })

  it('falls back to a usable filter for an unrecognised format', async () => {
    state.saveResult = { canceled: true }
    await invoke({ defaultFileName: 'a', content: '', format: 'xml' as never })
    expect(state.saveOptions?.filters).toEqual([{ name: 'JSON', extensions: ['json'] }])
  })

  it('passes the suggested filename through and asks to confirm an overwrite', async () => {
    state.saveResult = { canceled: true }
    await invoke({ defaultFileName: 'backtest_BTC-USDT_15m.csv', content: '', format: 'csv' })

    expect(state.saveOptions?.defaultPath).toBe('backtest_BTC-USDT_15m.csv')
    expect(state.saveOptions?.properties).toContain('showOverwriteConfirmation')
  })

  it('overwrites an existing file rather than appending to it', async () => {
    const target = join(dir, 'again.csv')
    await writeFile(target, 'stale content that must not survive', 'utf-8')
    state.saveResult = { canceled: false, filePath: target }
    await invoke({ defaultFileName: 'again.csv', content: 'fresh\r\n', format: 'csv' })

    const text = await readFile(target, 'utf-8')
    expect(text).not.toContain('stale')
    expect(text.endsWith('fresh\r\n')).toBe(true)
  })
})

describe('PNG export', () => {
  // A 1x1 PNG. Small enough to inline, real enough that a decoder accepts it -- which is the whole
  // point: the base64 path has to produce bytes, not a UTF-8 rendering of a base64 string.
  const ONE_PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  it('writes decoded bytes, not the base64 text', async () => {
    const target = join(dir, 'chart.png')
    state.saveResult = { canceled: false, filePath: target }
    const outcome = await invoke({ defaultFileName: 'chart.png', content: ONE_PIXEL, format: 'png' })

    expect(outcome).toEqual({ status: 'saved', filePath: target })
    const bytes = await readFile(target)
    expect(bytes.equals(Buffer.from(ONE_PIXEL, 'base64'))).toBe(true)
    expect(bytes.length).toBeLessThan(ONE_PIXEL.length)
  })

  it('starts with the PNG magic number', async () => {
    // Writing base64 as text produces a file of plausible size that no image viewer can open, and
    // nothing upstream would notice. The signature is what separates the two outcomes.
    const target = join(dir, 'chart.png')
    state.saveResult = { canceled: false, filePath: target }
    await invoke({ defaultFileName: 'chart.png', content: ONE_PIXEL, format: 'png' })

    const bytes = await readFile(target)
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('never prefixes an image with the CSV BOM', async () => {
    const target = join(dir, 'chart.png')
    state.saveResult = { canceled: false, filePath: target }
    await invoke({ defaultFileName: 'chart.png', content: ONE_PIXEL, format: 'png' })

    const bytes = await readFile(target)
    expect(bytes[0]).not.toBe(0xef)
  })

  it('offers a PNG filter in the save dialog', async () => {
    state.saveResult = { canceled: false, filePath: join(dir, 'chart.png') }
    await invoke({ defaultFileName: 'chart.png', content: ONE_PIXEL, format: 'png' })

    expect(state.saveOptions?.filters).toEqual([{ name: 'PNG image', extensions: ['png'] }])
  })

  it('reports a cancelled image save like any other', async () => {
    state.saveResult = { canceled: true, filePath: join(dir, 'chart.png') }
    const outcome = await invoke({ defaultFileName: 'chart.png', content: ONE_PIXEL, format: 'png' })
    expect(outcome).toEqual({ status: 'cancelled' })
  })
})
