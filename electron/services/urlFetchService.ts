import { lookup } from 'dns/promises'
import { request, type RequestOptions } from 'https'
import type { Readable } from 'stream'
import { createGunzip } from 'zlib'
import { URL_FETCH_LINES, addressRefusal, sanitizeUrl } from '../../shared/urlSafety'

// A PASTED LINK, READ SAFELY (V8 Stage 4, 26 October 2026; shared/urlSafety.ts). One page, on a person's click: the
// link cut down and its host checked first; then its name resolved and EVERY address it resolves to vetted, and the
// request made to the vetted address alone, the name kept for the certificate, so that a name cannot be made to point
// somewhere private between the check and the read. Https on its usual port, three redirects at most and each checked
// the same way, one deadline of fifteen seconds from the paste to the last byte, gzip only and two megabytes once
// decoded, no cookie sent or kept, and one start a host in ten seconds. No key, no session, nothing posted: a GET of a
// public page. What it read is handed to the worker to be read as text (shared/articleExtract.ts).

export type FetchFailure = 'refused' | 'paced' | 'dns' | 'address' | 'timeout' | 'network' | 'status' | 'type' | 'encoding' | 'too-large' | 'redirects'

export interface FetchedPage {
  ok: true
  /** The link as cut down, the page's address after any redirect, and the redirects followed. */
  url: string
  finalUrl: string
  redirects: string[]
  status: number
  contentType: string
  html: string
  bytes: number
  /** When the last byte came, in seconds, and the address it came from. */
  fetchedAt: number
  address: string
}

export interface FetchFailed {
  ok: false
  failure: FetchFailure
  reason: string
  redirects: string[]
}

/** A response as the fetch reads it: its status, its headers and its body. */
export interface RawResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Readable
}

/** What the fetch reads the world through: a test hands in its own. */
export const urlFetchSeam = {
  now: (): number => Date.now(),
  resolve: async (host: string): Promise<{ address: string; family: number }[]> => lookup(host, { all: true, verbatim: true }),
  get: (url: URL, pinned: { address: string; family: number }, signal: AbortSignal): Promise<RawResponse> =>
    new Promise((resolve, reject) => {
      const options: RequestOptions = {
        method: 'GET',
        signal,
        agent: false,
        headers: {
          Accept: 'text/html,application/xhtml+xml;q=0.9,text/plain;q=0.5',
          'Accept-Encoding': 'gzip',
          'Accept-Language': 'en',
          'User-Agent': 'TraderSpider (reads a link a person pasted)'
        },
        // The vetted address, whatever the name resolves to now; the name stays the request's, for its certificate.
        lookup: (_hostname, lookupOptions, callback) => {
          const all = typeof lookupOptions === 'object' && lookupOptions !== null && (lookupOptions as { all?: boolean }).all === true
          if (all) (callback as unknown as (error: null, addresses: { address: string; family: number }[]) => void)(null, [pinned])
          else (callback as (error: null, address: string, family: number) => void)(null, pinned.address, pinned.family)
        }
      }
      const req = request(url, options, (res) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: res }))
      req.on('error', reject)
      req.end()
    })
}

/** When each host was last started on, in milliseconds. */
const lastStart = new Map<string, number>()

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const PAGE_TYPES = /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i

const headerOf = (headers: RawResponse['headers'], name: string): string => {
  const value = headers[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

/** A promise held to the deadline: it fails with `timeout` when the deadline passes first. */
function withinDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  const left = deadlineMs - urlFetchSeam.now()
  if (left <= 0) return Promise.reject(new DeadlineError())
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError()), left)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

class DeadlineError extends Error {
  constructor() {
    super('The page did not come within fifteen seconds.')
  }
}

