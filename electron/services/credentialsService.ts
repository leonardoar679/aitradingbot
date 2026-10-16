import { app, safeStorage } from 'electron'
import { join } from 'path'
import { readFile, mkdir } from 'fs/promises'
import { writeJsonAtomic } from './atomicWrite'
import { fetchAccountBalance, type AccountBalance } from './exchanges/binanceTrading'
import { fetchUpbitBalances } from './exchanges/upbitTrading'
import { bitgetAccountTypeOf, fetchBitgetAccountSettings, fetchBitgetAssets, type BitgetAccountSettings } from './exchanges/bitgetTrading'
import { fetchBitgetDemoAccountSettings, fetchBitgetDemoAssets } from './exchanges/bitgetDemoTrading'
import type { BitgetCredentials } from './exchanges/bitgetAuth'
import { fetchFuturesPositions, fetchOpenFuturesOrders } from './exchanges/binanceFutures'
import { cancelProtectiveStop, closeFuturesPosition, placeProtectiveStop } from './exchanges/binanceFuturesTrading'
import { canCloseLivePosition } from './liveTradingService'
import { freeBalance, readableBalances, type ExchangeBalance } from '../../shared/liveBalances'
import type { CredentialAccountType, CredentialSetOptions, CredentialSlot, CredentialStatus, Exchange, LiveBalanceSnapshot } from '../../shared/ipc'
import type { FuturesCloseResult, FuturesReadout } from '../../shared/futuresPositions'
import { describeStopPlacementError, readableProtectiveStops, type ProtectiveStop } from '../../shared/futuresStops'

// Credentials live in their own file, separate from settings.json, so a bug in general settings
// persistence can never touch secrets. Each key/secret is encrypted at rest via Electron's
// safeStorage (OS keychain / DPAPI-backed) — this module is the only place that ever handles a
// decrypted secret, and it must never log one.

interface StoredCredential {
  apiKeyEnc: string
  apiSecretEnc: string
  /** The passphrase an exchange set with the key (Bitget), encrypted as the secret is (V7.1 Stage 7). */
  apiPassphraseEnc?: string
  addedAt: number
  lastTestedAt: number | null
  lastTestOk: boolean | null
  /** What the account said it was at the last test (Bitget's UNION, ISOLATED or CLASSIC); absent
   * where the exchange has no such thing. */
  accountMode?: string | null
}

/** Keyed by the slot's name: an exchange's real key under the exchange's name, as always, and a demo
 * key under `<exchange>:demo` (V7.1 Stage 7). */
type StoredCredentialsFile = Partial<Record<string, StoredCredential>>

/** The file's key for a slot. Exported for the test. */
export function slotKeyOf(exchange: Exchange, slot: CredentialSlot): string {
  return slot === 'demo' ? `${exchange}:demo` : exchange
}

/** The slot a file's key names, or null for a key this app did not write. */
export function slotOfKey(key: string): { exchange: Exchange; slot: CredentialSlot } | null {
  const match = /^([a-z]+)(?::(demo))?$/.exec(key)
  if (match === null) return null
  return { exchange: match[1] as Exchange, slot: match[2] === 'demo' ? 'demo' : 'real' }
}

type BalanceReader = (apiKey: string, apiSecret: string, passphrase: string) => Promise<AccountBalance[]>

// Exchanges whose account this app can read. The single point that grows as more exchanges gain
// authenticated adapters — storage itself stays generic per-exchange, so expansion needs no
// schema change.
//
// One call does two jobs on purpose: it verifies a key before that key is ever stored, and it is
// what Live Trading reads. Anything listed here can therefore be connected AND shown, so an
// exchange can never end up connected while being unable to say what is in the account.
//
// This is NOT the list of exchanges that can be traded on -- that is TRADING_EXCHANGES in
// shared/ipc.ts, and it is shorter. Being able to see a balance is not permission to spend it,
// and keeping one list for both is how an exchange becomes tradable as a side effect of someone
// adding a balance reader.
const BALANCE_READERS: Partial<Record<Exchange, BalanceReader>> = {
  binance: (apiKey, apiSecret) => fetchAccountBalance(apiKey, apiSecret),
  upbit: (apiKey, apiSecret) => fetchUpbitBalances(apiKey, apiSecret),
  bitget: (apiKey, apiSecret, passphrase) => fetchBitgetAssets({ apiKey, apiSecret, passphrase })
}

