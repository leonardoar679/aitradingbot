import { useState } from 'react'
import { Card } from '../components/Card'
import { buttonStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'
import { RESEARCH_LINES, type ResearchExport } from '../../shared/research'
import { useI18n } from '../i18n'

// THE RECORDS IN ONE FILE, ON PERFORMANCE (V8 Stage 10, 27 October 2026). One click makes the research folder's export
// (electron/services/researchFolderService.ts): the window's records kept whole -- the forecast's and every other
// source's predictions with their outcomes, the news links, the announcements, the traders under hashed ids, the paper
// books, the AI calls -- with Bitget's one-minute bars of each pair traded, every value shaped like a key removed. It
// stays on this computer; nothing is sent.

export function ExportCard(): React.JSX.Element {
  const { t, num } = useI18n()
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<ResearchExport | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const exportNow = async (): Promise<void> => {
    setBusy(true)
    setProblem(null)
    try {
      setMade(await window.api.researchFolder.exportNow())
    } catch (error) {
      setProblem(describeError(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card title={t('Export the records')}>
      <p style={noteStyle}>
        {t("One file of what was recorded over the last {days} days: the predictions of every source and their outcomes, the news links, Binance's announcements, the traders read (their ids hashed), the paper books, the AI calls, and Bitget's one-minute bars of each pair traded. Every value shaped like a key is removed. The file stays on this computer: nothing is sent.", { days: RESEARCH_LINES.exportWindowDays })}
      </p>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
        <button type="button" style={buttonStyle('primary', busy)} disabled={busy} onClick={() => void exportNow()}>
          {busy ? t('Exporting…') : t('Export')}
        </button>
        {made !== null && (
          <button type="button" style={buttonStyle('secondary')} onClick={() => void window.api.researchFolder.open()}>
            {t('Open the folder')}
          </button>
        )}
      </div>
      {made !== null && (
        <p style={{ ...noteStyle, marginTop: '0.5rem' }}>
          {t('Saved {name}: {files} files, {size} MB.', { name: made.name, files: num(made.files), size: num(made.bytes / 1_048_576, 1, 1) })}
          {made.skipped.length > 0 ? ` ${t('{count} could not be read and are listed in its manifest.', { count: made.skipped.length })}` : ''}
        </p>
      )}
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
    </Card>
  )
}
