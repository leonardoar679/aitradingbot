import type { ExecutorConfig } from '../../shared/ipc'
import { bookOf } from '../../shared/paperBooks'
import type { PaperTestingState } from '../../shared/paperTesting'
import { baselineBrowserDeps, closeBaselineTrades } from '../baseline/baselineTrade'
import { closeNewsBookShorts, newsBookBrowserDeps } from '../news/newsBookShort'
import { cloneBrowserDeps, closeClones } from '../traders/paperClone'
import { closeFollows, followBrowserDeps } from '../traders/paperFollow'

// STOP PAPER TESTING, IN THE WINDOW (V8 Stage 9, 27 October 2026). The main process stops the books and puts back
// every switch Start turned on (electron/services/paperTestingService.ts); then each book's open trades are closed at
// the price then by the writer that opened them -- the news book's shorts, the copy book's follows and clones, the
// baseline's trades -- each once, through the one queue of writes. The books stopped first, so no writer opens another
// while they close. And where a Stop was cut short, the app closed before its trades were, the trades of a stopped
// book still open are closed when the app next runs: a book's trade is never left open while the books are stopped.

/** Every book's open trade closed at the price then, by its own writer. The names of those closed. */
export async function closeBookTrades(): Promise<string[]> {
  const closers: [string, () => Promise<string[]>][] = [
    ["the news book's shorts", (): Promise<string[]> => closeNewsBookShorts(newsBookBrowserDeps)],
    ['the follows', (): Promise<string[]> => closeFollows(followBrowserDeps)],
    ["the clones' trades", (): Promise<string[]> => closeClones(cloneBrowserDeps)],
    ["the baseline's trades", (): Promise<string[]> => closeBaselineTrades(baselineBrowserDeps)]
  ]
  const closed: string[] = []
  for (const [what, close] of closers) {
    try {
      closed.push(...(await close()))
    } catch (error) {
      console.error(`Stopping paper testing could not close ${what}:`, error)
    }
  }
  return closed
}

/** The books' trades open now, of every run. */
export const openBookTrades = (executors: readonly ExecutorConfig[]): ExecutorConfig[] => executors.filter((executor) => executor.status === 'active' && bookOf(executor) !== 'other')

/** Stop: the books stopped and their switches put back, then their open trades closed. */
export async function stopPaperTesting(): Promise<{ state: PaperTestingState; closed: string[] }> {
  await window.api.books.stop()
  const closed = await closeBookTrades()
  return { state: await window.api.books.testing(), closed }
}

/** A Stop cut short finished: where the books are stopped and a trade of theirs is still open, it is closed now. */
export async function closeLeftoverBookTrades(): Promise<string[]> {
  const [{ running }, settings] = await Promise.all([window.api.books.state(), window.api.settings.get()])
  if (running || openBookTrades(settings.executors ?? []).length === 0) return []
  return closeBookTrades()
}
