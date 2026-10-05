import { useCallback, useEffect, useRef, useState } from 'react'
import { Card } from '../components/Card'
import { ExchangeSelect } from '../components/ExchangeSelect'
import { SymbolSearch } from '../components/SymbolSearch'
import { EXCHANGES, type Exchange, type SymbolInfo } from '../../shared/ipc'
import {
  AI_PROVIDER_LABEL,
  GPT_INTRADAY_INTERVAL,
  type AiSignalDecision,
  type AiSignalEstimate,
  type AiSignalTapeRequest
} from '../../shared/aiSignal'
import { buildAiContext, type AiMarketContext } from '../../shared/aiContext'
import { formatUsd, type AiConfig } from '../../shared/aiCost'
import { AI_PANEL_CALLS, describeDecider, isPanelId, panelIdFor } from '../../shared/aiPanel'
import { buildAiProposal, type AiOrderProposal } from '../../shared/aiProposal'
import { prepareAiSignalRequest } from '../ai/aiClient'
import { describeError } from '../utils/ipcError'
import { SignalCard } from './SignalCard'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle, recommendationColor, reasonLabel } from './agentStyles'

/** What is known about the next click, before it is made. */
type Pricing =
  | { status: 'loading' }
  | { status: 'ready'; estimate: AiSignalEstimate; request: AiSignalTapeRequest; context: AiMarketContext | null }
  | { status: 'unavailable'; reason: string }

interface Result {
  decision: AiSignalDecision
  symbol: string
  quoteAsset: string
  /** The market and the close the model was shown, kept so a call to buy can be turned into an
   * order form: its levels are prices, and the form takes distances from one. */
  exchange: Exchange
  pair: SymbolInfo
  referencePrice: number | null
}

function buttonLabel(pricing: Pricing, running: boolean): string {
  if (running) return 'Asking…'
  if (pricing.status === 'loading') return 'Pricing…'
  if (pricing.status === 'unavailable') return 'Analyze'
  const { estimate } = pricing
  if (estimate.maximumApiCalls === 0) return 'Analyze (cached, free)'
  // The whole click, not one call of it: a panel of agents makes four.
  if (estimate.estimatedCostUsd === null) return 'Analyze (cost unknown)'
  return `Analyze (≈ ${formatUsd(estimate.estimatedCostUsd)})`
}

/** One market, one model, one click, one call -- or four, when what is picked is a panel of agents
 * on a model, which the button's price then covers.
 *
 * NOTHING HERE SPENDS UNTIL THE BUTTON IS PRESSED. Choosing a market or a model prices the next
 * call -- which reads the cache and a price list -- and the button carries that price, so the cost
 * of pressing it is on the thing being pressed. */
