import { noticeI18n } from '../i18n/current'
import { useEffect, useMemo } from 'react'
import { Bot as BotIcon, Archive } from 'lucide-react'
import { EXCHANGES } from '../../shared/ipc'
import { useDryRun, summarizePaperTrades, classifyBotOpenPosition } from './useDryRun'
import {
  botAiProposal,
  confirmsEntries,
  describeAiCalls,
  describeBotRouteKind,
  gptCadenceOf,
  gptRouteOf,
  resolvedStrategy,
  type Bot
} from './types'
import type { AiOrderProposal } from '../../shared/aiProposal'
import { formatUtcTime } from '../backtest/formatTradeTime'
import { useNowSec } from '../utils/useNowSec'
import { describeGptCadence } from '../../shared/aiSignal'
import { formatQuotePrice } from '../utils/formatCurrency'
import { netUnrealizedPct } from '../../shared/fees'
import { breakerNotice } from '../../shared/notices'
import { describeStrategyHealth, strategyHealth } from '../../shared/strategyHealth'
import { MEASURED_EXPECTATIONS } from '../backtest/marketConditions'
import { GPT_INTRADAY_STRATEGY_ID } from '../../shared/aiSignal'

interface BotCardProps {
  bot: Bot
  onToggle: (id: string) => void
  onArchive: (id: string) => void
  onViewDetail: (id: string) => void
  /** Opens an executor form filled in from the bot's latest call to buy (shared/aiProposal.ts).
   * The form is the person's to submit; the card can only ask for it to be opened. */
  onPrepareOrder?: (proposal: AiOrderProposal) => void
}

