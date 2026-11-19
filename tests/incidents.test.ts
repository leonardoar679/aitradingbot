import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import victimsFile from '../shared/incidentVictims.json'
import { COMMITTED_VICTIMS, EXCHANGES, INCIDENT_LINES, amountsOf, incidentKeys, incidentsOf, mainClause, readIncident, setVictims, victimNames, victimOf } from '../shared/incidents'
import { assetDictionary, eventTypeOf, namedTickers, readStory, type FeedStory } from '../shared/newsFeed'

// shared/incidents.ts: a hack story read for its incident -- its victim, its sum, and whether it is the first report
// (V9 Stage 2, 6 November 2026). The headlines are the two archives' own, from the user's profile and V8's three-day
// run, as the feeds wrote them.

const DICTIONARY = assetDictionary(['BTC', 'ETH', 'SOL', 'BNB', 'INIT', 'RUNE', 'ARB', 'CETUS', 'HYPE', 'AAVE', 'POL', 'OKB', 'W', 'KAVA'])
const AT = Date.parse('2026-10-29T21:36:00Z') / 1000

function story(title: string, over: Partial<FeedStory> & { at?: number } = {}): FeedStory {
  const publishedAt = over.at ?? AT
  return { id: `decrypt:${title.length}:${publishedAt}`, source: 'decrypt', sourceName: 'Decrypt', sourceClass: 'media', title, url: 'https://decrypt.co/x', publishedAt, seenAt: publishedAt + 60, summary: '', ...over }
}

const read = (title: string, over: Partial<FeedStory> & { at?: number } = {}) => readIncident(story(title, over), DICTIONARY)

describe("what the run's fourth try told wrong (v9-7d, 9-16 November 2026)", () => {
  it('names a victim with a word of its part between its name and its loss', () => {
    // Told WATCH with no victim: "Lend" stood between the name and "loses". KAVA fell nearly 40%.
    expect(read('Kava Lend loses roughly $3.8 million to hack, sending KAVA token down nearly 40%')).toEqual({ report: 'first', why: null, victim: 'Kava', victimToken: 'KAVA', topExchange: false, amountUsd: 3.8e6 })
    // A word that is no part of a name still keeps the victim loose: the trader lost, not the protocol.
    expect(read('Uniswap trader loses $5 million to sandwich attack')).toMatchObject({ victim: null, victimToken: null })
  })

  it("reads a theft told as an authority's word as its attribution, whatever news of a loss it carries", () => {
    expect(read('North Korea Stole $400 Million in Crypto Using Deepfake Video Calls, DOJ Says')).toMatchObject({ report: 'follow-up', why: 'attribution', amountUsd: 400e6 })
    // An authority named beside a loss told as news, saying nothing, leaves it a first report.
    expect(read('Zyx Exchange hacked for $20 million as FBI opens probe')).toMatchObject({ report: 'first', amountUsd: 20e6 })
  })

  it('reads funds moved out unasked as a theft, its first report first and the next told before', () => {
    // Neither of Unocoin's two stories raised a notice: no word of a hack in either.
    const flagged = 'Unocoin ‘login suspension’ continues as exchange flags outgoing BitGo ETH transactions'
    expect(eventTypeOf({ title: flagged, summary: '' })).toBe('HACK')
    expect(read(flagged)).toEqual({ report: 'first', why: null, victim: 'Unocoin', victimToken: null, topExchange: false, amountUsd: null })
    const [first, next] = incidentsOf(
      [story(flagged, { id: 'theblock:u' }), story('Unocoin keeps deposits and withdrawals halted over suspect transfers', { id: 'cointelegraph:u', at: AT + 18 * 3600 })].map((entry) => readStory(entry, DICTIONARY, 0.8, entry.publishedAt + 60)),
      DICTIONARY,
      AT + 7 * 86_400
    )
    expect(first.incident).toMatchObject({ report: 'first', victim: 'Unocoin' })
    expect(next.incident).toMatchObject({ report: 'follow-up', why: 'told before' })
    // A transfer that is only large is no theft.
    expect(read('Whale makes large transfers of ETH to Binance ahead of the Fed')).toBeNull()
  })
})

