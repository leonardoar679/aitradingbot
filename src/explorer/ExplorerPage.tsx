import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { TextLink } from '../components/TextLink'
import type { Page } from '../navigation/pages'
import {
  EVENT_CANDIDATE_SCORE,
  EVENT_FOLLOW_MINUTES,
  EVENT_MAX_RANKED,
  EVENT_URGENT_SCORE,
  EVENT_WATCH_SCORE,
  describeEventType,
  type EventBand,
  type EventDirection,
  type MarketEvent,
  type MarketEventType
} from '../../shared/marketEvent'
import type { ScannerPair, ScannerState } from '../../shared/marketScanner'
import { cellStyle, headCellStyle, noteStyle, signedPct, buttonStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'
import { useNowSec } from '../utils/useNowSec'
import { loadEventMoves, type EventMoves } from './eventOutcomes'
import { NewsCard } from './NewsCard'

const PAIRS_SHOWN = 15
const EVENTS_SHOWN = 25
/** What followed an event is read from candles, and a horizon closes at most once a minute. */
const MOVES_REFRESH_SEC = 60

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 19)
}

/** `10-04 05:12`, in UTC, which is how every candle time in this app is said. */
function utcMinute(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(5, 16).replace('T', ' ')
}

function plainNumber(value: number): string {
  return Number(value.toPrecision(6)).toLocaleString('en-US', { maximumFractionDigits: 8 })
}

function directionColor(direction: EventDirection): string {
  if (direction === 'up') return 'var(--up)'
  if (direction === 'down') return 'var(--down)'
  return 'var(--text-secondary)'
}

function bandColor(band: EventBand): string {
  if (band === 'urgent') return 'var(--accent)'
  if (band === 'candidate') return 'var(--text-primary)'
  return 'var(--text-muted)'
}

