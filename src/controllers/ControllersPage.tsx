import { useEffect, useMemo, useRef, useState } from 'react'
import { Boxes, Play } from 'lucide-react'
import { PageHeader } from '../components/PageHeader'
import { Card } from '../components/Card'
import { EquityCurveChart } from '../components/EquityCurveChart'
import { computeExecutorPnl } from '../executors/computeSnapshot'
import { useControllerSnapshots } from './controllerStore'
import { runControllerSnapshotNow } from './ControllerScheduler'
import type { ControllerConfig, ExecutorConfig } from '../../shared/ipc'

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

function NewControllerForm({ executors, onCreate }: { executors: ExecutorConfig[]; onCreate: (controller: ControllerConfig) => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [stopLossPct, setStopLossPct] = useState('')
  const [takeProfitPct, setTakeProfitPct] = useState('')
  const [maxDrawdownPct, setMaxDrawdownPct] = useState('')

  function toggleExecutor(id: string): void {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  function handleCreate(): void {
    if (!name.trim() || selectedIds.length === 0) return
    onCreate({
      id: crypto.randomUUID(),
      name: name.trim(),
      executorIds: selectedIds,
      riskControls: {
        globalStopLossPct: stopLossPct ? Number(stopLossPct) : null,
        globalTakeProfitPct: takeProfitPct ? Number(takeProfitPct) : null,
        maxDrawdownPct: maxDrawdownPct ? Number(maxDrawdownPct) : null
      },
      status: 'active',
      createdAt: Math.floor(Date.now() / 1000)
    })
    setName('')
    setSelectedIds([])
    setStopLossPct('')
    setTakeProfitPct('')
    setMaxDrawdownPct('')
  }

  return (
    <Card title="New Controller">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
        <div>
          <label style={fieldLabelStyle()}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. BTC Strategy Group" style={textInputStyle()} />
        </div>

        <div>
          <label style={fieldLabelStyle()}>Attached Executors</label>
          {executors.length === 0 ? (
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
              No executors yet — create one on the Executors page first.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: 160, overflowY: 'auto' }}>
              {executors.map((e) => (
                <label key={e.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={selectedIds.includes(e.id)} onChange={() => toggleExecutor(e.id)} />
                  {e.name} <span style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }}>({e.type} • {e.symbol})</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 140px' }}>
            <label style={fieldLabelStyle()}>Global Stop Loss % (optional)</label>
            <input type="number" step="0.1" value={stopLossPct} onChange={(e) => setStopLossPct(e.target.value)} style={textInputStyle()} />
          </div>
          <div style={{ flex: '1 1 140px' }}>
            <label style={fieldLabelStyle()}>Global Take Profit % (optional)</label>
            <input type="number" step="0.1" value={takeProfitPct} onChange={(e) => setTakeProfitPct(e.target.value)} style={textInputStyle()} />
          </div>
          <div style={{ flex: '1 1 140px' }}>
            <label style={fieldLabelStyle()}>Max Drawdown % of allocated capital (optional)</label>
            <input type="number" step="0.1" value={maxDrawdownPct} onChange={(e) => setMaxDrawdownPct(e.target.value)} style={textInputStyle()} />
          </div>
        </div>

        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>
          Risk controls are checked every 5 minutes while the app is open (or on "Run Snapshot Now") — a breach
          stops every attached executor and the controller itself.
        </p>

        <button
          onClick={handleCreate}
          disabled={!name.trim() || selectedIds.length === 0}
          style={{
            alignSelf: 'flex-start',
            background: 'linear-gradient(135deg, #7c86ff, #6366f1)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            padding: '0.55rem 0.9rem',
            color: '#fff',
            fontSize: '0.8rem',
            fontWeight: 700,
            cursor: !name.trim() || selectedIds.length === 0 ? 'not-allowed' : 'pointer',
            opacity: !name.trim() || selectedIds.length === 0 ? 0.6 : 1
          }}
        >
          Create Controller
        </button>
      </div>
    </Card>
  )
}

function ExecutorBreakdown({ executors }: { executors: ExecutorConfig[] }): React.JSX.Element {
  const [pnls, setPnls] = useState<Record<string, number | 'error'>>({})

  useEffect(() => {
    let cancelled = false
    Promise.all(
      executors.map(async (e) => {
        try {
          return [e.id, await computeExecutorPnl(e)] as const
        } catch (error) {
          console.error(`Failed to compute P&L for executor "${e.name}":`, error)
          return [e.id, 'error'] as const
        }
      })
    ).then((entries) => {
      if (!cancelled) setPnls(Object.fromEntries(entries))
    })
    return () => {
      cancelled = true
    }
  }, [executors])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
      {executors.map((e) => {
        const pnl = pnls[e.id]
        return (
          <div key={e.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0.7rem', background: 'var(--bg-app)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', fontSize: '0.78rem' }}>
            <span style={{ color: 'var(--text-primary)' }}>{e.name} <span style={{ color: 'var(--text-muted)' }}>({e.type})</span></span>
            <span style={{ color: pnl === 'error' ? 'var(--down)' : pnl !== undefined ? pctColor(pnl) : 'var(--text-muted)', fontWeight: 600 }}>
              {pnl === 'error' ? 'failed to load' : pnl !== undefined ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} ${e.quoteAsset}` : 'loading…'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function ControllerSnapshots({ controller, executors }: { controller: ControllerConfig; executors: ExecutorConfig[] }): React.JSX.Element {
  const snapshots = useControllerSnapshots(controller.id)
  const attached = useMemo(() => executors.filter((e) => controller.executorIds.includes(e.id)), [executors, controller.executorIds])
  const equityCurve = useMemo(() => snapshots.slice().reverse().map((s) => ({ time: s.takenAt, value: s.aggregatePnlQuote })), [snapshots])

  return (
    <Card title={`Snapshots — ${controller.name}`}>
      {snapshots.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.82rem', margin: 0 }}>
          No snapshots yet. It'll capture one automatically every 5 minutes, or click "Run Snapshot Now" above.
        </p>
      ) : (
        <>
          <EquityCurveChart equityCurve={equityCurve} />
          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: '0.6rem 0 0.9rem' }}>
            Latest: {snapshots[0].aggregatePnlQuote >= 0 ? '+' : ''}
            {snapshots[0].aggregatePnlQuote.toFixed(2)} across {snapshots[0].executorCount} executor
            {snapshots[0].executorCount === 1 ? '' : 's'} · {new Date(snapshots[0].takenAt * 1000).toLocaleString()}
          </p>
        </>
      )}
      <h3 style={{ margin: '0.4rem 0 0.5rem', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>Per-Executor Breakdown</h3>
      <ExecutorBreakdown executors={attached} />
    </Card>
  )
}

export function ControllersPage(): React.JSX.Element {
  const [controllers, setControllers] = useState<ControllerConfig[]>([])
  const [executors, setExecutors] = useState<ExecutorConfig[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [runningId, setRunningId] = useState<string | null>(null)
  const [runError, setRunError] = useState<{ id: string; message: string } | null>(null)
  const loadedRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    window.api.settings.get().then((settings) => {
      if (cancelled) return
      setControllers(settings.controllers)
      setExecutors(settings.executors)
      loadedRef.current = true
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    void window.api.settings.set({ controllers })
  }, [controllers])

  function handleCreate(controller: ControllerConfig): void {
    setControllers((prev) => [...prev, controller])
    setSelectedId(controller.id)
  }

  function handleToggleEnabled(id: string): void {
    setControllers((prev) => prev.map((c) => (c.id === id ? { ...c, status: c.status === 'active' ? 'stopped' : 'active' } : c)))
  }

  async function handleRunNow(controller: ControllerConfig): Promise<void> {
    setRunningId(controller.id)
    setRunError(null)
    try {
      await runControllerSnapshotNow(controller)
      const settings = await window.api.settings.get()
      setControllers(settings.controllers)
      setExecutors(settings.executors)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('Controller snapshot failed:', error)
      setRunError({ id: controller.id, message })
    } finally {
      setRunningId(null)
    }
  }

  const selected = controllers.find((c) => c.id === selectedId) ?? null

  return (
    <>
      <PageHeader title="Controllers" subtitle="Group executors under shared risk controls and periodic P&L snapshots" />

      <NewControllerForm executors={executors} onCreate={handleCreate} />

      {controllers.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', margin: 0 }}>No controllers yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {controllers.map((controller) => {
            const active = selectedId === controller.id
            const riskParts = [
              controller.riskControls.globalStopLossPct !== null && `SL ${controller.riskControls.globalStopLossPct}%`,
              controller.riskControls.globalTakeProfitPct !== null && `TP ${controller.riskControls.globalTakeProfitPct}%`,
              controller.riskControls.maxDrawdownPct !== null && `DD ${controller.riskControls.maxDrawdownPct}%`
            ].filter(Boolean)
            return (
              <div key={controller.id}>
              <div
                onClick={() => setSelectedId(controller.id)}
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
                  <Boxes size={16} color="var(--text-secondary)" />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.88rem' }}>{controller.name}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                      {controller.executorIds.length} executor{controller.executorIds.length === 1 ? '' : 's'}
                      {riskParts.length > 0 && ` • ${riskParts.join(' • ')}`}
                      {controller.status === 'stopped' && ' • stopped'}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
                  <button
                    onClick={() => void handleRunNow(controller)}
                    disabled={runningId === controller.id}
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
                      cursor: runningId === controller.id ? 'default' : 'pointer',
                      opacity: runningId === controller.id ? 0.6 : 1
                    }}
                  >
                    <Play size={12} /> {runningId === controller.id ? 'Running…' : 'Run Snapshot Now'}
                  </button>
                  <button
                    onClick={() => handleToggleEnabled(controller.id)}
                    title={controller.status === 'active' ? 'Active — click to pause' : 'Stopped — click to reactivate'}
                    style={{
                      width: 36,
                      height: 20,
                      borderRadius: 999,
                      border: 'none',
                      background: controller.status === 'active' ? 'var(--positive)' : 'var(--border-strong)',
                      position: 'relative',
                      cursor: 'pointer',
                      flexShrink: 0
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        top: 2,
                        left: controller.status === 'active' ? 18 : 2,
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
              {runError?.id === controller.id && (
                <p style={{ margin: '0.35rem 0 0', fontSize: '0.75rem', color: 'var(--down)' }}>{runError.message}</p>
              )}
              </div>
            )
          })}
        </div>
      )}

      {selected && <ControllerSnapshots controller={selected} executors={executors} />}
    </>
  )
}
