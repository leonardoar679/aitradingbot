import type { ExecutorSide, PositionExecutorParams } from '../../shared/ipc'
import { fieldLabelStyle, textInputStyle, sideButtonStyle } from './formStyles'
import {
  MAX_LEVERAGE,
  MIN_LEVERAGE,
  isUsableLeverage,
  liquidationDistancePct,
  liquidationPrice,
  notionalFor,
  resolveLeverage
} from '../../shared/perp'
import { msg, useI18n } from '../i18n'

const SIDE_WORDS: Record<ExecutorSide, string> = { buy: msg('buy@@order side'), sell: msg('sell@@order side') }

interface PositionFormProps {
  params: PositionExecutorParams
  onChange: (params: PositionExecutorParams) => void
}

export function PositionForm({ params, onChange }: PositionFormProps): React.JSX.Element {
  const i18n = useI18n()
  const { t } = i18n
  /** A figure the person typed or the form worked out, as English always showed it, else in the language's form. */
  const figure = (value: number, digits?: number): string =>
    i18n.language === 'en' ? (digits === undefined ? String(value) : value.toFixed(digits)) : digits === undefined ? i18n.num(value, 0, 8) : i18n.num(value, digits, digits)
  function set<K extends keyof PositionExecutorParams>(key: K, value: PositionExecutorParams[K]): void {
    onChange({ ...params, [key]: value })
  }

  const trailingEnabled = params.trailingStop !== null

  // Leverage is shown with its consequence attached, never as a bare multiplier. A beginner reads
  // "10x" as "ten times the profit" -- which is true, and is also the half that doesn't hurt them.
  // The half that does is that a 10% dip ends the position entirely, so that sentence is rendered
  // right under the field rather than left for them to work out.
  const enteredLeverage = params.leverage
  const leverageOutOfRange = enteredLeverage !== undefined && !isUsableLeverage(enteredLeverage)
  const leverage = resolveLeverage(enteredLeverage)
  const distancePct = liquidationDistancePct(leverage)
  const liqPrice =
    params.entryPrice !== null && params.entryPrice > 0
      ? liquidationPrice({ entryPrice: params.entryPrice, leverage, side: params.side })
      : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        {(['buy', 'sell'] as ExecutorSide[]).map((s) => (
          <button key={s} style={sideButtonStyle(params.side === s, s)} onClick={() => set('side', s)}>
            {t(SIDE_WORDS[s])}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>{t('Entry Price (blank = market)')}</label>
          <input
            type="number"
            value={params.entryPrice ?? ''}
            onChange={(e) => set('entryPrice', e.target.value ? Number(e.target.value) : null)}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>{t('Amount (quote)')}</label>
          <input
            type="number"
            value={params.amountQuote || ''}
            onChange={(e) => set('amountQuote', Number(e.target.value))}
            style={textInputStyle()}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>{t('Take Profit % (optional)')}</label>
          <input
            type="number"
            step="0.1"
            value={params.takeProfitPct ?? ''}
            onChange={(e) => set('takeProfitPct', e.target.value ? Number(e.target.value) : null)}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>{t('Stop Loss % (optional)')}</label>
          <input
            type="number"
            step="0.1"
            value={params.stopLossPct ?? ''}
            onChange={(e) => set('stopLossPct', e.target.value ? Number(e.target.value) : null)}
            style={textInputStyle()}
          />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.7rem' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>{t('Time Limit, hours (optional)')}</label>
          <input
            type="number"
            value={params.timeLimitSec !== null ? params.timeLimitSec / 3600 : ''}
            onChange={(e) => set('timeLimitSec', e.target.value ? Number(e.target.value) * 3600 : null)}
            style={textInputStyle()}
          />
        </div>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle()}>{t('Leverage (blank = 1x, no leverage)')}</label>
          <input
            type="number"
            step="1"
            min={MIN_LEVERAGE}
            max={MAX_LEVERAGE}
            placeholder="1"
            value={params.leverage ?? ''}
            onChange={(e) => set('leverage', e.target.value ? Number(e.target.value) : undefined)}
            style={textInputStyle()}
          />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
        {leverageOutOfRange ? (
          <p style={{ fontSize: '0.72rem', color: 'var(--down)', margin: 0 }}>
            {t('Leverage has to be between {min} and {max}. This will be simulated at 1x.', { min: MIN_LEVERAGE, max: MAX_LEVERAGE })}
          </p>
        ) : leverage === 1 ? (
          <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>
            {t('1x is no leverage: you hold what you paid for, and no fall in price can close the position for you.')}
          </p>
        ) : (
          <>
            <p style={{ fontSize: '0.72rem', color: 'var(--down)', margin: 0, fontWeight: 600 }}>
              {((): string => {
                const values = {
                  leverage: figure(leverage),
                  amount: figure(params.amountQuote || 0),
                  notional: figure(notionalFor(params.amountQuote || 0, leverage)),
                  distance: distancePct !== null ? figure(distancePct, 2) : '—',
                  price: liqPrice !== null ? figure(liqPrice, 2) : ''
                }
                return liqPrice !== null
                  ? t('At {leverage}x, {amount} controls {notional} of the market. A {distance}% move against you — down to {price} wipes out the entire {amount}: the position is closed for you and the whole amount is gone.', values)
                  : t('At {leverage}x, {amount} controls {notional} of the market. A {distance}% move against you wipes out the entire {amount}: the position is closed for you and the whole amount is gone.', values)
              })()}
            </p>
            <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', margin: 0 }}>
              {t(
                'The fees scale too — {leverage}x leverage costs {leverage}x the trading fee on the same amount — and a leveraged position pays funding roughly every 8 hours just to stay open. Simulation only: this app has no futures connection, so live trading is refused above 1x.',
                { leverage: figure(leverage) }
              )}
            </p>
          </>
        )}
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-primary)', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={trailingEnabled}
          onChange={(e) => set('trailingStop', e.target.checked ? { activationPct: 1, trailPct: 0.5 } : null)}
        />
        {t('Trailing stop')}
      </label>

      {trailingEnabled && params.trailingStop && (
        <div style={{ display: 'flex', gap: '0.7rem' }}>
          <div style={{ flex: 1 }}>
            <label style={fieldLabelStyle()}>{t('Activation %')}</label>
            <input
              type="number"
              step="0.1"
              value={params.trailingStop.activationPct || ''}
              onChange={(e) => set('trailingStop', { ...params.trailingStop!, activationPct: Number(e.target.value) })}
              style={textInputStyle()}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label style={fieldLabelStyle()}>{t('Trail %')}</label>
            <input
              type="number"
              step="0.1"
              value={params.trailingStop.trailPct || ''}
              onChange={(e) => set('trailingStop', { ...params.trailingStop!, trailPct: Number(e.target.value) })}
              style={textInputStyle()}
            />
          </div>
        </div>
      )}
    </div>
  )
}
