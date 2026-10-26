import { describe, expect, it } from 'vitest'
import { URL_FETCH_LINES, addressRefusal, hostRefusal, isIpLiteral, sanitizeUrl } from '../shared/urlSafety'

// A PASTED LINK, MADE SAFE TO READ (shared/urlSafety.ts; V8 Stage 4): https on its usual port, no user name or
// password, no fragment, only the query fields that select an article; no host that is an address, a name of one
// label or a private name; and no resolved address that is private, loopback, link-local, shared, reserved, or carries
// one of those inside an IPv6 address.

describe('a pasted link', () => {
  it('is cut down to what an article needs', () => {
    expect(sanitizeUrl('  https://www.CoinDesk.com/markets/2026/10/26/a-story/?utm_source=x&utm_medium=y&fbclid=z#comments ')).toEqual({
      ok: true,
      url: 'https://www.coindesk.com/markets/2026/10/26/a-story/',
      host: 'www.coindesk.com',
      path: '/markets/2026/10/26/a-story/',
      removedFields: ['utm_source', 'utm_medium', 'fbclid']
    })
    expect(sanitizeUrl('https://example.org/?p=123&ref=abc')).toMatchObject({ ok: true, url: 'https://example.org/?p=123', removedFields: ['ref'] })
    expect(sanitizeUrl('https://www.youtube.com/watch?v=abc&t=10s')).toMatchObject({ ok: true, url: 'https://www.youtube.com/watch?v=abc' })
    expect(sanitizeUrl('https://example.org')).toMatchObject({ ok: true, url: 'https://example.org/' })
    expect(sanitizeUrl('https://example.org:443/a')).toMatchObject({ ok: true, url: 'https://example.org/a' })
  })
  it('compares an international host in its ASCII form', () => {
    expect(sanitizeUrl('https://bücher.example.com/a')).toMatchObject({ ok: true, host: 'xn--bcher-kva.example.com' })
  })
  it('is refused, saying why, where it is not one to read', () => {
    expect(sanitizeUrl('')).toMatchObject({ ok: false, refused: 'not-a-url' })
    expect(sanitizeUrl('not a link')).toMatchObject({ ok: false, refused: 'not-a-url' })
    expect(sanitizeUrl('http://example.org/a')).toMatchObject({ ok: false, refused: 'not-https' })
    expect(sanitizeUrl('file:///etc/passwd')).toMatchObject({ ok: false, refused: 'not-https' })
    expect(sanitizeUrl('javascript:alert(1)')).toMatchObject({ ok: false, refused: 'not-https' })
    expect(sanitizeUrl('https://user:pass@example.org/a')).toMatchObject({ ok: false, refused: 'userinfo' })
    expect(sanitizeUrl('https://user@example.org/a')).toMatchObject({ ok: false, refused: 'userinfo' })
    expect(sanitizeUrl('https://example.org:8443/a')).toMatchObject({ ok: false, refused: 'port' })
    expect(sanitizeUrl('https://127.0.0.1/a')).toMatchObject({ ok: false, refused: 'ip-literal' })
    expect(sanitizeUrl('https://2130706433/a')).toMatchObject({ ok: false, refused: 'ip-literal' })
    expect(sanitizeUrl('https://0x7f.1/a')).toMatchObject({ ok: false, refused: 'ip-literal' })
    expect(sanitizeUrl('https://[::1]/a')).toMatchObject({ ok: false, refused: 'ip-literal' })
    expect(sanitizeUrl('https://intranet/a')).toMatchObject({ ok: false, refused: 'single-label' })
    expect(sanitizeUrl('https://localhost/a')).toMatchObject({ ok: false, refused: 'single-label' })
    expect(sanitizeUrl('https://printer.local/a')).toMatchObject({ ok: false, refused: 'private-name' })
    expect(sanitizeUrl('https://router.home.arpa/a')).toMatchObject({ ok: false, refused: 'private-name' })
    expect(sanitizeUrl(`https://example.org/${'a'.repeat(2100)}`)).toMatchObject({ ok: false, refused: 'too-long' })
  })
  it('reads the hosts that are addresses as such', () => {
    expect(isIpLiteral('10.0.0.1')).toBe(true)
    expect(isIpLiteral('[fe80::1]')).toBe(true)
    expect(isIpLiteral('example.org')).toBe(false)
    expect(hostRefusal('www.binance.com')).toBeNull()
    expect(hostRefusal('api.internal')).toMatchObject({ refused: 'private-name' })
    expect(hostRefusal('example.org.')).toBeNull()
  })
})

describe('a resolved address', () => {
  it('is read from where it is public', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '104.16.132.229', '2606:4700::6810:84e5', '2a00:1450:4001:82a::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1']) {
      expect(addressRefusal(address), address).toBeNull()
    }
  })
  it('is refused where it is private, loopback, link-local, shared, reserved or not an address', () => {
    for (const address of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '100.64.0.1',
      '100.127.255.254',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.0.0.8',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.7',
      '203.0.113.9',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1%eth0',
      'fec0::1',
      'ff02::1',
      '2001:db8::1',
      '2001:0:4136:e378::1',
      '100::1',
      'nonsense'
    ]) {
      expect(addressRefusal(address), address).not.toBeNull()
    }
    // Public neighbours of the refused blocks are not refused.
    for (const address of ['100.63.255.255', '100.128.0.1', '172.15.255.255', '172.32.0.1', '192.169.0.1', '223.255.255.255']) {
      expect(addressRefusal(address), address).toBeNull()
    }
  })
  it('judges an IPv4 address carried inside an IPv6 one as the IPv4 address', () => {
    expect(addressRefusal('::ffff:10.0.0.1')).toMatch(/10\.0\.0\.1/)
    expect(addressRefusal('::ffff:a00:1')).toMatch(/10\.0\.0\.1/)
    expect(addressRefusal('::ffff:127.0.0.1')).toMatch(/127\.0\.0\.1/)
    expect(addressRefusal('64:ff9b::a9fe:a9fe')).toMatch(/169\.254\.169\.254/)
    expect(addressRefusal('2002:c0a8:101::1')).toMatch(/192\.168\.1\.1/)
    expect(addressRefusal('::8.8.8.8')).toMatch(/IPv4-compatible/)
  })
})

describe("the fetch's lines", () => {
  it('are one 15 s deadline, three redirects, 2 MB decoded and 10 s between two reads of a host', () => {
    expect(URL_FETCH_LINES).toMatchObject({ deadlineMs: 15_000, maxRedirects: 3, maxBytes: 2 * 1024 * 1024, hostGapMs: 10_000 })
  })
})
