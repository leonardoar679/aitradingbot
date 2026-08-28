import { useEffect, useRef, useState } from 'react'
import { createChart, LineSeries, type IChartApi, type UTCTimestamp } from 'lightweight-charts'
import { RotateCw, Undo2, ClipboardList, BarChart3 } from 'lucide-react'
import {
  summarizeSegment,
  MIN_ANNUALIZATION_DAYS,
  type BacktestResult,
  type MonthlyBreakdownRow,
  type SegmentSummary
} from './engine'
import { tookNoTrades } from './strategyRanking'
import { DebugLogsModal } from './DebugLogsModal'

export interface ResultsGeneralInfo {
  periodDays: number
  startDate: string
  endDate: string
  exchangeName: string
  symbolLabel: string
  intervalLabel: string
  strategyLabel: string
  splitDate: string | null
}

interface BacktestResultsViewProps {
  result: BacktestResult
  elapsedSec: number
  generalInfo: ResultsGeneralInfo
  logLines: string[]
  onRerun: () => void
  onNewSession: () => void
  onViewCharts: () => void
}

function formatUsd(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatPct(n: number): string {
  return `${n >= 0 ? '' : ''}${n.toFixed(2)}%`
}

function formatRatio(n: number | null): string {
  if (n === null) return 'N/A'
  return Number.isFinite(n) ? n.toFixed(2) : '∞'
}

// Annualized figures are withheld on short samples rather than shown as a huge meaningless
// number — this says which it is and what the run would need to produce a real one.
function formatAnnualized(value: number | null, periodDays: number): string {
  if (value !== null) return formatPct(value)
  return `N/A — needs ${MIN_ANNUALIZATION_DAYS}+ days of data (this run: ${Math.round(periodDays)})`
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '0s'
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const parts: string[] = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0 || h > 0) parts.push(`${m}m`)
  parts.push(`${s}s`)
  return parts.join(' ')
}

function sectionHeaderStyle(): React.CSSProperties {
  return { display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '0 0 0.9rem' }
}

function SectionHeader({ label }: { label: string }): React.JSX.Element {
  return (
    <div style={sectionHeaderStyle()}>
      <span style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>
        {label}
      </span>
      <div style={{ flex: 1, borderBottom: '1px dashed var(--border)' }} />
    </div>
  )
}

function StatRow({ label, value, index }: { label: string; value: string; index: number }): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0.65rem 0.9rem',
        background: index % 2 === 0 ? 'var(--bg-app)' : 'transparent',
        fontSize: '0.85rem'
      }}
    >
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{value}</span>
    </div>
  )
}

type Verdict = 'ok' | 'warning' | 'danger' | 'na'

function verdictColor(verdict: Verdict): string {
  if (verdict === 'ok') return 'var(--up)'
  if (verdict === 'danger') return 'var(--down)'
  if (verdict === 'warning') return '#f0b90b'
  return 'var(--text-muted)'
}

function verdictLabel(verdict: Verdict): string {
  if (verdict === 'ok') return 'Healthy'
  if (verdict === 'danger') return 'Red Flag'
  if (verdict === 'warning') return 'Caution'
  return 'N/A'
}

interface HealthCriterion {
  label: string
  measured: string
  healthyRange: string
  verdict: Verdict
  note?: string
}