function statColumnStyle(): React.CSSProperties {
  return { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem' }
}

function formatShortDate(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// Shows the strategy's real current position (from the full warmup lookback — honest, since
// EMA/ATR need history to compute correctly) separately from the paper-trade record, which
// only counts trades entered after this bot was actually turned on. Conflating the two would
// present the lookback's historical trades as if they were the user's own dry-run activity.
function DryRunPanel({ bot, onPrepareOrder }: { bot: Bot; onPrepareOrder?: (proposal: AiOrderProposal) => void }): React.JSX.Element {
  const { status, error, result, latestCandle, aiCalls, aiCall } = useDryRun(
    bot.exchange,
    bot.symbol,
    bot.enabled,
    bot.enabledAt,
    bot.strategyId,
    bot.aiModel,
    bot.aiConfirm,
    bot.aiEveryBars,
    gptRouteOf(bot) ?? undefined
  )
  // The offer ends when the call's candle closes, which is a moment on the clock and not a new
  // poll, so the card keeps time while there is a call to offer.
  const nowSec = useNowSec(aiCall !== null && aiCall.entered)
  const proposal = botAiProposal(bot, aiCall, nowSec)
  // The strategy's health on this pair (shared/strategyHealth.ts): its last thirty closed paper
  // trades against what the strategy made a trade where it was measured. Worked out from the dry
  // run's own trades; a flag here, and one notice a day. The bot keeps running: a person stops it.
  const expectation = MEASURED_EXPECTATIONS.find((entry) => entry.strategyId === bot.strategyId)?.trades ?? null
  const health = useMemo(() => strategyHealth(summarizePaperTrades(result?.trades ?? [], bot.enabledAt).paperTrades, expectation), [result, bot.enabledAt, expectation])
  const degradedText = health.verdict === 'degraded' ? health.reasons.join('; ') : null
  // A bot that asks no model is told by the hourly scheduler (./StrategyHealthScheduler.tsx, since
  // 8 October 2026), whether or not this card is open; a bot that does is told from here, where its
  // dry run already runs. The thread is the bot's own either way: once a day.
  const toldHere = bot.strategyId === GPT_INTRADAY_STRATEGY_ID || confirmsEntries(bot)
  useEffect(() => {
    if (degradedText === null || !toldHere) return
    // The notice in the person's language (V6 Stage 14): the card itself is an expert page's, in English.
    const say = noticeI18n()
    const reasons = strategyHealth(summarizePaperTrades(result?.trades ?? [], bot.enabledAt).paperTrades, expectation, say).reasons.join(say.t('; '))
    const notice = breakerNotice(
      'strategy',
      say.t('{bot}: {reasons}. It keeps running on paper; stop it under Strategies › Active Runs if that is what you want.', { bot: bot.name, reasons }),
      `strategy:${bot.id}`,
      say
    )
    // A desktop that cannot show it is not a reason to fail the poll that read the trades.
    void window.api.notify(notice.title, notice.body, notice.extra.severity, notice.extra).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- told once a degraded reading appears, on its text
  }, [degradedText, toldHere, bot.id, bot.name])

  if (status === 'loading') {
    return <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '0.5rem 0' }}>Loading market data…</div>
  }
  if (status === 'error') {
    return <div style={{ fontSize: '0.75rem', color: 'var(--down)', padding: '0.5rem 0' }}>Dry-run error: {error}</div>
  }
  if (!result || !latestCandle) return <></>

  const open = classifyBotOpenPosition(result.openPositionAtEnd, bot.enabledAt)
  const { paperTrades, paperWins, paperNetPct } = summarizePaperTrades(result.trades, bot.enabledAt)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.35rem',
        padding: '0.6rem 0',
        borderTop: '1px solid var(--border)',
        borderBottom: '1px solid var(--border)'
      }}
    >
      <span style={{ fontSize: '0.65rem', fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
        Dry Run (paper)
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem' }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: open.kind === 'bot' ? 'var(--up)' : 'var(--text-muted)',
            flexShrink: 0
          }}
        />
        {open.kind === 'bot' && (
          <span style={{ color: 'var(--text-primary)' }}>
            Long since {formatShortDate(open.position.entryTime)} @ {formatQuotePrice(open.position.entryPrice, bot.quoteAsset)}{' '}
            <span style={{ color: latestCandle.close >= open.position.entryPrice ? 'var(--up)' : 'var(--down)' }}>
              ({netUnrealizedPct(open.position.entryPrice, latestCandle.close).toFixed(2)}%)
            </span>
          </span>
        )}
        {open.kind === 'preexisting' && (
          <span style={{ color: 'var(--text-secondary)' }}>
            Flat — the strategy has been long since {formatShortDate(open.position.entryTime)}, from before you enabled
            this bot, so it is not counted as yours
          </span>
        )}
        {open.kind === 'none' && <span style={{ color: 'var(--text-secondary)' }}>Flat — waiting for signal</span>}
      </div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        {paperTrades.length === 0
          ? 'No paper trades yet'
          : `${paperTrades.length} paper trade${paperTrades.length === 1 ? '' : 's'} (${paperWins}W) · ${paperNetPct >= 0 ? '+' : ''}${paperNetPct.toFixed(2)}%`}
      </div>
      <div style={{ fontSize: '0.7rem', color: health.verdict === 'degraded' ? 'var(--gold)' : 'var(--text-muted)' }}>{describeStrategyHealth(health, expectation)}</div>
      {aiCalls && (
        <div style={{ fontSize: '0.68rem', color: describeAiCalls(aiCalls).bad ? 'var(--down)' : 'var(--text-muted)' }}>
          {describeAiCalls(aiCalls).text}
        </div>
      )}
      {proposal !== null && onPrepareOrder && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem', marginTop: '0.15rem' }}>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, color: 'var(--up)' }}>
            The model said BUY at {Math.round(proposal.confidence * 100)}% for the {formatUtcTime(proposal.candleTime)} UTC candle
          </span>
          <button
            onClick={() => onPrepareOrder(proposal)}
            style={{
              alignSelf: 'flex-start',
              padding: '0.3rem 0.6rem',
              fontSize: '0.72rem',
              fontWeight: 600,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--border)',
              background: 'var(--bg-app)',
              color: 'var(--text-primary)',
              cursor: 'pointer'
            }}
          >
            Prepare an order from this call
          </button>
        </div>
      )}
    </div>
  )
}

