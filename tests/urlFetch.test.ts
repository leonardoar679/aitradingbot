import { Readable } from 'node:stream'
import { gzipSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { URL_FETCH_LINES } from '../shared/urlSafety'

// A PASTED LINK, READ SAFELY (electron/services/urlFetchService.ts; V8 Stage 4): every address the name resolves to
// vetted and the request made to the vetted one; three redirects at most, each checked as the link was; a page of text
// only, gzip only, two megabytes at most once decoded; one start a host in ten seconds; one deadline for it all.

vi.mock('electron', () => ({ app: { getPath: () => '' } }))

type Reply = { status: number; headers?: Record<string, string>; body?: Buffer | string }

let clock = 1_793_000_000_000
let dns: Record<string, string[]> = {}
let pages: Record<string, Reply> = {}
let asked: { url: string; address: string }[] = []

beforeEach(() => {
  vi.resetModules()
  clock = 1_793_000_000_000
  dns = { 'news.example.com': ['93.184.216.34'], 'other.example.com': ['93.184.216.35'] }
  pages = {}
  asked = []
})

async function service() {
  const module = await import('../electron/services/urlFetchService')
  module.resetUrlFetch()
  module.urlFetchSeam.now = () => clock
  module.urlFetchSeam.resolve = async (host: string) => {
    const list = dns[host]
    if (list === undefined) throw new Error('ENOTFOUND')
    return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  module.urlFetchSeam.get = async (url: URL, pinned: { address: string }) => {
    asked.push({ url: url.toString(), address: pinned.address })
    const reply = pages[url.toString()] ?? { status: 404 }
    const body = reply.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body)
    return { status: reply.status, headers: reply.headers ?? {}, body: Readable.from([body]) }
  }
  return module
}

const html = (text: string): Reply => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: text })

describe('a page read', () => {
  it('comes from the vetted address, as the link was cut down, with its bytes and time', async () => {
    const fetch = await service()
    pages['https://news.example.com/a'] = html('<p>hello</p>')
    const page = await fetch.fetchPage('https://news.example.com/a?utm_source=x#top')
    expect(page).toMatchObject({ ok: true, url: 'https://news.example.com/a', finalUrl: 'https://news.example.com/a', html: '<p>hello</p>', bytes: 12, address: '93.184.216.34', status: 200, redirects: [] })
    expect(asked).toEqual([{ url: 'https://news.example.com/a', address: '93.184.216.34' }])
  })
  it('reads a gzip page, and its charset', async () => {
    const fetch = await service()
    pages['https://news.example.com/z'] = { status: 200, headers: { 'content-type': 'text/html; charset=iso-8859-1', 'content-encoding': 'gzip' }, body: gzipSync(Buffer.from([0x63, 0x61, 0x66, 0xe9])) }
    expect(await fetch.fetchPage('https://news.example.com/z')).toMatchObject({ ok: true, html: 'café' })
  })
  it('follows three redirects at most, each checked, a relative one read against the page', async () => {
    const fetch = await service()
    pages['https://news.example.com/r1'] = { status: 301, headers: { location: '/r2' } }
    pages['https://news.example.com/r2'] = { status: 302, headers: { location: 'https://other.example.com/r3?utm_campaign=x' } }
    pages['https://other.example.com/r3'] = html('<p>there</p>')
    expect(await fetch.fetchPage('https://news.example.com/r1')).toMatchObject({ ok: true, finalUrl: 'https://other.example.com/r3', redirects: ['https://news.example.com/r2', 'https://other.example.com/r3'], html: '<p>there</p>' })
    pages['https://news.example.com/l1'] = { status: 301, headers: { location: '/l2' } }
    pages['https://news.example.com/l2'] = { status: 301, headers: { location: '/l3' } }
    pages['https://news.example.com/l3'] = { status: 301, headers: { location: '/l4' } }
    pages['https://news.example.com/l4'] = { status: 301, headers: { location: '/l5' } }
    clock += URL_FETCH_LINES.hostGapMs
    expect(await fetch.fetchPage('https://news.example.com/l1')).toMatchObject({ ok: false, failure: 'redirects' })
  })
  it('refuses a redirect to a link that is not read, or to a private address', async () => {
    const fetch = await service()
    pages['https://news.example.com/h'] = { status: 302, headers: { location: 'http://news.example.com/plain' } }
    expect(await fetch.fetchPage('https://news.example.com/h')).toMatchObject({ ok: false, failure: 'refused' })
    dns['inside.example.com'] = ['10.0.0.5']
    pages['https://other.example.com/p'] = { status: 302, headers: { location: 'https://inside.example.com/secret' } }
    expect(await fetch.fetchPage('https://other.example.com/p')).toMatchObject({ ok: false, failure: 'address' })
    expect(asked.map((entry) => entry.url)).not.toContain('https://inside.example.com/secret')
  })
})

