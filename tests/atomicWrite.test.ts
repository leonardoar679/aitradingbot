import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeJsonAtomic } from '../electron/services/atomicWrite'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'atomic-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const strayTemps = async (): Promise<string[]> => (await readdir(dir)).filter((n) => n.includes('.tmp'))

describe('writeJsonAtomic', () => {
  it('writes and then replaces an existing file', async () => {
    const f = join(dir, 'store.json')
    await writeJsonAtomic(f, { n: 1 })
    await writeJsonAtomic(f, { n: 2 })
    expect(JSON.parse(await readFile(f, 'utf-8')).n).toBe(2)
  })

  // Regression: a shared "<file>.tmp" name made the second writer's rename fail with ENOENT,
  // and on Windows competing renames to one destination throw EPERM.
  it('survives many concurrent writes to one store', async () => {
    const f = join(dir, 'store.json')
    await expect(
      Promise.all(Array.from({ length: 60 }, (_, i) => writeJsonAtomic(f, { n: i })))
    ).resolves.toBeDefined()
    expect(() => JSON.parse('')).toThrow() // sanity: parse failure is detectable
    expect(JSON.parse(await readFile(f, 'utf-8'))).toHaveProperty('n')
    expect(await strayTemps()).toEqual([])
  })

  it('survives concurrent writes across several stores', async () => {
    const files = [1, 2, 3, 4, 5].map((i) => join(dir, `s${i}.json`))
    await Promise.all(files.flatMap((p) => Array.from({ length: 30 }, (_, i) => writeJsonAtomic(p, { n: i }))))
    for (const p of files) expect(JSON.parse(await readFile(p, 'utf-8'))).toHaveProperty('n')
    expect(await strayTemps()).toEqual([])
  })

  it('preserves last-writer-wins ordering', async () => {
    const f = join(dir, 'order.json')
    await Promise.all(Array.from({ length: 30 }, (_, i) => writeJsonAtomic(f, { n: i })))
    expect(JSON.parse(await readFile(f, 'utf-8')).n).toBe(29)
  })

  it('does not poison later writes on a path after a failure', async () => {
    const good = join(dir, 'good.json')
    await expect(writeJsonAtomic(join(dir, 'missing-dir', 'x.json'), { a: 1 })).rejects.toThrow()
    await writeJsonAtomic(good, { n: 7 })
    expect(JSON.parse(await readFile(good, 'utf-8')).n).toBe(7)
    expect(await strayTemps()).toEqual([])
  })
})
