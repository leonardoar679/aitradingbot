import { useState } from 'react'
import { Card } from '../components/Card'
import { QUANT_NAMES, type EventBenchmarkSummary } from '../../shared/aiEventBenchmark'
import { AI_HELP_MIN_TRADES, doesAiHelp, type AiHelpAnswer, type EventNews } from '../../shared/aiHelp'
import type { MarketEvent } from '../../shared/marketEvent'
import { cellStyle, headCellStyle, inputStyle, noteStyle } from './agentStyles'
import { inR, pct } from './EventTables'
import type { QuantBacktest } from './quantState'

const ANSWER_TONE: Record<AiHelpAnswer, string> = { yes: 'var(--up)', no: 'var(--down)', 'not enough': 'var(--text-muted)' }
const ANSWER_WORD: Record<AiHelpAnswer, string> = { yes: 'YES', no: 'NO', 'not enough': 'NOT ENOUGH TRADES' }
const ratio = (value: number | null): string => (value === null ? '—' : value.toFixed(2))
const percent = (value: number | null): string => (value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`)

/** "Does AI help?" (shared/aiHelp.ts): the quant baselines, holding the same hours, a model on its
 * own and the model where each strategy agrees, side by side over the same events; three verdicts
 * by fixed lines; and the strategies' own backtests over the same pairs and window. It reads what
 * is already scored; nothing here asks a model or trades. */
export function AiHelpCard({
  summary,
  events,
  news,
  backtests,
  failedPairs = 0
}: {
  summary: EventBenchmarkSummary
  events: Pick<MarketEvent, 'id' | 'live'>[]
  /** Each event's news, or null where the stories on file could not be read. */
  news: Record<string, EventNews | null> | null
  backtests: QuantBacktest[] | null
  /** Pairs whose strategy bars could not be read: their events have no quant state. */
  failedPairs?: number
}): React.JSX.Element {
  const models = summary.models.map((row) => row.name)
  const [picked, setPicked] = useState<string | null>(null)
  const model = picked !== null && models.includes(picked) ? picked : (models[0] ?? null)
  const help = model === null ? null : doesAiHelp({ summary, model, events, news })

  return (
    <Card title="Does AI help?">
      {models.length > 1 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.7rem' }}>
          Model
          <select value={model ?? ''} onChange={(change) => setPicked(change.target.value)} style={inputStyle()}>
            {models.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      )}
      {help === null ? (
        <p style={noteStyle}>No model has answered about these events yet.</p>
      ) : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Row', 'Closed', 'Won', 'Gains ÷ losses', 'A trade', 'R a trade', 'Deepest fall', 'Sharpe', 'Sortino'].map((column) => (
                    <th key={column} style={headCellStyle}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {help.rows.map(({ kind, label, row }) => (
                  <tr key={label}>
                    <td style={{ ...cellStyle, fontWeight: kind === 'ai' || kind === 'hybrid' ? 700 : 500, whiteSpace: 'normal' }}>{label}</td>
                    <td style={cellStyle}>{row.closed}</td>
                    <td style={cellStyle}>{row.winRatePct === null ? `${row.wins}` : `${row.winRatePct.toFixed(0)}%`}</td>
                    <td style={cellStyle}>{ratio(row.profitFactor)}</td>
                    <td style={cellStyle}>{pct(row.meanNetPct)}</td>
                    <td style={cellStyle}>{row.meanR === null ? '—' : inR(row.meanR)}</td>
                    <td style={cellStyle}>{row.closed === 0 ? '—' : `−${row.maxDrawdownPct.toFixed(2)}%`}</td>
                    <td style={cellStyle}>{ratio(row.sharpe)}</td>
                    <td style={cellStyle}>{ratio(row.sortino)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', marginTop: '0.9rem' }}>
            {help.verdicts.map((verdict) => (
              <p key={verdict.id} style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                <strong style={{ color: 'var(--text-primary)' }}>{verdict.question}</strong>{' '}
                <strong style={{ color: ANSWER_TONE[verdict.answer] }}>{ANSWER_WORD[verdict.answer]}</strong> — {verdict.text}
              </p>
            ))}
          </div>
        </>
      )}
      {backtests !== null && (
        <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['The strategy on its own', 'Pairs', 'Trades', 'Return, mean', 'Median', 'Deepest fall, mean', 'Holding the pairs'].map((column) => (
                  <th key={column} style={headCellStyle}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {backtests.map((test) => (
                <tr key={test.id}>
                  <td style={{ ...cellStyle, fontWeight: 600 }}>{QUANT_NAMES[test.id]}</td>
                  <td style={cellStyle}>{test.pairs}</td>
                  <td style={cellStyle}>{test.trades}</td>
                  <td style={cellStyle}>{percent(test.meanReturnPct)}</td>
                  <td style={cellStyle}>{percent(test.medianReturnPct)}</td>
                  <td style={cellStyle}>{percent(test.meanMaxDrawdownPct)}</td>
                  <td style={cellStyle}>{percent(test.holdMeanReturnPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        Over the same events. <strong>Quant</strong> follows the move with the fixed bracket where the strategy&apos;s state, read at the event from its own rule, is on the
        move&apos;s side: Trend Regime 4h holding (all four averages agree) or out (one or none), Short-Term Channel 15m at the top or the bottom of its channels.{' '}
        <strong>Hybrid</strong> is the model&apos;s own trades where the strategy is on its side. <strong>Buy and hold</strong> buys every event&apos;s pair at the same entry and
        holds it an hour. Sharpe and Sortino are a trade&apos;s, not a year&apos;s. A verdict says yes only when the difference is larger than the 95% margin around it, and
        waits for {AI_HELP_MIN_TRADES} closed trades a side; the news is the stories the feeds have given the app since it began reading them on 6 October 2026 (an
        event before them is left out), and the spread is the one the scanner saw on the book when it raised the event. The strategies on their own are the backtest engine&apos;s runs over the same pairs and window, warmed up first.
        {failedPairs > 0 && ` The strategies' bars could not be read for ${failedPairs} ${failedPairs === 1 ? 'pair' : 'pairs'}; their events have no state and are left out of the quant rows.`}
      </p>
    </Card>
  )
}
