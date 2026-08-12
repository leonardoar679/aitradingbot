import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'

export function ExplorerPage(): React.JSX.Element {
  return (
    <>
      <PageHeader title="Explorer" />
      <Card title="Explorer">
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>Coming soon.</p>
      </Card>
    </>
  )
}
