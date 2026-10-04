import { useCallback, useEffect, useState } from 'react'
import { Card } from '../components/Card'
import { AI_KEY_PREFIX, AI_PROVIDER_LABEL, describeUnusableAiKey, type AiCredentialStatus } from '../../shared/aiSignal'
import { formatUsd, type AiConfig } from '../../shared/aiCost'
import { buttonStyle, inputStyle, noteStyle } from '../agents/agentStyles'
import { describeError } from '../utils/ipcError'

/** Where the OpenRouter key is added, replaced, tested and removed.
 *
 * ONE CARD, SHOWN IN TWO PLACES: on the Agents page and in Settings. It used to be in Settings
 * alone, between the theme and the exchange keys, while everything that needs the key -- and every
 * message saying it is missing -- is on the Agents page. A key asked for on a page that does not
 * use it is a key the user is sent to look for.
 *
 * With no key stored the field is simply there. There is nothing else the card could be for, so
 * it does not make anyone press "Add key" to be shown it.
 *
 * The key travels from this field to the main process and is never read back. Everything shown
 * afterwards -- that one is stored, whether its last test passed -- is status, not the key. */
export function AiKeyCard({
  where,
  onChanged
}: {
  /** Settings names the section it sits in; the Agents page names the thing itself. */
  where: 'agents' | 'settings'
  /** Told what is stored now, after a key is saved, replaced or removed. */
  onChanged?: (status: AiCredentialStatus) => void
}): React.JSX.Element {
  const [status, setStatus] = useState<AiCredentialStatus | null>(null)
  const [config, setConfig] = useState<AiConfig | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  const refresh = useCallback(async (): Promise<AiCredentialStatus> => {
    const [nextStatus, nextConfig] = await Promise.all([window.api.ai.credentialsStatus(), window.api.ai.getConfig()])
    setStatus(nextStatus)
    setConfig(nextConfig)
    return nextStatus
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function run(action: () => Promise<{ ok: boolean; text: string }>, changesKey: boolean): Promise<void> {
    setBusy(true)
    setMessage(null)
    try {
      const result = await action()
      const next = await refresh()
      setMessage(result)
      if (changesKey) onChanged?.(next)
    } catch (failure) {
      setMessage({ ok: false, text: describeError(failure) })
    } finally {
      setBusy(false)
    }
  }

  const save = (): Promise<void> =>
    run(async () => {
      await window.api.ai.setCredentials(apiKey.trim())
      // The price list is what a call is priced from before any has been made, and it is free to
      // fetch -- but until now it was fetched only by opening the Models tab, so the first button
      // a new key was used on read "cost unknown". A failure here is not a failure to save the
      // key: the Models tab asks again.
      await window.api.ai.listModels(false).catch(() => undefined)
      setApiKey('')
      setReplacing(false)
      return { ok: true, text: `${AI_PROVIDER_LABEL} key verified and saved.` }
    }, true)

  const test = (): Promise<void> =>
    run(async () => {
      const result = await window.api.ai.testCredentials()
      return { ok: result.ok, text: result.message }
    }, false)

  const remove = (): Promise<void> =>
    run(async () => {
      await window.api.ai.removeCredentials()
      return { ok: true, text: 'Key removed.' }
    }, true)

  const configured = status?.configured === true
  const showForm = status !== null && (!configured || replacing)
  // Said while it is being typed, not after the click: the main process refuses the same values,
  // but by then the user has been made to wait for a refusal the field could have given.
  const typed = apiKey.trim()
  const problem = typed === '' ? null : describeUnusableAiKey(typed)
  const cannotSave = busy || typed === '' || problem !== null

  const title =
    where === 'settings'
      ? `AI — ${AI_PROVIDER_LABEL}`
      : configured
        ? `${AI_PROVIDER_LABEL} API key`
        : `Add your ${AI_PROVIDER_LABEL} API key`

  return (
    <Card title={title}>
      <p style={{ ...noteStyle, marginBottom: '0.9rem' }}>
        One {AI_PROVIDER_LABEL} key reaches every model on the Agents page. It is used only for chart signals,
        backtests, paper bots and the Agents page: AI signals have no live-order route. The key is stored encrypted by
        the operating system and is never read back into this window. Saving one asks {AI_PROVIDER_LABEL} a free
        question about the key itself and spends nothing.
      </p>
      {status?.legacyOpenAiKey && (
        <p
          style={{
            ...noteStyle,
            color: 'var(--text-secondary)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
            padding: '0.55rem 0.7rem',
            marginBottom: '0.9rem'
          }}
        >
          An OpenAI key from before this app used {AI_PROVIDER_LABEL} is still stored here. It is no longer used or
          sent anywhere. Adding an {AI_PROVIDER_LABEL} key replaces it, or{' '}
          <button
            onClick={() => void remove()}
            disabled={busy}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--down)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}
          >
            remove it now
          </button>
          .
        </p>
      )}
      {status === null ? (
        <p style={noteStyle}>Checking for a stored key…</p>
      ) : showForm ? (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!cannotSave) void save()
          }}
          style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}
        >
          <label
            style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)' }}
          >
            {AI_PROVIDER_LABEL} API key
            <input
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={`${AI_KEY_PREFIX}v1-…`}
              autoComplete="off"
              spellCheck={false}
              style={{ ...inputStyle(), width: '100%', maxWidth: 560, boxSizing: 'border-box' }}
            />
          </label>
          <p style={noteStyle}>
            Keys are made at openrouter.ai/keys and start with &quot;{AI_KEY_PREFIX}&quot;. Paste yours here and press
            Test &amp; Save.
          </p>
          {problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{problem}</p>}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="submit" disabled={cannotSave} style={buttonStyle('primary', cannotSave)}>
              {busy ? 'Testing…' : 'Test & Save'}
            </button>
            {replacing && (
              <button
                type="button"
                onClick={() => {
                  setReplacing(false)
                  setApiKey('')
                }}
                disabled={busy}
                style={buttonStyle('secondary', busy)}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.7rem' }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.6 }}>
            Key configured.
            {config && (
              <>
                {' '}Default model {config.defaultModel}. {formatUsd(config.spentTodayUsd)} of today&apos;s{' '}
                {formatUsd(config.dailyCapUsd)} AI budget spent.
                {where === 'settings' && ' Models, the budget and the call history are on the Agents page.'}
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={() => setReplacing(true)} disabled={busy} style={buttonStyle('secondary', busy)}>
              Replace key
            </button>
            <button onClick={() => void test()} disabled={busy} style={buttonStyle('secondary', busy)}>
              Test
            </button>
            <button
              onClick={() => void remove()}
              disabled={busy}
              style={{ ...buttonStyle('secondary', busy), background: 'transparent', border: '1px solid var(--down)', color: 'var(--down)' }}
            >
              Remove
            </button>
          </div>
        </div>
      )}
      {message && <p style={{ ...noteStyle, color: message.ok ? 'var(--up)' : 'var(--down)', marginTop: '0.7rem' }}>{message.text}</p>}
    </Card>
  )
}
