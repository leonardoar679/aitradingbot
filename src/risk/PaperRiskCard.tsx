import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import type { ExecutorConfig, PaperAccount, PaperPauseSettings, PaperRiskSettings } from '../../shared/ipc'
import { describeCorrelatedExposure } from '../../shared/paperExposure'
import {
  PAPER_MAX_OUT_CHOICES,
  PAPER_MIN_STAKE,
  PAPER_RISK_CHOICES,
  PAPER_RISK_PCT_CHOICES,
  healPaperRisk,
  paperEquity,
  paperOut,
  paperRiskProblem,
  paperStake
} from '../../shared/paperRisk'
import { healPaperDigest } from '../../shared/paperDigest'
import {
  PAPER_PAUSE_LOSS_CHOICES,
  PAPER_PAUSE_SOURCES,
  PAPER_PAUSE_TRADE_CHOICES,
  describePaperPauseStanding,
  healPaperPause,
  paperPauseProblem,
  resumePaperPause,
  savePaperPause,
  type PaperPauseSource
} from '../../shared/paperPause'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { fieldLabelStyle, formButtonStyle, textInputStyle } from '../settings/formStyles'

/** Stops this far from the entry show what a trade sized by risk stakes: the models' stops have
 * mostly been between a half and three percent away. */
const EXAMPLE_STOPS = [0.5, 1, 3]

const amount = (value: number): string => value.toLocaleString('en-US', { maximumFractionDigits: 2 })

