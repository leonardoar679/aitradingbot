import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { useLiveMarket } from '../hooks/useLiveMarket'
import { userViewProposal, type AiOrderProposal } from '../../shared/aiProposal'
import { SOURCE_RECORD_VERSION, dayUnitOf, sourcePredictionId, type SourcePrediction } from '../../shared/evaluation/predictionRecord'
import type { UrlRecord } from '../../shared/newsUrl'
import { pairWords, signed, utcTime } from '../calls/callText'

// NEWS URLS (V8 Stage 4, 26 October 2026; electron/services/newsUrlService.ts). A person pastes a news link; the app
// reads it safely and keeps what it found: its text and where that came from, when it was published, who says it, the
// coins it names and what their prices did, and the verdict -- a card where a measured source has one, otherwise "No
// profitable opportunity identified". "Paper trade my own view" records a view of the person's own, nothing filled in
// by the app, and opens the Position form with it for them to place on paper. English until V8 Stage 5.

const CREDIBILITY_WORDS: Record<UrlRecord['credibility'], string> = {
  exchange: 'an exchange speaking of its own markets',
  regulator: 'a regulator',
  outlet: 'a news outlet',
  project: "a project's own site",
  social: 'a social network, where anyone posts',
  unknown: 'a site the app does not know'
}

const RETRIEVAL_WORDS: Record<UrlRecord['retrieval'], string> = {
  fetched: 'read from the page',
  feed: "the news feed's own copy",
  announcement: "Binance's own list",
  supplied: 'supplied by you, not retrieved',
  'x-post': 'a post on X: not fetched',
  none: 'no text could be had'
}

