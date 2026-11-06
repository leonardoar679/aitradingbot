// WHO A HACK'S VICTIM IS, BY NAME: THE RULES (V9 Stage 2, 6 November 2026; read again every week since Stage 8). The
// protocols and chains whose own token trades against USDT on Binance, from DefiLlama's public lists. This is the one
// place the rules live: research/fetch-incident-victims.ts compiles the committed table (shared/incidentVictims.json)
// by them, and the main process's incidentVictimsService.ts reads the lists again every week by them. The news reader
// (shared/incidents.ts) reads a hack's victim from its headline by these names, so that a story of a protocol's theft
// is about that protocol's token, not the coins the attacker took.
//
// Kept: a chain whose token trades on Binance; a protocol whose token does and whose TVL is $20 million or more
// (DefiLlama's small entries often carry another project's or a chain's symbol: "Strike" as Starknet's STRK, "Alpha"
// as BTC). A name is kept whole and, where it ends in a word that only says which part of a protocol it is ("Aave V3",
// "Curve DEX", "Jupiter Lend"), also without it; a short name, or one that is an everyday word ("Open", "Gas", "Sign"),
// is left out, since a headline uses it for other things. A name two tokens claim is left out. The exchanges are not
// here: shared/incidents.ts lists them by hand, with whether a hack of each moves the whole market. Arithmetic only:
// nothing here reads the network.

export const INCIDENT_VICTIMS_LINES = {
  version: 'incident-victims-v1',
  minTvlUsd: 20e6,
  /** The table is read again once it is this old. */
  refreshEverySeconds: 7 * 86_400,
  /** A table read again is used only with at least this many names, keeping at least this share of those in use: a
   * list that came back empty or changed its shape leaves the table as it was. */
  minNames: 150,
  minKeptShare: 0.6,
  sources: ['https://api.llama.fi/protocols', 'https://api.llama.fi/v2/chains', 'https://api.binance.com/api/v3/exchangeInfo']
} as const

/** A name, the token it is the victim's of, and whether it is a protocol or a chain. */
export type VictimRow = [string, string, string]

export interface IncidentVictimsFile {
  version: string
  /** The UTC day the lists were read, YYYY-MM-DD. */
  readAt: string
  sources: readonly string[]
  minTvlUsd: number
  victims: VictimRow[]
}

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
const BY_HAND: readonly VictimRow[] = [
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

/** Every name a row gives: itself, and without the words that only name a part, while what is left is a name. */
export function namesOf(name: string): string[] {
  const out: string[] = []
  let current = name.toLowerCase().replace(/\s+/g, ' ').trim()
  for (;;) {
    out.push(current)
    const shorter = current.replace(PART, '').trim()
    if (shorter === current || shorter === '') break
    current = shorter
  }
  return out.filter((entry) => entry.length >= 4 && !EVERYDAY.has(entry) && !LOOT_CHAINS.has(entry) && !/^\d/.test(entry))
}

const upper = (value: unknown): string => (typeof value === 'string' ? value.toUpperCase() : '')

/** The victims by name, from DefiLlama's protocols and chains and the tokens Binance trades against USDT: sorted by
 * name, the names by hand over what was read. */
export function victimsOf(protocols: readonly unknown[], chains: readonly unknown[], tradable: ReadonlySet<string>): VictimRow[] {
  const claims = new Map<string, Map<string, string>>()
  const claim = (name: string, token: string, kind: string): void => {
    const tokens = claims.get(name) ?? new Map<string, string>()
    tokens.set(token, kind)
    claims.set(name, tokens)
  }
  for (const raw of chains) {
    const chain = (raw ?? {}) as { name?: unknown; tokenSymbol?: unknown }
    const token = upper(chain.tokenSymbol)
    if (token === '' || !tradable.has(token) || typeof chain.name !== 'string') continue
    for (const name of namesOf(chain.name)) claim(name, token, 'chain')
  }
  for (const raw of protocols) {
    const protocol = (raw ?? {}) as { name?: unknown; symbol?: unknown; tvl?: unknown; category?: unknown }
    const token = upper(protocol.symbol)
    const tvl = typeof protocol.tvl === 'number' ? protocol.tvl : 0
    if (token === '' || token === '-' || !tradable.has(token) || !(tvl >= INCIDENT_VICTIMS_LINES.minTvlUsd) || protocol.category === 'CEX' || typeof protocol.name !== 'string') continue
    for (const name of namesOf(protocol.name)) claim(name, token, 'protocol')
  }
  const victims: VictimRow[] = []
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
  return victims.sort((a, b) => a[0].localeCompare(b[0]))
}

/** Whether a table read again may replace the one in use: enough names, and most of those in use kept. */
export function refreshUsable(next: readonly VictimRow[], inUse: readonly VictimRow[]): boolean {
  if (next.length < INCIDENT_VICTIMS_LINES.minNames) return false
  if (inUse.length === 0) return true
  const names = new Set(next.map((row) => row[0]))
  return inUse.filter((row) => names.has(row[0])).length / inUse.length >= INCIDENT_VICTIMS_LINES.minKeptShare
}

/** The table's file: one victim a line. */
export function victimsFileText(file: IncidentVictimsFile): string {
  return `${JSON.stringify(file, null, 0).replace(/\],\[/g, '],\n[').replace('"victims":[[', '"victims":[\n[').replace(/\]\]\}$/, ']\n]}')}\n`
}

/** A table's file read back: itself where it is of this version and every row a name, a token and a kind, else null. */
export function readVictimsFile(value: unknown): IncidentVictimsFile | null {
  const file = value as Partial<IncidentVictimsFile> | null
  if (file === null || typeof file !== 'object' || file.version !== INCIDENT_VICTIMS_LINES.version || typeof file.readAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(file.readAt) || !Array.isArray(file.victims)) return null
  const rows = file.victims.filter((row): row is VictimRow => Array.isArray(row) && row.length === 3 && row.every((cell) => typeof cell === 'string'))
  if (rows.length !== file.victims.length) return null
  return { version: file.version, readAt: file.readAt, sources: Array.isArray(file.sources) ? file.sources : [], minTvlUsd: typeof file.minTvlUsd === 'number' ? file.minTvlUsd : INCIDENT_VICTIMS_LINES.minTvlUsd, victims: rows }
}