/** Exchanges with a demo account of their own, read over a second, demo key through the one module
 * that may send a demo request (bitgetDemoTrading.ts). A demo key can reach nothing real. */
const DEMO_READERS: Partial<Record<Exchange, BalanceReader>> = {
  bitget: (apiKey, apiSecret, passphrase) => fetchBitgetDemoAssets({ apiKey, apiSecret, passphrase })
}

/** Exchanges whose key has a passphrase: asked for with the key, kept beside it, sent with every
 * signed request. */
export const PASSPHRASE_EXCHANGES: ReadonlySet<Exchange> = new Set<Exchange>(['bitget'])

/** What an exchange's account says it is, read beside the balance at each test. */
const ACCOUNT_MODE_READERS: Partial<Record<Exchange, Record<CredentialSlot, (credentials: BitgetCredentials) => Promise<BitgetAccountSettings>>>> = {
  bitget: { real: fetchBitgetAccountSettings, demo: fetchBitgetDemoAccountSettings }
}

function readerFor(exchange: Exchange, slot: CredentialSlot): BalanceReader | undefined {
  return slot === 'demo' ? DEMO_READERS[exchange] : BALANCE_READERS[exchange]
}

function slotWord(exchange: Exchange, slot: CredentialSlot): string {
  return slot === 'demo' ? `${exchange}'s demo account` : exchange
}

/** The account's mode, read where the exchange has one; a read that fails leaves it unknown rather
 * than refusing a key the balance read has just proved. */
async function accountModeOf(exchange: Exchange, slot: CredentialSlot, credentials: BitgetCredentials): Promise<string | null> {
  const reader = ACCOUNT_MODE_READERS[exchange]?.[slot]
  if (reader === undefined) return null
  try {
    return (await reader(credentials)).accountMode
  } catch {
    return null
  }
}

function accountTypeOf(exchange: Exchange, entry: StoredCredential | undefined): CredentialAccountType {
  if (entry === undefined || ACCOUNT_MODE_READERS[exchange] === undefined) return null
  return bitgetAccountTypeOf(entry.accountMode)
}

/** How long a balance read is reused before the exchange is asked again.
 *
 * Short, because this exists for two specific reasons rather than to keep data fresh: React
 * StrictMode mounts every effect twice in development, and Live Trading is easy to leave and
 * come back to. Both would otherwise spend a signed, weighted request to learn a number that has
 * not moved. Anything the user does that changes their balance goes through an explicit action,
 * and Refresh bypasses this entirely. */
const BALANCE_TTL_MS = 15_000

/** Keyed by the slot's name (slotKeyOf). */
const balanceCache = new Map<string, LiveBalanceSnapshot>()

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

function toStatus(exchange: Exchange, slot: CredentialSlot, entry: StoredCredential | undefined): CredentialStatus {
  return {
    exchange,
    slot,
    configured: entry !== undefined,
    addedAt: entry?.addedAt ?? null,
    lastTestedAt: entry?.lastTestedAt ?? null,
    lastTestOk: entry?.lastTestOk ?? null,
    accountType: accountTypeOf(exchange, entry)
  }
}

/** The passphrase as the entry holds it: none for an exchange without one. */
function passphraseOf(entry: StoredCredential): string {
  return entry.apiPassphraseEnc === undefined ? '' : decrypt(entry.apiPassphraseEnc)
}

export async function listCredentialStatus(): Promise<CredentialStatus[]> {
  const store = await load()
  const statuses: CredentialStatus[] = []
  for (const key of Object.keys(store)) {
    const named = slotOfKey(key)
    if (named !== null) statuses.push(toStatus(named.exchange, named.slot, store[key]))
  }
  return statuses
}