const HORIZONS: { sec: number; label: string }[] = [
  { sec: 3600, label: '1 hour' },
  { sec: 4 * 3600, label: '4 hours' },
  { sec: 86_400, label: '1 day' }
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

const pct = (x: number | null): string => (x === null ? '—' : signed(x))

/** The lookups made after the paste, each named: the Internet Archive's first capture, and a post on X's author. */
function lookupsText(record: UrlRecord): string {
  const lookups = record.lookups
  if (lookups === undefined) return record.origin === 'automatic' ? 'none: a discovered story is recorded from the feed alone' : 'being made…'
  const archive = lookups.archive
  const parts = [
    archive === null
      ? 'the Internet Archive: not asked'
      : archive.status === 'found'
        ? `the Internet Archive first captured it ${new Date((archive.firstSec as number) * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC, so it was published by then${archive.note === null ? '' : ` — ${archive.note}`}`
        : archive.status === 'none'
          ? 'the Internet Archive holds no capture of it'
          : archive.status === 'off'
            ? 'the Internet Archive: switched off'
            : `the Internet Archive could not be asked (${archive.note ?? 'no answer'})`
  ]
  if (lookups.x !== null) parts.push(lookups.x.status === 'found' ? `X's embed names its author ${lookups.x.name ?? 'unnamed'}` : "X's embed could not be read")
  return parts.join(' · ')
}

/** One record: what was read, when it was published, who says it, its coins and their prices, and the verdict. */
function RecordView({ record }: { record: UrlRecord }): React.JSX.Element {
  const time = record.time
  return (
    <div>
      <p style={{ margin: 0, fontWeight: 700, fontSize: '1.02rem' }}>{record.title ?? record.url}</p>
      <p style={{ ...noteStyle, marginTop: '0.2rem' }} dir="ltr">
        {record.url}
      </p>
      <div style={{ marginTop: '0.5rem' }}>
        <Line name="Source">
          {record.host}: {CREDIBILITY_WORDS[record.credibility]}
          {record.binance !== null ? ` · a Binance announcement verified in Binance's own list (${record.binance.title})` : ''}
          {record.corroboration.stories > 0 ? ` · told too by ${record.corroboration.stories} other stor${record.corroboration.stories === 1 ? 'y' : 'ies'} of the feed (${record.corroboration.sources.join(', ')})` : ''}
        </Line>
        <Line name="Text">
          {RETRIEVAL_WORDS[record.retrieval]}
          {record.readFailure !== null ? ` · the page: ${record.readFailure}` : ''}
          {record.author !== null ? ` · by ${record.author}` : ''}
        </Line>
        <Line name="Published">
          {time === null || time.sec === null
            ? 'Not read: the price is not measured from it.'
            : `${new Date(time.sec * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC, from ${time.source}${time.field !== null ? ` (${time.field})` : ''}${time.disagree ? ' · the page gives times more than an hour apart' : ''}${time.future.length > 0 ? ` · ${time.future.length} time(s) after the page was read refused` : ''}${time.check !== null ? ` · the ${time.check.source === 'announcement' ? "announcement's" : "feed's"} own time ${time.check.agrees ? 'agrees' : 'disagrees'}` : ''}`}
        </Line>
        <Line name="Kind">{record.kind.toLowerCase().replace(/_/g, ' ')}</Line>
        <Line name="Lookups">{lookupsText(record)}</Line>
        <Line name="Coins">
          {record.coins.length === 0 ? 'none it names can be weighed here' : record.coins.map((coin) => `${coin.ticker} (${coin.relationship === 'DIRECT' ? 'in its title' : 'in its body'}, ${coin.venue})`).join(', ')}
          {record.rejected.length > 0
            ? ` · left out: ${record.rejected.map((coin) => `${coin.ticker} (${coin.why === 'no-pair' ? 'no USDT pair here' : coin.why === 'thin' ? 'under a day of 1M USDT traded' : 'past the five kept'})`).join(', ')}`
            : ''}
        </Line>
      </div>
      {record.reactions.length > 0 && (
        <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Coin', 'At publication', 'The day before', '+5 min', '+15 min', '+1 hour', '+4 hours', ''].map((name) => (
                  <th key={name} style={headCellStyle}>
                    {name}
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
                  <td style={cellStyle}>{reaction.refPrice === null ? '—' : reaction.refPrice.toPrecision(6)}</td>
                  <td style={cellStyle}>{pct(reaction.beforePct)}</td>
                  <td style={cellStyle}>{pct(reaction.afterPct.m5)}</td>
                  <td style={cellStyle}>{pct(reaction.afterPct.m15)}</td>
                  <td style={cellStyle}>{pct(reaction.afterPct.h1)}</td>
                  <td style={cellStyle}>{pct(reaction.afterPct.h4)}</td>
                  <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>{reaction.final ? 'final' : 'measured until four hours after'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ marginTop: '0.7rem', padding: '0.6rem 0.75rem', borderRadius: 'var(--radius-sm)', background: 'var(--bg-app)', border: '1px solid var(--border)' }}>
        {record.verdict.cards.length > 0 ? (
          <span>
            <strong>A card: </strong>
            {record.verdict.cards.join(', ')} — on Home and Predictions, with its figures.
          </span>
        ) : (
          <span>
            <strong>No profitable opportunity identified. </strong>
            {record.verdict.none}
          </span>
        )}
      </div>
      {record.snippets.length > 0 && (
        <details style={{ marginTop: '0.6rem' }}>
          <summary style={{ cursor: 'pointer', fontSize: '0.82rem' }}>The text read, in {record.snippets.length} numbered snippets</summary>
          <ol style={{ margin: '0.4rem 0 0', paddingInlineStart: '1.4rem', display: 'grid', gap: '0.3rem' }}>
            {record.snippets.map((snippet) => (
              <li key={snippet.n} style={{ fontSize: '0.8rem' }}>
                {snippet.text}
              </li>
            ))}
          </ol>
        </details>
      )}
      <details style={{ marginTop: '0.4rem' }}>
        <summary style={{ cursor: 'pointer', fontSize: '0.82rem' }}>What was done, step by step</summary>
        <ul style={{ margin: '0.4rem 0 0', paddingInlineStart: '1.2rem' }}>
          {record.trail.map((entry, index) => (
            <li key={index} style={{ fontSize: '0.8rem' }}>
              {utcTime(entry.at)} · {entry.status}: {entry.note}
            </li>
          ))}
        </ul>
      </details>
    </div>
  )
}

/** "Paper trade my own view": the person's side, stake, horizon and target, nothing filled in; recorded as their own
 * prediction and handed to the Position form for them to place on paper. */
function OwnView({ record, onPrepareOrder }: { record: UrlRecord; onPrepareOrder: (proposal: AiOrderProposal) => void }): React.JSX.Element | null {
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
    if (pair === '' || side === '' || !(stakeQuote > 0) || !(targetPct > 0) || !(horizonSec > 0)) return setProblem('Choose the coin, the side, the stake, the horizon and the target: nothing is filled in for you.')
    if (price === null) return setProblem('No live price of the coin is read yet; try again in a moment.')
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
      reason: `My own view on ${record.url}`,
      evidence: [record.id],
      unit: dayUnitOf(nowSec),
      versions: { engine: config?.engineVersion ?? 'unknown', config: config?.configVersion ?? 'unknown' }
    }
    try {
      await window.api.predictions.record(prediction)
      await window.api.urls.link(record.id, { predictionId: prediction.id })
    } catch (error) {
      return setProblem(`Your view could not be recorded: ${error instanceof Error ? error.message : String(error)}`)
    }
    setProblem(null)
    onPrepareOrder(userViewProposal({ pair, side, stakeQuote, targetPct, horizonSec, refPrice: price, nowSec, newsUrlId: record.id }))
  }
  return (
    <Card title="Paper trade my own view">
      <p style={{ ...noteStyle, marginTop: 0 }}>
        Your own view, nothing filled in by the app: it is recorded as your prediction, scored like every source, and opens the Position form on paper for you
        to place.
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={pair} onChange={(change) => setPair(change.target.value)} style={inputStyle()} aria-label="Coin">
          <option value="">Coin…</option>
          {record.coins.map((coin) => (
            <option key={coin.pair} value={coin.pair}>
              {pairWords(coin.pair)}
            </option>
          ))}
        </select>
        <select value={side} onChange={(change) => setSide(change.target.value as '' | 'up' | 'down')} style={inputStyle()} aria-label="Side">
          <option value="">Side…</option>
          <option value="up">Up (buy)</option>
          <option value="down">Down (sell, paper only)</option>
        </select>
        <input value={stake} onChange={(change) => setStake(change.target.value)} placeholder="Stake, USDT" inputMode="decimal" style={{ ...inputStyle(), width: '8rem' }} aria-label="Stake in USDT" />
        <select value={horizon} onChange={(change) => setHorizon(change.target.value)} style={inputStyle()} aria-label="Horizon">
          <option value="">Horizon…</option>
          {HORIZONS.map((entry) => (
            <option key={entry.sec} value={entry.sec}>
              {entry.label}
            </option>
          ))}
        </select>
        <input value={target} onChange={(change) => setTarget(change.target.value)} placeholder="Target, %" inputMode="decimal" style={{ ...inputStyle(), width: '7rem' }} aria-label="Target in percent" />
        <button type="button" style={buttonStyle('primary')} onClick={() => void submit()}>
          Record it and open the form
        </button>
      </div>
      {price !== null && <p style={{ ...noteStyle, marginTop: '0.4rem' }}>Now {price.toPrecision(6)}.</p>}
      {problem !== null && <p style={{ ...noteStyle, marginTop: '0.4rem', color: 'var(--down)' }}>{problem}</p>}
    </Card>
  )
}

