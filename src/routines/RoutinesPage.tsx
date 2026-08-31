import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Play, Plus, Repeat } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { EquityCurveChart } from '../components/EquityCurveChart'
import { useRoutineReports } from './routineStore'
import { runRoutineNow } from './RoutineScheduler'
import { SCHEDULE_PRESETS } from './types'
import { persistRoutines } from './persistRoutines'
import { STRATEGIES, DEFAULT_STRATEGY_ID, getStrategy } from '../backtest/strategies'
import { EXCHANGES, INTERVALS, type Exchange, type SymbolInfo, type Interval, type RoutineConfig } from '../../shared/ipc'

function fieldLabelStyle(): React.CSSProperties {
  return { fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem', display: 'block' }
}

function textInputStyle(): React.CSSProperties {
  return {
    width: '100%',
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.55rem 0.7rem',
    color: 'var(--text-primary)',
    fontSize: '0.85rem'
  }
}

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

function scheduleLabel(seconds: number): string {
  return SCHEDULE_PRESETS.find((p) => p.seconds === seconds)?.label ?? `Every ${Math.round(seconds / 60)} min`
}

function NewRoutineForm({ onCreate }: { onCreate: (routine: RoutineConfig) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [exchange, setExchange] = useState<Exchange>(EXCHANGES[0].id)
  const [pair, setPair] = useState<SymbolInfo>(EXCHANGES[0].defaultSymbol)
  const [interval, setInterval] = useState<Interval>(getStrategy(DEFAULT_STRATEGY_ID).preferredInterval)
  const [strategyId, setStrategyId] = useState(DEFAULT_STRATEGY_ID)

  // Choosing a strategy moves the interval to the bar size that strategy was measured on, the
  // same way the Backtest page does it. The two shipped trend strategies want different bars (1h
  // and 15m), so a single app-wide DEFAULT_INTERVAL was always wrong for one of them.
  function handleStrategyChange(next: string): void {
    setStrategyId(next)
    setInterval(getStrategy(next).preferredInterval)
  }
  const [scheduleSec, setScheduleSec] = useState(SCHEDULE_PRESETS[1].seconds)

  function handleExchangeChange(next: Exchange): void {
    setExchange(next)
    const info = EXCHANGES.find((e) => e.id === next)
    if (info) setPair(info.defaultSymbol)
  }

  function handleCreate(): void {
    if (!name.trim()) return
    onCreate({
      id: crypto.randomUUID(),
      name: name.trim(),
      exchange,
      symbol: pair.symbol,
      interval,
      strategyId,
      scheduleSec,
      enabled: true,
      createdAt: Math.floor(Date.now() / 1000),
      lastRunAt: null
    })
    setName('')
  }

  return (
    <Card title="New Routine">
      <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '1 1 160px' }}>
          <label style={fieldLabelStyle()}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. BTC daily scan" style={textInputStyle()} />
        </div>
        <div style={{ flex: '0 0 140px' }}>
          <label style={fieldLabelStyle()}>Exchange</label>
          <ExchangeSelect exchange={exchange} onSelect={handleExchangeChange} />
        </div>
        <div style={{ flex: '0 0 140px' }}>
          <label style={fieldLabelStyle()}>Symbol</label>
          <SymbolSearch exchange={exchange} symbol={pair.symbol} onSelect={setPair} />
        </div>
        <div style={{ flex: '0 0 90px' }}>
          <label style={fieldLabelStyle()}>Interval</label>
          <select value={interval} onChange={(e) => setInterval(e.target.value as Interval)} style={textInputStyle()}>
            {INTERVALS.map((iv) => (
              <option key={iv.id} value={iv.id}>
                {iv.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '0 0 170px' }}>
          <label style={fieldLabelStyle()}>Strategy</label>
          <select value={strategyId} onChange={(e) => handleStrategyChange(e.target.value)} style={textInputStyle()}>
            {STRATEGIES.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '0 0 160px' }}>
          <label style={fieldLabelStyle()}>Schedule</label>
          <select value={scheduleSec} onChange={(e) => setScheduleSec(Number(e.target.value))} style={textInputStyle()}>
            {SCHEDULE_PRESETS.map((p) => (
              <option key={p.seconds} value={p.seconds}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={handleCreate}
          disabled={!name.trim()}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.4rem',
            background: 'linear-gradient(135deg, #7c86ff, #6366f1)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            padding: '0.55rem 0.9rem',
            color: '#fff',
            fontSize: '0.8rem',
            fontWeight: 700,
            cursor: name.trim() ? 'pointer' : 'not-allowed',
            opacity: name.trim() ? 1 : 0.6
          }}
        >
          <Plus size={14} /> Create
        </button>
      </div>
    </Card>
  )
}

function ReportRow({ report }: { report: ReturnType<typeof useRoutineReports>[number] }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const { stats } = report.result

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0.6rem 0.8rem',
          background: 'var(--bg-app)',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left'
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          {new Date(report.ranAt * 1000).toLocaleString()}
        </span>
        <span style={{ fontSize: '0.82rem', fontWeight: 600, color: pctColor(stats.totalNetProfitPct) }}>
          {stats.totalNetProfitPct >= 0 ? '+' : ''}
          {stats.totalNetProfitPct.toFixed(2)}%
        </span>
      </button>
      {expanded && (
        <div style={{ padding: '0.8rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.7rem', marginBottom: '0.8rem' }}>
            <div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Trades</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>{stats.totalClosedTrades}</div>
            </div>
            <div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Win Rate</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)' }}>{stats.winRatePct.toFixed(0)}%</div>
            </div>
            <div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Max Drawdown</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--down)' }}>{stats.maxDrawdownPct.toFixed(2)}%</div>
            </div>
            <div>
              <div style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Net P&amp;L</div>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: pctColor(stats.totalNetProfit) }}>
                {stats.totalNetProfit.toFixed(2)}
              </div>
            </div>
          </div>
          <EquityCurveChart equityCurve={report.result.equityCurve} />
        </div>
      )}
    </div>
  )
}

