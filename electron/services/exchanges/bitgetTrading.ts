import type { AccountBalance } from './binanceTrading'
import { bitgetSigned, type BitgetCredentials } from './bitgetAuth'

// BITGET, THE REAL ACCOUNT (V7.1 Stage 7, 16 October 2026): reading it over the user's own key.
// Every request here is signed as a REAL request (bitgetAuth.ts): nothing in this file can reach the
// demo account, and a test pins that. From Stage 9 this file also places, queries and cancels real
// spot orders, through the same gates as Binance's; until then it reads, and nothing here writes.
//
// Never log a key, a secret or a passphrase.

/** One coin's row in the unified account, as /api/v3/account/assets gives it. */
interface CoinAsset {
  coin: string
  available: string
  locked: string
  equity?: string
  usdValue?: string
}

interface AccountAssets {
  accountEquity?: string
  usdtEquity?: string
  assets?: CoinAsset[]
}

/** The unified account's settings; `accountMode` is UNION or ISOLATED on a unified account and
 * CLASSIC on one not upgraded. */
export interface BitgetAccountSettings {
  accountMode: string
  assetMode?: string
  holdMode?: string
}

export type BitgetAccountType = 'uta' | 'classic' | 'unknown'

/** What an account's mode says it is: a unified account in either of its modes, a classic one, or
 * a mode this app does not know. A classic account is read-only in this app: its orders would go to
 * another API. */
export function bitgetAccountTypeOf(accountMode: string | null | undefined): BitgetAccountType {
  const mode = (accountMode ?? '').toUpperCase()
  if (mode === 'UNION' || mode === 'ISOLATED') return 'uta'
  if (mode === 'CLASSIC') return 'classic'
  return 'unknown'
}

/** The balances as the app shows them: a coin's spendable amount and what its resting orders hold.
 * A row that cannot be read becomes NaN and is reported by name (readableBalances), never as nought. */
export function balancesOf(data: AccountAssets | null | undefined): AccountBalance[] {
  if (!Array.isArray(data?.assets)) throw new Error('Bitget returned an account response without an asset list')
  return data.assets.map((row) => ({ asset: row.coin, free: Number(row.available), locked: Number(row.locked) }))
}

/** Reads the real account: proves a key, its secret and its passphrase, and is what Live Trading
 * shows for Bitget. Places no order. */
export async function fetchBitgetAssets(credentials: BitgetCredentials): Promise<AccountBalance[]> {
  return balancesOf(await bitgetSigned<AccountAssets>(credentials, { method: 'GET', path: '/api/v3/account/assets', what: 'account read' }, false))
}

/** The real account's settings: its mode, which says whether it is a unified account at all. */
export async function fetchBitgetAccountSettings(credentials: BitgetCredentials): Promise<BitgetAccountSettings> {
  const data = await bitgetSigned<BitgetAccountSettings>(credentials, { method: 'GET', path: '/api/v3/account/settings', what: 'account settings' }, false)
  return { accountMode: String(data?.accountMode ?? ''), ...(data?.assetMode === undefined ? {} : { assetMode: data.assetMode }), ...(data?.holdMode === undefined ? {} : { holdMode: data.holdMode }) }
}
