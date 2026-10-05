import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { Toggle } from '../components/Toggle'
import type { NewsConfig } from '../../shared/news'
import { noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'

/** The news reader's one setting: on or off. What it has read is on Discovery. The main process
 * checks the value again and refuses anything but on or off. */
export function NewsSettingsCard(): React.JSX.Element {
  const [config, setConfig] = useState<NewsConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.news.getState().then(
      (state) => {
        if (!cancelled) setConfig(state.config)
      },
      (failure: unknown) => {
        if (!cancelled) setProblem(describeError(failure))
      }
    )
    const stop = window.api.news.onUpdate((state) => {
      if (!cancelled) setConfig(state.config)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  async function change(enabled: boolean): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      setConfig((await window.api.news.setConfig({ enabled })).config)
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const enabled = config?.enabled === true

  return (
    <Card title="Binance announcements">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
        <Toggle on={enabled} onChange={(next) => !busy && void change(next)} />
        <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>{enabled ? 'On' : 'Off'}</span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Read Binance&apos;s listing and delisting announcements</span>
      </div>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.6rem' }}>{problem}</p>}
      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        Once a minute, a few seconds after the minute begins, Binance&apos;s two public announcement lists are read, and each new
        article is kept once and sorted by its title: a delisting, a futures launch, a spot listing, or none of these. That is two
        requests a minute. No key is used, no model is asked about an announcement, and nothing is placed or opened because of one.
        What it has read is on Discovery. It stays on across restarts until you switch it off.
      </p>
    </Card>
  )
}