function horizonLabel(minutes: number): string {
  return minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`
}

function StateBadge({ type, band, direction }: { type: MarketEventType | null; band: EventBand; direction: EventDirection }): React.JSX.Element {
  if (type === null) return <span style={{ color: 'var(--text-muted)' }}>quiet</span>
  return (
    <span style={{ color: directionColor(direction), fontWeight: band === 'watch' ? 500 : 700 }}>
      {describeEventType(type)}
      <span style={{ color: bandColor(band), fontWeight: 500 }}> · {band}</span>
    </span>
  )
}

function Pct({ value }: { value: number | null }): React.JSX.Element {
  const { text, color } = signedPct(value)
  return <span style={{ color }}>{text}</span>
}

function NowTable({ pairs }: { pairs: ScannerPair[] }): React.JSX.Element {
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? pairs : pairs.slice(0, PAIRS_SHOWN)
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headCellStyle}>Pair</th>
              <th style={headCellStyle}>Price</th>
              <th style={headCellStyle}>5m</th>
              <th style={headCellStyle}>15m</th>
              <th style={headCellStyle}>1h</th>
              <th style={headCellStyle}>4h</th>
              <th style={headCellStyle}>Volume</th>
              <th style={headCellStyle}>Score</th>
              <th style={headCellStyle}>State</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((pair) => (
              <tr key={pair.symbol}>
                <td style={{ ...cellStyle, fontWeight: 600 }}>{pair.symbol}</td>
                <td style={cellStyle}>{plainNumber(pair.price)}</td>
                <td style={cellStyle}>
                  <Pct value={pair.returnsPct.m5} />
                </td>
                <td style={cellStyle}>
                  <Pct value={pair.returnsPct.m15} />
                </td>
                <td style={cellStyle}>
                  <Pct value={pair.returnsPct.h1} />
                </td>
                <td style={cellStyle}>
                  <Pct value={pair.returnsPct.h4} />
                </td>
                <td style={cellStyle}>{pair.volumeRatio === null ? '—' : `${pair.volumeRatio.toFixed(1)}×`}</td>
                <td style={{ ...cellStyle, color: bandColor(pair.band), fontWeight: pair.band === 'quiet' ? 400 : 700 }}>{pair.score.toFixed(0)}</td>
                <td style={cellStyle}>
                  <StateBadge type={pair.type} band={pair.band} direction={pair.direction} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pairs.length > PAIRS_SHOWN && (
        <button onClick={() => setShowAll((all) => !all)} style={{ ...buttonStyle('secondary'), marginTop: '0.7rem' }}>
          {showAll ? `Show the strongest ${PAIRS_SHOWN}` : `Show all ${pairs.length}`}
        </button>
      )}
    </>
  )
}

function EventsTable({ events, moves }: { events: MarketEvent[]; moves: Map<string, EventMoves> }): React.JSX.Element {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={headCellStyle}>Time (UTC)</th>
            <th style={headCellStyle}>Pair</th>
            <th style={headCellStyle}>Event</th>
            <th style={headCellStyle}>Score</th>
            <th style={headCellStyle}>15m move</th>
            <th style={headCellStyle}>Volume</th>
            <th style={headCellStyle}>Spread</th>
            {EVENT_FOLLOW_MINUTES.map((minutes) => (
              <th key={minutes} style={headCellStyle}>
                After {horizonLabel(minutes)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {events.map((event) => {
            const after = moves.get(event.id)
            return (
              <tr key={event.id}>
                <td style={cellStyle}>{utcMinute(event.time)}</td>
                <td style={{ ...cellStyle, fontWeight: 600 }}>
                  {event.symbol}
                  {event.live !== null && event.live.rank > EVENT_MAX_RANKED && (
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400 }} title="More than three pairs raised an event in this minute; this one was not among the strongest three.">
                      {' '}
                      · #{event.live.rank}
                    </span>
                  )}
                </td>
                <td style={cellStyle}>
                  <StateBadge type={event.type} band={event.band} direction={event.direction} />
                </td>
                <td style={cellStyle}>{event.score.toFixed(0)}</td>
                <td style={cellStyle}>
                  <Pct value={event.returnsPct.m15} />
                </td>
                <td style={cellStyle}>{event.volumeRatio === null ? '—' : `${event.volumeRatio.toFixed(1)}×`}</td>
                <td style={cellStyle}>{event.live?.spreadPct === null || event.live?.spreadPct === undefined ? '—' : `${event.live.spreadPct.toFixed(3)}%`}</td>
                {EVENT_FOLLOW_MINUTES.map((minutes, index) => (
                  <td key={minutes} style={cellStyle}>
                    <Pct value={after?.[index] ?? null} />
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** The market scanner: what is moving now, and what it has raised.
 *
 * Everything on this page is public market data read by the main process, or worked out from it.
 * Opening it asks no model and costs nothing, and nothing here can place an order. */
export function ExplorerPage({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const [state, setState] = useState<ScannerState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [moves, setMoves] = useState<Map<string, EventMoves>>(new Map())
  const nowSec = useNowSec(state?.config.enabled === true, 1000)
  const movesAt = useRef(0)

  useEffect(() => {
    let cancelled = false
    void window.api.scanner
      .getState()
      .then((next) => {
        if (!cancelled) setState(next)
      })
      .catch((failure) => {
        if (!cancelled) setProblem(describeError(failure))
      })
    const stop = window.api.scanner.onUpdate((next) => {
      if (!cancelled) setState(next)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  const events = (state?.recentEvents ?? []).slice(0, EVENTS_SHOWN)
  const eventKey = events.map((event) => event.id).join('|')

  const refreshMoves = useCallback(async (shown: MarketEvent[]): Promise<void> => {
    if (shown.length === 0) return
    const now = Math.floor(Date.now() / 1000)
    movesAt.current = now
    const next = await loadEventMoves(shown, now, async (symbol, startSec, endSec) => {
      const result = await window.api.market.fetchHistoricalRange(shown[0].exchange, symbol, '1m', startSec, endSec)
      return result.candles
    })
    setMoves(next)
  }, [])

  // When the list changes, and then once a minute while anything on it is still pending.
  useEffect(() => {
    void refreshMoves(events)
    const timer = setInterval(() => {
      if (Math.floor(Date.now() / 1000) - movesAt.current >= MOVES_REFRESH_SEC) void refreshMoves(events)
    }, 15_000)
    return (): void => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ids shown, not the array's identity
  }, [eventKey, refreshMoves])

  const enabled = state?.config.enabled === true
  const pairs = state?.pairs ?? []

  return (
    <>
      <PageHeader title="Discovery" subtitle="What is moving right now, measured the same way for every pair" />

      <Card title="Scanner">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', fontSize: '0.85rem' }}>
          <span style={{ color: enabled ? 'var(--up)' : 'var(--text-secondary)', fontWeight: 700 }}>{enabled ? 'On' : 'Off'}</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            {state === null ? '' : `watching the ${state.config.universeSize} most traded USDT pairs on Binance.`} It is switched on and off, and its
            pairs chosen, under <TextLink onClick={() => onNavigate('settings')}>Settings › Market</TextLink>.
          </span>
        </div>

        {state !== null && enabled && (
          <p style={{ ...noteStyle, color: 'var(--text-secondary)', marginTop: '0.8rem' }}>
            {state.lastPassAt === null
              ? 'First pass not made yet.'
              : `Last pass ${utcClock(state.lastPassAt)} UTC, ${((state.lastPassMs ?? 0) / 1000).toFixed(1)}s, ${pairs.length} pairs read.`}
            {state.nextPassAt !== null && ` Next in ${Math.max(0, state.nextPassAt - nowSec)}s.`}
            {state.failed > 0 && state.error === null && ` ${state.failed} could not be read this time and show their last reading.`}
          </p>
        )}
        {(problem ?? state?.error) && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.6rem' }}>{problem ?? state?.error}</p>}
        <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
          Once a minute, a few seconds after the minute closes, every watched pair is read from its last twelve hours of
          1-minute candles. This is public market data only: no key is used, no model is asked and nothing is placed.
          It costs one request a pair a minute, and it stays on across restarts until it is switched off.
        </p>
      </Card>

      <Card title="Now">
        {pairs.length === 0 ? (
          <p style={noteStyle}>{enabled ? 'Waiting for the first pass.' : 'Switch the scanner on under Settings › Market to see what is moving.'}</p>
        ) : (
          <NowTable pairs={pairs} />
        )}
        <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
          The score is the plain mean of five readings, each 0 to 100: the last fifteen minutes&apos; move against that
          pair&apos;s own usual one; the last five minutes&apos; volume against the hours before the move began; how wide
          the bars are against the same; whether they closed at the end the move is heading for; and how far the price
          has cleared the high or low of the four hours before. {EVENT_WATCH_SCORE} is worth watching,{' '}
          {EVENT_CANDIDATE_SCORE} is a candidate and {EVENT_URGENT_SCORE} is urgent. Volume is the multiple of usual.
        </p>
      </Card>

      <Card title="Events">
        {events.length === 0 ? (
          <p style={noteStyle}>Nothing has reached the candidate band yet.</p>
        ) : (
          <EventsTable events={events} moves={moves} />
        )}
        <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
          A pair is listed when it reaches the candidate band, and again only if it climbs to urgent within half an
          hour: one move is one event. The last three columns are the plain price change from the event&apos;s price,
          read from candles each time this page is opened and never stored; a dash means that much time has not passed.
          After a fall, a negative number means it kept falling.
        </p>
        <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
          An event is something unusual, not a signal. Measured on twenty pairs, eight large ones over three years and
          eight smaller ones over one (research/EVENTS.md), rises like these did not carry on, falls came back a
          little, and neither paid for a round trip&apos;s fees on its own. A volume spike with no direction was
          followed by nothing at all, which is why one is shown in the table above and not listed here.
        </p>
      </Card>

      <NewsCard onNavigate={onNavigate} />
    </>
  )
}
