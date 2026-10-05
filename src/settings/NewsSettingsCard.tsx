import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { Toggle } from '../components/Toggle'
import { NEWS_SHORT_STAKES, type NewsConfig, type NewsConfigPatch } from '../../shared/news'
import { inputStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'

/** The news reader's settings: the reader, and what a delisting it reads does -- a notice to
 * someone holding the coin, and the paper short of the rule research/NEWS.md measured. What it has
 * read is on Discovery. The main process checks every value again. */
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

  async function change(patch: NewsConfigPatch): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      setConfig((await window.api.news.setConfig(patch)).config)
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const enabled = config?.enabled === true
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap', marginTop: '0.7rem' }
  const labelStyle: React.CSSProperties = { fontSize: '0.8rem', color: enabled ? 'var(--text-primary)' : 'var(--text-muted)' }

  return (
    <Card title="Binance announcements">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
        <Toggle on={enabled} onChange={(next) => !busy && void change({ enabled: next })} />
        <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>{enabled ? 'On' : 'Off'}</span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Read Binance&apos;s listing and delisting announcements</span>
      </div>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.6rem' }}>{problem}</p>}
      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        Once a minute, a few seconds after the minute begins, Binance&apos;s two public announcement lists are read, and each new
        article is kept once and sorted by its title: a delisting, a futures launch, a spot listing, or none of these. That is two
        requests a minute, and no key is used. What it has read is on Discovery. It stays on across restarts until you switch it off.
      </p>

      <div style={{ marginTop: '0.9rem', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>When Binance announces a delisting</div>
      <div style={rowStyle}>
        <Toggle on={config?.notifyHeld === true} onChange={(next) => !busy && void change({ notifyHeld: next })} />
        <span style={labelStyle}>Tell me if I hold the coin, on Binance or on paper</span>
      </div>
      <div style={rowStyle}>
        <Toggle on={config?.askModels === true} onChange={(next) => !busy && void change({ askModels: next })} />
        <span style={labelStyle}>Put it to the watch&apos;s models, when the watch is on</span>
      </div>
      <div style={rowStyle}>
        <Toggle on={config?.paperShort.enabled === true} onChange={(next) => !busy && void change({ paperShort: { enabled: next } })} />
        <span style={labelStyle}>Open a paper short of</span>
        <select
          aria-label="Paper short stake"
          value={config?.paperShort.stakeQuote ?? ''}
          disabled={busy || config === null}
          onChange={(event) => void change({ paperShort: { stakeQuote: Number(event.target.value) } })}
          style={inputStyle()}
        >
          {NEWS_SHORT_STAKES.map((stake) => (
            <option key={stake} value={stake}>
              {stake}
            </option>
          ))}
        </select>
        <span style={labelStyle}>USDT on each coin, held four hours</span>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        Each acts only on a delisting read while the app is open. The notice reads your Binance balances where a key is stored, and
        your paper account and positions; it sells nothing. Put to the models, each coin it names is raised as an event, and the watch
        on Opportunities asks its models about it within its own limits and the day&apos;s budget, as it does any event; a call to
        short can only ever be a paper trade. The paper short is the rule research/NEWS.md measured: opened within five
        minutes of the announcement, out four hours after it, with no stop and no target. It is paper and can never be anything else,
        and a coin squeezed upward can cost it a great deal: two of 87 lost 44% and 80%. With a paper account it is funded and
        settled like any paper trade.
      </p>
    </Card>
  )
}
