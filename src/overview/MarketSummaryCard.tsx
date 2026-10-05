import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { SummaryLine } from '../components/SummaryLine'
import { TextLink } from '../components/TextLink'
import type { ScannerPair, ScannerState } from '../../shared/marketScanner'
import { describeError } from '../utils/ipcError'
import type { Page } from '../navigation/pages'
import { describeBtcRegime, signedPct as pct } from './marketSummary'

const BTC = 'BTCUSDT'
const ETH = 'ETHUSDT'
/** The movers listed under Bitcoin and ether. */
const MOVERS = 3

function toneOf(value: number): 'up' | 'down' | undefined {
  return value > 0 ? 'up' : value < 0 ? 'down' : undefined
}

function plainPrice(value: number): string {
  return Number(value.toPrecision(7)).toLocaleString('en-US', { maximumFractionDigits: 8 })
}

function utcClock(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(11, 16)
}

/** What the market is doing, from the scanner's last pass: Bitcoin and ether, Bitcoin's four
 * hours, and what is moving most. It reads the scanner's state and nothing else: no request of its
 * own, and nothing when the scanner is off. */
export function MarketSummaryCard({ onNavigate }: { onNavigate: (page: Page) => void }): React.JSX.Element {
  const [state, setState] = useState<ScannerState | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.scanner.getState().then(
      (next) => {
        if (!cancelled) setState(next)
      },
      (failure: unknown) => {
        if (!cancelled) setProblem(describeError(failure))
      }
    )
    const stop = window.api.scanner.onUpdate((next) => {
      if (!cancelled) setState(next)
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  const note = (text: React.ReactNode): React.JSX.Element => (
    <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>{text}</p>
  )

  let body: React.JSX.Element
  if (problem !== null) body = note(`The scanner could not be read: ${problem}`)
  else if (state === null) body = note('Loading…')
  else if (!state.config.enabled) {
    body = note(
      <>
        The scanner is off, so there is no reading of the market here. Switch it on under{' '}
        <TextLink onClick={() => onNavigate('discovery')}>Discovery</TextLink>.
      </>
    )
  } else if (state.pairs.length === 0) body = note('The scanner has not finished its first pass yet.')
  else {
    const btc = state.pairs.find((pair) => pair.symbol === BTC)
    const eth = state.pairs.find((pair) => pair.symbol === ETH)
    const movers = state.pairs.filter((pair) => pair.symbol !== BTC && pair.symbol !== ETH && pair.band !== 'quiet').slice(0, MOVERS)
    const row = (pair: ScannerPair): React.JSX.Element => (
      <SummaryLine
        key={pair.symbol}
        label={pair.symbol}
        value={
          <>
            {plainPrice(pair.price)} <span style={{ color: `var(--${toneOf(pair.returnsPct.h1) ?? 'text-secondary'})` }}>{pct(pair.returnsPct.h1)} 1h</span>{' '}
            <span style={{ color: `var(--${toneOf(pair.returnsPct.h4) ?? 'text-secondary'})` }}>{pct(pair.returnsPct.h4)} 4h</span>
          </>
        }
      />
    )
    body = (
      <>
        {btc !== undefined && row(btc)}
        {eth !== undefined && row(eth)}
        <p style={{ margin: '0.6rem 0 0', fontSize: '0.82rem', color: 'var(--text-primary)', fontWeight: 600 }}>
          {btc !== undefined ? describeBtcRegime(btc) : 'Bitcoin is not among the pairs the scanner watches.'}
        </p>
        <p style={{ margin: '0.6rem 0 0.2rem', fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-secondary)' }}>Moving most now</p>
        {movers.length === 0
          ? note('Nothing the scanner watches is moving unusually.')
          : movers.map((pair) => (
              <SummaryLine key={pair.symbol} label={pair.symbol} value={`${pct(pair.returnsPct.m15)} in 15 min · ${pair.band}`} tone={toneOf(pair.returnsPct.m15)} />
            ))}
        {state.lastPassAt !== null && (
          <p style={{ margin: '0.6rem 0 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            From the scanner&apos;s pass at {utcClock(state.lastPassAt)} UTC over {state.pairs.length} pairs.
          </p>
        )}
      </>
    )
  }

  return <Card title="The market">{body}</Card>
}
