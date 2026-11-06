// WHO A HACK'S VICTIM IS, BY NAME (V9 Stage 2, 6 November 2026): the protocols and chains whose own token trades
// against USDT on Binance, compiled from DefiLlama's public lists into shared/incidentVictims.json -- versioned data,
// no key -- by the rules of shared/incidentVictimsBuild.ts, the same the app reads the lists again by every week
// (electron/services/incidentVictimsService.ts). A re-run replaces the file. It reads three public lists and writes one
// file; nothing else.
//
//   npx esbuild research/fetch-incident-victims.ts --bundle --platform=node --format=esm --outfile=research/.fetch-incident-victims.mjs
//   node research/.fetch-incident-victims.mjs           reads the three lists live and writes the file
//
// Read: https://api.llama.fi/protocols (every protocol with its token's symbol and its TVL),
// https://api.llama.fi/v2/chains (every chain with its token) and Binance's spot pairs
// (https://api.binance.com/api/v3/exchangeInfo).

import { writeFileSync } from 'node:fs'
import { INCIDENT_VICTIMS_LINES, victimsFileText, victimsOf } from '../shared/incidentVictimsBuild'

const OUT = process.env.OUT ?? 'shared/incidentVictims.json'

async function json(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.json()
}

const [protocols, chains, exchange] = (await Promise.all([
  json('https://api.llama.fi/protocols'),
  json('https://api.llama.fi/v2/chains'),
  json('https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT')
])) as [unknown[], unknown[], { symbols: { baseAsset: string; quoteAsset: string; status: string }[] }]
const tradable = new Set(exchange.symbols.filter((pair) => pair.quoteAsset === 'USDT' && pair.status === 'TRADING').map((pair) => pair.baseAsset.toUpperCase()))
const victims = victimsOf(protocols, chains, tradable)
writeFileSync(
  OUT,
  victimsFileText({ version: INCIDENT_VICTIMS_LINES.version, readAt: new Date().toISOString().slice(0, 10), sources: INCIDENT_VICTIMS_LINES.sources, minTvlUsd: INCIDENT_VICTIMS_LINES.minTvlUsd, victims }),
  'utf-8'
)
console.log(`${victims.length} names, ${new Set(victims.map((row) => row[1])).size} tokens, written to ${OUT}`)
