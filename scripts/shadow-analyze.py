"""What a shadow run did (scripts/shadow-run.mjs): every segment's status ticks, the hourly reports,
the final reports with their gates, and the records the app kept on file -- events, calls, trades,
stories -- which span every segment. Reads only.

    RUN_NAME=day python scripts/shadow-analyze.py
    SHADOW_ROOT=... RUN_NAME=... EXCHANGE_INFO=xinfo.json python scripts/shadow-analyze.py

EXCHANGE_INFO is optional: a saved /exchangeInfo answer, so that a stock token (Binance's trading
group TRD_GRP_261) is tagged in the listings. Without it nothing is tagged.
"""
import datetime
import glob
import json
import os
import tempfile

ROOT = os.environ.get('SHADOW_ROOT') or os.path.join(tempfile.gettempdir(), 'traderspider-shadow')
RUN = os.environ.get('RUN_NAME', 'shadow')
OUT = os.path.join(ROOT, f'{RUN}-out')
PROFILE = os.path.join(ROOT, f'{RUN}-profile')

STOCK = set()
if os.environ.get('EXCHANGE_INFO') and os.path.exists(os.environ['EXCHANGE_INFO']):
    info = json.load(open(os.environ['EXCHANGE_INFO'], encoding='utf8'))
    STOCK = {s['symbol'] for s in info['symbols'] if 'TRD_GRP_261' in (s.get('permissionSets') or [[]])[0]}


def tag(sym):
    return ' [STOCK]' if sym in STOCK else ''


def clock(sec):
    return datetime.datetime.fromtimestamp(sec, datetime.timezone.utc).strftime('%m-%d %H:%M:%S')


def jsonl(pattern):
    rows = []
    for f in sorted(glob.glob(pattern)):
        for line in open(f, encoding='utf8'):
            if line.strip():
                rows.append(json.loads(line))
    return rows


def load(path):
    return json.load(open(path, encoding='utf8')) if os.path.exists(path) else None


def gates_of(report, title):
    print(f'===== {title}: {clock(report["fromSec"])} to {clock(report["toSec"])}  passed={report["passed"]}  twelveHour={report["twelveHour"]}  appStarted={clock(report["appStartedSec"])}')
    for g in report['gates']:
        print(f'  {g["id"]:15} {g["status"]:13} {"(12h)" if g["twelveHour"] else "     "} {g["detail"]}')
    for k in ('events', 'calls', 'answers', 'paper', 'alerts', 'stream'):
        print(f'  {k}: {json.dumps(report[k])}')


print(f'run {RUN} in {ROOT}')
if not os.path.isdir(OUT):
    raise SystemExit(f'no output at {OUT}')

# --- the segments and their ticks ------------------------------------------------------------------
segments = load(os.path.join(OUT, 'segments.json')) or []
ticks = jsonl(os.path.join(OUT, 'status.jsonl'))
print(f'\n===== segments: {len(segments)}')
for s in segments:
    own = [t for t in ticks if t['segment'] == s['n']]
    end = s['endedAt'] or (own[-1]['at'] if own else s['startedAt'])
    last = own[-1] if own else None
    minutes = (end - s['startedAt']) / 60000
    print(f'  s{s["n"]}: {clock(s["startedAt"] / 1000)} to {clock(end / 1000)} ({minutes:.0f} min){"" if s["endedAt"] else " KILLED"}; {len(own)} ticks')
    if last:
        live = last['live']
        print(f'      last tick: events {json.dumps(last["events"])} calls {json.dumps(last["calls"])} executors {json.dumps(last["executors"])}')
        print(f'      stream: on {live.get("host")} open={live["open"]} connects={live["connects"]} drops={live["drops"]} gaps={live["gaps"]} socket moves={live.get("hostSwitches", 0)} data host moves={live.get("dataHostSwitches", 0)}; fake asked {last["fake"]["asked"]} {json.dumps(last["fake"]["byName"])} notices {json.dumps(last["fake"]["notices"])}')
        hb = last['hb']
        print(f'      page heartbeat: {hb["ticks"]} ticks, longest gap {hb["maxGapMs"]} ms, over 5 s {hb["over5s"]}, over 60 s {hb["over60s"]}, hidden {hb["hiddenMs"]} ms')
    feeds = {}
    for t in own:
        for source in t['feed']['sources']:
            name, ok = source.split(':')[0], source.split(':')[1]
            feeds.setdefault(name, [0, 0])[0 if ok == 'true' else 1] += 1
    if feeds:
        print('      feeds (ticks ok/failed): ' + ', '.join(f'{k} {v[0]}/{v[1]}' for k, v in feeds.items()))

# The stream's counts are since each segment's app start: summed over the segments' last ticks.
totals = {'connects': 0, 'drops': 0, 'gaps': 0, 'hostSwitches': 0, 'dataHostSwitches': 0}
for s in segments:
    own = [t for t in ticks if t['segment'] == s['n']]
    if own:
        for k in totals:
            totals[k] += own[-1]['live'].get(k, 0)
print(f'  stream over every segment: {json.dumps(totals)}')

