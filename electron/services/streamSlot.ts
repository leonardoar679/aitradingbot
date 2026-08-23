/** Holds at most one live websocket, and survives calls that overlap in time.
 *
 * The naive version of this -- `stop?.(); stop = await connect()` -- is correct only while no two
 * calls are ever in flight together. They routinely are: opening a stream means connecting a
 * websocket, which takes anywhere from milliseconds to a full connect timeout, and the renderer
 * re-subscribes on every interval change, symbol change and page mount. Two things went wrong
 * when calls overlapped:
 *
 *   - Two opens: the first `stop?.()` ran while the previous stop function was still null, then
 *     both connects resolved and the second assignment overwrote the first's stop function. The
 *     first socket was then unreachable and streamed forever -- and because these sockets
 *     reconnect on their own, it never even went quiet. Its data kept reaching every listener,
 *     so a chart that had been switched from 1m to 15m received both, mixed into one series with
 *     nothing distinguishing them.
 *   - An open then a close: `close()` found a null stop function, did nothing, and the connect
 *     that landed afterwards installed a socket nobody was listening for and nobody could stop.
 *
 * A generation counter fixes both: whoever finishes connecting checks whether it is still the
 * one that was asked for, and closes its own socket if it is not. */
export interface StreamSlot {
  /** Connects and takes ownership. If a later open() or close() happens while this is still
   * connecting, the socket it produces is closed immediately instead of being installed. */
  open(connect: () => Promise<() => void>): Promise<void>
  /** Closes the current socket, and disowns any connect that is still in flight. */
  close(): void
}

export function createStreamSlot(): StreamSlot {
  let generation = 0
  let stop: (() => void) | null = null

  return {
    async open(connect: () => Promise<() => void>): Promise<void> {
      const mine = ++generation
      stop?.()
      stop = null
      const newStop = await connect()
      if (mine !== generation) {
        // Superseded while connecting -- by another open, or by a close. Either way this socket
        // was never wanted, and this is the only reference to it that will ever exist.
        newStop()
        return
      }
      stop = newStop
    },

    close(): void {
      generation += 1
      stop?.()
      stop = null
    }
  }
}
