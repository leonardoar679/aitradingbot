import type { AccountLedgerEntry, PaperAccount } from '../../shared/ipc'
import { ENGLISH, type I18n } from '../../shared/i18n/translate'

// The simulated account behind paper trading. Every function here is pure: it takes an account
// and returns a new one, so the rules can be tested without a running app and a caller can never
// half-apply a movement.
//
// `balances` is TOTAL holdings, not spending money. What a strategy has committed is DERIVED from
// the running executors themselves (see accountCommitments.ts), and available = total - committed.
//
// That choice is the important one here. The obvious design deducts from the balance when a
// strategy opens and adds back when it closes -- but then every path that creates or destroys an
// executor has to move money in step: the New Executor form, the starter presets (which write
// settings directly), a Controller stopping its group on a risk breach, and plain deletion. Miss
// any one and the account silently invents or destroys money, which is the worst failure this
// file could have. Deriving what is committed from the executors that actually exist cannot drift,
// and it works for executors that were created before the account was.
//
// So the balance only ever moves for two reasons: the user adds funds, or a strategy finishes and
// its realised result is settled.

/** Ledger entries kept per account. The balances are authoritative, so trimming the oldest
 * entries loses explanation, never money -- but an unbounded array in settings.json would grow
 * forever on a machine that leaves executors cycling for months. */
export const MAX_LEDGER_ENTRIES = 500

export function emptyAccount(now: number): PaperAccount {
  return { balances: {}, initialBalances: {}, createdAt: now, ledger: [] }
}

/** Total holding of one asset, committed money included. An asset that was never funded is 0,
 * not undefined -- callers do arithmetic on this and undefined would silently produce NaN. */
export function totalBalance(account: PaperAccount, asset: string): number {
  const value = account.balances[asset]
  return Number.isFinite(value) ? value : 0
}

/** What is left to start something new with.
 *
 * Can go negative, and is allowed to: it means strategies are committed to more than the account
 * holds, which is a true statement worth showing rather than a number to clamp away. It happens
 * honestly when someone funds an account after already running strategies. */
export function availableBalance(account: PaperAccount, asset: string, committed: number): number {
  const out = Number.isFinite(committed) ? committed : 0
  return totalBalance(account, asset) - out
}

/** Assets with a non-zero total, largest first. */
export function fundedAssets(account: PaperAccount): { asset: string; amount: number }[] {
  return Object.entries(account.balances)
    .filter(([, amount]) => Number.isFinite(amount) && amount !== 0)
    .map(([asset, amount]) => ({ asset, amount }))
    .sort((a, b) => b.amount - a.amount)
}

/** Why a new strategy of this size cannot be started right now, in words a first-time user can
 * act on -- or null when it can.
 *
 * Returning the reason rather than a boolean is the point: "Create" being greyed out with no
 * explanation is the failure mode this app keeps running into, and money is the most confusing
 * place for it to happen. */
export function describeInsufficientFunds(
  {
    account,
    asset,
    amount,
    committed
  }: {
    account: PaperAccount
    asset: string
    amount: number
    committed: number
  },
  i18n: I18n = ENGLISH
): string | null {
  // Not >= 0: a NaN amount passes no comparison at all, so testing the good case explicitly is
  // what keeps it out. JSON cannot store NaN either, so one that reached storage would come back
  // as null and read as zero.
  const { t, num } = i18n
  if (!Number.isFinite(amount)) return t('Enter a valid amount.')
  if (amount <= 0) return t('Amount must be greater than zero.')

  const total = totalBalance(account, asset)
  if (total <= 0) {
    return t('This account holds no {asset}. Add some under Paper Trading before starting a strategy that spends it.', { asset })
  }
  const available = availableBalance(account, asset, committed)
  if (amount > available) {
    const short = amount - available
    const spare = Math.max(0, available)
    const figure = (value: number): string => (i18n.language === 'en' ? value.toLocaleString() : num(value, 0, 3))
    return t('Not enough {asset}: this needs {needed} but only {free} is free — {short} short. Stop another strategy to release funds, or lower the amount.', {
      asset,
      needed: figure(amount),
      free: figure(spare),
      short: figure(short)
    })
  }
  return null
}

function withEntry(account: PaperAccount, entry: AccountLedgerEntry): PaperAccount {
  const current = totalBalance(account, entry.asset)
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

/** Books what a finished strategy actually made or lost. `amount` is the realised result, so it
 * is negative for a loss -- unlike funding, which only ever goes up.
 *
 * This is the only other thing that moves a balance. While a strategy is running its money is
 * merely committed, not spent, so nothing needs to happen until it finishes. */
export function settle(account: PaperAccount, input: MovementInput): PaperAccount {
  if (!Number.isFinite(input.amount)) return account
  if (input.amount === 0) return account
  return withEntry(account, {
    id: input.id,
    at: input.now,
    asset: input.asset,
    delta: input.amount,
    reason: input.amount >= 0 ? 'release' : 'adjust',
    executorId: input.executorId ?? null,
    note: input.note ?? (input.amount >= 0 ? 'Profit from a strategy' : 'Loss from a strategy')
  })
}

/** Profit or loss against what was funded.
 *
 * The balance already includes money committed to running strategies, so nothing needs adding
 * back for those -- a strategy merely holding money is not a gain, which is the mistake this
 * replaced. Money that became an Inventory position is the opposite case and has to be added
 * back: it genuinely left the balance when the position was handed over, so without it the
 * account reports a loss the size of the position the moment one is kept.
 *
 * `inventoryCost` is required rather than defaulting to zero. Every caller has to decide, because
 * forgetting it is not a rounding error -- it is a red number telling someone they lost money
 * they still have. */
export function accountPnl(account: PaperAccount, asset: string, inventoryCost: number): number {
  const started = Number.isFinite(account.initialBalances[asset]) ? account.initialBalances[asset] : 0
  const held = Number.isFinite(inventoryCost) ? inventoryCost : 0
  return totalBalance(account, asset) + held - started
}
