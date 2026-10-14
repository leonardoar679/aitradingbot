import { useEffect, useRef, useState } from 'react'
import { EXIT_THESIS_CHARS } from '../../shared/aiAdditions'
import { describeDuration } from '../../shared/aiCost'
import { describeDecider } from '../../shared/aiPanel'
import { netUnrealizedPct } from '../../shared/fees'
import type { ExecutorConfig, PositionExecutorParams } from '../../shared/ipc'
import { describeMarketRegime, type MarketRegime } from '../../shared/marketResearch'
import { ownOpenPaperTrades } from '../../shared/paperRisk'
import { Card } from '../components/Card'
import { formatQuotePrice } from '../utils/formatCurrency'
import { ThesisChip } from './ThesisChip'
import { distancesOf, type ThesisReading } from './thesisMeasure'
import { useI18n, type I18n } from '../i18n'

// THE APP'S OWN PAPER TRADES ON POSITIONS (the V4 document, §50-51): the watch's and the news
// rules', each with where it stands on the last closed minute and its THESIS STATUS
// (shared/thesisStatus.ts), measured by the page once a minute (useThesisReadings.ts). IT SHOWS.
// Nothing here opens, closes, sizes or places anything, and the status is a reading: the exit check
// asks by its own triggers, and a stop is a stop.

const headerCellStyle: React.CSSProperties = {
  padding: '0 0.9rem 0.6rem',
  fontSize: '0.68rem',
  fontWeight: 600,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--text-muted)',
  textAlign: 'start'
}
const cellStyle: React.CSSProperties = { padding: '0.65rem 0.9rem', fontSize: '0.82rem', verticalAlign: 'top' }
const smallStyle: React.CSSProperties = { fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)' }
const REGIME_TONES: Record<'up' | 'down' | 'muted' | 'gold', string> = { up: 'var(--up)', down: 'var(--down)', muted: 'var(--text-muted)', gold: 'var(--gold)' }
/** Of a story's title, at most this much. */
const MAX_TITLE = 70

const clockIn = (i18n: I18n, sec: number): string => i18n.t('{time} UTC', { time: i18n.utcTime(sec * 1000) })
const pctIn = (i18n: I18n, value: number, digits = 2): string => (i18n.language === 'en' ? `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%` : i18n.pct(value, digits))
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)

/** What a trade was opened on: the call's reasoning from the ledger for the watch's, by the row the
 * trade's mark names (else by its event and model); the announcement's title for a news rule's. */
async function thesisOf(trade: ExecutorConfig): Promise<string | null> {
  if (trade.newsRule !== undefined) return trade.newsRule.title
  const mark = trade.watch
  if (mark === undefined) return null
  try {
    const page = await window.api.ai.listCalls({ symbol: trade.symbol, sinceSec: mark.eventTime - 60, limit: 200 })
    const row =
      (mark.callId === undefined ? undefined : page.rows.find((entry) => entry.id === mark.callId)) ??
      page.rows.find((entry) => entry.eventId === mark.eventId && entry.model === mark.model && entry.rationale !== null)
    return row?.rationale ?? null
  } catch {
    return null
  }
}

/** Each trade's thesis, read once a trade. */
function useTradeTheses(trades: ExecutorConfig[]): Record<string, string | null> {
  const [theses, setTheses] = useState<Record<string, string | null>>({})
  const asked = useRef(new Set<string>())
  const latest = useRef(trades)
  latest.current = trades
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return (): void => {
      mounted.current = false
    }
  }, [])
  const key = trades
    .map((trade) => trade.id)
    .sort()
    .join(',')
  useEffect(() => {
    for (const trade of latest.current) {
      if (asked.current.has(trade.id)) continue
      asked.current.add(trade.id)
      void thesisOf(trade).then((text) => {
        if (mounted.current) setTheses((held) => ({ ...held, [trade.id]: text }))
      })
    }
  }, [key])
  return theses
}

function Regime({ regime }: { regime: MarketRegime | null }): React.JSX.Element {
  const i18n = useI18n()
  if (regime === null) return <span style={{ color: 'var(--text-muted)' }}>—</span>
  const shown = describeMarketRegime(regime, i18n)
  return <span style={{ color: REGIME_TONES[shown.tone], fontWeight: 600 }}>{shown.word}</span>
}

