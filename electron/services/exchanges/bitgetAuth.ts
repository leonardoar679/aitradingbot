import { createHmac } from 'crypto'
import { BITGET, fetchBitgetTime } from './bitget'

// BITGET, SIGNED REQUESTS (V7.1 Stage 7, 16 October 2026): the one place a Bitget key signs anything.
// The scheme is the unified account's (UTA, v3), as its quick start gives it and its SDKs spell it:
// the string to sign is the timestamp in milliseconds, the method in capitals, the path, "?" and the
// query where there is one, and the body where there is one; signed with HMAC-SHA256 under the
// secret and written in base64; sent as ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP and
// ACCESS-PASSPHRASE. A DEMO request carries one more header, `paptrading: 1`, and a demo key --
// made in Bitget's demo mode, not the real one -- and a real key sent with it is refused by Bitget.
//
// TWO CALLERS, KEPT APART. bitgetTrading.ts reads and, from Stage 9, trades the REAL account and
// never passes `demo: true`; bitgetDemoTrading.ts is the only module that does, and never passes
// `demo: false`: a test pins both. Nothing here checks a safety gate, and nothing here logs a key,
// a secret, a passphrase or a signature.
//
// A CLASSIC ACCOUNT. The same signing serves Bitget's Classic (v2) endpoints, which is how a key made
// on an account not upgraded to the unified account is read (bitgetAccount.ts): Bitget refuses every
// unified request on such an account with code 40084, carried on the refusal so the reader can tell it
// from every other refusal without reading the words.

export interface BitgetCredentials {
  apiKey: string
  apiSecret: string
  /** The passphrase set when the key was made; Bitget asks for it on every signed request. */
  passphrase: string
}

export type BitgetMethod = 'GET' | 'POST'

/** The header a demo request carries, and its value. */
export const BITGET_DEMO_HEADER = { name: 'paptrading', value: '1' } as const

/** The string a request is signed over. Exported for the test that holds it to the quick start's
 * examples. */
export function bitgetPreHash(timestampMs: string, method: BitgetMethod, path: string, query: string, body: string): string {
  return `${timestampMs}${method}${path}${query === '' ? '' : `?${query}`}${body}`
}

export function bitgetSignature(apiSecret: string, preHash: string): string {
  return createHmac('sha256', apiSecret).update(preHash).digest('base64')
}

/** Every header a signed request carries. */
export function bitgetHeaders(credentials: BitgetCredentials, timestampMs: string, method: BitgetMethod, path: string, query: string, body: string, demo: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'ACCESS-KEY': credentials.apiKey,
    'ACCESS-SIGN': bitgetSignature(credentials.apiSecret, bitgetPreHash(timestampMs, method, path, query, body)),
    'ACCESS-TIMESTAMP': timestampMs,
    'ACCESS-PASSPHRASE': credentials.passphrase,
    'Content-Type': 'application/json',
    locale: 'en-US'
  }
  if (demo) headers[BITGET_DEMO_HEADER.name] = BITGET_DEMO_HEADER.value
  return headers
}

interface Envelope<T> {
  code: string
  /** Bitget's words; its Classic (v2) documentation spells the key `message` in one example. */
  msg?: string
  message?: string
  data: T
}

const SUCCESS = '00000'
/** Bitget's code for a unified (v3) request on a Classic account: "You are in Classic Account mode,
 * and the Unified Account API is not supported at this time". */
export const CLASSIC_ACCOUNT_CODE = '40084'

/** A refusal with Bitget's own code and the HTTP status beside the words, so a caller can act on the
 * code -- a Classic account's 40084 -- without parsing the message. */
export class BitgetRefusal extends Error {
  readonly code: string
  readonly status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'BitgetRefusal'
    this.code = code
    this.status = status
  }
}

