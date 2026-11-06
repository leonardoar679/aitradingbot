import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { PageHeader } from '../components/PageHeader'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { Interpolate, msg, useI18n, type I18n } from '../i18n'
import { describeError } from '../utils/ipcError'
import { numberLocale } from '../../shared/i18n/format'
import type { OpenPosition } from '../../shared/traders/hyperliquid'
import { traderRefOf } from '../../shared/traders/traderRef'
import { CLONE_LINES, type CloneFeature, type CloneResult, type CloneVerdict } from '../../shared/traders/clone'
import { DELAY_LINES } from '../../shared/traders/delay'
import type { OkxPnlPoint } from '../../shared/traders/okx'
import { SKILL_LINES, type SkillResult } from '../../shared/traders/skill'
import type { BitgetCopyCheck, OkxSummary, TraderAnalysis, TraderList, TraderMeta, TraderProgress } from '../../shared/traders/traderAnalysis'
import { FoundTradersCard } from './FoundTradersCard'
import { PaperCopyPanel } from './PaperCopyPanel'
import { durationOf, utcWhen } from './traderText'

// COPY TRADERS (V8 Stages 6-8, 26-27 October 2026; electron/services/traderService.ts). A person pastes a trader -- a
// Hyperliquid address or an explorer's link (VERIFIED: the venue's own fills), an OKX lead trader's code or profile link
// (REPORTED: OKX's positions and profit, the app's fees and funding ESTIMATED beside them) -- or opens a file of trades
// (UNVERIFIABLE). The app keeps the record, rebuilds the round trips, works out what they made after fees and funding,
// and judges the record by three registered tests: is it skill beyond the market and chance (V8-S6-SKILL), could it be
// followed late (V8-S6-DELAY), and can a simple rule of the market's state do what the trader does (V8-S7-CLONE). Since
// Stage 8 a trader can be followed, or their rule run, on paper (PaperCopyPanel.tsx), and the page speaks the person's
// language: what a venue or a file wrote -- an address, a name, a symbol, a venue's or a file's words -- is shown as
// written, and so are the tests' verdicts and the record's labels, the names they are registered and documented under.
// And, on its own button, the read-only Bitget copy-trading check with the person's own key. Nothing here places
// anything.

const shortId = (id: string): string => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id)

/** What a venue, a file or the engine wrote, shown as written. */
function Written({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <bdi lang="en">{children}</bdi>
}

/** A label or a verdict as the tests and the record name it -- VERIFIED, MARKET OR LUCK -- shown as written. */
function Term({ name }: { name: string }): React.JSX.Element {
  return <bdi lang="en">{name}</bdi>
}

/** A multiple of the account: whole above ten, one decimal above a tenth, two significant figures below. */
const timesOf = (i18n: I18n, value: number): string => `${value >= 10 ? i18n.num(value, 0, 0) : value >= 0.1 ? i18n.num(value, 1, 1) : i18n.num(Number(value.toPrecision(2)), 0, 6)}×`

const VERDICT_COLOR: Record<SkillResult['verdict'], string> = { SKILL: 'var(--up)', 'MARKET OR LUCK': 'var(--text-secondary)', 'TOO FEW': 'var(--text-muted)' }
const CLONE_COLOR: Record<CloneVerdict, string> = { REPLICABLE: 'var(--up)', PARTLY: 'var(--text-secondary)', 'NOT REPLICABLE': 'var(--text-secondary)', 'TOO FEW': 'var(--text-muted)' }

const row: React.CSSProperties = { display: 'flex', gap: '1rem', padding: '0.22rem 0', alignItems: 'baseline', flexWrap: 'wrap' }
const label: React.CSSProperties = { fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', flex: '0 0 11rem' }
const value: React.CSSProperties = { fontSize: '0.86rem', flex: '1 1 18rem', minWidth: 0, fontVariantNumeric: 'tabular-nums' }

function Line({ name, children }: { name: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={row}>
      <span style={label}>{name}</span>
      <span style={value}>{children}</span>
    </div>
  )
}

/** Where the record comes from, and how far it can be trusted. */
function RecordLines({ analysis }: { analysis: TraderAnalysis }): React.JSX.Element {
  const { t, date } = useI18n()
  const { record } = analysis
  const span = t('{from} to {to}', { from: record.firstMs === null ? '—' : date(record.firstMs), to: record.lastMs === null ? '—' : date(record.lastMs) })
  if (record.source === 'okx') {
    return (
      <Line name={t("Record@@where a trader's record comes from")}>
        <Interpolate text={t("{count} positions from OKX's public copy-trading record, {reported} (OKX's own prices and profit; OKX gives no fee), {span}", { count: record.records, span })} values={{ reported: <Term name="REPORTED" /> }} />
        {'. '}
        {record.capped ? t('More than the app reads: the oldest are left out.') : t('OKX keeps three months.')}{' '}
        <Interpolate text={t('Fees and funding {estimated} by the app.')} values={{ estimated: <Term name="ESTIMATED" /> }} />
      </Line>
    )
  }
  if (record.source === 'file') {
    const refused = record.fileRefused
    return (
      <>
        <Line name={t("Record@@where a trader's record comes from")}>
          <Interpolate
            text={
              record.fileKind === 'trips'
                ? t('{count} round trips from the file {name}, {label} (nobody can check a file), {span}; times without a zone read as UTC', { count: record.records, span })
                : t('{count} fills from the file {name}, {label} (nobody can check a file), {span}; times without a zone read as UTC', { count: record.records, span })
            }
            values={{ name: <bdi dir="auto">{record.name}</bdi>, label: <Term name="UNVERIFIABLE" /> }}
          />
          {refused !== null && refused.count > 0 ? `; ${t('{count} rows refused', { count: refused.count })}` : ''}
        </Line>
        {refused !== null && refused.reasons.length > 0 && (
          <ul style={{ ...noteStyle, margin: '0 0 0.3rem', paddingInlineStart: '1.1rem' }}>
            {refused.reasons.map((reason) => (
              <li key={reason}>
                <Written>{reason}</Written>
              </li>
            ))}
          </ul>
        )}
      </>
    )
  }
  return (
    <Line name={t("Record@@where a trader's record comes from")}>
      <Interpolate text={t("{count} fills from Hyperliquid, {verified} (the venue's own record), {span}", { count: record.records, span })} values={{ verified: <Term name="VERIFIED" /> }} />
      {record.capped ? `. ${t('Hyperliquid gives only about its most recent 10,000 fills: older ones are not read.')}` : ''}
    </Line>
  )
}

/** A year's cumulative profit as a line, its zero marked. */
function Sparkline({ points }: { points: readonly OkxPnlPoint[] }): React.JSX.Element {
  const { t } = useI18n()
  const width = 240
  const height = 40
  const values = points.map((point) => point.pnl)
  const low = Math.min(0, ...values)
  const high = Math.max(0, ...values)
  const spanX = Math.max(1, points[points.length - 1].timeMs - points[0].timeMs)
  const y = (amount: number): number => (high === low ? height / 2 : height - 2 - ((amount - low) / (high - low)) * (height - 4))
  const path = points.map((point) => `${(((point.timeMs - points[0].timeMs) / spanX) * width).toFixed(1)},${y(point.pnl).toFixed(1)}`).join(' ')
  const last = values[values.length - 1]
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('Profit over the year')} style={{ verticalAlign: 'middle', marginInlineEnd: '0.5rem' }}>
      <line x1={0} x2={width} y1={y(0)} y2={y(0)} stroke="var(--border)" strokeWidth={1} />
      <polyline points={path} fill="none" stroke={last >= 0 ? 'var(--up)' : 'var(--down)'} strokeWidth={1.5} />
    </svg>
  )
}

