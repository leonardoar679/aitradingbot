import { useEffect, useState } from 'react'
import type { AiConfig } from '../../shared/aiCost'
import { StatusChip } from '../status/StatusChip'
import { describeAiSpend, describeWatchMode, watchModeOf } from '../status/statusModes'

const POLL_MS = 15_000

/** What the AI does by itself, on the bar at the top of every page: nothing (the watch is off),
 * asks and scores (shadow), or opens paper positions -- and what asking has cost today.
 *
 * It reads whether a key is stored and the AI setting, and nothing else. It asks no model and
 * offers nothing to act on: what a model said is on Opportunities. */
export function AiStatusChip(): React.JSX.Element | null {
  const [keyConfigured, setKeyConfigured] = useState<boolean | null>(null)
  const [config, setConfig] = useState<AiConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      window.api.ai.credentialsStatus().then(
        (status) => {
          if (!cancelled) setKeyConfigured(status.configured)
        },
        () => undefined
      )
      window.api.ai.getConfig().then(
        (next) => {
          if (!cancelled) setConfig(next)
        },
        () => undefined
      )
    }
    read()
    const timer = setInterval(read, POLL_MS)
    return (): void => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  if (keyConfigured === null) return null
  const mode = describeWatchMode(watchModeOf({ keyConfigured, config }))
  return <StatusChip mode={mode} extra={keyConfigured && config !== null ? describeAiSpend(config) : undefined} />
}