function RoutineReports({ routine }: { routine: RoutineConfig }): React.JSX.Element {
  const reports = useRoutineReports(routine.id)

  if (reports.length === 0) {
    return (
      <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: 0 }}>
        No reports yet for this routine. It'll run automatically on schedule, or click "Run Now" above.
      </p>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {reports.map((report) => (
        <ReportRow key={report.id} report={report} />
      ))}
    </div>
  )
}

export function RoutinesPage(): React.JSX.Element {
  const [routines, setRoutines] = useState<RoutineConfig[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [runError, setRunError] = useState<{ id: string; message: string } | null>(null)
  const loadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (cancelled) return
      setRoutines(settings.routines)
      loadedRef.current = true
    })
    return (): void => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    void persistRoutines(routines)
  }, [routines])

  function handleCreate(routine: RoutineConfig): void {
    setRoutines((prev) => [...prev, routine])
    setSelectedId(routine.id)
  }

  function handleToggleEnabled(id: string): void {
    setRoutines((prev) => prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)))
  }

  async function handleRunNow(routine: RoutineConfig): Promise<void> {
    setRunningId(routine.id)
    setRunError(null)
    try {
      await runRoutineNow(routine)
      const settings = await window.api.settings.get()
      setRoutines(settings.routines)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Routine run failed:', error)
      setRunError({ id: routine.id, message })
    } finally {
      setRunningId(null)
    }
  }

  const selected = routines.find((r) => r.id === selectedId) ?? null

  return (
    <>
      <PageHeader title="Routines" subtitle="Recurring backtests that re-run on a schedule while this app is open" />

      <NewRoutineForm onCreate={handleCreate} />

      {routines.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>No routines yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {routines.map((routine) => {
            const exchangeName = EXCHANGES.find((e) => e.id === routine.exchange)?.name ?? routine.exchange
            const active = selectedId === routine.id
            return (
              <div key={routine.id}>
              <div
                onClick={() => setSelectedId(routine.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  padding: '0.75rem 1rem',
                  background: active ? 'var(--bg-surface-hover)' : 'var(--bg-surface)',
                  border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.7rem', minWidth: 0 }}>
                  <Repeat size={16} color="var(--text-secondary)" />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.88rem' }}>{routine.name}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      {exchangeName} • {routine.symbol} • {routine.interval} • {STRATEGIES.find((s) => s.id === routine.strategyId)?.name ?? 'Unknown strategy'} • {scheduleLabel(routine.scheduleSec)}
                      {routine.lastRunAt && ` • last run ${new Date(routine.lastRunAt * 1000).toLocaleString()}`}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => void handleRunNow(routine)}
                    disabled={runningId === routine.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.3rem',
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      padding: '0.4rem 0.7rem',
                      color: 'var(--text-primary)',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      cursor: runningId === routine.id ? 'default' : 'pointer',
                      opacity: runningId === routine.id ? 0.6 : 1
                    }}
                  >
                    <Play size={12} /> {runningId === routine.id ? 'Running…' : 'Run Now'}
                  </button>
                  <button
                    onClick={() => handleToggleEnabled(routine.id)}
                    title={routine.enabled ? 'Enabled — click to pause' : 'Paused — click to enable'}
                    style={{
                      width: 36,
                      height: 20,
                      borderRadius: 999,
                      border: 'none',
                      background: routine.enabled ? 'var(--positive)' : 'var(--border-strong)',
                      position: 'relative',
                      cursor: 'pointer',
                      flexShrink: 0
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        top: 2,
                        left: routine.enabled ? 18 : 2,
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        background: '#fff',
                        transition: 'left 0.12s ease'
                      }}
                    />
                  </button>
                </div>
              </div>
              {runError?.id === routine.id && (
                <p style={{ margin: '0.35rem 0 0', fontSize: '0.75rem', color: 'var(--down)' }}>{runError.message}</p>
              )}
              </div>
            )
          })}
        </div>
      )}

      {selected && (
        <Card title={`Reports — ${selected.name}`}>
          <RoutineReports routine={selected} />
        </Card>
      )}
    </>
  )
}
