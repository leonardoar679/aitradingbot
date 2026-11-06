// V9-HACK-2'S EVENTS (V9 Stage 5, 6 November 2026; registered 6 November 2026 before anything was read). Every hack or
// exploit of $5 million or more that DefiLlama lists (api.llama.fi/hacks) from 1 January 2020 to 31 October 2026, each
// mapped to the victim's own token -- by DefiLlama's own id of the protocol where it has one and that protocol names a
// token (api.llama.fi/protocols), else by the victim's name in the app's tables (shared/incidents.ts's exchanges and
// shared/incidentVictims.json), else by hand below, for exchanges, bridges and chains -- and kept only where that token
// had a USDT perpetual on Binance (its onboard date, fapi exchangeInfo) or on Bitget (its launch time) listed before the
// hack's day. Written to research/v9-hack-events.json, committed with the study before its held-out half is read; the
// result names the file's sha256.
//
//   node research/v9HackEvents.mjs
//
// It reads four public lists and writes one file. A token delisted from both venues' perpetuals since is not on their
// lists and is left out, said so in the file's count of those left without a perpetual.

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const OUT = process.env.OUT ?? 'research/v9-hack-events.json'
const FROM = Date.UTC(2020, 0, 1) / 1000
const TO = Date.UTC(2026, 10, 1) / 1000
const MIN_USD = 5_000_000

/** By hand, by DefiLlama's name of the hack: the victim's own token, or none and why. Read before any price. */
const BY_HAND = {
  'BNB Bridge': { token: 'BNB', why: "Binance's BNB Chain bridge (BSC Token Hub), 6 October 2022" },
  'Binance Bridge': { token: 'BNB', why: "Binance's BNB Chain bridge (BSC Token Hub), 6 October 2022" },
  'Harmony Bridge': { token: 'ONE', why: "Harmony's own Horizon bridge" },
  'Horizon Bridge': { token: 'ONE', why: "Harmony's own Horizon bridge" },
  'HTX': { token: 'HT', why: "HTX's exchange token, HT, at the time" },
  'Heco Bridge': { token: 'HT', why: "HTX's HECO chain bridge; HT is the chain's token" },
  'HECO Bridge': { token: 'HT', why: "HTX's HECO chain bridge; HT is the chain's token" },
  'Ronin Bridge': { token: 'RON', why: "the Ronin chain's own token" },
  'Ronin': { token: 'RON', why: "the Ronin chain's own token" },
  'KuCoin': { token: 'KCS', why: "KuCoin's exchange token" },
  'BitMart': { token: 'BMX', why: "BitMart's exchange token" },
  'Bybit': { token: null, why: 'Bybit has no token of its own' },
  'Wormhole': { token: 'W', why: "Wormhole's token, W, listed in 2024: after the hack" },
  'Nomad Bridge': { token: null, why: 'Nomad had no token' },
  'Poly Network': { token: null, why: 'Poly Network had no token of its own' },
  'Multichain': { token: 'MULTI', why: "Multichain's token" }
}

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

const [hacks, protocols, binance, bitget] = await Promise.all([
  json('https://api.llama.fi/hacks'),
  json('https://api.llama.fi/protocols'),
  json('https://fapi.binance.com/fapi/v1/exchangeInfo'),
  json('https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES')
])
const byId = new Map(protocols.map((protocol) => [String(protocol.id), protocol]))
const binancePerps = new Map(binance.symbols.filter((symbol) => symbol.contractType === 'PERPETUAL' && symbol.quoteAsset === 'USDT').map((symbol) => [symbol.symbol, symbol.onboardDate]))
const bitgetPerps = new Map(bitget.data.filter((contract) => contract.symbolType === 'perpetual').map((contract) => [contract.symbol, Number(contract.launchTime) || 0]))

// The app's tables of victims' names: the exchanges by hand (shared/incidents.ts) and the compiled protocols and chains.
const incidents = readFileSync('shared/incidents.ts', 'utf-8')
const exchangeNames = new Map()
for (const match of incidents.matchAll(/\{ name: '([^']+)', names: \[([^\]]*)\], token: (null|'[A-Z0-9]+')/g)) {
  const token = match[3] === 'null' ? null : match[3].slice(1, -1)
  for (const name of match[2].split(',').map((entry) => entry.trim().replace(/^'|'$/g, '')).filter(Boolean)) exchangeNames.set(name, token)
}
const victims = new Map(JSON.parse(readFileSync('shared/incidentVictims.json', 'utf-8')).victims.map(([name, token]) => [name, token]))

