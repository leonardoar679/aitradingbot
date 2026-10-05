import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { Toggle } from '../components/Toggle'
import { SCANNER_UNIVERSE_SIZES, type ScannerConfig } from '../../shared/marketScanner'
import { inputStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'

/** The scanner's two settings: on or off, and how many pairs it watches. What it is reading now,
 * and what it has raised, are on Discovery. Every value is checked again by the main process,
 * which refuses a size that is not one of the choices. */
export function ScannerSettingsCard(): React.JSX.Element {
  const [config, setConfig] = useState<ScannerConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.scanner.getState().then(
      (state) => {
        if (!cancelled) setConfig(state.config)
      },
      (failure: unknown) => {
        if (!cancelled) setProblem(describeError(failure))
      }
    )
    const stop = window.api.scanner.onUpdate((state) => {
      if (!cancelled) setConfig(state.config)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  async function change(patch: { enabled?: boolean; universeSize?: number }): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      setConfig((await window.api.scanner.setConfig(patch)).config)
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const enabled = config?.enabled === true

  return (
    <Card title="Market scanner">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
        <Toggle on={enabled} onChange={(next) => !busy && void change({ enabled: next })} />
        <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>{enabled ? 'On' : 'Off'}</span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Watch the</span>
        <select
          aria-label="Pairs watched"
          value={config?.universeSize ?? ''}
          disabled={busy || config === null}
          onChange={(event) => void change({ universeSize: Number(event.target.value) })}
          style={inputStyle()}
        >
          {SCANNER_UNIVERSE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>most traded USDT pairs on Binance</span>
      </div>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.6rem' }}>{problem}</p>}
      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        Once a minute, a few seconds after the minute closes, every watched pair is read from its last twelve hours of 1-minute
        candles. This is public market data only: no key is used, no model is asked and nothing is placed. It costs one request a
        pair a minute, and it stays on across restarts until you switch it off. What it is reading, and the events it has raised,
        are on Discovery; the watch on Opportunities asks models only about events it raises.
      </p>
    </Card>
  )
}
