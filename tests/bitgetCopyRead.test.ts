import { describe, expect, it, vi } from 'vitest'
import type { BitgetRequest } from '../electron/services/exchanges/bitgetAuth'

// THE BITGET COPY-TRADING CHECK (electron/services/exchanges/bitgetCopyRead.ts; V8 Stage 6; the user's answer of 26
// October 2026: on a click, read-only): nothing asked without a key; the account's mode read, a Classic one through
// v2's follower read and a Unified one through v3's; the traders copied read wherever Bitget puts its list; a refusal
// kept with Bitget's code as the answer; and nothing ever asked but with a GET.

vi.mock('../electron/services/credentialsService', () => ({ getDecryptedCredential: async () => ({ apiKey: 'k', apiSecret: 's', passphrase: 'p' }) }))

async function check(answer: (request: BitgetRequest) => unknown, credentials: 'present' | 'absent' = 'present') {
  vi.resetModules()
  const module = await import('../electron/services/exchanges/bitgetCopyRead')
  const auth = await import('../electron/services/exchanges/bitgetAuth')
  const asked: BitgetRequest[] = []
  Object.assign(module.bitgetCopySeam, {
    now: () => 1_793_000_000,
    credentials: async () => {
      if (credentials === 'absent') throw new Error('No credential configured for bitget')
      return { apiKey: 'k', apiSecret: 's', passphrase: 'p' }
    },
    send: async (_credentials: unknown, request: BitgetRequest) => {
      asked.push(request)
      const answered = answer(request)
      if (answered instanceof Error) throw answered
      return answered
    }
  })
  return { module, auth, asked }
}

describe('the Bitget copy-trading check', () => {
  it('asks nothing without a key on Connections', async () => {
    const { module, asked } = await check(() => ({}), 'absent')
    expect(await module.bitgetCopyCheck()).toEqual({ at: 1_793_000_000, configured: false, accountMode: null, modeProblem: null, followerRead: null })
    expect(asked).toEqual([])
  })

  it("reads a Classic account's mode from Bitget's refusal of the unified read, and its traders through v2", async () => {
    let auth: typeof import('../electron/services/exchanges/bitgetAuth') | null = null
    const { module, asked, auth: loaded } = await check((request) => {
      if (request.path === '/api/v3/account/settings') return new (auth as typeof import('../electron/services/exchanges/bitgetAuth')).BitgetRefusal('Classic', '40084', 400)
      return { traderList: [{ traderId: 'b1b8', traderName: 'Lead one' }, { traderUid: 9001 }, { nickName: 'no id' }] }
    })
    auth = loaded
    const result = await module.bitgetCopyCheck()
    expect(result).toEqual({
      at: 1_793_000_000,
      configured: true,
      accountMode: 'classic',
      modeProblem: null,
      followerRead: {
        ok: true,
        endpoint: '/api/v2/copy/mix-follower/query-traders',
        traders: [
          { id: 'b1b8', name: 'Lead one' },
          { id: '9001', name: null }
        ]
      }
    })
    expect(asked.map((request) => [request.method, request.path, request.query ?? null])).toEqual([
      ['GET', '/api/v3/account/settings', null],
      ['GET', '/api/v2/copy/mix-follower/query-traders', { pageNo: '1', pageSize: '50' }]
    ])
  })

  it("reads a Unified account's copies through v3, and keeps Bitget's refusal of the read -- its code and words -- as the answer", async () => {
    let auth: typeof import('../electron/services/exchanges/bitgetAuth') | null = null
    const { module, asked, auth: loaded } = await check((request) => {
      if (request.path === '/api/v3/account/settings') return { accountMode: 'UNION' }
      return new (auth as typeof import('../electron/services/exchanges/bitgetAuth')).BitgetRefusal('Bitget copy trading read failed: 40014 Incorrect permissions', '40014', 400)
    })
    auth = loaded
    const result = await module.bitgetCopyCheck()
    expect(result.accountMode).toBe('uta')
    expect(result.followerRead).toEqual({ ok: false, endpoint: '/api/v3/copy/futures/current-copy', code: '40014', message: 'Bitget copy trading read failed: 40014 Incorrect permissions' })
    expect(asked.every((request) => request.method === 'GET' && request.body === undefined)).toBe(true)
  })

  it("says where the mode could not be read, and still reads the copies Classic's way", async () => {
    const { module } = await check((request) => {
      if (request.path === '/api/v3/account/settings') return new Error('Bitget account mode read failed: 429')
      return []
    })
    const result = await module.bitgetCopyCheck()
    expect(result).toMatchObject({ accountMode: null, modeProblem: 'Bitget account mode read failed: 429', followerRead: { ok: true, endpoint: '/api/v2/copy/mix-follower/query-traders', traders: [] } })
  })

  it('reads the traders wherever Bitget puts its list, and at most two hundred', async () => {
    const { module } = await check(() => ({}))
    expect(module.copiedTradersOf([{ traderId: 'a' }])).toEqual([{ id: 'a', name: null }])
    expect(module.copiedTradersOf({ list: [{ projectId: 'p', traderNickName: 'N' }] })).toEqual([{ id: 'p', name: 'N' }])
    expect(module.copiedTradersOf({ resultList: Array.from({ length: 300 }, (_, k) => ({ uid: k })) })).toHaveLength(200)
    expect(module.copiedTradersOf(null)).toEqual([])
    expect(module.copiedTradersOf({ list: 'x' })).toEqual([])
  })
})
