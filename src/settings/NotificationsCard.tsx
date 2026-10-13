import { useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { ALERT_KINDS, healAlerts, type AlertKind } from '../../shared/alerts'
import type { AlertSettings } from '../../shared/ipc'
import { SIMULATED_EVENTS, SOUNDS, SOUND_COOLDOWNS, healSoundSettings, shouldPlay, soundFor, type SoundName, type SoundSettings } from '../../shared/sounds'
import { playSound, soundMs } from '../sound/player'
import { setSoundPrefs } from '../sound/hearing'
import { showToast } from '../sound/NoticeToasts'
import { describeError } from '../utils/ipcError'
import { settingsWrites } from '../utils/settingsWrites'
import { formButtonStyle, textInputStyle } from './formStyles'

const noteStyle: React.CSSProperties = { margin: '0.3rem 0 0', fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }
const SOUND_WORDS: Record<SoundName, { name: string; meaning: string }> = {
  information: { name: 'Information', meaning: 'a soft two-note chime: something to know' },
  opportunity: { name: 'Opportunity', meaning: 'three rising notes: something to act on' },
  warning: { name: 'Warning', meaning: 'two falling notes: something going against you' },
  critical: { name: 'Critical', meaning: 'a pulse of three, again each minute its banner is up: something to stop for' }
}
const HOURS = Array.from({ length: 24 }, (_, hour) => hour)

/** The notices' sounds (the V6 document, §72-80 and §109; V6 Stage 13): sound on or off, the volume, each
 * sound to hear, and -- under its advanced part -- a kind muted, the cooldown, quiet hours, the desktop's
 * own notices, and the simulator, which plays each event the document names as it would sound. CRITICAL
 * is heard whatever they say: only switching notices off on Essentials silences it. Every sound is shown
 * as well as heard. */
export function NotificationsCard(): React.JSX.Element {
  const [alerts, setAlerts] = useState<AlertSettings | null>(null)
  const [sounds, setSounds] = useState<SoundSettings | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [simulating, setSimulating] = useState(false)

  const read = (): void => {
    void window.api.settings.get().then(
      (settings) => {
        const nextAlerts = healAlerts(settings.alerts)
        const nextSounds = healSoundSettings(settings.sounds)
        setAlerts(nextAlerts)
        setSounds(nextSounds)
        setSoundPrefs({ alerts: nextAlerts, sounds: nextSounds })
      },
      (failure) => setProblem(describeError(failure))
    )
  }
  useEffect(read, [])

  const save = (patch: { alerts?: Partial<AlertSettings>; sounds?: Partial<SoundSettings> }): void => {
    setProblem(null)
    void settingsWrites(async () => {
      const fresh = await window.api.settings.get()
      await window.api.settings.set({
        ...(patch.alerts === undefined ? {} : { alerts: { ...healAlerts(fresh.alerts), ...patch.alerts } }),
        ...(patch.sounds === undefined ? {} : { sounds: { ...healSoundSettings(fresh.sounds), ...patch.sounds } })
      })
    }).then(read, (failure) => setProblem(describeError(failure)))
  }

  const simulate = async (): Promise<void> => {
    if (alerts === null || sounds === null) return
    setSimulating(true)
    try {
      const lastPlayedMs: Partial<Record<SoundName, number>> = {}
      for (const event of SIMULATED_EVENTS) {
        const sound = soundFor(event)
        const now = new Date()
        const decision = shouldPlay({ sound, kind: event.kind, alerts, settings: { ...sounds, cooldownSec: 0 }, hourOfDay: now.getHours(), nowMs: now.getTime(), lastPlayedMs })
        if (decision.play && sound !== null) playSound(sound, sounds.volume)
        showToast({ id: `simulated:${event.name}`, title: `${event.title} (simulated)`, body: sound === null ? 'Seen, not heard.' : decision.play ? `${SOUND_WORDS[sound].name}.` : `${SOUND_WORDS[sound].name}, not heard: ${decision.why}`, sound })
        await new Promise((resolve) => setTimeout(resolve, Math.max(900, sound === null ? 600 : soundMs(sound) + 400)))
      }
    } finally {
      setSimulating(false)
    }
  }

  if (alerts === null || sounds === null) {
    return (
      <Card title="Notifications">
        <p style={noteStyle}>{problem ?? 'Loading…'}</p>
      </Card>
    )
  }
  const muted = new Set(sounds.mutedKinds)
  return (
    <Card title="Notifications">
      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
          <input type="checkbox" aria-label="Sound on" checked={alerts.sound} onChange={(change) => save({ alerts: { sound: change.target.checked } })} />
          Sound
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
          Volume
          <input type="range" aria-label="Volume" min={0} max={100} step={5} value={Math.round(sounds.volume * 100)} onChange={(change) => save({ sounds: { volume: Number(change.target.value) / 100 } })} />
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>{Math.round(sounds.volume * 100)}%</span>
        </label>
      </div>
      <div style={{ display: 'grid', gap: '0.35rem', marginTop: '0.7rem' }}>
        {SOUNDS.map((sound) => (
          <div key={sound} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.8rem' }}>
            <button type="button" aria-label={`Test the ${SOUND_WORDS[sound].name} sound`} onClick={() => void playSound(sound, sounds.volume)} style={{ ...formButtonStyle('secondary'), padding: '0.25rem 0.6rem' }}>
              ▶ Test
            </button>
            <strong style={{ minWidth: '6.5rem', color: 'var(--text-primary)' }}>{SOUND_WORDS[sound].name}</strong>
            <span style={{ color: 'var(--text-secondary)' }}>{SOUND_WORDS[sound].meaning}</span>
          </div>
        ))}
      </div>
      <p style={noteStyle}>
        Critical is always heard: with sound off, in quiet hours and for a muted kind. Only switching notices off on Essentials silences it. Every sound is also shown -- a banner for critical, a note in the corner for the rest -- and a forecast made again, a trade refused or a model's disagreement are seen, not heard. The desktop's own notices are silent: the app's sound is the only one.
      </p>
      <button type="button" onClick={() => setAdvanced((open) => !open)} style={{ ...formButtonStyle('secondary'), marginTop: '0.6rem', padding: '0.3rem 0.7rem' }}>
        {advanced ? '▾ Advanced' : '▸ Advanced'}
      </button>
      {advanced && (
        <div style={{ marginTop: '0.6rem', display: 'grid', gap: '0.7rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
            <input type="checkbox" aria-label="The desktop's own notices" checked={alerts.desktop !== false} onChange={(change) => save({ alerts: { desktop: change.target.checked } })} />
            Show the desktop's notices too (off: notices are still shown in the window, heard and recorded)
          </label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
            Cooldown between two of one sound
            <select aria-label="Cooldown" value={sounds.cooldownSec} onChange={(change) => save({ sounds: { cooldownSec: Number(change.target.value) } })} style={{ ...textInputStyle(), width: 'auto', padding: '0.3rem 0.5rem' }}>
              {SOUND_COOLDOWNS.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {seconds === 0 ? 'none' : seconds < 60 ? `${seconds} seconds` : `${seconds / 60} minute${seconds === 60 ? '' : 's'}`}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', fontSize: '0.82rem', color: 'var(--text-primary)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <input type="checkbox" aria-label="Quiet hours" checked={sounds.quietHours !== null} onChange={(change) => save({ sounds: { quietHours: change.target.checked ? { from: 22, to: 7 } : null } })} />
              Quiet hours, on this computer's clock: only critical is heard
            </label>
            {sounds.quietHours !== null &&
              (['from', 'to'] as const).map((end) => (
                <select
                  key={end}
                  aria-label={`Quiet hours ${end}`}
                  value={sounds.quietHours?.[end]}
                  onChange={(change) => save({ sounds: { quietHours: { ...(sounds.quietHours as { from: number; to: number }), [end]: Number(change.target.value) } } })}
                  style={{ ...textInputStyle(), width: 'auto', padding: '0.3rem 0.5rem' }}
                >
                  {HOURS.map((hour) => (
                    <option key={hour} value={hour}>
                      {end} {String(hour).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              ))}
          </div>
          <div>
            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text-secondary)' }}>Kinds heard (unticked: seen only)</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(13rem, 1fr))', gap: '0.25rem 1rem', marginTop: '0.3rem' }}>
              {ALERT_KINDS.map((kind: AlertKind) => (
                <label key={kind} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.78rem', color: 'var(--text-primary)' }}>
                  <input
                    type="checkbox"
                    aria-label={`Hear ${kind}`}
                    checked={!muted.has(kind)}
                    onChange={(change) => save({ sounds: { mutedKinds: change.target.checked ? sounds.mutedKinds.filter((entry) => entry !== kind) : [...sounds.mutedKinds, kind] } })}
                  />
                  {kind.toLowerCase().replace(/_/g, ' ')}
                </label>
              ))}
            </div>
          </div>
          <div>
            <button type="button" disabled={simulating} onClick={() => void simulate()} style={{ ...formButtonStyle('secondary'), padding: '0.3rem 0.7rem', opacity: simulating ? 0.6 : 1 }}>
              {simulating ? 'Simulating…' : 'Simulate the events'}
            </button>
            <p style={noteStyle}>Plays each event the document names -- news, a pump and a dump, a strong bull and bear, a prediction changing, a trade ready and opened, a stop, a target, a circuit breaker, an exchange failing -- as it would sound under these controls, each with its note. Nothing is told, recorded or placed.</p>
          </div>
        </div>
      )}
      {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
    </Card>
  )
}