const noteStyle: React.CSSProperties = { fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0.7rem 0 0', lineHeight: 1.5 }

/** How the paper trades the app opens by itself -- the watch's and the news rules' -- are sized,
 * how much they may stake together (shared/paperRisk.ts), the losing run that pauses them until
 * they are resumed here (shared/paperPause.ts), and whether a notice tells each day what they did
 * the day before (shared/paperDigest.ts). Kept in settings.json, where those two read it each time
 * they open one. Every one of them only ever opens less. */
export function PaperRiskCard(): React.JSX.Element {
  const [saved, setSaved] = useState<PaperRiskSettings | null>(null)
  const [draft, setDraft] = useState<PaperRiskSettings | null>(null)
  const [digestSaved, setDigestSaved] = useState<boolean | null>(null)
  const [digest, setDigest] = useState(true)
  /** The pause as it is on file, each side's state with it; and the loss and run being chosen. */
  const [pause, setPause] = useState<PaperPauseSettings | null>(null)
  const [pauseDraft, setPauseDraft] = useState<Pick<PaperPauseSettings, 'lossR' | 'trades'> | null>(null)
  const [executors, setExecutors] = useState<ExecutorConfig[]>([])
  const [account, setAccount] = useState<PaperAccount | null>(null)
  const [out, setOut] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  /** Reads what is on file. After a Resume, the choices being made are kept as they are. */
  function read(keepDrafts = false): void {
    window.api.settings.get().then(
      (settings) => {
        const paused = healPaperPause(settings.paperPause)
        setPause(paused)
        setExecutors(settings.executors)
        setAccount(settings.paperAccount ?? null)
        setOut(paperOut(settings.executors, 'USDT'))
        if (keepDrafts) return
        setPauseDraft({ lossR: paused.lossR, trades: paused.trades })
        const risk = healPaperRisk(settings.paperRisk)
        setSaved(risk)
        setDraft(risk)
        const told = healPaperDigest(settings.paperDigest)
        setDigestSaved(told.enabled)
        setDigest(told.enabled)
      },
      (failure: unknown) => setProblem(describeError(failure))
    )
  }

  useEffect(() => {
    read()
  }, [])

  async function save(): Promise<void> {
    if (draft === null || pauseDraft === null) return
    const invalid = paperRiskProblem(draft) ?? paperPauseProblem(pauseDraft)
    if (invalid !== null) {
      setProblem(invalid)
      return
    }
    setBusy(true)
    setDone(false)
    setProblem(null)
    try {
      // The digest's last day told, and each side's pause, are kept as they are on file: only the
      // switch, the loss and the run are the card's -- and switched off, a pause is lifted.
      await settingsWrites(async () => {
        const fresh = await window.api.settings.get()
        await window.api.settings.set({
          paperRisk: draft,
          paperDigest: { ...healPaperDigest(fresh.paperDigest), enabled: digest },
          paperPause: savePaperPause(healPaperPause(fresh.paperPause), pauseDraft)
        })
      })
      read()
      setDone(true)
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  /** Lifts one side's pause, and counts its run again from now. */
  async function resume(source: PaperPauseSource): Promise<void> {
    setBusy(true)
    setDone(false)
    setProblem(null)
    try {
      await settingsWrites(async () => {
        const fresh = await window.api.settings.get()
        await window.api.settings.set({ paperPause: resumePaperPause(healPaperPause(fresh.paperPause), source, Math.floor(Date.now() / 1000)) })
      })
      read(true)
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  if (draft === null || saved === null || pause === null || pauseDraft === null) {
    return <Card title="Paper trades the app opens by itself">{problem ?? 'Loading…'}</Card>
  }

  // The equity a share is taken of, as it stands now: the USDT balance and what is out.
  const equity = paperEquity(account, 'USDT')
  const examples = EXAMPLE_STOPS.map((stopPct) => `${amount(paperStake({ risk: draft, stakeQuote: Number.POSITIVE_INFINITY, stopPct, equityQuote: equity }))} at a stop ${stopPct}% away`)
  const changed =
    draft.sizing !== saved.sizing ||
    draft.riskQuote !== saved.riskQuote ||
    draft.riskPct !== saved.riskPct ||
    draft.maxOutQuote !== saved.maxOutQuote ||
    digest !== digestSaved ||
    pauseDraft.lossR !== pause.lossR ||
    pauseDraft.trades !== pause.trades
  const daily = "The watch's pause for the day, after losses in a row, is apart from this, and set with its paper trades on Opportunities."

  return (
    <Card title="Paper trades the app opens by itself">
      <p style={{ ...noteStyle, margin: '0 0 0.9rem' }}>
        The watch and the news rules open paper positions with nobody pressing anything, each at the stake set where it is switched on. These
        settings bound them, and every one only ever opens less: a trade sized by risk never stakes more than its own stake, the cap only refuses,
        and a losing run only pauses. Trades made by hand on Strategies › Execution are not counted, and the bots hold no paper money: a
        bot&apos;s run is a replay, measured in percent. It is paper; nothing here reaches an order.
      </p>
      <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 180px' }}>
          <label style={fieldLabelStyle()}>Size each trade</label>
          <select
            aria-label="Size each paper trade"
            value={draft.sizing}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, sizing: event.target.value === 'stake' ? 'stake' : event.target.value === 'equity' ? 'equity' : 'risk' })}
            style={textInputStyle()}
          >
            <option value="risk">By what its stop would lose</option>
            <option value="equity">By a share of the paper account</option>
            <option value="stake">At its own stake</option>
          </select>
        </div>
        <div style={{ flex: '1 1 180px' }}>
          <label style={fieldLabelStyle()}>Of the paper account, a stop loses (%)</label>
          <select
            aria-label="What share of the paper account a paper trade's stop loses"
            value={draft.riskPct}
            disabled={busy || draft.sizing !== 'equity'}
            onChange={(event) => setDraft({ ...draft, riskPct: Number(event.target.value) })}
            style={textInputStyle()}
          >
            {PAPER_RISK_PCT_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}%
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 180px' }}>
          <label style={fieldLabelStyle()}>A stop loses about (quote)</label>
          <select
            aria-label="What a paper trade's stop loses"
            value={draft.riskQuote}
            disabled={busy || draft.sizing === 'stake'}
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
      <p style={noteStyle}>
        {draft.sizing === 'risk'
          ? `A trade with a stop stakes what would lose about ${draft.riskQuote} there after a round trip's fees: ${examples.join(', ')}. Never more than its own stake, the watch's or a Monitoring Tag short's, so a near stop is held to that; one that would stake under ${PAPER_MIN_STAKE} is not opened, being less than the smallest order on Binance. A delisting's short has no stop, and stakes its own.`
          : draft.sizing === 'equity'
            ? `A trade with a stop stakes what would lose about ${draft.riskPct}% of the paper account's equity there after a round trip's fees${equity === null ? ` -- with no paper account in USDT, about ${draft.riskQuote}, as sized by risk` : `: ${amount((equity * draft.riskPct) / 100)} on ${amount(equity)} USDT now, its balance and what its own trades have out`}: ${examples.join(', ')}. Never more than its own stake, so a near stop is held to that; one that would stake under ${PAPER_MIN_STAKE} is not opened. A delisting's short has no stop, and stakes its own.`
            : "Each trade stakes its own stake: the watch's, or a news rule's."}{' '}
        {draft.maxOutQuote === null
          ? 'Nothing caps what they stake together.'
          : `The watch and the news rules open nothing that would take what their open paper trades stake together past ${amount(draft.maxOutQuote)}, in a quote asset.`}{' '}
        {out !== null && `Out now: ${amount(out)} USDT in their open paper trades.`}{' '}
        {/* Since 6 October 2026: one side, on coins that move with Bitcoin (shared/paperExposure.ts). */}
        {describeCorrelatedExposure({ account, risk: draft, quoteAsset: 'USDT' })}
      </p>

      <div style={{ display: 'flex', gap: '0.7rem', flexWrap: 'wrap', marginTop: '1rem' }}>
        <div style={{ flex: '1 1 180px' }}>
          <label style={fieldLabelStyle()}>Pause after a losing run of</label>
          <select
            aria-label="The losing run that pauses paper trades"
            value={pauseDraft.lossR === null ? 'never' : String(pauseDraft.lossR)}
            disabled={busy}
            onChange={(event) => setPauseDraft({ ...pauseDraft, lossR: event.target.value === 'never' ? null : Number(event.target.value) })}
            style={textInputStyle()}
          >
            <option value="never">Never</option>
            {PAPER_PAUSE_LOSS_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice} R lost
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 180px' }}>
          <label style={fieldLabelStyle()}>Over the last (closed trades)</label>
          <select
            aria-label="Closed trades the losing run is counted over"
            value={pauseDraft.trades}
            disabled={busy || pauseDraft.lossR === null}
            onChange={(event) => setPauseDraft({ ...pauseDraft, trades: Number(event.target.value) })}
            style={textInputStyle()}
          >
            {PAPER_PAUSE_TRADE_CHOICES.map((choice) => (
              <option key={choice} value={choice}>
                {choice}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p style={noteStyle}>
        {pauseDraft.lossR === null
          ? `No losing run pauses them, and switched off, a pause is lifted. ${daily}`
          : `The watch and the news rules are each judged on their own record. When the last ${pauseDraft.trades} paper trades one of them closed with a stop lost ${pauseDraft.lossR} R or more together, it opens none until it is resumed here, and a desktop notice says so once; any still open run to their end. R is what a trade made over what its stop would have lost, so a delisting's short, which has no stop, is not counted. Resuming starts the count again. ${daily}`}
      </p>
      {PAPER_PAUSE_SOURCES.map((source) => {
        const standing = describePaperPauseStanding({ setting: pause, executors, source })
        return (
          <div key={source} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.45rem' }}>
            <span style={{ fontSize: '0.8rem', color: standing.paused ? 'var(--down)' : 'var(--text-secondary)', lineHeight: 1.5 }}>{standing.text}</span>
            {standing.paused && (
              <button
                aria-label={source === 'watch' ? "Resume the watch's paper trades" : "Resume the news rules' paper shorts"}
                onClick={() => void resume(source)}
                disabled={busy}
                style={{ ...formButtonStyle('secondary'), padding: '0.35rem 0.7rem', opacity: busy ? 0.6 : 1 }}
              >
                Resume
              </button>
            )}
          </div>
        )
      })}

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', marginTop: '1rem', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
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
