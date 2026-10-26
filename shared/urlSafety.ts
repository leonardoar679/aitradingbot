// A PASTED LINK, MADE SAFE TO READ (V8 Stage 4, 26 October 2026). The News URLs page reads an article a person pastes,
// and a pasted link is the one input to this app that names a host chosen by someone else. So before anything is
// fetched the link is cut down to what an article needs -- https on its usual port, no user name or password, no
// fragment, only the query fields that select an article -- and its host is refused where it is an address, a name of
// one label or a name kept for a private network. Once its name is resolved every address is vetted, and the one
// fetched from is the vetted one (electron/services/urlFetchService.ts): a private, loopback, link-local, shared,
// reserved or embedded private address refuses the fetch, so a link cannot make this app reach the machine or the
// network it runs on. Arithmetic on strings: nothing here resolves or fetches anything.

export const URL_SAFETY_VERSION = 'url-safety-v1'

/** The fetch's lines: one deadline from the paste to the last byte, the redirects followed, the bytes kept once
 * decoded, and the gap between two requests to one host. */
export const URL_FETCH_LINES = {
  version: URL_SAFETY_VERSION,
  deadlineMs: 15_000,
  maxRedirects: 3,
  maxBytes: 2 * 1024 * 1024,
  hostGapMs: 10_000
} as const

/** Query fields that select an article on any host: a post's number and its kind. Every other field is dropped --
 * tracking, sessions and campaign tags among them -- unless the host's own list keeps it. */
export const GENERIC_QUERY_FIELDS: readonly string[] = ['p', 'id', 'article', 'articleId', 'story', 'post', 'page_id']

/** The fields a host's articles are selected by, beyond the generic ones. */
export const HOST_QUERY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'www.youtube.com': ['v'],
  'youtube.com': ['v'],
  'm.youtube.com': ['v'],
  'news.ycombinator.com': ['id']
}

export type UrlRefusal = 'not-a-url' | 'not-https' | 'userinfo' | 'port' | 'ip-literal' | 'single-label' | 'private-name' | 'too-long'

export type SanitizedUrl =
  | { ok: true; url: string; host: string; path: string; removedFields: string[] }
  | { ok: false; refused: UrlRefusal; reason: string }

const MAX_URL_CHARS = 2048
/** Names kept for private networks and for the machine itself. */
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home', '.corp', '.private', '.home.arpa', '.test', '.invalid', '.example']

/** Whether a host is an address written as one: dotted IPv4, or IPv6 in brackets. (The URL parser already turns the
 * other ways of writing IPv4 -- one number, hex, octal -- into dotted form.) */
export function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')
}

/** Why a host is refused before it is resolved; null where it may be. */
export function hostRefusal(host: string): { refused: UrlRefusal; reason: string } | null {
  const name = host.toLowerCase().replace(/\.$/, '')
  if (isIpLiteral(name)) return { refused: 'ip-literal', reason: 'The link names an address rather than a host; only a named host is read.' }
  if (!name.includes('.')) return { refused: 'single-label', reason: 'The link names a host of one label, which only a private network resolves.' }
  if (name === 'localhost' || PRIVATE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return { refused: 'private-name', reason: 'The link names a host kept for a private network or for this machine.' }
  return null
}

/** A pasted link cut down to what an article needs, or why it is refused. The host comes out in its ASCII form
 * (an international name as punycode), so that two spellings of one host compare equal. */
export function sanitizeUrl(raw: string): SanitizedUrl {
  const text = raw.trim()
  if (text.length === 0 || text.length > MAX_URL_CHARS) {
    return text.length > MAX_URL_CHARS ? { ok: false, refused: 'too-long', reason: `The link is over ${MAX_URL_CHARS} characters.` } : { ok: false, refused: 'not-a-url', reason: 'Nothing was pasted.' }
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return { ok: false, refused: 'not-a-url', reason: 'This is not a link.' }
  }
  if (parsed.protocol !== 'https:') return { ok: false, refused: 'not-https', reason: 'Only https links are read.' }
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, refused: 'userinfo', reason: 'The link carries a user name or a password; such a link is not read.' }
  if (parsed.port !== '' && parsed.port !== '443') return { ok: false, refused: 'port', reason: 'Only the usual https port is read.' }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '')
  const refusal = hostRefusal(host)
  if (refusal !== null) return { ok: false, ...refusal }
  const keep = new Set([...GENERIC_QUERY_FIELDS, ...(HOST_QUERY_FIELDS[host] ?? [])])
  const kept = new URLSearchParams()
  const removedFields: string[] = []
  for (const [field, value] of parsed.searchParams) {
    if (keep.has(field)) kept.append(field, value)
    else removedFields.push(field)
  }
  const search = kept.toString()
  const path = parsed.pathname === '' ? '/' : parsed.pathname
  return { ok: true, url: `https://${host}${path}${search === '' ? '' : `?${search}`}`, host, path, removedFields: [...new Set(removedFields)] }
}

