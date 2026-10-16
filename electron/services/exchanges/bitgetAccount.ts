import type { AccountBalance } from './binanceTrading'
import type { BitgetRequest } from './bitgetAuth'
import { isClassicRefusal } from './bitgetAuth'

// BITGET, THE ACCOUNT'S READS (V7.1, 16 October 2026; written when a user's key, made on a Classic
// account, was refused by the unified reads with code 40084): how an account's balances and its mode
// are read -- on a unified account (UTA, v3) as Stage 7 had it, and on a CLASSIC account, one not
// upgraded, from the Classic spot account's own endpoint, which is what such a key can answer. Written
// once here and used by the real module (bitgetTrading.ts) and the demo module (bitgetDemoTrading.ts),
// each of which brings its own signer (`send`), as bitgetOrders.ts does for orders. This file signs
// nothing and chooses no account.
//
// A CLASSIC ACCOUNT IS READ, NOT TRADED. Bitget answers every unified (v3) request on a Classic account
// with code 40084, "You are in Classic Account mode, and the Unified Account API is not supported at
// this time". Its balances are then read from GET /api/v2/spot/account/assets (the Classic spot
// account's documentation, read 16 October 2026): rows of coin, available, frozen, locked,
// limitAvailable and uTime, all strings. The order paths this app has are the unified ones
// (bitgetOrders.ts), so a Classic key verifies and shows its balance, and a real order on it is refused
// before anything is sent (liveExecutionService.ts assertAccountCanTrade), with the way to the unified
// account said. A main account switches to the Unified Trading Account on Bitget itself, and back.
//
// THE BALANCE READ IS THE PROOF. Whether an account is Classic is learned from the balance read that
// took the Classic endpoint (readBitgetAccount says so), not from a second request: the settings read
// is asked only of an account the unified read answered, and a Classic account is stored as such even
// where its settings read would fail for another reason (credentialsService.ts).

export type BitgetSend = <T>(request: BitgetRequest) => Promise<T>

export const BITGET_ACCOUNT_PATHS = {
  /** The unified account's balances. */
  assets: '/api/v3/account/assets',
  /** The unified account's settings: its mode. */
  settings: '/api/v3/account/settings',
  /** The Classic spot account's balances: what a key on an account not upgraded can answer. */
  classicAssets: '/api/v2/spot/account/assets'
} as const

/** Bitget's own word for an account not upgraded, as /api/v3/account/settings would give it and as a
 * 40084 refusal means it. */
export const CLASSIC_MODE = 'CLASSIC'

/** One coin's row in the unified account, as /api/v3/account/assets gives it. */
export interface CoinAsset {
  coin: string
  available: string
  locked: string
  equity?: string
  usdValue?: string
}

export interface AccountAssets {
  accountEquity?: string
  usdtEquity?: string
  assets?: CoinAsset[]
}

/** One coin's row on the Classic spot account, as /api/v2/spot/account/assets gives it: `available` is
 * spendable, `frozen` is held by resting orders (or a Launchpad), `locked` is held by the exchange for
 * another reason (a fiat merchant's deposit), `limitAvailable` is what copy trading restricts. */
export interface ClassicAsset {
  coin: string
  available: string
  frozen: string
  locked: string
  limitAvailable?: string
  uTime?: string
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
 * a mode this app does not know. A classic account is read in this app and not traded: its orders
 * would go to another API. */
export function bitgetAccountTypeOf(accountMode: string | null | undefined): BitgetAccountType {
  const mode = (accountMode ?? '').toUpperCase()
  if (mode === 'UNION' || mode === 'ISOLATED') return 'uta'
  if (mode === CLASSIC_MODE) return 'classic'
  return 'unknown'
}

/** The unified account's balances as the app shows them: a coin's spendable amount and what its
 * resting orders hold. A row that cannot be read becomes NaN and is reported by name
 * (readableBalances), never as nought. */
export function balancesOf(data: AccountAssets | null | undefined): AccountBalance[] {
  if (!Array.isArray(data?.assets)) throw new Error('Bitget returned an account response without an asset list')
  return data.assets.map((row) => ({ asset: row.coin, free: Number(row.available), locked: Number(row.locked) }))
}

/** The Classic spot account's balances as the app shows them. What is frozen by resting orders and
 * what the exchange holds for another reason are both not spendable, and are shown together as held,
 * so a coin wholly held does not vanish from the list. A row that cannot be read becomes NaN by name. */
export function classicBalancesOf(data: ClassicAsset[] | null | undefined): AccountBalance[] {
  if (!Array.isArray(data)) throw new Error('Bitget returned a Classic account response without an asset list')
  return data.map((row) => ({ asset: row.coin, free: Number(row.available), locked: Number(row.frozen) + Number(row.locked) }))
}

/** What one read of the account learned: its balances, and whether they came from the Classic
 * endpoint, which proves the account Classic. */
export interface BitgetAccountRead {
  balances: AccountBalance[]
  /** True where the unified read was refused as a Classic account's and the Classic endpoint answered. */
  classic: boolean
}

/** The account's balances over a signer: the unified account's, or, where the account is Classic and
 * refuses the unified read as such, the Classic spot account's -- said so. Any other refusal is thrown
 * as it is. */
export async function readBitgetAccount(send: BitgetSend, what: string): Promise<BitgetAccountRead> {
  try {
    return { balances: balancesOf(await send<AccountAssets>({ method: 'GET', path: BITGET_ACCOUNT_PATHS.assets, what })), classic: false }
  } catch (error) {
    if (!isClassicRefusal(error)) throw error
    return { balances: classicBalancesOf(await send<ClassicAsset[]>({ method: 'GET', path: BITGET_ACCOUNT_PATHS.classicAssets, what: `Classic ${what}` })), classic: true }
  }
}

/** The balances alone. */
export async function readBitgetAssets(send: BitgetSend, what: string): Promise<AccountBalance[]> {
  return (await readBitgetAccount(send, what)).balances
}

/** The account's mode: as its settings give it, or CLASSIC where the settings read itself is refused
 * as a Classic account's -- Bitget's refusal names the mode. Any other refusal is thrown as it is. */
export async function readBitgetAccountSettings(send: BitgetSend, what: string): Promise<BitgetAccountSettings> {
  try {
    const data = await send<BitgetAccountSettings>({ method: 'GET', path: BITGET_ACCOUNT_PATHS.settings, what })
    return { accountMode: String(data?.accountMode ?? ''), ...(data?.assetMode === undefined ? {} : { assetMode: data.assetMode }), ...(data?.holdMode === undefined ? {} : { holdMode: data.holdMode }) }
  } catch (error) {
    if (!isClassicRefusal(error)) throw error
    return { accountMode: CLASSIC_MODE }
  }
}
