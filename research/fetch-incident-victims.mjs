// WHO A HACK'S VICTIM IS, BY NAME (V9 Stage 2, 6 November 2026): the protocols and chains whose own token trades
// against USDT on Binance, compiled from DefiLlama's public lists into shared/incidentVictims.json -- versioned data,
// no key. The news reader (shared/incidents.ts) reads a hack's victim from its headline by these names, so that a
// story of a protocol's theft is about that protocol's token, not the coins the attacker took.
//
//   node research/fetch-incident-victims.mjs           reads the three lists live and writes the file
//
// Read: https://api.llama.fi/protocols (every protocol with its token's symbol and its TVL),
// https://api.llama.fi/v2/chains (every chain with its token) and Binance's spot pairs
// (https://api.binance.com/api/v3/exchangeInfo). Kept: a chain whose token trades on Binance; a protocol whose token
// does and whose TVL is $20 million or more (DefiLlama's small entries often carry another project's or a chain's
// symbol: "Strike" as Starknet's STRK, "Alpha" as BTC). A name is kept whole and, where it ends in a word that only
// says which part of a protocol it is ("Aave V3", "Curve DEX", "Jupiter Lend"), also without it; a short name, or
// one that is an everyday word ("Open", "Gas", "Sign"), is left out, since a headline uses it for other things. A
// name two tokens claim is left out. The exchanges are not here: shared/incidents.ts lists them by hand, with
// whether a hack of each moves the whole market. A re-run replaces the file. It reads three public lists and writes
// one file; nothing else.

import { writeFileSync } from 'fs'

const OUT = process.env.OUT ?? 'shared/incidentVictims.json'
const MIN_TVL = 20e6

/** Words that end a name and only say which part of a protocol it is. */
const PART = /\s+(v\d+(\.\d+)?|cex|dex|amm|clmm|dlmm|damm( v\d)?|lend|lending|perps?|perpetual exchange|staking|liquid staking|restaking|bridge|swap|aggregator|agg|earn|vaults?|spot orderbook|spot|options|savings|liquidity layer|liquidity|core pool|isolated pools|protocol|network|finance|money|rwa|cdp|l1|mainnet|stake|liquid)$/i
/** Everyday words a headline uses for other things, and names a coin's own name covers better. */
const EVERYDAY = new Set([
  'open', 'gas', 'sign', 'gain', 're', 'alpha', 'terminal', 'telemetry', 'strike', 'home', 'form', 'story', 'kernel', 'portal', 'momentum',
  'katana', 'shell', 'magic', 'treasure', 'ampere', 'base', 'blast', 'mode', 'scroll', 'spark', 'sky', 'maker', 'compound', 'curve', 'venus',
  'drift', 'harmony', 'gravity', 'flux', 'nil', 'erasure', 'endurance', 'acumen', 'reserve', 'falcon', 'convex', 'origin', 'mover', 'usual',
  'enso', 'cyber', 'saga', 'prom', 'rose', 'flow', 'near', 'sonic', 'plasma', 'movement', 'wax', 'dash', 'theta', 'oasis', 'lisk', 'gnosis dao',
  'one dex', 'alien worlds', 'big time', 'tree news', 'turtle club', 'world is flat', 'ace of base', 'bankless', 'bank ai', 'memecoin',
  'hyphen', 'luna.fun', 'fwog.fun', 'pumpkin dao', 'milky cow', 'axl inu', 'shibex', 'zena finance', 'zenland', 'enjoyoors', 'solana farm',
  'blackrockfund', 'coinwind', 'apricot finance', 'sapien vault', 'lets get hai', 'tealswap', 'zeno exchange', 'alt fun', 'aptoslaunch',
  'basevol', 'genius.fun', 'memedex', 'gas404swap', 'gasswap', 'sohei', 'tutellus', 'peerme', 'superfarm', 'nullmask', 'chronos', 'skydrome',
  'xusd money', 'xbacked', 'synlev', 'syncyield', 'acet', 'eteria', 'caldera', 'mitosis', 'jupiterz', 'homecoin', 'bbbfi', 'openworld',
  'ethereal', 'sudo', 'opinion', 'vaulta', 'gain network', 'usd ai'
])
/** The largest chains: in a hack's headline their name is the chain a theft ran on or the coin taken ("$786K Solana
 * bot drain", "stolen Solana"), almost never the victim. Their bridges, named in full, are kept. */
const LOOT_CHAINS = new Set(['bitcoin', 'ethereum', 'solana', 'binance', 'bsc', 'binance smart chain', 'tron', 'doge', 'dogecoin', 'xrpl', 'cardano', 'litecoin', 'bitcoincash', 'stellar', 'avalanche'])
/** Names DefiLlama does not give a protocol whose hack was news (its listed name is another, or its token is
 * listed under a child entry left out above), and a few it gives the wrong token. */