describe("what the run's third try told loudly and should not have (v9-7d, 6-9 November 2026)", () => {
  it('reads a breach of data alone, with no sum and no funds lost, as no theft', () => {
    expect(read('Crypto Card Provider Gnosis Pay Says Hackers Accessed Customer Data')).toBeNull()
    expect(read('Chainalysis says breach exposed password hashes and live tokens')).toBeNull()
    expect(read('Gnosis Pay breach exposes card details, personal data and crypto wallet information')).toBeNull()
    // The archives' own breaches of data, read as thefts before.
    expect(read('Chainalysis says hacker using ‘offensive agentic techniques’ accessed its customers’ names and emails')).toBeNull()
    expect(read('Keystone customers say breach exposed data the hardware wallet maker promised to delete')).toBeNull()
    expect(read('Keystone says website breach exposed hardware wallet buyers’ addresses')).toBeNull()
    // A wallet bug that let funds be stolen is a theft, data or no.
    expect(read('Bitcoin wallet bug let rogue servers steal funds when users tried to speed up payments')).toMatchObject({ report: 'first' })
    // A breach with a sum, or with funds lost, is still a theft.
    expect(read('Hackers drain $12 million in a data breach at Zyx Exchange')).toMatchObject({ report: 'first', amountUsd: 12e6 })
    expect(read('Hackers accessed customer data and drained user funds at Zyx Exchange')).toMatchObject({ report: 'first' })
    expect(read('Zyx Exchange says hackers took $3 million in a customer data breach')).toMatchObject({ report: 'first', amountUsd: 3e6 })
  })

  it('reads a theft named as one already known, with no news of a loss, as a follow-up', () => {
    expect(read('Solana moves to scrap the transaction feature used in the $270 million Drift hack')).toMatchObject({ report: 'follow-up', why: 'past', amountUsd: 270e6 })
    // Told as news, a hack named with "the" is still a first report.
    expect(read('Zyx Exchange drained of $270 million in the hack of its hot wallet')).toMatchObject({ report: 'first', amountUsd: 270e6 })
  })
})

