import { Card } from '../components/Card'
import { RESEARCH_CANDIDATES, type ResearchPair } from '../../shared/marketResearch'
import { useMarketResearch } from '../hooks/useMarketResearch'

const cell: React.CSSProperties = { padding: '0.35rem 0.5rem', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' }
const head: React.CSSProperties = { ...cell, fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textAlign: 'left' }

const pct = (value: number | null): React.JSX.Element =>
  value === null ? (
    <span style={{ color: 'var(--text-muted)' }}>—</span>
  ) : (
    <span style={{ color: value > 0 ? 'var(--up)' : value < 0 ? 'var(--down)' : undefined }}>{`${value > 0 ? '+' : ''}${value.toFixed(2)}%`}</span>
  )

const score = (value: number | null): string => (value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}`)

/** The funnel's choice (the V5 document, §14): of the liquid pairs the research reads every ten
 * minutes, the RESEARCH_CANDIDATES standing highest by the larger of their two scores, the day's
 * and the week's (shared/marketResearch.ts). A reading of where to look; the scanner raises events
 * on every watched pair whether it is here or not, and the watch asks on events. */
export function CandidatesCard(): React.JSX.Element {
  const { state } = useMarketResearch()
  const pairs: ResearchPair[] = state === null ? [] : state.candidates.map((symbol) => state.pairs.find((pair) => pair.symbol === symbol)).filter((pair): pair is ResearchPair => pair !== undefined)

  return (
    <Card title="Candidates">
      {state === null || (pairs.length === 0 && state.running) ? (
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>Researching the market…</p>
      ) : pairs.length === 0 ? (
        <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>The market could not be read yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }} data-testid="candidates-table">
            <thead>
              <tr>
                <th style={head}>#</th>
                <th style={head}>Pair</th>
                <th style={head}>24h</th>
                <th style={head}>7d</th>
                <th style={head}>Volume</th>
                <th style={head}>From the day's high</th>
                <th style={head}>Trend</th>
                <th style={head}>Day score</th>
                <th style={head}>Week score</th>
              </tr>
            </thead>
            <tbody>
              {pairs.map((pair, index) => (
                <tr key={pair.symbol}>
                  <td style={{ ...cell, color: 'var(--text-muted)' }}>{index + 1}</td>
                  <td style={{ ...cell, fontWeight: 700 }}>
                    {pair.symbol}
                    {pair.trending && <span style={{ marginLeft: '0.35rem', fontSize: '0.66rem', color: 'var(--gold)' }}>TRENDING</span>}
                  </td>
                  <td style={cell}>{pct(pair.change24hPct)}</td>
                  <td style={cell}>{pct(pair.change7dPct)}</td>
                  <td style={cell}>{pair.volumeExpansion === null ? '—' : `${pair.volumeExpansion.toFixed(1)}×`}</td>
                  <td style={cell}>{pct(pair.fromHigh24hPct)}</td>
                  <td style={cell}>{pair.trend7d === null ? '—' : pair.trend7d.toFixed(2)}</td>
                  <td style={{ ...cell, fontWeight: 700 }}>{score(pair.score24h)}</td>
                  <td style={{ ...cell, fontWeight: 700 }}>{score(pair.score7d)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ margin: '0.6rem 0 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        The {RESEARCH_CANDIDATES} liquid pairs standing highest by the larger of their two scores across the researched universe, read every ten minutes
        (Markets › Movers has every pair and its figures). A place to look, not a signal: events are raised on every watched pair, and nothing here asks a
        model or places anything.
      </p>
    </Card>
  )
}
