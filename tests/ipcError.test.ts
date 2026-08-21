import { describe, expect, it } from 'vitest'
import { cleanIpcErrorMessage, describeError } from '../src/utils/ipcError'

// Every error a user sees from a main-process call arrives wrapped by electron's
// ipcRenderer.invoke. Unstripped, the message leads with an IPC channel name instead of the
// reason — which is noise to anyone who did not write the app.

describe('cleanIpcErrorMessage', () => {
  it('strips the invoke wrapper and the leading Error:', () => {
    expect(cleanIpcErrorMessage("Error invoking remote method 'market:subscribeCandles': Error: fetch failed")).toBe(
      'fetch failed'
    )
  })

  it('strips a bare leading Error:', () => {
    expect(cleanIpcErrorMessage('Error: Binance API error: API-key format invalid.')).toBe(
      'Binance API error: API-key format invalid.'
    )
  })

  it('leaves an already-clean message alone', () => {
    expect(cleanIpcErrorMessage('No credential configured for binance')).toBe('No credential configured for binance')
  })

  it('keeps a colon that belongs to the message itself', () => {
    // The channel pattern is anchored and quoted, so a message that merely contains a colon
    // must survive intact.
    expect(cleanIpcErrorMessage('Daily cap reached: 25 of 25 USDT used')).toBe('Daily cap reached: 25 of 25 USDT used')
  })

  it('keeps colons inside a wrapped message', () => {
    // The channel is quoted, so only the quoted span may be consumed. A greedy match would run
    // to the last colon and eat the start of the real message — and this app's own gate messages
    // are full of colons, so that would routinely truncate the reason a live order was refused.
    expect(
      cleanIpcErrorMessage(
        "Error invoking remote method 'liveTrading:placeOrder': Error: Daily cap reached: 25 of 25 USDT used"
      )
    ).toBe('Daily cap reached: 25 of 25 USDT used')
  })

  it('handles an empty string', () => {
    expect(cleanIpcErrorMessage('')).toBe('')
  })
})

describe('describeError', () => {
  it('unwraps an Error instance', () => {
    expect(describeError(new Error("Error invoking remote method 'x': Error: boom"))).toBe('boom')
  })

  it('stringifies a non-Error without throwing', () => {
    expect(describeError('plain string')).toBe('plain string')
    expect(describeError(null)).toBe('null')
    expect(describeError(undefined)).toBe('undefined')
  })
})
