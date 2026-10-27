import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { useLiveMarket } from '../hooks/useLiveMarket'
import { Interpolate } from '../i18n/Interpolate'
import { useI18n } from '../i18n'
import { msg, type I18n } from '../../shared/i18n/translate'
import { userViewProposal, type AiOrderProposal } from '../../shared/aiProposal'
import { SOURCE_RECORD_VERSION, dayUnitOf, sourcePredictionId, type SourcePrediction } from '../../shared/evaluation/predictionRecord'
import { describeEventType, storyKindWord } from '../../shared/newsFeed'
import type { UrlRecord } from '../../shared/newsUrl'
import type { PublicationTime } from '../../shared/articleTime'
import { pairWords } from '../calls/callText'
import { ArticleReading } from './ArticleReading'

// NEWS URLS (V8 Stage 4, 26 October 2026; electron/services/newsUrlService.ts). A person pastes a news link; the app
// reads it safely and keeps what it found: its text and where that came from, when it was published, who says it, the
// coins it names and what their prices did, and the verdict -- a card where a measured source has one, otherwise "No
// profitable opportunity identified". Since V8 Stage 5 a model's reading of it on a click (ArticleReading.tsx, the one
// file of the page that reaches the AI bridge), and the page in the person's language; what the record keeps in its own
// words -- the steps it took, why a page could not be read -- is shown as written. "Paper trade my own view" records a
// view of the person's own, nothing filled in by the app, and opens the Position form with it for them to place on
// paper.

const CREDIBILITY_WORDS: Record<UrlRecord['credibility'], string> = {
  exchange: msg('an exchange speaking of its own markets'),
  regulator: msg('a regulator'),
  outlet: msg('a news outlet'),
  project: msg("a project's own site"),
  social: msg('a social network, where anyone posts'),
  unknown: msg('a site the app does not know')
}

const RETRIEVAL_WORDS: Record<UrlRecord['retrieval'], string> = {
  fetched: msg('read from the page'),
  feed: msg("the news feed's own copy"),
  announcement: msg("Binance's own list"),
  supplied: msg('supplied by you, not retrieved'),
  'x-post': msg('a post on X: not fetched'),
  none: msg('no text could be had')
}

const TIME_SOURCE_WORDS: Record<NonNullable<PublicationTime['source']>, string> = {
  jsonld: msg("the page's structured data"),
  og: msg("the page's Open Graph tags"),
  byline: msg('its dated byline'),
  meta: msg("another of the page's meta tags"),
  announcement: msg("Binance's own list"),
  'x-id': msg("the post's id"),
  feed: msg("the news feed's copy")
}

const REJECTED_WORDS: Record<UrlRecord['rejected'][number]['why'], string> = {
  'no-pair': msg('{coin} (no USDT pair here)'),
  thin: msg('{coin} (under 1M USDT traded a day)'),
  'over-cap': msg('{coin} (past the five kept)')
}

const HORIZONS: { sec: number; label: string }[] = [
  { sec: 3600, label: msg('1 hour') },
  { sec: 4 * 3600, label: msg('4 hours') },
  { sec: 86_400, label: msg('1 day') }
]