# --- the hourly reports --------------------------------------------------------------------------
hourly = sorted(glob.glob(os.path.join(OUT, 'hour-reports', '*.json')))
if hourly:
    print(f'\n===== hourly reports: {len(hourly)}')
    refused = {}
    alerts = {'info': 0, 'watch': 0, 'high': 0, 'critical': 0}
    for f in hourly:
        r = load(f)
        failed = [g['id'] for g in r['gates'] if g['status'] == 'fail' and (not g['twelveHour'] or r['twelveHour'])]
        print(f'  {os.path.basename(f):28} {clock(r["fromSec"])} to {clock(r["toSec"])} passed={r["passed"]} events {r["events"]["raised"]} calls {r["calls"]["total"]} trades {r["paper"]["opened"]} alerts {json.dumps(r["alerts"])}{" FAILED " + ",".join(failed) if failed else ""}')
        for entry in r['paper']['refused']:
            refused[entry['reason']] = refused.get(entry['reason'], 0) + entry['count']
        for k in alerts:
            alerts[k] += r['alerts'][k]
    print(f'  refusals over the hours: {json.dumps(refused)}')
    print(f'  alerts over the hours: {json.dumps(alerts)}')

# --- the final reports ---------------------------------------------------------------------------
print()
for name in ('day', 'twelve', 'session', 'hour'):
    r = load(os.path.join(OUT, f'session-report-{name}.json'))
    if r is None:
        print(f'(no session-report-{name}.json)')
        continue
    gates_of(r, name)

# --- the records on file, over every segment -----------------------------------------------------
print('\n===== raw records')
events = jsonl(os.path.join(PROFILE, 'marketEvents', '*.jsonl'))
# Since V5 Stage 4 the events file also holds each event's status lines ({kind: 'status'}); the
# records are the event lines alone.
events = [e for e in events if e.get('kind') != 'status']
for e in events:
    live = e.get('live') or {}
    print(f'EVENT {clock(e["time"])} {e["symbol"] + tag(e["symbol"]):20} {e["band"]:9} {e["type"]:12} {e["direction"]:4} score {e["score"]:.1f} price {e["price"]} move15m {e["returnsPct"]["m15"]:.2f}% sigmas {e["moveSigmas"]:.1f} rank {live.get("rank")} vol24h {live.get("quoteVolume24h")} spread {live.get("spreadPct")}')
calls = jsonl(os.path.join(PROFILE, 'aiLedger', '*.jsonl'))
for c in calls:
    ans = c.get('additionAnswer')
    print(f'CALL {clock(c["at"])} {c["source"]:8} {str(c.get("addition")):6} {c["status"]:8} {str(c.get("symbol")) + tag(c.get("symbol")):20} {str(c.get("recommendation")):5} conf {c.get("confidence")} latency {c["usage"].get("latencyMs")} cost {c["usage"].get("costUsd")} {json.dumps(ans)[:160] if ans else ""} {c.get("error") or ""}')
settings = load(os.path.join(PROFILE, 'settings.json')) or {}
for e in settings.get('executors', []):
    p = e['params']
    w = e.get('watch') or {}
    print(f'TRADE {e["id"][:8]} {e["symbol"] + tag(e["symbol"]):20} {p["side"]:4} {e["status"]:7} created {clock(e["createdAt"])} stopped {clock(e["stoppedAt"]) if e.get("stoppedAt") else "-"} stake {p["amountQuote"]} tp {p["takeProfitPct"]} sl {p["stopLossPct"]} limit {p["timeLimitSec"]} range {p.get("entryRange")} fill {p.get("entryFill")} expires {clock(p["entryExpiresAt"]) if p.get("entryExpiresAt") else "-"} book {json.dumps(w.get("book"))} result {json.dumps(w.get("result"))} aiExit {json.dumps(w.get("aiExit"))[:200] if w.get("aiExit") else "-"}')

for f in sorted(glob.glob(os.path.join(OUT, 'main-fake-*.json'))):
    fake = load(f)
    print(f'\n===== {os.path.basename(f)}: {len(fake["asked"])} calls, {len(fake["other"])} other openrouter requests, {len(fake["notices"])} notices')
    for a in fake['asked']:
        print(f'  {clock(a["at"] / 1000)} {a["name"]:20} {a["status"]} {a["ms"]} ms {a.get("said", "")} {a.get("error", "")}')
    for o in fake['other']:
        print('  OTHER', o)
    for n in fake['notices']:
        print(f'  NOTICE {clock(n["at"] / 1000)} [{n["severity"]}] {n["title"]} :: {n["body"][:220]}')

stories = jsonl(os.path.join(PROFILE, 'news', 'feed-*.jsonl'))
start = segments[0]['startedAt'] / 1000 if segments else 0
recent = [s for s in stories if s['publishedAt'] >= start - 3600]
print(f'\n===== stories on file: {len(stories)}; published in the hour before and during the run: {len(recent)}')

print('\n===== logs')
for name in ('main.log', 'console.log'):
    path = os.path.join(OUT, name)
    if not os.path.exists(path):
        continue
    lines = [line.rstrip() for line in open(path, encoding='utf8', errors='replace') if 'Using Binance market data endpoint' not in line]
    print(f'{name}: {len(lines)} lines')
    shown = 0
    for line in lines:
        if line.lstrip().startswith('at ') or line.strip() in ('}', ']', '[errors]: [') or line.lstrip().startswith(('errno:', 'code:', 'syscall:', 'address:', 'port:', 'Error: connect')):
            continue
        print('  ', line[:300])
        shown += 1
        if shown >= 80:
            print('   ...')
            break

card = os.path.join(OUT, 'card-text.json')
if os.path.exists(card):
    c = load(card)
    for k, v in c.items():
        print()
        print('===== card text:', k)
        print(str(v.get('text', v))[:3000])
