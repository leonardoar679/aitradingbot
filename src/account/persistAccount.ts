import type { PaperAccount } from '../../shared/ipc'
import { settingsWrites } from '../utils/settingsWrites'
import { emptyAccount } from './paperAccount'

/** Applies a change to the paper account as one read-modify-write under the shared settings
 * queue.
 *
 * Everything that touches money goes through here rather than writing settings.paperAccount
 * directly. settings.set replaces whole top-level values, so a caller holding a stale account and
 * writing it back would silently undo any movement that landed in between -- and for a balance,
 * "silently undo" means money appearing or disappearing.
 *
 * `mutate` must be pure (every function in paperAccount.ts is), because the queue may call it
 * against an account that is newer than the one the caller was looking at. */
export async function updateAccount(mutate: (account: PaperAccount) => PaperAccount, now: number): Promise<PaperAccount> {
  let result: PaperAccount | null = null
  await settingsWrites(async () => {
    const fresh = await window.api.settings.get()
    const current = fresh.paperAccount ?? emptyAccount(now)
    const next = mutate(current)
    result = next
    await window.api.settings.set({ paperAccount: next })
  })
  // settingsWrites resolves only after the callback has run, so this is set by here. The
  // non-null assertion is doing real work: returning a possibly-null account would push the
  // uncertainty onto every caller for a case that cannot happen.
  return result as unknown as PaperAccount
}

export async function readAccount(): Promise<PaperAccount | null> {
  const settings = await window.api.settings.get()
  return settings.paperAccount
}
