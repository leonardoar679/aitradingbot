import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CACHE_RETENTION_DAYS, RECORD_DIRECTORIES, describeRecordSizes, formatBytes, staleCacheFile } from '../shared/retention'

// The records on disk (shared/retention.ts, electron/services/recordRetentionService.ts; the V5
// document, §93): which cached answers the start sweeps, what is measured, and the words.

const ROOT = mkdtempSync(join(tmpdir(), 'retention-'))
vi.mock('electron', () => ({ app: { getPath: () => ROOT } }))

import { recordSizes, resetRecordRetention, sweepAnswerCache } from '../electron/services/recordRetentionService'

const NOW_MS = Date.parse('2026-10-08T12:00:00Z')
const DAY_MS = 86_400_000

afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('staleCacheFile', () => {
  it('is older than ninety days, strictly', () => {
    expect(CACHE_RETENTION_DAYS).toBe(90)
    expect(staleCacheFile(NOW_MS - 90 * DAY_MS - 1, NOW_MS)).toBe(true)
    expect(staleCacheFile(NOW_MS - 90 * DAY_MS, NOW_MS)).toBe(false)
    expect(staleCacheFile(NOW_MS - 89 * DAY_MS, NOW_MS)).toBe(false)
    expect(staleCacheFile(NOW_MS - 10 * DAY_MS - 1, NOW_MS, 10)).toBe(true)
    expect(staleCacheFile(NaN, NOW_MS)).toBe(false)
  })
})

describe('the sweep and the sizes', () => {
  beforeEach(() => {
    resetRecordRetention()
    rmSync(ROOT, { recursive: true, force: true })
    mkdirSync(join(ROOT, 'aiSignalCache'), { recursive: true })
    mkdirSync(join(ROOT, 'aiLedger'), { recursive: true })
    mkdirSync(join(ROOT, 'news', 'feed'), { recursive: true })
    const file = (path: string, content: string, ageDays: number): void => {
      writeFileSync(join(ROOT, path), content)
      const at = (NOW_MS - ageDays * DAY_MS) / 1000
      utimesSync(join(ROOT, path), at, at)
    }
    file('aiSignalCache/old.json', '{"a":1}', 120)
    file('aiSignalCache/edge.json', '{"a":2}', 90)
    file('aiSignalCache/fresh.json', '{"a":3}', 1)
    file('aiSignalCache/notes.txt', 'kept whatever its age', 400)
    file('aiLedger/calls-2026-10.jsonl', 'x'.repeat(1000), 1)
    file('news/feed/stories.jsonl', 'y'.repeat(300), 200)
  })

  it('sweeps the cached answers older than the retention and nothing else, and says so in the sizes', async () => {
    expect(await sweepAnswerCache(NOW_MS)).toBe(1)
    const sizes = await recordSizes(true)
    const of = (name: string): { files: number; bytes: number } | undefined => sizes.directories.find((directory) => directory.name === name)
    expect(of('aiSignalCache')).toEqual({ name: 'aiSignalCache', files: 3, bytes: 7 + 7 + 21 })
    expect(of('aiLedger')).toEqual({ name: 'aiLedger', files: 1, bytes: 1000 })
    expect(of('news')).toEqual({ name: 'news', files: 1, bytes: 300 })
    expect(of('marketEvents')).toEqual({ name: 'marketEvents', files: 0, bytes: 0 })
    expect(sizes.directories.map((directory) => directory.name)).toEqual([...RECORD_DIRECTORIES])
    expect(sizes.cacheSwept).toBe(1)
    expect(sizes.at).toBeGreaterThan(0)
    expect(describeRecordSizes(sizes)).toBe('The records weigh 1.3 KB in 5 files. The answer cache holds 3 files in 35 B. 1 cached answer older than 90 days was swept at start.')
  })

  it('sweeps nothing without a cache, and measures again only after five minutes unless forced', async () => {
    rmSync(join(ROOT, 'aiSignalCache'), { recursive: true, force: true })
    expect(await sweepAnswerCache(NOW_MS)).toBe(0)
    const first = await recordSizes()
    writeFileSync(join(ROOT, 'aiLedger', 'more.jsonl'), 'z'.repeat(50))
    expect((await recordSizes()).directories).toEqual(first.directories)
    expect((await recordSizes(true)).directories.find((directory) => directory.name === 'aiLedger')).toEqual({ name: 'aiLedger', files: 2, bytes: 1050 })
    expect(describeRecordSizes({ at: 1, directories: [], cacheSwept: 0, tookMs: 1 })).toBe('The records weigh 0 B in 0 files. No cached answer was older than 90 days at start.')
    expect(describeRecordSizes({ at: 1, directories: [{ name: 'aiSignalCache', files: 2649, bytes: 2_500_000 }], cacheSwept: 12, tookMs: 1 })).toBe(
      'The records weigh 2.4 MB in 2649 files. The answer cache holds 2649 files in 2.4 MB. 12 cached answers older than 90 days were swept at start.'
    )
  })
})

describe('formatBytes', () => {
  it('reads as a person would', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(20 * 1024)).toBe('20 KB')
    expect(formatBytes(2.7 * 1024 * 1024)).toBe('2.7 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
    expect(formatBytes(-5)).toBe('0 B')
  })
})
