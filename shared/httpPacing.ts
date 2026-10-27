// ONE BUDGET PER HOST (V8 Stage 1, 26 October 2026).
//
// The limits a public API holds a reader to are per IP address, and shared: the scanner, the forecast's data,
// the live market's books, a backtest's range read and, from V8, a trader's history and a pasted link's price
// path all spend Binance's one budget from this machine, and so does any other copy of the app running beside
// it. Until V8 the only pacing was private to the forecast's data reader, and nothing read what Binance says it
// has counted. Here each host has one budget, kept in the main process:
// - BINANCE reports the weight this IP has used in the minute on every answer (X-MBX-USED-WEIGHT-1M). A reader
//   that can wait -- a range read, an import -- waits while it is above the line, so the readers that cannot wait
//   (the live books, the forecast's closes) keep their room. A 429 holds every read until its Retry-After; a 418
//   (the ban Binance gives an IP that went on after a 429) holds every read until its Retry-After, half an hour
//   when it names none. A held read fails at once rather than waiting the hold out.
// - HYPERLIQUID weighs each request (2 for an account's state, 20 and more for fills): a request is costed
//   before it is sent, against a share of its 1,200 a minute, so that two imports cannot use it up.
// - OKX allows each public copy-trading endpoint 5 requests in 2 seconds: one request a half second per
//   endpoint keeps under it.
// - BINANCE'S FUTURES and BITGET'S PERPETUALS (V8 Stage 6), read for a trader's coins: Binance futures weighs each
//   request against 2,400 a minute an IP, of which this app spends half, and its funding history shares 500 requests
//   in five minutes, one a second keeping under; Bitget's public market data allows 20 requests a second, one a tenth
//   of a second keeping under.
// Signed requests -- an order, a cancel, a close -- never pass through here: a budget must not delay an exit.

/** The lines, pinned (ENGINE_CONSTANTS.httpPacing). */
export const HTTP_PACING_LINES = {
  version: 'http-pacing-v1',
  binance: {
    /** Binance's weight a minute for one IP. */
    weightPerMinute: 6000,
    /** Above this weight used in the minute, a reader that can wait waits for the next minute. */
    backgroundLine: 2400,
    /** A 429 with no Retry-After holds reads this long. */
    holdOn429Ms: 60_000,
    /** A 418 with no Retry-After holds reads this long. */
    holdOn418Ms: 30 * 60_000
  },
  hyperliquid: {
    /** The share of Hyperliquid's 1,200 a minute for one IP this app spends. */
    weightPerMinute: 600
  },
  okx: {
    /** One request a half second per public endpoint (OKX allows 5 in 2 seconds). */
    minGapMs: 500
  },
  binanceFutures: {
    /** The share of Binance futures' 2,400 a minute for one IP this app spends. */
    weightPerMinute: 1200,
    /** Its funding history: one request a second (500 in five minutes, shared with another endpoint). */
    fundingGapMs: 1000
  },
  bitget: {
    /** Bitget's public market data: one request a tenth of a second (20 a second for one IP). */
    minGapMs: 100
  }
} as const

export type Priority = 'normal' | 'background'

/** The clock the budgets read and wait on: a test moves it. */
export interface PacingClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const realClock: PacingClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/** A request not sent because its host has told this app to stop until `untilMs`. */
export class RateLimitedError extends Error {
  constructor(
    readonly host: string,
    readonly untilMs: number,
    readonly why: string
  ) {
    super(`${host} is not asked until ${new Date(untilMs).toISOString()}: ${why}.`)
    this.name = 'RateLimitedError'
  }
}

/** A Retry-After header in milliseconds: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(value: string | null | undefined, nowMs: number): number | null {
  if (value === null || value === undefined) return null
  const text = value.trim()
  if (text === '') return null
  if (/^\d+$/.test(text)) return Number(text) * 1000
  // An HTTP date names its day and month in words ("Mon, 26 Oct 2026 12:01:00 GMT"); a bare number or sign is not one.
  if (!/[A-Za-z]/.test(text)) return null
  const at = Date.parse(text)
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null
}

/** The start of the minute `ms` falls in. */
const minuteOf = (ms: number): number => Math.floor(ms / 60_000) * 60_000

/** Binance's budget: the weight it says this IP used, and a hold after a 429 or a 418. */
export class BinanceBudget {
  private heldUntil = -Infinity
  private heldWhy = ''
  private usedWeight = 0
  private usedMinute = -Infinity

  constructor(private readonly clock: PacingClock = realClock) {}

