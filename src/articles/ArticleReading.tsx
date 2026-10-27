import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'
import { useI18n } from '../i18n'
import { Interpolate } from '../i18n/Interpolate'
import { msg } from '../../shared/i18n/translate'
import {
  AI_ADDITION_PROMPT_VERSIONS,
  ARTICLE_READING_LINES,
  latestArticleReadingOf,
  type AiAdditionsStatus,
  type ArticleCallKey,
  type ArticleReading as Reading,
  type ArticleReadingOnFile,
  type ArticleReadingResult
} from '../../shared/aiAdditions'
import { formatUsd } from '../../shared/aiCost'
import { describeDecider } from '../../shared/aiPanel'
import type { UrlRecord } from '../../shared/newsUrl'

const STANCE_WORDS: Record<Reading['stance'], string> = {
  official: msg('an official statement, or one it quotes'),
  reported: msg('reported as fact by its outlet'),
  unconfirmed: msg('unconfirmed: rumour or unnamed sources'),
  opinion: msg('analysis or commentary')
}
const NOVELTY_WORDS: Record<Reading['novelty'], string> = {
  new: msg('new when it was published'),
  known: msg('a repeat of what was already public'),
  unclear: msg('whether it is new cannot be told')
}
const ABOUT_WORDS: Record<Reading['coins'][number]['about'], string> = {
  subject: msg('{coin}: the subject'),
  mentioned: msg('{coin}: mentioned'),
  unrelated: msg('{coin}: unrelated, the rules misread a word')
}
const CALL_WORDS: Record<ArticleCallKey, string> = {
  hour: msg('at least {move} away in an hour'),
  fourHours: msg('at least {move} away in four hours'),
  day: msg('at least {move} away in a day')
}

const label: React.CSSProperties = { fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)' }

/** THE ARTICLE READING (V8 Stage 5, 26 October 2026; shared/aiAdditions.ts): a model's reading of a news link on file,
 * asked only on a click here, at the price shown -- what the article reports, citing its numbered passages, how firmly
 * it says it, whether it is new, which of the coins the rules found it is about, and its size calls on the first of
 * them, each recorded and scored like every source's. It names no side and no trade. Opening the panel asks nothing:
 * it reads the reading on file, the switch and the price. */
