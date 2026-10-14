import { useEffect, useRef, useState } from 'react'
import { AI_ADDITION_PROMPT_VERSIONS, latestWhyOf, type MoveConclusion, type WhyEvidence, type WhyOnFile } from '../../shared/aiAdditions'
import { formatUsd } from '../../shared/aiCost'
import { describeDecider } from '../../shared/aiPanel'
import { describeError } from '../utils/ipcError'
import { buttonStyle, noteStyle } from './agentStyles'
import { useI18n } from '../i18n'

/** A conclusion on file is shown while it is this recent. */
const ON_FILE_SECONDS = 3600

function Cited({ cites, evidence }: { cites: string[]; evidence: WhyEvidence[] | null }): React.JSX.Element {
  return (
    <ul lang="en" style={{ margin: '0.3rem 0 0', paddingInlineStart: '1.1rem', fontSize: '0.76rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
      {cites.map((cite) => (
        <li key={cite}>{evidence?.find((item) => item.id === cite)?.text ?? cite}</li>
      ))}
    </ul>
  )
}

/** The AI's conclusion to "Why did it move?" (shared/aiAdditions.ts), under the fixed rules'
 * explanation: the newest on file for the pair, if one is recent, and a button that asks for one at
 * the price shown. The main process rebuilds the evidence from candles and the stories it holds; the
 * conclusion has to cite what it rests on, or it is dropped. It asks only on a click, and places
 * nothing. */
export function WhyConclusion({ symbol, onFound }: { symbol: string; onFound?: (found: WhyOnFile | null) => void }): React.JSX.Element {
  const i18n = useI18n()
  const { t, pctPlain, utcTime } = i18n
  const [onFile, setOnFile] = useState<WhyOnFile | null>(null)
  /** Hands what is on file up to the view above, for its timeline (since 8 October 2026). */
  const handUp = useRef(onFound)
  handUp.current = onFound
  const [perCall, setPerCall] = useState<number | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [asked, setAsked] = useState<MoveConclusion | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const sinceSec = Math.floor(Date.now() / 1000) - ON_FILE_SECONDS
    window.api.ai.listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.why, symbol, sinceSec, limit: 50 }).then(
      (page) => {
        if (cancelled) return
        const found = latestWhyOf(page.rows, symbol)
        setOnFile(found)
        handUp.current?.(found)
      },
      () => undefined
    )
    window.api.ai.additionsStatus().then(
      (status) => {
        if (cancelled) return
        setPerCall(status.perCall.why.usd)
        setEnabled(status.additions.why)
      },
      () => undefined
    )
    return (): void => {
      cancelled = true
    }
  }, [symbol])

  async function ask(): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      setAsked(await window.api.ai.concludeMove(symbol))
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const outcome = asked?.outcome ?? null
  return (
    <div style={{ marginTop: '0.9rem', paddingTop: '0.8rem', borderTop: '1px solid var(--border)' }}>
      <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>{t('AI conclusion')}</div>
      {asked === null && onFile !== null && (
        <div style={{ marginTop: '0.35rem' }}>
          <p lang="en" dir="auto" style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-primary)', lineHeight: 1.5 }}>
            {onFile.conclusion.conclusion}
          </p>
          <p style={{ ...noteStyle, marginTop: '0.2rem' }}>
            {t('AI summary: {model} at {time} UTC, {confidence} sure, citing {count} items of the evidence then.', {
              model: describeDecider(onFile.model, i18n),
              time: utcTime(onFile.at * 1000),
              confidence: pctPlain(Math.round(onFile.conclusion.confidence * 100), 0),
              count: onFile.conclusion.cites.length
            })}
          </p>
        </div>
      )}
      {asked !== null && outcome === null && (
        <p style={{ ...noteStyle, marginTop: '0.35rem' }}>
          {asked.explanation.movePct === null
            ? t('Nothing to conclude: its minutes could not be read. No model was asked.')
            : asked.question === null && asked.explanation.causes.length === 0
              ? t('Nothing to conclude: the rules found no evidence to weigh. No model was asked.')
              : t('Nothing to conclude: the move is under half a percent. No model was asked.')}
        </p>
      )}
      {outcome?.status === 'answered' && (
        <div style={{ marginTop: '0.35rem' }}>
          <p lang="en" dir="auto" style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-primary)', lineHeight: 1.5 }}>
            {outcome.answer.conclusion}
          </p>
          <p style={{ ...noteStyle, marginTop: '0.2rem' }}>
            {outcome.cached
              ? t('AI summary: {model}, {confidence} sure, already held: nothing was paid. It rests on:', { model: describeDecider(outcome.model, i18n), confidence: pctPlain(Math.round(outcome.answer.confidence * 100), 0) })
              : t('AI summary: {model}, {confidence} sure. It rests on:', { model: describeDecider(outcome.model, i18n), confidence: pctPlain(Math.round(outcome.answer.confidence * 100), 0) })}
          </p>
          <Cited cites={outcome.answer.cites} evidence={asked?.question?.evidence ?? null} />
        </div>
      )}
      {outcome?.status === 'refused' && <p style={{ ...noteStyle, marginTop: '0.35rem', color: 'var(--down)' }}>{t('The answer was refused and is not shown: {reason}', { reason: outcome.reason })}</p>}
      {(outcome?.status === 'skipped' || outcome?.status === 'failed') && <p style={{ ...noteStyle, marginTop: '0.35rem' }}>{t('Not asked: {reason}', { reason: outcome.reason })}</p>}
      {problem !== null && <p style={{ ...noteStyle, marginTop: '0.35rem', color: 'var(--down)' }}>{problem}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
        <button onClick={() => void ask()} disabled={busy || !enabled} style={buttonStyle('secondary', busy || !enabled)}>
          {busy ? t('Asking…') : perCall === null ? t('Ask for a conclusion') : t('Ask for a conclusion · about {cost}', { cost: formatUsd(perCall, i18n) })}
        </button>
        <span style={noteStyle}>{enabled ? t('It may cite only the evidence the rules found; one that cites anything else is dropped.') : t('The conclusion is switched off under Settings › AI.')}</span>
      </div>
    </div>
  )
}
