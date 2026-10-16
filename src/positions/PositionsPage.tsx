import { useEffect, useMemo, useRef, useState } from 'react'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { BotPositionRow } from './BotPositionRow'
import { HeldPositionRow } from './HeldPositionRow'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { LivePositionRow } from './LivePositionRow'
import { LedgerCheck } from './LedgerCheck'
import { LiveHistoryRow } from './LiveHistoryRow'
import { OwnPaperTradesCard } from './OwnPaperTradesCard'
import { liveSubjects, paperSubjects } from './thesisMeasure'
import { useThesisReadings } from './useThesisReadings'
import { emptyAccount, settle } from '../account/paperAccount'
import type { Bot } from '../bots/types'
import type { ExecutorConfig, HeldPosition, LivePosition, LiveWatcherSummary, TradingBook } from '../../shared/ipc'
import { useI18n } from '../i18n'

const LIVE_POLL_MS = 15_000
/** The demo book's rows (V7.1 Stage 8): closed through the demo bridge, said to hold play money. */
const DEMO_BOOK: TradingBook = 'demo'

const headerCellStyle: React.CSSProperties = {
  padding: '0 0.9rem 0.6rem',
  fontSize: '0.68rem',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  textAlign: 'start'
}

export function PositionsPage(): React.JSX.Element {
  const { t } = useI18n()
  const [bots, setBots] = useState<Bot[]>([])
  const [executors, setExecutors] = useState<ExecutorConfig[]>([])
  const [heldPositions, setHeldPositions] = useState<HeldPosition[]>([])
  const [livePositions, setLivePositions] = useState<LivePosition[]>([])
  const [watchers, setWatchers] = useState<LiveWatcherSummary[]>([])
  const [liveHistory, setLiveHistory] = useState<LivePosition[]>([])
  /** The demo book (V7.1 Stage 8): an exchange's demo account, play money, shown apart. */
  const [demoPositions, setDemoPositions] = useState<LivePosition[]>([])
  const [demoWatchers, setDemoWatchers] = useState<LiveWatcherSummary[]>([])
  const [demoHistory, setDemoHistory] = useState<LivePosition[]>([])
  const [loaded, setLoaded] = useState(false)
  const [liveError, setLiveError] = useState<string | null>(null)
  /** Closing a held position is a click that either removes the row or does nothing at all --
   * previously a failed settings write only reached console.error, so "nothing happened" was the
   * whole of the feedback. */
  const [heldError, setHeldError] = useState<string | null>(null)
  const loadedRef = useRef(false)

  // A failed poll must not look like "genuinely no open positions" on a page titled Real Money —
  // keep whatever was last successfully loaded and surface the failure instead of silently
  // clearing/freezing the table with no indication anything went wrong.
  function refreshLivePositions(): void {
    window.api.liveTrading
      .listPositions()
      .then((positions) => {
        setLivePositions(positions)
        setLiveError(null)
      })
      .catch((error) => {
        console.error('Failed to load live positions:', error)
        setLiveError(error instanceof Error ? error.message : String(error))
      })
    window.api.liveTrading
      .listClosedPositions()
      .then(setLiveHistory)
      .catch((error) => console.error('Failed to load live trade history:', error))
    // The watchers' copies: each position's barriers, shown beside it with its thesis status.
    window.api.liveTrading
      .listActiveWatchers()
      .then(setWatchers)
      .catch((error) => console.error('Failed to load live watchers:', error))
    // The demo book, read beside: a failure here leaves the real rows whole.
    window.api.demoTrading
      .listPositions()
      .then(setDemoPositions)
      .catch((error) => console.error('Failed to load demo positions:', error))
    window.api.demoTrading
      .listClosedPositions()
      .then(setDemoHistory)
      .catch((error) => console.error('Failed to load demo trade history:', error))
    window.api.demoTrading
      .listActiveWatchers()
      .then(setDemoWatchers)
      .catch((error) => console.error('Failed to load demo watchers:', error))
  }

  useEffect(() => {
    refreshLivePositions()
    const timer = setInterval(refreshLivePositions, LIVE_POLL_MS)
    return (): void => clearInterval(timer)
  }, [])

  // Inventory is re-read on the same tick as live positions, not just once at mount: a
  // controller's risk-control breach can hand a position over while this page is open (see
  // handOverPositionOnStop), and a list frozen at mount would never show it.
  function refreshSettingsBacked(): void {
    window.api.settings
      .get()
      .then((settings) => {
        setBots(settings.bots)
        setExecutors(settings.executors)
        setHeldPositions(settings.heldPositions)
        setLoaded(true)
        loadedRef.current = true
      })
      .catch((error) => console.error('Failed to load positions settings:', error))
  }

  useEffect(() => {
    refreshSettingsBacked()
    const timer = setInterval(refreshSettingsBacked, LIVE_POLL_MS)
    return (): void => clearInterval(timer)
  }, [])

  // Writes against a freshly re-read array rather than persisting local state wholesale.
  // settings.set replaces the entire heldPositions array, so echoing back a copy loaded at mount
  // would silently delete anything handed over since -- and closing one row is a removal of one
  // id, which applies just as correctly to the current array as to the stale one.
  //
  // `closeValue` is what the position is worth at the price the row is showing, and it goes back
  // into the balance. Removing the row on its own destroyed the money: the cash left the balance
  // when the position was handed over (settleExecutorOnStop books -amountQuote, because the cash
  // IS the position from then on), so deleting the row with no credit made the stake and the
  // profit disappear together.
  function handleCloseHeldPosition(id: string, closeValue: number): void {
    void (async (): Promise<void> => {
      setHeldError(null)
      try {
        // Queued: re-reading before the write narrows the gap but does not close it, and a
        // handover landing inside it would be erased by this removal.
        //
        // Both keys go in ONE settings.set, so the credit and the removal cannot come apart. Two
        // writes would mean a failure between them either pays twice or, exactly as before, pays
        // nothing at all.
        const next = await settingsWrites(async () => {
          const fresh = await window.api.settings.get()
          const position = fresh.heldPositions.find((p) => p.id === id)
          // Already gone -- another window, or a retry, got there first. Removing it again is
          // harmless; paying for it again is not.
          if (!position) return fresh.heldPositions
          const remaining = fresh.heldPositions.filter((p) => p.id !== id)
          const now = Math.floor(Date.now() / 1000)
          const account = settle(fresh.paperAccount ?? emptyAccount(now), {
            asset: position.quoteAsset,
            amount: closeValue,
            executorId: position.sourceExecutorId,
            note: `Closed ${position.sourceExecutorName}'s position from Inventory`,
            now,
            id: crypto.randomUUID()
          })
          await window.api.settings.set({ heldPositions: remaining, paperAccount: account })
          return remaining
        })
        setHeldPositions(next)
      } catch (error) {
        console.error('Failed to close held position:', error)
        setHeldError(describeError(error))
      }
    })()
  }

  const activeBots = bots.filter((b) => b.enabled)

  // The theses of the app's own paper trades and of the real positions with a watcher, measured once
  // a minute while the page is open (thesisMeasure.ts): shown, never acted on.
  const subjects = useMemo(() => [...paperSubjects(executors), ...liveSubjects(livePositions, watchers)], [executors, livePositions, watchers])
  const theses = useThesisReadings(subjects)

  return (
    <>
      <PageHeader title={t('Positions')} subtitle={t('Paper positions from bots and executors, plus any real-money positions — each section says which it is')} />
      <Card title={t('Open Positions')}>
        {loaded && activeBots.length === 0 && <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{t('No active bots. Enable a bot under Strategies › Active Runs to see its paper position here.')}</p>}
        {activeBots.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headerCellStyle}>{t('Bot')}</th>
                  <th style={headerCellStyle}>{t('Side')}</th>
                  <th style={headerCellStyle}>{t('Entry')}</th>
                  <th style={headerCellStyle}>{t('Mark')}</th>
                  <th style={headerCellStyle}>{t('Stop')}</th>
                  <th style={headerCellStyle}>{t('Unrealized P&L')}</th>
                </tr>
              </thead>
              <tbody>
                {activeBots.map((bot) => (
                  <BotPositionRow key={bot.id} bot={bot} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <OwnPaperTradesCard executors={executors} readings={theses.readings} measuredAt={theses.measuredAt} />

      <Card title={t('Live Positions — Real Money')}>
        {liveError && (
          <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0 0 0.7rem' }}>
            {t('Failed to refresh live positions ({error}) — the list below may be stale. Retrying every {seconds}s.', { error: liveError, seconds: LIVE_POLL_MS / 1000 })}
          </p>
        )}
        {livePositions.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            {t("No open live positions. A live-mode Order, Position, DCA, TWAP or Grid executor's BUY fill lands here — closing one places a real market sell.")}
          </p>
        )}
        {livePositions.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headerCellStyle}>{t('Symbol')}</th>
                  <th style={headerCellStyle}>{t('Qty')}</th>
                  <th style={headerCellStyle}>{t('Avg Cost')}</th>
                  <th style={headerCellStyle}>{t('Mark')}</th>
                  <th style={headerCellStyle}>{t('Unrealized P&L')}</th>
                  <th style={headerCellStyle}></th>
                </tr>
              </thead>
              <tbody>
                {livePositions.map((position) => {
                  const watcher = watchers.find((entry) => entry.livePositionId === position.id) ?? null
                  return (
                    <LivePositionRow
                      key={position.id}
                      position={position}
                      onClosed={refreshLivePositions}
                      thesis={watcher === null ? null : { watcher, reading: theses.readings[position.id] ?? null }}
                    />
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {livePositions.length > 0 && <LedgerCheck positions={livePositions} />}
      </Card>

      <Card title={t('Live Trade History — Realized P&L')}>
        {liveHistory.length === 0 && <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{t('No closed live positions yet. Once a live position is fully closed, it lands here with its realized P&L.')}</p>}
        {liveHistory.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headerCellStyle}>{t('Symbol')}</th>
                  <th style={headerCellStyle}>{t('Entry')}</th>
                  <th style={headerCellStyle}>{t('Exit')}</th>
                  <th style={headerCellStyle}>{t('Realized P&L')}</th>
                  <th style={headerCellStyle}>{t('Closed@@a column')}</th>
                </tr>
              </thead>
              <tbody>
                {liveHistory.map((position) => (
                  <LiveHistoryRow key={position.id} position={position} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {(demoPositions.length > 0 || demoHistory.length > 0) && (
        <Card title={t('Demo Positions — play money')}>
          <p style={{ color: 'var(--text-secondary)', margin: '0 0 0.7rem', fontSize: '0.8rem' }}>
            {t("Positions on an exchange's demo account, opened over your demo key by a demo executor or the paper laboratory. Play money the exchange gives: closing one places a demo sell, never a real one.")}
          </p>
          {demoPositions.length === 0 && <p style={{ color: 'var(--text-secondary)', margin: 0 }}>{t('No open demo positions.')}</p>}
          {demoPositions.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={headerCellStyle}>{t('Symbol')}</th>
                    <th style={headerCellStyle}>{t('Qty')}</th>
                    <th style={headerCellStyle}>{t('Avg Cost')}</th>
                    <th style={headerCellStyle}>{t('Mark')}</th>
                    <th style={headerCellStyle}>{t('Unrealized P&L')}</th>
                    <th style={headerCellStyle}></th>
                  </tr>
                </thead>
                <tbody>
                  {demoPositions.map((position) => {
                    const watcher = demoWatchers.find((entry) => entry.livePositionId === position.id) ?? null
                    return <LivePositionRow key={position.id} position={position} onClosed={refreshLivePositions} book={DEMO_BOOK} thesis={watcher === null ? null : { watcher, reading: null }} />
                  })}
                </tbody>
              </table>
            </div>
          )}
          {demoHistory.length > 0 && (
            <div style={{ overflowX: 'auto', marginTop: '0.8rem' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={headerCellStyle}>{t('Symbol')}</th>
                    <th style={headerCellStyle}>{t('Entry')}</th>
                    <th style={headerCellStyle}>{t('Exit')}</th>
                    <th style={headerCellStyle}>{t('Realized P&L')}</th>
                    <th style={headerCellStyle}>{t('Closed@@a column')}</th>
                  </tr>
                </thead>
                <tbody>
                  {demoHistory.map((position) => (
                    <LiveHistoryRow key={position.id} position={position} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card title={t('Inventory (Handed-Over Positions)')}>
        {loaded && heldPositions.length === 0 && (
          <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
            {t('Nothing here yet. When an executor with "Keep position when stopped" enabled is stopped mid-trade, its open position lands here instead of being discarded.')}
          </p>
        )}
        {heldError !== null && (
          <p style={{ color: 'var(--down)', fontSize: '0.78rem', margin: '0 0 0.7rem' }}>
            {t('That position could not be closed ({error}) — it is still listed below, and still counts toward your holdings. Try Close again.', { error: heldError })}
          </p>
        )}
        {heldPositions.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={headerCellStyle}>{t('Source')}</th>
                  <th style={headerCellStyle}>{t('Side')}</th>
                  <th style={headerCellStyle}>{t('Entry')}</th>
                  <th style={headerCellStyle}>{t('Mark')}</th>
                  <th style={headerCellStyle}>{t('Amount')}</th>
                  <th style={headerCellStyle}>{t('Unrealized P&L')}</th>
                  <th style={headerCellStyle}></th>
                </tr>
              </thead>
              <tbody>
                {heldPositions.map((position) => (
                  <HeldPositionRow key={position.id} position={position} onClose={handleCloseHeldPosition} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  )
}
