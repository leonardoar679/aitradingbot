import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { PriceChart } from '../charts/PriceChart'
import { SettingsPanel } from '../settings/SettingsPanel'

export function Dashboard(): React.JSX.Element {
  const [status, setStatus] = useState('checking...')

  useEffect(() => {
    window.api?.ping().then(setStatus)
  }, [])

  return (
    <div style={{ display: 'grid', gap: '1rem', padding: '1rem' }}>
      <Card title="Backend status">{status}</Card>
      <PriceChart />
      <SettingsPanel />
    </div>
  )
}
