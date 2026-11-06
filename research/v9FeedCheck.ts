// V9-S8-GATES's feed gate (V9 Stage 8): every HIGH or CRITICAL hack or exploit notice of the run is one whose story was a
// first report by its incident. The run's stories are read again from the profile's feed files by the app's own rules
// (shared/newsFeed.ts readStory, shared/incidents.ts incidentsOf, as of the run's build), each as it was when first
// seen, and each loud news notice of the run (alerts-*.jsonl, NEWS_EVENT, high or critical) is looked up by its id.
// Prints one JSON line: the gate's counts and the notices that were not first reports. Reads files only.
//
//   npx esbuild research/v9FeedCheck.ts --bundle --platform=node --format=esm --outfile=research/.v9FeedCheck.mjs
//   PROFILE=<profile> FROM_SEC=<run start> node research/.v9FeedCheck.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { incidentsOf } from '../shared/incidents'
import { assetDictionary, readStory, FEED_SOURCES, NEWS_FEED_VERSION, type FeedStory } from '../shared/newsFeed'

const PROFILE = process.env.PROFILE ?? ''
const FROM_SEC = Number(process.env.FROM_SEC ?? 0)
if (PROFILE === '' || !existsSync(PROFILE)) throw new Error('PROFILE is the run\'s profile folder')

const rows = (dir: string, pattern: RegExp): unknown[] =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => pattern.test(name))
        .sort()
        .flatMap((name) => readFileSync(join(dir, name), 'utf-8').split('\n').filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line) as unknown))
    : []

const stories = new Map<string, FeedStory>()
for (const row of rows(join(PROFILE, 'news'), /^feed-\d{4}-\d{2}\.jsonl$/) as (FeedStory & { kind?: string })[]) if (row.kind !== 'source' && typeof row.title === 'string') stories.set(row.id, row)
// The coins a story can name: the tickers its stories named on file and the main coins; a story's incident reads its
// victim from the tables, its token checked against these.
const bases = new Set<string>(['BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX'])
const dictionary = assetDictionary([...bases, ...JSON.parse(readFileSync('shared/incidentVictims.json', 'utf-8')).victims.map((row: [string, string]) => row[1])])
const credibility = new Map<string, number>(FEED_SOURCES.map((source) => [source.id, source.credibility]))
const read = [...stories.values()].map((story) => readStory(story, dictionary, credibility.get(story.source) ?? 0.5, story.seenAt))
const byId = new Map(incidentsOf(read, dictionary, 0).map((story) => [story.id, story]))

const alerts = (rows(join(PROFILE, 'alerts'), /^alerts-\d{4}-\d{2}\.jsonl$/) as { id: string; at: number; kind?: string; severity: string; title: string }[]).filter(
  (alert) => alert.kind === 'NEWS_EVENT' && (alert.severity === 'high' || alert.severity === 'critical') && alert.at >= FROM_SEC
)
const hackAlerts = alerts.filter((alert) => {
  const story = byId.get(alert.id)
  return story !== undefined ? story.eventType === 'HACK' || story.eventType === 'EXPLOIT' : /· (Hack|Exploit)$/.test(alert.title)
})
const notFirst = hackAlerts.filter((alert) => byId.get(alert.id)?.incident?.report !== 'first').map((alert) => ({ id: alert.id, title: alert.title, why: byId.get(alert.id)?.incident?.why ?? 'its story is not on file' }))
console.log(JSON.stringify({ version: NEWS_FEED_VERSION, stories: stories.size, loudNews: alerts.length, loudHacks: hackAlerts.length, notFirst }))
