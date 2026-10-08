import type { CredentialStatus, ExecutorConfig, LiveTradingStatus, PaperAccount, PositionExecutorParams } from './ipc'

// THE PATH TO LIVE, READ (the second V3 document, §56): connect Binance, verify the key, trade on
// paper, run the 1-hour and 12-hour tests, prepare a trade from a call and place it yourself, then
// arm the session. Every step already exists in the app; this says where a person stands on them,
// from what is on file, and does nothing about any of them. Arming stays on the bar, the limits on
// Risk & Safety, the key on Connections.
//
// IT READS, AND IT OPENS AND ARMS NOTHING.

export type LivePathStepId = 'key' | 'verified' | 'paper' | 'hour' | 'twelve' | 'confirm' | 'armed'
export type LivePathState = 'done' | 'not yet' | 'not known'

export interface LivePathStep {
  id: LivePathStepId
  label: string
  state: LivePathState
  detail: string
}

/** What the session report said of a span: whether every gate that applies passed. */
export interface LivePathReport {
  passed: boolean
  fromSec: number
  toSec: number
}

export interface LivePathInput {
  /** Binance's credential entry; undefined while not read, null when there is none. */
  binance: CredentialStatus | null | undefined
  paperAccount: PaperAccount | null | undefined
  /** Whether the watch's paper trades are switched on; undefined while not read. */
  watchPaperOn: boolean | undefined
  executors: readonly ExecutorConfig[] | undefined
  /** The last hour's and the last twelve hours' reports; undefined until checked, null when one
   * could not be built. */
  hour: LivePathReport | null | undefined
  twelve: LivePathReport | null | undefined
  status: LiveTradingStatus | undefined
}

const day = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10)
const clock = (sec: number): string => new Date(sec * 1000).toISOString().slice(11, 16)

/** A position a person made from a call's filled-in form (shared/aiProposal.ts): named as the
 * form names it, or carrying the recommendation's entry range on paper; never one of the app's own. */
export function madeFromCall(executor: ExecutorConfig): boolean {
  if (executor.type !== 'position' || executor.watch !== undefined || executor.newsRule !== undefined) return false
  const params = executor.params as PositionExecutorParams
  return /^AI call /.test(executor.name) || (params.entryRange !== undefined && params.entryRange !== null)
}

function funded(account: PaperAccount | null | undefined): boolean {
  if (account === null || account === undefined) return false
  return Object.values(account.initialBalances ?? {}).some((amount) => amount > 0) || Object.values(account.balances ?? {}).some((amount) => amount > 0)
}

function report(id: 'hour' | 'twelve', label: string, span: string, value: LivePathReport | null | undefined): LivePathStep {
  if (value === undefined) return { id, label, state: 'not known', detail: `Not checked yet: press "Check the test runs" to read ${span} against the gates.` }
  if (value === null) return { id, label, state: 'not known', detail: `The report over ${span} could not be built.` }
  const when = `${day(value.fromSec)} ${clock(value.fromSec)} to ${clock(value.toSec)} UTC`
  return value.passed
    ? { id, label, state: 'done', detail: `Every gate that applies passed over ${when}.` }
    : { id, label, state: 'not yet', detail: `A gate failed over ${when}: see the session report on Performance.` }
}