function OwnPaperTradeRow({ executor, reading, thesis, measured }: { executor: ExecutorConfig; reading: ThesisReading | null; thesis: string | null; measured: boolean }): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  const clock = (sec: number): string => clockIn(i18n, sec)
  const pct = (value: number, digits = 2): string => pctIn(i18n, value, digits)
  const price = (value: number): string => formatQuotePrice(value, executor.quoteAsset, i18n)
  const params = executor.params as PositionExecutorParams
  const { side } = params
  const openedBy =
    executor.watch !== undefined
      ? t('Opened by the watch, on a call by {model}.', { model: describeDecider(executor.watch.model, i18n) })
      : executor.newsRule !== undefined
        ? executor.newsRule.category === 'MONITORING_TAG'
          ? t("Opened by the Monitoring Tag rule, on Binance's announcement.")
          : t("Opened by the delisting rule, on Binance's announcement.")
        : executor.forecast !== undefined
          ? t('Opened by the forecast trader, on a TRADE decision.')
          : t('Opened by the app.')
  const nowSec = Math.floor(Date.now() / 1000)
  const pnlPct = reading === null ? null : netUnrealizedPct(reading.entryPrice, reading.price, side)
  const pnlQuote = pnlPct === null ? null : (params.amountQuote * pnlPct) / 100
  const distances = reading === null ? null : distancesOf({ side, entryPrice: reading.entryPrice, price: reading.price, stopPct: params.stopLossPct, targetPct: params.takeProfitPct })
  const left = reading === null || params.timeLimitSec === null ? null : Math.max(0, reading.enteredAt + params.timeLimitSec - nowSec)
  const story = reading === null ? null : (reading.storyAgainst ?? reading.latestStory)
  const against = reading !== null && story !== null && reading.storyAgainst !== null && story.id === reading.storyAgainst.id

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)', maxWidth: 320 }}>
        <span dir="ltr">{executor.symbol}</span> <span style={{ color: side === 'buy' ? 'var(--up)' : 'var(--down)' }}>{side === 'buy' ? t('BUY') : t('SELL')}</span>{' '}
        <span style={smallStyle}>{t('· paper')}</span>
        <div style={smallStyle}>{openedBy}</div>
        {thesis !== null && (
          <div lang="en" dir="auto" style={{ ...smallStyle, marginTop: '0.3rem', fontStyle: 'italic', whiteSpace: 'normal' }} title={thesis}>
            {cut(thesis, EXIT_THESIS_CHARS)}
          </div>
        )}
      </td>
      <td style={cellStyle}>
        {reading === null ? '—' : price(reading.entryPrice)}
        {reading !== null && <div style={smallStyle}>{clock(reading.enteredAt)}</div>}
      </td>
      <td style={cellStyle}>
        {reading === null ? '—' : price(reading.price)}
        {reading !== null && <div style={smallStyle}>{t('close of {time}', { time: clock(reading.priceTime) })}</div>}
      </td>
      <td style={{ ...cellStyle, fontWeight: 600, color: pnlPct === null ? 'var(--text-muted)' : pnlPct >= 0 ? 'var(--up)' : 'var(--down)' }}>
        {pnlPct === null || pnlQuote === null
          ? '—'
          : i18n.language === 'en'
            ? `${pnlQuote >= 0 ? '+' : ''}${formatQuotePrice(pnlQuote, executor.quoteAsset)} (${pct(pnlPct)})`
            : t('{pnl} ({pct})', { pnl: i18n.signedMoney(pnlQuote, executor.quoteAsset), pct: pct(pnlPct) })}
        {reading !== null && reading.move15mPct !== null && <div style={smallStyle}>{t('{move} over fifteen minutes', { move: pct(reading.move15mPct) })}</div>}
      </td>
      <td style={cellStyle}>
        {distances === null ? (
          '—'
        ) : (
          <>
            <div>
              {distances.toStopPct === null
                ? t('no stop')
                : distances.toStopPct <= 0
                  ? t('stop reached')
                  : reading !== null && reading.verdict.stopProgress !== null
                    ? t('stop {gap} away · {share} of the way', { gap: i18n.pctPlain(distances.toStopPct, 2), share: i18n.pctPlain(Math.round(Math.max(0, reading.verdict.stopProgress) * 100), 0) })
                    : t('stop {gap} away', { gap: i18n.pctPlain(distances.toStopPct, 2) })}
            </div>
            <div style={smallStyle}>
              {distances.toTargetPct === null ? t('no target') : distances.toTargetPct <= 0 ? t('target reached') : t('target {gap} away', { gap: i18n.pctPlain(distances.toTargetPct, 2) })}
            </div>
          </>
        )}
      </td>
      <td style={cellStyle}>
        {reading === null ? '—' : t('in trade {time}', { time: describeDuration((nowSec - reading.enteredAt) * 1000, i18n) })}
        {left !== null && <div style={smallStyle}>{left === 0 ? t('its time limit has passed') : t('{time} left', { time: describeDuration(left * 1000, i18n) })}</div>}
      </td>
      <td style={cellStyle}>
        {reading === null ? (
          '—'
        ) : (
          <>
            <Regime regime={reading.regimeAtEntry} /> <span style={smallStyle}>→</span> <Regime regime={reading.regimeNow} />
            <div style={smallStyle}>{t('at entry → now')}</div>
          </>
        )}
      </td>
      <td style={{ ...cellStyle, maxWidth: 260 }}>
        {reading === null ? (
          '—'
        ) : story === null ? (
          <span style={smallStyle}>{t('none naming {coin} this week', { coin: executor.baseAsset })}</span>
        ) : (
          <>
            <div lang="en" dir="auto" style={{ whiteSpace: 'normal' }} title={story.title}>
              {cut(story.title, MAX_TITLE)}
            </div>
            <div style={{ ...smallStyle, color: against ? 'var(--down)' : 'var(--text-muted)' }}>
              {t('{source} · {time} · impact {impact}', { source: story.sourceName, time: clock(story.publishedAt), impact: Math.round(story.impact) })}
              {against ? ` · ${t('AGAINST THE TRADE')}` : ''}
            </div>
          </>
        )}
      </td>
      <td style={cellStyle}>
        {reading !== null ? <ThesisChip verdict={reading.verdict} /> : <span style={smallStyle}>{measured ? t('not entered, or its minutes are not of the last few') : t('measuring…')}</span>}
      </td>
    </tr>
  )
}

