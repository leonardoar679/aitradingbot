import { app, safeStorage } from 'electron'
import { mkdir, readFile } from 'fs/promises'
import { join } from 'path'
import type { AiCredentialStatus } from '../../shared/aiSignal'
import { writeJsonAtomic } from './atomicWrite'

export const DEFAULT_OPENAI_MODEL = 'gpt-5-mini'

interface StoredAiCredential {
  apiKeyEnc: string
  model: string
  addedAt: number
  lastTestedAt: number | null
  lastTestOk: boolean | null
}

let cache: StoredAiCredential | null | undefined

function credentialPath(): string {
  return join(app.getPath('userData'), 'aiCredentials.json')
}

async function load(): Promise<StoredAiCredential | null> {
  if (cache !== undefined) return cache
  try {
    const raw = JSON.parse(await readFile(credentialPath(), 'utf-8')) as Partial<StoredAiCredential>
    cache =
      typeof raw.apiKeyEnc === 'string' && typeof raw.model === 'string'
        ? {
            apiKeyEnc: raw.apiKeyEnc,
            model: raw.model,
            addedAt: typeof raw.addedAt === 'number' ? raw.addedAt : Date.now(),
            lastTestedAt: typeof raw.lastTestedAt === 'number' ? raw.lastTestedAt : null,
            lastTestOk: typeof raw.lastTestOk === 'boolean' ? raw.lastTestOk : null
          }
        : null
  } catch {
    cache = null
  }
  return cache
}

async function persist(): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeJsonAtomic(credentialPath(), cache)
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

function cleanModel(model: string): string {
  const value = model.trim()
  if (!value || value.length > 100 || !/^[a-zA-Z0-9._:-]+$/.test(value)) {
    throw new Error('Enter a valid OpenAI model name')
  }
  return value
}

function statusFor(entry: StoredAiCredential | null): AiCredentialStatus {
  return {
    configured: entry !== null,
    model: entry?.model ?? DEFAULT_OPENAI_MODEL,
    addedAt: entry?.addedAt ?? null,
    lastTestedAt: entry?.lastTestedAt ?? null,
    lastTestOk: entry?.lastTestOk ?? null
  }
}

async function verify(apiKey: string, model: string): Promise<void> {
  const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300)
    throw new Error(`OpenAI verification failed (${response.status})${body ? `: ${body}` : ''}`)
  }
}

export async function getAiCredentialStatus(): Promise<AiCredentialStatus> {
  return statusFor(await load())
}

export async function setAiCredential(apiKey: string, model: string): Promise<AiCredentialStatus> {
  const key = apiKey.trim()
  if (!key) throw new Error('OpenAI API key is required')
  const normalizedModel = cleanModel(model)
  await verify(key, normalizedModel)
  const now = Date.now()
  cache = {
    apiKeyEnc: encrypt(key),
    model: normalizedModel,
    addedAt: now,
    lastTestedAt: now,
    lastTestOk: true
  }
  await persist()
  return statusFor(cache)
}

export async function testAiCredential(): Promise<{ ok: boolean; message: string }> {
  const entry = await load()
  if (!entry) return { ok: false, message: 'No OpenAI API key configured' }
  try {
    await verify(decrypt(entry.apiKeyEnc), entry.model)
    entry.lastTestedAt = Date.now()
    entry.lastTestOk = true
    await persist()
    return { ok: true, message: `OpenAI ${entry.model} is available` }
  } catch (error) {
    entry.lastTestedAt = Date.now()
    entry.lastTestOk = false
    await persist()
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

export async function removeAiCredential(): Promise<void> {
  cache = null
  await persist()
}

/** Main-process only. Never expose the decrypted key through IPC. */
export async function getDecryptedAiCredential(): Promise<{ apiKey: string; model: string }> {
  const entry = await load()
  if (!entry) throw new Error('No OpenAI API key configured')
  return { apiKey: decrypt(entry.apiKeyEnc), model: entry.model }
}