export function NewsUrlsPage({ onPrepareOrder }: { onPrepareOrder: (proposal: AiOrderProposal) => void }): React.JSX.Element {
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
      <PageHeader title="News URLs" subtitle="Paste a news link: the app reads it safely, says when it was published and who says it, which coins it names, what their prices did, and whether any measured source calls a way" />
      <Card title="Analyze a link">
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input value={link} onChange={(change) => setLink(change.target.value)} placeholder="https://…" style={{ ...inputStyle(), flex: '1 1 26rem' }} aria-label="News link" dir="ltr" />
          <button type="button" style={buttonStyle('primary', busy || link.trim() === '')} disabled={busy || link.trim() === ''} onClick={() => void analyze()}>
            {busy ? 'Reading…' : 'Analyze'}
          </button>
        </div>
        <textarea
          value={supplied}
          onChange={(change) => setSupplied(change.target.value)}
          placeholder="Optional: the article's text, if its page cannot be read (kept as supplied by you, not retrieved)"
          style={{ ...inputStyle(), width: '100%', minHeight: '4rem', marginTop: '0.5rem', resize: 'vertical' }}
          aria-label="The article's text"
        />
        {refused !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.4rem' }}>{refused}</p>}
        <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
          Only https links on their usual port are read; the link's tracking fields are dropped; its host's addresses are checked, and nothing on this machine or
          its network can be reached through it. Fifteen seconds, three redirects and two megabytes at most. A post on X is not fetched. No model reads it here.
        </p>
      </Card>
      {selected !== null && (
        <Card title="What the link says">
          <RecordView record={selected} />
        </Card>
      )}
      {selected !== null && <OwnView record={selected} onPrepareOrder={onPrepareOrder} />}
      <Card title="Links on file">
        {records.length === 0 ? (
          <p style={noteStyle}>None yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['When', 'Origin', 'Source', 'Title', 'Coins', 'Verdict'].map((name) => (
                    <th key={name} style={headCellStyle}>
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id} onClick={() => setOpen(record.id)} style={{ cursor: 'pointer', background: open === record.id ? 'var(--bg-app)' : undefined }}>
                    <td style={cellStyle}>{new Date(record.at * 1000).toISOString().slice(0, 16).replace('T', ' ')}</td>
                    <td style={cellStyle}>{record.origin === 'manual' ? 'pasted' : 'discovered'}</td>
                    <td style={cellStyle}>{record.host}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'normal', minWidth: '16rem' }}>{record.title ?? '—'}</td>
                    <td style={cellStyle}>{record.coins.map((coin) => coin.ticker).join(', ') || '—'}</td>
                    <td style={cellStyle}>{record.verdict.cards.length > 0 ? 'a card' : 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <label style={{ ...noteStyle, display: 'inline-flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.6rem' }}>
          <input type="checkbox" checked={autoAnalyze} onChange={(change) => void switchAuto(change.target.checked)} />
          Analyze discovered news automatically: read the page of each announcement and each feed story of impact 70 or more that names a coin directly. Off, they
          are recorded from the feed alone, and nothing is fetched.
        </label>
        <label style={{ ...noteStyle, display: 'inline-flex', gap: '0.4rem', alignItems: 'center', marginTop: '0.4rem' }}>
          <input type="checkbox" checked={archive} onChange={(change) => void switchArchive(change.target.checked)} />
          Ask the Internet Archive when it first captured each link you paste (the link is sent to web.archive.org): an upper bound on when it was published.
        </label>
      </Card>
    </>
  )
}
