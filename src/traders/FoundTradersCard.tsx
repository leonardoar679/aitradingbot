import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { Toggle } from '../components/Toggle'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { sumWords } from '../../shared/alerts'
import { DISCOVERY_LINES, type BoardsSource, type DiscoveryState, type FoundTrader } from '../../shared/traders/discovery'
import { msg, useI18n } from '../i18n'
import { utcWhen } from './traderText'

// FOUND FOR YOU (V9 Stage 3, 6 November 2026; shared/traders/discovery.ts): the traders the app found on OKX's and
// Hyperliquid's public rankings by its fixed rule, each with the ranking's figures on the day it was found and, once the
// app has read and analysed them, what their record made after fees, the skill test's verdict and what a follower
// two minutes late, the delay test's shortest delay, would have made a trip. Their verdicts describe them: they were picked for their past profit. Opening one
// shows their cards below, with Follow on paper -- the person's own click; the app follows no one by itself. The switch
// stops or starts the daily reading. Since V9 Stage 4 the card also says what the analysed found traders held when last
// read, coin by coin: context, never a call shown (V9-TOP-TRADERS-2 judges it after sixty days). Since V9 Stage 9 an
// analysis that lost reads says so, and that it is made again six hours on, or how many times it was made.

/** Coins listed of what they hold, the most held first. */
const HELD_SHOWN = 8

/** The venues by their own names, which no language changes. */
const VENUE_NAMES: Record<string, string> = { okx: 'OKX', hyperliquid: 'Hyperliquid' }
const STATUS_WORDS: Record<string, string> = {
  queued: msg('waiting to be analysed'),
  analysing: msg('being analysed now'),
  analysed: msg("analysed@@a found trader's status"),
  skipped: msg('could not be read')
}

const shortId = (id: string): string => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id)

/** What a venue or a test wrote, shown as written. */
function Written({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <bdi lang="en">{children}</bdi>
}

/** The card, reading the found traders as they change. */
export function FoundTradersCard({ onOpen }: { onOpen: (key: string) => void }): React.JSX.Element {
  const [state, setState] = useState<DiscoveryState | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let cancelled = false
    window.api.traders.discovery().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      () => undefined
    )
    const stop = window.api.traders.onDiscovery((next) => {
      if (!cancelled) setState(next)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])
  const toggle = (on: boolean): void => {
    setBusy(true)
    void window.api.traders
      .setDiscovery(on)
      .then(setState, () => undefined)
      .finally(() => setBusy(false))
  }
  return <FoundTradersView state={state} busy={busy} onToggle={toggle} onOpen={onOpen} />
}

