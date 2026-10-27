import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { useI18n, type I18n } from '../i18n'
import { describeError } from '../utils/ipcError'
import type { ExecutorConfig } from '../../shared/ipc'
import type { MissRecord } from '../../shared/misses'
import { healPaperBooks } from '../../shared/paperBooks'
import { healCopyTrading, type CopyTradingSettings } from '../../shared/traders/copyTrading'
import { CLONE_LINES } from '../../shared/traders/clone'
import { followableAt } from '../../shared/traders/delay'
import type { FollowStatus } from '../../shared/traders/follow'
import type { TraderAnalysis, TraderMeta } from '../../shared/traders/traderAnalysis'

// FOLLOWING AND CLONING ON PAPER, ON COPY TRADERS (V8 Stage 8, 27 October 2026). A trader's two buttons -- Follow on
// paper, Run the clone on paper -- each switching on or off only what it names (electron/services/followService.ts);
// how the follow is read, its open and closed trades in the copy book and the delay it measured live, which is the
// delay V8-S6-DELAY's verdict is read at; the clone's; and the copy book's recent missed opportunities with why. It
// reads; the trades are written by src/traders/paperFollow.ts and paperClone.ts, on paper. Rendered in its own error
// boundary, so a failure here leaves the rest of the page.

const REFRESH_MS = 10_000

/** A moment on the records' clock: its UTC day and time. */
export const utcWhen = (i18n: I18n, ms: number): string => i18n.t('{time} UTC', { time: `${i18n.utcDay(ms)} ${i18n.utcTime(ms)}` })

