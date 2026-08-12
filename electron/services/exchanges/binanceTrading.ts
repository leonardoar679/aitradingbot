import { createHmac } from 'crypto'
import { resolveEndpoint } from './binance'

// Live-trading groundwork for Binance only (see live-trading design plan — Phase A is limited to
// this one authenticated, read-only call, used solely to verify a newly-entered API key/secret
// before it's ever persisted). No order placement exists yet.

export interface AccountBalance {
  asset: string
  free: number
  locked: number
}

interface BinanceAccountResponse {
  balances: { asset: string; free: string; locked: string }[]
}

interface BinanceErrorResponse {
  code: number
  msg: string
}

interface BinanceServerTimeResponse {
  serverTime: number
}

let serverTimeOffsetMs = 0
let serverTimeOffsetResolvedAt = 0
const SERVER_TIME_TTL_MS = 5 * 60 * 1000

// Binance rejects signed requests whose `timestamp` drifts too far from its own clock (error
// -1021), so the offset from the local clock is measured against Binance's own `/time` endpoint
// rather than trusting the machine's clock to be accurate.
async function getServerTimeOffset(restRoot: string): Promise<number> {
  const now = Date.now()
  if (now - serverTimeOffsetResolvedAt < SERVER_TIME_TTL_MS) return serverTimeOffsetMs
  const response = await fetch(`${restRoot}/time`)
  if (!response.ok) throw new Error(`Binance time request failed: ${response.status} ${response.statusText}`)
  const data = (await response.json()) as BinanceServerTimeResponse
  serverTimeOffsetMs = data.serverTime - Date.now()
  serverTimeOffsetResolvedAt = Date.now()
  return serverTimeOffsetMs
}

// Never log `apiSecret`, `apiKey`, or the computed `signature` — an invariant enforced across
// this whole module, since a leaked API secret is equivalent to a leaked key.
async function signedRequest(
  apiKey: string,
  apiSecret: string,
  path: string,
  params: Record<string, string>,
  method: 'GET' | 'POST' | 'DELETE'
): Promise<unknown> {
  const endpoint = await resolveEndpoint()
  const offset = await getServerTimeOffset(endpoint.restRoot)
  const timestamp = Date.now() + offset

  const query = new URLSearchParams({ ...params, timestamp: String(timestamp) })
  const signature = createHmac('sha256', apiSecret).update(query.toString()).digest('hex')
  query.set('signature', signature)

  const response = await fetch(`${endpoint.restRoot}${path}?${query.toString()}`, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey }
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'msg' in body ? (body as BinanceErrorResponse).msg : response.statusText
    throw new Error(`Binance API error: ${message}`)
  }
  return body
}

/** The one authenticated call Phase A needs: proves a key/secret pair is valid and can read the
 * account, without placing any order. */
export async function fetchAccountBalance(apiKey: string, apiSecret: string): Promise<AccountBalance[]> {
  const data = (await signedRequest(apiKey, apiSecret, '/account', {}, 'GET')) as BinanceAccountResponse
  return data.balances.map((b) => ({ asset: b.asset, free: Number(b.free), locked: Number(b.locked) }))
}
