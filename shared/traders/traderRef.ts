// A PASTED TRADER, READ (V8 Stage 6, 26 October 2026). What a person pastes on Copy Traders -- an address, a profile's
// link -- is parsed here and never fetched: the paste names a trader whose record the app can read, or it is refused
// with why. Hyperliquid publishes any address's fills, keyless; OKX a lead trader's positions, keyless; Bitget, Binance
// and Bybit publish no trader's trades through their APIs, and a page of theirs is refused with that reason. Pure text
// work: nothing here fetches anything.

/** Where a trader's record comes from: a venue, or a file a person brought (V8 Stage 7), named by its contents' hash. */
export type TraderVenue = 'hyperliquid' | 'okx' | 'file'

/** A trader the app can read: the venue, the id as the venue writes it, and the key its files are kept under. */
export interface TraderRef {
  venue: TraderVenue
  id: string
  /** `hyperliquid-0x…`, `okx-…` or `file-…`: a folder name, letters, digits and one hyphen only. */
  key: string
}

export const TRADER_REF_LINES = {
  /** A paste longer than this is not an address or a link. */
  maxChars: 500
} as const

const HYPERLIQUID_ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** An OKX lead trader's unique code: sixteen letters and digits, or eighteen digits. */
const OKX_CODE = /^(?:[0-9A-Za-z]{16}|\d{18})$/
/** A file's id: the first sixteen hex digits of its contents' SHA-256. */
const FILE_ID = /^[0-9a-f]{16}$/

/** Hosts whose pages name a Hyperliquid address in their path: the app itself, its explorers. */
const HYPERLIQUID_HOSTS = ['hyperliquid.xyz', 'hypurrscan.io', 'hyperdash.info']
const OKX_HOSTS = ['okx.com']

/** Venues whose traders cannot be read, and why, by the host their pages are on. */
const REFUSED_HOSTS: readonly { hosts: readonly string[]; reason: string }[] = [
  {
    hosts: ['bitget.com'],
    reason: "Bitget publishes no lead trader's trades without your own key. The Bitget check below reads the traders you copy there, through your key, read-only."
  },
  { hosts: ['binance.com', 'binance.us'], reason: "Binance publishes no trader's positions or trades through its API, so a Binance trader cannot be read." },
  { hosts: ['bybit.com'], reason: "Bybit publishes no trader's positions or trades through its API, so a Bybit trader cannot be read." },
  { hosts: ['x.com', 'twitter.com'], reason: "A post is not a trader's record: paste the trader's Hyperliquid address or OKX profile instead." }
]

const within = (host: string, domain: string): boolean => host === domain || host.endsWith(`.${domain}`)

export const refOf = (venue: TraderVenue, id: string): TraderRef => {
  const normal = venue === 'hyperliquid' ? id.toLowerCase() : id
  return { venue, id: normal, key: `${venue}-${normal}` }
}

/** What a paste names: a trader the app can read, or a refusal with why. */
export function traderRefOf(raw: string): { ok: true; ref: TraderRef } | { ok: false; reason: string } {
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'Paste a Hyperliquid address (0x and forty letters and digits) or an OKX lead trader\'s profile link.' }
  if (text.length > TRADER_REF_LINES.maxChars) return { ok: false, reason: 'That is too long to be an address or a link.' }
  if (HYPERLIQUID_ADDRESS.test(text)) return { ok: true, ref: refOf('hyperliquid', text) }
  if (OKX_CODE.test(text)) return { ok: true, ref: refOf('okx', text) }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'Not a Hyperliquid address, an OKX lead trader\'s code, or a link to either.' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, reason: 'Only a web link is read.' }
  const host = url.hostname.toLowerCase()
  for (const refused of REFUSED_HOSTS) if (refused.hosts.some((domain) => within(host, domain))) return { ok: false, reason: refused.reason }
  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  if (HYPERLIQUID_HOSTS.some((domain) => within(host, domain))) {
    const address = [...segments, ...url.searchParams.values()].find((part) => HYPERLIQUID_ADDRESS.test(part))
    return address === undefined ? { ok: false, reason: 'That Hyperliquid link names no address (0x and forty letters and digits).' } : { ok: true, ref: refOf('hyperliquid', address) }
  }
  if (OKX_HOSTS.some((domain) => within(host, domain))) {
    const code = [...segments, ...url.searchParams.values()].find((part) => OKX_CODE.test(part))
    return code === undefined ? { ok: false, reason: "That OKX link names no lead trader's code (sixteen letters and digits, or eighteen digits)." } : { ok: true, ref: refOf('okx', code) }
  }
  return { ok: false, reason: 'Traders are read from Hyperliquid and OKX only: paste a Hyperliquid address or an OKX lead trader\'s profile link.' }
}

/** A key read back from a folder's name; null for one that is not a trader's. */
export function traderRefOfKey(key: string): TraderRef | null {
  const at = key.indexOf('-')
  if (at < 0) return null
  const venue = key.slice(0, at)
  const id = key.slice(at + 1)
  if (venue === 'hyperliquid' && HYPERLIQUID_ADDRESS.test(id) && id === id.toLowerCase()) return refOf('hyperliquid', id)
  if (venue === 'okx' && OKX_CODE.test(id)) return refOf('okx', id)
  if (venue === 'file' && FILE_ID.test(id)) return refOf('file', id)
  return null
}
