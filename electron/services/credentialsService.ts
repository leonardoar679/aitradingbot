import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFile, mkdir } from 'fs/promises'
import { writeJsonAtomic } from './atomicWrite'
import { fetchAccountBalance, type AccountBalance } from './exchanges/binanceTrading'
import { readableBalances } from '../../shared/liveBalances'
import type { CredentialStatus, Exchange, LiveBalanceSnapshot } from '../../shared/ipc'

// Credentials live in their own file, separate from settings.json, so a bug in general settings
// persistence can never touch secrets. Each key/secret is encrypted at rest via Electron's
// safeStorage (OS keychain / DPAPI-backed) — this module is the only place that ever handles a
// decrypted secret, and it must never log one.

interface StoredCredential {
  apiKeyEnc: string
  apiSecretEnc: string
  addedAt: number
  lastTestedAt: number | null
  lastTestOk: boolean | null
}

type StoredCredentialsFile = Partial<Record<Exchange, StoredCredential>>

// Only Binance has an authenticated adapter today (see the live-trading design plan). This is
// the single point that grows as more exchanges gain real account access — storage itself stays
// generic per-exchange so that expansion doesn't require a schema change.
//
// One call does two jobs on purpose: it verifies a key before that key is ever stored, and it is
// what the Account page reads. Anything listed here can therefore be connected AND shown, so an
// exchange can never end up trusted for orders while being unable to say what is in the account.
const BALANCE_READERS: Partial<Record<Exchange, (apiKey: string, apiSecret: string) => Promise<AccountBalance[]>>> = {
  binance: fetchAccountBalance
}

/** How long a balance read is reused before the exchange is asked again.
 *
 * Short, because this exists for two specific reasons rather than to keep data fresh: React
 * StrictMode mounts every effect twice in development, and the Account page is easy to leave and
 * come back to. Both would otherwise spend a signed, weighted request to learn a number that has
 * not moved. Anything the user does that changes their balance goes through an explicit action,
 * and Refresh bypasses this entirely. */
const BALANCE_TTL_MS = 15_000

const balanceCache = new Map<Exchange, LiveBalanceSnapshot>()

let cache: StoredCredentialsFile | null = null

function credentialsPath(): string {
  return join(app.getPath('userData'), 'credentials.json')
}

async function load(): Promise<StoredCredentialsFile> {
  if (cache) return cache
  try {
    const raw = await readFile(credentialsPath(), 'utf-8')
    cache = JSON.parse(raw) as StoredCredentialsFile
  } catch {
    cache = {}
  }
  return cache
}

async function persist(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(credentialsPath(), cache)
}

function encrypt(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level credential encryption is not available on this machine')
  }
  return safeStorage.encryptString(value).toString('base64')
}

function decrypt(value: string): string {
  return safeStorage.decryptString(Buffer.from(value, 'base64'))
}

function toStatus(exchange: Exchange, entry: StoredCredential | undefined): CredentialStatus {
  return {
    exchange,
    configured: entry !== undefined,
    addedAt: entry?.addedAt ?? null,
    lastTestedAt: entry?.lastTestedAt ?? null,
    lastTestOk: entry?.lastTestOk ?? null
  }
}

export async function listCredentialStatus(): Promise<CredentialStatus[]> {
  const store = await load()
  return (Object.keys(store) as Exchange[]).map((exchange) => toStatus(exchange, store[exchange]))
}

/** Tests and persists a new key/secret in one step — a key that fails verification is never
 * saved, per the live-trading design plan's "no key, no live mode, ever" principle. */
export async function setCredential(exchange: Exchange, apiKey: string, apiSecret: string): Promise<CredentialStatus> {
  const reader = BALANCE_READERS[exchange]
  if (!reader) throw new Error(`Live trading is not supported for ${exchange} yet`)
  await reader(apiKey, apiSecret)

  const store = await load()
  const now = Date.now()
  store[exchange] = {
    apiKeyEnc: encrypt(apiKey),
    apiSecretEnc: encrypt(apiSecret),
    addedAt: now,
    lastTestedAt: now,
    lastTestOk: true
  }
  balanceCache.delete(exchange)
  await persist()
  return toStatus(exchange, store[exchange])
}

/** Re-tests an already-stored key (e.g. a "Test" action in the UI, independent of adding one). */
export async function testCredential(exchange: Exchange): Promise<{ ok: boolean; message: string }> {
  const reader = BALANCE_READERS[exchange]
  if (!reader) return { ok: false, message: `Live trading is not supported for ${exchange} yet` }

  const store = await load()
  const entry = store[exchange]
  if (!entry) return { ok: false, message: 'No credential configured for this exchange' }

  try {
    await reader(decrypt(entry.apiKeyEnc), decrypt(entry.apiSecretEnc))
    entry.lastTestedAt = Date.now()
    entry.lastTestOk = true
    await persist()
    return { ok: true, message: 'Key verified successfully' }
  } catch (error) {
    entry.lastTestedAt = Date.now()
    entry.lastTestOk = false
    await persist()
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function removeCredential(exchange: Exchange): Promise<void> {
  const store = await load()
  delete store[exchange]
  // Dropped with the key, not left to expire. Disconnecting an exchange and still being shown its
  // balances for the next fifteen seconds would suggest the app kept something it was told to
  // forget.
  balanceCache.delete(exchange)
  await persist()
}

/** Reads what the user really holds on an exchange, over their own stored key.
 *
 * Read-only: this places no order and changes nothing. It is the same authenticated call that
 * verifies a key, which is the point -- the app already had this number and was throwing it away
 * after using it as a yes/no connectivity test.
 *
 * Errors are thrown rather than folded into an empty snapshot. An exchange that is unreachable,
 * a key that has been revoked, and an account holding nothing are three different situations, and
 * reporting the first two as "you have no money" would be a lie about someone's balance. */
export async function readLiveBalances(exchange: Exchange, force = false): Promise<LiveBalanceSnapshot> {
  const reader = BALANCE_READERS[exchange]
  if (!reader) throw new Error(`Reading balances is not supported for ${exchange} yet`)

  const cached = balanceCache.get(exchange)
  if (!force && cached && Date.now() - cached.fetchedAt < BALANCE_TTL_MS) return cached

  const store = await load()
  const entry = store[exchange]
  if (!entry) throw new Error(`No API key is connected for ${exchange}`)

  const raw = await reader(decrypt(entry.apiKeyEnc), decrypt(entry.apiSecretEnc))
  const { rows, unreadable } = readableBalances(raw)
  const snapshot: LiveBalanceSnapshot = { exchange, rows, unreadable, fetchedAt: Date.now() }
  balanceCache.set(exchange, snapshot)
  return snapshot
}

/** Main-process-internal only — never wire this to an IPC handler. The only function in this
 * module that returns a decrypted secret. */
export async function getDecryptedCredential(exchange: Exchange): Promise<{ apiKey: string; apiSecret: string }> {
  const store = await load()
  const entry = store[exchange]
  if (!entry) throw new Error(`No credential configured for ${exchange}`)
  return { apiKey: decrypt(entry.apiKeyEnc), apiSecret: decrypt(entry.apiSecretEnc) }
}
