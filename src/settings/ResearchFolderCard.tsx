import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import type { ResearchStatus } from '../../shared/research'
import { buttonStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'

/** A size in words: `840 KB`, `12.4 MB`. */
function sizeOf(bytes: number): string {
  return bytes < 1_000_000 ? `${Math.max(1, Math.round(bytes / 1000))} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`
}

const when = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'

/** The research record (V7.2-R Stage 2; electron/services/researchFolderService.ts): where the app keeps what it
 * records for analysis elsewhere, the exports made of it, and two buttons: an export now, and the folder opened.
 * Reading it, exporting and opening ask no model and place nothing; an export holds no key. */
export function ResearchFolderCard(): React.JSX.Element {
  const [status, setStatus] = useState<ResearchStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.api.researchFolder.status())
    } catch (failure) {
      setError(describeError(failure))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function exportNow(): Promise<void> {
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const made = await window.api.researchFolder.exportNow()
      setMessage(`Exported ${made.files} files, ${sizeOf(made.bytes)}, to ${made.path}.${made.skipped.length > 0 ? ` ${made.skipped.length} could not be read and are listed in its manifest.` : ''}`)
      await load()
    } catch (failure) {
      setError(describeError(failure))
    } finally {
      setBusy(false)
    }
  }

  async function open(): Promise<void> {
    setError(null)
    try {
      const opened = await window.api.researchFolder.open()
      if (!opened.ok) setError(opened.problem ?? 'The folder could not be opened.')
    } catch (failure) {
      setError(describeError(failure))
    }
  }

  return (
    <Card
      title="Research record"
      actions={
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button onClick={() => void open()} disabled={status === null} style={buttonStyle('secondary', status === null)}>
            Open folder
          </button>
          <button onClick={() => void exportNow()} disabled={busy} style={buttonStyle('primary', busy)}>
            {busy ? 'Exporting…' : 'Export now'}
          </button>
        </div>
      }
    >
      <p style={{ ...noteStyle, marginBottom: '0.7rem' }}>
        What the app records for analysis on another machine, kept as it runs: the configuration it runs under, its errors and warnings, each paper
        trade&apos;s opening and end, and the hour&apos;s and the day&apos;s reports. Every day at 00:05 UTC, and on Export now, it is packed into one ZIP with
        the last fortnight&apos;s forecasts and their outcomes, the tape, the AI calls, the alerts, the events, the news and the bars, with a manifest of
        every file. No key, secret or password is ever in it: the key files are never read, and the settings go in with every secret field left out.
      </p>
      {error !== null && <p style={{ ...noteStyle, color: 'var(--down)', marginBottom: '0.5rem' }}>{error}</p>}
      {message !== null && <p style={{ ...noteStyle, color: 'var(--up)', marginBottom: '0.5rem' }}>{message}</p>}
      {status === null ? (
        <p style={noteStyle}>Loading…</p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 12rem) minmax(0, 1fr)', gap: '0.35rem 1rem', fontSize: '0.8rem' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Folder</span>
          <code style={{ overflowWrap: 'anywhere' }}>{status.dir}</code>
          <span style={{ color: 'var(--text-secondary)' }}>Last export</span>
          <span>{status.lastExport === null ? (status.exports[0] === undefined ? 'none yet' : `${status.exports[0].name}, ${sizeOf(status.exports[0].bytes)}`) : `${status.lastExport.name}, ${sizeOf(status.lastExport.bytes)}, ${status.lastExport.files} files`}</span>
          <span style={{ color: 'var(--text-secondary)' }}>Next daily export</span>
          <span>{when(status.nextExportAt)}</span>
          <span style={{ color: 'var(--text-secondary)' }}>Exports kept</span>
          <span>{status.exports.length}</span>
          <span style={{ color: 'var(--text-secondary)' }}>Newest reports</span>
          <span>
            hour {status.latestHour ?? 'none yet'}, day {status.latestDay ?? 'none yet'}
          </span>
        </div>
      )}
    </Card>
  )
}
