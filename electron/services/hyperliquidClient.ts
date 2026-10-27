import { HYPERLIQUID_INFO_URL } from '../../shared/traders/hyperliquid'
import { hyperliquidBudget } from './httpPacing'

// HYPERLIQUID'S PUBLIC INFO API (V8 Stage 6, 26 October 2026): an address's account, its fills, its funding, its
// deposits and withdrawals and its account's value through time -- keyless reads, each costed against the app's share
// of Hyperliquid's weight a minute before it is sent (electron/services/httpPacing.ts). The info endpoint takes its
// question as a POST of JSON; it reads, and nothing here writes to Hyperliquid or signs anything. A failed request is
// asked again twice, a little later each time: from this machine, Hyperliquid has been seen to drop a connection.

export const HYPERLIQUID_LINES = {
  /** The weight each question is costed at: Hyperliquid's own, with a full page's extra for the lists. */
  weights: { clearinghouseState: 2, portfolio: 20, userFillsByTime: 120, userFunding: 45, userNonFundingLedgerUpdates: 120 },
  /** A page of fills is at most 2,000. Hyperliquid's documents give its most recent 10,000 fills; it has given more
   * (over 12,000 for a busy address on 27 October 2026), read oldest first from the window's start, so the pages run to
   * the window's end -- the trader's newest fill -- up to fifteen. A record of the window's 10,000 or more is one
   * Hyperliquid cut: older fills are not given. */
  fillsPage: 2000,
  maxFillPages: 15,
  windowFills: 10_000,
  fundingPage: 500,
  maxFundingPages: 40,
  ledgerPage: 2000,
  maxLedgerPages: 5,
  timeoutMs: 20_000,
  retryDelaysMs: [2000, 6000]
} as const

/** What the client reads the world through: a test hands in its own. */
export const hyperliquidSeam = {
  fetch: (url: string, init: RequestInit): Promise<Response> => fetch(url, init),
  spend: (weight: number): Promise<void> => hyperliquidBudget.spend(weight),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
}

type Question = 'clearinghouseState' | 'portfolio' | 'userFillsByTime' | 'userFunding' | 'userNonFundingLedgerUpdates'

/** One question to the info endpoint: costed, asked, and asked again after a failure. */
export async function hyperliquidInfo<T>(type: Question, body: Record<string, unknown>): Promise<T> {
  let last: unknown = null
  for (let attempt = 0; attempt <= HYPERLIQUID_LINES.retryDelaysMs.length; attempt++) {
    if (attempt > 0) await hyperliquidSeam.sleep(HYPERLIQUID_LINES.retryDelaysMs[attempt - 1])
    await hyperliquidSeam.spend(HYPERLIQUID_LINES.weights[type])
    try {
      const response = await hyperliquidSeam.fetch(HYPERLIQUID_INFO_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type, ...body }),
        signal: AbortSignal.timeout(HYPERLIQUID_LINES.timeoutMs)
      })
      // A refusal of the question itself is not asked again; a busy or failing host is.
      if (response.status >= 400 && response.status < 500 && response.status !== 429) throw Object.assign(new Error(`Hyperliquid answered ${response.status}`), { final: true })
      if (!response.ok) throw new Error(`Hyperliquid answered ${response.status}`)
      return (await response.json()) as T
    } catch (error) {
      if ((error as { final?: boolean }).final === true) throw error
      last = error
    }
  }
  throw new Error(`Hyperliquid could not be read: ${last instanceof Error ? last.message : String(last)}`)
}

/** What an address's record holds, as Hyperliquid answered: read into shapes by shared/traders/hyperliquid.ts. */
export interface HyperliquidAnswers {
  state: unknown
  portfolio: unknown
  fills: unknown[]
  funding: unknown[]
  ledger: unknown[]
  /** Where a list may go on past what was read: more fills than Hyperliquid gives, or a cap reached. */
  fillsCapped: boolean
}

const timeOf = (row: unknown): number | null => {
  const time = (row as { time?: unknown } | null)?.time
  return typeof time === 'number' && Number.isFinite(time) ? time : null
}

/** A list read page by page from a start time, oldest first, until a page comes back short. */
async function paged(type: Question, user: string, startMs: number, pageSize: number, maxPages: number, keyOf: (row: unknown) => string): Promise<{ rows: unknown[]; capped: boolean }> {
  const rows = new Map<string, unknown>()
  let cursor = startMs
  for (let page = 0; page < maxPages; page++) {
    const answer = await hyperliquidInfo<unknown>(type, type === 'userFillsByTime' ? { user, startTime: cursor, aggregateByTime: false } : { user, startTime: cursor })
    if (!Array.isArray(answer) || answer.length === 0) return { rows: [...rows.values()], capped: false }
    for (const row of answer) rows.set(keyOf(row), row)
    if (answer.length < pageSize) return { rows: [...rows.values()], capped: false }
    const last = timeOf(answer[answer.length - 1])
    if (last === null) return { rows: [...rows.values()], capped: false }
    // The next page from the last time read: a millisecond shared across pages is read again and kept once.
    cursor = last > cursor ? last : last + 1
  }
  return { rows: [...rows.values()], capped: true }
}

/** An address's whole record, as far as Hyperliquid gives it: its account now, its value through time, its fills (those
 * of Hyperliquid's window, to its newest), and its funding and ledger from its first fill on. */
export async function fetchHyperliquidRecord(address: string, onStep: (step: string) => void = () => undefined): Promise<HyperliquidAnswers> {
  onStep('account')
  const state = await hyperliquidInfo<unknown>('clearinghouseState', { user: address })
  const portfolio = await hyperliquidInfo<unknown>('portfolio', { user: address })
  onStep('fills')
  const fills = await paged('userFillsByTime', address, 0, HYPERLIQUID_LINES.fillsPage, HYPERLIQUID_LINES.maxFillPages, (row) => String((row as { tid?: unknown }).tid))
  const first = fills.rows.map(timeOf).filter((time): time is number => time !== null).reduce((a, b) => Math.min(a, b), Infinity)
  const from = Number.isFinite(first) ? first : 0
  onStep('funding')
  const funding = await paged('userFunding', address, from, HYPERLIQUID_LINES.fundingPage, HYPERLIQUID_LINES.maxFundingPages, (row) => `${timeOf(row)}:${String((row as { delta?: { coin?: unknown } }).delta?.coin)}`)
  onStep('ledger')
  const ledger = await paged('userNonFundingLedgerUpdates', address, 0, HYPERLIQUID_LINES.ledgerPage, HYPERLIQUID_LINES.maxLedgerPages, (row) => `${timeOf(row)}:${String((row as { hash?: unknown }).hash)}:${JSON.stringify((row as { delta?: unknown }).delta)}`)
  return { state, portfolio, fills: fills.rows, funding: funding.rows, ledger: ledger.rows, fillsCapped: fills.capped || fills.rows.length >= HYPERLIQUID_LINES.windowFills }
}