/** What the panel reads of the settings and the books. */
export interface PaperCopyHeld {
  copy: CopyTradingSettings
  executors: ExecutorConfig[]
  running: boolean
  /** The most one trade of the copy book may stake, as a share of it. */
  stakeShare: number
}

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function PaperCopyPanel({ meta, analysis }: { meta: TraderMeta; analysis: TraderAnalysis | null }): React.JSX.Element {
  const key = meta.ref.key
  const [held, setHeld] = useState<PaperCopyHeld | null>(null)
  const [statuses, setStatuses] = useState<FollowStatus[]>([])
  const [misses, setMisses] = useState<MissRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    const [settings, books, missed] = await Promise.all([window.api.settings.get(), window.api.books.state(), window.api.books.misses(Math.floor(Date.now() / 1000) - 86_400)])
    setHeld({ copy: healCopyTrading(settings.copyTrading), executors: settings.executors ?? [], running: books.running, stakeShare: healPaperBooks(settings.paperBooks).books.copy.maxStakeShare })
    setMisses(missed.filter((miss) => miss.book === 'copy').slice(-5).reverse())
  }, [])
  useEffect(() => {
    void refresh().catch(() => undefined)
    void window.api.traders
      .followStatus()
      .then(setStatuses)
      .catch(() => undefined)
    const off = window.api.traders.onFollowStatus(setStatuses)
    const timer = setInterval(() => void refresh().catch(() => undefined), REFRESH_MS)
    return (): void => {
      off()
      clearInterval(timer)
    }
  }, [refresh])

  const press = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      await run()
      await refresh()
    } catch (error) {
      setProblem(describeError(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <PaperCopyView
      meta={meta}
      analysis={analysis}
      held={held}
      status={statuses.find((entry) => entry.key === key) ?? null}
      misses={misses}
      busy={busy}
      problem={problem}
      onFollow={(on) => void press(() => window.api.traders.follow(key, on))}
      onClone={(on) => void press(() => window.api.traders.clone(key, on))}
    />
  )
}

/** The panel as it reads: what is switched on, the trades, the measured delay, the misses. */
export function PaperCopyView({
  meta,
  analysis,
  held,
  status,
  misses,
  busy,
  problem,
  onFollow,
  onClone
}: {
  meta: TraderMeta
  analysis: TraderAnalysis | null
  held: PaperCopyHeld | null
  status: FollowStatus | null
  misses: readonly MissRecord[]
  busy: boolean
  problem: string | null
  onFollow: (on: boolean) => void
  onClone: (on: boolean) => void
}): React.JSX.Element {
  const i18n = useI18n()
  const { t, num, signedMoney, pctPlain } = i18n
  const key = meta.ref.key
  const following = held?.copy.follows[key] ?? null
  const cloning = held?.copy.clones[key] ?? null
  const follows = (held?.executors ?? []).filter((executor) => executor.follow?.traderKey === key && executor.mode === 'paper')
  const clones = (held?.executors ?? []).filter((executor) => executor.clone?.traderKey === key && executor.mode === 'paper')
  const closedNet = (trades: readonly ExecutorConfig[]): number => trades.reduce((total, trade) => total + (trade.book?.result?.netQuote ?? 0), 0)
  const delays = follows.map((executor) => executor.follow?.delaySec ?? Number.NaN).filter(Number.isFinite)
  const measured = median(delays)
  const verdict = analysis?.delay !== null && analysis?.delay !== undefined && measured !== null ? followableAt(analysis.delay, measured) : null
  const rule = analysis?.clone?.rule ?? null

  return (
    <Card title={t('On paper')}>
      {held !== null && !held.running && (
        <p style={{ ...noteStyle, marginTop: 0 }}>
          {t('The paper books are not running: until they are started, a follow and a clone write what they would have done as missed opportunities, with why.')}
        </p>
      )}
      {problem !== null && (
        <p style={{ ...noteStyle, color: 'var(--down)' }}>
          <bdi lang="en">{problem}</bdi>
        </p>
      )}

      <h3 style={{ margin: '0.6rem 0 0.3rem', fontSize: '0.9rem' }}>{t('Follow@@a heading: following a trader on paper')}</h3>
      {meta.source === 'file' ? (
        <p style={noteStyle}>{t("A file is not a trader's live record: there is no one to follow.")}</p>
      ) : (
        <>
          <button type="button" style={buttonStyle(following === null ? 'primary' : 'secondary', busy)} disabled={busy || analysis === null} onClick={() => onFollow(following === null)}>
            {following === null ? t('Follow on paper') : t('Stop following')}
          </button>
          {following !== null && (
            <div style={{ ...noteStyle, marginTop: '0.4rem' }}>
              <p style={{ margin: 0 }}>
                {status?.mode === 'stream'
                  ? t("Following since {time}: their trades read as they are made, on Hyperliquid's stream.", { time: utcWhen(i18n, following.since) })
                  : t('Following since {time}: their trades read once a minute.', { time: utcWhen(i18n, following.since) })}{' '}
                {t('A follow stays open at most {hours} hours, the longest the trader held.', { hours: num(following.maxHoldSec / 3600, 0, 1) })}
              </p>
              {status?.lost === true && <p style={{ margin: '0.2rem 0 0', color: 'var(--down)' }}>{t('Lost: two reads of the trader missed in a row. Their follows close.')}</p>}
              {status?.hidden === true && <p style={{ margin: '0.2rem 0 0' }}>{t('The trader hides their positions on OKX: there is nothing to follow until they show them.')}</p>}
              {status !== null && <p style={{ margin: '0.2rem 0 0' }}>{t('{count} of their trades read today.', { count: status.eventsToday })}</p>}
            </div>
          )}
          <TradesTable trades={follows} />
          {follows.some((trade) => trade.status === 'stopped') && (
            <p style={noteStyle}>{t('{count} follows closed: {net} after fees and funding.', { count: follows.filter((trade) => trade.status === 'stopped').length, net: signedMoney(closedNet(follows), 'USDT') })}</p>
          )}
          {measured !== null && (
            <p style={noteStyle}>
              {verdict === null
                ? t('The follows entered a median {seconds} s after the trader.', { seconds: num(measured, 0, 0) })
                : verdict.followable
                  ? t('The follows entered a median {seconds} s after the trader: at that delay the record is followable (its {minutes}-minute row is above 0).', { seconds: num(measured, 0, 0), minutes: verdict.delayMin })
                  : t("The follows entered a median {seconds} s after the trader: at that delay the record is not followable (its {minutes}-minute row's interval reaches 0).", { seconds: num(measured, 0, 0), minutes: verdict.delayMin })}
            </p>
          )}
        </>
      )}

      <h3 style={{ margin: '0.9rem 0 0.3rem', fontSize: '0.9rem' }}>{t("Clone@@a heading: running a trader's clone on paper")}</h3>
      {rule === null ? (
        <p style={noteStyle}>{t('The last analysis fitted no rule: there is no clone to run.')}</p>
      ) : (
        <>
          <button type="button" style={buttonStyle(cloning === null ? 'primary' : 'secondary', busy)} disabled={busy} onClick={() => onClone(cloning === null)}>
            {cloning === null ? t('Run the clone on paper') : t('Stop the clone')}
          </button>
          {cloning !== null && (
            <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
              {t('Running since {time}: its rule read at each 15-minute close on {coins}, each trade held {hours} hours.', { time: utcWhen(i18n, cloning.since), coins: cloning.coins.map((coin) => coin.symbol).join(', '), hours: num((cloning.rule.holdBars * CLONE_LINES.barMinutes) / 60, 0, 2) })}
            </p>
          )}
          <TradesTable trades={clones} />
          {clones.some((trade) => trade.status === 'stopped') && (
            <p style={noteStyle}>{t('{count} clone trades closed: {net} after fees and funding.', { count: clones.filter((trade) => trade.status === 'stopped').length, net: signedMoney(closedNet(clones), 'USDT') })}</p>
          )}
        </>
      )}

      {misses.length > 0 && (
        <>
          <h3 style={{ margin: '0.9rem 0 0.3rem', fontSize: '0.9rem' }}>{t("The copy book's last missed opportunities")}</h3>
          <ul style={{ ...noteStyle, margin: 0, paddingInlineStart: '1.1rem' }}>
            {misses.map((miss) => (
              <li key={`${miss.at}:${miss.pair}:${miss.reason}`}>
                {utcWhen(i18n, miss.at * 1000)} · <bdi dir="ltr">{miss.pair}</bdi> · {miss.writer === 'clone' ? t('clone@@the writer of a missed trade') : t('follow@@the writer of a missed trade')} · <bdi lang="en">{miss.stage}: {miss.reason}</bdi>
              </li>
            ))}
          </ul>
        </>
      )}
      <p style={{ ...noteStyle, marginTop: '0.6rem' }}>
        {t("Paper only: a follow and a clone trade nothing real. Each trade is in the copy book, at the perpetual's own price, after the taker fee and the funding over its hold, with at most {share} of the book at stake.", { share: pctPlain((held?.stakeShare ?? 0.1) * 100, 0) })}
      </p>
    </Card>
  )
}

/** A writer's trades of one trader: open first, then the closed ones' results. */
function TradesTable({ trades }: { trades: readonly ExecutorConfig[] }): React.JSX.Element | null {
  const i18n = useI18n()
  const { t, num, dollars, signedMoney } = i18n
  if (trades.length === 0) return null
  const shown = [...trades].sort((a, b) => (a.status === b.status ? b.createdAt - a.createdAt : a.status === 'active' ? -1 : 1)).slice(0, 10)
  return (
    <div style={{ overflowX: 'auto', marginTop: '0.4rem' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {[t('Opened'), t('Perpetual'), t('Side'), t('Size'), t('Entry'), t('Result')].map((name) => (
              <th key={name} style={headCellStyle}>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((trade) => {
            const follow = trade.follow
            const clone = trade.clone
            const size = follow?.size ?? clone?.qty ?? 0
            const entry = follow?.avgPx ?? clone?.entryPx ?? 0
            const side = (follow?.side ?? clone?.side) === 'long' ? t('long@@a side') : t('short@@a side')
            const result = trade.book?.result
            return (
              <tr key={trade.id}>
                <td style={cellStyle}>{utcWhen(i18n, trade.createdAt * 1000)}</td>
                <td style={cellStyle}>
                  <bdi dir="ltr">{trade.symbol}</bdi>
                </td>
                <td style={cellStyle}>{side}</td>
                <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{num(size, 0, 6)}</td>
                <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{dollars(entry)}</td>
                <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{result === undefined ? (trade.status === 'active' ? t('open@@a trade still open') : '—') : signedMoney(result.netQuote, 'USDT')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
