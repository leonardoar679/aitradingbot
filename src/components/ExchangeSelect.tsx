import { EXCHANGES, type Exchange } from '../../shared/ipc'

interface ExchangeSelectProps {
  exchange: Exchange
  onSelect: (exchange: Exchange) => void
}

export function ExchangeSelect({ exchange, onSelect }: ExchangeSelectProps): React.JSX.Element {
  return (
    <select
      value={exchange}
      onChange={(e) => onSelect(e.target.value as Exchange)}
      style={{
        background: 'var(--bg-app)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-sm)',
        padding: '0.4rem 0.6rem',
        fontSize: '0.8rem',
        fontWeight: 600,
        cursor: 'pointer'
      }}
    >
      {EXCHANGES.map((ex) => (
        <option key={ex.id} value={ex.id}>
          {ex.name}
        </option>
      ))}
    </select>
  )
}
