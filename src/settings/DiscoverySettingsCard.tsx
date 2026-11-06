import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { Toggle } from '../components/Toggle'
import { noteStyle } from '../agents/agentStyles'
import { DISCOVERY_LINES, type DiscoveryState } from '../../shared/traders/discovery'

/** Finding traders (V9 Stage 3; shared/traders/discovery.ts): its one switch, on unless switched off. The same switch is
 * on Copy Traders' "Found for you", beside what it found. The main process holds the setting. */
export function DiscoverySettingsCard(): React.JSX.Element {
  const [state, setState] = useState<DiscoveryState | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    window.api.traders.discovery().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      () => undefined
    )
    const stop = window.api.traders.onDiscovery((next) => {
      if (!cancelled) setState(next)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])
  const toggle = (on: boolean): void => {
    if (busy) return
    setBusy(true)
    void window.api.traders
      .setDiscovery(on)
      .then(setState, () => undefined)
      .finally(() => setBusy(false))
  }
  return (
    <Card title="Finding traders">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
        <Toggle on={state?.enabled !== false} onChange={toggle} />
        <span style={{ fontSize: '0.84rem' }}>Read OKX&apos;s and Hyperliquid&apos;s public rankings once a day and analyse the traders the rule picks</span>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        Up to {DISCOVERY_LINES.newPerDay} new traders a day, each read and analysed half an hour apart, behind every paper follow&apos;s reads. It reads public data only and places, follows and copies nothing. What it found is on Copy Traders.
      </p>
    </Card>
  )
}
