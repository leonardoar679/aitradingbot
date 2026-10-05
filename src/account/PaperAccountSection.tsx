import { useCallback, useEffect, useState } from 'react'
import { Wallet, Plus, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { Card } from '../components/Card'
import { StatCard } from '../components/StatCard'
import { formatQuotePrice } from '../utils/formatCurrency'
import { accountPnl, availableBalance, emptyAccount, fund, totalBalance } from './paperAccount'
import { assetsInPlay, committedByAsset, heldCostByAsset } from './accountCommitments'
import { updateAccount } from './persistAccount'
import type { AccountLedgerEntry, ExecutorConfig, HeldPosition, PaperAccount } from '../../shared/ipc'

/** Amount with its sign in front of the currency symbol, not inside it. */
function signed(value: number, asset: string): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}${formatQuotePrice(Math.abs(value), asset)}`
}

const SUGGESTED_ASSETS = ['USDT', 'USD', 'KRW', 'BTC', 'ETH']

function labelStyle(): React.CSSProperties {
  return { fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '0.4rem', display: 'block' }
}

function inputStyle(): React.CSSProperties {
  return {
    width: '100%',
    background: 'var(--bg-app)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-sm)',
    padding: '0.5rem 0.6rem',
    color: 'var(--text-primary)',
    fontSize: '0.85rem'
  }
}

function reasonLabel(entry: AccountLedgerEntry): string {
  if (entry.reason === 'fund') return 'Added funds'
  if (entry.reason === 'allocate') return 'Into a strategy'
  if (entry.reason === 'release') return 'Back from a strategy'
  if (entry.reason === 'reset') return 'Reset'
  return 'Adjustment'
}

/** Stand-in for a null account, so the page can render "nothing funded yet" instead of throwing.
 * Never mutated: every helper that receives it only reads. */
const EMPTY_ACCOUNT = emptyAccount(0)

/** The paper account: the simulated balance paper strategies spend and hand back. It is the paper
 * half of what was the Account page; the real balances are on Live Trading (LiveAccountSection). */
export function PaperAccountSection(): React.JSX.Element {
  const [account, setAccount] = useState<PaperAccount | null>(null)
  const [executors, setExecutors] = useState<ExecutorConfig[]>([])
  const [heldPositions, setHeldPositions] = useState<HeldPosition[]>([])
  const [loaded, setLoaded] = useState(false)
  const [asset, setAsset] = useState('USDT')
  const [amount, setAmount] = useState('10000')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const settings = await window.api.settings.get()
    setAccount(settings.paperAccount)
    setExecutors(settings.executors)
    setHeldPositions(settings.heldPositions ?? [])
    setLoaded(true)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const committed = committedByAsset(executors)
  // Inventory is part of the account too: that cash left the balance to buy the position.
  const heldCost = heldCostByAsset(heldPositions)
  // "No account yet" is a state to render, not an error. The row list is built from balances AND
  // from what executors have committed, so it is non-empty whenever a strategy is running even if
  // the account is null -- which is exactly the case that used to reach `totalBalance(account!)`
  // and throw "Cannot read properties of null (reading 'balances')", replacing the whole page with
  // the error boundary. Five paper executors and no funded account is enough to trigger it.
  //
  // Reading through an empty account is the honest rendering rather than a patch: totalBalance
  // reports 0 for an asset that was never funded, and availableBalance deliberately goes negative
  // when strategies are committed to more than the account holds -- see its comment. That negative
  // IS this situation, and showing it beats hiding the cards.
  const view = account ?? EMPTY_ACCOUNT
  const balances = view.balances
  const rows = assetsInPlay(balances, committed)

  async function handleFund(): Promise<void> {
    const value = Number(amount)
    const cleanAsset = asset.trim().toUpperCase()
    if (!cleanAsset) {
      setError('Enter an asset, for example USDT.')
      return
    }
    // Number('') is 0 and Number('abc') is NaN, so both need catching before this reaches the
    // account -- which would ignore them silently and leave the user staring at an unchanged
    // balance with no idea why.
    if (!Number.isFinite(value) || value <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const now = Math.floor(Date.now() / 1000)
      await updateAccount((a) => fund(a, { asset: cleanAsset, amount: value, now, id: crypto.randomUUID() }), now)
      await reload()
      setAmount('')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const totalRows = rows.length

  return (
    <>
      {loaded && account === null && (
        <Card title="Get started">
          <div style={{ display: 'flex', gap: '0.8rem', alignItems: 'flex-start' }}>
            <Wallet size={18} style={{ color: 'var(--gold)', flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: '0.92rem' }}>No account yet</div>
              <p style={{ margin: '0.35rem 0 0', fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                Choose what you want to pretend you hold and add it below — most people start with 10,000 USDT. Paper
                strategies spend from this balance and hand it back when they stop, so you can see whether a set of
                strategies would actually have grown your money rather than just whether each one looked good on its own.
                None of this is real money and nothing here touches an exchange.
              </p>
            </div>
          </div>
        </Card>
      )}

      {rows.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
          {rows.slice(0, 4).map((row) => {
            const total = totalBalance(view, row)
            const out = committed[row] ?? 0
            const available = availableBalance(view, row, out)
            const pnl = accountPnl(view, row, heldCost[row] ?? 0)
            return (
              <StatCard
                key={row}
                icon={Wallet}
                label={row}
                value={formatQuotePrice(total, row)}
                sub={
                  (heldCost[row] ?? 0) > 0
                    ? `${formatQuotePrice(available, row)} available · ${formatQuotePrice(out, row)} in strategies · ${formatQuotePrice(heldCost[row], row)} in inventory`
                    : `${formatQuotePrice(available, row)} available · ${formatQuotePrice(out, row)} in strategies`
                }
                subColor="var(--text-secondary)"
                valueColor={pnl > 0 ? 'var(--up)' : pnl < 0 ? 'var(--down)' : undefined}
              />
            )
          })}
        </div>
      )}

      <Card title="Add funds">
        <p style={{ margin: '0 0 0.9rem', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
          Simulated money. Adding funds raises your starting point too, so putting more in never shows up as profit.
        </p>
        <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 150 }}>
            <label style={labelStyle()}>Asset</label>
            <input
              list="account-asset-suggestions"
              value={asset}
              onChange={(e) => setAsset(e.target.value)}
              style={inputStyle()}
              placeholder="USDT"
            />
            <datalist id="account-asset-suggestions">
              {SUGGESTED_ASSETS.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </div>
          <div style={{ minWidth: 170 }}>
            <label style={labelStyle()}>Amount</label>
            <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} style={inputStyle()} placeholder="10000" />
          </div>
          <button
            onClick={() => void handleFund()}
            disabled={busy}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              background: busy ? 'var(--bg-surface-hover)' : 'var(--accent)',
              color: busy ? 'var(--text-muted)' : '#fff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              padding: '0.55rem 0.9rem',
              fontSize: '0.8rem',
              fontWeight: 700,
              cursor: busy ? 'not-allowed' : 'pointer'
            }}
          >
            <Plus size={14} /> Add funds
          </button>
        </div>
        {error && <p style={{ margin: '0.7rem 0 0', fontSize: '0.78rem', color: 'var(--down)' }}>{error}</p>}
      </Card>

      {totalRows > 0 && (
        <Card title="Balances">
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
              <thead>
                <tr style={{ color: 'var(--text-secondary)', textAlign: 'left' }}>
                  <th style={{ padding: '0.45rem 0.6rem' }}>Asset</th>
                  <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>Total</th>
                  <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>In strategies</th>
                  <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>In inventory</th>
                  <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>Available</th>
                  <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>Since funded</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const total = totalBalance(view, row)
                  const out = committed[row] ?? 0
                  const available = availableBalance(view, row, out)
                  const pnl = accountPnl(view, row, heldCost[row] ?? 0)
                  return (
                    <tr key={row} style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                      <td style={{ padding: '0.5rem 0.6rem', fontWeight: 600 }}>{row}</td>
                      <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right' }}>{formatQuotePrice(total, row)}</td>
                      <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right', color: 'var(--text-secondary)' }}>
                        {formatQuotePrice(out, row)}
                      </td>
                      <td style={{ padding: '0.5rem 0.6rem', textAlign: 'right', color: 'var(--text-secondary)' }}>
                        {formatQuotePrice(heldCost[row] ?? 0, row)}
                      </td>
                      <td
                        style={{
                          padding: '0.5rem 0.6rem',
                          textAlign: 'right',
                          color: available < 0 ? 'var(--down)' : 'var(--text-primary)'
                        }}
                      >
                        {available < 0 ? signed(available, row) : formatQuotePrice(available, row)}
                      </td>
                      <td
                        style={{
                          padding: '0.5rem 0.6rem',
                          textAlign: 'right',
                          color: pnl > 0 ? 'var(--up)' : pnl < 0 ? 'var(--down)' : 'var(--text-secondary)'
                        }}
                      >
                        {signed(pnl, row)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p style={{ margin: '0.8rem 0 0', fontSize: '0.74rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>
&quot;In strategies&quot; is money currently committed to running paper executors, worked out from the executors
            themselves rather than tracked separately, so it cannot drift. It is not spent: the total only changes when you
            add funds, a strategy finishes and books its result, or a strategy hands a position over to Inventory.
            &quot;In inventory&quot; is what those handed-over positions cost — that money really did leave the total to buy
            them, so &quot;since funded&quot; counts it back in rather than reporting a loss you have not made. It is shown
            at cost here; Positions and Performance price the same holdings at the market. Available can go negative if
            strategies were started before the account was funded. Live executors are excluded — they spend real money and keep their own ledger.
          </p>
        </Card>
      )}

      {account !== null && account.ledger.length > 0 && (
        <Card title="Movements">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {[...account.ledger]
              .reverse()
              .slice(0, 40)
              .map((entry) => (
                <div
                  key={entry.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.6rem',
                    padding: '0.45rem 0.1rem',
                    borderBottom: '1px solid var(--border)',
                    fontSize: '0.8rem'
                  }}
                >
                  {entry.delta >= 0 ? (
                    <ArrowDownLeft size={14} style={{ color: 'var(--up)', flexShrink: 0 }} />
                  ) : (
                    <ArrowUpRight size={14} style={{ color: 'var(--down)', flexShrink: 0 }} />
                  )}
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600, minWidth: 60 }}>{entry.asset}</span>
                  <span style={{ color: entry.delta >= 0 ? 'var(--up)' : 'var(--down)', minWidth: 110 }}>
                    {signed(entry.delta, entry.asset)}
                  </span>
                  <span style={{ color: 'var(--text-secondary)' }}>{reasonLabel(entry)}</span>
                  <span style={{ color: 'var(--text-muted)', marginLeft: 'auto', fontSize: '0.74rem' }}>
                    {new Date(entry.at * 1000).toLocaleString()}
                  </span>
                </div>
              ))}
          </div>
        </Card>
      )}
    </>
  )
}