describe('a headline that reports a theft', () => {
  it('is read as the first report, its victim named at its loss with its own token, and its sum', () => {
    expect(read('Binance Drained of $5.5 Billion in Suspected Hack, Tether and Circle Freeze $1.8 Billion')).toEqual({
      report: 'first',
      why: null,
      victim: 'Binance',
      victimToken: 'BNB',
      topExchange: true,
      amountUsd: 5.5e9
    })
    expect(read('Initia halts network after security incident as attacker reportedly mints tokens')).toMatchObject({ report: 'first', victim: 'Initia', victimToken: 'INIT', topExchange: false, amountUsd: null })
    // A victim the tables know with no token of its own: named, and no coin.
    expect(read('Brazil’s Mercado Bitcoin halts withdrawals after $40 million drained across 10 chains')).toMatchObject({ report: 'first', victim: 'Mercado Bitcoin', victimToken: null, topExchange: false, amountUsd: 40e6 })
    // A victim the tables do not know: no victim, and the sum.
    expect(read('Cysic suspends bridge after attacker mints tokens and moves $727,000 to Ethereum')).toMatchObject({ report: 'first', victim: null, victimToken: null, amountUsd: 727_000 })
    expect(read('EU entity suspected of losing $106 million from crypto exchange accounts, ZachXBT says')).toMatchObject({ report: 'first', victim: null, amountUsd: 106e6 })
    expect(read('Polymarket Pauses Trading as Prediction Market Investigates Security Incident')).toMatchObject({ report: 'first', victim: null })
    expect(read('CoinDCX confirms $16 million loss from retired wallets days after CEO called breach reports a ‘false alarm’')).toMatchObject({ report: 'first', victim: 'CoinDCX', amountUsd: 16e6 })
    // A leak of data with no funds lost is no theft (since 9 November 2026; it was read as a first report before).
    expect(read('Bithumb discloses data leak after internal system breach: Report')).toBeNull()
    expect(read('Hackers hijack a dozen DeFi websites, all registered with Name.com, and steal about $138,000')).toMatchObject({ report: 'first', amountUsd: 138_000 })
  })

  it('is no report of a theft where its main clause names no loss', () => {
    expect(read('Bitget plans Thai crypto exchange acquisition weeks after $388M hack')).toBeNull()
    expect(read('Liquid Network Restores Full Bitcoin Backing Two Months After $320M Exploit')).toBeNull()
    expect(read('Coinbase says user funds are safe after third-party vendor exposes customer contact info')).toBeNull()
    expect(read("Binance Cuts Off SignalPlus API Keys Over 'Potential Security Issue' at Trading Platform")).toBeNull()
  })

  it('is a follow-up where it tells the aftermath, each by what it is', () => {
    const why = (title: string): string | null => read(title)?.why ?? null
    expect(why('Binance hackers move 81% of stolen Solana, route funds via THORChain')).toBe('laundering')
    expect(why('Drift exploiter sends $61M ETH to Tornado Cash, holds $194M')).toBe('laundering')
    expect(why('Arbitrum’s council moved $30 million of Binance hack funds without the hacker’s key')).toBe('laundering')
    expect(why('Liquid’s bitcoin IOUs are fully backed again after a $320 million exploit')).toBe('recovery')
    expect(why('Mercado Bitcoin pledges to cover all user losses after near $40 million hack')).toBe('recovery')
    expect(why("Brazil's Biggest Bitcoin Exchange Says It Will Refund Users After a $40 Million Hack")).toBe('recovery')
    expect(why("TRM and Chainalysis Tie $6.4B Binance Hack to North Korea's TraderTraitor")).toBe('attribution')
    expect(why('North Korea denies role in $6.3B Binance hack, points finger at US')).toBe('attribution')
    expect(why('Texas brothers sentenced to 15 years for holding Minnesota family at gunpoint in $8 million crypto heist')).toBe('trial')
    expect(why('Morning Minute: Tom Lee Calls the Binance Hack Bullish for Ethereum')).toBe('roundup')
    expect(why('Crypto audits give investors false sense of security as Q3 hacks cost $1.18 billion, Hacken says')).toBe('roundup')
    expect(why('Inside the largest crypto hack on record: How attackers breached Binance for $6.3 billion')).toBe('roundup')
    expect(why('Bitmine Buys More Ethereum as Tom Lee Calls the Binance Hack Bullish')).toBe('opinion')
    expect(why('Worried About Crypto Hacks? Buy Bitcoin Proxies in Stock Market Instead, Say Wall Street Firms')).toBe('opinion')
    expect(why('Trezor lifts password ceiling after Coldcard’s $100M wallet thefts')).toBe('past')
    // Customer data exposed, no funds lost: no theft at all (since 9 November 2026; an attribution before).
    expect(read('Coinbase denies systems breach, says vendor exposed customer data')).toBeNull()
    expect(why('Coinbase Customer Data Hit in Analytics Vendor Breach, Funds ‘Not Impacted’')).toBe('denial')
    expect(why('Coinbase Says 99% of Customer Crypto Is Offline and Out of Hackers’ Reach')).toBe('denial')
    expect(why('Suspected EU crypto theft estimate rises to $133M: ZachXBT')).toBe('estimate')
    expect(why('Mercado Bitcoin Said Its Hack Was Contained, But Blockchain Data Tells a Different Story')).toBe('continued')
    // Recycled news (shared/newsFeed.ts) is a follow-up whatever it says.
    expect(read('Binance Drained of $5.5 Billion in Suspected Hack', { repeat: true })).toMatchObject({ report: 'follow-up', why: 'recycled' })
  })

  it('stays a first report where it says the loss as news beside a word of the aftermath', () => {
    expect(read('Bybit hacked for $1.5 billion, pledges to cover all user losses')).toMatchObject({ report: 'first', victim: 'Bybit', topExchange: true })
    expect(read('Crypto Docs Host GitBook Hit by AI Agent Security Breach, Urges Users to Rotate Keys')).toMatchObject({ report: 'first' })
    // A denial is one only where no sum is named: CoinDCX confirmed its loss beside its CEO's "false alarm".
    expect(read('CoinDCX confirms $16 million loss days after CEO called it a false alarm')).toMatchObject({ report: 'first' })
    expect(read('Bitvavo says user funds are safe after $5 million hot wallet breach')).toMatchObject({ report: 'first', amountUsd: 5e6 })
    expect(read('Bitvavo says user funds are safe after hot wallet breach')).toMatchObject({ report: 'follow-up', why: 'denial' })
  })
})

