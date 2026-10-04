import { utcMidnight, watchCallProblem, watchEventIdsToday } from '../../shared/aiWatch'
import { getAiConfig } from './aiConfigService'
import { listAiCalls } from './aiLedgerService'

// The watch's limits, held where the money is spent (shared/aiWatch.ts).
//
// The renderer's scheduler decides which events to take up. This is the same decision made again
// in the main process, immediately before a call the watch asked for, from the two things only the
// main process owns: the setting, and the ledger. A scheduler that has gone wrong -- two passes at
// once, a count that drifted, a watch it still believes is on -- is refused here.
//
// ONE CHECK AT A TIME. Several of the watch's calls arrive together: every model for one event,
// and up to three events in a minute. Each has to see the ones before it, so the check, and the
// note that a call is in the air, are made in turn. A call's note is cleared in turn too: by then
// its row is in the ledger, so the next check finds the event in one place or the other and never
// in neither.

/** Events with a call of the watch's in the air, and how many. */
const inFlight = new Map<string, number>()
let turn: Promise<unknown> = Promise.resolve()

function inTurn<T>(work: () => Promise<T>): Promise<T> {
  const run = turn.then(work, work)
  turn = run.catch(() => undefined)
  return run
}

/** How many of today's rows are read to count the day's events. Far more than a day of the watch
 * can write: forty events, six models. */
const LEDGER_ROWS_READ = 5000

/** Runs a call the watch asked for, if its limits allow one. Throws, having asked nothing, when
 * they do not. */
export async function withinWatchLimits<T>(call: { model: string; eventId: string; eventTime: number }, work: () => Promise<T>): Promise<T> {
  await inTurn(async () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const [config, page] = await Promise.all([getAiConfig(), listAiCalls({ source: 'watch', sinceSec: utcMidnight(nowSec), limit: LEDGER_ROWS_READ })])
    const takenToday = watchEventIdsToday(page.rows, nowSec)
    for (const eventId of inFlight.keys()) takenToday.add(eventId)
    const problem = watchCallProblem({ watch: config.watch, ...call, nowSec, takenToday })
    if (problem !== null) throw new Error(problem)
    inFlight.set(call.eventId, (inFlight.get(call.eventId) ?? 0) + 1)
  })
  try {
    return await work()
  } finally {
    await inTurn(async () => {
      const left = (inFlight.get(call.eventId) ?? 1) - 1
      if (left > 0) inFlight.set(call.eventId, left)
      else inFlight.delete(call.eventId)
    })
  }
}