/** Tests and persists a new key/secret in one step — a key that fails verification is never
 * saved, per the live-trading design plan's "no key, no live mode, ever" principle.
 *
 * Storing a key does not make an exchange tradable. It makes its account readable; whether an
 * order can be placed is TRADING_EXCHANGES, checked separately at the point an order is placed.
 * A key with a passphrase (Bitget) is refused without one; a demo key goes in its own slot, read
 * through the demo module alone. */
export async function setCredential(exchange: Exchange, apiKey: string, apiSecret: string, options: CredentialSetOptions = {}): Promise<CredentialStatus> {
  const slot = options.slot ?? 'real'
  const reader = readerFor(exchange, slot)
  if (!reader) throw new Error(`This app cannot connect to ${slotWord(exchange, slot)} yet`)
  const passphrase = (options.passphrase ?? '').trim()
  if (PASSPHRASE_EXCHANGES.has(exchange) && passphrase === '') throw new Error(`A ${exchange} key needs the passphrase set when the key was made`)
  await reader(apiKey, apiSecret, passphrase)
  const accountMode = await accountModeOf(exchange, slot, { apiKey, apiSecret, passphrase })

  const store = await load()
  const now = Date.now()
  const key = slotKeyOf(exchange, slot)
  store[key] = {
    apiKeyEnc: encrypt(apiKey),
    apiSecretEnc: encrypt(apiSecret),
    ...(passphrase === '' ? {} : { apiPassphraseEnc: encrypt(passphrase) }),
    addedAt: now,
    lastTestedAt: now,
    lastTestOk: true,
    ...(ACCOUNT_MODE_READERS[exchange] === undefined ? {} : { accountMode })
  }
  balanceCache.delete(key)
  await persist()
  return toStatus(exchange, slot, store[key])
}

