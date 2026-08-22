import { describe, it, expect } from 'vitest'
import { describeBlockedExits } from '../src/livetrading/blockedExits'

const base = { watchedPositions: 1, symbols: ['BTCUSDT'], sessionArmed: false, killSwitchEngaged: false }

describe('describeBlockedExits', () => {
  it('says nothing when there is nothing being watched', () => {
    expect(describeBlockedExits({ ...base, watchedPositions: 0, symbols: [] })).toBeNull()
  })

  it('says nothing while live trading is armed and the kill switch is off', () => {
    expect(describeBlockedExits({ ...base, sessionArmed: true })).toBeNull()
  })

  // The whole reason this exists: watchers persist across a restart, sessionArmed does not.
  it('warns when watched positions exist but the session is not armed', () => {
    const msg = describeBlockedExits(base)
    expect(msg).toContain('CANNOT fire')
    expect(msg).toContain('arm live trading')
    expect(msg).toContain('resets when the app restarts')
  })

  it('names the symbols so the user knows which positions are exposed', () => {
    const msg = describeBlockedExits({ ...base, watchedPositions: 2, symbols: ['BTCUSDT', 'ETHUSDT'] })
    expect(msg).toContain('BTCUSDT')
    expect(msg).toContain('ETHUSDT')
  })

  it('pluralises correctly', () => {
    expect(describeBlockedExits(base)).toContain('1 live position')
    expect(describeBlockedExits(base)).not.toContain('positions')
    expect(describeBlockedExits({ ...base, watchedPositions: 3 })).toContain('3 live positions')
  })

  // "Kill switch" reads as protective. It is not: it freezes positions open by blocking the
  // closing order too, so this case needs its own wording rather than the arming one.
  it('gives the kill switch its own wording, even while armed', () => {
    const msg = describeBlockedExits({ ...base, sessionArmed: true, killSwitchEngaged: true })
    expect(msg).toContain('kill switch')
    expect(msg).toContain('frozen open, not protected')
    expect(msg).not.toContain('arm live trading')
  })

  it('prefers the kill switch wording when both gates are shut', () => {
    const msg = describeBlockedExits({ ...base, sessionArmed: false, killSwitchEngaged: true })
    expect(msg).toContain('kill switch')
  })

  it('copes with no symbols reported', () => {
    const msg = describeBlockedExits({ ...base, symbols: [] })
    expect(msg).toContain('1 live position')
    expect(msg).not.toContain('()')
  })
})
