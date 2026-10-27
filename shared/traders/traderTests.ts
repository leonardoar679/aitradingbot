import { cloneOf, type CloneInput, type CloneResult } from './clone'
import { delayOf, type DelayResult } from './delay'
import { skillOf, type SkillInput, type SkillResult } from './skill'

// A TRADER'S TESTS IN ONE TASK (V8 Stages 6-7): V8-S6-SKILL, V8-S6-DELAY and V8-S7-CLONE run on the main process's
// worker (shared/tasks.ts 'traderTests') -- ten thousand draws each under null A and null B, and some forty thousand
// rules searched, are no work for the thread that fires a live exit. The input arrives copied through the worker's
// message, its maps and arrays whole; it is checked in its shape before any test reads it.

export interface TraderTestsInput {
  skill: SkillInput
  delay: Parameters<typeof delayOf>[0]
  clone: CloneInput
}

export interface TraderTestsResult {
  skill: SkillResult
  delay: DelayResult
  clone: CloneResult
}

const isMap = (value: unknown): value is Map<unknown, unknown> => value instanceof Map

/** The tests on a payload in their shape; an error for anything else. */
export function traderTestsOf(payload: unknown): TraderTestsResult {
  const input = payload as Partial<TraderTestsInput> | null
  const skill = input?.skill
  const delay = input?.delay
  const clone = input?.clone
  if (skill === undefined || !Array.isArray(skill.trips) || !isMap(skill.bars) || !isMap(skill.hourly) || typeof skill.key !== 'string') throw new Error("The skill test's input is not in its shape.")
  if (delay === undefined || !Array.isArray(delay.trips) || !isMap(delay.costs) || !isMap(delay.bars) || !isMap(delay.funding) || typeof delay.nowMs !== 'number') throw new Error("The delay test's input is not in its shape.")
  if (clone === undefined || !Array.isArray(clone.trips) || !isMap(clone.bars) || !isMap(clone.hourly) || !isMap(clone.costs) || typeof clone.key !== 'string') throw new Error("The clone's input is not in its shape.")
  return {
    skill: skillOf(skill),
    delay: delayOf({ trips: delay.trips, costs: delay.costs, bars: delay.bars, funding: delay.funding, nowMs: delay.nowMs }),
    clone: cloneOf({ trips: clone.trips, bars: clone.bars, hourly: clone.hourly, costs: clone.costs, key: clone.key })
  }
}
