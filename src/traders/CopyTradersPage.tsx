import { useEffect, useMemo, useState } from 'react'
import { Card } from '../components/Card'
import { PageHeader } from '../components/PageHeader'
import { buttonStyle, cellStyle, headCellStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { traderRefOf } from '../../shared/traders/traderRef'
import { DELAY_LINES } from '../../shared/traders/delay'
import { SKILL_LINES, type SkillResult } from '../../shared/traders/skill'
import type { BitgetCopyCheck, TraderAnalysis, TraderList, TraderProgress } from '../../shared/traders/traderAnalysis'

// COPY TRADERS (V8 Stage 6, 26 October 2026; electron/services/traderService.ts). A person pastes a trader -- a
// Hyperliquid address, an explorer's link -- and the app reads their record from the venue (VERIFIED: the venue's own
// fills), keeps it, rebuilds their round trips, works out what they made after fees and funding, and judges the record
// by two registered tests: is it skill beyond the market and chance (V8-S6-SKILL), and could it be followed late
// (V8-S6-DELAY). And, on its own button, the read-only Bitget copy-trading check with the person's own key. Nothing here
// follows a trader or places anything. English until V8 Stage 8.

const usd = (value: number, digits = 2): string => `${value < 0 ? '−' : ''}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`
const pct = (value: number | null | undefined, digits = 2): string => (value === null || value === undefined || !Number.isFinite(value) ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}%`)
const day = (ms: number | null): string => (ms === null ? '—' : new Date(ms).toISOString().slice(0, 10))
const shortId = (id: string): string => (id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id)
const minutes = (value: number): string => (value < 1 ? `${Math.round(value * 60)} s` : value < 90 ? `${value.toFixed(0)} min` : value < 48 * 60 ? `${(value / 60).toFixed(1)} h` : `${(value / 1440).toFixed(1)} days`)
/** A multiple of the account: whole above ten, one decimal above a tenth, two significant figures below. */
const times = (value: number): string => `${value >= 10 ? value.toFixed(0) : value >= 0.1 ? value.toFixed(1) : value.toPrecision(2)}x`
const count = (value: number): string => value.toLocaleString('en-US')

const VERDICT_COLOR: Record<SkillResult['verdict'], string> = { SKILL: 'var(--up)', 'MARKET OR LUCK': 'var(--text-secondary)', 'TOO FEW': 'var(--text-muted)' }

const row: React.CSSProperties = { display: 'flex', gap: '1rem', padding: '0.22rem 0', alignItems: 'baseline', flexWrap: 'wrap' }
const label: React.CSSProperties = { fontSize: '0.66rem', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: 'var(--text-muted)', flex: '0 0 11rem' }
const value: React.CSSProperties = { fontSize: '0.86rem', flex: '1 1 18rem', minWidth: 0, fontVariantNumeric: 'tabular-nums' }

function Line({ name, children }: { name: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={row}>
      <span style={label}>{name}</span>
      <span style={value}>{children}</span>
    </div>
  )
}

/** What the record says: the figures of the completed round trips, and what is open now. */
function FiguresView({ analysis }: { analysis: TraderAnalysis }): React.JSX.Element {
  const { figures, record } = analysis
  const mapped = new Map(analysis.mapping.map((entry) => [entry.coin, entry]))
  return (
    <div>
      <Line name="Record">
        {record.fills.toLocaleString('en-US')} fills from Hyperliquid, VERIFIED (the venue's own record), {day(record.firstMs)} to {day(record.lastMs)}
        {record.fillsCapped ? ' -- the most recent 10,000 Hyperliquid gives; older fills are not read' : ''}
      </Line>
      <Line name="Round trips">
        {count(figures.trips)} completed
        {figures.span !== null ? ` over ${count(Number(figures.span.calendarDays.toFixed(1)))} days, on ${count(figures.span.tradingDays)} trading days` : ''}
        {figures.partial > 0 ? `; ${count(figures.partial)} left out (opened before the record, or with fills the record lacks)` : ''}
        {figures.spotFills > 0 ? `; ${count(figures.spotFills)} spot fills apart` : ''}
      </Line>
      <Line name="Net after fees and funding">
        {usd(figures.money.net)} (closed {usd(figures.money.realized)}, fees {usd(-figures.money.fees)}, funding {usd(figures.money.funding)}
        {figures.money.rebates > 0 ? `; maker rebates earned ${usd(figures.money.rebates)}, counted in the fees` : ''})
      </Line>
      <Line name="Win rate">{figures.winRate === null ? '—' : `${(figures.winRate * 100).toFixed(1)}% of trips made money after fees and funding`}</Line>
      <Line name="Largest fall">
        {usd(figures.drawdown.usdc)} from a high of the trips' cumulative net
        {figures.drawdown.pctOfAccount !== null ? `, ${figures.drawdown.pctOfAccount.toFixed(1)}% of the account then` : ''} (money in and out moves no figure here)
      </Line>
      <Line name="Holding time">{figures.holdMin === null ? '—' : `median ${minutes(figures.holdMin.median)}; one in ten under ${minutes(figures.holdMin.p10)}, one in ten over ${minutes(figures.holdMin.p90)}`}</Line>
      <Line name="Stake and leverage">
        {figures.stake === null ? '—' : `median ${usd(figures.stake.medianUsdc, 0)} at entry`}
        {figures.leverage !== null ? `; ${times(figures.leverage.median)} the account's value at the median, ${times(figures.leverage.max)} at most (${count(figures.leverage.trips)} trips)` : '; leverage not known: no account history'}
      </Line>
      <Line name="Money in and out">
        deposits {usd(figures.ledger.deposits)}, withdrawals {usd(figures.ledger.withdrawals)} over the trips' span
      </Line>
      {figures.open.positions.length > 0 && (
        <Line name="Open now">
          {figures.open.positions.map((position) => `${position.coin} ${position.size > 0 ? 'long' : 'short'} ${usd(position.positionValue, 0)}${position.leverage ? ` at ${position.leverage.value}x ${position.leverage.type}` : ''}`).join(', ')}; unrealized {usd(figures.open.unrealized)}
        </Line>
      )}
      <div style={{ overflowX: 'auto', marginTop: '0.5rem' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Coin', 'Trips', 'Net', 'Perpetual it is read on'].map((name) => (
                <th key={name} style={headCellStyle}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {figures.coins.map((coin) => {
              const venue = mapped.get(coin.coin)
              return (
                <tr key={coin.coin}>
                  <td style={{ ...cellStyle, fontWeight: 600 }}>{coin.coin}</td>
                  <td style={cellStyle}>{count(coin.trips)}</td>
                  <td style={cellStyle}>{usd(coin.net)}</td>
                  <td style={{ ...cellStyle, color: 'var(--text-secondary)' }}>
                    {venue === undefined ? 'none found: its trips are without bars in the tests' : `${venue.venue === 'binance' ? 'Binance' : 'Bitget'} ${venue.symbol}`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** V8-S6-SKILL's result. */
function SkillView({ skill, analysed, medianHoldMin }: { skill: SkillResult | null; analysed: number; medianHoldMin: number | null }): React.JSX.Element {
  if (skill === null) return <p style={noteStyle}>The test could not be run: see what could not be read, below.</p>
  return (
    <div>
      <p style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: VERDICT_COLOR[skill.verdict] }}>{skill.verdict}</p>
      {skill.reasons.length > 0 && (
        <ul style={{ ...noteStyle, margin: '0.3rem 0 0', paddingInlineStart: '1.1rem' }}>
          {skill.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <div style={{ marginTop: '0.5rem' }}>
        <Line name="Edge per trip">
          {pct(skill.edgePct, 3)} at 1x, less the market's drift
          {skill.interval !== null ? ` (95%: ${pct(skill.interval.low, 3)} to ${pct(skill.interval.high, 3)}, by trading day)` : ''}
        </Line>
        <Line name="First half, second half">{skill.halvesPct === null ? '—' : `${pct(skill.halvesPct[0], 3)}, ${pct(skill.halvesPct[1], 3)}`}</Line>
        <Line name="Shifted schedule">{skill.pShift === null ? 'not asked' : `does as well ${(skill.pShift * 100).toFixed(2)}% of the time (${skill.draws.toLocaleString('en-US')} draws)`}</Line>
        <Line name="Sides by a coin toss">{skill.pFlip === null ? 'not asked' : `do as well ${(skill.pFlip * 100).toFixed(2)}% of the time (${skill.draws.toLocaleString('en-US')} draws)`}</Line>
        <Line name="Read on">
          {count(skill.trips)} trips on {count(skill.tradingDays)} trading days over {count(Number(skill.spanDays.toFixed(1)))} days
          {skill.withoutBars > 0 ? `; ${count(skill.withoutBars)} without a venue's bars at their times, left out` : ''}
          {skill.betaOfOne > 0 ? `; ${skill.betaOfOne} with too little history for a beta, given 1` : ''}
        </Line>
      </div>
      {medianHoldMin !== null && medianHoldMin < SKILL_LINES.nullBarMinutes && (
        <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
          Half of these trips were held under {SKILL_LINES.nullBarMinutes} minutes, the bars the shifted schedule is measured on: that null sees little of
          them, and the test can say little either way.
        </p>
      )}
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        SKILL needs both chances at {SKILL_LINES.alpha * 100}% or less, the edge's interval above 0 and both halves positive; under {SKILL_LINES.minTrips} trips,{' '}
        {SKILL_LINES.minTradingDays} trading days or {SKILL_LINES.minSpanDays} days the record is TOO FEW. A verdict reads one trader's own record: {analysed}{' '}
        {analysed === 1 ? 'trader has' : 'traders have'} been analysed here, and at 1% about one in a hundred would pass by chance alone. A past record is a screen,
        not a promise.
      </p>
    </div>
  )
}

/** V8-S6-DELAY's rows. */
function DelayView({ analysis }: { analysis: TraderAnalysis }): React.JSX.Element {
  const delay = analysis.delay
  if (delay === null) return <p style={noteStyle}>The test could not be run: see what could not be read, below.</p>
  if (delay.trips === 0) return <p style={noteStyle}>No completed trip in the last {DELAY_LINES.lookbackDays} days on a coin a venue's perpetual covers: nothing to copy late.</p>
  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Copied late by', 'Costs', 'Trips', 'Mean net per trip', '95% interval', 'Above 0'].map((name) => (
                <th key={name} style={headCellStyle}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {delay.rows.map((entry) => (
              <tr key={`${entry.delayMin}:${entry.costMultiplier}`}>
                <td style={cellStyle}>{entry.delayMin} min</td>
                <td style={cellStyle}>{entry.costMultiplier === 1 ? 'fees and impact' : 'twice them'}</td>
                <td style={cellStyle}>
                  {entry.n}
                  {entry.missing > 0 ? ` (${entry.missing} without bars)` : ''}
                </td>
                <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{pct(entry.meanNetPct, 3)}</td>
                <td style={{ ...cellStyle, fontVariantNumeric: 'tabular-nums' }}>{entry.interval === null ? '—' : `${pct(entry.interval.low, 3)} to ${pct(entry.interval.high, 3)}`}</td>
                <td style={{ ...cellStyle, color: entry.aboveZero ? 'var(--up)' : 'var(--text-secondary)' }}>{entry.aboveZero ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
        The last {DELAY_LINES.lookbackDays} days' trips, {count(delay.trips)} of them{delay.noVenue > 0 ? ` (${count(delay.noVenue)} on coins no venue's perpetual covers, or whose minutes could not be read, left out)` : ''}, copied as a follower
        would: in and out at the next minute's open of the venue's perpetual, charged the taker fee and the larger of 2 bps and the book's impact at{' '}
        {DELAY_LINES.stakeQuote.toLocaleString('en-US')} USDT each way, and the funding the copy's hold crossed
        {delay.impactAssumed.length > 0 ? `; no book read for ${delay.impactAssumed.join(', ')}: 2 bps charged` : ''}
        {delay.fundingAssumed > 0 ? `; ${delay.fundingAssumed} trips' funding assumed at 0.01% against them each eight hours, none published` : ''}. A trader is called
        followable only at a delay a follow has measured live, and no follow has run yet: no one is called followable. Rows at 0 and 30 seconds need one-second
        bars no venue gives for its perpetuals.
      </p>
    </div>
  )
}

/** The read-only Bitget copy-trading check, on its button. */
function BitgetCheck(): React.JSX.Element {
  const [check, setCheck] = useState<BitgetCopyCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const ask = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      setCheck(await window.api.traders.bitgetCheck())
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const read = check?.followerRead ?? null
  return (
    <Card title="Your Bitget copy trading">
      <p style={{ ...noteStyle, marginTop: 0 }}>
        Bitget publishes no lead trader's trades without a key. With the key on Connections, this asks Bitget three things, each a read and only when you press it:
        the account's mode, whether the key may read copy trading, and the traders it copies. Nothing is subscribed, changed or placed.
      </p>
      <button type="button" style={buttonStyle('secondary', busy)} disabled={busy} onClick={() => void ask()}>
        {busy ? 'Asking Bitget…' : 'Check my Bitget copy trading (read-only)'}
      </button>
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginTop: '0.4rem' }}>{problem}</p>}
      {check !== null && !check.configured && <p style={{ ...noteStyle, marginTop: '0.5rem' }}>No Bitget key is set on Connections: nothing was asked.</p>}
      {check !== null && check.configured && (
        <div style={{ marginTop: '0.5rem' }}>
          <Line name="Account mode">
            {check.accountMode === 'uta' ? 'Unified Trading Account' : check.accountMode === 'classic' ? 'Classic' : check.accountMode === 'unknown' ? 'not known' : 'not read'}
            {check.modeProblem !== null ? ` -- ${check.modeProblem}` : ''}
          </Line>
          <Line name="Copy trading read">
            {read === null ? '—' : read.ok ? `allowed (${read.endpoint})` : `refused${read.code !== null ? ` (${read.code})` : ''}: ${read.message}`}
          </Line>
          {read?.ok === true && (
            <Line name="Traders copied">{read.traders.length === 0 ? 'none' : read.traders.map((trader) => (trader.name === null ? trader.id : `${trader.name} (${trader.id})`)).join(', ')}</Line>
          )}
        </div>
      )}
    </Card>
  )
}

export function CopyTradersPage(): React.JSX.Element {
  const [paste, setPaste] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [list, setList] = useState<TraderList>({ traders: [], analysed: 0 })
  const [open, setOpen] = useState<string | null>(null)
  const [progress, setProgress] = useState<TraderProgress | null>(null)
  const parsed = useMemo(() => (paste.trim() === '' ? null : traderRefOf(paste)), [paste])

  const refresh = async (): Promise<void> => {
    setList(await window.api.traders.list())
  }
  useEffect(() => {
    void refresh().catch(() => undefined)
    return window.api.traders.onProgress((step) => setProgress(step))
  }, [])

  const selected = list.traders.find((entry) => entry.meta.ref.key === open) ?? null

  const read = async (raw: string): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      const kept = await window.api.traders.import(raw)
      if ('refused' in kept) {
        setProblem(kept.refused)
        return
      }
      setOpen(kept.ref.key)
      await window.api.traders.analyze(kept.ref.key)
      await refresh()
      setPaste('')
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  return (
    <>
      <PageHeader title="Copy Traders" subtitle="Paste a trader: the app reads their record from the venue, works out what they made after fees and funding, and tests whether it is skill and whether it could be followed late" />
      <Card title="Read a trader">
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <input value={paste} onChange={(change) => setPaste(change.target.value)} placeholder="0x… or a Hyperliquid explorer link" style={{ ...inputStyle(), flex: '1 1 26rem' }} aria-label="Trader" dir="ltr" />
          <button type="button" style={buttonStyle('primary', busy || parsed === null || !parsed.ok)} disabled={busy || parsed === null || !parsed.ok} onClick={() => void read(paste)}>
            {busy ? 'Reading…' : 'Read and analyse'}
          </button>
        </div>
        {parsed !== null && (
          <p style={{ ...noteStyle, marginTop: '0.4rem', color: parsed.ok ? 'var(--text-secondary)' : 'var(--down)' }}>
            {parsed.ok ? `${parsed.ref.venue === 'hyperliquid' ? 'A Hyperliquid address' : "An OKX lead trader"}: ${parsed.ref.id}` : parsed.reason}
          </p>
        )}
        {busy && progress !== null && <p style={{ ...noteStyle, marginTop: '0.4rem' }}>{progress.step}…</p>}
        {problem !== null && <p style={{ ...noteStyle, marginTop: '0.4rem', color: 'var(--down)' }}>{problem}</p>}
        <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
          A paste is read as text and never opened. A Hyperliquid address's fills, funding, deposits and withdrawals and its open positions are read from Hyperliquid's
          public API, without a key, and kept; the perpetual bars, funding and books the tests need are read from Binance, or Bitget where Binance lists none. A
          record of years on several coins takes ten minutes or so, its steps shown as it goes. Nothing is followed or placed here.
        </p>
      </Card>
      {selected !== null && selected.latest !== null && (
        <>
          <Card title={`What the record says -- ${shortId(selected.meta.ref.id)}`}>
            <FiguresView analysis={selected.latest} />
          </Card>
          <Card title="Is it skill?">
            <SkillView skill={selected.latest.skill} analysed={list.analysed} medianHoldMin={selected.latest.figures.holdMin?.median ?? null} />
          </Card>
          <Card title="Could it be followed?">
            <DelayView analysis={selected.latest} />
          </Card>
          {selected.latest.problems.length > 0 && (
            <Card title="What could not be read">
              <ul style={{ ...noteStyle, margin: 0, paddingInlineStart: '1.1rem' }}>
                {selected.latest.problems.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      <Card title="Traders on file">
        {list.traders.length === 0 ? (
          <p style={noteStyle}>None yet.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Trader', 'Fills', 'Read', 'Trips', 'Net', 'Skill', ''].map((name) => (
                    <th key={name} style={headCellStyle}>
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {list.traders.map((entry) => (
                  <tr key={entry.meta.ref.key} onClick={() => setOpen(entry.meta.ref.key)} style={{ cursor: 'pointer', background: open === entry.meta.ref.key ? 'var(--bg-app)' : undefined }}>
                    <td dir="ltr" style={{ ...cellStyle, fontWeight: 600 }}>
                      {shortId(entry.meta.ref.id)}
                    </td>
                    <td style={cellStyle}>{entry.meta.fills.toLocaleString('en-US')}</td>
                    <td style={cellStyle}>{new Date(entry.meta.importedAt * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC</td>
                    <td style={cellStyle}>{entry.latest === null ? '—' : count(entry.latest.figures.trips)}</td>
                    <td style={cellStyle}>{entry.latest === null ? '—' : usd(entry.latest.figures.money.net)}</td>
                    <td style={{ ...cellStyle, color: entry.latest?.skill ? VERDICT_COLOR[entry.latest.skill.verdict] : 'var(--text-muted)' }}>{entry.latest?.skill?.verdict ?? 'not analysed'}</td>
                    <td style={cellStyle}>
                      <button
                        type="button"
                        style={buttonStyle('secondary', busy)}
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation()
                          void read(entry.meta.ref.id)
                        }}
                      >
                        Read again
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
          {list.analysed} {list.analysed === 1 ? 'trader has' : 'traders have'} been analysed here.
        </p>
      </Card>
      <BitgetCheck />
    </>
  )
}
