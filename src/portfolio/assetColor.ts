// Real holdings don't come with a designer-picked palette -- derive a stable color per asset so
// the same base asset always gets the same color across reloads and across the Top Holdings list
// and Evolution chart, without a lookup table that would need updating for every new symbol a
// user might ever hold.
const PALETTE = ['#d4a94a', '#3ecf6a', '#6d5ff5', '#ef4444', '#3b82f6', '#f97316', '#a855f7', '#06b6d4']

export function colorForAsset(baseAsset: string): string {
  let hash = 0
  for (let i = 0; i < baseAsset.length; i++) hash = (hash * 31 + baseAsset.charCodeAt(i)) >>> 0
  return PALETTE[hash % PALETTE.length]
}