/** The steps, in the document's order, each with where it stands. */
export function livePathSteps(input: LivePathInput): LivePathStep[] {
  const steps: LivePathStep[] = []
  const { binance } = input
  if (binance === undefined) steps.push({ id: 'key', label: 'Connect Binance', state: 'not known', detail: 'Not read yet.' })
  else if (binance === null || !binance.configured) steps.push({ id: 'key', label: 'Connect Binance', state: 'not yet', detail: 'No Binance key is stored. Add one on Connections.' })
  else steps.push({ id: 'key', label: 'Connect Binance', state: 'done', detail: `A Binance key is stored${binance.addedAt === null ? '' : `, added ${day(binance.addedAt)}`}.` })

  if (binance === undefined) steps.push({ id: 'verified', label: 'Verify the key', state: 'not known', detail: 'Not read yet.' })
  else if (binance === null || !binance.configured) steps.push({ id: 'verified', label: 'Verify the key', state: 'not yet', detail: 'Needs a key first.' })
  else if (binance.lastTestOk === true) steps.push({ id: 'verified', label: 'Verify the key', state: 'done', detail: `Tested${binance.lastTestedAt === null ? '' : ` ${day(binance.lastTestedAt)}`}: it works.` })
  else if (binance.lastTestOk === false) steps.push({ id: 'verified', label: 'Verify the key', state: 'not yet', detail: 'The last test of the key failed. Test it again on Connections.' })
  else steps.push({ id: 'verified', label: 'Verify the key', state: 'not yet', detail: 'The key has not been tested. Test it on Connections.' })

  if (input.paperAccount === undefined && input.watchPaperOn === undefined) steps.push({ id: 'paper', label: 'Trade on paper', state: 'not known', detail: 'Not read yet.' })
  else if (funded(input.paperAccount) || input.watchPaperOn === true) {
    const how = [funded(input.paperAccount) ? 'the paper account is funded' : null, input.watchPaperOn === true ? "the watch's paper trades are on" : null].filter((part) => part !== null)
    steps.push({ id: 'paper', label: 'Trade on paper', state: 'done', detail: `Paper trading is in use: ${how.join(', and ')}.` })
  } else steps.push({ id: 'paper', label: 'Trade on paper', state: 'not yet', detail: "Fund the paper account on Paper Trading, or switch on the watch's paper trades on Opportunities." })

  steps.push(report('hour', 'Run the 1-hour test', 'the last hour', input.hour))
  steps.push(report('twelve', 'Run the 12-hour test', 'the last twelve hours', input.twelve))

  if (input.executors === undefined) steps.push({ id: 'confirm', label: 'Prepare a trade from a call, and place it yourself', state: 'not known', detail: 'Not read yet.' })
  else {
    const made = input.executors.filter(madeFromCall)
    steps.push(
      made.length > 0
        ? { id: 'confirm', label: 'Prepare a trade from a call, and place it yourself', state: 'done', detail: `${made.length === 1 ? 'One position was' : `${made.length} positions were`} made from a call's filled-in form (${made.filter((entry) => entry.mode === 'live').length} of them live).` }
        : { id: 'confirm', label: 'Prepare a trade from a call, and place it yourself', state: 'not yet', detail: 'Prepare an order from a call on Opportunities or AI Decisions; the form opens on paper, and a person places it.' }
    )
  }

  if (input.status === undefined) steps.push({ id: 'armed', label: 'Arm the session', state: 'not known', detail: 'Not read yet.' })
  else if (input.status.killSwitchEngaged) steps.push({ id: 'armed', label: 'Arm the session', state: 'not yet', detail: 'The kill switch is engaged: no real order can be placed until it is released on the bar.' })
  else if (input.status.sessionArmed) steps.push({ id: 'armed', label: 'Arm the session', state: 'done', detail: 'The session is armed: a real order can be placed, through every gate, until the app closes.' })
  else steps.push({ id: 'armed', label: 'Arm the session', state: 'not yet', detail: 'Disarmed. Arm the session on the bar at the top once the steps above are done; it disarms itself when the app closes.' })
  return steps
}

/** One line: how many are done, and the first that is not. */
export function livePathSummary(steps: readonly LivePathStep[]): string {
  const done = steps.filter((step) => step.state === 'done').length
  const next = steps.find((step) => step.state !== 'done')
  if (next === undefined) return `Every step is done: ${done} of ${steps.length}.`
  return `${done} of ${steps.length} done. Next: ${next.label.toLowerCase()}${next.state === 'not known' ? ' (not read yet)' : ''}.`
}
