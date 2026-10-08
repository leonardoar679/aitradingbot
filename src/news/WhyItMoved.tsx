import { useEffect, useState } from 'react'
import type { Candle } from '../../shared/ipc'
import { explainMove, type CauseLabel, type CauseRole, type MoveExplanation } from '../../shared/moveExplanation'
import { WhyConclusion } from '../agents/WhyConclusion'
import { useNewsFeed } from './useNewsFeed'

/** The minutes read for a pair and for Bitcoin: the hour explained and the three before it. */
const HOURS_READ = 4

const LABEL_TONE: Record<CauseLabel, string> = { KNOWN: 'var(--up)', PROBABLE: 'var(--gold)', POSSIBLE: 'var(--text-secondary)', UNKNOWN: 'var(--text-muted)' }

const signed = (value: number | null): string => (value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`)

/** "Why did it move?" for one pair (shared/moveExplanation.ts): its last hour against Bitcoin's and
 * its usual volume, and the stories that name it, with how sure that is. It reads public candles
 * and the news feed, and never names a cause it did not find. Below it, the AI's conclusion
 * (../agents/WhyConclusion.tsx), asked only on a click at the price shown. */
const ROLE_TONE: Record<CauseRole, string> = {
  'PRIMARY CATALYST': 'var(--up)',
  SECONDARY: 'var(--text-secondary)',
  'MARKET AMPLIFIER': 'var(--gold)',
  UNRELATED: 'var(--text-muted)',
  UNKNOWN: 'var(--text-muted)'
}

export function WhyItMoved({ symbol }: { symbol: string }): React.JSX.Element {
  const feed = useNewsFeed()
  const [bars, setBars] = useState<{ pair: Candle[]; btc: Candle[]; at: number } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  /** The analyst's newest conclusion for the pair, for the timeline: what the conclusion view below
   * found on file, or made on a click, handed up. This view reads no ledger itself. */
  const [reading, setReading] = useState<{ at: number; text: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    const nowSec = Math.floor(Date.now() / 1000)
    const from = nowSec - HOURS_READ * 3600
    Promise.all([
      window.api.market.fetchHistoricalRange('binance', symbol, '1m', from, nowSec),
      symbol === 'BTCUSDT' ? Promise.resolve(null) : window.api.market.fetchHistoricalRange('binance', 'BTCUSDT', '1m', from, nowSec)
    ]).then(
      ([pair, btc]) => {
        if (!cancelled) setBars({ pair: pair.candles, btc: btc === null ? pair.candles : btc.candles, at: nowSec })
      },
      (failure: unknown) => {
        if (!cancelled) setProblem(failure instanceof Error ? failure.message : String(failure))
      }
    )
    return (): void => {
      cancelled = true
    }
  }, [symbol])

  if (problem !== null) return <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--down)' }}>{symbol}&apos;s minutes could not be read: {problem}</p>
  if (bars === null || feed === null) return <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-muted)' }}>Reading {symbol}&apos;s last hours and the news…</p>

  const explanation: MoveExplanation = explainMove({
    symbol,
    ticker: symbol.replace(/USDT$/, ''),
    bars: bars.pair,
    btcBars: bars.btc,
    stories: feed.stories,
    nowSec: bars.at,
    reading
  })

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.7rem', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '1rem', fontWeight: 800, color: LABEL_TONE[explanation.label] }}>{explanation.label}</span>
        <span style={{ fontSize: '0.84rem', color: 'var(--text-primary)', lineHeight: 1.5 }}>{explanation.summary}</span>
      </div>
      <div style={{ display: 'flex', gap: '1.4rem', flexWrap: 'wrap', marginTop: '0.7rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
        <span>Move: {signed(explanation.movePct)}</span>
        <span>Volume: {explanation.volumeRatio === null ? '—' : `${explanation.volumeRatio.toFixed(1)}× usual`}</span>
        <span>Bitcoin: {signed(explanation.btcMovePct)}</span>
        <span>Share of the market: {explanation.marketShare === null ? '—' : `${Math.round(explanation.marketShare * 100)}%`}</span>
      </div>
      <div style={{ marginTop: '0.8rem' }}>
        {explanation.causes.length === 0 ? (
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>Nothing found to name as a cause.</p>
        ) : (
          explanation.causes.map((cause, index) => (
            <div key={`${cause.kind}-${index}`} style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', padding: '0.35rem 0', borderTop: '1px solid var(--border)', fontSize: '0.8rem' }}>
              <span style={{ width: 70, flexShrink: 0, color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: '0.68rem', fontWeight: 700 }}>{cause.kind}</span>
              <span style={{ width: 128, flexShrink: 0, color: ROLE_TONE[cause.role], fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.03em' }}>{cause.role}</span>
              <span style={{ flex: 1, color: 'var(--text-primary)', lineHeight: 1.45 }}>{cause.text}</span>
              <span style={{ color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{cause.relevance}/100</span>
              {cause.url !== undefined && (
                <button
                  onClick={() => void window.api.feed.openLink(cause.url as string).catch(() => undefined)}
                  style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '0.15rem 0.5rem', fontSize: '0.72rem', color: 'var(--text-primary)', cursor: 'pointer' }}
                >
                  Open
                </button>
              )}
            </div>
          ))
        )}
      </div>
      {explanation.timeline.length > 0 && (
        <div style={{ marginTop: '0.9rem' }}>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: '0.3rem' }}>In order</div>
          {explanation.timeline.map((entry, index) => (
            <div key={`${entry.kind}-${entry.at}-${index}`} style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', padding: '0.25rem 0', fontSize: '0.78rem', borderTop: '1px solid var(--border)' }}>
              <span style={{ width: 58, flexShrink: 0, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{new Date(entry.at * 1000).toISOString().slice(11, 16)} UTC</span>
              <span style={{ width: 58, flexShrink: 0, color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: '0.66rem', fontWeight: 700 }}>{entry.kind}</span>
              <span style={{ flex: 1, color: 'var(--text-primary)', lineHeight: 1.45 }}>{entry.text}</span>
            </div>
          ))}
        </div>
      )}
      <p style={{ margin: '0.8rem 0 0', fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
        A PRIMARY CATALYST is a story that names the coin directly, before the move began, at a relevance of 70 or more; SECONDARY a story before it that
        names the coin or reads at 40, or a surge in volume; MARKET AMPLIFIER Bitcoin making half the move; UNRELATED a story published after the move
        began, which cannot have caused it. KNOWN is an announcement by Binance about the coin; PROBABLE a story about it with nothing pointing the other way; POSSIBLE a story that only mentions
        it, the whole market moving with Bitcoin, or a surge in volume with no story found; UNKNOWN none of these. A cause named is a story found or a
        figure measured, never a guess.
      </p>
      <WhyConclusion symbol={symbol} onFound={(found) => setReading(found === null ? null : { at: found.at, text: found.conclusion.conclusion })} />
    </div>
  )
}
