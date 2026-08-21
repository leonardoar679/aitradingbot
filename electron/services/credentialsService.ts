import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFile, mkdir } from 'fs/promises'
import { writeJsonAtomic } from './atomicWrite'
import { fetchAccountBalance } from './exchanges/binanceTrading'
import type { CredentialStatus, Exchange } from '../../shared/ipc'

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

// Only Binance has a live-trading adapter today (see the live-trading design plan). This is the
// single point that grows as more exchanges gain real order execution support — storage itself
// stays generic per-exchange so that expansion doesn't require a schema change.
const BALANCE_TESTERS: Partial<Record<Exchange, (apiKey: string, apiSecret: string) => Promise<unknown>>> = {
  binance: fetchAccountBalance
}

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
  const tester = BALANCE_TESTERS[exchange]
  if (!tester) throw new Error(`Live trading is not supported for ${exchange} yet`)
  await tester(apiKey, apiSecret)

  const store = await load()
  const now = Date.now()
  store[exchange] = {
    apiKeyEnc: encrypt(apiKey),
    apiSecretEnc: encrypt(apiSecret),
    addedAt: now,
    lastTestedAt: now,
    lastTestOk: true
  }
  await persist()
  return toStatus(exchange, store[exchange])
}

/** Re-tests an already-stored key (e.g. a "Test" action in the UI, independent of adding one). */
export async function testCredential(exchange: Exchange): Promise<{ ok: boolean; message: string }> {
  const tester = BALANCE_TESTERS[exchange]
  if (!tester) return { ok: false, message: `Live trading is not supported for ${exchange} yet` }

  const store = await load()
  const entry = store[exchange]
  if (!entry) return { ok: false, message: 'No credential configured for this exchange' }

  try {
    await tester(decrypt(entry.apiKeyEnc), decrypt(entry.apiSecretEnc))
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
  await persist()
}

/** Main-process-internal only — never wire this to an IPC handler. The only function in this
 * module that returns a decrypted secret. */
export async function getDecryptedCredential(exchange: Exchange): Promise<{ apiKey: string; apiSecret: string }> {
  const store = await load()
  const entry = store[exchange]
  if (!entry) throw new Error(`No credential configured for ${exchange}`)
  return { apiKey: decrypt(entry.apiKeyEnc), apiSecret: decrypt(entry.apiSecretEnc) }
}