describe('who lost the funds', () => {
  it('is the name at the loss, not the chain it ran on or the coins taken', () => {
    expect(victimOf('THORChain halts swaps after block reorg bug, slowing Binance hackers')?.victim.label).toBe('Binance')
    // The largest chains are no victims: "Solana bot drain" is a bot's, on Solana.
    expect(victimOf('Crypto investigators flag suspected $106M theft, $786K Solana bot drain')).toBeNull()
    expect(victimOf('Cetus exploited for $223 million on Sui')).toMatchObject({ written: 'Cetus', tight: true })
    expect(victimOf('Hyperliquid’s JELLY market exploited as whale squeezes vault')).toMatchObject({ written: 'Hyperliquid', tight: true })
  })

  it('is read loosely from the first exchange named where none is named at its loss, and then names no token', () => {
    expect(victimOf('Mercado Bitcoin, Brazil’s largest crypto exchange, hit by $46 million security breach')).toMatchObject({ tight: false })
    const loose = read('Binance, Deribit revoke SignalPlus API keys after fake Teams invite attack')
    expect(loose).toMatchObject({ victim: 'Binance', victimToken: null, topExchange: false })
  })

  it('names the token only where it trades on Binance', () => {
    expect(readIncident(story('Binance Drained of $5.5 Billion'), assetDictionary(['BTC']))).toMatchObject({ victim: 'Binance', victimToken: null, topExchange: true })
  })
})