const row: React.CSSProperties = { display: 'flex', gap: '1rem', padding: '0.22rem 0', alignItems: 'baseline', flexWrap: 'wrap' }
const label: React.CSSProperties = { fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', flex: '0 0 9.5rem' }
const value: React.CSSProperties = { fontSize: '0.86rem', flex: '1 1 18rem', minWidth: 0 }

function Line({ name, children }: { name: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={row}>
      <span style={label}>{name}</span>
      <span style={value}>{children}</span>
    </div>
  )
}

/** A moment in UTC with its day: "14:05 UTC on 26 Oct". */
const momentText = (seconds: number, { t, utcTime, utcDay }: I18n): string => t('{time} UTC on {day}', { time: utcTime(seconds * 1000), day: utcDay(seconds * 1000) })

/** When it was published, how that was read, and what checks it. */
function publishedText(time: PublicationTime | null, i18n: I18n): string {
  const { t } = i18n
  if (time === null || time.sec === null) return t('Not read: the price is not measured from it.')
  const parts = [t('{moment}, from {where}', { moment: momentText(time.sec, i18n), where: time.source === null ? '—' : t(TIME_SOURCE_WORDS[time.source]) })]
  if (time.disagree) parts.push(t('the page gives times more than an hour apart'))
  if (time.future.length > 0) parts.push(t('{count} times after the page was read refused', { count: time.future.length }))
  if (time.check !== null) {
    parts.push(
      time.check.source === 'announcement'
        ? time.check.agrees
          ? t("the announcement's own time agrees")
          : t("the announcement's own time disagrees")
        : time.check.agrees
          ? t("the feed's own time agrees")
          : t("the feed's own time disagrees")
    )
  }
  return parts.join(' · ')
}

/** Parts of a line, a dot between each. */
function Dotted({ parts }: { parts: React.ReactNode[] }): React.JSX.Element {
  return (
    <>
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? ' · ' : ''}
          {part}
        </span>
      ))}
    </>
  )
}

/** The lookups made after the paste, each named: the Internet Archive's first capture, and a post on X's author, whose
 * name is shown as X gives it. */
function lookupParts(record: UrlRecord, i18n: I18n): React.ReactNode[] {
  const { t } = i18n
  const lookups = record.lookups
  if (lookups === undefined) return [record.origin === 'automatic' ? t('none: a discovered story is recorded from the feed alone') : t('being made…')]
  const archive = lookups.archive
  const parts: React.ReactNode[] = [
    archive === null
      ? t('the Internet Archive: not asked')
      : archive.status === 'found' && archive.firstSec !== null
        ? archive.note === null
          ? t('the Internet Archive first captured it at {moment}, so it was published by then', { moment: momentText(archive.firstSec, i18n) })
          : t("the Internet Archive first captured it at {moment}, before the time it states: its stated time may be a later edit's", { moment: momentText(archive.firstSec, i18n) })
        : archive.status === 'none'
          ? t('the Internet Archive holds no capture of it')
          : archive.status === 'off'
            ? t('the Internet Archive: switched off')
            : t('the Internet Archive could not be asked')
  ]
  if (lookups.x !== null) {
    parts.push(lookups.x.status === 'found' ? <Interpolate text={t("X's embed names its author {name}")} values={{ name: <bdi dir="auto">{lookups.x.name ?? '—'}</bdi> }} /> : t("X's embed could not be read"))
  }
  return parts
}

/** Why there is no card, from the record: no coin to weigh, a delisting outside its rule's window, or no measured source
 * for news of its kind (as electron/services/newsUrlService.ts wrote it, in the person's language). */
function noCardText(record: UrlRecord, i18n: I18n): string {
  const { t } = i18n
  if (record.coins.length === 0) return t('No coin it names can be weighed here.')
  if (record.binance?.delisting === true) return t("A Binance delisting is a card only within its rule's five minutes, on a fresh book that holds the stake.")
  return t('No measured source calls a way for news of this kind ({kind}).', { kind: storyKindWord(record.kind, i18n) })
}

