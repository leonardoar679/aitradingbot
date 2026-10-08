import { app } from 'electron'
import { readdir, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { RECORD_DIRECTORIES, staleCacheFile, type RecordDirectorySize, type RecordSizes } from '../../shared/retention'

// THE RECORDS ON DISK (the V5 document, §93; V5 Stage 12, 8 October 2026): the answer cache swept
// of files older than the retention at start, and the size of every record directory measured for
// the effective-config card and the start's log line (shared/retention.ts). The monthly files are
// never touched: a sweep here is of cached answers alone, each a file named by the question's hash,
// read back only for the same question. Nothing else is deleted, and nothing is rewritten.

const SIZES_TTL_MS = 5 * 60_000

let swept = 0
let cached: RecordSizes | null = null

function recordsRoot(): string {
  return app.getPath('userData')
}

/** Removes the cached answers older than the retention. Returns how many; 0 with no cache yet. */
export async function sweepAnswerCache(nowMs: number = Date.now()): Promise<number> {
  const dir = join(recordsRoot(), 'aiSignalCache')
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  let count = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (!info.isFile() || !staleCacheFile(info.mtimeMs, nowMs)) continue
      await unlink(path)
      count++
    } catch {
      // Gone between the listing and the look, or held by something: left alone.
    }
  }
  swept = count
  cached = null
  return count
}

async function measure(name: string): Promise<RecordDirectorySize> {
  const dir = join(recordsRoot(), name)
  let files = 0
  let bytes = 0
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        bytes += (await stat(join(entry.parentPath ?? dir, entry.name))).size
        files++
      } catch {
        // A file gone between the listing and the look.
      }
    }
  } catch {
    // Not there yet: nothing was ever recorded under it.
  }
  return { name, files, bytes }
}

/** What the record directories weigh, measured at most every five minutes. */
export async function recordSizes(force = false): Promise<RecordSizes> {
  if (!force && cached !== null && Date.now() - cached.at * 1000 < SIZES_TTL_MS) return cached
  const started = Date.now()
  const directories: RecordDirectorySize[] = []
  for (const name of RECORD_DIRECTORIES) directories.push(await measure(name))
  cached = { at: Math.floor(started / 1000), directories, cacheSwept: swept, tookMs: Date.now() - started }
  return cached
}

/** Test seam. */
export function resetRecordRetention(): void {
  swept = 0
  cached = null
}