describe('the week of stories', () => {
  const run = (stories: FeedStory[]) => incidentsOf(stories.map((entry) => readStory(entry, DICTIONARY, 0.8, entry.publishedAt + 60)), DICTIONARY, AT + 7 * 86_400)

  it('makes the first report of a victim the only first one: the next stories of it are told before', () => {
    const [first, second, third] = run([
      story('Binance Drained of $5.5 Billion in Suspected Hack, Tether and Circle Freeze $1.8 Billion', { id: 'decrypt:a' }),
      story('Binance investigating hack as suspicious outflows reach up to $5.8 billion', { id: 'theblock:b', at: AT + 13 * 60 }),
      story('Bitcoin slides below $77,000, BNB drops amid Binance hack', { id: 'theblock:c', at: AT + 5 * 3600 })
    ])
    expect(first.incident).toMatchObject({ report: 'first' })
    expect(second.incident).toMatchObject({ report: 'follow-up', why: 'told before' })
    expect(third.incident).toMatchObject({ report: 'follow-up', why: 'told before' })
  })

  it('follows a victim the headline does not name by its sum, and a victim by its token across its names', () => {
    const [first, mystery] = run([
      story('EU entity suspected of losing $106 million from crypto exchange accounts, ZachXBT says', { id: 'coindesk:a', at: AT }),
      story('Mystery $106 Million Crypto Theft Hits EU Entity Days After Binance Hack', { id: 'decrypt:b', at: AT + 4 * 3600 })
    ])
    expect(first.incident).toMatchObject({ report: 'first', amountUsd: 106e6 })
    expect(mystery.incident).toMatchObject({ report: 'follow-up', why: 'told before' })
    expect(incidentKeys({ victim: 'Aave V3', victimToken: 'AAVE', amountUsd: null })).toContain('token:AAVE')
  })

  it('reads two named victims of the same sum as two thefts', () => {
    const [mercado, dmm] = run([
      story('Brazil’s Mercado Bitcoin halts withdrawals after $40 million drained across 10 chains', { id: 'coindesk:a' }),
      story('DMM Bitcoin halts withdrawals after $40 million drained', { id: 'coindesk:b', at: AT + 86_400 })
    ])
    expect(mercado.incident).toMatchObject({ report: 'first', victim: 'Mercado Bitcoin' })
    expect(dmm.incident).toMatchObject({ report: 'first', victim: 'DMM Bitcoin', amountUsd: 40e6 })
    expect(dmm.assets).toEqual([])
  })

  it('reads a theft of the same victim as new again after the week the feed keeps', () => {
    const [, later] = run([story('Binance Drained of $5.5 Billion', { id: 'decrypt:a' }), story('Binance hacked again for $40 million', { id: 'decrypt:b', at: AT + INCIDENT_LINES.knownSeconds + 60 })])
    expect(later.incident).toMatchObject({ report: 'first', victimToken: 'BNB' })
  })

  it("keeps the victim's token as the story's one subject and every other coin as mentioned, with the impact read again", () => {
    const [cysic, binance, other] = run([
      story('Cysic suspends bridge after attacker mints tokens and moves $727,000 to Ethereum', { id: 'theblock:a' }),
      story('Binance hackers begin swapping stolen Solana tokens for Bitcoin: Chainalysis', { id: 'cointelegraph:b', at: AT + 60 }),
      story('Solana rallies as ETF inflows grow', { id: 'coindesk:c', at: AT + 120 })
    ])
    expect(cysic.assets).toEqual([{ ticker: 'ETH', relationship: 'INDIRECT' }])
    expect(binance.assets).toEqual([
      { ticker: 'BNB', relationship: 'DIRECT' },
      { ticker: 'SOL', relationship: 'INDIRECT' },
      { ticker: 'BTC', relationship: 'INDIRECT' }
    ])
    // Read on its loot coin, Cysic's story mattered as one naming ETH (90, DIRECT); on what it is, less.
    expect(cysic.impact).toBeLessThan(90 * 0.8)
    // A story of no hack keeps its coins and has no incident.
    expect(other).toMatchObject({ incident: null, assets: [{ ticker: 'SOL', relationship: 'DIRECT' }] })
  })

  it('makes a top exchange’s or a $100 million theft concern the whole market', () => {
    const [binance, mercado] = run([story('Binance Drained of $5.5 Billion', { id: 'decrypt:a' }), story('Brazil’s Mercado Bitcoin halts withdrawals after $40 million drained', { id: 'coindesk:b' })])
    expect(binance.marketWide).toBe(true)
    expect(mercado.marketWide).toBe(false)
  })
})

describe('the words', () => {
  it('drops a clause that dates an old theft, and reads sums in dollars', () => {
    expect(mainClause('Mystery $106 Million Crypto Theft Hits EU Entity Days After Binance Hack')).toBe('Mystery $106 Million Crypto Theft Hits EU Entity')
    expect(amountsOf('Binance Drained of $5.5 Billion, Tether and Circle Freeze $1.8 Billion')).toEqual([5.5e9, 1.8e9])
    expect(amountsOf('moves $727,000 to Ethereum; $786K bot drain; $4.8M; 15.99 million USDT')).toEqual([727_000, 786_000, 4.8e6, 15.99e6])
  })
})

