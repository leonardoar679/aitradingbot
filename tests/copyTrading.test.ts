import { describe, expect, it } from 'vitest'
import { DEFAULT_COPY_TRADING, healCopyTrading } from '../shared/traders/copyTrading'

// WHICH TRADERS ARE FOLLOWED OR CLONED ON PAPER (shared/traders/copyTrading.ts; V8 Stage 8): no one on a fresh install;
// a follow only of a Hyperliquid or OKX trader on file, with when it began and its time limit; a clone only with a
// rule in its shape and the perpetuals of its coins; everything else left out.

const HL = 'hyperliquid-0x0b4b6beaca45fce66ca818fbd867ec3761ed2143'
const OKX = 'okx-35E22983F436F55B'
const FILE = 'file-019b6c3cc293e353'
const RULE = { side: 'short', holdBars: 8, conditions: [{ feature: 'ret4h', op: '<=', threshold: -0.04 }, { feature: 'ret24h', op: '>=', threshold: -0.01 }] }

describe('the copy-trading setting', () => {
  it('follows and clones no one, read empty or as junk', () => {
    for (const junk of [undefined, null, {}, [], 'x', 7, { follows: 'all', clones: [] }]) expect(healCopyTrading(junk)).toEqual(DEFAULT_COPY_TRADING)
    expect(DEFAULT_COPY_TRADING).toEqual({ follows: {}, clones: {} })
  })

  it('keeps a follow of a Hyperliquid or OKX trader with when it began and its time limit, and no other', () => {
    const healed = healCopyTrading({
      follows: {
        [HL]: { since: 1_793_000_000_000, maxHoldSec: 3600 },
        [OKX]: { since: 1_793_000_000_000, maxHoldSec: 604_800 },
        [FILE]: { since: 1_793_000_000_000, maxHoldSec: 3600 },
        'okx-nope': { since: 1, maxHoldSec: 1 },
        'hyperliquid-0xABC': { since: 1, maxHoldSec: 1 },
        [`${HL.slice(0, -1)}9`]: { since: 0, maxHoldSec: 3600 },
        [`${OKX.slice(0, -1)}C`]: { since: 1_793_000_000_000, maxHoldSec: -1 }
      }
    })
    expect(Object.keys(healed.follows).sort()).toEqual([HL, OKX].sort())
    expect(healed.follows[HL]).toEqual({ since: 1_793_000_000_000, maxHoldSec: 3600 })
  })

  it("keeps a clone with a rule in its shape and its coins' perpetuals, a file's trader's among them", () => {
    const coins = [{ coin: 'ETH', venue: 'binance', symbol: 'ETHUSDT' }, { coin: 'X', venue: 'kraken', symbol: 'XUSD' }, { coin: 'Y', venue: 'bitget', symbol: 'y-usdt' }]
    const healed = healCopyTrading({
      clones: {
        [FILE]: { since: 5, rule: RULE, coins },
        [HL]: { since: 5, rule: { ...RULE, side: 'up' }, coins },
        [OKX]: { since: 5, rule: { ...RULE, conditions: [...RULE.conditions, RULE.conditions[0]] }, coins },
        'okx-AB12CD34EF56GH78': { since: 5, rule: { ...RULE, conditions: [{ feature: 'moon', op: '<=', threshold: 1 }] }, coins },
        'okx-AB12CD34EF56GH79': { since: 5, rule: { ...RULE, holdBars: 1.5 }, coins },
        'okx-AB12CD34EF56GH80': { since: 5, rule: RULE, coins: [] },
        'okx-AB12CD34EF56GH81': { since: 5, rule: { ...RULE, conditions: [{ ...RULE.conditions[0], op: '<' }] }, coins }
      }
    })
    expect(Object.keys(healed.clones)).toEqual([FILE])
    expect(healed.clones[FILE]).toEqual({ since: 5, rule: RULE, coins: [{ coin: 'ETH', venue: 'binance', symbol: 'ETHUSDT' }] })
  })
})
