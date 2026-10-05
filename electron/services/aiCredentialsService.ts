import { app, safeStorage } from 'electron'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import { AI_PROVIDER_LABEL, describeUnusableAiKey, type AiCredentialStatus } from '../../shared/aiSignal'
import type { AiKeyInfo } from '../../shared/aiCost'
import { writeJsonAtomic } from './atomicWrite'
import { fetchKeyInfo } from './openRouterClient'

// The OpenRouter key, in its own file for the same reason exchange credentials have theirs: a bug
// in settings persistence can never touch a secret it does not hold. This module is the only place
// the key is ever decrypted, and it must never log one.

interface StoredAiCredential {
  provider: 'openrouter'
  apiKeyEnc: string
  addedAt: number
  lastTestedAt: number | null
  lastTestOk: boolean | null
}

interface LoadedCredential {
  credential: StoredAiCredential | null
  /** The file holds a key, but it is the OpenAI key from before this app used OpenRouter.
   *
   * It is recognised by having no `provider` field and is otherwise left exactly alone: never
   * decrypted, never sent, never rewritten. An OpenAI key posted to OpenRouter would be a
   * credential handed to a service it was not issued for, so "try it and see" is not a migration
   * this module will perform. It stays on disk until the user removes it or saves an OpenRouter
   * key over it. */
  legacyOpenAiKey: boolean
}

let cache: LoadedCredential | undefined

function credentialPath(): string {
  return join(app.getPath('userData'), 'aiCredentials.json')
}

async function load(): Promise<LoadedCredential> {
  if (cache !== undefined) return cache
  try {
    const raw = JSON.parse(await readFile(credentialPath(), 'utf-8')) as Partial<StoredAiCredential> | null
    if (raw !== null && typeof raw.apiKeyEnc === 'string' && raw.provider === 'openrouter') {
      cache = {
        credential: {
          provider: 'openrouter',
          apiKeyEnc: raw.apiKeyEnc,
          addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
          lastTestedAt: typeof raw.lastTestedAt === 'number' ? raw.lastTestedAt : null,
          lastTestOk: typeof raw.lastTestOk === 'boolean' ? raw.lastTestOk : null
        },
        legacyOpenAiKey: false
      }
    } else {
      cache = { credential: null, legacyOpenAiKey: raw !== null && typeof raw.apiKeyEnc === 'string' }
    }
  } catch {
    cache = { credential: null, legacyOpenAiKey: false }
  }
  return cache
}

async function persist(credential: StoredAiCredential | null): Promise<void> {
  cache = { credential, legacyOpenAiKey: false }
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(credentialPath(), credential)
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

function statusFor(loaded: LoadedCredential): AiCredentialStatus {
  return {
    configured: loaded.credential !== null,
    addedAt: loaded.credential?.addedAt ?? null,
    lastTestedAt: loaded.credential?.lastTestedAt ?? null,
    lastTestOk: loaded.credential?.lastTestOk ?? null,
    legacyOpenAiKey: loaded.legacyOpenAiKey
  }
}

export async function getAiCredentialStatus(): Promise<AiCredentialStatus> {
  return statusFor(await load())
}

/** Verified before it is stored, with a request that costs nothing. A key that fails is never
 * written, the same rule the exchange credentials follow. */
export async function setAiCredential(apiKey: string): Promise<AiCredentialStatus> {
  const key = apiKey.trim()
  if (!key) throw new Error(`${AI_PROVIDER_LABEL} API key is required`)
  // Verifying means sending, so what is plainly some other secret is refused before it is sent.
  const unusable = describeUnusableAiKey(key)
  if (unusable !== null) throw new Error(`${unusable} It was not sent anywhere.`)
  await fetchKeyInfo(key)
  const now = Date.now()
  await persist({ provider: 'openrouter', apiKeyEnc: encrypt(key), addedAt: now, lastTestedAt: now, lastTestOk: true })
  return statusFor(await load())
}

export async function testAiCredential(): Promise<{ ok: boolean; message: string }> {
  const { credential } = await load()
  if (!credential) return { ok: false, message: `No ${AI_PROVIDER_LABEL} API key configured` }
  try {
    const info = await fetchKeyInfo(decrypt(credential.apiKeyEnc))
    await persist({ ...credential, lastTestedAt: Date.now(), lastTestOk: true })
    return { ok: true, message: `${AI_PROVIDER_LABEL} accepted the key${info.label ? ` (${info.label})` : ''}` }
  } catch (error) {
    await persist({ ...credential, lastTestedAt: Date.now(), lastTestOk: false })
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Removes whatever the file holds, the legacy OpenAI key included. */
export async function removeAiCredential(): Promise<void> {
  await persist(null)
}

/** Usage and remaining limit, as OpenRouter reports them for the stored key. Free to call. */
export async function getAiKeyInfo(): Promise<AiKeyInfo> {
  return fetchKeyInfo((await getDecryptedAiCredential()).apiKey)
}

/** Main-process only. Never expose the decrypted key through IPC. */
export async function getDecryptedAiCredential(): Promise<{ apiKey: string }> {
  const { credential, legacyOpenAiKey } = await load()
  if (!credential) {
    throw new Error(
      legacyOpenAiKey
        ? `The stored key is an OpenAI key from before this app used ${AI_PROVIDER_LABEL}, and is no longer used. Add an ${AI_PROVIDER_LABEL} key on Connections.`
        : `No ${AI_PROVIDER_LABEL} API key configured. Add one on Connections.`
    )
  }
  return { apiKey: decrypt(credential.apiKeyEnc) }
}
