import { OKX_HOST, OKX_LINES, okxCoinOf } from '../../shared/traders/okx'
import { okxBudget } from './httpPacing'

// OKX'S PUBLIC COPY-TRADING RECORD (V8 Stage 7, 27 October 2026): a lead trader's closed positions over the last three
// months, the positions open now, their profit day by day over a year and their year's figures, the instruments'
// contract values, and the funding OKX published for each instrument the trader held -- keyless GET requests to
// www.okx.com, each endpoint at most one request a half second (electron/services/httpPacing.ts). A dropped connection
// or a busy host is asked again twice, a little later each time; OKX's refusal of the question is not. Nothing here signs
// anything, reads a key or writes to OKX.

export const OKX_PATHS = {
  history: '/api/v5/copytrading/public-subpositions-history',
  current: '/api/v5/copytrading/public-current-subpositions',
  pnl: '/api/v5/copytrading/public-pnl',
  stats: '/api/v5/copytrading/public-stats',
  instruments: '/api/v5/public/instruments',
  funding: '/api/v5/public/funding-rate-history'
} as const

/** What the client reads the world through: a test hands in its own. */
export const okxSeam = {
  fetch: (url: string): Promise<Response> => fetch(url, { signal: AbortSignal.timeout(15_000) }),
  take: (endpoint: string): Promise<void> => okxBudget.take(endpoint),
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  now: (): number => Date.now()
}

const RETRY_DELAYS_MS = [2000, 6000]

/** One GET to a public endpoint: its data, or why there is none. */
export async function okxGet(path: string, query: Record<string, string>): Promise<unknown[]> {
  let last: unknown = null
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await okxSeam.sleep(RETRY_DELAYS_MS[attempt - 1])
    await okxSeam.take(path)
    try {
      const response = await okxSeam.fetch(`${OKX_HOST}${path}?${new URLSearchParams(query)}`)
      if (response.status >= 400 && response.status < 500 && response.status !== 429) throw Object.assign(new Error(`OKX answered ${response.status}`), { final: true })
      if (!response.ok) throw new Error(`OKX answered ${response.status}`)
      const body = (await response.json()) as { code?: unknown; msg?: unknown; data?: unknown }
      if (body.code !== '0' || !Array.isArray(body.data)) throw Object.assign(new Error(`OKX answered ${String(body.code ?? '?')}: ${typeof body.msg === 'string' && body.msg !== '' ? body.msg : 'no data'}`), { final: body.code !== '50011' })
      return body.data
    } catch (error) {
      if ((error as { final?: boolean }).final === true) throw error
      last = error
    }
  }
  throw new Error(`OKX could not be read: ${last instanceof Error ? last.message : String(last)}`)
}

/** What a lead trader's record holds, as OKX answered: read into shapes by shared/traders/okx.ts. */
export interface OkxAnswers {
  history: unknown[]
  current: unknown[]
  pnl: unknown[]
  stats: unknown[]
  instruments: unknown[]
  /** Each instrument's funding history, by its id. */
  funding: Record<string, unknown[]>
  /** OKX holds more closed positions than were read. */
  capped: boolean
}

let instrumentsHeld: { at: number; rows: unknown[] } | null = null
const INSTRUMENTS_MAX_AGE_MS = 6 * 3600_000

/** A lead trader's whole record, as far as OKX gives it. */
export async function fetchOkxRecord(code: string, onStep: (step: string) => void = () => undefined): Promise<OkxAnswers> {
  onStep('positions')
  const history: unknown[] = []
  let after: string | null = null
  let capped = false
  for (let page = 0; ; page++) {
    if (page >= OKX_LINES.maxHistoryPages) {
      capped = true
      break
    }
    const rows = await okxGet(OKX_PATHS.history, { instType: 'SWAP', uniqueCode: code, limit: String(OKX_LINES.historyPage), ...(after === null ? {} : { after }) })
    history.push(...rows)
    const last = rows[rows.length - 1] as { subPosId?: unknown } | undefined
    if (rows.length < OKX_LINES.historyPage || typeof last?.subPosId !== 'string') break
    after = last.subPosId
  }
  onStep('open positions')
  const current = await okxGet(OKX_PATHS.current, { instType: 'SWAP', uniqueCode: code, limit: String(OKX_LINES.currentPage) })
  onStep('the year')
  const pnl = await okxGet(OKX_PATHS.pnl, { instType: 'SWAP', uniqueCode: code, lastDays: '4' })
  const stats = await okxGet(OKX_PATHS.stats, { instType: 'SWAP', uniqueCode: code, lastDays: '4' })
  onStep('instruments')
  if (instrumentsHeld === null || okxSeam.now() - instrumentsHeld.at >= INSTRUMENTS_MAX_AGE_MS) instrumentsHeld = { at: okxSeam.now(), rows: await okxGet(OKX_PATHS.instruments, { instType: 'SWAP' }) }
  const instruments = instrumentsHeld.rows

  // The funding each USDT-margined perpetual the trader held published, back past their first opening there.
  const firstOpen = new Map<string, number>()
  for (const row of history) {
    const entry = row as { instId?: unknown; openTime?: unknown }
    const openMs = Number(entry.openTime)
    if (okxCoinOf(entry.instId) === null || !Number.isFinite(openMs)) continue
    const id = entry.instId as string
    firstOpen.set(id, Math.min(firstOpen.get(id) ?? Infinity, openMs))
  }
  const funding: Record<string, unknown[]> = {}
  for (const [instId, openMs] of [...firstOpen.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    onStep(`funding of ${instId}`)
    const rows: unknown[] = []
    let before: string | null = null
    for (let page = 0; page < OKX_LINES.maxFundingPages; page++) {
      const answer = await okxGet(OKX_PATHS.funding, { instId, limit: String(OKX_LINES.fundingPage), ...(before === null ? {} : { after: before }) })
      rows.push(...answer)
      const times = answer.map((row) => Number((row as { fundingTime?: unknown }).fundingTime)).filter(Number.isFinite)
      if (answer.length < OKX_LINES.fundingPage || times.length === 0) break
      const oldest = Math.min(...times)
      if (oldest <= openMs - 8 * 3600_000) break
      before = String(oldest)
    }
    funding[instId] = rows
  }
  return { history, current, pnl, stats, instruments, funding, capped }
}

/** Test seam. */
export function resetOkxClient(): void {
  instrumentsHeld = null
}
