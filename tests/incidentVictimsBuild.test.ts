import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { INCIDENT_VICTIMS_LINES, namesOf, readVictimsFile, refreshUsable, victimsFileText, victimsOf, type VictimRow } from '../shared/incidentVictimsBuild'

// shared/incidentVictimsBuild.ts: the rules a hack's victims are named by, from DefiLlama's protocols and chains and
// the tokens Binance trades -- the committed table's and the app's weekly reading's (V9 Stages 2 and 8).

const TRADABLE = new Set(['AAVE', 'SMALL', 'STRK', 'BNB', 'TWA', 'TWB', 'ABC', '1INCH', 'CRV', 'INIT', 'SUI', 'ETH', 'UNI', 'WRONG', 'W'])
const PROTOCOLS = [
  { name: 'Aave V3', symbol: 'AAVE', tvl: 3e10, category: 'Lending' },
  { name: 'Small Thing', symbol: 'SMALL', tvl: 5e6 },
  { name: 'Strike', symbol: 'STRK', tvl: 1e8 },
  { name: 'Binance CEX', symbol: 'BNB', tvl: 1e11, category: 'CEX' },
  { name: 'Twin Protocol', symbol: 'TWA', tvl: 1e8 },
  { name: 'Twin Finance', symbol: 'TWB', tvl: 1e8 },
  { name: 'Nottraded Swap', symbol: 'NOPE', tvl: 1e9 },
  { name: 'Abc', symbol: 'ABC', tvl: 1e9 },
  { name: '1inch', symbol: '1INCH', tvl: 1e9 },
  { name: 'Curve DEX', symbol: 'CRV', tvl: 2e9 },
  { name: 'Uniswap V3', symbol: 'WRONG', tvl: 5e9 },
  // DefiLlama names Hyperliquid with a token Binance trades; the hand's HYPE is not traded here, so the name is left out.
  { name: 'Hyperliquid', symbol: 'WRONG', tvl: 1e9 },
  { name: 'No Token', symbol: '-', tvl: 5e9 },
  null
]
const CHAINS = [{ name: 'Ethereum', tokenSymbol: 'ETH' }, { name: 'Initia', tokenSymbol: 'INIT' }, { name: 'Sui', tokenSymbol: 'SUI' }, { name: 'Unlisted', tokenSymbol: 'ZZZ' }]

describe("a hack's victims, by name", () => {
  it('keeps a chain whose token trades on Binance and a protocol of $20 million whose token does, by every name it gives', () => {
    expect(victimsOf(PROTOCOLS, CHAINS, TRADABLE)).toEqual([
      ['aave', 'AAVE', 'protocol'],
      ['aave v3', 'AAVE', 'protocol'],
      ['curve dex', 'CRV', 'protocol'],
      ['curve finance', 'CRV', 'protocol'],
      ['initia', 'INIT', 'chain'],
      ['portal bridge', 'W', 'protocol'],
      ['twin finance', 'TWB', 'protocol'],
      ['twin protocol', 'TWA', 'protocol'],
      ['uniswap', 'UNI', 'protocol'],
      ['uniswap v3', 'WRONG', 'protocol'],
      ['wormhole', 'W', 'protocol']
    ])
  })

  it('leaves out a short name, an everyday word, the largest chains, a name two tokens claim, an exchange, and a small or untraded one', () => {
    const names = new Set(victimsOf(PROTOCOLS, CHAINS, TRADABLE).map((row) => row[0]))
    for (const left of ['small thing', 'strike', 'binance cex', 'binance', 'twin', 'nottraded swap', 'nottraded', 'abc', '1inch', 'curve', 'ethereum', 'sui', 'unlisted', 'no token']) expect(names.has(left), left).toBe(false)
    expect(namesOf('Jupiter  Lend')).toEqual(['jupiter lend', 'jupiter'])
    expect(namesOf('Gnosis DAO')).toEqual([])
  })

  it('sets the names it holds by hand over what was read, and leaves out one whose token Binance does not trade', () => {
    const rows = victimsOf(PROTOCOLS, CHAINS, TRADABLE)
    // DefiLlama gave Uniswap another token; the hand's is UNI. Hyperliquid's HYPE is not traded here, so it is left out.
    expect(rows.find((row) => row[0] === 'uniswap')).toEqual(['uniswap', 'UNI', 'protocol'])
    expect(rows.some((row) => row[0] === 'hyperliquid')).toBe(false)
    const withoutW = victimsOf(PROTOCOLS, CHAINS, new Set([...TRADABLE].filter((token) => token !== 'W')))
    expect(withoutW.some((row) => row[1] === 'W')).toBe(false)
  })

  it('uses a table read again only with enough names, keeping most of those in use', () => {
    const table = (count: number, from = 0): VictimRow[] => Array.from({ length: count }, (_, k) => [`name ${from + k}`, 'TKN', 'protocol'])
    expect(refreshUsable(table(INCIDENT_VICTIMS_LINES.minNames - 1), [])).toBe(false)
    expect(refreshUsable(table(INCIDENT_VICTIMS_LINES.minNames), [])).toBe(true)
    // Of 200 in use, the new table keeps 120 (60%) and then 119.
    expect(refreshUsable(table(200, 80), table(200))).toBe(true)
    expect(refreshUsable(table(200, 81), table(200))).toBe(false)
  })

  it("writes the committed table's own text, and reads back only a table of its version with whole rows", () => {
    // Git may check the table out with CRLF (core.autocrlf), which the main checkout does; the builder writes LF.
    const text = readFileSync(join(__dirname, '..', 'shared', 'incidentVictims.json'), 'utf-8').replace(/\r\n/g, '\n')
    const file = readVictimsFile(JSON.parse(text))
    expect(file?.victims.length).toBeGreaterThanOrEqual(INCIDENT_VICTIMS_LINES.minNames)
    expect(victimsFileText(file as NonNullable<typeof file>)).toBe(text)
    expect(readVictimsFile({ ...file, version: 'incident-victims-v0' })).toBeNull()
    expect(readVictimsFile({ ...file, readAt: '6 November' })).toBeNull()
    expect(readVictimsFile({ ...file, victims: [['aave', 'AAVE']] })).toBeNull()
    expect(readVictimsFile('not a table')).toBeNull()
  })
})
