import { useEffect, useState } from 'react'
import { X, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { STARTER_PACKS, STARTER_PRESETS, findPreset, type PresetRisk, type StarterPreset } from './starterPresets'
import { insertPreset, insertStarterPack } from './insertStarterPack'

interface StarterPresetsModalProps {
  onClose: () => void
  /** Called after anything is written, so the page can pull the new executors into view. */
  onInserted: () => void
}

function riskColor(risk: PresetRisk): string {
  if (risk === 'conservative') return 'var(--up)'
  if (risk === 'moderate') return 'var(--gold)'
  return 'var(--down)'
}

function badgeStyle(color: string): React.CSSProperties {
  return {
    fontSize: '0.66rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color,
    border: `1px solid ${color}`,
    borderRadius: 'var(--radius-sm)',
    padding: '0.1rem 0.4rem',
    whiteSpace: 'nowrap'
  }
}

function actionButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    background: disabled ? 'var(--bg-surface-hover)' : 'var(--accent)',
    color: disabled ? 'var(--text-muted)' : '#fff',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    padding: '0.4rem 0.8rem',
    fontSize: '0.78rem',
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap'
  }
}

function PresetRow({
  preset,
  referencePrice,
  priceLoading,
  busy,
  onAdd
}: {
  preset: StarterPreset
  referencePrice: number | null
  priceLoading: boolean
  busy: boolean
  onAdd: (preset: StarterPreset) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const blocked = preset.needsReferencePrice && referencePrice === null

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.7rem 0.8rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        </button>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.9rem' }}>{preset.name}</span>
        <span style={badgeStyle(riskColor(preset.risk))}>{preset.risk}</span>
        {preset.paperOnly && <span style={badgeStyle('var(--text-muted)')}>paper only</span>}
        <span style={{ marginLeft: 'auto' }}>
          <button style={actionButtonStyle(busy || blocked)} disabled={busy || blocked} onClick={() => onAdd(preset)}>
            {priceLoading && blocked ? 'Loading...' : 'Add'}
          </button>
        </span>
      </div>

      <p style={{ margin: '0.45rem 0 0 1.6rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{preset.summary}</p>

      {blocked && !priceLoading && (
        <p style={{ margin: '0.35rem 0 0 1.6rem', fontSize: '0.72rem', color: 'var(--down)' }}>
          Unavailable right now: this one places its levels at fixed prices, and the current {preset.symbol} price could not
          be loaded. Check your connection and reopen this window.
        </p>
      )}

      {open && (
        <div style={{ margin: '0.6rem 0 0 1.6rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              What it does
            </div>
            <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{preset.howItWorks}</p>
          </div>
          <div>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--down)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              When it loses money
            </div>
            <p style={{ margin: '0.2rem 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{preset.whenItLosesMoney}</p>
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            Based on Hummingbot&apos;s {preset.hummingbot} · {preset.exchange} {preset.symbol}
          </div>
        </div>
      )}
    </div>
  )
}

export function StarterPresetsModal({ onClose, onInserted }: StarterPresetsModalProps): React.JSX.Element {
  const [referencePrice, setReferencePrice] = useState<number | null>(null)
  const [priceLoading, setPriceLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [added, setAdded] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Only the Range Grid needs this -- its levels are absolute prices, so it cannot be built
  // without knowing what BTC costs right now. Everything else ignores it.
  //
  // Two sources rather than one: the ticker is the freshest, but it is a socket that can be slow
  // or fail, and a single failed subscribe used to leave the Range Grid and the Directional Desk
  // permanently unavailable. A recent 1m close is a perfectly good band centre, and it comes from
  // the same fetch every executor already simulates against.
  useEffect(() => {
    let cancelled = false

    async function loadReferencePrice(): Promise<number | null> {
      try {
        const snapshot = await window.api.market.subscribeTicker('binance', 'BTCUSDT')
        if (snapshot.lastPrice > 0) return snapshot.lastPrice
      } catch (e) {
        console.error('Ticker unavailable for presets, falling back to recent candles:', e)
      } finally {
        void window.api.market.unsubscribeTicker()
      }
      try {
        const endSec = Math.floor(Date.now() / 1000)
        const { candles } = await window.api.market.fetchHistoricalRange('binance', 'BTCUSDT', '1m', endSec - 3600, endSec)
        const last = candles[candles.length - 1]
        if (last && last.close > 0) return last.close
      } catch (e) {
        console.error('Could not load any reference price for presets:', e)
      }
      return null
    }

    void loadReferencePrice().then((price) => {
      if (!cancelled) {
        setReferencePrice(price)
        setPriceLoading(false)
      }
    })

    return (): void => {
      cancelled = true
    }
  }, [])

  async function run(label: string, action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await action()
      setAdded(label)
      onInserted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const opts = { referencePrice: referencePrice ?? 0, now: Math.floor(Date.now() / 1000) }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 720,
          maxWidth: '94vw',
          maxHeight: '88vh',
          overflowY: 'auto',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.9rem 1.1rem', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>Starter Presets</span>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <div style={{ padding: '1rem 1.1rem', display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
          {/* The most important text in this modal. A beginner reading "recommended settings" will
              assume recommended means likely to profit, and it does not. */}
          <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-start', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', padding: '0.7rem 0.8rem' }}>
            <AlertTriangle size={16} style={{ color: 'var(--gold)', flexShrink: 0, marginTop: 2 }} />
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              None of these predict price, and none of them are expected to earn a profit. They are starting configurations
              adapted from the strategies Hummingbot ships, so you begin with sensible sizes, spreads and stops instead of a
              blank form. Every one is created in <strong style={{ color: 'var(--text-primary)' }}>paper mode</strong> and
              trades no real money. Open one to read the conditions under which it loses.
            </p>
          </div>

          <section>
            <h3 style={{ margin: '0 0 0.15rem', fontSize: '0.88rem', color: 'var(--text-primary)' }}>Starter packs</h3>
            <p style={{ margin: '0 0 0.65rem', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
              A group of strategies plus a Controller that watches their combined result and stops all of them together if it
              goes wrong.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              {STARTER_PACKS.map((pack) => {
                const members = pack.presetIds.map((id) => findPreset(id)).filter((p): p is StarterPreset => p !== undefined)
                const blocked = members.some((m) => m.needsReferencePrice) && referencePrice === null
                return (
                  <div key={pack.id} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.75rem 0.85rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.9rem' }}>{pack.name}</span>
                      <span style={{ marginLeft: 'auto' }}>
                        <button
                          style={actionButtonStyle(busy || blocked)}
                          disabled={busy || blocked}
                          onClick={() => void run(pack.name, () => insertStarterPack(pack, opts))}
                        >
                          {priceLoading && blocked ? 'Loading price...' : 'Add pack'}
                        </button>
                      </span>
                    </div>
                    <p style={{ margin: '0.4rem 0 0', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{pack.summary}</p>
                    <p style={{ margin: '0.4rem 0 0', fontSize: '0.76rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>{pack.rationale}</p>
                    <div style={{ margin: '0.5rem 0 0', fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                      Includes {members.map((m) => m.name).join(', ')} · stops the group at {pack.riskControls.globalStopLossPct}% loss,
                      takes profit at {pack.riskControls.globalTakeProfitPct}%, caps drawdown at {pack.riskControls.maxDrawdownPct}%
                    </div>
                    {blocked && !priceLoading && (
                      <p style={{ margin: '0.4rem 0 0', fontSize: '0.72rem', color: 'var(--down)' }}>
                        Unavailable right now: the Range Grid in this pack places its levels at fixed prices, and the current
                        BTCUSDT price could not be loaded. Check your connection and reopen this window.
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          <section>
            <h3 style={{ margin: '0 0 0.15rem', fontSize: '0.88rem', color: 'var(--text-primary)' }}>Individual strategies</h3>
            <p style={{ margin: '0 0 0.65rem', fontSize: '0.76rem', color: 'var(--text-muted)' }}>
              Added on their own, with no Controller watching them. Expand one to see what it does and how it fails.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {STARTER_PRESETS.map((preset) => (
                <PresetRow
                  key={preset.id}
                  preset={preset}
                  referencePrice={referencePrice}
                  priceLoading={priceLoading}
                  busy={busy}
                  onAdd={(p) => void run(p.name, () => insertPreset(p, opts))}
                />
              ))}
            </div>
          </section>

          {added && !error && (
            <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--up)' }}>
              Added {added}. It is running in paper mode on the Executors page.
            </p>
          )}
          {error && <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--down)' }}>Could not add: {error}</p>}
        </div>
      </div>
    </div>
  )
}
