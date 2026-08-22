import { Grid3x3, Layers3, Timer, Target, FileText, Shuffle, Scale, Waves, HelpCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface ExecutorTypeMeta {
  label: string
  icon: LucideIcon
  color: string
}

// A Map, not an object literal: an object literal inherits from Object.prototype, so a settings
// file holding type "toString" or "constructor" would find a truthy inherited value, skip the
// `??` fallback, and crash on `.icon` exactly as an unknown type did before. A Map has no such
// entries.
const TYPE_META = new Map<string, ExecutorTypeMeta>(Object.entries({
  grid: { label: 'Grid', icon: Grid3x3, color: '#3b82f6' },
  dca: { label: 'DCA', icon: Layers3, color: '#d4a94a' },
  twap: { label: 'TWAP', icon: Timer, color: '#3ecf6a' },
  position: { label: 'Position', icon: Target, color: '#f97316' },
  order: { label: 'Order', icon: FileText, color: '#94a3b8' },
  xemm: { label: 'XEMM', icon: Shuffle, color: '#a855f7' },
  arbitrage: { label: 'Arbitrage', icon: Scale, color: '#ec4899' },
  marketmaking: { label: 'Market Making', icon: Waves, color: '#06b6d4' }
}))

/** Indexing TYPE_META directly used to be enough, because ExecutorConfig['type'] is a closed union
 * -- but the settings file is data on disk, not a typed value: it survives downgrades, hand-edits
 * and partial writes, so a type string outside the union genuinely does reach here at runtime.
 * When it did, `meta.icon` threw and blanked the entire window. Falling back keeps the odd
 * executor visible (and stoppable) instead, and shows the raw type so it can be reported. */
export function executorTypeMeta(type: string): ExecutorTypeMeta {
  return TYPE_META.get(type) ?? { label: `Unknown (${type})`, icon: HelpCircle, color: 'var(--text-muted)' }
}
