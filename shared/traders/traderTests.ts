import { delayOf, type DelayResult } from './delay'
import { skillOf, type SkillInput, type SkillResult } from './skill'

// A TRADER'S TWO TESTS IN ONE TASK (V8 Stage 6): V8-S6-SKILL and V8-S6-DELAY run on the main process's worker
// (shared/tasks.ts 'traderTests') -- ten thousand draws each under null A and null B are no work for the thread that
// fires a live exit. The input arrives copied through the worker's message, its maps and arrays whole; it is checked
// in its shape before either test reads it.

export interface TraderTestsInput {
  skill: SkillInput
  delay: Parameters<typeof delayOf>[0]
}

export interface TraderTestsResult {
  skill: SkillResult
  delay: DelayResult
}

const isMap = (value: unknown): value is Map<unknown, unknown> => value instanceof Map

/** Both tests on a payload in their shape; an error for anything else. */
export function traderTestsOf(payload: unknown): TraderTestsResult {
  const input = payload as Partial<TraderTestsInput> | null
  const skill = input?.skill
  const delay = input?.delay
  if (skill === undefined || !Array.isArray(skill.trips) || !isMap(skill.bars) || !isMap(skill.hourly) || typeof skill.key !== 'string') throw new Error("The skill test's input is not in its shape.")
  if (delay === undefined || !Array.isArray(delay.trips) || !isMap(delay.costs) || !isMap(delay.bars) || !isMap(delay.funding) || typeof delay.nowMs !== 'number') throw new Error("The delay test's input is not in its shape.")
  return { skill: skillOf(skill), delay: delayOf({ trips: delay.trips, costs: delay.costs, bars: delay.bars, funding: delay.funding, nowMs: delay.nowMs }) }
}