/** The page's text in its charset; UTF-8 where the charset is not one the platform reads. */
function decode(bytes: Buffer, contentType: string): string {
  const charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Reads one pasted link's page, or says why it was not read. */
export async function fetchPage(raw: string): Promise<FetchedPage | FetchFailed> {
  const startedAt = urlFetchSeam.now()
  const deadline = startedAt + URL_FETCH_LINES.deadlineMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), URL_FETCH_LINES.deadlineMs)
  const redirects: string[] = []
  const fail = (failure: FetchFailure, reason: string): FetchFailed => ({ ok: false, failure, reason, redirects })
  try {
    const first = sanitizeUrl(raw)
    if (!first.ok) return fail('refused', first.reason)
    let current = new URL(first.url)
    const started = new Set<string>()
    for (let hop = 0; ; hop++) {
      const host = current.hostname
      if (!started.has(host)) {
        const last = lastStart.get(host)
        if (last !== undefined && startedAt - last < URL_FETCH_LINES.hostGapMs) {
          return fail('paced', `${host} was read less than ${URL_FETCH_LINES.hostGapMs / 1000} seconds ago; try again in a moment.`)
        }
        lastStart.set(host, startedAt)
        started.add(host)
      }
      let addresses: { address: string; family: number }[]
      try {
        addresses = await withinDeadline(urlFetchSeam.resolve(host), deadline)
      } catch (error) {
        if (error instanceof DeadlineError) return fail('timeout', error.message)
        return fail('dns', `${host} could not be resolved.`)
      }
      if (addresses.length === 0) return fail('dns', `${host} resolves to no address.`)
      for (const entry of addresses) {
        const refusal = addressRefusal(entry.address)
        if (refusal !== null) return fail('address', `${host} resolves to ${refusal}`)
      }
      const pinned = addresses[0]
      let response: RawResponse
      try {
        response = await withinDeadline(urlFetchSeam.get(current, pinned, controller.signal), deadline)
      } catch (error) {
        if (error instanceof DeadlineError || controller.signal.aborted) return fail('timeout', new DeadlineError().message)
        return fail('network', `The page could not be read: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (REDIRECTS.has(response.status)) {
        response.body.destroy()
        const location = headerOf(response.headers, 'location')
        if (location === '') return fail('status', `The page answered ${response.status} with nowhere to go.`)
        if (hop >= URL_FETCH_LINES.maxRedirects) return fail('redirects', `The page redirected more than ${URL_FETCH_LINES.maxRedirects} times.`)
        let next: URL
        try {
          next = new URL(location, current)
        } catch {
          return fail('status', 'The page redirected to something that is not a link.')
        }
        const checked = sanitizeUrl(next.toString())
        if (!checked.ok) return fail('refused', `It redirected to a link that is not read: ${checked.reason}`)
        redirects.push(checked.url)
        current = new URL(checked.url)
        continue
      }
      if (response.status < 200 || response.status >= 300) {
        response.body.destroy()
        return fail('status', `The page answered ${response.status}.`)
      }
      const contentType = headerOf(response.headers, 'content-type')
      if (!PAGE_TYPES.test(contentType)) {
        response.body.destroy()
        return fail('type', `The link is to ${contentType === '' ? 'something with no type' : contentType.split(';')[0]}, not a page.`)
      }
      const encoding = headerOf(response.headers, 'content-encoding').trim().toLowerCase()
      if (encoding !== '' && encoding !== 'identity' && encoding !== 'gzip') {
        response.body.destroy()
        return fail('encoding', `The page came ${encoding}-encoded; only gzip is read.`)
      }
      const source: Readable = encoding === 'gzip' ? response.body.pipe(createGunzip()) : response.body
      const chunks: Buffer[] = []
      let total = 0
      try {
        for await (const chunk of source) {
          const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          total += piece.length
          if (total > URL_FETCH_LINES.maxBytes) {
            response.body.destroy()
            source.destroy()
            return fail('too-large', `The page is over ${URL_FETCH_LINES.maxBytes / 1024 / 1024} MB once decoded.`)
          }
          chunks.push(piece)
          if (urlFetchSeam.now() > deadline) {
            response.body.destroy()
            source.destroy()
            return fail('timeout', new DeadlineError().message)
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return fail('timeout', new DeadlineError().message)
        return fail(encoding === 'gzip' ? 'encoding' : 'network', `The page could not be read whole: ${error instanceof Error ? error.message : String(error)}`)
      }
      return {
        ok: true,
        url: first.url,
        finalUrl: current.toString(),
        redirects,
        status: response.status,
        contentType,
        html: decode(Buffer.concat(chunks), contentType),
        bytes: total,
        fetchedAt: Math.floor(urlFetchSeam.now() / 1000),
        address: pinned.address
      }
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Test seam: as a new session finds it. */
export function resetUrlFetch(): void {
  lastStart.clear()
}
