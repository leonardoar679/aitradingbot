import { getDecryptedCredential } from '../credentialsService'
import { BitgetRefusal, bitgetSigned, type BitgetCredentials, type BitgetRequest } from './bitgetAuth'
import { bitgetAccountTypeOf, readBitgetAccountSettings } from './bitgetAccount'
import type { BitgetCopiedTrader, BitgetCopyCheck } from '../../../shared/traders/traderAnalysis'

// THE BITGET COPY-TRADING CHECK (V8 Stage 6; the user's answer of 26 October 2026: on a click, read-only). Bitget
// publishes no lead trader's trades without a key; what a person's own key can read is their own copy trading. This
// asks three things with the key typed on Connections, each a GET, and nothing else: the account's mode (a Classic
// account and a Unified one read copy trading through different endpoints), whether the key may read copy trading at
// all, and the traders it copies. Nothing is subscribed, changed, placed or closed: no request here is anything but a
// GET, and none is made but on the person's click. The key never leaves the main process.

export const BITGET_COPY_PATHS = {
  /** A Classic account's follower read: the traders it copies (v2). */
  classicTraders: '/api/v2/copy/mix-follower/query-traders',
  /** A Unified account's follower read: the copies it holds (v3). */
  unifiedCopies: '/api/v3/copy/futures/current-copy'
} as const

/** What the check reads through: a test hands in its own. */
export const bitgetCopySeam = {
  now: (): number => Math.floor(Date.now() / 1000),
  credentials: async (): Promise<BitgetCredentials> => getDecryptedCredential('bitget', 'real'),
  send: <T>(credentials: BitgetCredentials, request: BitgetRequest): Promise<T> => bitgetSigned<T>(credentials, request, false)
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 80) : typeof value === 'number' && Number.isFinite(value) ? String(value) : null)

/** The traders in a follower read's answer, wherever Bitget puts its list: an id and a name where it gives them. */
export function copiedTradersOf(data: unknown): BitgetCopiedTrader[] {
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const list = Array.isArray(data) ? data : (['list', 'traderList', 'resultList', 'items', 'data'].map((name) => record[name]).find(Array.isArray) ?? [])
  const out: BitgetCopiedTrader[] = []
  for (const item of list as unknown[]) {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    const id = text(entry.traderId) ?? text(entry.traderUid) ?? text(entry.projectId) ?? text(entry.uid)
    if (id === null) continue
    out.push({ id, name: text(entry.traderName) ?? text(entry.nickName) ?? text(entry.traderNickName) ?? text(entry.name) })
  }
  return out.slice(0, 200)
}

/** The check, on a click: the account's mode, the follower read, and the traders copied. Never throws for a refusal of
 * Bitget's: that is the answer. */
export async function bitgetCopyCheck(): Promise<BitgetCopyCheck> {
  const at = bitgetCopySeam.now()
  let credentials: BitgetCredentials
  try {
    credentials = await bitgetCopySeam.credentials()
  } catch {
    return { at, configured: false, accountMode: null, modeProblem: null, followerRead: null }
  }
  const send = <T>(request: BitgetRequest): Promise<T> => bitgetCopySeam.send<T>(credentials, request)
  let accountMode: BitgetCopyCheck['accountMode'] = null
  let modeProblem: string | null = null
  try {
    accountMode = bitgetAccountTypeOf((await readBitgetAccountSettings(send, 'account mode read')).accountMode)
  } catch (error) {
    modeProblem = error instanceof Error ? error.message : String(error)
  }
  const endpoint = accountMode === 'uta' ? BITGET_COPY_PATHS.unifiedCopies : BITGET_COPY_PATHS.classicTraders
  try {
    const data = await send<unknown>({ method: 'GET', path: endpoint, ...(endpoint === BITGET_COPY_PATHS.classicTraders ? { query: { pageNo: '1', pageSize: '50' } } : {}), what: 'copy trading read' })
    return { at, configured: true, accountMode, modeProblem, followerRead: { ok: true, endpoint, traders: copiedTradersOf(data) } }
  } catch (error) {
    return {
      at,
      configured: true,
      accountMode,
      modeProblem,
      followerRead: { ok: false, endpoint, code: error instanceof BitgetRefusal && error.code !== '' ? error.code : null, message: error instanceof Error ? error.message : String(error) }
    }
  }
}