/** OKX's own figure beside the app's estimate of the same positions, and the trader's year as OKX reports it. */
function OkxView({ okx }: { okx: OkxSummary }): React.JSX.Element {
  const { t, signedMoney, money, pctPlain, date } = useI18n()
  const stats = okx.stats
  const usd = (amount: number, decimals = 2): string => signedMoney(amount, 'USDT', decimals)
  return (
    <>
      <Line name={t("OKX's figure and the app's")}>
        {t("OKX reports {reported} over these {count} positions. The app's estimate of the same from their prices: moved {gross}, fees {fees} at OKX's taker rate each way, funding {funding} at the rates OKX published, net {net}.", {
          reported: usd(okx.reportedPnl),
          count: okx.positions,
          gross: usd(okx.estimate.gross),
          fees: usd(-okx.estimate.fees),
          funding: usd(okx.estimate.funding),
          net: usd(okx.estimate.net)
        })}
        {okx.estimate.fundingUnknown > 0 ? ` ${t('Funding not known for {count} of them.', { count: okx.estimate.fundingUnknown })}` : ''}
        {okx.notPriced > 0 ? ` ${t('{count} positions OKX gave are left out: still open in part, on another kind of instrument, or without a contract value.', { count: okx.notPriced })}` : ''}
      </Line>
      {stats !== null && (
        <Line name={t('The year, as OKX reports it')}>
          {[
            stats.winRatio === null ? t('win ratio not given') : t('win ratio {share}', { share: pctPlain(stats.winRatio * 100, 1) }),
            stats.profitDays !== null && stats.lossDays !== null ? t('{up} days up and {down} down', { up: stats.profitDays, down: stats.lossDays }) : null,
            stats.investAmt !== null ? t('{amount} invested', { amount: money(stats.investAmt, 'USDT', 0) }) : null,
            stats.avgSubPosNotional !== null ? t('an average position of {amount}', { amount: money(stats.avgSubPosNotional, 'USDT', 0) }) : null
          ]
            .filter((part): part is string => part !== null)
            .join(', ')}
        </Line>
      )}
      {okx.series.length > 1 && (
        <Line name={t('Profit over the year')}>
          <Sparkline points={okx.series} />
          {t('{amount} from {from} to {to}, as OKX reports it', { amount: usd(okx.series[okx.series.length - 1].pnl, 0), from: date(okx.series[0].timeMs), to: date(okx.series[okx.series.length - 1].timeMs) })}
        </Line>
      )}
    </>
  )
}

/** A log return as the percentage it is. */
const returnOf = (i18n: I18n, logReturn: number): string => i18n.pct((Math.exp(logReturn) - 1) * 100)

/** The day of the week a weekday feature's threshold rounds to, in the language's own name: 1 January 2024 was a Monday. */
const weekdayOf = (i18n: I18n, threshold: number): string =>
  new Intl.DateTimeFormat(numberLocale(i18n.language), { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2024, 0, 1 + Math.min(6, Math.max(0, Math.round(threshold)))))

/** A condition's feature in words, and its threshold as the feature is read: returns and distances in percent. */
const FEATURE_WORDS: Record<CloneFeature, { name: string; show: (i18n: I18n, threshold: number) => string }> = {
  ret1h: { name: msg("the coin's last hour"), show: returnOf },
  ret4h: { name: msg("the coin's last four hours"), show: returnOf },
  ret24h: { name: msg("the coin's last day"), show: returnOf },
  vol24h: { name: msg("the coin's 15-minute volatility over the day"), show: (i18n, threshold) => i18n.t('{share} a bar', { share: i18n.pctPlain(threshold * 100, 2) }) },
  volRatio: { name: msg("the last four hours' volatility over the day's"), show: (i18n, threshold) => i18n.num(threshold, 2, 2) },
  rangePos24h: { name: msg("where the coin stands in the day's range (0 its low, 1 its high)"), show: (i18n, threshold) => i18n.num(threshold, 2, 2) },
  fromMean24h: { name: msg("the coin's distance from the day's mean"), show: (i18n, threshold) => i18n.pct(threshold * 100) },
  btcRet1h: { name: msg("Bitcoin's last hour"), show: returnOf },
  btcRet24h: { name: msg("Bitcoin's last day"), show: returnOf },
  relRet24h: { name: msg("the coin's day less Bitcoin's"), show: (i18n, threshold) => i18n.pct(threshold * 100) },
  hourUtc: { name: msg('the hour of the day (UTC)'), show: (i18n, threshold) => i18n.num(threshold, 1, 1) },
  weekdayUtc: { name: msg('the day of the week (Monday 0)'), show: (i18n, threshold) => `${i18n.num(threshold, 1, 1)} (${weekdayOf(i18n, threshold)})` }
}

