import { EXCHANGES, canTradeOn, type Exchange } from '../../shared/ipc'
import { useI18n } from '../i18n'

interface ExchangeSelectProps {
  exchange: Exchange
  onSelect: (exchange: Exchange) => void
  /** Where an executor is made (V7.1 Stage 14): an exchange this app cannot trade on is said to be data only. */
  tradeNotes?: boolean
}

export function ExchangeSelect({ exchange, onSelect, tradeNotes = false }: ExchangeSelectProps): React.JSX.Element {
  const { t } = useI18n()
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
          {tradeNotes && !canTradeOn(ex.id) ? t('{name} (data only)', { name: ex.name }) : ex.name}
        </option>
      ))}
    </select>
  )
}