function tokenOf(hack) {
  const hand = BY_HAND[hack.name]
  if (hand !== undefined) return { token: hand.token, rule: 'hand', why: hand.why }
  const protocol = hack.defillamaId ? byId.get(String(hack.defillamaId)) : undefined
  const symbol = protocol?.symbol && protocol.symbol !== '-' ? protocol.symbol.toUpperCase() : null
  if (symbol !== null) return { token: symbol, rule: 'id', why: `DefiLlama's protocol ${protocol.name}` }
  const name = String(hack.name).toLowerCase()
  if (exchangeNames.has(name)) return { token: exchangeNames.get(name), rule: 'name', why: 'the exchange table (shared/incidents.ts)' }
  if (victims.has(name)) return { token: victims.get(name), rule: 'name', why: 'the victims compiled from DefiLlama (shared/incidentVictims.json)' }
  return { token: null, rule: 'none', why: 'no token found for the victim' }
}

function perpOf(token, dayMs) {
  for (const symbol of [`${token}USDT`, `1000${token}USDT`]) {
    const listed = binancePerps.get(symbol)
    if (typeof listed === 'number' && listed < dayMs) return { venue: 'binance', symbol, listedAt: new Date(listed).toISOString().slice(0, 10), multiple: symbol.startsWith('1000') ? 1000 : 1 }
  }
  for (const symbol of [`${token}USDT`, `1000${token}USDT`]) {
    const listed = bitgetPerps.get(symbol)
    if (typeof listed === 'number' && listed > 0 && listed < dayMs) return { venue: 'bitget', symbol, listedAt: new Date(listed).toISOString().slice(0, 10), multiple: symbol.startsWith('1000') ? 1000 : 1 }
  }
  return null
}

const events = []
const left = { noToken: 0, noPerp: 0 }
const leftOut = []
for (const hack of hacks.filter((entry) => entry.amount >= MIN_USD && entry.date >= FROM && entry.date < TO).sort((a, b) => a.date - b.date || String(a.name).localeCompare(String(b.name)))) {
  const day = Math.floor(hack.date / 86_400) * 86_400
  const mapped = tokenOf(hack)
  const base = { date: new Date(day * 1000).toISOString().slice(0, 10), day, name: hack.name, amountUsd: hack.amount, targetType: hack.targetType ?? null, bridgeHack: hack.bridgeHack === true, chain: hack.chain ?? [] }
  if (mapped.token === null) {
    left.noToken++
    leftOut.push({ ...base, why: mapped.why })
    continue
  }
  const perp = perpOf(mapped.token, day * 1000)
  if (perp === null) {
    left.noPerp++
    leftOut.push({ ...base, token: mapped.token, why: `no USDT perpetual of ${mapped.token} on Binance or Bitget listed before the day (by ${mapped.rule}: ${mapped.why})` })
    continue
  }
  events.push({ ...base, token: mapped.token, rule: mapped.rule, ruleWhy: mapped.why, ...perp })
}

const file = {
  version: 'v9-hack-events-v1',
  readAt: new Date().toISOString(),
  sources: ['https://api.llama.fi/hacks', 'https://api.llama.fi/protocols', 'https://fapi.binance.com/fapi/v1/exchangeInfo', 'https://api.bitget.com/api/v2/mix/market/contracts?productType=USDT-FUTURES'],
  minUsd: MIN_USD,
  from: '2020-01-01',
  to: '2026-10-31',
  counts: { hacks: events.length + leftOut.length, kept: events.length, ...left },
  events,
  leftOut
}
const text = `${JSON.stringify(file, null, 1)}\n`
writeFileSync(OUT, text, 'utf-8')
console.log(`${events.length} events kept of ${file.counts.hacks} (no token ${left.noToken}, no perpetual before the day ${left.noPerp}); sha256 ${createHash('sha256').update(text).digest('hex')}`)
