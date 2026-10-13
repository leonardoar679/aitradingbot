import { useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { cellStyle, headCellStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { useLiveMarket } from '../hooks/useLiveMarket'
import { useNowSec } from '../utils/useNowSec'
import { HORIZONS, PAIR_CLASSES, type Horizon, type PairClass } from '../../shared/forecast/features'
import type { Direction } from '../../shared/forecast/direction'
import { forecastView } from '../../shared/forecast/view'
import { LIVE_MAX_INTEREST } from '../../shared/liveMarket'
import { PredictionDrawer } from './PredictionDrawer'
import type { AiOrderProposal } from '../../shared/aiProposal'
import { ForecastTraderCard } from './ForecastTraderCard'
import { NO_FILTERS, predictionRows, type PredictionFilters } from './predictionRows'
import { takeWantedPrediction, useForecast } from './useForecast'
import { callColor, callLabel, decisionWords, forecastStatusText, pairText, rangeText, signedPct, timeLeftText, HORIZON_SHORT } from './forecastWords'

const CLASS_NAMES: Record<PairClass, string> = { btc: 'Bitcoin', eth: 'Ether', large: 'Large', mid: 'Mid', 'high-vol': 'High volatility', other: 'Other' }

/** Every pair's forecast, ranked (the V6 document, §32-37 and §69-70): the table best first, with the
 * page's filters, and a row's whole forecast in the drawer. Live percentages where the stream holds
 * the pair; the close's elsewhere. Reading it asks no model and places nothing. */
export function PredictionsPage({ onPrepareOrder }: { onPrepareOrder?: (proposal: AiOrderProposal) => void }): React.JSX.Element {
  const { state, predictions, ranking } = useForecast()
  const [filters, setFilters] = useState<PredictionFilters>(NO_FILTERS)
  const [open, setOpen] = useState<string | null>(() => takeWantedPrediction())
  const nowSec = useNowSec(true, 5_000)
  const rows = useMemo(() => predictionRows(ranking, predictions, filters), [ranking, predictions, filters])
  // The stream carries a dozen pairs: the open one and the table's first.
  const streamed = useMemo(() => [...new Set([...(open === null ? [] : [open]), ...rows.map((row) => row.ranked.pair)])].slice(0, LIVE_MAX_INTEREST), [open, rows])
  const live = useLiveMarket(streamed)
  const set = <K extends keyof PredictionFilters>(key: K, value: PredictionFilters[K]): void => setFilters((current) => ({ ...current, [key]: value }))
  const openPrediction = open === null ? undefined : predictions.get(open)
  const openDecision = open === null ? null : (ranking?.ranked.find((entry) => entry.pair === open)?.decision ?? null)

  return (
    <>
      <PageHeader title="Predictions" subtitle="Every pair's forecast, ranked by its edge after costs, its reliability, the news, liquidity and execution" />
      <p style={{ ...noteStyle, margin: '0 0 0.9rem' }}>{forecastStatusText(state)}</p>
      <Card title="Ranked forecasts">
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '0.7rem' }}>
          <input value={filters.query} onChange={(change) => set('query', change.target.value)} placeholder="Pair" aria-label="Pair" style={{ ...inputStyle(), width: '7rem' }} />
          <select value={filters.horizon} onChange={(change) => set('horizon', change.target.value as Horizon | 'ranked')} style={inputStyle()} aria-label="Horizon">
            <option value="ranked">Its ranked horizon</option>
            {HORIZONS.map((horizon) => (
              <option key={horizon} value={horizon}>
                {HORIZON_SHORT[horizon]}
              </option>
            ))}
          </select>
          <select value={filters.call} onChange={(change) => set('call', change.target.value as Direction | 'all')} style={inputStyle()} aria-label="Call">
            <option value="all">Every call</option>
            <option value="BULLISH">Bullish</option>
            <option value="BEARISH">Bearish</option>
            <option value="NEUTRAL">Neutral</option>
          </select>
          <select value={filters.pairClass} onChange={(change) => set('pairClass', change.target.value as PairClass | 'all')} style={inputStyle()} aria-label="Kind of coin">
            <option value="all">Every kind of coin</option>
            {PAIR_CLASSES.map((pairClass) => (
              <option key={pairClass} value={pairClass}>
                {CLASS_NAMES[pairClass]}
              </option>
            ))}
          </select>
          <label style={{ ...noteStyle, display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}>
            <input type="checkbox" checked={filters.tradeOnly} onChange={(change) => set('tradeOnly', change.target.checked)} />
            Tradable only
          </label>
          <label style={{ ...noteStyle, display: 'inline-flex', gap: '0.3rem', alignItems: 'center' }}>
            <input type="checkbox" checked={filters.newsOnly} onChange={(change) => set('newsOnly', change.target.checked)} />
            With news
          </label>
          <span style={{ ...noteStyle, marginLeft: 'auto' }}>
            {rows.length} of {ranking?.ranked.length ?? 0} pairs
          </span>
        </div>
        {rows.length === 0 ? (
          <p style={noteStyle}>{ranking === null || ranking.ranked.length === 0 ? 'No forecast yet.' : 'No pair passes these filters.'}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['#', 'Pair', 'At', 'Call', 'Likely', 'Bear · bull', 'P(up)', 'Quality', 'Reliability', 'Edge after costs', 'Decision', 'Valid'].map((name) => (
                    <th key={name} style={headCellStyle}>
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const book = live?.books[row.ranked.pair]
                  const livePrice = book !== undefined && book.bid > 0 && book.ask > 0 ? (book.bid + book.ask) / 2 : null
                  const view = forecastView(row.prediction, livePrice, nowSec * 1000).horizons[row.horizon]
                  const range = row.prediction.horizons[row.horizon]
                  if (view === undefined || range === undefined) return null
                  const decision = decisionWords(row.ranked.decision)
                  const edge = row.horizon === row.ranked.horizon ? row.ranked.decision.edge : null
                  return (
                    <tr key={row.ranked.pair} onClick={() => setOpen(row.ranked.pair)} style={{ cursor: 'pointer', background: open === row.ranked.pair ? 'var(--bg-app)' : undefined }}>
                      <td style={cellStyle}>{row.rank}</td>
                      <td style={{ ...cellStyle, fontWeight: 600 }}>{pairText(row.ranked.pair)}</td>
                      <td style={cellStyle}>{HORIZON_SHORT[row.horizon]}</td>
                      <td style={{ ...cellStyle, color: callColor(range.direction), fontWeight: 600 }}>{callLabel(range)}</td>
                      <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{rangeText(view.lowPct, view.highPct)}</td>
                      <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>
                        {signedPct(view.bearPct)} · {signedPct(view.bullPct)}
                      </td>
                      <td style={cellStyle}>{Math.round(range.pUp * 100)}%</td>
                      <td style={cellStyle}>{range.quality.score}</td>
                      <td style={cellStyle}>{range.reliability}</td>
                      <td style={cellStyle}>{edge === null ? '—' : `${signedPct(edge.edgePct)} (${edge.side}, ${Math.round(edge.pProfit * 100)}% to clear)`}</td>
                      <td style={{ ...cellStyle, whiteSpace: 'normal', minWidth: '12rem', color: decision.trade ? 'var(--up)' : 'var(--text-secondary)' }} title={decision.detail}>
                        {decision.trade ? decision.label : `NO TRADE · ${row.ranked.decision.reasons[0]?.text ?? ''}`}
                      </td>
                      <td style={cellStyle}>{view.invalidated ? 'INVALIDATED' : timeLeftText(view.timeLeftMs)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
          Ranked once a pass, at each pair's ranked horizon: the edge after a round trip's 0.24% and half the spread, weighed by reliability, the news, liquidity and execution, less the range's uncertainty, the market's risk and the cost. A row opens its whole forecast. A forecast is not a trade; nothing was placed.
        </p>
      </Card>
      <ForecastTraderCard />
      {openPrediction !== undefined && <PredictionDrawer prediction={openPrediction} decision={openDecision} live={live} onClose={() => setOpen(null)} onPrepareOrder={onPrepareOrder} />}
    </>
  )
}
