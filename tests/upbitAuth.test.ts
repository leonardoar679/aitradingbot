import { createHash, createHmac } from 'crypto'
import { describe, expect, it } from 'vitest'
import { upbitAuthToken } from '../electron/services/exchanges/upbitTrading'

// Upbit authenticates with a signed JWT rather than a signature parameter on the query, so the
// whole credential is one opaque string. Get any part of it wrong and the answer is a 401 that
// says nothing about which part -- which is exactly why this is tested here rather than left to
// be discovered against the live API with someone's real key.
//
// This does not prove Upbit accepts the token. It proves the token is the one the documented
// scheme describes: the right claims, a real HMAC-SHA256 signature over header.payload, and the
// SHA512 query hash where one is called for.

const ACCESS = 'test-access-key'
const SECRET = 'test-secret-key'

function decode(token: string): { header: Record<string, string>; claims: Record<string, string>; signature: string } {
  const [header, payload, signature] = token.split('.')
  const fromBase64Url = (part: string): string =>
    Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  return { header: JSON.parse(fromBase64Url(header)), claims: JSON.parse(fromBase64Url(payload)), signature }
}

describe('upbitAuthToken — shape', () => {
  it('is a three-part JWT', () => {
    expect(upbitAuthToken(ACCESS, SECRET).split('.')).toHaveLength(3)
  })

  it('declares HS256, which is the algorithm it actually signs with', () => {
    // A header claiming one algorithm while the signature uses another is rejected, and the
    // rejection names neither.
    expect(decode(upbitAuthToken(ACCESS, SECRET)).header).toEqual({ alg: 'HS256', typ: 'JWT' })
  })

  it('carries the access key and a nonce', () => {
    const { claims } = decode(upbitAuthToken(ACCESS, SECRET))

    expect(claims.access_key).toBe(ACCESS)
    expect(claims.nonce).toBeTruthy()
  })

  it('uses base64url, not base64', () => {
    // A '+' or '/' in the encoding makes the token invalid, and both appear often enough in
    // HMAC output that this would fail intermittently rather than never.
    const token = upbitAuthToken('a+b/c==', SECRET, 'x=1')

    expect(token).not.toMatch(/[+/=]/)
  })
})

describe('upbitAuthToken — signature', () => {
  it('signs header.payload with the secret, so the token cannot be edited in flight', () => {
    const token = upbitAuthToken(ACCESS, SECRET)
    const [header, payload, signature] = token.split('.')
    const expected = createHmac('sha256', SECRET)
      .update(`${header}.${payload}`)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    expect(signature).toBe(expected)
  })

  it('signs with the secret and not the access key', () => {
    // They are two different strings and the wrong one produces a token that looks perfectly
    // well-formed. Nothing but a comparison catches this.
    const [header, payload, signature] = upbitAuthToken(ACCESS, SECRET, undefined, 'fixed-nonce').split('.')
    const wrongKey = createHmac('sha256', ACCESS).update(`${header}.${payload}`).digest('base64url')

    expect(signature).not.toBe(wrongKey)
  })

  it('produces a different signature for a different secret', () => {
    const a = upbitAuthToken(ACCESS, 'secret-one', undefined, 'fixed-nonce')
    const b = upbitAuthToken(ACCESS, 'secret-two', undefined, 'fixed-nonce')

    expect(a).not.toBe(b)
  })
})

describe('upbitAuthToken — the nonce', () => {
  it('differs between two tokens made at the same moment', () => {
    // Upbit requires it to be unique per request. A timestamp collides for two requests in the
    // same millisecond -- which is exactly what a page reading on mount and on a timer produces,
    // and the second request would be rejected as a replay.
    const tokens = new Set(Array.from({ length: 200 }, () => decode(upbitAuthToken(ACCESS, SECRET)).claims.nonce))

    expect(tokens.size).toBe(200)
  })
})

describe('upbitAuthToken — the query hash', () => {
  it('carries no hash at all when there are no parameters', () => {
    // Upbit rejects an empty query_hash rather than ignoring it, and /accounts -- the only call
    // this app makes -- takes no parameters.
    const { claims } = decode(upbitAuthToken(ACCESS, SECRET))

    expect(claims.query_hash).toBeUndefined()
    expect(claims.query_hash_alg).toBeUndefined()
  })

  it('treats an empty query string the same as no query', () => {
    const { claims } = decode(upbitAuthToken(ACCESS, SECRET, ''))

    expect(claims.query_hash).toBeUndefined()
  })

  it('hashes the query with SHA512 and says so', () => {
    const query = 'market=KRW-BTC&side=bid'
    const { claims } = decode(upbitAuthToken(ACCESS, SECRET, query))

    expect(claims.query_hash).toBe(createHash('sha512').update(query).digest('hex'))
    expect(claims.query_hash_alg).toBe('SHA512')
  })

  it('hashes hex, not base64 — the encoding is part of the agreement', () => {
    const { claims } = decode(upbitAuthToken(ACCESS, SECRET, 'market=KRW-BTC'))

    expect(claims.query_hash).toMatch(/^[0-9a-f]{128}$/)
  })

  it('produces a different hash for a different query', () => {
    const a = decode(upbitAuthToken(ACCESS, SECRET, 'market=KRW-BTC', 'n')).claims.query_hash
    const b = decode(upbitAuthToken(ACCESS, SECRET, 'market=KRW-ETH', 'n')).claims.query_hash

    expect(a).not.toBe(b)
  })
})