/** One record: what was read, when it was published, who says it, its coins and their prices, and the verdict. */
export function RecordView({ record }: { record: UrlRecord }): React.JSX.Element {
  const i18n = useI18n()
  const { t, pct, utcTime, dollars } = i18n
  const signed = (x: number | null): string => (x === null ? '—' : pct(x, 2))
  // What the record holds as it was written -- its host, a title, the feed's sources, an author -- is shown as written.
  const source: React.ReactNode[] = [
    <>
      <bdi dir="ltr">{record.host}</bdi>: {t(CREDIBILITY_WORDS[record.credibility])}
    </>
  ]
  if (record.binance !== null) source.push(<Interpolate text={t("a Binance announcement verified in Binance's own list ({title})")} values={{ title: <bdi dir="auto">{record.binance.title}</bdi> }} />)
  if (record.corroboration.stories > 0) {
    source.push(<Interpolate text={t('told too by {count} other stories of the feed ({sources})', { count: record.corroboration.stories })} values={{ sources: <bdi dir="auto">{record.corroboration.sources.join(', ')}</bdi> }} />)
  }
  const text: React.ReactNode[] = [t(RETRIEVAL_WORDS[record.retrieval])]
  if (record.author !== null) text.push(<Interpolate text={t('by {author}')} values={{ author: <bdi dir="auto">{record.author}</bdi> }} />)
  if (record.readFailure !== null) {
    text.push(
      <>
        {t('the page could not be read:')}{' '}
        <span lang="en" dir="auto">
          {record.readFailure}
        </span>
      </>
    )
  }
  return (
    <div>
      <p lang="en" dir="auto" style={{ margin: 0, fontWeight: 700, fontSize: '1.02rem' }}>
        {record.title ?? record.url}
      </p>
      <p lang="en" dir="ltr" style={{ ...noteStyle, marginTop: '0.2rem' }}>
        {record.url}
      </p>
      <div style={{ marginTop: '0.5rem' }}>
        <Line name={t('Source')}>
          <Dotted parts={source} />
        </Line>
        <Line name={t('Text')}>
          <Dotted parts={text} />
        </Line>
        <Line name={t('Published')}>{publishedText(record.time, i18n)}</Line>
        <Line name={t('Kind')}>{describeEventType(record.kind, i18n)}</Line>
        <Line name={t('Lookups')}>
          <Dotted parts={lookupParts(record, i18n)} />
        </Line>
        <Line name={t('Coins')}>
          {record.coins.length === 0
            ? t('none it names can be weighed here')
            : record.coins.map((coin) => (coin.relationship === 'DIRECT' ? t('{coin} (in its title, {venue})', { coin: coin.ticker, venue: coin.venue === 'binance' ? 'Binance' : 'Bitget' }) : t('{coin} (in its body, {venue})', { coin: coin.ticker, venue: coin.venue === 'binance' ? 'Binance' : 'Bitget' }))).join(', ')}
          {record.rejected.length > 0 ? ` · ${t('left out: {coins}', { coins: record.rejected.map((coin) => t(REJECTED_WORDS[coin.why], { coin: coin.ticker })).join(', ') })}` : ''}
        </Line>
      </div>
      {record.reactions.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {[msg('Coin'), msg('At publication'), msg('The day before'), msg('+5 min'), msg('+15 min'), msg('+1 hour'), msg('+4 hours'), ''].map((name) => (
                  <th key={name} style={headCellStyle}>
                    {name === '' ? '' : t(name)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {record.reactions.map((reaction) => (
                <tr key={reaction.pair}>
                  <td dir="ltr" style={{ ...cellStyle, fontWeight: 600 }}>
                    {pairWords(reaction.pair)}
                  </td>
                  <td style={cellStyle}>{reaction.refPrice === null ? '—' : dollars(reaction.refPrice)}</td>
                  <td style={cellStyle}>{signed(reaction.beforePct)}</td>
                  <td style={cellStyle}>{signed(reaction.afterPct.m5)}</td>
                  <td style={cellStyle}>{signed(reaction.afterPct.m15)}</td>
                  <td style={cellStyle}>{signed(reaction.afterPct.h1)}</td>
                  <td style={cellStyle}>{signed(reaction.afterPct.h4)}</td>
                  <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>{reaction.final ? t('final') : t('measured until four hours after')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: '0.7rem', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-app)', border: '1px solid var(--border)' }}>
        {record.verdict.cards.length > 0 ? (
          <span>
            <strong>{t('A card:')} </strong>
            <Interpolate text={t('{cards} — on Home and Predictions, with its figures.')} values={{ cards: <code>{record.verdict.cards.join(', ')}</code> }} />
          </span>
        ) : (
          <span>
            <strong>{t('No profitable opportunity identified.')} </strong>
            {noCardText(record, i18n)}
          </span>
        )}
      </div>
      {record.snippets.length > 0 && (
        <details style={{ marginTop: '0.6rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.82rem' }}>{t('The text read, in {count} numbered passages', { count: record.snippets.length })}</summary>
          <ol lang="en" dir="auto" style={{ margin: '0.4rem 0 0', paddingInlineStart: '1.4rem', display: 'grid', gap: '0.3rem' }}>
            {record.snippets.map((snippet) => (
              <li key={snippet.n} value={snippet.n} style={{ fontSize: '0.8rem' }}>
                {snippet.text}
              </li>
            ))}
          </ol>
        </details>
      )}
      <details style={{ marginTop: '0.4rem' }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.82rem' }}>{t('What was done, step by step')}</summary>
        <ul style={{ margin: '0.4rem 0 0', paddingInlineStart: '1.2rem' }}>
          {record.trail.map((entry, index) => (
            <li key={index} style={{ fontSize: '0.8rem' }}>
              {t('{time} UTC', { time: utcTime(entry.at * 1000) })} ·{' '}
              <span lang="en" dir="auto">
                {entry.note}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

/** "Paper trade my own view": the person's side, stake, horizon and target, nothing filled in; recorded as their own
 * prediction and handed to the Position form for them to place on paper. */
export function OwnView({ record, onPrepareOrder }: { record: UrlRecord; onPrepareOrder: (proposal: AiOrderProposal) => void }): React.JSX.Element | null {
  const { t, dollars } = useI18n()
  const [pair, setPair] = useState('')
  const [side, setSide] = useState<'' | 'up' | 'down'>('')
  const [stake, setStake] = useState('')
  const [horizon, setHorizon] = useState('')
  const [target, setTarget] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const live = useLiveMarket(pair === '' ? [] : [pair])
  if (record.coins.length === 0) return null
  const book = pair === '' ? undefined : live?.books[pair]
  const price = book !== undefined && book.bid > 0 && book.ask > 0 ? (book.bid + book.ask) / 2 : null
  const submit = async (): Promise<void> => {
    const stakeQuote = Number(stake)
    const targetPct = Number(target)
    const horizonSec = Number(horizon)
    if (pair === '' || side === '' || !(stakeQuote > 0) || !(targetPct > 0) || !(horizonSec > 0)) return setProblem(t('Choose the coin, the side, the stake, the horizon and the target: nothing is filled in for you.'))
    if (price === null) return setProblem(t('No live price of the coin is read yet; try again in a moment.'))
    const nowSec = Math.floor(Date.now() / 1000)
    const config = await window.api.effectiveConfig().catch(() => null)
    const coin = record.coins.find((entry) => entry.pair === pair)
    const prediction: SourcePrediction = {
      v: SOURCE_RECORD_VERSION,
      id: sourcePredictionId('user', pair, nowSec),
      source: 'user',
      sourceVersion: 'user-view-v1',
      kind: 'direction',
      pair,
      venue: coin?.venue ?? 'binance',
      madeAt: nowSec,
      bar: null,
      horizonSec,
      refPrice: price,
      side,
      movePct: targetPct,
      targetPrice: price * (1 + ((side === 'up' ? 1 : -1) * targetPct) / 100),
      window: null,
      dist: { pRight: null, q: null, pMove: null },
      scenarios: null,
      cost: null,
      expectedNet: null,
      // The record's reason stays in English, as every record's does.
      reason: `My own view on ${record.url}`,
      evidence: [record.id],
      unit: dayUnitOf(nowSec),
      versions: { engine: config?.engineVersion ?? 'unknown', config: config?.configVersion ?? 'unknown' }
    }
    try {
      await window.api.predictions.record(prediction)
      await window.api.urls.link(record.id, { predictionId: prediction.id })
    } catch (error) {
      return setProblem(t('Your view could not be recorded: {reason}', { reason: error instanceof Error ? error.message : String(error) }))
    }
    setProblem(null)
    onPrepareOrder(userViewProposal({ pair, side, stakeQuote, targetPct, horizonSec, refPrice: price, nowSec, newsUrlId: record.id }))
  }
  return (
    <Card title={t('Paper trade my own view')}>
      <p style={{ ...noteStyle, marginTop: 0 }}>{t('Your own view, nothing filled in by the app: it is recorded as your prediction, scored like every source, and opens the Position form on paper for you to place.')}</p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={pair} onChange={(change) => setPair(change.target.value)} style={inputStyle()} aria-label={t('Coin')}>
          <option value="">{t('Coin…')}</option>
          {record.coins.map((coin) => (
            <option key={coin.pair} value={coin.pair}>
              {pairWords(coin.pair)}
            </option>
          ))}
        </select>
        <select value={side} onChange={(change) => setSide(change.target.value as '' | 'up' | 'down')} style={inputStyle()} aria-label={t('Side')}>
          <option value="">{t('Side…')}</option>
          <option value="up">{t('Up (buy)')}</option>
          <option value="down">{t('Down (sell, paper only)')}</option>
        </select>
        <input value={stake} onChange={(change) => setStake(change.target.value)} placeholder={t('Stake, USDT')} inputMode="decimal" style={{ ...inputStyle(), width: '8rem' }} aria-label={t('Stake in USDT')} />
        <select value={horizon} onChange={(change) => setHorizon(change.target.value)} style={inputStyle()} aria-label={t('Horizon')}>
          <option value="">{t('Horizon…')}</option>
          {HORIZONS.map((entry) => (
            <option key={entry.sec} value={entry.sec}>
              {t(entry.label)}
            </option>
          ))}
        </select>
        <input value={target} onChange={(change) => setTarget(change.target.value)} placeholder={t('Target, %')} inputMode="decimal" style={{ ...inputStyle(), width: '7rem' }} aria-label={t('Target in percent')} />
        <button type="button" style={buttonStyle('primary')} onClick={() => void submit()}>
          {t('Record it and open the form')}
        </button>
      </div>
      {price !== null && <p style={{ ...noteStyle, marginTop: '0.4rem' }}>{t('Now {price}.', { price: dollars(price) })}</p>}
      {problem !== null && <p style={{ ...noteStyle, marginTop: '0.4rem', color: 'var(--down)' }}>{problem}</p>}
    </Card>
  )
}

export function NewsUrlsPage({ onPrepareOrder }: { onPrepareOrder: (proposal: AiOrderProposal) => void }): React.JSX.Element {
  const i18n = useI18n()
  const { t, utcTime, utcDay } = i18n
  const [link, setLink] = useState('')
  const [supplied, setSupplied] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [records, setRecords] = useState<UrlRecord[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [autoAnalyze, setAutoAnalyze] = useState(false)
  const [archive, setArchive] = useState(true)

  useEffect(() => {
    let live = true
    void window.api.urls
      .list()
      .then((read) => {
        if (live) setRecords(read)
      })
      .catch(() => undefined)
    void window.api.settings
      .get()
      .then((settings) => {
        if (!live) return
        setAutoAnalyze(settings.newsUrls?.autoAnalyze === true)
        setArchive(settings.newsUrls?.archive !== false)
      })
      .catch(() => undefined)
    const stop = window.api.urls.onUpdate((record) => setRecords((current) => [record, ...current.filter((entry) => entry.id !== record.id)].sort((a, b) => b.at - a.at)))
    return (): void => {
      live = false
      stop()
    }
  }, [])

  const selected = useMemo(() => records.find((record) => record.id === open) ?? null, [records, open])

  const analyze = async (): Promise<void> => {
    setBusy(true)
    setRefused(null)
    try {
      const done = await window.api.urls.analyze(link, supplied.trim() === '' ? null : supplied)
      if ('refused' in done) setRefused(done.refused)
      else {
        setOpen(done.id)
        setLink('')
        setSupplied('')
      }
    } catch (error) {
      setRefused(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const switchAuto = async (on: boolean): Promise<void> => {
    setAutoAnalyze(on)
    await window.api.settings.set({ newsUrls: { autoAnalyze: on, archive } }).catch(() => setAutoAnalyze(!on))
  }

  const switchArchive = async (on: boolean): Promise<void> => {
    setArchive(on)
    await window.api.settings.set({ newsUrls: { autoAnalyze, archive: on } }).catch(() => setArchive(!on))
  }

  return (
    <>
      <PageHeader
        title={t('News URLs')}
        subtitle={t('Paste a news link: the app reads it safely, says when it was published and who says it, which coins it names, what their prices did, and whether any measured source calls a way')}
      />
      <Card title={t('Analyze a link')}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input value={link} onChange={(change) => setLink(change.target.value)} placeholder="https://…" style={{ ...inputStyle(), flex: '1 1 26rem' }} aria-label={t('News link')} dir="ltr" />
          <button type="button" style={buttonStyle('primary', busy || link.trim() === '')} disabled={busy || link.trim() === ''} onClick={() => void analyze()}>
            {busy ? t('Reading…') : t('Analyze')}
          </button>
        </div>
        <textarea
          value={supplied}
          onChange={(change) => setSupplied(change.target.value)}
          placeholder={t("Optional: the article's text, if its page cannot be read (kept as supplied by you, not retrieved)")}
          style={{ ...inputStyle(), width: '100%', minHeight: '4rem', marginTop: '0.5rem', resize: 'vertical' }}
          aria-label={t("The article's text")}
        />
        {refused !== null && (
          <p lang="en" dir="auto" style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.4rem' }}>
            {refused}
          </p>
        )}
        <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
          {t("Only https links on their usual port are read; the link's tracking fields are dropped; its host's addresses are checked, and nothing on this machine or its network can be reached through it. Fifteen seconds, three redirects and two megabytes at most. A post on X is not fetched. A model reads it only when you ask, below.")}
        </p>
      </Card>
      {selected !== null && (
        <Card title={t('What the link says')}>
          <RecordView record={selected} />
        </Card>
      )}
      {selected !== null && <ArticleReading record={selected} />}
      {selected !== null && <OwnView record={selected} onPrepareOrder={onPrepareOrder} />}
      <Card title={t('Links on file')}>
        {records.length === 0 ? (
          <p style={noteStyle}>{t('None yet.')}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {[msg('When'), msg('Origin'), msg('Source'), msg('Title'), msg('Coins'), msg('Verdict')].map((name) => (
                    <th key={name} style={headCellStyle}>
                      {t(name)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id} onClick={() => setOpen(record.id)} style={{ cursor: 'pointer', background: open === record.id ? 'var(--bg-app)' : undefined }}>
                    <td style={cellStyle}>{t('{time} UTC on {day}', { time: utcTime(record.at * 1000), day: utcDay(record.at * 1000) })}</td>
                    <td style={cellStyle}>{record.origin === 'manual' ? t('pasted') : t('discovered')}</td>
                    <td style={cellStyle}>
                      <bdi dir="ltr">{record.host}</bdi>
                    </td>
                    <td lang="en" dir="auto" style={{ ...cellStyle, whiteSpace: 'normal', minWidth: '16rem' }}>
                      {record.title ?? '—'}
                    </td>
                    <td style={cellStyle}>{record.coins.map((coin) => coin.ticker).join(', ') || '—'}</td>
                    <td style={cellStyle}>{record.verdict.cards.length > 0 ? t('a card') : t('none')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <label style={{ ...noteStyle, display: 'inline-flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.6rem' }}>
          <input type="checkbox" checked={autoAnalyze} onChange={(change) => void switchAuto(change.target.checked)} />
          {t('Analyze discovered news automatically: read the page of each announcement and each feed story of impact 70 or more that names a coin directly. Off, they are recorded from the feed alone, and nothing is fetched.')}
        </label>
        <label style={{ ...noteStyle, display: 'inline-flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.4rem' }}>
          <input type="checkbox" checked={archive} onChange={(change) => void switchArchive(change.target.checked)} />
          <span>
            <Interpolate
              text={t('Ask the Internet Archive when it first captured each link you paste (the link is sent to {host}): an upper bound on when it was published.')}
              values={{ host: <bdi dir="ltr">web.archive.org</bdi> }}
            />
          </span>
        </label>
      </Card>
    </>
  )
}