describe('a page not read', () => {
  it('says why: the link, the name, an address, the status, the type, the encoding', async () => {
    const fetch = await service()
    expect(await fetch.fetchPage('http://news.example.com/a')).toMatchObject({ ok: false, failure: 'refused' })
    expect(await fetch.fetchPage('https://nowhere.example.com/a')).toMatchObject({ ok: false, failure: 'dns' })
    dns['mixed.example.com'] = ['93.184.216.40', '127.0.0.1']
    expect(await fetch.fetchPage('https://mixed.example.com/a')).toMatchObject({ ok: false, failure: 'address' })
    dns['six.example.com'] = ['::ffff:192.168.1.1']
    expect(await fetch.fetchPage('https://six.example.com/a')).toMatchObject({ ok: false, failure: 'address' })
    dns['empty.example.com'] = []
    expect(await fetch.fetchPage('https://empty.example.com/a')).toMatchObject({ ok: false, failure: 'dns' })
    expect(asked).toEqual([])
    pages['https://other.example.com/missing'] = { status: 404 }
    expect(await fetch.fetchPage('https://other.example.com/missing')).toMatchObject({ ok: false, failure: 'status' })
    clock += URL_FETCH_LINES.hostGapMs
    pages['https://other.example.com/img'] = { status: 200, headers: { 'content-type': 'image/png' }, body: 'x' }
    expect(await fetch.fetchPage('https://other.example.com/img')).toMatchObject({ ok: false, failure: 'type' })
    clock += URL_FETCH_LINES.hostGapMs
    pages['https://other.example.com/br'] = { status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'br' }, body: 'x' }
    expect(await fetch.fetchPage('https://other.example.com/br')).toMatchObject({ ok: false, failure: 'encoding' })
  })
  it('stops at two megabytes once decoded, a small gzip that grows past them included', async () => {
    const fetch = await service()
    pages['https://news.example.com/big'] = html('x'.repeat(URL_FETCH_LINES.maxBytes + 1))
    expect(await fetch.fetchPage('https://news.example.com/big')).toMatchObject({ ok: false, failure: 'too-large' })
    const bomb = gzipSync(Buffer.alloc(URL_FETCH_LINES.maxBytes * 4, 0x61))
    expect(bomb.length).toBeLessThan(100_000)
    pages['https://other.example.com/bomb'] = { status: 200, headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: bomb }
    expect(await fetch.fetchPage('https://other.example.com/bomb')).toMatchObject({ ok: false, failure: 'too-large' })
  })
  it('starts on a host once in ten seconds', async () => {
    const fetch = await service()
    pages['https://news.example.com/a'] = html('<p>a</p>')
    expect((await fetch.fetchPage('https://news.example.com/a')).ok).toBe(true)
    clock += URL_FETCH_LINES.hostGapMs - 1
    expect(await fetch.fetchPage('https://news.example.com/a')).toMatchObject({ ok: false, failure: 'paced' })
    clock += 1
    expect((await fetch.fetchPage('https://news.example.com/a')).ok).toBe(true)
  })
  it('gives up at its one deadline', async () => {
    const fetch = await service()
    let calls = 0
    fetch.urlFetchSeam.now = () => (calls++ === 0 ? clock : clock + URL_FETCH_LINES.deadlineMs + 1)
    expect(await fetch.fetchPage('https://news.example.com/a')).toMatchObject({ ok: false, failure: 'timeout' })
  })
})
