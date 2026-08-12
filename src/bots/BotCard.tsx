import { Bot as BotIcon, Archive } from 'lucide-react'
import { EXCHANGES } from '../../shared/ipc'
import { useDryRun } from './useDryRun'
import type { Bot } from './types'

interface BotCardProps {
  bot: Bot
  onToggle: (id: string) => void
  onArchive: (id: string) => void
  onViewDetail: (id: string) => void
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
function DryRunPanel({ bot }: { bot: Bot }): React.JSX.Element {
  const { status, error, result, latestCandle } = useDryRun(bot.exchange, bot.symbol, bot.enabled, bot.enabledAt)

  if (status === 'loading') {
    return <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', padding: '0.5rem 0' }}>Loading market data…</div>
  }
  if (status === 'error') {
    return <div style={{ fontSize: '0.75rem', color: 'var(--down)', padding: '0.5rem 0' }}>Dry-run error: {error}</div>
  }
  if (!result || !latestCandle) return <></>

  const openPosition = result.openPositionAtEnd
  const paperTrades = bot.enabledAt !== null ? result.trades.filter((t) => t.entryTime >= bot.enabledAt!) : []
  const paperWins = paperTrades.filter((t) => t.pnl > 0).length
  const paperNetPct =
    paperTrades.length > 0 ? (paperTrades.reduce((acc, t) => acc * (1 + t.returnPct / 100), 1) - 1) * 100 : 0

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
            background: openPosition ? 'var(--up)' : 'var(--text-muted)',
            flexShrink: 0
          }}
        />
        {openPosition ? (
          <span style={{ color: 'var(--text-primary)' }}>
            Long since {formatShortDate(openPosition.entryTime)} @ {openPosition.entryPrice.toFixed(2)}{' '}
            <span style={{ color: latestCandle.close >= openPosition.entryPrice ? 'var(--up)' : 'var(--down)' }}>
              ({((latestCandle.close / openPosition.entryPrice - 1) * 100).toFixed(2)}%)
            </span>
          </span>
        ) : (
          <span style={{ color: 'var(--text-secondary)' }}>Flat — waiting for signal</span>
        )}
      </div>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        {paperTrades.length === 0
          ? 'No paper trades yet'
          : `${paperTrades.length} paper trade${paperTrades.length === 1 ? '' : 's'} (${paperWins}W) · ${paperNetPct >= 0 ? '+' : ''}${paperNetPct.toFixed(2)}%`}
      </div>
    </div>
  )
}

export function BotCard({ bot, onToggle, onArchive, onViewDetail }: BotCardProps): React.JSX.Element {
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
          style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.2rem' }}
        >
          <Archive size={14} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem', textAlign: 'center' }}>
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
      </div>

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
        {bot.strategy}
      </div>

      {bot.enabled && <DryRunPanel bot={bot} />}

      {bot.enabled && (
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
      )}

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