/** Re-tests an already-stored key (e.g. a "Test" action in the UI, independent of adding one). */
export async function testCredential(exchange: Exchange, slot: CredentialSlot = 'real'): Promise<{ ok: boolean; message: string }> {
  const reader = readerFor(exchange, slot)
  if (!reader) return { ok: false, message: `This app cannot connect to ${slotWord(exchange, slot)} yet` }

  const store = await load()
  const entry = store[slotKeyOf(exchange, slot)]
  if (!entry) return { ok: false, message: slot === 'demo' ? 'No demo key configured for this exchange' : 'No credential configured for this exchange' }

  try {
    const credentials = { apiKey: decrypt(entry.apiKeyEnc), apiSecret: decrypt(entry.apiSecretEnc), passphrase: passphraseOf(entry) }
    await reader(credentials.apiKey, credentials.apiSecret, credentials.passphrase)
    if (ACCOUNT_MODE_READERS[exchange] !== undefined) entry.accountMode = await accountModeOf(exchange, slot, credentials)
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

export async function removeCredential(exchange: Exchange, slot: CredentialSlot = 'real'): Promise<void> {
  const store = await load()
  const key = slotKeyOf(exchange, slot)
  delete store[key]
  // Dropped with the key, not left to expire. Disconnecting an exchange and still being shown its
  // balances for the next fifteen seconds would suggest the app kept something it was told to
  // forget.
  balanceCache.delete(key)
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
export async function readLiveBalances(exchange: Exchange, force = false, slot: CredentialSlot = 'real'): Promise<LiveBalanceSnapshot> {
  const reader = readerFor(exchange, slot)
  if (!reader) throw new Error(`Reading balances is not supported for ${slotWord(exchange, slot)} yet`)

  const key = slotKeyOf(exchange, slot)
  const cached = balanceCache.get(key)
  if (!force && cached && Date.now() - cached.fetchedAt < BALANCE_TTL_MS) return cached

  const store = await load()
  const entry = store[key]
  if (!entry) throw new Error(`No API key is connected for ${slotWord(exchange, slot)}`)

  const raw = await reader(decrypt(entry.apiKeyEnc), decrypt(entry.apiSecretEnc), passphraseOf(entry))
  const { rows, unreadable } = readableBalances(raw)
  const snapshot: LiveBalanceSnapshot = { exchange, rows, unreadable, fetchedAt: Date.now() }
  balanceCache.set(key, snapshot)
  return snapshot
}

/** The balances as the account's own stream just reported them (liveUserStreamService.ts; the V5
 * document, S101), kept as a read made now: the page's next read is answered from them instead of
 * a signed request, and a trade's funding check still reads fresh (freeBalanceFor). */
export function updateBalanceCache(exchange: Exchange, raw: readonly ExchangeBalance[]): LiveBalanceSnapshot {
  const { rows, unreadable } = readableBalances(raw)
  const snapshot: LiveBalanceSnapshot = { exchange, rows, unreadable, fetchedAt: Date.now() }
  balanceCache.set(exchange, snapshot)
  return snapshot
}

/** What is spendable in one asset on an exchange, for the check that runs immediately before a
 * real order.
 *
 * Reads fresh rather than from the cache: the cached copy exists to spare repeated page renders a
 * signed request, and a balance that is fifteen seconds old is exactly wrong for deciding whether
 * an order placed now can be paid for. A deposit that just landed would otherwise read as absent.
 *
 * Answers null -- not known -- rather than throwing when the balance cannot be read, and the
 * caller treats that as no reason to block. See describeLiveShortfall. */
export async function freeBalanceFor(exchange: Exchange, asset: string): Promise<number | null> {
  try {
    return freeBalance(await readLiveBalances(exchange, true), asset)
  } catch {
    // Swallowed on purpose, and reported as "not known" rather than as zero. An exchange that
    // cannot be reached must not look like an account holding nothing, which would block every
    // order behind a message about funds when the real problem is the network.
    return null
  }
}

/** Main-process-internal only — never wire this to an IPC handler. The only function in this
 * module that returns a decrypted secret. The passphrase is empty for an exchange without one. */
export async function getDecryptedCredential(exchange: Exchange, slot: CredentialSlot = 'real'): Promise<{ apiKey: string; apiSecret: string; passphrase: string }> {
  const store = await load()
  const entry = store[slotKeyOf(exchange, slot)]
  if (!entry) throw new Error(`No credential configured for ${slotWord(exchange, slot)}`)
  return { apiKey: decrypt(entry.apiKeyEnc), apiSecret: decrypt(entry.apiSecretEnc), passphrase: passphraseOf(entry) }
}

/** Real perpetual-futures positions on an exchange, read over the user's own key.
 *
 * Never cached, unlike the spot balance. A balance is a slow-moving fact and a fifteen-second-old
 * copy spares repeated renders a signed request; a liquidation price is the opposite kind of
 * number, and showing a stale one to someone whose position is closing is the single worst moment
 * for this app to be fifteen seconds behind.
 *
 * Binance only, and read-only -- see binanceFutures.ts, which contains no order endpoint at all
 * and therefore no path from here to opening, closing or changing any of these positions. */
export async function readFuturesPositions(exchange: Exchange): Promise<FuturesReadout> {
  if (exchange !== 'binance') throw new Error(`Reading futures positions is not supported for ${exchange}`)
  const store = await load()
  const entry = store[exchange]
  if (!entry) throw new Error(`No API key is connected for ${exchange}`)
  return fetchFuturesPositions(decrypt(entry.apiKeyEnc), decrypt(entry.apiSecretEnc))
}

/** Closes a real futures position at market. The only write this app can make to a futures
 * account -- see binanceFuturesTrading.ts for why opening one is deliberately absent.
 *
 * Gated by canCloseLivePosition rather than canPlaceLiveOrder: the size, daily-cap and loss-limit
 * gates exist to bound NEW exposure, and none of them should be able to trap someone inside a
 * leveraged position they are trying to leave. The kill switch and the session arm still apply,
 * because both mean "this app should not be touching the exchange at all right now".
 *
 * The size is re-read here rather than taken from the caller: the renderer's copy is up to twenty
 * seconds old, and closing a stale quantity would either leave a remainder open or -- without
 * reduceOnly, which is also set -- open a position in the opposite direction. */
export async function closeFuturesPositionFor(exchange: Exchange, symbol: string): Promise<FuturesCloseResult> {
  if (exchange !== 'binance') throw new Error(`Closing futures positions is not supported for ${exchange}`)
  const gate = await canCloseLivePosition()
  if (!gate.allowed) throw new Error(gate.reason ?? 'Closing is not allowed right now')

  const store = await load()
  const entry = store[exchange]
  if (!entry) throw new Error(`No API key is connected for ${exchange}`)

  const apiKey = decrypt(entry.apiKeyEnc)
  const apiSecret = decrypt(entry.apiSecretEnc)
  const { positions } = await fetchFuturesPositions(apiKey, apiSecret)
  const position = positions.find((p) => p.symbol === symbol)
  if (!position) {
    throw new Error(`Binance reports no open ${symbol} futures position — it may already be closed.`)
  }
  return closeFuturesPosition(apiKey, apiSecret, symbol, position.positionAmt)
}

/** The stop orders resting on a futures account, filtered down to the ones that actually protect
 * something.
 *
 * Read as its own call rather than folded into readFuturesPositions, so that the two can fail
 * independently. If the order read fails and the position read succeeds, the card has to be able
 * to say "this app could not tell whether these are protected" -- merging them would collapse
 * that into an empty list, which reads as "no stop", which is the one wrong answer that matters
 * here. */
export async function readFuturesStops(exchange: Exchange): Promise<ProtectiveStop[]> {
  if (exchange !== 'binance') throw new Error(`Reading futures orders is not supported for ${exchange}`)
  const store = await load()
  const entry = store[exchange]
  if (!entry) throw new Error(`No API key is connected for ${exchange}`)
  const rows = await fetchOpenFuturesOrders(decrypt(entry.apiKeyEnc), decrypt(entry.apiSecretEnc))
  return readableProtectiveStops(rows)
}

/** Places a stop that closes a real position if the price reaches `stopPrice`.
 *
 * Gated by canCloseLivePosition, like closing and for the same reason: this order can only ever
 * reduce a position, so the size, daily-cap and loss-limit gates -- which exist to bound NEW
 * exposure -- have no business refusing it. The kill switch and the session arm still apply.
 *
 * The position is re-read here rather than trusted from the renderer, for two separate reasons:
 * the size decides the closing side, and the mark and liquidation prices decide whether the stop
 * is placeable at all. A twenty-second-old mark is enough to accept a stop that has already been
 * passed, which the exchange would then trigger the instant it was placed. */
export async function placeFuturesStopFor(exchange: Exchange, symbol: string, stopPrice: number): Promise<ProtectiveStop> {
  if (exchange !== 'binance') throw new Error(`Placing futures stops is not supported for ${exchange}`)
  const gate = await canCloseLivePosition()
  if (!gate.allowed) throw new Error(gate.reason ?? 'Placing a stop is not allowed right now')

  const store = await load()
  const entry = store[exchange]
  if (!entry) throw new Error(`No API key is connected for ${exchange}`)

  const apiKey = decrypt(entry.apiKeyEnc)
  const apiSecret = decrypt(entry.apiSecretEnc)
  const { positions } = await fetchFuturesPositions(apiKey, apiSecret)
  const position = positions.find((p) => p.symbol === symbol)
  if (!position) {
    throw new Error(`Binance reports no open ${symbol} futures position — there is nothing for a stop to close.`)
  }

  const problem = describeStopPlacementError(position, stopPrice)
  if (problem !== null) throw new Error(problem)

  return placeProtectiveStop(apiKey, apiSecret, symbol, position.positionAmt, stopPrice)
}

/** Cancels a resting stop. The only write in this app that leaves a position more exposed than it
 * found it, gated identically so that "this app should not be touching the exchange right now"
 * means the same thing in both directions. */
export async function cancelFuturesStopFor(exchange: Exchange, symbol: string, orderId: number): Promise<void> {
  if (exchange !== 'binance') throw new Error(`Cancelling futures stops is not supported for ${exchange}`)
  const gate = await canCloseLivePosition()
  if (!gate.allowed) throw new Error(gate.reason ?? 'Cancelling a stop is not allowed right now')

  const store = await load()
  const entry = store[exchange]
  if (!entry) throw new Error(`No API key is connected for ${exchange}`)

  await cancelProtectiveStop(decrypt(entry.apiKeyEnc), decrypt(entry.apiSecretEnc), symbol, orderId)
}
