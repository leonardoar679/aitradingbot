import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { noteStyle } from '../agents/agentStyles'
import { challengeSummary } from '../../shared/forecast/challenger'
import type { TrainingState } from '../../shared/forecast/status'

// CHAMPION AND CHALLENGER, ON PERFORMANCE (V8 Stage 10, 27 October 2026; English, with the page's other analysis). The
// price forecast's run in use, the last refit that challenged it and how that ended, and a challenger in its shadow
// week -- what the Forecast Lab's first card says at length (shared/forecast/challenger.ts, shadow.ts). It reads the
// forecast's state; it changes nothing.

const day = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')

export function ChampionView({ training }: { training: TrainingState | null }): React.JSX.Element {
  return (
    <Card title="Champion and challenger">
      {training === null ? (
        <p style={noteStyle}>Reading the forecast's state…</p>
      ) : (
        <>
          <p style={{ ...noteStyle, color: 'var(--text-primary)' }}>
            {training.current === null ? 'No run of the price forecast is in use yet.' : `In use: ${training.current.runId}, fitted ${day(training.current.fittedAt)} UTC.`}
          </p>
          <p style={noteStyle}>
            {training.challenge === null || training.challenge === undefined
              ? 'No refit has challenged it yet.'
              : `Last challenge: ${training.challenge.runId} against ${training.challenge.championRunId} at ${day(training.challenge.at)} UTC, ${challengeSummary(training.challenge.verdict)}.`}
          </p>
          {training.shadow !== null && training.shadow !== undefined && (
            <p style={noteStyle}>{`In its shadow week: ${training.shadow.runId}, beside ${training.shadow.championRunId} from ${day(training.shadow.since)} to ${day(training.shadow.until)} UTC, recorded and traded on by nothing (${training.shadow.summary}).`}</p>
          )}
          {training.shadowVerdict !== null && training.shadowVerdict !== undefined && (
            <p style={noteStyle}>{`Last shadow week: ${training.shadowVerdict.runId} ${training.shadowVerdict.adopted ? 'put in use' : 'dropped, the run in use kept'} at ${day(training.shadowVerdict.at)} UTC: ${training.shadowVerdict.summary}.`}</p>
          )}
          <p style={noteStyle}>A refit replaces the run in use only where it is better beyond noise at some horizon and worse at none, after a shadow week beside it. The Forecast Lab says how each is judged.</p>
        </>
      )}
    </Card>
  )
}

export function ChampionCard(): React.JSX.Element {
  const [training, setTraining] = useState<TrainingState | null>(null)
  useEffect(() => {
    let live = true
    void window.api.forecast
      .getState()
      .then((state) => {
        if (live) setTraining(state.training)
      })
      .catch(() => undefined)
    return (): void => {
      live = false
    }
  }, [])
  return <ChampionView training={training} />
}
