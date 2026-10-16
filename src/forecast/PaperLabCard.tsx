import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, cellStyle, headCellStyle, noteStyle } from '../agents/agentStyles'
import { LAB_RISK, LAB_STRATEGIES, labDailyNet, labDayOf, labStatsOf, type LabStrategy } from '../../shared/forecast/labTrader'
import { healForecastSettings } from '../../shared/forecast/training'
import type { AppSettings } from '../../shared/ipc'
import { paperEquity } from '../../shared/paperRisk'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { fundLab, labTraderBrowserDeps } from './labTrader'
import { lastLabPass, onLabPass } from './LabTraderScheduler'
import { pairText } from './forecastWords'
import { tableCsv, type LabTableData } from '../forecastLab/labTables'
import type { LabStats } from '../../shared/forecast/labTrader'

// THE PAPER LABORATORY'S CARD (V7.1 Stage 4, 16 October 2026), on the Forecast Lab: FUND, the four
// strategies' switches, the daily stop's standing, what the last pass did and the sensitivity counts, and
// each strategy's record. An expert page, in English. It writes the laboratory's switches and the paper
// account's funding, and nothing else; it places nothing real.

const STRATEGY_WORDS: Record<LabStrategy, { name: string; what: string }> = {
  strict: { name: 'STRICT', what: "the forecast trader's own rule -- a TRADE decision in an approved class or one on probation -- under the laboratory's caps" },
  direction: { name: 'DIRECTION', what: "a call whose P(up) came from a promoted direction model, held back by nothing but its opportunity class" },
  news: { name: 'NEWS EVENT', what: 'a call a story moved its way, from a kind the library had thirty stories of, held back by nothing but its class' },
  hybrid: { name: 'HYBRID', what: 'a call held back by nothing but its class, where Trend Regime 4h stood on its side at the moment' }
}

const money = (value: number | null, digits = 2): string => (value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits))
const share = (value: number | null): string => (value === null || !Number.isFinite(value) ? '—' : `${(value * 100).toFixed(1)}%`)

/** Each strategy's record as one table, the same for the card and its CSV. */
export function labStatsTable(stats: readonly LabStats[]): LabTableData {
  return {
    headers: ['Strategy', 'Opened', 'Closed', 'Open', 'Net (USDT)', 'Profit factor', 'Win rate', 'Expectancy a trade', 'Max drawdown', 'Fees', 'Slippage', 'Utilization'],
    rows: stats.map((row) => [
      STRATEGY_WORDS[row.strategy].name,
      row.opened,
      row.closed,
      row.open,
      money(row.netQuote),
      money(row.profitFactor),
      share(row.winRate),
      money(row.expectancyQuote),
      money(row.maxDrawdownQuote),
      money(row.feesQuote),
      money(row.slippageQuote),
      row.utilizationPct === null ? '—' : `${row.utilizationPct.toFixed(1)}%`
    ])
  }
}