/** What the card shows: pure. */
export function FoundTradersView({ state, busy, onToggle, onOpen }: { state: DiscoveryState | null; busy: boolean; onToggle: (on: boolean) => void; onOpen: (key: string) => void }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num } = i18n
  const signedSum = (value: number): string => `${value > 0 ? '+' : ''}${sumWords(value, i18n)}`
  const sourceLine = (source: BoardsSource): string =>
    source.ok
      ? t('{venue}: {rows} read, {passed} pass the rule.', { venue: VENUE_NAMES[source.venue] ?? source.venue, rows: num(source.rows, 0, 0), passed: num(source.passed, 0, 0) })
      : t('{venue}: not read.', { venue: VENUE_NAMES[source.venue] ?? source.venue })
  const lastMonth = (trader: FoundTrader): string => (trader.board.venue === 'okx' ? i18n.pct(trader.board.last30d * 100, 1) : signedSum(trader.board.last30d))
  return (
    <Card title={t('Found for you')}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', flexWrap: 'wrap' }}>
        <Toggle on={state?.enabled !== false} onChange={(next) => !busy && onToggle(next)} />
        <span style={{ fontSize: '0.84rem' }}>{t('Find traders every day')}</span>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
        {t("Once a day the app reads OKX's lead-trader ranking and Hyperliquid's leaderboard, picks up to {count} traders by a fixed rule -- profit all time and over the last 30 days, an account of $50,000 or more, not a market maker, on OKX 90 days leading -- and reads and analyses each, half an hour apart, behind every follow. It places nothing.", { count: DISCOVERY_LINES.newPerDay })}
      </p>
      {state !== null && state.lastReadAt !== null && (
        <p style={{ ...noteStyle, marginTop: '0.3rem' }}>
          {t('Rankings last read {when}.', { when: utcWhen(i18n, state.lastReadAt * 1000) })} {state.sources.map(sourceLine).join(' ')}
        </p>
      )}
      {state !== null && state.found.length === 0 ? (
        <p style={{ ...noteStyle, marginTop: '0.4rem' }}>{state.enabled ? t('None found yet: the first reading comes a few minutes after the app starts.') : t('Finding traders is off.')}</p>
      ) : (
        <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[t('Trader'), t('Found@@when a trader was found'), t('Profit, all time'), t('Last 30 days'), t("Account@@a trader's account value"), t("Analysis@@what the app's tests found of a trader"), ''].map((name, k) => (
                  <th key={`${k}:${name}`} style={headCellStyle}>
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(state?.found ?? []).map((trader) => (
                <tr key={trader.key}>
                  <td dir="ltr" style={{ ...cellStyle, fontWeight: 600 }}>
                    <bdi dir="auto">{trader.board.name ?? shortId(trader.board.id)}</bdi>
                    <div style={{ fontWeight: 400, fontSize: '0.72rem', color: 'var(--text-muted)' }}>{VENUE_NAMES[trader.board.venue]}</div>
                  </td>
                  <td style={cellStyle}>{utcWhen(i18n, trader.foundAt * 1000)}</td>
                  <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{signedSum(trader.board.pnlAllTime)}</td>
                  <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{lastMonth(trader)}</td>
                  <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>
                    {sumWords(trader.board.accountUsd, i18n)}
                    {trader.board.venue === 'okx' && <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{t("copiers' assets")}</div>}
                  </td>
                  <td style={cellStyle}>
                    {trader.latest === null ? (
                      <span style={{ color: 'var(--text-muted)' }}>
                        {t(STATUS_WORDS[trader.status])}
                        {trader.why !== null && (
                          <>
                            {': '}
                            <Written>{trader.why}</Written>
                          </>
                        )}
                      </span>
                    ) : (
                      <span>
                        {t('{trips} trips, {net} after fees', { trips: num(trader.latest.trips, 0, 0), net: signedSum(trader.latest.netUsd) })}
                        {trader.latest.skill !== null && (
                          <>
                            {' · '}
                            <Written>{trader.latest.skill}</Written>
                          </>
                        )}
                        {trader.latest.followerNetPct !== null && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>{trader.latest.followerDelayMin === 5
                            ? t('A follower five minutes late, as OKX shows positions: {net} a trip', { net: i18n.pct(trader.latest.followerNetPct, 2) })
                            : t('A follower two minutes late: {net} a trip', { net: i18n.pct(trader.latest.followerNetPct, 2) })}</div>
                        )}
                        {trader.latest.unread > 0 && (
                          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                            {trader.status === 'analysing'
                              ? t(STATUS_WORDS.analysing)
                              : trader.again < DISCOVERY_LINES.maxAgain
                                ? t('Partly read: {reads} of its reads failed. It is analysed again {hours} hours after this analysis.', { reads: num(trader.latest.unread, 0, 0), hours: num(DISCOVERY_LINES.againAfterSeconds / 3600, 0, 0) })
                                : t('Partly read: {reads} of its reads failed, after {times} analyses.', { reads: num(trader.latest.unread, 0, 0), times: num(trader.again + 1, 0, 0) })}
                          </div>
                        )}
                      </span>
                    )}
                  </td>
                  <td style={cellStyle}>
                    {trader.latest !== null && (
                      <button type="button" style={buttonStyle('secondary', false)} onClick={() => onOpen(trader.key)}>
                        {t('Open@@a button: shows a trader found')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {state?.holdings != null && state.holdings.consensus.length > 0 && (
        <div style={{ marginTop: '0.6rem', fontSize: '0.84rem', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <span>{t('What they held when read, {when}:', { when: utcWhen(i18n, state.holdings.at * 1000) })}</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            {state.holdings.consensus
              .slice(0, HELD_SHOWN)
              .map((entry) => t('{coin}: {longs} long, {shorts} short', { coin: entry.coin, longs: num(entry.longs, 0, 0), shorts: num(entry.shorts, 0, 0) }))
              .join(' · ')}
          </span>
          <p style={{ ...noteStyle, margin: 0 }}>
            {t('Context, not a call. Where three or more hold a coin and two thirds of them one way, that way is recorded once a day as a call of its own, judged after 60 days against the share of coins that moved that way; until then it is never shown on Home or taken as a side.')}
          </p>
        </div>
      )}
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        {t('{count} found traders analysed. They were picked for their past profit, so their tests describe them and prove nothing: what is judged is following them on paper from the day they were found, all of them together.', { count: state?.analysed ?? 0 })}
        {(state?.analysed ?? 0) > 0 && (
          <>
            {' '}
            {t('Allowing for how many were analysed, {beyond} of them still read as skill.', { beyond: num(state?.beyondChance ?? 0, 0, 0) })}
          </>
        )}
      </p>
      <p style={{ ...noteStyle, marginTop: '0.3rem' }}>
        {t("To follow one on paper, open them and press Follow on paper there; until paper testing is started, a follow only records what it would have done. Hyperliquid's leaderboard is the site's own data, not part of its documented API.")}
      </p>
    </Card>
  )
}
