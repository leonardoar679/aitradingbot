import { EXCHANGES } from '../../shared/ipc'
import { useDryRun, classifyBotOpenPosition } from '../bots/useDryRun'
import { formatQuotePrice } from '../utils/formatCurrency'
import type { Bot } from '../bots/types'
import { netUnrealizedPct } from '../../shared/fees'

function pctColor(pct: number): string {
  return pct >= 0 ? 'var(--up)' : 'var(--down)'
}

const cellStyle: React.CSSProperties = { padding: '0.65rem 0.9rem', fontSize: '0.82rem' }

export function BotPositionRow({ bot }: { bot: Bot }): React.JSX.Element {
  const dryRun = useDryRun(bot.exchange, bot.symbol, true, bot.enabledAt, bot.strategyId)
  const exchangeName = EXCHANGES.find((e) => e.id === bot.exchange)?.name ?? bot.exchange
  // Only a position this bot actually entered is shown as the bot's -- see
  // classifyBotOpenPosition. A position the replay was already holding when the bot was switched
  // on belongs to the lookback window, not to the user, and attributing its entry price and P&L
  // here would put an unearned number on the Positions page.
  const open = classifyBotOpenPosition(dryRun.result?.openPositionAtEnd ?? null, bot.enabledAt)
  const position = open.kind === 'bot' ? open.position : null
  const markPrice = dryRun.latestCandle?.close ?? null
  const pnlPct = position && markPrice ? netUnrealizedPct(position.entryPrice, markPrice) : null

  return (
    <tr style={{ borderBottom: '1px solid var(--border)' }}>
      <td style={{ ...cellStyle, fontWeight: 600, color: 'var(--text-primary)' }}>
        {bot.name}
        <div style={{ fontSize: '0.7rem', fontWeight: 400, color: 'var(--text-muted)' }}>
          {exchangeName} • {bot.symbol}
        </div>
      </td>
      <td style={cellStyle}>
        {dryRun.status === 'loading' && <span style={{ color: 'var(--text-muted)' }}>Loading…</span>}
        {dryRun.status === 'error' && <span style={{ color: 'var(--down)' }}>Error</span>}
        {dryRun.status === 'running' && position && (
          <span style={{ color: 'var(--up)', fontWeight: 600 }}>Long</span>
        )}
        {dryRun.status === 'running' && !position && (
          <span style={{ color: 'var(--text-muted)' }}>
            Flat
            {open.kind === 'preexisting' && (
              <div style={{ fontSize: '0.68rem' }}>strategy long since before you enabled this bot</div>
            )}
          </span>
        )}
      </td>
      <td style={cellStyle}>{position ? formatQuotePrice(position.entryPrice, bot.quoteAsset) : '—'}</td>
      <td style={cellStyle}>{markPrice !== null ? formatQuotePrice(markPrice, bot.quoteAsset) : '—'}</td>
      <td style={cellStyle}>{position ? formatQuotePrice(position.stopPrice, bot.quoteAsset) : '—'}</td>
      <td style={{ ...cellStyle, fontWeight: 600, color: pnlPct !== null ? pctColor(pnlPct) : 'var(--text-muted)' }}>
        {pnlPct !== null ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%` : '—'}
      </td>
    </tr>
  )
}
