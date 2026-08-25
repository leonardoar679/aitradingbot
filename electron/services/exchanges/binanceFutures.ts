import { createHmac } from 'crypto'
import { readableFuturesPositions, type FuturesReadout, type RawFuturesPosition } from '../../../shared/futuresPositions'

/** Reading a Binance USDT-M futures account. READ-ONLY, and structurally so.
 *
 * There is no order endpoint in this file and no function here that takes a side or a quantity.
 * That is the safety property, and it is worth more than a comment saying "be careful": this app
 * cannot open, close or modify a futures position because the code to do it does not exist. If
 * that ever changes it has to be a deliberate addition that passes canPlaceLiveOrder -- whose
 * size limits are denominated in exposure precisely so a leveraged order cannot slip under a
 * ceiling written for spot.
 *
 * Why read it at all: someone who has opened a leveraged position on Binance already has a
 * liquidation price whether they have looked at it or not. This app simulates that whole
 * mechanism in paper mode; showing the real one beside it costs nothing and risks nothing.
 *
 * Never log `apiSecret`, `apiKey` or the computed signature -- the same invariant the spot
 * module holds, for the same reason. */

/** Futures lives on its own host. Deliberately not routed through resolveEndpoint(): that picks
 * between binance.com and binance.us for spot, and binance.us has no futures API at all, so a
 * shared resolver would silently send these requests somewhere that answers 404 and report it as
 * a bad API key. */
const FUTURES_REST_ROOT = 'https://fapi.binance.com'

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

/** Binance rejects a signed request whose timestamp drifts from its own clock (-1021), so the
 * offset is measured against the exchange rather than trusting this machine's clock. Measured
 * against the FUTURES host specifically -- it is a separate service and need not agree with
 * spot's clock to the millisecond. */
async function futuresTimeOffset(): Promise<number> {
  const now = Date.now()
  if (now - serverTimeOffsetResolvedAt < SERVER_TIME_TTL_MS) return serverTimeOffsetMs
  const response = await fetch(`${FUTURES_REST_ROOT}/fapi/v1/time`)
  if (!response.ok) {
    throw new Error(`Binance futures time request failed: ${response.status} ${response.statusText}`)
  }
  const data = (await response.json()) as BinanceServerTimeResponse
  serverTimeOffsetMs = data.serverTime - Date.now()
  serverTimeOffsetResolvedAt = Date.now()
  return serverTimeOffsetMs
}

/** GET only. The method is not a parameter, so this helper cannot be handed a POST by a future
 * edit that meant well. */
async function signedGet(apiKey: string, apiSecret: string, path: string): Promise<unknown> {
  const offset = await futuresTimeOffset()
  const query = new URLSearchParams({ timestamp: String(Date.now() + offset) })
  query.set('signature', createHmac('sha256', apiSecret).update(query.toString()).digest('hex'))

  const response = await fetch(`${FUTURES_REST_ROOT}${path}?${query.toString()}`, {
    method: 'GET',
    headers: { 'X-MBX-APIKEY': apiKey }
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'msg' in body ? (body as BinanceErrorResponse).msg : response.statusText
    // A spot key without futures permission is the overwhelmingly likely cause of a 401 here, and
    // "Binance API error: <blank>" would send someone to regenerate a key that is perfectly fine.
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Binance futures rejected this key (${message}). A spot API key does not automatically have futures permission — check "Enable Futures" on the key, and that this machine's IP is allowlisted.`
      )
    }
    throw new Error(`Binance futures API error: ${message}`)
  }
  return body
}

/** Every position the futures account is actually holding, closest to liquidation first.
 *
 * Binance returns a row per symbol the account has ever touched; readableFuturesPositions drops
 * the flat ones and reports any it could not parse rather than coercing them to zero. */
export async function fetchFuturesPositions(apiKey: string, apiSecret: string): Promise<FuturesReadout> {
  const data = await signedGet(apiKey, apiSecret, '/fapi/v2/positionRisk')
  // A 200 whose body is not a list would otherwise fail somewhere inside the parser and surface
  // as an unrelated TypeError -- the same failure the spot balance reader had.
  if (!Array.isArray(data)) {
    throw new Error('Binance futures returned a position response that was not a list')
  }
  return readableFuturesPositions(data as RawFuturesPosition[])
}

export interface FuturesWalletBalance {
  asset: string
  /** Total wallet balance in that asset. */
  balance: number
  /** What is not already backing a position. */
  available: number
}

interface RawFuturesBalance {
  asset?: string
  balance?: string
  availableBalance?: string
}

/** The futures wallet, which is a different pot of money from the spot balance -- Binance keeps
 * them in separate accounts and a transfer between them is an explicit action. Reported
 * separately for that reason, never summed into the spot figure. */
export async function fetchFuturesBalances(apiKey: string, apiSecret: string): Promise<FuturesWalletBalance[]> {
  const data = await signedGet(apiKey, apiSecret, '/fapi/v2/balance')
  if (!Array.isArray(data)) {
    throw new Error('Binance futures returned a balance response that was not a list')
  }
  return (data as RawFuturesBalance[])
    .filter((row): row is RawFuturesBalance & { asset: string } => typeof row.asset === 'string' && row.asset !== '')
    .map((row) => ({
      asset: row.asset,
      // Left as NaN when unparseable rather than zeroed, the same choice the spot reader makes:
      // an unreadable balance is information, and a fabricated 0 says "you hold nothing".
      balance: Number(row.balance),
      available: Number(row.availableBalance)
    }))
    .filter((row) => !(row.balance === 0 && row.available === 0))
}
