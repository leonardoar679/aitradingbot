import { describe, it, expect } from 'vitest'
import { singleFlight } from '../electron/services/singleFlight'

function deferred() {
  let resolve!: (v?: unknown) => void
  let reject!: (e: unknown) => void
  const promise = new Promise((res, rej) => { resolve = res as typeof resolve; reject = rej })
  return { promise, resolve, reject }
}

describe('singleFlight', () => {
  it('runs the operation normally when nothing is in flight', async () => {
    const guarded = singleFlight(async () => 'ran', () => 'skipped')
    expect(await guarded()).toBe('ran')
  })

  it('skips a call that arrives while the first is still running', async () => {
    // The real case: a 10s connect timeout against a 5s poll interval.
    let runs = 0
    const gate = deferred()
    const guarded = singleFlight(
      async () => { runs++; await gate.promise; return 'ran' },
      () => 'skipped'
    )

    const first = guarded()
    expect(await guarded()).toBe('skipped')
    expect(runs).toBe(1)

    gate.resolve()
    expect(await first).toBe('ran')
    expect(runs).toBe(1)
  })

  it('accepts a new call once the first has finished', async () => {
    let runs = 0
    const gate = deferred()
    const guarded = singleFlight(async () => { runs++; await gate.promise; return runs }, () => -1)

    const first = guarded()
    gate.resolve()
    await first

    expect(await guarded()).toBe(2)
  })

  it('does not stay wedged busy after the operation throws', async () => {
    // Without the finally, one failed poll would silently stop every future poll -- the ledger
    // would simply never learn that a resting order had filled.
    let attempt = 0
    const guarded = singleFlight(
      async () => { attempt++; if (attempt === 1) throw new Error('network down'); return 'recovered' },
      () => 'skipped'
    )

    await expect(guarded()).rejects.toThrow('network down')
    expect(await guarded()).toBe('recovered')
  })

  it('keeps separate wrappers independent', async () => {
    const gate = deferred()
    const a = singleFlight(async () => { await gate.promise; return 'a' }, () => 'a-skipped')
    const b = singleFlight(async () => 'b', () => 'b-skipped')

    const pending = a()
    expect(await b()).toBe('b')

    gate.resolve()
    expect(await pending).toBe('a')
  })
})