/** Whether a refusal is Bitget's for a unified request on a Classic account. */
export function isClassicRefusal(error: unknown): boolean {
  return error instanceof BitgetRefusal && error.code === CLASSIC_ACCOUNT_CODE
}
const REQUEST_TIMEOUT_MS = 15_000
const SERVER_TIME_TTL_MS = 5 * 60_000
let serverOffsetMs = 0
let serverOffsetReadAt = 0

/** How far Bitget's clock is from this machine's, read once in five minutes: a signed request's
 * timestamp must be near the exchange's own. A clock that cannot be read is taken as this one. */
async function serverOffset(): Promise<number> {
  if (Date.now() - serverOffsetReadAt < SERVER_TIME_TTL_MS) return serverOffsetMs
  try {
    const { serverTime, latencyMs } = await fetchBitgetTime()
    serverOffsetMs = serverTime + Math.round(latencyMs / 2) - Date.now()
  } catch {
    serverOffsetMs = 0
  }
  serverOffsetReadAt = Date.now()
  return serverOffsetMs
}

/** Test seam: the clock's offset is module state. */
export function resetBitgetClock(): void {
  serverOffsetMs = 0
  serverOffsetReadAt = 0
}

export interface BitgetRequest {
  method: BitgetMethod
  /** From the root on: "/api/v3/account/assets". */
  path: string
  query?: Record<string, string>
  body?: Record<string, unknown>
  /** Names the request in an error. */
  what: string
}

/** One signed request, its envelope opened: the data, or an error with Bitget's code and message. A
 * request's query string is the one signed, as sent. */
export async function bitgetSigned<T>(credentials: BitgetCredentials, request: BitgetRequest, demo: boolean): Promise<T> {
  const query = request.query === undefined ? '' : new URLSearchParams(request.query).toString()
  const body = request.body === undefined ? '' : JSON.stringify(request.body)
  const timestampMs = String(Date.now() + (await serverOffset()))
  const headers = bitgetHeaders(credentials, timestampMs, request.method, request.path, query, body, demo)
  const response = await fetch(`${BITGET.restRoot}${request.path}${query === '' ? '' : `?${query}`}`, {
    method: request.method,
    headers,
    ...(body === '' ? {} : { body }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  const envelope = (await response.json().catch(() => null)) as Envelope<T> | null
  if (!response.ok || envelope === null || envelope.code !== SUCCESS) {
    throw new BitgetRefusal(describeBitgetRefusal(request.what, response.status, envelope, demo), envelope?.code ?? '', response.status)
  }
  return envelope.data
}

/** Bitget's own words, with what they usually mean for a key typed into this app. */
export function describeBitgetRefusal(what: string, status: number, envelope: { code?: string; msg?: string; message?: string } | null, demo: boolean): string {
  const code = envelope?.code ?? ''
  const msg = envelope?.msg ?? envelope?.message ?? ''
  const said = envelope === null ? `${status}` : `${code} ${msg}`.trim()
  if (status === 429) return `Bitget ${what} failed: too many requests (${said}).`
  if (code === CLASSIC_ACCOUNT_CODE) {
    return `Bitget ${what} failed: ${said}. This key's account is in Classic mode: its balance is read, and an order needs the Unified Trading Account. Switch the account on Bitget (Assets, Upgrade to Unified Account), then test the key again on Connections.`
  }
  if (/passphrase/i.test(msg)) return `Bitget ${what} failed: ${said}. The passphrase is the one set when the key was made.`
  if (/sign|signature|timestamp/i.test(msg)) return `Bitget ${what} failed: ${said}. The secret, or this machine's clock, does not match the key.`
  if (/apikey|api key|access-key|does not exist|invalid key/i.test(msg) || status === 401) {
    return `Bitget ${what} failed: ${said}.${demo ? ' A demo request needs a key made in Bitget\'s demo mode, not the real one.' : ' A real request needs a key made in the real account, not a demo one.'}`
  }
  return `Bitget ${what} failed: ${said}`
}