export function ArticleReading({ record }: { record: UrlRecord }): React.JSX.Element {
  const i18n = useI18n()
  const { t, pctPlain, utcTime } = i18n
  const [onFile, setOnFile] = useState<ArticleReadingOnFile | null>(null)
  const [status, setStatus] = useState<AiAdditionsStatus | null>(null)
  const [asked, setAsked] = useState<ArticleReadingResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.ai.listCalls({ source: 'addition', promptVersion: AI_ADDITION_PROMPT_VERSIONS.article, limit: 500 }).then(
      (page) => {
        if (!cancelled) setOnFile(latestArticleReadingOf(page.rows, record.id))
      },
      () => undefined
    )
    window.api.ai.additionsStatus().then(
      (read) => {
        if (!cancelled) setStatus(read)
      },
      () => undefined
    )
    return (): void => {
      cancelled = true
    }
  }, [record.id, record.analysisId, asked])

  async function ask(): Promise<void> {
    setBusy(true)
    setProblem(null)
    try {
      setAsked(await window.api.ai.readArticle(record.id))
    } catch (failure) {
      setProblem(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  const subject = record.coins[0] !== undefined && record.coins[0].relationship === 'DIRECT' ? record.coins[0].ticker : null
  const enabled = status?.additions.article === true
  const perCall = status?.perCall.article.usd ?? null
  const model = status?.models.article ?? null
  const outcome = asked?.outcome ?? null
  const shown: { reading: Reading; model: string; at: number | null; cached: boolean; served: string | null } | null =
    outcome?.status === 'answered'
      ? { reading: outcome.answer, model: outcome.model, at: null, cached: outcome.cached, served: null }
      : onFile !== null
        ? { reading: onFile.reading, model: onFile.model, at: onFile.at, cached: false, served: onFile.servedModel }
        : null
  const passage = (n: number): string | null => record.snippets.find((snippet) => snippet.n === n)?.text ?? null

  return (
    <Card title={t('Article reading')}>
      <p style={{ ...noteStyle, marginTop: 0 }}>
        {subject === null
          ? t('A model reads the article, only when you click, at the price shown: what it reports, citing its numbered passages, how firmly it says it, whether it is new, and which of the coins the rules found it is about. With no coin in its title it makes no size call. It names no side and no trade, and nothing else in the app reads it.')
          : t('A model reads the article, only when you click, at the price shown: what it reports, citing its numbered passages, how firmly it says it, whether it is new, and which of the coins the rules found it is about. Its calls that {coin} closes at least 1% away in an hour, 2% in four hours or 5% in a day, either way, are recorded and scored like every source. It names no side and no trade, and nothing else in the app reads it.', { coin: subject })}
      </p>
      {record.snippets.length === 0 && <p style={noteStyle}>{t('Nothing of the article was read, so there is nothing to put to a model.')}</p>}
      {shown !== null && <ReadingView reading={shown.reading} subject={subject} passage={passage} />}
      {shown !== null && (
        <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
          {shown.at !== null
            ? t('Read by {model} at {time} UTC, {confidence} sure.', { model: describeDecider(shown.model, i18n), time: utcTime(shown.at * 1000), confidence: pctPlain(Math.round(shown.reading.confidence * 100), 0) })
            : shown.cached
              ? t('Read by {model}, {confidence} sure, already held: nothing was paid.', { model: describeDecider(shown.model, i18n), confidence: pctPlain(Math.round(shown.reading.confidence * 100), 0) })
              : t('Read by {model}, {confidence} sure.', { model: describeDecider(shown.model, i18n), confidence: pctPlain(Math.round(shown.reading.confidence * 100), 0) })}
          {shown.served !== null && shown.served !== shown.model ? ` ${t('Answered by {served}.', { served: shown.served })}` : ''}
        </p>
      )}
      {asked !== null && asked.predictionIds.length > 0 && (
        <p style={{ ...noteStyle, marginTop: '0.3rem' }}>
          <Interpolate text={t("Recorded as {ids}; each is settled from the venue's bars when its horizon ends.")} values={{ ids: <code>{asked.predictionIds.join(', ')}</code> }} />
        </p>
      )}
      {asked?.note != null && <p style={{ ...noteStyle, marginTop: '0.3rem' }}>{asked.note}</p>}
      {asked !== null && !asked.asked && <p style={{ ...noteStyle, marginTop: '0.3rem' }}>{t('Nothing of the article was read, so there is nothing to put to a model.')}</p>}
      {outcome?.status === 'refused' && <p style={{ ...noteStyle, marginTop: '0.35rem', color: 'var(--down)' }}>{t('The answer was refused and is not shown: {reason}', { reason: outcome.reason })}</p>}
      {(outcome?.status === 'skipped' || outcome?.status === 'failed') && <p style={{ ...noteStyle, marginTop: '0.35rem' }}>{t('Not asked: {reason}', { reason: outcome.reason })}</p>}
      {problem !== null && <p style={{ ...noteStyle, marginTop: '0.35rem', color: 'var(--down)' }}>{problem}</p>}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
        <button onClick={() => void ask()} disabled={busy || !enabled || record.snippets.length === 0} style={buttonStyle('secondary', busy || !enabled || record.snippets.length === 0)}>
          {busy
            ? t('Asking…')
            : model === null
              ? t('Read it with a model')
              : perCall === null
                ? t('Read it with {model}', { model: describeDecider(model, i18n) })
                : t('Read it with {model} · about {cost}', { model: describeDecider(model, i18n), cost: formatUsd(perCall, i18n) })}
        </button>
        <span style={noteStyle}>
          {status === null
            ? ''
            : enabled
              ? t('{count} of {limit} today, inside the daily AI budget.', { count: status.today.article, limit: status.limits.article })
              : t('The article reading is switched off under Settings › AI.')}
        </span>
      </div>
    </Card>
  )
}

/** A reading: its summary and the passages it cites, how firmly the article says it and whether it is new, what each
 * coin is to it, and its size calls. Its own words are the model's, in English. */
export function ReadingView({ reading, subject, passage }: { reading: Reading; subject: string | null; passage: (n: number) => string | null }): React.JSX.Element {
  const { t, pctPlain } = useI18n()
  return (
    <div style={{ display: 'grid', gap: '0.45rem' }}>
      <p lang="en" dir="auto" style={{ margin: 0, fontSize: '0.86rem', color: 'var(--text-primary)', lineHeight: 1.5 }}>
        {reading.summary}
      </p>
      {reading.instructions && <p style={{ ...noteStyle, margin: 0, color: 'var(--down)' }}>{t('The article holds text addressed to whoever reads it, rather than news: the reading did not follow it.')}</p>}
      <div>
        <div style={label}>{t('It rests on')}</div>
        <ul lang="en" dir="auto" style={{ margin: '0.2rem 0 0', paddingInlineStart: '1.1rem', fontSize: '0.78rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {reading.cites.map((n) => (
            <li key={n}>
              {n}. {passage(n) ?? '—'}
            </li>
          ))}
        </ul>
      </div>
      <div style={{ ...noteStyle, margin: 0 }}>
        {t('How it says it: {stance}. Whether it is new: {novelty}.', { stance: t(STANCE_WORDS[reading.stance]), novelty: t(NOVELTY_WORDS[reading.novelty]) })}
      </div>
      {reading.coins.length > 0 && <div style={{ ...noteStyle, margin: 0 }}>{reading.coins.map((coin) => t(ABOUT_WORDS[coin.about], { coin: coin.ticker })).join(' · ')}</div>}
      {subject !== null && (
        <div style={{ ...noteStyle, margin: 0 }}>
          {ARTICLE_READING_LINES.calls.map((call) => (
            <div key={call.key}>
              {reading.bigMove[call.key]
                ? t('Likely: {coin} closes {where}.', { coin: subject, where: t(CALL_WORDS[call.key], { move: pctPlain(call.movePct, 0) }) })
                : t('Not called: {coin} closes {where}.', { coin: subject, where: t(CALL_WORDS[call.key], { move: pctPlain(call.movePct, 0) }) })}
            </div>
          ))}
        </div>
      )}
      {reading.reasons.trim() !== '' && (
        <p lang="en" dir="auto" style={{ ...noteStyle, margin: 0 }}>
          {reading.reasons}
        </p>
      )}
    </div>
  )
}
