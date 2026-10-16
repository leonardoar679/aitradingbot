import type { AccountBalance } from './binanceTrading'
import { bitgetSigned, type BitgetCredentials } from './bitgetAuth'
import { balancesOf, type BitgetAccountSettings } from './bitgetTrading'

// BITGET, THE DEMO ACCOUNT (V7.1 Stage 7, 16 October 2026): the only module whose requests carry the
// demo header (bitgetAuth.ts, `demo: true`), and the only one that may, which a test pins. Bitget
// refuses a real key sent with it and a demo key sent without it, so a demo request from here can
// reach nothing real, and a real order can never come from this file. From Stage 8 the paper
// laboratory may place, query and cancel DEMO orders through here, under its paper caps; until then
// it reads, and nothing here writes.
//
// Never log a key, a secret or a passphrase.

interface AccountAssets {
  assets?: { coin: string; available: string; locked: string }[]
}

/** Reads the demo account: proves a demo key, its secret and its passphrase. Places no order. */
export async function fetchBitgetDemoAssets(credentials: BitgetCredentials): Promise<AccountBalance[]> {
  return balancesOf(await bitgetSigned<AccountAssets>(credentials, { method: 'GET', path: '/api/v3/account/assets', what: 'demo account read' }, true))
}

/** The demo account's settings: its mode. */
export async function fetchBitgetDemoAccountSettings(credentials: BitgetCredentials): Promise<BitgetAccountSettings> {
  const data = await bitgetSigned<BitgetAccountSettings>(credentials, { method: 'GET', path: '/api/v3/account/settings', what: 'demo account settings' }, true)
  return { accountMode: String(data?.accountMode ?? '') }
}