/** The app's own open paper trades, each with where it stands and its thesis status. */
export function OwnPaperTradesCard({ executors, readings, measuredAt }: { executors: ExecutorConfig[]; readings: Record<string, ThesisReading>; measuredAt: number | null }): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  const trades = ownOpenPaperTrades(executors)
  const theses = useTradeTheses(trades)
  return (
    <Card title={t("The App's Own Paper Trades")}>
      {trades.length === 0 && (
        <p style={{ color: 'var(--text-secondary)', margin: 0 }}>
          {t("None open. A paper trade the watch opens on a model's call, or a news rule's paper short on Binance's announcement, is listed here with where it stands and its THESIS STATUS. Nothing real is ever opened by either.")}
        </p>
      )}
      {trades.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headerCellStyle}>{t('Trade')}</th>
                <th style={headerCellStyle}>{t('Entry')}</th>
                <th style={headerCellStyle}>{t('Mark')}</th>
                <th style={headerCellStyle}>{t('Unrealized')}</th>
                <th style={headerCellStyle}>{t('Stop / Target')}</th>
                <th style={headerCellStyle}>{t('Time')}</th>
                <th style={headerCellStyle}>{t('Regime')}</th>
                <th style={headerCellStyle}>{t('News')}</th>
                <th style={headerCellStyle}>{t('Thesis Status')}</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((executor) => (
                <OwnPaperTradeRow key={executor.id} executor={executor} reading={readings[executor.id] ?? null} thesis={theses[executor.id] ?? null} measured={measuredAt !== null} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ ...smallStyle, margin: '0.8rem 0 0', whiteSpace: 'normal' }}>
        {t(
          "THESIS STATUS is a reading on the last closed minute, once a minute: VALID; WEAKENING when one of these holds — three quarters of the way to its stop, a story of impact 70 or more against it, Bitcoin's regime turned against it, or 2% against it over fifteen minutes; BROKEN when its stop is hit, or two of them hold. Nothing acts on it: a stop is a stop, and the exit check asks by its own triggers."
        )}
        {measuredAt !== null ? ` ${t('Last measured at {time} UTC.', { time: i18n.language === 'en' ? new Date(measuredAt * 1000).toISOString().slice(11, 19) : i18n.utcTime(measuredAt * 1000) })}` : ''}
      </p>
    </Card>
  )
}