const BY_HAND = [
  ['wormhole', 'W', 'protocol'],
  ['portal bridge', 'W', 'protocol'],
  ['stargate', 'STG', 'protocol'],
  ['balancer', 'BAL', 'protocol'],
  ['radiant', 'RDNT', 'protocol'],
  ['kyberswap', 'KNC', 'protocol'],
  ['ronin', 'RON', 'chain'],
  ['thorchain', 'RUNE', 'chain'],
  ['hyperliquid', 'HYPE', 'chain'],
  ['lido', 'LDO', 'protocol'],
  ['eigenlayer', 'EIGEN', 'protocol'],
  ['layerzero', 'ZRO', 'protocol'],
  ['pancakeswap', 'CAKE', 'protocol'],
  ['sushiswap', 'SUSHI', 'protocol'],
  ['uniswap', 'UNI', 'protocol'],
  ['curve finance', 'CRV', 'protocol'],
  ['compound finance', 'COMP', 'protocol'],
  ['venus protocol', 'XVS', 'protocol'],
  ['ether.fi', 'ETHFI', 'protocol'],
  ['etherfi', 'ETHFI', 'protocol'],
  ['cetus', 'CETUS', 'protocol'],
  ['abracadabra', 'SPELL', 'protocol'],
  ['pump.fun', 'PUMP', 'protocol'],
  ['magic eden', 'ME', 'protocol'],
  ['trust wallet', 'TWT', 'protocol'],
  ['world liberty financial', 'WLFI', 'protocol'],
  ['virtuals', 'VIRTUAL', 'protocol']
]

async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

const [protocols, chains, exchange] = await Promise.all([json('https://api.llama.fi/protocols'), json('https://api.llama.fi/v2/chains'), json('https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT')])
const tradable = new Set(exchange.symbols.filter((pair) => pair.quoteAsset === 'USDT' && pair.status === 'TRADING').map((pair) => pair.baseAsset.toUpperCase()))

/** Every name a row gives: itself, and without the words that only name a part, while what is left is a name. */
function namesOf(name) {
  const out = []
  let current = name.toLowerCase().replace(/\s+/g, ' ').trim()
  for (;;) {
    out.push(current)
    const shorter = current.replace(PART, '').trim()
    if (shorter === current || shorter === '') break
    current = shorter
  }
  return out.filter((entry) => entry.length >= 4 && !EVERYDAY.has(entry) && !LOOT_CHAINS.has(entry) && !/^\d/.test(entry))
}

const claims = new Map()
const claim = (name, token, kind) => {
  if (!claims.has(name)) claims.set(name, new Map())
  claims.get(name).set(token, kind)
}
for (const chain of chains) {
  const token = String(chain.tokenSymbol ?? '').toUpperCase()
  if (token === '' || !tradable.has(token)) continue
  for (const name of namesOf(chain.name)) claim(name, token, 'chain')
}
for (const protocol of protocols) {
  const token = String(protocol.symbol ?? '').toUpperCase()
  if (token === '' || token === '-' || !tradable.has(token) || !((protocol.tvl ?? 0) >= MIN_TVL) || protocol.category === 'CEX') continue
  for (const name of namesOf(protocol.name)) claim(name, token, 'protocol')
}
const victims = []
for (const [name, tokens] of claims) {
  if (tokens.size !== 1) continue
  const [[token, kind]] = [...tokens]
  victims.push([name, token, kind])
}
// By hand, over what was read: a name it names is its, whatever DefiLlama gave.
for (const [name, token, kind] of BY_HAND) {
  const at = victims.findIndex((row) => row[0] === name)
  if (!tradable.has(token)) {
    if (at >= 0) victims.splice(at, 1)
    continue
  }
  if (at >= 0) victims[at] = [name, token, kind]
  else victims.push([name, token, kind])
}
victims.sort((a, b) => a[0].localeCompare(b[0]))
const out = {
  version: 'incident-victims-v1',
  readAt: new Date().toISOString().slice(0, 10),
  sources: ['https://api.llama.fi/protocols', 'https://api.llama.fi/v2/chains', 'https://api.binance.com/api/v3/exchangeInfo'],
  minTvlUsd: MIN_TVL,
  victims
}
writeFileSync(OUT, `${JSON.stringify(out, null, 0).replace(/\],\[/g, '],\n[').replace('"victims":[[', '"victims":[\n[').replace(/\]\]\}$/, ']\n]}')}\n`, 'utf-8')
console.log(`${victims.length} names, ${new Set(victims.map((row) => row[1])).size} tokens, written to ${OUT}`)
