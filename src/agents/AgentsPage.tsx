import { useState } from 'react'
import { Atom, ArrowUp, ArrowDown, Minus } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { requestAiSignal, type AiSignal } from '../ai/aiClient'

function recommendationColor(rec: AiSignal['recommendation']): string {
  if (rec === 'buy') return 'var(--up)'
  if (rec === 'sell') return 'var(--down)'
  return 'var(--text-secondary)'
}

function RecommendationIcon({ rec }: { rec: AiSignal['recommendation'] }): React.JSX.Element {
  if (rec === 'buy') return <ArrowUp size={14} />
  if (rec === 'sell') return <ArrowDown size={14} />
  return <Minus size={14} />
}

export function AgentsPage(): React.JSX.Element {
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [running, setRunning] = useState(false)
  const [signal, setSignal] = useState<AiSignal | null>(null)

  async function handleRun(): Promise<void> {
    if (!symbol.trim() || running) return
    setRunning(true)
    try {
      const result = await requestAiSignal(symbol.trim().toUpperCase())
      setSignal(result)
    } finally {
      setRunning(false)
    }
  }

  return (
    <>
      <PageHeader title="Agents" subtitle="AI assistants that analyze the market on your behalf" />

      <Card title="Market Signal Agent">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.9rem' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 34,
              height: 34,
              borderRadius: '50%',
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              flexShrink: 0
            }}
          >
            <Atom size={16} />
          </div>
          <div>
            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Market Signal Agent</div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              Watches candle closes and returns a buy / sell / hold call with a confidence score.
            </div>
          </div>
        </div>

        <p style={{ margin: '0 0 1rem', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          This is the same paper-only GPT classifier that marks buy/sell arrows on the 15-minute Market chart.
          Configure its encrypted OpenAI key and model in Settings. Its output can never place a live order.
        </p>

        <div style={{ display: 'flex', gap: '0.6rem', marginBottom: '1rem' }}>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleRun()}
            placeholder="Symbol, e.g. BTCUSDT"
            style={{
              flex: 1,
              maxWidth: 220,
              background: 'var(--bg-app)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.5rem 0.7rem',
              color: 'var(--text-primary)',
              fontSize: '0.85rem'
            }}
          />
          <button
            onClick={handleRun}
            disabled={running || !symbol.trim()}
            style={{
              padding: '0.5rem 1rem',
              background: 'var(--accent)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              color: '#fff',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: running ? 'default' : 'pointer',
              opacity: running || !symbol.trim() ? 0.6 : 1
            }}
          >
            {running ? 'Running…' : 'Run Agent'}
          </button>
        </div>

        {signal && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.9rem',
              padding: '0.8rem 1rem',
              background: 'var(--bg-app)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)'
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                color: recommendationColor(signal.recommendation),
                fontWeight: 700,
                fontSize: '0.9rem',
                textTransform: 'uppercase'
              }}
            >
              <RecommendationIcon rec={signal.recommendation} />
              {signal.recommendation}
            </div>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
              {signal.symbol} • {(signal.confidence * 100).toFixed(0)}% confidence
            </div>
          </div>
        )}
      </Card>
    </>
  )
}
