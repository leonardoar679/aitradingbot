import { PageHeader } from '../components/PageHeader'
import { AiKeyCard } from '../ai/AiKeyCard'
import { ExchangeCredentialsCard } from './ExchangeCredentialsCard'

/** Every key this app holds, in one place: the exchanges', and the AI models' provider. Each is
 * stored encrypted, tested before it is saved, and never read back into this window. */
export function ConnectionsPage(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Connections" subtitle="The keys this app holds: your exchanges, and the AI models' provider" />
      <ExchangeCredentialsCard />
      <AiKeyCard where="connections" />
      <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.55 }}>
        Market data needs no key: prices and candles come from each exchange&apos;s public data, and the scanner and every
        chart work without one.
      </p>
    </>
  )
}
