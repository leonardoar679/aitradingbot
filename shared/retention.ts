// THE RECORDS ON DISK (the V5 document, §93; V5 Stage 12, 8 October 2026). The monthly files are
// kept whole: the daily report reads thirty days back and the Research tab up to ninety, and the
// files are small. The answer cache (aiSignalCache/, one file per decision) is the one store that
// only grows and is never read back after a few days: an answer is served from it only for the
// same question, which a market moves on from. It is swept of files older than CACHE_RETENTION_DAYS
// at start. The sizes of every record directory go on the effective-config card, so that what the
// app keeps is never a guess. Everything here is arithmetic; the sweep itself is the main
// process's (electron/services/recordRetentionService.ts).

/** A cached answer older than this, by its file's modification time, is swept at start. */
export const CACHE_RETENTION_DAYS = 90

/** Whether a cache file last written at `modifiedMs` is older than the retention at `nowMs`. A
 * file exactly at the line is kept: "older than ninety days" is strict. */
export function staleCacheFile(modifiedMs: number, nowMs: number, days: number = CACHE_RETENTION_DAYS): boolean {
  if (!Number.isFinite(modifiedMs) || !Number.isFinite(nowMs)) return false
  return nowMs - modifiedMs > days * 86_400_000
}

export interface RecordDirectorySize {
  /** The directory's name under the profile, e.g. `aiLedger`. */
  name: string
  files: number
  bytes: number
}

export interface RecordSizes {
  /** Seconds: when the directories were measured. */
  at: number
  directories: RecordDirectorySize[]
  /** Cached answers swept at this start, by the retention. */
  cacheSwept: number
  /** Milliseconds the measuring took, so a slow disk is seen. */
  tookMs: number
}

/** The record directories measured, in the order shown. */
export const RECORD_DIRECTORIES = ['aiLedger', 'aiSignalCache', 'marketEvents', 'paperRefusals', 'alerts', 'news', 'aiExperiments'] as const

export function formatBytes(bytes: number): string {
  if (!(bytes >= 0) || !Number.isFinite(bytes)) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/** One sentence for the log and the card: what the records weigh, and what the sweep did. */
export function describeRecordSizes(sizes: RecordSizes): string {
  const total = sizes.directories.reduce((sum, directory) => sum + directory.bytes, 0)
  const files = sizes.directories.reduce((sum, directory) => sum + directory.files, 0)
  const cache = sizes.directories.find((directory) => directory.name === 'aiSignalCache')
  const swept =
    sizes.cacheSwept > 0
      ? ` ${sizes.cacheSwept} cached answer${sizes.cacheSwept === 1 ? '' : 's'} older than ${CACHE_RETENTION_DAYS} days ${sizes.cacheSwept === 1 ? 'was' : 'were'} swept at start.`
      : ` No cached answer was older than ${CACHE_RETENTION_DAYS} days at start.`
  const cacheWords = cache === undefined ? '' : ` The answer cache holds ${cache.files} file${cache.files === 1 ? '' : 's'} in ${formatBytes(cache.bytes)}.`
  return `The records weigh ${formatBytes(total)} in ${files} file${files === 1 ? '' : 's'}.${cacheWords}${swept}`
}
