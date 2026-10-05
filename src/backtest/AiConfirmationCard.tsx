import type { BacktestStats, Trade } from './engine'
import type { ConfirmationCounts, EntryReview } from './aiConfirmation'
import { tookNoTrades } from './strategyRanking'
import { formatHoldingDuration, formatUtcDate, formatUtcTime } from './formatTradeTime'
import { formatUsd } from '../../shared/aiCost'
import { MIN_SCORED_CALLS } from '../../shared/aiOutcome'
import { GPT_MIN_CONFIDENCE } from '../../shared/aiSignal'
import { cellStyle, headCellStyle, noteStyle, reasonLabel, signedPct } from '../agents/agentStyles'

export interface ConfirmationReport {
  strategyName: string
  /** Null when the strategy opened no position, so no model was ever asked. */
  model: string | null
  /** The strategy on its own, over the same candles. */
  quantOnly: BacktestStats
  /** The strategy with every vetoed entry removed: the run the rest of this page describes. */
  confirmed: BacktestStats
  reviews: EntryReview[]
  counts: ConfirmationCounts
  /** Set when the strategy signalled on the final candle while it was still forming: that entry
   * was neither reviewed nor taken. */
  formingEntryTime: number | null
}

function statCells(stats: BacktestStats): React.JSX.Element {
  // A run that never traded has no win rate or drawdown, only zeroes standing in for figures that
  // were never measured -- the same rule the strategy comparison table follows.
  const flat = tookNoTrades(stats)
  const net = signedPct(stats.totalNetProfitPct)
  return (
    <>
      <td style={{ ...cellStyle, fontWeight: 600, color: flat ? 'var(--text-muted)' : net.color }}>{flat ? 'no trades' : net.text}</td>
      <td style={cellStyle}>{stats.totalClosedTrades}</td>
      <td style={cellStyle}>{flat ? '—' : `${stats.winRatePct.toFixed(0)}%`}</td>
      <td style={{ ...cellStyle, color: flat ? 'var(--text-muted)' : 'var(--down)' }}>{flat ? '—' : `${stats.maxDrawdownPct.toFixed(2)}%`}</td>
      <td style={cellStyle}>{flat ? '—' : stats.totalPaidFees.toFixed(2)}</td>
    </>
  )
}

function tradeResult(review: EntryReview): { text: string; color: string } {
  const trade: Trade | null = review.trade
  if (trade === null) return { text: review.confirmed ? 'still open' : '—', color: 'var(--text-muted)' }
  const move = signedPct(trade.returnPct)
  const held = formatHoldingDuration(trade.exitTime - trade.entryTime)
  const how = trade.exitReason === 'end_of_data' ? `open at the end, after ${held}` : `${held}, ${trade.exitReason.replace('_', ' ')}`
  return { text: `${review.confirmed ? '' : 'would have made '}${move.text} (${how})`, color: move.color }
}

/** What a run with AI-confirmed entries has to say that an ordinary results page does not: the
 * same strategy with nobody asked, and each ruling beside what its entry made or would have made.
 *
 * The vetoed rows are the point. A veto that removed a losing trade and a veto that removed a
 * winning one look identical on an equity curve -- both are simply a trade that is not there --
 * so each one is shown the trade it removed. */