function HealthCheckTable({ rows }: { rows: HealthCriterion[] }): React.JSX.Element {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.3fr 0.9fr 1fr 0.9fr',
          padding: '0.5rem 0.9rem',
          fontSize: '0.72rem',
          fontStyle: 'italic',
          color: 'var(--text-secondary)',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <span>Metric</span>
        <span>Measured</span>
        <span>Healthy Range</span>
        <span>Verdict</span>
      </div>
      {rows.map((row, i) => (
        <div key={row.label}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.3fr 0.9fr 1fr 0.9fr',
              alignItems: 'center',
              padding: '0.55rem 0.9rem',
              background: i % 2 === 0 ? 'var(--bg-app)' : 'transparent',
              fontSize: '0.85rem'
            }}
          >
            <span style={{ color: 'var(--text-secondary)' }}>{row.label}</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{row.measured}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>{row.healthyRange}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', color: verdictColor(row.verdict), fontWeight: 700 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: verdictColor(row.verdict), flexShrink: 0 }} />
              {verdictLabel(row.verdict)}
            </span>
          </div>
          {row.note && (
            <div style={{ padding: '0 0.9rem 0.6rem', fontSize: '0.74rem', color: 'var(--text-muted)', background: i % 2 === 0 ? 'var(--bg-app)' : 'transparent' }}>
              {row.note}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0', fontSize: '0.82rem' }}>
      <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{value}</span>
    </div>
  )
}

function monthLabel(month: string): string {
  const [year, m] = month.split('-')
  const date = new Date(Date.UTC(Number(year), Number(m) - 1, 1))
  return date.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function MonthlyBreakdownTable({ rows }: { rows: MonthlyBreakdownRow[] }): React.JSX.Element {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1.3fr 1fr',
          padding: '0.5rem 0.9rem',
          fontSize: '0.72rem',
          fontStyle: 'italic',
          color: 'var(--text-secondary)',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <span>Month</span>
        <span>Trades</span>
        <span>Net Profit</span>
        <span>Return</span>
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto' }}>
        {rows.map((row, i) => (
          <div
            key={row.month}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1.3fr 1fr',
              alignItems: 'center',
              padding: '0.5rem 0.9rem',
              background: i % 2 === 0 ? 'var(--bg-app)' : 'transparent',
              fontSize: '0.82rem'
            }}
          >
            <span style={{ color: 'var(--text-primary)' }}>{monthLabel(row.month)}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{row.trades}</span>
            <span style={{ color: row.netProfit >= 0 ? 'var(--up)' : 'var(--down)', fontWeight: 600 }}>
              {formatUsd(row.netProfit)}
            </span>
            <span style={{ color: row.returnPct >= 0 ? 'var(--up)' : 'var(--down)', fontWeight: 600 }}>
              {formatPct(row.returnPct)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SampleComparisonTable({
  inSample,
  outOfSample
}: {
  inSample: SegmentSummary
  outOfSample: SegmentSummary
}): React.JSX.Element {
  const rows: { label: string; format: (s: SegmentSummary) => string; colorBySign?: boolean }[] = [
    { label: 'Trades', format: (s) => String(s.trades) },
    { label: 'Net Return', format: (s) => formatPct(s.netProfitPct), colorBySign: true },
    { label: 'Win-rate', format: (s) => formatPct(s.winRatePct) },
    { label: 'Max Drawdown', format: (s) => formatPct(s.maxDrawdownPct), colorBySign: true }
  ]

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.2fr 1fr 1fr',
          padding: '0.5rem 0.9rem',
          fontSize: '0.72rem',
          fontStyle: 'italic',
          color: 'var(--text-secondary)',
          borderBottom: '1px solid var(--border)'
        }}
      >
        <span />
        <span>{inSample.label}</span>
        <span>{outOfSample.label}</span>
      </div>
      {rows.map((row, i) => (
        <div
          key={row.label}
          style={{
            display: 'grid',
            gridTemplateColumns: '1.2fr 1fr 1fr',
            alignItems: 'center',
            padding: '0.55rem 0.9rem',
            background: i % 2 === 0 ? 'var(--bg-app)' : 'transparent',
            fontSize: '0.85rem'
          }}
        >
          <span style={{ color: 'var(--text-secondary)' }}>{row.label}</span>
          <span
            style={{
              color: row.colorBySign ? (row.format(inSample).startsWith('-') ? 'var(--down)' : 'var(--up)') : 'var(--text-primary)',
              fontWeight: 600
            }}
          >
            {row.format(inSample)}
          </span>
          <span
            style={{
              color: row.colorBySign ? (row.format(outOfSample).startsWith('-') ? 'var(--down)' : 'var(--up)') : 'var(--text-primary)',
              fontWeight: 600
            }}
          >
            {row.format(outOfSample)}
          </span>
        </div>
      ))}
    </div>
  )
}

function sideButtonStyle(background: string, color: string): React.CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '0.5rem',
    background,
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: '0.8rem',
    color,
    fontSize: '0.88rem',
    fontWeight: 700,
    cursor: 'pointer',
    width: '100%'
  }
}

export function BacktestResultsView({
  result,
  elapsedSec,
  generalInfo,
  logLines,
  onRerun,
  onNewSession,
  onViewCharts
}: BacktestResultsViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [showLogs, setShowLogs] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const chart = createChart(container, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#c7cad1' },
      grid: {
        vertLines: { color: 'rgba(120,120,130,0.15)' },
        horzLines: { color: 'rgba(120,120,130,0.15)' }
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: 'var(--border)' }
    })
    chartRef.current = chart

    const portfolioSeries = chart.addSeries(LineSeries, {
      color: '#7c86ff',
      lineWidth: 2,
      priceLineVisible: false,
      title: 'Portfolio'
    })
    portfolioSeries.setData(result.equityCurve.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))

    const benchmarkSeries = chart.addSeries(LineSeries, {
      color: '#f0b90b',
      lineWidth: 2,
      priceLineVisible: false,
      title: `${generalInfo.symbolLabel} (buy & hold)`
    })
    benchmarkSeries.setData(result.benchmarkCurve.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })))

    chart.timeScale().fitContent()

    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [result, generalInfo.symbolLabel])

  const s = result.stats

  const overallStart = result.equityCurve[0]?.time
  const overallEnd = result.equityCurve[result.equityCurve.length - 1]?.time
  const splitTime = generalInfo.splitDate ? Math.floor(new Date(`${generalInfo.splitDate}T00:00:00Z`).getTime() / 1000) : null
  const showSampleComparison =
    splitTime !== null && overallStart !== undefined && overallEnd !== undefined && splitTime > overallStart && splitTime < overallEnd
  const inSample = showSampleComparison ? summarizeSegment(result.equityCurve, result.trades, overallStart!, splitTime!, 'In-Sample') : null
  const outOfSample = showSampleComparison
    ? summarizeSegment(result.equityCurve, result.trades, splitTime!, overallEnd!, 'Out-of-Sample')
    : null
  const sampleGapPct = inSample && outOfSample ? Math.abs(inSample.netProfitPct - outOfSample.netProfitPct) : null
  const absMaxDrawdownPct = Math.abs(s.maxDrawdownPct)

  const healthRows: HealthCriterion[] = [
    {
      label: 'Total Trades',
      measured: String(s.totalClosedTrades),
      healthyRange: '40 – 150',
      verdict: s.totalClosedTrades < 20 ? 'danger' : s.totalClosedTrades >= 40 && s.totalClosedTrades <= 150 ? 'ok' : 'warning',
      // Zero is not "few". Nineteen trades is a weak sample; none at all means every number on
      // this page is a placeholder, and the flat 0.00% headline above is the absence of a result
      // rather than a calm one.
      note: tookNoTrades(s)
        ? 'This strategy never opened a position on this data, so every figure on this page is a placeholder rather than a measurement.'
        : s.totalClosedTrades < 20
          ? 'Too few trades to draw a reliable conclusion from.'
          : undefined
    },
    {
      label: 'Win Rate',
      measured: formatPct(s.winRatePct),
      healthyRange: '30% – 50%',
      verdict: s.winRatePct > 70 ? 'danger' : s.winRatePct >= 30 && s.winRatePct <= 50 ? 'ok' : 'warning',
      note: s.winRatePct > 70 ? 'Unusually high — a common symptom of look-ahead bias in the backtest.' : undefined
    },
    {
      label: 'Max Drawdown',
      measured: formatPct(s.maxDrawdownPct),
      healthyRange: 'within 20%',
      verdict: absMaxDrawdownPct > 30 ? 'danger' : absMaxDrawdownPct <= 20 ? 'ok' : 'warning'
    },
    {
      label: 'Profit Factor',
      measured: formatRatio(s.profitFactor),
      healthyRange: '1.2 – 2.0',
      verdict:
        s.profitFactor <= 1 ? 'danger' : s.profitFactor > 3 ? 'danger' : s.profitFactor >= 1.2 && s.profitFactor <= 2.0 ? 'ok' : 'warning',
      note:
        s.profitFactor <= 1
          ? 'Not profitable overall — losses meet or exceed gains.'
          : s.profitFactor > 3
            ? 'Unusually high — a common symptom of overfitting.'
            : undefined
    },
    {
      label: 'In-Sample vs OOS Gap',
      measured: sampleGapPct !== null ? formatPct(sampleGapPct) : 'N/A',
      healthyRange: 'within 30%',
      verdict: sampleGapPct === null ? 'na' : sampleGapPct > 50 ? 'danger' : sampleGapPct <= 30 ? 'ok' : 'warning',
      note: sampleGapPct === null ? 'Set an out-of-sample split date above to check this.' : undefined
    }
  ]
  const tooGoodToBeTrue = s.winRatePct > 70 || s.profitFactor > 3 || s.totalNetProfitPct > 300

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '2rem', alignItems: 'start' }}>
      <div>
        <SectionHeader label="Equity Curve" />
        <div ref={containerRef} style={{ width: '100%', height: 340 }} />
        <div style={{ display: 'flex', gap: '1.25rem', marginTop: '0.5rem', marginBottom: '1.5rem' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: '#7c86ff' }} /> Portfolio
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <span style={{ width: 12, height: 12, borderRadius: 2, background: '#f0b90b' }} /> {generalInfo.symbolLabel}
          </span>
        </div>

        <SectionHeader label="Performance" />
        <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
          <StatRow index={0} label="Total Closed Trades" value={String(s.totalClosedTrades)} />
          <StatRow index={1} label="Total Net Profit" value={`${formatUsd(s.totalNetProfit)} (${formatPct(s.totalNetProfitPct)})`} />
          <StatRow index={2} label="Starting → Finishing Balance" value={`${formatUsd(s.startingBalance)} → ${formatUsd(s.finishingBalance)}`} />
          <StatRow index={3} label="Open Trades" value={String(s.openTrades)} />
          <StatRow index={4} label="Total Paid Fees" value={formatUsd(s.totalPaidFees)} />
          <StatRow index={5} label="Max Drawdown" value={formatPct(s.maxDrawdownPct)} />
          <StatRow index={6} label="Annual Return" value={formatAnnualized(s.annualReturnPct, s.periodDays)} />
          <StatRow index={7} label="Expectancy" value={`${formatUsd(s.expectancy)} (${formatPct(s.expectancyPct)})`} />
          <StatRow index={8} label="Avg Win | Avg Loss" value={`${formatUsd(s.avgWin)} | ${formatUsd(s.avgLoss)}`} />
          <StatRow index={9} label="Ratio Avg Win / Avg Loss" value={formatRatio(s.avgWinLossRatio)} />
          <StatRow index={10} label="Profit Factor" value={formatRatio(s.profitFactor)} />
          <StatRow index={11} label="Win-rate" value={formatPct(s.winRatePct)} />
          <StatRow index={12} label="Longs | Shorts" value={`${formatPct(s.longPct)} | ${formatPct(s.shortPct)}`} />
          <StatRow index={13} label="Avg Holding Time" value={formatDuration(s.avgHoldingSec)} />
          <StatRow index={14} label="Winning Trades Avg Holding Time" value={formatDuration(s.winningAvgHoldingSec)} />
          <StatRow index={15} label="Losing Trades Avg Holding Time" value={formatDuration(s.losingAvgHoldingSec)} />
          <StatRow index={16} label="Sharpe Ratio" value={formatRatio(s.sharpeRatio)} />
          <StatRow index={17} label="Calmar Ratio" value={formatRatio(s.calmarRatio)} />
          <StatRow index={18} label="Sortino Ratio" value={formatRatio(s.sortinoRatio)} />
          <StatRow index={19} label="Omega Ratio" value={formatRatio(s.omegaRatio)} />
          <StatRow index={20} label="Winning Streak" value={String(s.winningStreak)} />
          <StatRow index={21} label="Losing Streak" value={String(s.losingStreak)} />
          <StatRow index={22} label="Largest Winning Trade" value={formatUsd(s.largestWinningTrade)} />
          <StatRow index={23} label="Largest Losing Trade" value={formatUsd(s.largestLosingTrade)} />
          <StatRow index={24} label="Total Winning Trades" value={String(s.totalWinningTrades)} />
          <StatRow index={25} label="Total Losing Trades" value={String(s.totalLosingTrades)} />
          <StatRow index={26} label="Losing Months" value={String(s.losingMonthsCount)} />
          <StatRow index={27} label="Max Consecutive Losing Months" value={String(s.maxConsecutiveLosingMonths)} />
        </div>

        <div style={{ marginTop: '1.5rem' }}>
          <SectionHeader label="Health Check" />
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0 0 0.9rem', lineHeight: 1.5 }}>
          Decide what "good" looks like before judging the numbers above. A win rate over 70%, a drawdown under 5%,
          or a return in the hundreds of percent is not a reason to celebrate — it's the classic signature of
          look-ahead bias, the most common beginner mistake in a backtest.
        </p>
        {tooGoodToBeTrue && (
          <div
            style={{
              background: 'rgba(239,83,80,0.12)',
              border: '1px solid rgba(239,83,80,0.4)',
              borderRadius: 'var(--radius-sm)',
              padding: '0.75rem 0.9rem',
              color: 'var(--down)',
              fontSize: '0.8rem',
              marginBottom: '0.9rem',
              lineHeight: 1.5
            }}
          >
            These results look unusually good. Before trusting them, check the strategy code for look-ahead bias
            (using information that wouldn't have been available at the time of the trade) rather than assuming
            the strategy is really this strong.
          </div>
        )}
        <HealthCheckTable rows={healthRows} />
        <p style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '0.6rem', lineHeight: 1.5 }}>
          For this specific strategy, a realistic range is roughly -10% to +40% annual return with a 15%–25% max
          drawdown. Landing in that range means the pipeline is working correctly — that's success at this stage,
          not a disappointing result. Here:{' '}
          {s.annualReturnPct === null
            ? `${Math.round(s.periodDays)} days of data — too short to state an annual return`
            : `${formatPct(s.annualReturnPct)} annual return`}
          , {formatPct(s.maxDrawdownPct)} max drawdown.
        </p>

        {showSampleComparison && inSample && outOfSample && (
          <>
            <div style={{ marginTop: '1.5rem' }}>
              <SectionHeader label="In-Sample vs Out-of-Sample" />
            </div>
            <SampleComparisonTable inSample={inSample} outOfSample={outOfSample} />
            <p style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '0.6rem', lineHeight: 1.5 }}>
              In-sample is {generalInfo.startDate} → {generalInfo.splitDate}, out-of-sample is {generalInfo.splitDate} →{' '}
              {generalInfo.endDate}. A strategy that only worked in one half is a sign the result was luck, not edge —
              a return gap of roughly 30% or more between the two is usually treated as a red flag.
            </p>
          </>
        )}

        <div style={{ marginTop: '1.5rem' }}>
          <SectionHeader label="Monthly Breakdown" />
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.78rem', margin: '0 0 0.9rem', lineHeight: 1.5 }}>
          Two things worth checking in the table below: the longest streak of consecutive losing months (you'd need
          to be able to sit through that in real trading), and how much of the total profit came from just a
          handful of standout months (trend-following naturally works this way — better to know that going in than
          to discover it six months into a losing streak).
        </p>
        <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.9rem' }}>
          <div style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.7rem 0.9rem' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Max Consecutive Losing Months</div>
            <div style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)' }}>{s.maxConsecutiveLosingMonths}</div>
          </div>
          <div style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.7rem 0.9rem' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Profit From Top 3 Months</div>
            <div
              style={{
                fontSize: '1.1rem',
                fontWeight: 700,
                color: s.topThreeMonthsProfitSharePct >= 80 ? 'var(--down)' : 'var(--text-primary)'
              }}
            >
              {formatPct(s.topThreeMonthsProfitSharePct)}
              {s.topThreeMonthsProfitSharePct >= 80 && (
                <span style={{ fontSize: '0.7rem', fontWeight: 600, marginLeft: '0.4rem' }}>concentrated</span>
              )}
            </div>
          </div>
        </div>
        <MonthlyBreakdownTable rows={result.monthlyBreakdown} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        <button onClick={onRerun} style={sideButtonStyle('linear-gradient(135deg, #7c86ff, #6366f1)', '#fff')}>
          <RotateCw size={16} /> Rerun
        </button>
        <button onClick={onNewSession} style={sideButtonStyle('#14b8a6', '#fff')}>
          <Undo2 size={16} /> New session
        </button>
        <button
          onClick={() => setShowLogs(true)}
          style={{ ...sideButtonStyle('var(--bg-app)', 'var(--text-primary)'), border: '1px solid var(--border)' }}
        >
          <ClipboardList size={16} /> Debugging Logs
        </button>
        <button
          onClick={onViewCharts}
          style={{ ...sideButtonStyle('var(--bg-app)', 'var(--text-primary)'), border: '1px solid var(--border)' }}
        >
          <BarChart3 size={16} /> View charts
        </button>

        <div
          style={{
            background: 'rgba(20,184,166,0.12)',
            border: '1px solid rgba(20,184,166,0.35)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.75rem 0.9rem',
            color: '#5eead4',
            fontSize: '0.8rem',
            marginTop: '0.4rem'
          }}
        >
          Successfully executed backtest simulation in: {elapsedSec.toFixed(2)} seconds
        </div>

        <SectionHeader label="General Info" />
        <div style={{ marginTop: '-0.6rem' }}>
          {/* The requested range and the range actually returned can differ a lot, and now in
              BOTH directions -- which is why the two cases are worded differently rather than
              sharing one "days of data" line.

              SHORT of the request is a warning: a symbol listed partway through the range, or an
              exchange that capped the response, means the stats above rest on less than was asked
              for. LONGER is not, and reads alarmingly if phrased the same way: the page
              deliberately fetches extra history ahead of the window so the strategy's indicators
              are warm when the requested period opens, so the surplus is warm-up that the run is
              measured AFTER, not extra period folded into the result. */}
          <InfoRow
            label="Period"
            value={
              s.periodDays < generalInfo.periodDays - 1
                ? `${Math.round(s.periodDays)} days of data (${generalInfo.periodDays} requested)`
                : s.periodDays > generalInfo.periodDays + 1
                  ? `${generalInfo.periodDays} days (${(generalInfo.periodDays / 30).toFixed(1)} months), after ${Math.round(s.periodDays - generalInfo.periodDays)} days of warm-up`
                  : `${generalInfo.periodDays} days (${(generalInfo.periodDays / 30).toFixed(1)} months)`
            }
          />
          {/* The equity curve is flat for this stretch and no trade can happen in it, which
              otherwise reads as "the strategy found nothing". Buy & hold is measured from the end
              of it too, so the two lines start together and the comparison is like-for-like. */}
          <InfoRow
            label="Indicator Warm-Up"
            value={`first ${s.warmupBars} candles — no trades possible, buy & hold measured from there too`}
          />
          <InfoRow label="Starting Date" value={generalInfo.startDate} />
          <InfoRow label="Ending Date" value={generalInfo.endDate} />
          <InfoRow label="Exchange" value={generalInfo.exchangeName} />
        </div>

        <SectionHeader label="Routes" />
        <div style={{ marginTop: '-0.6rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', color: 'var(--text-muted)', padding: '0 0 0.4rem' }}>
            <span>Symbol</span>
            <span>Timeframe</span>
            <span>Strategy</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 600 }}>
            <span>{generalInfo.symbolLabel}</span>
            <span>{generalInfo.intervalLabel}</span>
            <span>{generalInfo.strategyLabel}</span>
          </div>
        </div>

        <p style={{ color: 'var(--text-muted)', fontSize: '0.72rem', marginTop: '0.75rem', lineHeight: 1.5 }}>
          Long-only: entries, exits, and the stop-loss set at entry all come from the {generalInfo.strategyLabel}
          strategy selected above (see the debug log for its exact rules). Cash-settled with no leverage, 0.1% taker
          fee per fill.
        </p>
      </div>

      {showLogs && <DebugLogsModal logLines={logLines} onClose={() => setShowLogs(false)} />}
    </div>
  )
}