export function BotCard({ bot, onToggle, onArchive, onViewDetail, onPrepareOrder }: BotCardProps): React.JSX.Element {
  const strategy = resolvedStrategy(bot)
  const exchangeName = EXCHANGES.find((e) => e.id === bot.exchange)?.name ?? bot.exchange

  return (
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        padding: '1.1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.7rem'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: '50%',
            background: 'var(--accent-soft)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <BotIcon size={13} color="var(--accent)" />
        </div>
        <button
          onClick={() => onArchive(bot.id)}
          title="Archive bot"
          aria-label={`Archive ${bot.name}`}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.2rem' }}
        >
          <Archive size={14} />
        </button>
      </div>

      <button
        onClick={() => onViewDetail(bot.id)}
        title={`Open ${bot.name}`}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: '0.5rem',
          textAlign: 'center',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer'
        }}
      >
        <div
          style={{
            width: 60,
            height: 60,
            borderRadius: '50%',
            background: 'var(--accent-soft)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <BotIcon size={26} color="var(--accent)" />
        </div>
        <span
          style={{
            fontWeight: 700,
            color: 'var(--text-primary)',
            fontSize: '0.95rem',
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {bot.name}
        </span>
      </button>

      <div style={{ display: 'flex', justifyContent: 'center', gap: '1.6rem' }}>
        <div style={statColumnStyle()}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Exchange</span>
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>{exchangeName}</span>
        </div>
        <div style={statColumnStyle()}>
          <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Pair</span>
          <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {bot.baseAsset}-{bot.quoteAsset}
          </span>
        </div>
      </div>

      <div
        style={{
          fontSize: '0.75rem',
          color: 'var(--text-muted)',
          textAlign: 'center',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap'
        }}
      >
        {strategy.name}
        {confirmsEntries(bot) && ' + AI confirmation'}
        {gptCadenceOf(bot) > 1 && ` · asked every ${describeGptCadence(gptCadenceOf(bot))}`}
        {/* Only while it is running: the route is a pin taken when a bot is switched on, and the
            next time this one is switched on it takes whatever is set then. */}
        {bot.enabled && describeBotRouteKind(bot) !== null && ` · ${describeBotRouteKind(bot)}`}
      </div>
      {strategy.mismatched && (
        <div
          title={`Stored as "${strategy.label}", but no strategy id is set, so the dry run falls back to ${strategy.name}. Recreate the bot to pick one deliberately.`}
          style={{
            fontSize: '0.68rem',
            color: 'var(--down)',
            textAlign: 'center',
            marginTop: '0.15rem'
          }}
        >
          labelled &ldquo;{strategy.label}&rdquo; &middot; running {strategy.name}
        </div>
      )}

      {bot.enabled && <DryRunPanel bot={bot} onPrepareOrder={onPrepareOrder} />}

      <button
        onClick={() => onViewDetail(bot.id)}
        style={{
          background: 'transparent',
          border: '1px solid var(--border)',
          borderRadius: 999,
          padding: '0.5rem',
          color: 'var(--text-secondary)',
          fontSize: '0.78rem',
          fontWeight: 600,
          cursor: 'pointer'
        }}
      >
        View Chart
      </button>

      <button
        onClick={() => onToggle(bot.id)}
        style={
          bot.enabled
            ? {
                background: 'var(--bg-app)',
                border: '1px solid var(--border)',
                borderRadius: 999,
                padding: '0.55rem',
                color: 'var(--text-primary)',
                fontSize: '0.8rem',
                fontWeight: 700,
                cursor: 'pointer'
              }
            : {
                background: 'linear-gradient(135deg, #7c86ff, #6366f1)',
                border: 'none',
                borderRadius: 999,
                padding: '0.55rem',
                color: '#fff',
                fontSize: '0.8rem',
                fontWeight: 700,
                cursor: 'pointer'
              }
        }
      >
        {bot.enabled ? 'Disable Bot' : 'Enable Bot'}
      </button>
    </div>
  )
}
