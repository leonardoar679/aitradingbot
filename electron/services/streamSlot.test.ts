import { describe, it, expect } from 'vitest'
import { createStreamSlot } from './streamSlot'

/** A connect() whose resolution this test controls, so overlapping calls can be interleaved
 * deterministically instead of racing a real websocket. */
function deferredSocket(name: string, closed: string[]) {
  let resolve!: () => void
  const connected = new Promise<void>((r) => (resolve = r))
  const connect = async (): Promise<(() => void)> => {
    await connected
    return () => closed.push(name)
  }
  return { connect, finishConnecting: resolve }
}

describe('createStreamSlot', () => {
  it('closes the previous socket when opening a new one', async () => {
    const closed: string[] = []
    const slot = createStreamSlot()
    const a = deferredSocket('a', closed)
    const b = deferredSocket('b', closed)

    const first = slot.open(a.connect)
    a.finishConnecting()
    await first

    expect(closed).toEqual([])
    const second = slot.open(b.connect)
    b.finishConnecting()
    await second

    expect(closed).toEqual(['a'])
  })

  it('does not leak the first socket when two opens overlap', async () => {
    // The real sequence: click 1m, click 15m before 1m has finished connecting. Both connects
    // then resolve. Without a generation check the 1m socket becomes unreachable and keeps
    // streaming its candles into the same listeners the 15m chart is reading.
    const closed: string[] = []
    const slot = createStreamSlot()
    const oneMinute = deferredSocket('1m', closed)
    const fifteenMinute = deferredSocket('15m', closed)

    const first = slot.open(oneMinute.connect)
    const second = slot.open(fifteenMinute.connect)

    oneMinute.finishConnecting()
    fifteenMinute.finishConnecting()
    await Promise.all([first, second])

    expect(closed).toEqual(['1m'])
  })

  it('closes the loser regardless of which connect resolves first', async () => {
    const closed: string[] = []
    const slot = createStreamSlot()
    const older = deferredSocket('older', closed)
    const newer = deferredSocket('newer', closed)

    const first = slot.open(older.connect)
    const second = slot.open(newer.connect)

    // Newer wins the connect race but is still the one that was asked for.
    newer.finishConnecting()
    older.finishConnecting()
    await Promise.all([first, second])

    expect(closed).toEqual(['older'])

    slot.close()
    expect(closed).toEqual(['older', 'newer'])
  })

  it('closes a socket that finishes connecting after close()', async () => {
    // Navigating away during a slow connect. This used to be a silent leak: close() found
    // nothing to stop, and the socket that landed afterwards had no reachable stop function.
    const closed: string[] = []
    const slot = createStreamSlot()
    const late = deferredSocket('late', closed)

    const opening = slot.open(late.connect)
    slot.close()
    expect(closed).toEqual([])

    late.finishConnecting()
    await opening

    expect(closed).toEqual(['late'])
  })

  it('closes the live socket', async () => {
    const closed: string[] = []
    const slot = createStreamSlot()
    const only = deferredSocket('only', closed)

    const opening = slot.open(only.connect)
    only.finishConnecting()
    await opening

    slot.close()
    expect(closed).toEqual(['only'])
  })

  it('does not close the same socket twice across repeated close() calls', async () => {
    const closed: string[] = []
    const slot = createStreamSlot()
    const only = deferredSocket('only', closed)

    const opening = slot.open(only.connect)
    only.finishConnecting()
    await opening

    slot.close()
    slot.close()
    expect(closed).toEqual(['only'])
  })

  it('propagates a failed connect and leaves the slot empty', async () => {
    const closed: string[] = []
    const slot = createStreamSlot()

    await expect(slot.open(async () => { throw new Error('connect timeout') })).rejects.toThrow('connect timeout')

    // Nothing to close, and the slot is still usable for the retry that follows.
    slot.close()
    expect(closed).toEqual([])

    const after = deferredSocket('after', closed)
    const opening = slot.open(after.connect)
    after.finishConnecting()
    await opening
    slot.close()
    expect(closed).toEqual(['after'])
  })
})
