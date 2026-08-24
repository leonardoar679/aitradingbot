import { describe, it, expect } from 'vitest'
import { createSerialQueue } from '../src/utils/serialQueue'

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('createSerialQueue', () => {
  it('never runs two tasks at the same time', async () => {
    const queue = createSerialQueue()
    let active = 0
    let maxActive = 0
    const task = async (): Promise<void> => {
      active++
      maxActive = Math.max(maxActive, active)
      await tick()
      active--
    }

    await Promise.all([queue(task), queue(task), queue(task)])
    expect(maxActive).toBe(1)
  })

  it('runs tasks in the order they were queued', async () => {
    const queue = createSerialQueue()
    const order: string[] = []
    const task = (name: string, delay: number) => async (): Promise<void> => {
      await tick(delay)
      order.push(name)
    }

    // First task is the slowest, so ordering cannot come from the delays.
    await Promise.all([queue(task('a', 20)), queue(task('b', 1)), queue(task('c', 1))])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('preserves each task\'s return value', async () => {
    const queue = createSerialQueue()
    const results = await Promise.all([queue(async () => 1), queue(async () => 2)])
    expect(results).toEqual([1, 2])
  })

  it('delivers a failure to its own caller only', async () => {
    const queue = createSerialQueue()
    const failing = queue(async () => { throw new Error('write failed') })
    const following = queue(async () => 'still ran')

    await expect(failing).rejects.toThrow('write failed')
    expect(await following).toBe('still ran')
  })

  it('keeps working after a failure, for tasks queued later too', async () => {
    // Without swallowing the rejection in the chain, one failed settings write would silently
    // stop every future one.
    const queue = createSerialQueue()
    await expect(queue(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await queue(async () => 'ok')).toBe('ok')
  })

  it('serializes the exact read-modify-write that loses a routine run', async () => {
    let stored = { routines: [{ id: 'A', lastRunAt: null as number | null }, { id: 'B', lastRunAt: null as number | null }] }
    const get = async (): Promise<typeof stored> => { await tick(); return JSON.parse(JSON.stringify(stored)) }
    const set = async (patch: Partial<typeof stored>): Promise<void> => { await tick(); stored = { ...stored, ...patch } }

    const queue = createSerialQueue()
    const stamp = (id: string) =>
      queue(async () => {
        const s = await get()
        await set({ routines: s.routines.map((r) => (r.id === id ? { ...r, lastRunAt: 1000 } : r)) })
      })

    await Promise.all([stamp('A'), stamp('B')])
    expect(stored.routines.map((r) => r.lastRunAt)).toEqual([1000, 1000])
  })
})
