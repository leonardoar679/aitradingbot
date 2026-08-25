import { createHash, createHmac } from 'crypto'
import type { AccountBalance } from './binanceTrading'

// Authenticated Upbit access -- reading the account, nothing more. Upbit cannot place an order
// from this app (see TRADING_EXCHANGES in credentialsService), so nothing here writes anything.
//
// Never log `secretKey`, `accessKey`, or the signed token: the token IS a credential for the
// length of its life, and the same rule the Binance module follows applies here.

const REST_ROOT = 'https://api.upbit.com/v1'

interface UpbitAccountRow {
  currency: string
  balance: string
  locked: string
}

interface UpbitError {
  error?: { name?: string; message?: string }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** Builds the JWT Upbit expects in the Authorization header.
 *
 * Upbit does not sign the request the way Binance does -- there is no signature parameter on the
 * query. It takes an HS256 JWT whose payload carries the access key and a nonce, and, for a
 * request that has query parameters, a SHA512 hash of that query string so the parameters cannot
 * be altered in flight. A request with no parameters carries no hash at all; sending an empty one
 * is rejected rather than ignored.
 *
 * Exported so it can be tested. A signing function that is only exercised through a live network
 * call is a signing function nobody can check -- and the failure mode of getting it wrong is an
 * authentication error that says nothing about which part was wrong. */
export function upbitAuthToken(accessKey: string, secretKey: string, query?: string, nonce?: string): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const claims: Record<string, string> = {
    access_key: accessKey,
    // Upbit requires this to be unique per request. crypto.randomUUID is what the rest of this
    // app already uses for ids; a timestamp would collide for two requests in the same
    // millisecond, which is exactly what a page that reads on mount and on a timer can produce.
    nonce: nonce ?? crypto.randomUUID()
  }
  if (query !== undefined && query !== '') {
    claims.query_hash = createHash('sha512').update(query).digest('hex')
    claims.query_hash_alg = 'SHA512'
  }
  const payload = base64Url(JSON.stringify(claims))
  const signature = base64Url(createHmac('sha256', secretKey).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${signature}`
}

function describeUpbitError(status: number, body: unknown): string {
  const named = (body as UpbitError | null)?.error
  if (named?.message) {
    // Upbit's own wording, which names the actual cause -- an IP not on the allowlist, a key
    // without the right scope. Far more useful than the status code, and the reason this is not
    // flattened into a generic message.
    return `Upbit API error: ${named.message}${named.name ? ` (${named.name})` : ''}`
  }
  if (status === 401) {
    return 'Upbit rejected the key. Upbit requires the IP address making the request to be on the key\'s allowlist — check that, and that the key has the "asset lookup" permission.'
  }
  return `Upbit API error: ${status}`
}

/** Reads the account. The only authenticated call this app makes to Upbit, and it places no
 * order and changes nothing -- a read-only key is enough, and is what the Settings page tells
 * the user to create. */
export async function fetchUpbitBalances(accessKey: string, secretKey: string): Promise<AccountBalance[]> {
  const response = await fetch(`${REST_ROOT}/accounts`, {
    headers: { Authorization: `Bearer ${upbitAuthToken(accessKey, secretKey)}` }
  })
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) throw new Error(describeUpbitError(response.status, body))
  // Same reasoning as the Binance reader: a 200 whose body is not the documented shape must say
  // so, rather than failing as "rows.map is not a function" and reaching the user as the reason
  // their API key was rejected.
  if (!Array.isArray(body)) throw new Error('Upbit returned an account response that was not a list of balances')

  return (body as UpbitAccountRow[]).map((row) => ({
    asset: row.currency,
    // Left to become NaN rather than defaulted to 0, exactly as the Binance reader does:
    // readableBalances reports an unreadable amount by name, and a 0 substituted here would
    // instead tell the user they hold nothing.
    free: Number(row.balance),
    locked: Number(row.locked)
  }))
}