/** A position open now: its coin and side, its value, and the leverage and margin the venue gives for it. */
function openText(i18n: I18n, position: OpenPosition): string {
  const { t, num, money } = i18n
  const value = money(position.positionValue, 'USDT', 0)
  if (position.leverage === null) return position.size > 0 ? t('{coin} long {value}', { coin: position.coin, value }) : t('{coin} short {value}', { coin: position.coin, value })
  // Hyperliquid's margin is cross or isolated; another word it might write is left out.
  const times = `${num(position.leverage.value, 0, 1)}×`
  const leverage = position.leverage.type === 'cross' ? t('{times} cross margin', { times }) : position.leverage.type === 'isolated' ? t('{times} isolated margin', { times }) : times
  return position.size > 0 ? t('{coin} long {value} at {leverage}', { coin: position.coin, value, leverage }) : t('{coin} short {value} at {leverage}', { coin: position.coin, value, leverage })
}

/** A clone's rule in words: its side, each condition, its hold. */
function ruleText(i18n: I18n, rule: NonNullable<CloneResult['rule']>): string {
  const { t, list } = i18n
  const conditions = list(
    rule.conditions
      .map((condition) => {
        const words = { feature: t(FEATURE_WORDS[condition.feature].name), threshold: FEATURE_WORDS[condition.feature].show(i18n, condition.threshold) }
        return condition.op === '<=' ? t('{feature} is at or below {threshold}', words) : t('{feature} is at or above {threshold}', words)
      })
  )
  const hold = durationOf(i18n, rule.holdBars * CLONE_LINES.barMinutes)
  return rule.side === 'long' ? t('long where {conditions}, held {hold}', { conditions, hold }) : t('short where {conditions}, held {hold}', { conditions, hold })
}

/** Why V8-S7-CLONE did not call the clone REPLICABLE, in the person's language, from the result's own figures; a reason
 * the page cannot read again is shown as the engine wrote it. */
function cloneReasonsOf(i18n: I18n, clone: CloneResult): { text: string; written: boolean }[] {
  const { t, num } = i18n
  const said = (text: string): { text: string; written: boolean } => ({ text, written: false })
  if (clone.verdict === 'TOO FEW') {
    if (clone.rule === null) return [said(t('no side has {min} entries in the first two thirds to fit a rule on', { min: CLONE_LINES.minSideEntries }))]
    // The count of the rule's side in the last third is in the reason alone.
    const counted = /^(\d+) (long|short) entries in the last third/.exec(clone.reasons[0] ?? '')
    if (counted === null) return clone.reasons.map((text) => ({ text, written: true }))
    const words = { count: Number(counted[1]), min: CLONE_LINES.minTestEntries }
    return [said(counted[2] === 'long' ? t('{count} long entries in the last third, under {min}', words) : t('{count} short entries in the last third, under {min}', words))]
  }
  const out: { text: string; written: boolean }[] = []
  const auc = clone.outOfTime?.interval ?? null
  if (auc === null) out.push(said(t("the last third's AUC has no interval")))
  else if (!(auc.low > CLONE_LINES.minAucLow)) out.push(said(t("the last third's AUC reaches {line} or below", { line: num(CLONE_LINES.minAucLow, 1, 1) })))
  const trades = clone.trades
  if (trades === null || trades.n < CLONE_LINES.minTrades) out.push(said(t('the clone made {count} trades in the last third, under {min}', { count: trades?.n ?? 0, min: CLONE_LINES.minTrades })))
  else if (trades.interval === null) out.push(said(t("the clone's mean net has no interval")))
  else if (!(trades.interval.low > 0)) out.push(said(t("the clone's mean net reaches 0 or below")))
  return out
}

