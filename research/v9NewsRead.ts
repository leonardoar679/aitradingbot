// V9-NEWS-CLASS's and V9-SHOCK's reading by hand (V9 Stage 9): what the run's records hold for a person to judge, put
// out claim by claim. Reads files only and judges nothing: the person reads each line against its story.
//
// - LOUD: every HIGH or CRITICAL hack or exploit notice of the run, its story (source, publication, title), and the
//   app's reading of it (shared/incidents.ts, as of this build): first report or follow-up and why, the victim, its
//   token, the sum. For precision: right where it is the first report of a new incident and names the victim.
// - NET: every story of the run's feed whose title or summary speaks of a theft in any words -- a net wider than the
//   app's own rules -- with the notice it raised, if any. The person picks the first reports among them; those that
//   raised a WATCH notice or louder are caught. For recall.
// - SHOCKS: every market shock notice, Bitcoin's move it names, and the loud news notices of stories published in the
//   two hours after it, with the minutes between. For V9-SHOCK, exploratory.
//
//   npx esbuild research/v9NewsRead.ts --bundle --platform=node --format=esm --outfile=research/.v9NewsRead.mjs
//   PROFILE=<profile> FROM_SEC=<run start> [TO_SEC=<run end>] node research/.v9NewsRead.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SHOCK_ATTACH_SECONDS } from '../shared/alerts'
import { incidentsOf } from '../shared/incidents'
import { assetDictionary, readStory, FEED_SOURCES, type FeedStory, type ReadStory } from '../shared/newsFeed'

const PROFILE = process.env.PROFILE ?? ''
const FROM_SEC = Number(process.env.FROM_SEC ?? 0)
const TO_SEC = Number(process.env.TO_SEC ?? Infinity)
if (PROFILE === '' || !existsSync(PROFILE)) throw new Error("PROFILE is the run's profile folder")

const rows = (dir: string, pattern: RegExp): unknown[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => pattern.test(name))
        .sort()
        .flatMap((name) => readFileSync(join(dir, name), 'utf-8').split('\n').filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line) as unknown))
    : []
const clock = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ')
const inRun = (sec: number): boolean => sec >= FROM_SEC && sec < TO_SEC