export function AiConfirmationCard({ report }: { report: ConfirmationReport }): React.JSX.Element {
  const { counts, reviews } = report
  const vetoedTrades = reviews.filter((review) => !review.confirmed && review.trade !== null).map((review) => review.trade as Trade)
  const avoided = vetoedTrades.filter((trade) => trade.pnl <= 0).length
  const skipped = vetoedTrades.length - avoided

  return (
    <div>
      <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
        {report.model === null
          ? `${report.strategyName} opened no position over this range, so there was no entry to review and no model was asked.`
          : `${report.strategyName} was run twice over the same candles: on its own, and with ${report.model} asked once about each trade before it was taken. The model can only remove a trade; exits and stops are the strategy's own in both runs, so the second row is the first with the vetoed trades missing. Paper only.`}
      </p>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={headCellStyle}>Run</th>
              <th style={headCellStyle}>Net</th>
              <th style={headCellStyle}>Trades</th>
              <th style={headCellStyle}>Win rate</th>
              <th style={headCellStyle}>Max drawdown</th>
              <th style={headCellStyle}>Fees</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ ...cellStyle, fontWeight: 600 }}>Strategy alone</td>
              {statCells(report.quantOnly)}
            </tr>
            <tr>
              <td style={{ ...cellStyle, fontWeight: 600 }}>With AI confirmation</td>
              {statCells(report.confirmed)}
            </tr>
          </tbody>
        </table>
      </div>

      {counts.reviewed > 0 && (
        <>
          <p style={{ ...noteStyle, margin: '0.9rem 0 0' }}>
            {counts.reviewed} {counts.reviewed === 1 ? 'entry' : 'entries'} reviewed: {counts.confirmed} confirmed, {counts.vetoed} vetoed
            {counts.refused > 0 && ` (${counts.refused} of those because the answer was unusable, not because the model said no)`}.{' '}
            {counts.generated} new {counts.generated === 1 ? 'call' : 'calls'} costing {formatUsd(counts.costUsd)}, {counts.cached} served from
            the cache.
            {vetoedTrades.length > 0 &&
              ` The vetoes avoided ${avoided} losing ${avoided === 1 ? 'trade' : 'trades'} and skipped ${skipped} winning ${skipped === 1 ? 'one' : 'ones'}.`}
          </p>
          {counts.reviewed < MIN_SCORED_CALLS && (
            <p style={{ ...noteStyle, margin: '0.5rem 0 0', color: 'var(--gold)' }}>
              {counts.reviewed} {counts.reviewed === 1 ? 'review is' : 'reviews are'} too few to tell a model that helps from one that was
              lucky. Under {MIN_SCORED_CALLS}, the gap between the two rows above is not evidence either way.
            </p>
          )}
          {report.formingEntryTime !== null && (
            <p style={{ ...noteStyle, margin: '0.5rem 0 0' }}>
              The strategy also signalled on the final candle ({formatUtcDate(report.formingEntryTime)} {formatUtcTime(report.formingEntryTime)}{' '}
              UTC), which had not closed. That entry was neither reviewed nor taken.
            </p>
          )}

          <div style={{ overflowX: 'auto', marginTop: '0.9rem' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headCellStyle}>Signal bar (UTC)</th>
                  <th style={headCellStyle}>Ruling</th>
                  <th style={headCellStyle}>Conf.</th>
                  <th style={headCellStyle}>Its reasons</th>
                  <th style={headCellStyle}>What the entry made</th>
                </tr>
              </thead>
              <tbody>
                {reviews.map((review) => {
                  const outcome = tradeResult(review)
                  const refused = Boolean(review.decision.rejected)
                  return (
                    <tr key={review.time} title={review.decision.rejected ?? review.decision.rationale}>
                      <td style={cellStyle}>
                        {formatUtcDate(review.time)} {formatUtcTime(review.time)}
                      </td>
                      <td style={{ ...cellStyle, fontWeight: 700, color: review.confirmed ? 'var(--up)' : 'var(--down)' }}>
                        {review.confirmed ? 'CONFIRMED' : refused ? 'VETOED (unusable answer)' : 'VETOED'}
                      </td>
                      <td style={cellStyle}>{refused ? '—' : `${(review.decision.confidence * 100).toFixed(0)}%`}</td>
                      <td style={{ ...cellStyle, whiteSpace: 'normal', color: 'var(--text-secondary)' }}>
                        {review.decision.detail?.reasonCodes.map(reasonLabel).join(', ') || '—'}
                      </td>
                      <td style={{ ...cellStyle, color: outcome.color }}>{outcome.text}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p style={{ ...noteStyle, marginTop: '0.7rem' }}>
            A buy the model was less than {(GPT_MIN_CONFIDENCE * 100).toFixed(0)}% confident in counts as a veto, the same gate GPT
            Intraday enters on. Hover a row for the model&apos;s reasoning. Every review is also in AI Decisions › Signals.
          </p>
        </>
      )}
    </div>
  )
}