/** V8-S7-CLONE's result. */
export function CloneView({ clone }: { clone: CloneResult | null }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num, pct, pctPlain } = i18n
  if (clone === null) return <p style={noteStyle}>{t('The clone could not be fitted: see what could not be read, below.')}</p>
  const rule = clone.rule
  const reasons = cloneReasonsOf(i18n, clone)
  return (
    <div>
      <p style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: CLONE_COLOR[clone.verdict] }}>
        <Written>{clone.verdict}</Written>
      </p>
      {reasons.length > 0 && (
        <ul style={{ ...noteStyle, margin: '0.3rem 0 0', paddingInlineStart: '1.1rem' }}>
          {reasons.map((reason) => (
            <li key={reason.text}>{reason.written ? <Written>{reason.text}</Written> : reason.text}</li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: '0.5rem' }}>
        {rule !== null && <Line name={t('The rule')}>{ruleText(i18n, rule)}</Line>}
        {clone.training !== null && (
          <Line name={t('Fitted on')}>
            {t('the first two thirds: {entries} entries against {moved} moved moments; it holds at {held} of the entries and {movedHeld} of the moved moments', {
              entries: clone.training.positives,
              moved: clone.training.negatives,
              held: pctPlain(clone.training.tpr * 100, 0),
              movedHeld: pctPlain(clone.training.fpr * 100, 0)
            })}
          </Line>
        )}
        {clone.outOfTime !== null && (
          <Line name={t('The last third')}>
            {t('{entries} entries against {moved} moved moments: it holds at {held} and {movedHeld}, an AUC of {auc}', {
              entries: clone.outOfTime.positives,
              moved: clone.outOfTime.negatives,
              held: pctPlain(clone.outOfTime.tpr * 100, 0),
              movedHeld: pctPlain(clone.outOfTime.fpr * 100, 0),
              auc: num(clone.outOfTime.auc, 3, 3)
            })}
            {clone.outOfTime.interval !== null ? ` ${t('(95%: {low} to {high}, by day)', { low: num(clone.outOfTime.interval.low, 3, 3), high: num(clone.outOfTime.interval.high, 3, 3) })}` : ''}
          </Line>
        )}
        {clone.trades !== null && (
          <Line name={t('Traded on its own')}>
            <Interpolate text={t("{count} trades in the last third on {coins}, a mean net of {net} a trade after the taker fee, the larger of 2 bps and the book's impact each way, and funding", { count: clone.trades.n, net: clone.trades.meanNetPct === null ? '—' : pct(clone.trades.meanNetPct, 3) })} values={{ coins: <bdi dir="ltr">{clone.trades.coins.join(', ')}</bdi> }} />
            {clone.trades.interval !== null ? ` ${t('(95%: {low} to {high}, by day)', { low: pct(clone.trades.interval.low, 3), high: pct(clone.trades.interval.high, 3) })}` : ''}
          </Line>
        )}
        <Line name={t('Read on')}>
          {t('{count} entries with every feature, {fit} to fit and {test} to test', { count: clone.entries, fit: clone.trainEntries, test: clone.testEntries })}
          {clone.withoutFeatures > 0 ? `; ${t("{count} without a venue's bars the day before them, left out", { count: clone.withoutFeatures })}` : ''}
        </Line>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        <Interpolate
          text={t("{replicable} needs the last third's AUC above {auc} at its interval's lower end, and at least {trades} trades of the rule on its own there whose mean net is above 0 at its lower end; {partly}, one of the two. The rule is chosen freely among at most 21,600 a side on the first two thirds: only the last third judges it. A clone runs on paper only.", { auc: num(CLONE_LINES.minAucLow, 1, 1), trades: CLONE_LINES.minTrades })}
          values={{ replicable: <Term name="REPLICABLE" />, partly: <Term name="PARTLY" /> }}
        />
      </p>
    </div>
  )
}

/** What the record says: the figures of the completed round trips, and what is open now. */
export function FiguresView({ analysis }: { analysis: TraderAnalysis }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num, pctPlain, signedMoney, money } = i18n
  const usd = (amount: number, decimals = 2): string => signedMoney(amount, 'USDT', decimals)
  const { figures } = analysis
  const mapped = new Map(analysis.mapping.map((entry) => [entry.coin, entry]))
  const hidden = analysis.okx?.open?.hidden ?? 0
  const unrealized = analysis.okx !== null && analysis.okx.open !== null ? analysis.okx.open.unrealized : figures.open.unrealized
  return (
    <div>
      <RecordLines analysis={analysis} />
      {analysis.okx !== null && <OkxView okx={analysis.okx} />}
      <Line name={t('Round trips')}>
        {figures.span !== null
          ? t('{count} completed over {days} days, on {trading} trading days', { count: figures.trips, days: num(figures.span.calendarDays, 1, 1), trading: figures.span.tradingDays })
          : t('{count} completed', { count: figures.trips })}
        {figures.partial > 0 ? `; ${t('{count} left out (opened before the record, or with fills the record lacks)', { count: figures.partial })}` : ''}
        {figures.spotFills > 0 ? `; ${t('{count} spot fills apart', { count: figures.spotFills })}` : ''}
      </Line>
      <Line name={t('Net after fees and funding')}>
        {t('{net} (closed {closed}, fees {fees}, funding {funding})', { net: usd(figures.money.net), closed: usd(figures.money.realized), fees: usd(-figures.money.fees), funding: usd(figures.money.funding) })}
        {figures.money.rebates > 0 ? `; ${t('maker rebates earned {amount}, counted in the fees', { amount: money(figures.money.rebates, 'USDT') })}` : ''}
      </Line>
      <Line name={t('Win rate')}>{figures.winRate === null ? '—' : t('{share} of trips made money after fees and funding', { share: pctPlain(figures.winRate * 100, 1) })}</Line>
      <Line name={t('Largest fall')}>
        {figures.drawdown.pctOfAccount !== null
          ? t("{amount} from a high of the trips' cumulative net, {share} of the account then (money in and out moves no figure here)", { amount: money(figures.drawdown.usdc, 'USDT'), share: pctPlain(figures.drawdown.pctOfAccount, 1) })
          : t("{amount} from a high of the trips' cumulative net (money in and out moves no figure here)", { amount: money(figures.drawdown.usdc, 'USDT') })}
      </Line>
      <Line name={t('Holding time')}>
        {figures.holdMin === null ? '—' : t('median {median}; one in ten under {p10}, one in ten over {p90}', { median: durationOf(i18n, figures.holdMin.median), p10: durationOf(i18n, figures.holdMin.p10), p90: durationOf(i18n, figures.holdMin.p90) })}
      </Line>
      <Line name={t('Stake and leverage')}>
        {figures.stake === null ? '—' : t('median {amount} at entry', { amount: money(figures.stake.medianUsdc, 'USDT', 0) })}
        {'; '}
        {figures.leverage !== null
          ? t("{median} the account's value at the median, {max} at most ({count} trips)", { median: timesOf(i18n, figures.leverage.median), max: timesOf(i18n, figures.leverage.max), count: figures.leverage.trips })
          : figures.reportedLeverage !== null
            ? t('leverage as the venue reports it {median} at the median, {max} at most ({count} trips)', { median: timesOf(i18n, figures.reportedLeverage.median), max: timesOf(i18n, figures.reportedLeverage.max), count: figures.reportedLeverage.trips })
            : t('leverage not known: no account history')}
      </Line>
      <Line name={t('Money in and out')}>{t("deposits {deposits}, withdrawals {withdrawals} over the trips' span", { deposits: money(figures.ledger.deposits, 'USDT'), withdrawals: money(figures.ledger.withdrawals, 'USDT') })}</Line>
      {(figures.open.positions.length > 0 || hidden > 0) && (
        <Line name={t('Open now')}>
          {[...figures.open.positions.map((position) => openText(i18n, position)), ...(hidden > 0 ? [t('{count} whose coin and size the trader hides', { count: hidden })] : [])].join('; ')}
          {'; '}
          {t('unrealized {amount}', { amount: usd(unrealized) })}
        </Line>
      )}
      <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {[t('Coin'), t('Trips'), t('Net'), t('Perpetual it is read on')].map((name) => (
                <th key={name} style={headCellStyle}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {figures.coins.map((coin) => {
              const venue = mapped.get(coin.coin)
              return (
                <tr key={coin.coin}>
                  <td style={{ ...cellStyle, fontWeight: 600 }}>
                    <bdi dir="ltr">{coin.coin}</bdi>
                  </td>
                  <td style={cellStyle}>{num(coin.trips, 0, 0)}</td>
                  <td style={cellStyle}>{usd(coin.net)}</td>
                  <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>
                    {venue === undefined ? (
                      t('none found: its trips are without bars in the tests')
                    ) : (
                      <bdi dir="ltr">
                        {venue.venue === 'binance' ? 'Binance' : 'Bitget'} {venue.symbol}
                      </bdi>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Why V8-S6-SKILL did not call it SKILL, in the person's language, from the result's own figures. */
function skillReasonsOf(i18n: I18n, skill: SkillResult): string[] {
  const { t, num, pctPlain } = i18n
  const out: string[] = []
  const alpha = pctPlain(SKILL_LINES.alpha * 100, 0)
  if (skill.verdict === 'TOO FEW') {
    if (skill.trips < SKILL_LINES.minTrips) out.push(t('{count} completed round trips, under {min}', { count: skill.trips, min: SKILL_LINES.minTrips }))
    if (skill.tradingDays < SKILL_LINES.minTradingDays) out.push(t('{count} trading days, under {min}', { count: skill.tradingDays, min: SKILL_LINES.minTradingDays }))
    if (skill.spanDays < SKILL_LINES.minSpanDays) out.push(t('{days} calendar days, under {min}', { days: num(skill.spanDays, 1, 1), min: SKILL_LINES.minSpanDays }))
    return out
  }
  if (skill.verdict === 'SKILL') return out
  if (skill.pShift === null) out.push(t('the shifted schedule could not be measured on the bars'))
  else if (skill.pShift > SKILL_LINES.alpha) out.push(t('the shifted schedule does as well {share} of the time, over {alpha}', { share: pctPlain(skill.pShift * 100, 2), alpha }))
  if (skill.pFlip !== null && skill.pFlip > SKILL_LINES.alpha) out.push(t('sides by a coin toss do as well {share} of the time, over {alpha}', { share: pctPlain(skill.pFlip * 100, 2), alpha }))
  if (skill.interval === null) out.push(t('the edge has no interval'))
  else if (!(skill.interval.low > 0)) out.push(t("the edge's 95% interval reaches 0 or below"))
  if (skill.halvesPct === null || !(skill.halvesPct[0] > 0 && skill.halvesPct[1] > 0)) out.push(t('the first half and the second half are not both positive'))
  return out
}

/** V8-S6-SKILL's result. */
export function SkillView({ skill, analysed, medianHoldMin }: { skill: SkillResult | null; analysed: number; medianHoldMin: number | null }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num, pct, pctPlain } = i18n
  if (skill === null) return <p style={noteStyle}>{t('The test could not be run: see what could not be read, below.')}</p>
  const reasons = skillReasonsOf(i18n, skill)
  return (
    <div>
      <p style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: VERDICT_COLOR[skill.verdict] }}>
        <Written>{skill.verdict}</Written>
      </p>
      {reasons.length > 0 && (
        <ul style={{ ...noteStyle, margin: '0.3rem 0 0', paddingInlineStart: '1.1rem' }}>
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: '0.5rem' }}>
        <Line name={t('Edge per trip')}>
          {t("{edge} at 1×, less the market's drift", { edge: skill.edgePct === null ? '—' : pct(skill.edgePct, 3) })}
          {skill.interval !== null ? ` ${t('(95%: {low} to {high}, by trading day)', { low: pct(skill.interval.low, 3), high: pct(skill.interval.high, 3) })}` : ''}
        </Line>
        <Line name={t('First half, second half')}>{skill.halvesPct === null ? '—' : `${pct(skill.halvesPct[0], 3)}, ${pct(skill.halvesPct[1], 3)}`}</Line>
        <Line name={t('Shifted schedule')}>{skill.pShift === null ? t('not asked') : t('does as well {share} of the time ({draws} draws)', { share: pctPlain(skill.pShift * 100, 2), draws: num(skill.draws, 0, 0) })}</Line>
        <Line name={t('Sides by a coin toss')}>{skill.pFlip === null ? t('not asked') : t('do as well {share} of the time ({draws} draws)', { share: pctPlain(skill.pFlip * 100, 2), draws: num(skill.draws, 0, 0) })}</Line>
        <Line name={t('Read on')}>
          {t('{count} trips on {days} trading days over {span} days', { count: skill.trips, days: skill.tradingDays, span: num(skill.spanDays, 1, 1) })}
          {skill.withoutBars > 0 ? `; ${t("{count} without a venue's bars at their times, left out", { count: skill.withoutBars })}` : ''}
          {skill.betaOfOne > 0 ? `; ${t('{count} with too little history for a beta, given 1', { count: skill.betaOfOne })}` : ''}
        </Line>
      </div>
      {medianHoldMin !== null && medianHoldMin < SKILL_LINES.nullBarMinutes && (
        <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
          {t('Half of these trips were held under {minutes} minutes, the bars the shifted schedule is measured on: that null sees little of them, and the test can say little either way.', { minutes: SKILL_LINES.nullBarMinutes })}
        </p>
      )}
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        <Interpolate
          text={t("{skill} needs both chances at {alpha} or less, the edge's interval above 0 and both halves positive; under {trips} trips, {days} trading days or {span} days the record is {tooFew}. A verdict reads one trader's own record: {count} traders have been analysed here, and at 1% about one in a hundred would pass by chance alone. A past record is a screen, not a promise.", {
            alpha: pctPlain(SKILL_LINES.alpha * 100, 0),
            trips: SKILL_LINES.minTrips,
            days: SKILL_LINES.minTradingDays,
            span: SKILL_LINES.minSpanDays,
            count: analysed
          })}
          values={{ skill: <Term name="SKILL" />, tooFew: <Term name="TOO FEW" /> }}
        />
      </p>
    </div>
  )
}

/** V8-S6-DELAY's rows. */
export function DelayView({ analysis }: { analysis: TraderAnalysis }): React.JSX.Element {
  const { t, num, pct, money } = useI18n()
  const delay = analysis.delay
  if (delay === null) return <p style={noteStyle}>{t('The test could not be run: see what could not be read, below.')}</p>
  if (delay.trips === 0) return <p style={noteStyle}>{t("No completed trip in the last {days} days on a coin a venue's perpetual covers: nothing to copy late.", { days: DELAY_LINES.lookbackDays })}</p>
  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {[t('Copied late by'), t('Costs'), t('Trips'), t('Mean net per trip'), t('95% interval'), t('Above 0')].map((name) => (
                <th key={name} style={headCellStyle}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {delay.rows.map((entry) => (
              <tr key={`${entry.delayMin}:${entry.costMultiplier}`}>
                <td style={cellStyle}>{t('{minutes} min', { minutes: entry.delayMin })}</td>
                <td style={cellStyle}>{entry.costMultiplier === 1 ? t('fees and impact') : t('twice them')}</td>
                <td style={cellStyle}>
                  {num(entry.n, 0, 0)}
                  {entry.missing > 0 ? ` ${t('({count} without bars)', { count: entry.missing })}` : ''}
                </td>
                <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{entry.meanNetPct === null ? '—' : pct(entry.meanNetPct, 3)}</td>
                <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{entry.interval === null ? '—' : t('{low} to {high}', { low: pct(entry.interval.low, 3), high: pct(entry.interval.high, 3) })}</td>
                <td style={{ ...cellStyle, color: entry.aboveZero ? 'var(--up)' : 'var(--text-secondary)' }}>{entry.aboveZero ? t('yes') : t('no')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        {t("The last {days} days' trips, {count} of them, copied as a follower would: in and out at the next minute's open of the venue's perpetual, charged the taker fee and the larger of 2 bps and the book's impact at {stake} each way, and the funding the copy's hold crossed.", { days: DELAY_LINES.lookbackDays, count: delay.trips, stake: money(DELAY_LINES.stakeQuote, 'USDT', 0) })}
        {delay.noVenue > 0 ? ` ${t("{count} on coins no venue's perpetual covers, or whose minutes could not be read, are left out.", { count: delay.noVenue })}` : ''}
        {delay.impactAssumed.length > 0 ? (
          <>
            {' '}
            <Interpolate text={t('No book was read for {coins}: 2 bps charged.')} values={{ coins: <bdi dir="ltr">{delay.impactAssumed.join(', ')}</bdi> }} />
          </>
        ) : null}
        {delay.fundingAssumed > 0 ? ` ${t("{count} trips' funding assumed at 0.01% against them each eight hours, none published.", { count: delay.fundingAssumed })}` : ''}{' '}
        {t('A trader is called followable only at a delay a follow has measured live: see On paper. Rows at 0 and 30 seconds need one-second bars no venue gives for its perpetuals.')}
      </p>
    </div>
  )
}

/** The read-only Bitget copy-trading check, on its button. */
function BitgetCheck(): React.JSX.Element {
  const [check, setCheck] = useState<BitgetCopyCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const ask = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      setCheck(await window.api.traders.bitgetCheck())
    } catch (error) {
      setProblem(describeError(error))
    } finally {
      setBusy(false)
    }
  }
  return <BitgetCheckView check={check} busy={busy} problem={problem} onAsk={() => void ask()} />
}

/** The check's card: its button, and what Bitget answered. */
export function BitgetCheckView({ check, busy, problem, onAsk }: { check: BitgetCopyCheck | null; busy: boolean; problem: string | null; onAsk: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const read = check?.followerRead ?? null
  return (
    <Card title={t('Your Bitget copy trading')}>
      <p style={{ ...noteStyle, marginTop: 0 }}>
        {t("Bitget publishes no lead trader's trades without a key. With the key on Connections, this asks Bitget three things, each a read and only when you press it: the account's mode, whether the key may read copy trading, and the traders it copies. Nothing is subscribed, changed or placed.")}
      </p>
      <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={onAsk}>
        {busy ? t('Asking Bitget…') : t('Check my Bitget copy trading (read-only)')}
      </button>
      {problem !== null && (
        <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.4rem' }}>
          <Written>{problem}</Written>
        </p>
      )}
      {check !== null && !check.configured && <p style={{ ...noteStyle, marginTop: '0.5rem' }}>{t('No Bitget key is set on Connections: nothing was asked.')}</p>}
      {check !== null && check.configured && (
        <div style={{ marginTop: '0.5rem' }}>
          <Line name={t('Account mode')}>
            {check.accountMode === 'uta' ? t('Unified Trading Account') : check.accountMode === 'classic' ? t('Classic@@a Bitget account mode') : check.accountMode === 'unknown' ? t('not known') : t('not read')}
            {check.modeProblem !== null ? (
              <>
                {' — '}
                <Written>{check.modeProblem}</Written>
              </>
            ) : null}
          </Line>
          <Line name={t('Copy trading read')}>
            {read === null ? (
              '—'
            ) : read.ok ? (
              <Interpolate text={t('allowed ({endpoint})')} values={{ endpoint: <code>{read.endpoint}</code> }} />
            ) : (
              <>
                {t('refused@@a read Bitget refused')}
                {read.code !== null ? ` (${read.code})` : ''}: <Written>{read.message}</Written>
              </>
            )}
          </Line>
          {read?.ok === true && (
            <Line name={t('Traders copied')}>
              {read.traders.length === 0 ? t('none') : <bdi dir="auto">{read.traders.map((trader) => (trader.name === null ? trader.id : `${trader.name} (${trader.id})`)).join(', ')}</bdi>}
            </Line>
          )}
        </div>
      )}
    </Card>
  )
}

/** What a paste names, under the box: the trader it reads, or why it is refused. */
export function PasteNote({ parsed }: { parsed: ReturnType<typeof traderRefOf> }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <p style={{ ...noteStyle, marginTop: '0.4rem', color: parsed.ok ? 'var(--text-secondary)' : 'var(--down)' }}>
      {parsed.ok ? <Interpolate text={parsed.ref.venue === 'hyperliquid' ? t('A Hyperliquid address: {id}') : t('An OKX lead trader: {id}')} values={{ id: <bdi dir="ltr">{parsed.ref.id}</bdi> }} /> : t(parsed.reason)}
    </p>
  )
}

/** A trader's analysis: the record, the three tests, the paper panel, and what could not be read. */
export function TraderCards({ meta, analysis, analysed }: { meta: TraderMeta; analysis: TraderAnalysis; analysed: number }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <>
      <Card
        title={
          <Interpolate
            text={t('What the record says: {name}')}
            values={{
              name: (
                <bdi dir={meta.source === 'file' ? 'auto' : 'ltr'} style={{ textTransform: 'none' }}>
                  {meta.source === 'file' ? (meta.name ?? '—') : shortId(meta.ref.id)}
                </bdi>
              )
            }}
          />
        }
      >
        <FiguresView analysis={analysis} />
      </Card>
      <Card title={t('Is it skill?')}>
        <SkillView skill={analysis.skill} analysed={analysed} medianHoldMin={analysis.figures.holdMin?.median ?? null} />
      </Card>
      <Card title={t('Could it be followed?')}>
        <DelayView analysis={analysis} />
      </Card>
      <Card title={t('Can a rule do it?')}>
        <CloneView clone={analysis.clone} />
      </Card>
      <ErrorBoundary label={msg('Following on paper')}>
        <PaperCopyPanel meta={meta} analysis={analysis} />
      </ErrorBoundary>
      {analysis.problems.length > 0 && (
        <Card title={t('What could not be read')}>
          <ul style={{ ...noteStyle, margin: 0, paddingInlineStart: '1.1rem' }}>
            {analysis.problems.map((entry) => (
              <li key={entry}>
                <Written>{entry}</Written>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}

/** The traders on file, the one open lit; a row opens its analysis, its button reads it again. */
export function TradersOnFile({ list, open, busy, onOpen, onAgain }: { list: TraderList; open: string | null; busy: boolean; onOpen: (key: string) => void; onAgain: (meta: TraderMeta) => void }): React.JSX.Element {
  const i18n = useI18n()
  const { t, num, signedMoney } = i18n
  const unitOf = (meta: Pick<TraderMeta, 'source' | 'fileKind' | 'records'>): string =>
    meta.source === 'okx' ? t('{count} positions', { count: meta.records }) : meta.source === 'file' && meta.fileKind === 'trips' ? t('{count} round trips', { count: meta.records }) : t('{count} fills', { count: meta.records })
  return (
    <Card title={t('Traders on file')}>
      {list.traders.length === 0 ? (
        <p style={noteStyle}>{t('None yet.')}</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[t('Trader'), t("Record@@where a trader's record comes from"), t('Read@@when a trader was read'), t('Trips'), t('Net'), t("Skill@@the skill test's verdict"), t("Clone@@the clone test's verdict"), ''].map((name, k) => (
                  <th key={`${k}:${name}`} style={headCellStyle}>
                    {name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.traders.map((entry) => (
                <tr key={entry.meta.ref.key} onClick={() => onOpen(entry.meta.ref.key)} style={{ cursor: 'pointer', background: open === entry.meta.ref.key ? 'var(--bg-app)' : undefined }}>
                  <td dir="ltr" style={{ ...cellStyle, fontWeight: 600 }}>
                    <bdi dir="auto">{entry.meta.source === 'file' ? entry.meta.name : shortId(entry.meta.ref.id)}</bdi>
                  </td>
                  <td style={cellStyle}>
                    {unitOf(entry.meta)}, <Written>{entry.meta.label}</Written>
                  </td>
                  <td style={cellStyle}>{utcWhen(i18n, entry.meta.importedAt * 1000)}</td>
                  <td style={cellStyle}>{entry.latest === null ? '—' : num(entry.latest.figures.trips, 0, 0)}</td>
                  <td style={cellStyle}>{entry.latest === null ? '—' : signedMoney(entry.latest.figures.money.net, 'USDT')}</td>
                  <td style={{ ...cellStyle, color: entry.latest?.skill ? VERDICT_COLOR[entry.latest.skill.verdict] : 'var(--text-muted)' }}>{entry.latest?.skill ? <Written>{entry.latest.skill.verdict}</Written> : t('not analysed')}</td>
                  <td style={{ ...cellStyle, color: entry.latest?.clone ? CLONE_COLOR[entry.latest.clone.verdict] : 'var(--text-muted)' }}>{entry.latest?.clone ? <Written>{entry.latest.clone.verdict}</Written> : '—'}</td>
                  <td style={cellStyle}>
                    <button
                      type="button"
                      style={buttonStyle('secondary', busy)}
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation()
                        onAgain(entry.meta)
                      }}
                    >
                      {entry.meta.source === 'file' ? t('Analyse again') : t('Read again')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>{t('{count} traders have been analysed here.', { count: list.analysed })}</p>
    </Card>
  )
}

export function CopyTradersPage({ handoff = null, onHandoffTaken }: { handoff?: string | null; onHandoffTaken?: () => void } = {}): React.JSX.Element {
  const { t } = useI18n()
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [list, setList] = useState<TraderList>({ traders: [], analysed: 0 })
  const [open, setOpen] = useState<string | null>(null)
  const [progress, setProgress] = useState<TraderProgress | null>(null)
  const parsed = useMemo(() => (paste.trim() === '' ? null : traderRefOf(paste)), [paste])

  const refresh = async (): Promise<void> => {
    setList(await window.api.traders.list())
  }
  useEffect(() => {
    void refresh().catch(() => undefined)
    return window.api.traders.onProgress((step) => setProgress(step))
  }, [])

  const selected = list.traders.find((entry) => entry.meta.ref.key === open) ?? null

  /** Keeps what `fetch` brings and analyses it: a pasted trader read from its venue, a file chosen in the main process's
   * dialog, or a trader on file analysed again. */
  const run = async (fetch: () => Promise<TraderMeta | { refused: string } | { canceled: true }>): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const kept = await fetch()
      if ('canceled' in kept) return
      if ('refused' in kept) {
        setProblem(kept.refused)
        return
      }
      setOpen(kept.ref.key)
      await window.api.traders.analyze(kept.ref.key)
      await refresh()
      setPaste('')
    } catch (error) {
      setProblem(describeError(error))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }
  const read = (raw: string): Promise<void> => run(() => window.api.traders.import(raw))
  // A trader pasted on Home (V8 Stage 10): shown in the box -- with why, where it is not one -- and read as one pasted
  // here, once.
  useEffect(() => {
    if (handoff === null) return
    onHandoffTaken?.()
    setPaste(handoff)
    if (traderRefOf(handoff).ok) void read(handoff)
    // Taken once, as it comes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff])
  const readFile = (): Promise<void> => run(() => window.api.traders.importFile())
  /** A venue's trader is read from it again; a file's is analysed again, its file not opened twice. */
  const again = (meta: TraderMeta): Promise<void> => (meta.source === 'file' ? run(async () => meta) : read(meta.ref.id))

  return (
    <>
      <PageHeader title={t('Copy Traders')} subtitle={t('Paste a trader or open a file of trades: the app reads the record, works out what it made after fees and funding, and tests whether it is skill, whether it could be followed late, and whether a simple rule can do it')} />
      <Card title={t('Read a trader')}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input value={paste} onChange={(change) => setPaste(change.target.value)} placeholder={t("0x…, a Hyperliquid explorer link, or an OKX lead trader's code or link")} style={{ ...inputStyle(), flex: '1 1 26rem' }} aria-label={t('Trader')} dir="ltr" />
          <button type="button" style={buttonStyle('primary', busy || parsed === null || !parsed.ok)} disabled={busy || parsed === null || !parsed.ok} onClick={() => void read(paste)}>
            {busy ? t('Reading…') : t('Read and analyse')}
          </button>
          <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={() => void readFile()}>
            {t('Open a file of trades…')}
          </button>
        </div>
        {parsed !== null && <PasteNote parsed={parsed} />}
        {busy && progress !== null && (
          <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
            <Written>{progress.step}…</Written>
          </p>
        )}
        {problem !== null && (
          <p style={{ ...noteStyle, marginTop: '0.4rem', color: 'var(--down)' }}>
            <Written>{problem}</Written>
          </p>
        )}
        <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
          <Interpolate
            text={t("A paste is read as text and never opened. A Hyperliquid address's fills, funding, deposits and withdrawals and its open positions are read from Hyperliquid's public API, without a key ({verified}); an OKX lead trader's last three months of positions, those open now and the year's profit from OKX's ({reported}, the app's fees and funding {estimated} beside OKX's figure); a file of trades -- CSV or JSON, at most 5 MB, fills or round trips -- is opened through this app's own window and read as it is ({unverifiable}). The perpetual bars, funding and books the tests need are read from Binance, or Bitget where Binance lists none. A record of years on several coins takes ten minutes or so, its steps shown as it goes.")}
            values={{ verified: <Term name="VERIFIED" />, reported: <Term name="REPORTED" />, estimated: <Term name="ESTIMATED" />, unverifiable: <Term name="UNVERIFIABLE" /> }}
          />
        </p>
      </Card>
      {/* The traders the app found (V9 Stage 3): one opened is read from the list again, since it was analysed apart. */}
      <FoundTradersCard onOpen={(key) => void refresh().then(() => setOpen(key), () => undefined)} />
      {selected !== null && selected.latest !== null && <TraderCards meta={selected.meta} analysis={selected.latest} analysed={list.analysed} />}
      <TradersOnFile list={list} open={open} busy={busy} onOpen={setOpen} onAgain={(meta) => void again(meta)} />
      <BitgetCheck />
    </>
  )
}
