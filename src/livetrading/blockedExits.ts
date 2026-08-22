/** Whether the automatic exits on already-open live positions can currently fire, and what to say
 * when they cannot.
 *
 * This exists because the two gates in canCloseLivePosition are invisible from the outside while
 * they matter most. `sessionArmed` is module state that always starts false on launch and is never
 * persisted, but live position watchers ARE persisted and their loop restarts with the app -- so
 * after any restart or crash, every stored stop-loss, take-profit and trailing stop is inert until
 * someone arms live trading again. The watcher keeps ticking and keeps being refused, so the only
 * previous sign was a failure counter on a card the user had to be looking at.
 *
 * The kill switch blocks these same exits. That is a deliberate user action rather than a default,
 * but it is worth stating plainly: "kill switch" reads as protective, and a newbie can reasonably
 * assume it closes positions rather than freezing them open. */
export function describeBlockedExits(params: {
  watchedPositions: number
  symbols: string[]
  sessionArmed: boolean
  killSwitchEngaged: boolean
}): string | null {
  const { watchedPositions, symbols, sessionArmed, killSwitchEngaged } = params
  if (watchedPositions <= 0) return null
  if (!killSwitchEngaged && sessionArmed) return null

  const which = symbols.length > 0 ? ` (${symbols.join(', ')})` : ''
  const subject =
    watchedPositions === 1
      ? `1 live position${which} has an automatic exit`
      : `${watchedPositions} live positions${which} have automatic exits`

  return killSwitchEngaged
    ? `${subject} that CANNOT fire while the kill switch is engaged. The kill switch blocks closing orders too, so these positions are frozen open, not protected. Release it to let their stop-losses work again.`
    : `${subject} that CANNOT fire while live trading is off. Stop-losses and take-profits do not work until you arm live trading — arming always resets when the app restarts.`
}
