import { describe, expect, it, vi } from 'vitest'

// HYPERLIQUID'S FILLS AS THEY HAPPEN (electron/services/hyperliquidStream.ts; V8 Stage 8): one socket, a subscription
// for each of at most five addresses on every opening, a ping of Hyperliquid's own each fifty seconds, and each
// address's fills handed on with whether they are a snapshot; anything else on the socket passed over.

describe("Hyperliquid's stream of fills", () => {
  it('subscribes each address on every opening, pings each fifty seconds, and hands on fills alone', async () => {
    vi.resetModules()
    const module = await import('../electron/services/hyperliquidStream')
    let handlers: { onOpen?: (socket: unknown, renewed: boolean) => void; onMessage: (data: Buffer) => void; onConnectFailed?: (n: number) => void } | null = null
    let url = ''
    let stopped = false
    const timers: { run: () => void; ms: number }[] = []
    let cleared = 0
    Object.assign(module.hyperliquidStreamSeam, {
      open: (address: string, given: typeof handlers) => {
        url = address
        handlers = given
        return () => {
          stopped = true
        }
      },
      setInterval: (run: () => void, ms: number) => {
        timers.push({ run, ms })
        return timers.length as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => void cleared++
    })
    const fills: [string, number, boolean][] = []
    const failed: number[] = []
    let opened = 0
    const users = ['0x1', '0x2', '0x3', '0x4', '0x5', '0x6']
    const stop = module.streamHyperliquidFills(users, {
      onFills: (user, rows, snapshot) => void fills.push([user, rows.length, snapshot]),
      onOpen: () => void opened++,
      onConnectFailed: (n) => void failed.push(n)
    })
    expect(url).toBe('wss://api.hyperliquid.xyz/ws')
    const sent: string[] = []
    const socket = { OPEN: 1, readyState: 1, send: (text: string) => void sent.push(text) }
    handlers!.onOpen!(socket, false)
    expect(sent.map((text) => JSON.parse(text))).toEqual(users.slice(0, 5).map((user) => ({ method: 'subscribe', subscription: { type: 'userFills', user } })))
    expect(opened).toBe(1)
    expect(timers.map((timer) => timer.ms)).toEqual([50_000])
    timers[0].run()
    expect(JSON.parse(sent[sent.length - 1])).toEqual({ method: 'ping' })
    // A socket closing: no ping sent into it.
    const pinged = sent.length
    socket.readyState = 3
    timers[0].run()
    expect(sent).toHaveLength(pinged)
    socket.readyState = 1
    // A reopening subscribes again and replaces its ping.
    handlers!.onOpen!(socket, true)
    expect(sent.filter((text) => text.includes('subscribe'))).toHaveLength(10)
    expect(cleared).toBe(1)
    const frame = (value: unknown): Buffer => Buffer.from(JSON.stringify(value))
    handlers!.onMessage(frame({ channel: 'userFills', data: { user: '0xAB', isSnapshot: true, fills: [{}, {}] } }))
    handlers!.onMessage(frame({ channel: 'userFills', data: { user: '0x1', fills: [{}] } }))
    handlers!.onMessage(frame({ channel: 'pong' }))
    handlers!.onMessage(frame({ channel: 'subscriptionResponse', data: { user: '0x1', fills: [{}] } }))
    handlers!.onMessage(frame({ channel: 'userFills', data: { user: 7, fills: [] } }))
    handlers!.onMessage(Buffer.from('not json'))
    expect(fills).toEqual([
      ['0xab', 2, true],
      ['0x1', 1, false]
    ])
    handlers!.onConnectFailed!(3)
    expect(failed).toEqual([3])
    stop()
    expect(stopped).toBe(true)
    expect(cleared).toBe(2)
  })
})
