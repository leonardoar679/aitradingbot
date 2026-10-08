import { OpportunityCard } from '../agents/OpportunityCard'
import { noteStyle } from '../agents/agentStyles'
import { useEventFeed } from '../agents/useEventFeed'
import { useNowSec } from '../utils/useNowSec'

const EVENTS_SHOWN = 20

/** The decisions the document asks for on this page (the V5 document, §54): each recent event the
 * scanner raised with what every model asked about it said -- its call, its confidence, its
 * reasons, the models' count and whether they took opposite sides -- as the cards on Opportunities
 * show them. READ-ONLY: nothing here asks a model, and nothing hands an order on; asking is done
 * on Opportunities, where the price of a call is stated first. */
export function EventDecisionsTab(): React.JSX.Element {
  const feed = useEventFeed(EVENTS_SHOWN)
  const nowSec = useNowSec(true, 1000)
  return (
    <>
      <p style={{ ...noteStyle, marginTop: 0 }}>
        The last {EVENTS_SHOWN} events the scanner raised, newest first, each with what the models asked about it said: the call, the confidence, the
        reasons, and when they took opposite sides. A paper trade of the watch&apos;s follows one model&apos;s call, or, with two or more models asked, their
        vote. Nothing here asks: Opportunities does, with the price stated first.
      </p>
      {feed.problem !== null && <p style={{ ...noteStyle, color: 'var(--down)' }}>{feed.problem}</p>}
      {feed.events === null ? (
        <p style={noteStyle}>Reading the scanner&apos;s events…</p>
      ) : feed.feed.length === 0 ? (
        <p style={noteStyle}>{feed.scannerOn === false ? 'The scanner is off (Settings › Market), so no event has been raised.' : 'No event has been raised yet.'}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {feed.feed.map((item) => (
            <OpportunityCard key={item.event.id} item={item} bars={feed.bars.get(item.event.id)} nowSec={nowSec} toAsk={[]} busy={false} problem={null} onAsk={() => undefined} />
          ))}
        </div>
      )}
    </>
  )
}
