/** Applies a page's own edits onto whatever storage holds right now, instead of overwriting
 * storage with the page's whole local array.
 *
 * ExecutorsPage keeps a local copy of settings.executors, refreshed by a 10s poll, and persists
 * by writing that array wholesale. LiveOrderScheduler patches the same array every 5s -- clearing
 * pendingLiveOrderIds when a resting order resolves, storing the liveWatcherId when an exit
 * watcher is armed, flipping status when a run finishes. Any page edit inside the gap wrote the
 * pre-patch copy back over all of it, so renaming one executor could make another's resolved
 * order look pending again and forget its armed exit watcher.
 *
 * `previous` is what the page last knew storage to be -- the snapshot it loaded or last polled.
 * Anything differing from it is an edit the page made and must win; anything identical to it the
 * page did not touch, so the fresh copy wins. That distinction is the whole fix: it is what lets
 * one page's edit stop meaning "everything I am not currently looking at reverts". */
export function mergeLocalEdits<T extends { id: string }>({
  previous,
  local,
  fresh
}: {
  previous: T[]
  local: T[]
  fresh: T[]
}): T[] {
  const previousById = new Map(previous.map((item) => [item.id, JSON.stringify(item)]))
  const freshById = new Map(fresh.map((item) => [item.id, item]))
  const localIds = new Set(local.map((item) => item.id))

  const merged: T[] = []

  for (const item of local) {
    const before = previousById.get(item.id)
    const untouched = before !== undefined && before === JSON.stringify(item)
    if (!untouched) {
      // The page created or changed this one. Its version is the edit being saved.
      merged.push(item)
      continue
    }
    const current = freshById.get(item.id)
    // Untouched here, and gone from storage: something else deleted it, so honour that.
    if (current !== undefined) merged.push(current)
  }

  for (const item of fresh) {
    if (localIds.has(item.id)) continue
    // Present in storage but not on the page. If the page knew about it, the page deleted it;
    // if it never did, something else created it after the page's last read.
    if (!previousById.has(item.id)) merged.push(item)
  }

  return merged
}