// The stories, each as first seen, read again by the app's rules as research/v9FeedCheck.ts reads them.
const stories = new Map<string, FeedStory>()
for (const row of rows(join(PROFILE, 'news'), /^feed-\d{4}-\d{2}\.jsonl$/) as (FeedStory & { kind?: string })[]) if (row.kind !== 'source' && typeof row.title === 'string' && !stories.has(row.id)) stories.set(row.id, row)
const bases = new Set<string>(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX'])
const dictionary = assetDictionary([...bases, ...JSON.parse(readFileSync('shared/incidentVictims.json', 'utf-8')).victims.map((row: [string, string]) => row[1])])
const credibility = new Map<string, number>(FEED_SOURCES.map((source) => [source.id, source.credibility]))
type Read = Omit<ReadStory, 'alsoIn' | 'sources'>
const read = [...stories.values()].map((story) => readStory(story, dictionary, credibility.get(story.source) ?? 0.5, story.seenAt))
const byId = new Map<string, Read>(incidentsOf(read, dictionary, 0).map((story) => [story.id, story]))

type Alert = { id: string; at: number; kind?: string; severity: string; title: string; body: string }
const alerts = (rows(join(PROFILE, 'alerts'), /^alerts-\d{4}-\d{2}\.jsonl$/) as Alert[]).filter((alert) => inRun(alert.at))
const newsAlert = new Map<string, Alert>(alerts.filter((alert) => alert.kind === 'NEWS_EVENT').map((alert) => [alert.id, alert]))
const loud = (alert: Alert): boolean => alert.severity === 'high' || alert.severity === 'critical'
const isHack = (story: Read | undefined, alert: Alert): boolean => (story !== undefined ? story.eventType === 'HACK' || story.eventType === 'EXPLOIT' : /· (Hack|Exploit)$/.test(alert.title))
const reading = (story: Read | undefined): string => {
  const incident = story?.incident
  if (story === undefined) return 'its story is not on file'
  if (incident === undefined) return `${story.eventType}; not read for an incident`
  if (incident === null) return `${story.eventType}; read as reporting no theft`
  const sum = incident.amountUsd === null ? 'no sum' : `$${(incident.amountUsd / 1e6).toFixed(1)}M`
  return `${incident.report}${incident.why === null ? '' : ` (${incident.why})`}; victim ${incident.victim ?? 'none'}, token ${incident.victimToken ?? 'none'}${incident.topExchange ? ', a top exchange' : ''}, ${sum}`
}
const say = (text: string): void => console.log(text)

say(`V9 news read by hand -- profile ${PROFILE}, from ${clock(FROM_SEC)} UTC${Number.isFinite(TO_SEC) ? ` to ${clock(TO_SEC)} UTC` : ''}`)
say(`${stories.size} stories on file, ${[...stories.values()].filter((story) => inRun(story.seenAt)).length} first seen in the run; ${alerts.length} notices in the run`)

say('\n== LOUD: the HIGH or CRITICAL hack or exploit notices (precision)')
const loudHacks = alerts.filter((alert) => alert.kind === 'NEWS_EVENT' && loud(alert) && isHack(byId.get(alert.id), alert))
for (const alert of loudHacks) {
  const story = byId.get(alert.id)
  say(`- ${clock(alert.at)} ${alert.severity.toUpperCase()} "${alert.title}" -- ${story?.sourceName ?? '?'}, published ${story === undefined ? '?' : clock(story.publishedAt)}`)
  say(`    ${story?.title ?? alert.body.slice(0, 200)}`)
  say(`    app: ${reading(story)}`)
}
say(`${loudHacks.length} loud hack or exploit notice(s)`)

// A story first seen in the run but published before it (the feeds' backlog read at the launch) is marked: no run could
// have told it first.
say('\n== NET: stories speaking of a theft in any words, with the notice each raised (recall)')
const THEFT = /\b(hack(s|ed|er|ers|ing)?|exploit(s|ed|er|ers)?|drain(s|ed|er)?|stole|stolen|steal(s|ing)?|theft|thieves|breach(es|ed)?|attack(s|ed|er|ers)?|compromised?|heist|rug ?pull(ed)?|phish(ing|ed)?|vulnerabilit(y|ies)|siphon(s|ed)?|private keys?|funds (lost|frozen)|lost \$|loss of \$|laundered|launder(s|ing)?)\b/i
const net = [...byId.values()].filter((story) => inRun(story.seenAt) && THEFT.test(`${story.title} ${story.summary}`)).sort((a, b) => a.seenAt - b.seenAt)
for (const story of net) {
  const alert = newsAlert.get(story.id)
  const before = story.publishedAt < FROM_SEC ? ` [published ${clock(story.publishedAt)}, before the run]` : ''
  say(`- ${clock(story.seenAt)} [${alert === undefined ? 'no notice' : alert.severity.toUpperCase()}] ${story.sourceName}: ${story.title}${before}`)
  say(`    app: ${reading(story)}`)
}
const counts = new Map<string, number>()
for (const story of net) {
  const severity = newsAlert.get(story.id)?.severity ?? 'none'
  counts.set(severity, (counts.get(severity) ?? 0) + 1)
}
say(`${net.length} stories in the net, ${net.filter((story) => story.publishedAt < FROM_SEC).length} of them published before the run; notices: ${[...counts.entries()].map(([severity, count]) => `${severity} ${count}`).join(', ')}`)

say('\n== SHOCKS: the market shock notices and the loud news after them (V9-SHOCK)')
const shocks = alerts.filter((alert) => alert.kind === 'MARKET_EVENT' && alert.id.startsWith('market-shock:')).sort((a, b) => a.at - b.at)
let explained = 0
for (const shock of shocks) {
  const after = alerts
    .filter((alert) => alert.kind === 'NEWS_EVENT' && loud(alert))
    .map((alert) => ({ alert, story: byId.get(alert.id) }))
    .filter(({ story }) => story !== undefined && story.publishedAt >= shock.at && story.publishedAt - shock.at <= SHOCK_ATTACH_SECONDS)
  if (after.length > 0) explained++
  say(`- ${clock(shock.at)} ${shock.title} -- ${shock.body.split('. ')[0]}.`)
  for (const { alert, story } of after) say(`    +${Math.round(((story as Read).publishedAt - shock.at) / 60)} min ${alert.severity.toUpperCase()} ${(story as Read).sourceName}: ${(story as Read).title}${alert.body.includes('after the market shock told at') ? ' [told with the shock]' : ''}`)
  if (after.length === 0) say('    no loud story within two hours')
}
say(`${shocks.length} shock notice(s); ${explained} with a loud story published within two hours, ${shocks.length - explained} without`)