export function PaperLabCard(): React.JSX.Element {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [pass, setPass] = useState(lastLabPass())
  const [problem, setProblem] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      void window.api.settings.get().then(
        (next) => {
          if (!cancelled) setSettings(next)
        },
        (failure) => {
          if (!cancelled) setProblem(describeError(failure))
        }
      )
    }
    read()
    const stop = onLabPass(() => {
      setPass(lastLabPass())
      read()
    })
    return (): void => {
      cancelled = true
      stop()
    }
  }, [])

  // The forecast's settings are written whole (a patch replaces them): the refit's and the trader's are kept.
  const setStrategy = (strategy: LabStrategy, on: boolean): void => {
    setBusy(true)
    setProblem(null)
    void settingsWrites(async () => {
      const fresh = await window.api.settings.get()
      const forecast = healForecastSettings(fresh.forecast)
      await window.api.settings.set({ forecast: { ...forecast, lab: { ...forecast.lab, strategies: { ...forecast.lab.strategies, [strategy]: on } } } })
      return window.api.settings.get()
    })
      .then(setSettings, (failure) => setProblem(describeError(failure)))
      .finally(() => setBusy(false))
  }

  const fundNow = (): void => {
    setBusy(true)
    setProblem(null)
    setNote(null)
    void fundLab(labTraderBrowserDeps)
      .then(async (made) => {
        setNote(made.added > 0 ? `Added ${made.added.toFixed(2)} USDT: the paper account holds ${made.balance.toFixed(2)} USDT.` : `The paper account already holds ${made.balance.toFixed(2)} USDT.`)
        setSettings(await window.api.settings.get())
      })
      .catch((failure: unknown) => setProblem(describeError(failure)))
      .finally(() => setBusy(false))
  }

  // The record as a file, through the save dialog every Lab table uses.
  const exportCsv = async (table: LabTableData): Promise<void> => {
    setNote(null)
    try {
      const outcome = await window.api.backtest.exportSave({ defaultFileName: `forecast-lab-laboratory-${new Date().toISOString().slice(0, 10)}.csv`, content: tableCsv(table), format: 'csv' })
      if (outcome.status === 'saved') setNote(`Saved to ${outcome.filePath}`)
      else if (outcome.status === 'error') setNote(`Could not save the file: ${outcome.message}`)
    } catch (failure) {
      setNote(describeError(failure))
    }
  }

  if (settings === null) {
    return (
      <Card title="Paper laboratory">
        <p style={noteStyle}>{problem ?? 'Loading…'}</p>
      </Card>
    )
  }
  const lab = healForecastSettings(settings.forecast).lab
  const equity = paperEquity(settings.paperAccount, settings.executors, 'USDT')
  const held = settings.paperAccount === null ? 0 : (settings.paperAccount.balances.USDT ?? 0)
  const nowSec = Math.floor(Date.now() / 1000)
  const today = labDailyNet(settings.executors, nowSec, 'USDT')
  const stoppedToday = lab.stopped !== null && lab.stopped.day === labDayOf(nowSec)
  const table = labStatsTable(LAB_STRATEGIES.map((strategy) => labStatsOf(settings.executors, strategy, equity)))
  return (
    <Card
      title="Paper laboratory"
      actions={
        <button type="button" style={buttonStyle('primary', busy)} disabled={busy} onClick={fundNow} title={`Fills the paper account to ${LAB_RISK.fundQuote.toLocaleString('en-US')} USDT; a click, never by itself.`}>
          {held >= LAB_RISK.fundQuote ? 'Funded' : `Fund to ${LAB_RISK.fundQuote.toLocaleString('en-US')} USDT`}
        </button>
      }
    >
      <p style={{ ...noteStyle, marginTop: 0 }}>
        A ${LAB_RISK.fundQuote.toLocaleString('en-US')} paper account on which four candidate strategies are measured, each a paper trader like the forecast trader and off until switched on. Every trade risks {LAB_RISK.riskPct}% of the account's equity at its stop, stakes a tenth of it at most, and the laboratory keeps {LAB_RISK.maxOpen} open at once; once the trades closed in a UTC day have lost {LAB_RISK.dailyStopPct}% of the equity together it opens none until the next day. A pair is opened once a pass, under the first strategy it qualifies for; the money-out and correlated-side caps of Risk & Safety apply. Paper only: no strategy here can reach a real order. If a strategy makes no trade, that is the result, and the sensitivity counts below say where the line binds.
      </p>
      <p style={noteStyle}>
        The paper account holds {held.toFixed(2)} USDT{equity === null ? '' : `; the laboratory's equity is ${equity.toFixed(2)} USDT`}. Today its closed trades made {today.netQuote.toFixed(2)} USDT over {today.closed}.{' '}
        {stoppedToday && lab.stopped !== null ? `STOPPED for the day at ${new Date(lab.stopped.at * 1000).toISOString().slice(11, 16)} UTC: ${lab.stopped.lossQuote.toFixed(2)} USDT lost of ${lab.stopped.equityQuote.toFixed(2)}.` : ''}
      </p>
      <div style={{ display: 'grid', gap: '0.3rem', margin: '0.5rem 0' }}>
        {LAB_STRATEGIES.map((strategy) => (
          <label key={strategy} style={{ display: 'flex', gap: '0.6rem', alignItems: 'baseline', fontSize: '0.84rem' }}>
            <input type="checkbox" checked={lab.strategies[strategy]} disabled={busy} onChange={(event) => setStrategy(strategy, event.target.checked)} />
            <strong>{STRATEGY_WORDS[strategy].name}</strong>
            <span style={noteStyle}>{STRATEGY_WORDS[strategy].what}</span>
          </label>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {table.headers.map((header) => (
                <th key={header} style={headCellStyle}>
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, index) => (
              <tr key={LAB_STRATEGIES[index]}>
                {row.map((cell, column) => (
                  <td key={column} style={cellStyle}>
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => void exportCsv(table)} style={{ ...buttonStyle('secondary'), marginTop: '0.5rem' }}>
        Export CSV
      </button>
      {pass !== null && (
        <p style={{ ...noteStyle, marginTop: '0.4rem' }}>
          At {new Date(pass.at * 1000).toISOString().slice(11, 16)} UTC: {pass.result.held !== null ? pass.result.held + ' ' : ''}
          {pass.result.opened.length > 0 ? `opened ${pass.result.opened.map((entry) => `${pairText(entry.pair)} (${STRATEGY_WORDS[entry.strategy].name})`).join(', ')}. ` : pass.result.held === null ? 'no forecast qualified. ' : ''}
          {pass.result.refused
            .slice(0, 3)
            .map((entry) => `${pairText(entry.pair)} not opened: ${entry.why}`)
            .join(' ')}
          {Object.keys(pass.result.sensitivity).length > 0
            ? ` Sensitivity (counted, never traded): forecasts a direction model would have called a way at ${Object.entries(pass.result.sensitivity)
                .map(([line, count]) => `P(up) ${Math.round(Number(line) * 100)}%: ${count}`)
                .join(', ')}.`
            : ''}
        </p>
      )}
      {note !== null && <p style={noteStyle}>{note}</p>}
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
    </Card>
  )
}
