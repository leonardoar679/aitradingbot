import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// The sibling file covers concurrency. This one covers the reason writeJsonAtomic exists at all:
// a write that dies part-way must not damage what was already on disk. Nothing tested that,
// because every existing assertion looks at the finished file -- and writing straight to the
// target produces exactly the same finished file when nothing goes wrong. Replacing the whole
// temp-and-rename with a plain writeFile left the suite green.
//
// A real crash mid-write cannot be scheduled, so writeFile is stubbed to lay down a truncated
// prefix and then fail, which is what power loss looks like to the file system.
const state = vi.hoisted(() => ({ failPartially: false, renameFailures: 0, renameFailureCode: 'EPERM' }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    writeFile: async (path: Parameters<typeof actual.writeFile>[0], data: Parameters<typeof actual.writeFile>[1], options?: Parameters<typeof actual.writeFile>[2]) => {
      if (!state.failPartially) return actual.writeFile(path, data, options)
      await actual.writeFile(path, String(data).slice(0, 8), options)
      throw Object.assign(new Error('simulated power loss mid-write'), { code: 'ENOSPC' })
    },
    rename: async (from: string, to: string) => {
      if (state.renameFailures > 0) {
        state.renameFailures--
        throw Object.assign(new Error(`simulated ${state.renameFailureCode}`), { code: state.renameFailureCode })
      }
      return actual.rename(from, to)
    }
  }
})

const { writeJsonAtomic } = await import('../electron/services/atomicWrite')

let dir: string
beforeEach(async () => {
  state.failPartially = false
  state.renameFailures = 0
  state.renameFailureCode = 'EPERM'
  dir = await mkdtemp(join(tmpdir(), 'atomic-durable-'))
})
afterEach(async () => {
  state.failPartially = false
  await rm(dir, { recursive: true, force: true })
})

const strayTemps = async (): Promise<string[]> => (await readdir(dir)).filter((n) => n.includes('.tmp'))

describe('writeJsonAtomic rename retry', () => {
  // Windows fails a rename with EPERM/EACCES/EBUSY when a virus scanner or indexer holds a
  // transient handle on the destination. The retry that exists for it had no test -- deleting
  // it entirely left the suite green, on the step that commits every persisted store.
  for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    it(`retries through a transient ${code} and still commits`, async () => {
      const f = join(dir, 'store.json')
      state.renameFailureCode = code
      state.renameFailures = 3
      await writeJsonAtomic(f, { a: 1 })
      expect(JSON.parse(await readFile(f, 'utf-8'))).toEqual({ a: 1 })
      expect(state.renameFailures).toBe(0)
    })
  }

  it('gives up rather than retrying forever', async () => {
    const f = join(dir, 'store.json')
    state.renameFailures = 99
    await expect(writeJsonAtomic(f, { a: 1 })).rejects.toThrow('simulated EPERM')
  })

  it('does not retry an error that is not transient', async () => {
    // A missing directory or a permissions problem will not fix itself; retrying six times
    // just delays the failure the caller needs to see.
    const f = join(dir, 'store.json')
    state.renameFailureCode = 'ENOENT'
    state.renameFailures = 99
    await expect(writeJsonAtomic(f, { a: 1 })).rejects.toThrow('simulated ENOENT')
    expect(state.renameFailures).toBe(98)
  })
})

describe('writeJsonAtomic durability', () => {
  it('leaves the previous file complete when a write dies half-way', async () => {
    // livePositions.json is the case that matters: every store is read back with a
    // `catch { use defaults }`, which cannot tell a truncated file from a missing one -- so a
    // half-written ledger reads as empty, and the next persist makes that permanent.
    const f = join(dir, 'livePositions.json')
    await writeJsonAtomic(f, { positions: [{ symbol: 'BTCUSDT', qty: 0.5 }] })

    state.failPartially = true
    await expect(writeJsonAtomic(f, { positions: [] })).rejects.toThrow('simulated power loss')
    state.failPartially = false

    const onDisk = await readFile(f, 'utf-8')
    expect(() => JSON.parse(onDisk)).not.toThrow()
    expect(JSON.parse(onDisk)).toEqual({ positions: [{ symbol: 'BTCUSDT', qty: 0.5 }] })
  })

  it('leaves no half-written file at all when there was nothing there before', async () => {
    const f = join(dir, 'fresh.json')
    state.failPartially = true
    await expect(writeJsonAtomic(f, { a: 1 })).rejects.toThrow()
    state.failPartially = false

    // Absent is fine and reads as "no data yet". Present-but-truncated is not.
    await expect(readFile(f, 'utf-8')).rejects.toThrow()
  })

  it('cleans up its temp file when the write fails', async () => {
    const f = join(dir, 'store.json')
    state.failPartially = true
    await expect(writeJsonAtomic(f, { a: 1 })).rejects.toThrow()
    state.failPartially = false

    expect(await strayTemps()).toEqual([])
  })

  it('keeps working on that path after a failed write', async () => {
    const f = join(dir, 'store.json')
    state.failPartially = true
    await expect(writeJsonAtomic(f, { a: 1 })).rejects.toThrow()
    state.failPartially = false

    await writeJsonAtomic(f, { a: 2 })
    expect(JSON.parse(await readFile(f, 'utf-8'))).toEqual({ a: 2 })
    expect(await strayTemps()).toEqual([])
  })
})
