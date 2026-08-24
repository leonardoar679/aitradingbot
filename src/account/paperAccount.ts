import type { AccountLedgerEntry, PaperAccount } from '../../shared/ipc'

// The simulated account behind paper trading. Every function here is pure: it takes an account
// and returns a new one, so the rules can be tested without a running app and a caller can never
// half-apply a movement.
//
// The model is deliberately the one a person already has in their head. `balances` holds FREE
// money. Funding an executor moves money out of it, the same way handing cash to a strategy
// leaves your wallet. Stopping that executor brings it back, plus or minus what it made. There is
// no separate "committed" column to drift out of sync with anything.

/** Ledger entries kept per account. The balances are authoritative, so trimming the oldest
 * entries loses explanation, never money -- but an unbounded array in settings.json would grow
 * forever on a machine that leaves executors cycling for months. */
export const MAX_LEDGER_ENTRIES = 500

export function emptyAccount(now: number): PaperAccount {
  return { balances: {}, initialBalances: {}, createdAt: now, ledger: [] }
}

/** Free balance of one asset. An asset that was never funded is 0, not undefined -- callers do
 * arithmetic on this and undefined would silently produce NaN. */
export function freeBalance(account: PaperAccount, asset: string): number {
  const value = account.balances[asset]
  return Number.isFinite(value) ? value : 0
}

/** Assets with a non-zero free balance, largest first. */
export function fundedAssets(account: PaperAccount): { asset: string; amount: number }[] {
  return Object.entries(account.balances)
    .filter(([, amount]) => Number.isFinite(amount) && amount !== 0)
    .map(([asset, amount]) => ({ asset, amount }))
    .sort((a, b) => b.amount - a.amount)
}

/** Why an amount cannot be taken out of the account right now, in words a first-time user can
 * act on -- or null when it can.
 *
 * Returning the reason rather than a boolean is the point: "Create" being greyed out with no
 * explanation is the failure mode this whole app keeps running into, and an account is the most
 * confusing place for it to happen. */
export function describeInsufficientFunds({
  account,
  asset,
  amount
}: {
  account: PaperAccount
  asset: string
  amount: number
}): string | null {
  // Not >= 0: a NaN amount passes no comparison at all, so testing the good case explicitly is
  // what keeps it out. JSON cannot store NaN either, so one that reached storage would come back
  // as null and read as zero.
  if (!Number.isFinite(amount)) return 'Enter a valid amount.'
  if (amount <= 0) return 'Amount must be greater than zero.'

  const free = freeBalance(account, asset)
  if (free <= 0) {
    return `This account holds no ${asset}. Add some on the Account page before starting a strategy that spends it.`
  }
  if (amount > free) {
    const short = amount - free
    return `Not enough ${asset}: this needs ${amount.toLocaleString()} but only ${free.toLocaleString()} is free — ${short.toLocaleString()} short. Stop another strategy to release funds, or lower the amount.`
  }
  return null
}

function withEntry(account: PaperAccount, entry: AccountLedgerEntry): PaperAccount {
  const current = freeBalance(account, entry.asset)
  const ledger = [...account.ledger, entry]
  return {
    ...account,
    balances: { ...account.balances, [entry.asset]: current + entry.delta },
    ledger: ledger.length > MAX_LEDGER_ENTRIES ? ledger.slice(ledger.length - MAX_LEDGER_ENTRIES) : ledger
  }
}

export interface MovementInput {
  asset: string
  amount: number
  executorId?: string | null
  note?: string
  now: number
  id: string
}

/** Adds money the user says they have. Also raises initialBalances, so funding more later does
 * not make the account look as though it had earned the difference. */
export function fund(account: PaperAccount, input: MovementInput): PaperAccount {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return account
  const next = withEntry(account, {
    id: input.id,
    at: input.now,
    asset: input.asset,
    delta: input.amount,
    reason: 'fund',
    executorId: null,
    note: input.note ?? 'Added funds'
  })
  const startedWith = Number.isFinite(next.initialBalances[input.asset]) ? next.initialBalances[input.asset] : 0
  return { ...next, initialBalances: { ...next.initialBalances, [input.asset]: startedWith + input.amount } }
}

export interface AllocationResult {
  account: PaperAccount
  /** Null when the money moved. Otherwise the account is returned untouched and this says why. */
  error: string | null
}

/** Takes money out of the free balance to fund a running strategy. Refuses rather than going
 * negative: an account that can be overdrawn is not an account. */
export function allocate(account: PaperAccount, input: MovementInput): AllocationResult {
  const error = describeInsufficientFunds({ account, asset: input.asset, amount: input.amount })
  if (error !== null) return { account, error }
  return {
    account: withEntry(account, {
      id: input.id,
      at: input.now,
      asset: input.asset,
      delta: -input.amount,
      reason: 'allocate',
      executorId: input.executorId ?? null,
      note: input.note ?? 'Funded a strategy'
    }),
    error: null
  }
}

/** Returns money from a strategy that has stopped. `amount` is what actually came back --
 * principal plus or minus the strategy's result -- so it can legitimately be more or less than
 * was allocated, and can even be zero. It is never negative: a paper strategy cannot lose more
 * than it was given here, and letting it would drain assets it never touched. */
export function release(account: PaperAccount, input: MovementInput): PaperAccount {
  if (!Number.isFinite(input.amount) || input.amount < 0) return account
  if (input.amount === 0) return account
  return withEntry(account, {
    id: input.id,
    at: input.now,
    asset: input.asset,
    delta: input.amount,
    reason: 'release',
    executorId: input.executorId ?? null,
    note: input.note ?? 'Returned from a strategy'
  })
}

/** Total profit or loss so far for one asset: what is free now, plus whatever is still committed
 * to running strategies, against what was funded. `committed` comes from the caller because only
 * it knows which executors are still running. */
export function accountPnl(account: PaperAccount, asset: string, committed: number): number {
  const started = Number.isFinite(account.initialBalances[asset]) ? account.initialBalances[asset] : 0
  const commitedSafe = Number.isFinite(committed) ? committed : 0
  return freeBalance(account, asset) + commitedSafe - started
}
