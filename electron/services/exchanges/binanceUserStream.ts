import { userStreamUrl } from '../../../shared/userStream'
import { resolveTradingEndpoint } from './binance'

// THE LISTEN KEY (the V5 document, §101; V5 Stage 11, 8 October 2026). Binance's user-data stream
// is reached with a listen key: asked for with the API key alone in a header -- no signature, no
// secret -- kept alive every thirty minutes, and closed when the stream is. The key is never logged.
// Nothing here places, cancels or sizes an order.

interface ListenKeyResponse {
  listenKey?: unknown
  msg?: unknown
}

async function listenKeyRequest(apiKey: string, method: 'POST' | 'PUT' | 'DELETE', listenKey: string | null): Promise<ListenKeyResponse | null> {
  const endpoint = await resolveTradingEndpoint()
  const query = listenKey === null ? '' : `?listenKey=${encodeURIComponent(listenKey)}`
  const response = await fetch(`${endpoint.restRoot}/userDataStream${query}`, { method, headers: { 'X-MBX-APIKEY': apiKey } })
  const body = (await response.json().catch(() => null)) as ListenKeyResponse | null
  if (!response.ok) {
    const message = body !== null && typeof body.msg === 'string' ? body.msg : `${response.status} ${response.statusText}`
    throw new Error(`Binance listen key ${method === 'POST' ? 'request' : method === 'PUT' ? 'keep-alive' : 'close'} failed: ${message}`)
  }
  return body
}

/** A listen key for the account: POST /userDataStream. Binance answers the key already open, where
 * one is, so asking twice does not open two streams. */
export async function createListenKey(apiKey: string): Promise<string> {
  const body = await listenKeyRequest(apiKey, 'POST', null)
  if (body === null || typeof body.listenKey !== 'string' || body.listenKey === '') throw new Error('Binance listen key request answered with no key.')
  return body.listenKey
}

/** Keeps the key open another sixty minutes: PUT /userDataStream. */
export async function keepAliveListenKey(apiKey: string, listenKey: string): Promise<void> {
  await listenKeyRequest(apiKey, 'PUT', listenKey)
}

/** Closes the key, and with it the stream: DELETE /userDataStream. */
export async function closeListenKey(apiKey: string, listenKey: string): Promise<void> {
  await listenKeyRequest(apiKey, 'DELETE', listenKey)
}

/** The stream's address: the trading host's socket base and the key -- or, for a check against a
 * local server with the key header faked away, the base USER_STREAM_URL names. */
export async function userStreamAddress(listenKey: string): Promise<string> {
  const seam = process.env.USER_STREAM_URL
  const base = seam !== undefined && seam !== '' ? seam : (await resolveTradingEndpoint()).wsBase
  return userStreamUrl(base, listenKey)
}
