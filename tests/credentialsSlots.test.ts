import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// THE KEYS' SLOTS (electron/services/credentialsService.ts; V7.1 Stage 7): a Bitget key with its
// passphrase, a demo key in a slot of its own read through the demo module alone, the account's mode
// read beside the balance, and the file's keys. Electron's store and encryption are faked: the
// encryption reverses, so the file can be read back here; nothing is sent anywhere -- fetch is faked
// with Bitget's envelope.

const dir = mkdtempSync(join(tmpdir(), 'credentials-slots-'))
vi.mock('electron', () => ({
  app: { getPath: () => dir },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(`enc:${value}`), decryptString: (value: Buffer) => value.toString().replace(/^enc:/, '') }
}))
vi.mock('../electron/services/liveTradingService', () => ({ canCloseLivePosition: async () => ({ allowed: false, reason: 'not here' }) }))

const { getDecryptedCredential, listCredentialStatus, PASSPHRASE_EXCHANGES, readLiveBalances, removeCredential, setCredential, slotKeyOf, slotOfKey, testCredential } = await import('../electron/services/credentialsService')

const asked: { url: string; headers: Record<string, string> }[] = []
const ok = (data: unknown): Promise<Response> => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ code: '00000', msg: 'success', data }) } as Response)

beforeEach(() => {
  asked.length = 0
  vi.unstubAllGlobals()
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const u = String(url)
    asked.push({ url: u, headers: (init?.headers as Record<string, string>) ?? {} })
    if (u.includes('/api/v3/market/time')) return ok({ serverTime: String(Date.now()) })
    if (u.includes('/api/v3/account/assets')) return ok({ assets: [{ coin: 'USDT', available: '10000', locked: '0' }] })
    if (u.includes('/api/v3/account/settings')) return ok({ accountMode: (init?.headers as Record<string, string>)?.paptrading === '1' ? 'ISOLATED' : 'UNION' })
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ code: '40404', msg: 'not found', data: null }) })
  })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("the file's keys", () => {
  it('names a real key by its exchange, as always, and a demo key by the exchange and the slot', () => {
    expect(slotKeyOf('binance', 'real')).toBe('binance')
    expect(slotKeyOf('bitget', 'demo')).toBe('bitget:demo')
    expect(slotOfKey('binance')).toEqual({ exchange: 'binance', slot: 'real' })
    expect(slotOfKey('bitget:demo')).toEqual({ exchange: 'bitget', slot: 'demo' })
    expect(slotOfKey('bitget:other')).toBeNull()
    expect(slotOfKey('')).toBeNull()
    expect([...PASSPHRASE_EXCHANGES]).toEqual(['bitget'])
  })
})

describe('a Bitget key', () => {
  it('needs its passphrase, is verified by a real read with it, and is stored with it and with what the account said it was', async () => {
    await expect(setCredential('bitget', 'k', 's')).rejects.toThrow('A bitget key needs the passphrase set when the key was made')
    expect(asked).toEqual([])
    const status = await setCredential('bitget', 'k', 's', { passphrase: 'p' })
    expect(status).toMatchObject({ exchange: 'bitget', slot: 'real', configured: true, lastTestOk: true, accountType: 'uta' })
    const reads = asked.filter((entry) => entry.url.includes('/account/'))
    expect(reads.map((entry) => entry.url)).toEqual(['https://api.bitget.com/api/v3/account/assets', 'https://api.bitget.com/api/v3/account/settings'])
    for (const read of reads) {
      expect(read.headers['ACCESS-PASSPHRASE']).toBe('p')
      expect(read.headers).not.toHaveProperty('paptrading')
    }
    const file = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf-8')) as Record<string, Record<string, unknown>>
    expect(file.bitget).toMatchObject({ apiKeyEnc: Buffer.from('enc:k').toString('base64'), apiPassphraseEnc: Buffer.from('enc:p').toString('base64'), accountMode: 'UNION' })
    expect(await getDecryptedCredential('bitget')).toEqual({ apiKey: 'k', apiSecret: 's', passphrase: 'p' })
  })

  it('keeps a demo key in its own slot, read through the demo module alone, beside the real one', async () => {
    const status = await setCredential('bitget', 'dk', 'ds', { passphrase: 'dp', slot: 'demo' })
    expect(status).toMatchObject({ exchange: 'bitget', slot: 'demo', configured: true, accountType: 'uta' })
    for (const read of asked.filter((entry) => entry.url.includes('/account/'))) expect(read.headers.paptrading).toBe('1')
    const file = JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf-8')) as Record<string, Record<string, unknown>>
    expect(Object.keys(file).sort()).toEqual(['bitget', 'bitget:demo'])
    expect(file['bitget:demo']).toMatchObject({ accountMode: 'ISOLATED' })
    expect(await getDecryptedCredential('bitget', 'demo')).toEqual({ apiKey: 'dk', apiSecret: 'ds', passphrase: 'dp' })
    expect(await getDecryptedCredential('bitget')).toEqual({ apiKey: 'k', apiSecret: 's', passphrase: 'p' })
    const statuses = await listCredentialStatus()
    expect(statuses.map((entry) => `${entry.exchange}:${entry.slot}:${entry.accountType}`)).toEqual(['bitget:real:uta', 'bitget:demo:uta'])
  })

  it("reads each slot's balances over its own key, tests each on its own, and removes each on its own", async () => {
    const demo = await readLiveBalances('bitget', true, 'demo')
    expect(demo.rows).toEqual([{ asset: 'USDT', free: 10000, locked: 0 }])
    expect(asked.filter((entry) => entry.url.includes('/account/assets')).map((entry) => entry.headers.paptrading)).toEqual(['1'])
    asked.length = 0
    const real = await readLiveBalances('bitget', true)
    expect(real.rows).toEqual([{ asset: 'USDT', free: 10000, locked: 0 }])
    expect(asked.filter((entry) => entry.url.includes('/account/assets')).map((entry) => entry.headers.paptrading)).toEqual([undefined])
    expect(await testCredential('bitget', 'demo')).toEqual({ ok: true, message: 'Key verified successfully' })
    expect(await testCredential('binance')).toEqual({ ok: false, message: 'No credential configured for this exchange' })
    expect(await testCredential('bitget', 'demo')).toMatchObject({ ok: true })
    await removeCredential('bitget', 'demo')
    expect((await listCredentialStatus()).map((entry) => entry.slot)).toEqual(['real'])
    expect(await testCredential('bitget', 'demo')).toEqual({ ok: false, message: 'No demo key configured for this exchange' })
    await removeCredential('bitget')
    expect(await listCredentialStatus()).toEqual([])
  })

  it('has no demo slot on an exchange without a demo account', async () => {
    await expect(setCredential('binance', 'k', 's', { slot: 'demo' })).rejects.toThrow("This app cannot connect to binance's demo account yet")
    expect(await testCredential('upbit', 'demo')).toEqual({ ok: false, message: "This app cannot connect to upbit's demo account yet" })
  })
})