// ---------------------------------------------------------------------------------------------------------------
// The addresses a name resolves to.

const v4Parts = (address: string): number[] | null => {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null
}

/** Whether an IPv4 address is in a block no public article lives on. */
function v4Refused(parts: readonly number[]): boolean {
  const [a, b, c] = parts
  return (
    a === 0 || // this network
    a === 10 || // private
    a === 127 || // loopback
    (a === 100 && b >= 64 && b <= 127) || // shared address space (carrier-grade NAT)
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) || // private
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relay anycast
    (a === 192 && b === 168) || // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, reserved and broadcast
  )
}

/** The eight 16-bit groups of an IPv6 address, or null where it is not one. */
function v6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/^\[|\]$/g, '')
  const zone = text.indexOf('%')
  if (zone >= 0) text = text.slice(0, zone)
  // An embedded IPv4 tail, as in ::ffff:10.0.0.1.
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text)
  if (tail !== null) {
    const parts = v4Parts(tail[1])
    if (parts === null) return null
    text = `${text.slice(0, tail.index)}${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const read = (half: string): number[] | null => {
    if (half === '') return []
    const groups = half.split(':').map((group) => (/^[0-9a-f]{1,4}$/.test(group) ? parseInt(group, 16) : Number.NaN))
    return groups.every((group) => Number.isFinite(group)) ? groups : null
  }
  const head = read(halves[0])
  const rest = halves.length === 2 ? read(halves[1]) : []
  if (head === null || rest === null) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const missing = 8 - head.length - rest.length
  return missing >= 1 ? [...head, ...new Array<number>(missing).fill(0), ...rest] : null
}

/** Why a resolved address is refused; null where an article may be read from it. An IPv4 address embedded in an
 * IPv6 one -- mapped, compatible, NAT64 or 6to4 -- is judged as the IPv4 address it carries. */
export function addressRefusal(address: string): string | null {
  const v4 = v4Parts(address)
  if (v4 !== null) return v4Refused(v4) ? `${address} is a private, loopback, link-local, shared or reserved address.` : null
  const g = v6Groups(address)
  if (g === null) return `${address} is not an address.`
  const embedded = (hi: number, lo: number): string | null => {
    const parts = [hi >> 8, hi & 255, lo >> 8, lo & 255]
    return v4Refused(parts) ? `${address} carries the IPv4 address ${parts.join('.')}, which is not public.` : null
  }
  if (g.every((group) => group === 0)) return `${address} is the unspecified address.`
  if (g.slice(0, 7).every((group) => group === 0) && g[7] === 1) return `${address} is the loopback address.`
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d).
  if (g.slice(0, 5).every((group) => group === 0) && (g[5] === 0xffff || g[5] === 0)) return embedded(g[6], g[7]) ?? (g[5] === 0 ? `${address} is a deprecated IPv4-compatible address.` : null)
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address too.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((group) => group === 0)) return embedded(g[6], g[7])
  if (g[0] === 0x2002) return embedded(g[1], g[2])
  if ((g[0] & 0xfe00) === 0xfc00) return `${address} is a unique local address.`
  if ((g[0] & 0xffc0) === 0xfe80) return `${address} is a link-local address.`
  if ((g[0] & 0xffc0) === 0xfec0) return `${address} is a site-local address.`
  if ((g[0] & 0xff00) === 0xff00) return `${address} is a multicast address.`
  if (g[0] === 0x2001 && g[1] === 0x0db8) return `${address} is a documentation address.`
  if (g[0] === 0x2001 && g[1] === 0) return `${address} is a Teredo address.`
  if (g[0] === 0x100 && g.slice(1, 4).every((group) => group === 0)) return `${address} is a discard address.`
  return null
}
