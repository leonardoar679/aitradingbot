import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { Toggle } from '../components/Toggle'
import { NEWS_SHORT_STAKES, type NewsConfig, type NewsConfigPatch, type NewsKindActions, type NewsKindActionsPatch } from '../../shared/news'
import { inputStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'

/** One kind's switches: the notice, the models, and the paper short of its rule with its stake. */
function KindRows(props: {
  heading: string
  actions: NewsKindActions | null
  enabled: boolean
  busy: boolean
  /** How the rule's short is held, after "USDT on each coin". */
  held: string
  onChange: (patch: NewsKindActionsPatch) => void
}): React.JSX.Element {
  const { actions, busy, onChange } = props
  const rowStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap', marginTop: '0.7rem' }
  const labelStyle: React.CSSProperties = { fontSize: '0.8rem', color: props.enabled ? 'var(--text-primary)' : 'var(--text-muted)' }
  return (
    <>
      <div style={{ marginTop: '0.9rem', fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{props.heading}</div>
      <div style={rowStyle}>
        <Toggle on={actions?.notifyHeld === true} onChange={(next) => !busy && onChange({ notifyHeld: next })} />
        <span style={labelStyle}>Tell me if I hold the coin, on Binance or on paper</span>
      </div>
      <div style={rowStyle}>
        <Toggle on={actions?.askModels === true} onChange={(next) => !busy && onChange({ askModels: next })} />
        <span style={labelStyle}>Put it to the watch&apos;s models, when the watch is on</span>
      </div>
      <div style={rowStyle}>
        <Toggle on={actions?.paperShort.enabled === true} onChange={(next) => !busy && onChange({ paperShort: { enabled: next } })} />
        <span style={labelStyle}>Open a paper short of</span>
        <select
          aria-label={`${props.heading}: paper short stake`}
          value={actions?.paperShort.stakeQuote ?? ''}
          disabled={busy || actions === null}
          onChange={(event) => onChange({ paperShort: { stakeQuote: Number(event.target.value) } })}
          style={inputStyle()}
        >
          {NEWS_SHORT_STAKES.map((stake) => (
            <option key={stake} value={stake}>
              {stake}
            </option>
          ))}
        </select>
        <span style={labelStyle}>USDT on each coin, {props.held}</span>
      </div>
    </>
  )
}

/** The news reader's settings: the reader, and what each of the two kinds that passed does -- a
 * notice to someone holding the coin, the paper short of the kind's rule research/NEWS.md measured,
 * and a question to the watch's models. What it has read is on Explorer. The main process checks
 * every value again. */
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

  return (
    <Card title="Binance announcements">
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', flexWrap: 'wrap' }}>
        <Toggle on={enabled} onChange={(next) => !busy && void change({ enabled: next })} />
        <span style={{ fontSize: '0.85rem', color: 'var(--text-primary)', fontWeight: 600 }}>{enabled ? 'On' : 'Off'}</span>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Read Binance&apos;s listing, delisting and news announcements</span>
      </div>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.6rem' }}>{problem}</p>}
      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        Once a minute, a few seconds after the minute begins, Binance&apos;s three public announcement lists are read (delistings, new
        listings, and its news) and each new article is kept once and sorted by its title: a delisting, a coin added to the Monitoring
        Tag, a futures launch, a spot listing, or none of these. That is three requests a minute, and no key is used. What it has read
        is on Explorer. It stays on across restarts until you switch it off.
      </p>

      <KindRows
        heading="When Binance announces a delisting"
        actions={config?.delisting ?? null}
        enabled={enabled}
        busy={busy}
        held="held four hours"
        onChange={(patch) => void change({ delisting: patch })}
      />
      <KindRows
        heading="When Binance adds a coin to its Monitoring Tag"
        actions={config?.monitoringTag ?? null}
        enabled={enabled}
        busy={busy}
        held="with a stop and a target, out within the hour"
        onChange={(patch) => void change({ monitoringTag: patch })}
      />

      <p style={{ ...noteStyle, marginTop: '0.8rem' }}>
        Each acts only on an announcement read while the app is open. The notice reads your Binance balances where a key is stored, and
        your paper account and positions; it sells nothing. Put to the models, each coin a delisting or a tag names is raised as an event, and
        the watch on Opportunities asks its models about it within its own limits and the day&apos;s budget, as it does any event; a
        call to short can only ever be a paper trade.
      </p>
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        Each paper short is the rule research/NEWS.md measured for its kind. A delisting&apos;s is opened within five minutes of the
        announcement and is out four hours after it, with no stop and no target; a coin squeezed upward can cost it a great deal (two of
        87 lost 44% and 80%). A tag&apos;s is made in the minute after the announcement&apos;s and enters at the next, with a stop 1.5
        and a target 3 of the coin&apos;s usual fifteen-minute moves, and is out at the close of its sixtieth minute otherwise; it
        passed by a small margin, 0.35% a trade after costs. Both are paper and can never be anything else; with a paper account they
        are funded and settled like any paper trade.
      </p>
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        The stake is the most a short stakes. Where Risk &amp; Safety sizes the app&apos;s own paper trades by what their stop would lose,
        a tag&apos;s short stakes that, never more than its stake; a delisting&apos;s has no stop and stakes its stake. With the
        watch&apos;s paper trades, they open none past what Risk &amp; Safety lets them have out together; and after a losing run of
        their own, measured in R on the tags&apos; shorts, they open none until they are resumed there.
      </p>
    </Card>
  )
}
