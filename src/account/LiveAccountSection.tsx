import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import type { CredentialStatus } from '../../shared/ipc'
import { LiveBalancesCard } from './LiveBalancesCard'
import { FuturesPositionsCard } from './FuturesPositionsCard'

/** What you really hold on each exchange a key is stored for, and the real futures positions on
 * Binance. The live half of what was the Account page; the paper account is on Paper Trading. */
export function LiveAccountSection(): React.JSX.Element {
  const [connected, setConnected] = useState<CredentialStatus[] | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    window.api.credentials
      .list()
      .then((list) => setConnected(list.filter((c) => c.configured)))
      .catch((e: unknown) => {
        console.error('Failed to list connected exchanges:', e)
        setProblem('The stored exchange keys could not be read, so no real balance can be shown.')
      })
  }, [])

  if (problem !== null) return <Card title="Real balances">{problem}</Card>
  if (connected === null) return <Card title="Real balances">Loading…</Card>
  if (connected.length === 0) {
    return (
      <Card title="Real balances">
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
          No exchange key is stored, so there is no real balance to show. Add one on Connections: Binance can be read and
          traded from this app, Upbit only read.
        </p>
      </Card>
    )
  }

  return (
    <>
      {connected.map((credential) => (
        <LiveBalancesCard key={`${credential.exchange}:${credential.slot ?? 'real'}`} exchange={credential.exchange} slot={credential.slot ?? 'real'} />
      ))}
      {connected.some((c) => c.exchange === 'binance' && (c.slot ?? 'real') === 'real') && <FuturesPositionsCard />}
    </>
  )
}