  /** Before a request: fails while a hold stands; a background request waits for the next minute while the
   * minute's weight is above the line. */
  async before(priority: Priority = 'normal'): Promise<void> {
    const now = this.clock.now()
    if (now < this.heldUntil) throw new RateLimitedError('Binance', this.heldUntil, this.heldWhy)
    if (priority === 'background' && minuteOf(now) === this.usedMinute && this.usedWeight > HTTP_PACING_LINES.binance.backgroundLine) {
      await this.clock.sleep(this.usedMinute + 60_000 - now)
      const after = this.clock.now()
      if (after < this.heldUntil) throw new RateLimitedError('Binance', this.heldUntil, this.heldWhy)
    }
  }

  /** After an answer: the weight Binance counted, and a hold where it said stop. */
  after(response: { status: number; headers?: Pick<Headers, 'get'> | null }): void {
    const now = this.clock.now()
    // An answer without headers (a test's, or a proxy's) says nothing of the weight.
    const read = (name: string): string | null => (typeof response.headers?.get === 'function' ? response.headers.get(name) : null)
    const header = read('x-mbx-used-weight-1m')
    const used = header === null ? Number.NaN : Number(header)
    if (Number.isFinite(used) && used >= 0) {
      const minute = minuteOf(now)
      this.usedWeight = minute === this.usedMinute ? Math.max(this.usedWeight, used) : used
      this.usedMinute = minute
    }
    if (response.status === 429 || response.status === 418) {
      const wait = retryAfterMs(read('retry-after'), now) ?? (response.status === 418 ? HTTP_PACING_LINES.binance.holdOn418Ms : HTTP_PACING_LINES.binance.holdOn429Ms)
      const until = now + wait
      if (until > this.heldUntil) {
        this.heldUntil = until
        this.heldWhy = response.status === 418 ? 'it banned this address for asking on after a rate limit (418)' : 'it rate-limited this address (429)'
      }
    }
  }

  /** Test seam: as a new session finds it. */
  reset(): void {
    this.heldUntil = -Infinity
    this.heldWhy = ''
    this.usedWeight = 0
    this.usedMinute = -Infinity
  }

  /** What the budget stands at, for the status a page shows. */
  state(): { heldUntilMs: number | null; usedWeight: number; minuteStartMs: number | null } {
    const now = this.clock.now()
    return {
      heldUntilMs: now < this.heldUntil ? this.heldUntil : null,
      usedWeight: minuteOf(now) === this.usedMinute ? this.usedWeight : 0,
      minuteStartMs: Number.isFinite(this.usedMinute) ? this.usedMinute : null
    }
  }
}

/** A budget of weight a minute, spent before each request: Hyperliquid's. A request that would go over the
 * minute's share waits for the next minute; one that alone weighs more than the share is refused. */
export class WeightBudget {
  private spent = 0
  private minute = -Infinity
  private chain: Promise<void> = Promise.resolve()

  constructor(
    readonly host: string,
    private readonly perMinute: number,
    private readonly clock: PacingClock = realClock
  ) {}

  /** Waits until `weight` fits in the minute, then counts it. One at a time, in the order asked. */
  spend(weight: number): Promise<void> {
    if (!(weight > 0) || weight > this.perMinute) return Promise.reject(new Error(`A request of weight ${weight} cannot be sent to ${this.host} within ${this.perMinute} a minute`))
    const turn = this.chain.then(async () => {
      for (;;) {
        const now = this.clock.now()
        const minute = minuteOf(now)
        if (minute !== this.minute) {
          this.minute = minute
          this.spent = 0
        }
        if (this.spent + weight <= this.perMinute) {
          this.spent += weight
          return
        }
        await this.clock.sleep(minute + 60_000 - now)
      }
    })
    this.chain = turn.catch(() => undefined)
    return turn
  }
}

/** One request at a time per key, at least `gapMs` apart: OKX's public endpoints, one key each. */
export class GapBudget {
  private last = new Map<string, number>()
  private chains = new Map<string, Promise<void>>()

  constructor(
    readonly host: string,
    private readonly gapMs: number,
    private readonly clock: PacingClock = realClock
  ) {}

  /** Waits until `key` was last asked at least the gap ago, then marks it asked. */
  take(key: string): Promise<void> {
    const before = this.chains.get(key) ?? Promise.resolve()
    const turn = before.then(async () => {
      const last = this.last.get(key)
      if (last !== undefined) {
        const wait = last + this.gapMs - this.clock.now()
        if (wait > 0) await this.clock.sleep(wait)
      }
      this.last.set(key, this.clock.now())
    })
    this.chains.set(key, turn.catch(() => undefined))
    return turn
  }
}
