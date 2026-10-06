import { Card } from '../components/Card'
import { describeOpportunitySide } from '../../shared/aiOpportunity'
import { describeDecider } from '../../shared/aiPanel'
import type { LiveState } from '../../shared/liveMarket'
import { describeEventType } from '../../shared/marketEvent'
import { cellStyle, headCellStyle, noteStyle } from './agentStyles'
import { liveReadingOf } from './liveVerdict'
import { LiveVerdictView } from './LiveVerdictView'
import { WhyButton } from '../news/WhyItMovedHost'
import type { RightNowRow } from './opportunities'

function plainNumber(value: number): string {
  return Number(value.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 8 })
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** What can still be acted on right now (./opportunities.ts, rightNowRows): one line for each
 * event with a call this app would act on whose entry has not run out or filled, the strongest
 * candidate first. A line leaves when its entry does. Each is checked against the live price
 * (./liveVerdict.ts): enterable now, waiting for its range, or no longer standing. It shows; it
 * asks nothing and opens nothing. */
export function RightNowCard({
  rows,
  nowSec,
  live = null,
  btcLimitPct,
  stakeQuote
}: {
  rows: RightNowRow[]
  nowSec: number
  /** The live prices of these pairs (src/hooks/useLiveMarket.ts); null before they are read. */
  live?: LiveState | null
  /** The watch's Bitcoin safeguard and stake, where known: what the live check holds a row to. */
  btcLimitPct?: number
  stakeQuote?: number
}): React.JSX.Element {
  const nowMs = Date.now()
  return (
    <Card title="Right now">
      {rows.length === 0 ? (
        <>
          {/* Saying so is the point, not a gap in the page: a system that always has a trade to
              offer is not a better one. */}
          <p style={{ margin: '0 0 0.4rem', fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)' }}>No high-quality opportunity right now. Wait.</p>
          <p style={noteStyle}>
            No recommendation can be acted on at the moment. A call to trade is listed here from the minute it arrives until its entry is filled or runs out, which is at most an
            hour and usually fifteen minutes.
          </p>
        </>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>#</th>
                <th style={headCellStyle}>Pair</th>
                <th style={headCellStyle}>Event</th>
                <th style={headCellStyle}>Score</th>
                <th style={headCellStyle}>Each model&apos;s call</th>
                <th style={headCellStyle}>Entry on offer</th>
                <th style={headCellStyle}>Until (UTC)</th>
                <th style={headCellStyle}>Time left</th>
                <th style={headCellStyle}>Now (live)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const { event } = row.item
                const left = Math.max(0, row.expiresAt - nowSec)
                return (
                  <tr key={event.id}>
                    <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>{index + 1}</td>
                    <td style={{ ...cellStyle, fontWeight: 700, whiteSpace: 'nowrap' }}>
                      {event.symbol} <WhyButton symbol={event.symbol} compact />
                    </td>
                    <td style={{ ...cellStyle, color: event.direction === 'up' ? 'var(--up)' : 'var(--down)' }}>
                      {describeEventType(event.type)} <span style={{ color: 'var(--text-muted)' }}>{utcClock(event.time)}</span>
                    </td>
                    <td style={cellStyle}>
                      {event.score.toFixed(0)} <span style={{ color: 'var(--text-muted)' }}>{event.band}</span>
                    </td>
                    <td style={{ ...cellStyle, whiteSpace: 'normal' }}>
                      {row.calls.map((call, position) => (
                        <span key={call.model}>
                          {position > 0 && <span style={{ color: 'var(--text-muted)' }}> · </span>}
                          <span style={{ color: 'var(--text-secondary)' }}>{describeDecider(call.model)} </span>
                          <span style={{ fontWeight: 700, color: call.refused ? 'var(--down)' : call.side === 'long' ? 'var(--up)' : call.side === 'short' ? 'var(--down)' : 'var(--text-secondary)' }}>
                            {call.refused ? 'REFUSED' : describeOpportunitySide(call.side)}
                          </span>
                          {!call.refused && <span style={{ color: call.acted ? 'var(--text-primary)' : 'var(--text-muted)' }}> {Math.round(call.confidence * 100)}%</span>}
                        </span>
                      ))}
                    </td>
                    <td style={cellStyle}>
                      <span style={{ fontWeight: 700, color: row.side === 'long' ? 'var(--up)' : 'var(--down)' }}>{describeOpportunitySide(row.side)}</span> {plainNumber(row.entryMin)} –{' '}
                      {plainNumber(row.entryMax)}
                    </td>
                    <td style={cellStyle}>{utcClock(row.expiresAt)}</td>
                    <td style={{ ...cellStyle, fontWeight: 600, color: left <= 120 ? 'var(--gold)' : 'var(--text-primary)' }}>{left < 60 ? `${left}s` : `${Math.ceil(left / 60)} min`}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'normal', minWidth: 190 }}>
                      <LiveVerdictView reading={liveReadingOf(row, live, { btcLimitPct, stakeQuote, nowMs })} compact />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {rows.length > 0 && (
        <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
          Strongest candidate first. The entry shown is that of the surest call at 65% confidence or more; a call under that is listed and not acted on. Each event&apos;s card is
          below, with the stop, the target and the Paper trade button. &quot;Now&quot; is the live price: enterable when what a fill would pay is inside the range, the
          spread within 0.1% and the price under ten seconds old; waiting while it is outside the range; invalidated once the entry has expired, Bitcoin has moved against
          it by the watch&apos;s safeguard, the spread is wider or no fresh price is had.
        </p>
      )}
    </Card>
  )
}