export function AnalyzeTab({
  onPrepareOrder
}: {
  /** Opens an executor form filled in from a call to buy. Absent, the card offers no such form. */
  onPrepareOrder?: (proposal: AiOrderProposal) => void
} = {}): React.JSX.Element {
  const [exchange, setExchange] = useState<Exchange>('binance')
  const [pair, setPair] = useState<SymbolInfo>(EXCHANGES[0].defaultSymbol)
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const [pricing, setPricing] = useState<Pricing>({ status: 'loading' })
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [results, setResults] = useState<Result[]>([])
  const [showContext, setShowContext] = useState(false)
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))
  const pricingRunRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    void window.api.ai.getConfig().then((next) => {
      if (cancelled) return
      setConfig(next)
      setModel(next.defaultModel)
    })
    return (): void => {
      cancelled = true
    }
  }, [])

  // So a card can turn "stale" when its candle closes, without each card owning a timer.
  useEffect(() => {
    const timer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 30_000)
    return (): void => clearInterval(timer)
  }, [])

  /** Prices the next call. Returns what it found as well as storing it, because the click handler
   * needs the answer now rather than on the next render. */
  const price = useCallback(async (): Promise<Pricing> => {
    if (model === null) return { status: 'loading' }
    const run = ++pricingRunRef.current
    setPricing({ status: 'loading' })
    let next: Pricing
    try {
      const prepared = await prepareAiSignalRequest(pair.symbol, { exchange, model, source: 'agent' })
      if (!prepared) {
        next = { status: 'unavailable', reason: 'This market does not have seven days of completed 15-minute candles yet.' }
      } else {
        const estimate = await window.api.ai.estimateSignalTape(prepared.request)
        const context = buildAiContext(prepared.candles, prepared.executionIndex, {
          exchange,
          symbol: pair.symbol,
          interval: GPT_INTRADAY_INTERVAL,
          position: 'flat'
        })
        next = { status: 'ready', estimate, request: prepared.request, context }
      }
    } catch (failure) {
      next = { status: 'unavailable', reason: describeError(failure) }
    }
    // A slower answer for a market the user has already moved away from must not overwrite the
    // price of the one they are looking at.
    if (run === pricingRunRef.current) setPricing(next)
    return next
  }, [exchange, pair.symbol, model])

  useEffect(() => {
    void price()
  }, [price])

  async function handleAnalyze(): Promise<void> {
    if (running || pricing.status !== 'ready') return
    setRunning(true)
    setError(null)
    try {
      // Priced again at the moment of the click. The figure on the button was computed when the
      // market was chosen, and a new candle may have opened since: the decision it priced is then
      // no longer the one that would be asked for, and a button reading "cached, free" would spend.
      const shown = pricing.estimate
      const fresh = await price()
      if (fresh.status !== 'ready') return
      if (fresh.estimate.maximumApiCalls > shown.maximumApiCalls) {
        setError('A new candle has opened since this was priced, so the answer is no longer cached. The button shows the new cost; press it again to ask.')
        return
      }
      const tape = await window.api.ai.generateSignalTape(fresh.request)
      const decision = tape.decisions[0]
      if (!decision) {
        setError('No decision came back for this candle.')
        return
      }
      setResults((previous) => {
        // Results stack only while they answer the SAME question. A different market or a new
        // candle starts the comparison again, or it would compare answers to different questions.
        const sameQuestion = previous.filter(
          (entry) => entry.symbol === pair.symbol && entry.decision.candleTime === decision.candleTime && entry.decision.model !== decision.model
        )
        return [
          {
            decision,
            symbol: pair.symbol,
            quoteAsset: pair.quoteAsset,
            exchange,
            pair,
            referencePrice: fresh.context?.lastClose ?? null
          },
          ...sameQuestion
        ]
      })
      void price()
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setRunning(false)
    }
  }

  const latest = results[0] ?? null
  // Built on every render from the clock the card is given, so the offer is withdrawn the moment
  // the call's candle closes rather than whenever the card is next asked.
  const proposal =
    latest !== null && latest.referencePrice !== null
      ? buildAiProposal({
          decision: latest.decision,
          exchange: latest.exchange,
          pair: latest.pair,
          interval: GPT_INTRADAY_INTERVAL,
          referencePrice: latest.referencePrice,
          nowSec
        })
      : null
  const ready = pricing.status === 'ready'
  const disabled = running || !ready

  return (
    <Card title="Ask a model about a market">
      <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
        Sends the last seven days of {GPT_INTRADAY_INTERVAL} candles — as indicators, a short tail of raw bars and 1h and
        4h views — to the chosen model through {AI_PROVIDER_LABEL}, and shows its decision for the candle forming now.
        This is the same question a GPT Intraday bot or backtest asks, so an answer here is cached for them too. It can
        never place an order.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', marginBottom: '0.6rem' }}>
        <ExchangeSelect
          exchange={exchange}
          onSelect={(next) => {
            setExchange(next)
            setPair(EXCHANGES.find((entry) => entry.id === next)?.defaultSymbol ?? pair)
          }}
        />
        <SymbolSearch exchange={exchange} symbol={pair.symbol} onSelect={setPair} />
        <select value={model ?? ''} onChange={(event) => setModel(event.target.value)} style={inputStyle()} aria-label="Model">
          {(config?.enabledModels ?? []).map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
          {(config?.enabledModels ?? []).map((id) => (
            <option key={panelIdFor(id)} value={panelIdFor(id)}>
              {describeDecider(panelIdFor(id))} ({AI_PANEL_CALLS} calls)
            </option>
          ))}
        </select>
        <button onClick={() => void handleAnalyze()} disabled={disabled} style={buttonStyle('primary', disabled)}>
          {buttonLabel(pricing, running)}
        </button>
      </div>

      {pricing.status === 'ready' && (
        <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
          {pricing.estimate.maximumApiCalls === 0
            ? 'This candle has already been asked of this model, so asking again costs nothing.'
            : pricing.estimate.costBasis === 'history'
              ? "The price is what this model's recent calls here have averaged."
              : pricing.estimate.costBasis === 'pricing'
                ? 'The price is an estimate from the model’s price list; it has not been called here yet.'
                : 'This model has no call history here and no published price.'}{' '}
          {formatUsd(pricing.estimate.budgetRemainingUsd)} of today&apos;s AI budget is left.
          {model !== null &&
            isPanelId(model) &&
            ` A panel is ${AI_PANEL_CALLS} calls to its model: a trend, a momentum and a risk analyst, then the decision made from their reports.`}
        </p>
      )}
      {pricing.status === 'unavailable' && <p style={{ ...noteStyle, color: 'var(--down)', marginBottom: '0.9rem' }}>{pricing.reason}</p>}
      {error !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginBottom: '0.9rem' }}>{error}</p>}

      {latest && (
        <SignalCard
          decision={latest.decision}
          interval={GPT_INTRADAY_INTERVAL}
          quoteAsset={latest.quoteAsset}
          nowSec={nowSec}
          proposal={proposal}
          onPrepareOrder={onPrepareOrder}
        />
      )}

      {results.length > 1 && (
        <div style={{ marginTop: '1rem', overflowX: 'auto' }}>
          <p style={{ ...noteStyle, marginBottom: '0.4rem' }}>
            The same candle, as each model asked so far read it. Agreement between models is not evidence that they are
            right; AI Benchmark asks them all the same history and scores it.
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headCellStyle}>Model</th>
                <th style={headCellStyle}>Call</th>
                <th style={headCellStyle}>Confidence</th>
                <th style={headCellStyle}>Regime</th>
                <th style={headCellStyle}>Cost</th>
              </tr>
            </thead>
            <tbody>
              {results.map(({ decision }) => (
                <tr key={decision.model}>
                  <td style={cellStyle}>{describeDecider(decision.model)}</td>
                  <td style={{ ...cellStyle, color: recommendationColor(decision.recommendation), fontWeight: 700, textTransform: 'uppercase' }}>
                    {decision.error ? 'failed' : decision.rejected ? 'refused' : decision.recommendation}
                  </td>
                  <td style={cellStyle}>{(decision.confidence * 100).toFixed(0)}%</td>
                  <td style={cellStyle}>{decision.detail ? reasonLabel(decision.detail.marketRegime) : '—'}</td>
                  <td style={cellStyle}>{decision.usage?.costUsd != null ? formatUsd(decision.usage.costUsd) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pricing.status === 'ready' && pricing.context && (
        <div style={{ marginTop: '1rem' }}>
          <button onClick={() => setShowContext((shown) => !shown)} style={buttonStyle('secondary')}>
            {showContext ? 'Hide what the model is shown' : 'Show what the model is shown'}
          </button>
          {showContext && (
            <pre
              style={{
                marginTop: '0.6rem',
                maxHeight: 360,
                overflow: 'auto',
                padding: '0.8rem',
                background: 'var(--bg-app)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-sm)',
                fontSize: '0.7rem',
                color: 'var(--text-secondary)',
                lineHeight: 1.5
              }}
            >
              {JSON.stringify(pricing.context, null, 1)}
            </pre>
          )}
        </div>
      )}
    </Card>
  )
}
