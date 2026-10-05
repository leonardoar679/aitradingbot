import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import type { PaperRiskSettings } from '../../shared/ipc'
import {
  PAPER_MAX_OUT_CHOICES,
  PAPER_MIN_STAKE,
  PAPER_RISK_CHOICES,
  healPaperRisk,
  paperOut,
  paperRiskProblem,
  paperStake
} from '../../shared/paperRisk'
import { healPaperDigest } from '../../shared/paperDigest'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { fieldLabelStyle, formButtonStyle, textInputStyle } from '../settings/formStyles'

/** Stops this far from the entry show what a trade sized by risk stakes: the models' stops have
 * mostly been between a half and three percent away. */
const EXAMPLE_STOPS = [0.5, 1, 3]

const amount = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** How the paper trades the app opens by itself -- the watch's and the news rules' -- are sized,
 * and how much they may stake together (shared/paperRisk.ts), and whether a notice tells each day
 * what they did the day before (shared/paperDigest.ts). Kept in settings.json, where those two read
 * it each time they open one. Both sizing settings only ever open less. */
export function PaperRiskCard(): React.JSX.Element {
  const [saved, setSaved] = useState<PaperRiskSettings | null>(null)
  const [draft, setDraft] = useState<PaperRiskSettings | null>(null)
  const [digestSaved, setDigestSaved] = useState<boolean | null>(null)
  const [digest, setDigest] = useState(true)
  const [out, setOut] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  function read(): void {
    window.api.settings.get().then(
      (settings) => {
        const risk = healPaperRisk(settings.paperRisk)
        setSaved(risk)
        setDraft(risk)
        const told = healPaperDigest(settings.paperDigest)
        setDigestSaved(told.enabled)
        setDigest(told.enabled)
        setOut(paperOut(settings.executors, 'USDT'))
      },
      (failure: unknown) => setProblem(describeError(failure))
    )
  }

  useEffect(() => {
    read()
  }, [])

  async function save(): Promise<void> {
    if (draft === null) return
    const invalid = paperRiskProblem(draft)
    if (invalid !== null) {
      setProblem(invalid)
      return
    }
    setBusy(true)
    setDone(false)
    setProblem(null)
    try {
      // The digest's last day told is kept as it is on file: only its switch is the card's.
      await settingsWrites(async () => {
        const fresh = await window.api.settings.get()
        await window.api.settings.set({ paperRisk: draft, paperDigest: { ...healPaperDigest(fresh.paperDigest), enabled: digest } })
      })
      read()
      setDone(true)
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  if (draft === null || saved === null) return <Card title="Paper trades the app opens by itself">{problem ?? 'Loading…'}</Card>

  const examples = EXAMPLE_STOPS.map((stopPct) => `${amount(paperStake({ risk: draft, stakeQuote: Number.POSITIVE_INFINITY, stopPct }))} at a stop ${stopPct}% away`)
  const changed = draft.sizing !== saved.sizing || draft.riskQuote !== saved.riskQuote || draft.maxOutQuote !== saved.maxOutQuote || digest !== digestSaved

  return (
    <Card title="Paper trades the app opens by itself">
      <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 0.9rem', lineHeight: 1.5 }}>
        The watch and the news rules open paper positions with nobody pressing anything, each at the stake set where it is switched on. These two
        settings bound them, and both only ever open less: a trade sized by risk never stakes more than its own stake, and the cap only refuses.
        Trades made by hand on Strategies › Execution are not counted, and the bots hold no paper money: a bot&apos;s run is a replay, measured
        in percent. It is paper; nothing here reaches an order.
      </p>
      <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 180px' }}>
          <label style={fieldLabelStyle()}>Size each trade</label>
          <select
            aria-label="Size each paper trade"
            value={draft.sizing}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, sizing: event.target.value === 'stake' ? 'stake' : 'risk' })}
            style={textInputStyle()}
          >
            <option value="risk">By what its stop would lose</option>
            <option value="stake">At its own stake</option>
          </select>
        </div>
        <div style={{ flex: '1 1 180px' }}>
          <label style={fieldLabelStyle()}>A stop loses about (quote)</label>
          <select
            aria-label="What a paper trade's stop loses"
            value={draft.riskQuote}
            disabled={busy || draft.sizing !== 'risk'}
            onChange={(event) => setDraft({ ...draft, riskQuote: Number(event.target.value) })}
            style={textInputStyle()}
          >
            {PAPER_RISK_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 180px' }}>
          <label style={fieldLabelStyle()}>Out together, at most (quote)</label>
          <select
            aria-label="Paper money out together, at most"
            value={draft.maxOutQuote === null ? 'none' : String(draft.maxOutQuote)}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, maxOutQuote: event.target.value === 'none' ? null : Number(event.target.value) })}
            style={textInputStyle()}
          >
            <option value="none">No cap</option>
            {PAPER_MAX_OUT_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {amount(choice)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0.7rem 0 0', lineHeight: 1.5 }}>
        {draft.sizing === 'risk'
          ? `A trade with a stop stakes what would lose about ${draft.riskQuote} there after a round trip's fees: ${examples.join(', ')}. Never more than its own stake, the watch's or a Monitoring Tag short's, so a near stop is held to that; one that would stake under ${PAPER_MIN_STAKE} is not opened, being less than the smallest order on Binance. A delisting's short has no stop, and stakes its own.`
          : "Each trade stakes its own stake: the watch's, or a news rule's."}{' '}
        {draft.maxOutQuote === null
          ? 'Nothing caps what they stake together.'
          : `The watch and the news rules open nothing that would take what their open paper trades stake together past ${amount(draft.maxOutQuote)}, in a quote asset.`}{' '}
        {out !== null && `Out now: ${amount(out)} USDT in their open paper trades.`}
      </p>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginTop: '0.8rem', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        <input type="checkbox" aria-label="A daily paper digest" checked={digest} disabled={busy} onChange={(event) => setDigest(event.target.checked)} style={{ marginTop: '0.2rem' }} />
        <span>
          A desktop notice each day, the first time the app is open after 00:00 UTC: what they opened and closed the day before, and what each
          closed one made against what it risked at its stop (R). None on a day with nothing to tell, and none caught up on for days the app
          was closed.
        </span>
      </label>
      <div style={{ marginTop: '0.7rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <button onClick={() => void save()} disabled={busy || !changed} style={{ ...formButtonStyle('primary'), opacity: busy || !changed ? 0.6 : 1 }}>
          Save
        </button>
        {done && !changed && <span style={{ fontSize: '0.78rem', color: 'var(--up)' }}>Saved</span>}
        {problem && <span style={{ fontSize: '0.78rem', color: 'var(--down)' }}>{problem}</span>}
      </div>
    </Card>
  )
}
