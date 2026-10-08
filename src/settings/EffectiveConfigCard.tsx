import { useEffect, useState } from 'react'
import { describeHealed, flattenConfig, type EffectiveConfig } from '../../shared/appConfig'
import { describeConfigFiles } from '../../shared/configMigration'
import { Card } from '../components/Card'
import { noteStyle } from '../agents/agentStyles'

/** Where each store's values are kept, so a row says where to change it. */
const STORE_HOMES: Record<keyof EffectiveConfig['stores'], string> = {
  paperRisk: 'Risk & Safety',
  paperPause: 'Risk & Safety',
  paperDigest: 'Risk & Safety',
  alerts: 'Settings › Essentials',
  watch: 'Opportunities',
  watchPaper: 'Opportunities',
  additions: 'Settings › AI',
  ai: 'Settings › AI',
  scanner: 'Settings › Market',
  news: 'Settings › Market',
  live: 'Risk & Safety'
}

const cell: React.CSSProperties = { padding: '0.2rem 0.6rem 0.2rem 0', fontSize: '0.78rem', verticalAlign: 'top', borderBottom: '1px solid var(--border)' }

type Section = 'stores' | 'engine' | 'start'

const SECTION_LABELS: Record<Section, string> = { stores: 'The settings, as read', engine: 'The engine, as pinned', start: 'What the start read' }

/** The effective configuration, read-only (the V4 document, §4-5 and §61; the V5 document, §4-7
 * and §107): every store as the app reads it, with where to change it; every constant the engine
 * runs on, which nothing but the code changes, the hard limits above every setting among them; the
 * two versions a report and an experiment are stamped with; and what the start read -- each
 * settings file's version and what was migrated, and every value the heal changed. It reads once
 * when opened, and changes nothing. */
export function EffectiveConfigCard(): React.JSX.Element {
  const [config, setConfig] = useState<EffectiveConfig | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [open, setOpen] = useState<Section | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api
      .effectiveConfig()
      .then((next) => {
        if (!cancelled) setConfig(next)
      })
      .catch((error: unknown) => {
        if (!cancelled) setProblem(error instanceof Error ? error.message : String(error))
      })
    return (): void => {
      cancelled = true
    }
  }, [])

  const table = (rows: { path: string; value: string; home?: string }[]): React.JSX.Element => (
    <table style={{ borderCollapse: 'collapse', width: '100%', marginTop: '0.5rem' }}>
      <tbody>
        {rows.map((row) => (
          <tr key={row.path}>
            <td style={{ ...cell, fontFamily: 'var(--mono, monospace)', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{row.path}</td>
            <td style={{ ...cell, color: 'var(--text-primary)' }}>{row.value}</td>
            {row.home !== undefined && <td style={{ ...cell, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{row.home}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  )

  const start = (current: EffectiveConfig): React.JSX.Element => (
    <>
      <p style={{ ...noteStyle, marginBottom: 0 }} data-testid="config-start-note">
        {describeConfigFiles(current.files)} {describeHealed(current.healed)}
      </p>
      {table(
        current.files.map((file) => ({
          path: file.basename,
          value: !file.present
            ? 'not there: its defaults'
            : file.newer
              ? `version ${file.from}, newer than this app knows; left as written`
              : file.applied.length > 0
                ? `version ${file.from} → ${file.to}: ${file.applied.join(', ')}`
                : `version ${file.to}`
        }))
      )}
      {current.healed.length > 0 &&
        table(current.healed.map((entry) => ({ path: entry.path, value: `${entry.how}: ${entry.stored} → ${entry.effective}`, home: `${entry.file}.json` })))}
    </>
  )

  return (
    <Card title="Effective configuration">
      {problem !== null ? (
        <p style={noteStyle}>{problem}</p>
      ) : config === null ? (
        <p style={{ ...noteStyle, marginTop: 0 }}>Reading…</p>
      ) : (
        <>
          <p style={{ margin: 0, fontSize: '0.84rem', lineHeight: 1.6, color: 'var(--text-primary)' }}>
            Configuration version <strong>{config.configVersion}</strong>, engine version <strong>{config.engineVersion}</strong>. The configuration version is what
            this profile runs under now, every setting and every constant together; the session report and each experiment record it. The engine
            version is the constants alone, and changes only when the code does.
          </p>
          <p style={{ ...noteStyle, marginBottom: '0.4rem' }}>
            Nothing here is edited here: a setting is changed where the row says, and a constant is pinned by a test and changed only in the code, so that
            every record stays comparable with the ones before it. Above every setting stand the hard limits (under the engine, as `hardLimits`): a stored
            value over one is held to it, and the start says so.
          </p>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {(['stores', 'engine', 'start'] as const).map((section) => (
              <button
                key={section}
                onClick={() => setOpen(open === section ? null : section)}
                style={{
                  padding: '0.35rem 0.8rem',
                  border: `1px solid ${open === section ? 'var(--accent)' : 'var(--border)'}`,
                  borderRadius: 'var(--radius-sm)',
                  background: open === section ? 'var(--accent-soft)' : 'var(--bg-app)',
                  color: open === section ? 'var(--accent)' : 'var(--text-primary)',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                {SECTION_LABELS[section]}
              </button>
            ))}
          </div>
          {open === 'stores' &&
            table(
              (Object.keys(config.stores) as (keyof EffectiveConfig['stores'])[]).flatMap((store) =>
                flattenConfig(config.stores[store], store).map((row) => ({ ...row, home: STORE_HOMES[store] }))
              )
            )}
          {open === 'engine' && table(flattenConfig(config.engine))}
          {open === 'start' && start(config)}
        </>
      )}
    </Card>
  )
}
