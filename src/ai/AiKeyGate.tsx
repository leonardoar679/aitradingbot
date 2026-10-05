import { useEffect, useState } from 'react'
import type { AiCredentialStatus } from '../../shared/aiSignal'
import { AiKeyCard } from './AiKeyCard'

/** The key card above an AI page, for as long as no key is stored.
 *
 * Opportunities, AI Decisions and AI Benchmark cannot do anything without an OpenRouter key, so
 * while none is stored the card that takes one sits above them, as it sat above the one page they
 * were split from. Once a key is stored it is managed on Connections, and the card stays only
 * until this page is left -- so the line saying the key was accepted does not vanish with the form.
 *
 * Saving or removing a key remounts the page's content: every view was priced, listed or refused by
 * the key it found when it mounted, and mounting it again is how it finds the new one. */
export function AiKeyGate({ children }: { children: (version: number) => React.ReactNode }): React.JSX.Element {
  const [status, setStatus] = useState<AiCredentialStatus | null>(null)
  const [changed, setChanged] = useState(false)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    void window.api.ai.credentialsStatus().then(
      (next) => {
        if (!cancelled) setStatus(next)
      },
      () => undefined
    )
    return (): void => {
      cancelled = true
    }
  }, [])

  const missing = status !== null && !status.configured

  return (
    <>
      {(missing || changed) && (
        <AiKeyCard
          where="ai-page"
          onChanged={(next) => {
            setStatus(next)
            setChanged(true)
            setVersion((current) => current + 1)
          }}
        />
      )}
      {children(version)}
    </>
  )
}