describe('a company named for a coin, and a hack only where the headline says one (shared/newsFeed.ts, feed-v3)', () => {
  it('names no coin inside a company’s name, by name or by ticker', () => {
    const dictionary = assetDictionary(['BTC', 'ETH', 'ETHFI'])
    expect(namedTickers('Brazil’s Mercado Bitcoin halts withdrawals', dictionary)).toEqual([])
    expect(namedTickers('BTC Markets reports record volume', dictionary)).toEqual([])
    expect(namedTickers('BTC Markets reports record volume as Bitcoin climbs', dictionary)).toEqual(['BTC'])
    expect(namedTickers('ether.fi stakers move to new vaults', dictionary)).toEqual([])
    expect(namedTickers('Bitcoin rises', dictionary)).toEqual(['BTC'])
  })

  it('is a hack or an exploit by its headline alone, and no drain of a fund is one', () => {
    const kind = (title: string, summary = ''): string => eventTypeOf({ title, summary, binanceCategory: null })
    expect(kind('Coinbase hit with 50% price target cut as post-earnings rout deepens', 'Fallout from the Binance hack is clouding revenue.')).not.toBe('HACK')
    expect(kind('Bitcoin ETFs Shed Nearly $1 Billion in Two Weeks as Uptober Stays Red', 'following a $681.1 million drain the week before')).toBe('ETF')
    expect(kind('ETF drain deepens as outflows reach $1 billion')).not.toBe('EXPLOIT')
    expect(kind('Mercado Bitcoin halts withdrawals after $40 million drained across 10 chains')).toBe('EXPLOIT')
    expect(kind('Suspected EU crypto theft estimate rises to $133M: ZachXBT')).toBe('HACK')
    expect(kind('EU entity suspected of losing $106 million from crypto exchange accounts, ZachXBT says')).toBe('HACK')
    expect(kind('Bitcoin ETFs lost $643 million in outflows Friday, and 2026 is barely green now')).not.toBe('HACK')
    expect(kind('Polymarket Pauses Trading as Prediction Market Investigates Security Incident')).toBe('HACK')
  })
})

describe('the victims on file (shared/incidentVictims.json, research/fetch-incident-victims.mjs)', () => {
  it('holds names in lower case, each with a token in capitals, sorted, the largest chains and everyday words left out', () => {
    const rows = victimsFile.victims as unknown as [string, string, string][]
    expect(victimsFile.version).toBe('incident-victims-v1')
    expect(rows.length).toBeGreaterThan(150)
    expect(rows.map((row) => row[0])).toEqual([...rows.map((row) => row[0])].sort((a, b) => a.localeCompare(b)))
    for (const [name, token, kind] of rows) {
      expect(name).toBe(name.toLowerCase())
      expect(token).toMatch(/^[A-Z0-9]+$/)
      expect(['protocol', 'chain']).toContain(kind)
    }
    const names = new Set(rows.map((row) => row[0]))
    for (const left of ['bitcoin', 'ethereum', 'solana', 'binance', 'open', 'gas', 'strike', 'alpha']) expect(names.has(left), left).toBe(false)
    for (const kept of ['aave', 'initia', 'cetus', 'wormhole', 'thorchain', 'hyperliquid', 'uniswap']) expect(names.has(kept), kept).toBe(true)
  })

  it('reads an exchange by its own name first, and every name longest first', () => {
    const names = victimNames()
    expect(names.find((entry) => entry.name === 'binance')).toMatchObject({ label: 'Binance', kind: 'exchange', token: 'BNB', top: true })
    for (let index = 1; index < names.length; index++) expect(names[index - 1].name.length).toBeGreaterThanOrEqual(names[index].name.length)
    expect(EXCHANGES.filter((exchange) => exchange.top).map((exchange) => exchange.name)).toEqual(['Binance', 'Coinbase', 'OKX', 'Bybit', 'Upbit', 'Kraken', 'Bitget'])
  })

  it('is compiled by a script that reads public lists and writes the one file, by the rules the app reads them again by', () => {
    const script = readFileSync(join(__dirname, '..', 'research', 'fetch-incident-victims.ts'), 'utf-8')
    expect(script).toContain("'https://api.llama.fi/protocols'")
    expect(script).toContain("OUT ?? 'shared/incidentVictims.json'")
    expect(script).toContain("from '../shared/incidentVictimsBuild'")
    expect(script).not.toMatch(/apiKey|credentials|\/order|newOrder/)
  })

  it('reads the stories by the table the app read again, and by the committed one when told so', () => {
    const headline = 'Zyntharion exploited for $12 million in a price oracle attack'
    expect(victimOf(headline)).toBeNull()
    setVictims([...COMMITTED_VICTIMS, ['zyntharion', 'ZYN', 'protocol']])
    expect(victimOf(headline)).toMatchObject({ written: 'Zyntharion', tight: true, victim: { name: 'zyntharion', token: 'ZYN', kind: 'protocol' } })
    setVictims(null)
    expect(victimOf(headline)).toBeNull()
  })
})
