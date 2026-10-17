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
import sys
import tempfile

# A coin's name need not be Latin (Binance lists some by their Chinese names): written to a file on
# Windows, the output's code page could not hold it, and the listing stopped at the first such event.
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

ROOT =os.environ.get('SHADOW_ROOT') or os.path.join(tempfile.gettempdir(), 'traderspider-shadow')
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

# --- the experiment's report and the price forecast (V6 Stage 15) ---------------------------------


def share(value):
    return '-' if value is None else f'{value * 100:.1f}%'


def pct(value):
    return '-' if value is None else f'{value:.3f}%'


def interval(made, digits=1):
    """A figure's 95% interval (V7.2 Stage 1), where the section carries one."""
    return '-' if not made else f'[{made["low"] * 100:.{digits}f}%, {made["high"] * 100:.{digits}f}%]'


def worth(m):
    """What a horizon's figures are worth (V7.2 Stage 1): the intervals, the independent outcomes, the blocks."""
    ci = m.get('ci')
    if not ci:
        return ''
    n_eff = m.get('nEff')
    return f' | 95%: in 50% {interval(ci.get("coverage50"))} in 80% {interval(ci.get("coverage80"))} skill {interval(ci.get("skill"), 2)} calls right {interval(ci.get("callsRight"))}; independent outcomes {"-" if n_eff is None else round(n_eff)} of {m["n"]}, {m.get("blocks")} blocks'


def forecast_of(section, title):
    p = section['predictions']
    print(f'===== {title}: {clock(section["fromSec"])} to {clock(section["toSec"])}  passed={section["passed"]}')
    print(f'  {p["lines"]} forecasts of {p["pairs"]} pairs, at {p["gridCloses"]} of {p["expectedGridCloses"]} quarter-hour closes; {p["refreshes"]} refreshes {json.dumps(p["byReason"])}')
    for h, row in section['horizons'].items():
        m = row['metrics']
        moved, unmoved = row['news']['moved'], row['news']['unmoved']
        print(f'  {h:10} judged {row["outcomes"]:5}  way right {share(m["direction"]):7} calls {m["calls"]} right {share(m["callsRight"]):7} in 50% {share(m["coverage50"]):7} in 80% {share(m["coverage80"]):7} median error {pct(m["mae"]):9} bias {pct(m["bias"]):9} bull {row["bull"]["right"]}/{row["bull"]["calls"]} bear {row["bear"]["right"]}/{row["bear"]["calls"]}  story-moved {moved["n"]} ({share(moved["coverage80"])} in 80%)  the rest {unmoved["n"]} ({share(unmoved["coverage80"])} in 80%)' + worth(m))
        shock = row.get('shock')
        if shock is not None:
            print(f'  {h:10} widened for Bitcoin\'s move {shock["widened"]["n"]} ({share(shock["widened"]["coverage80"])} in 80%; by V2\'s own levels {share(shock["unwidened"]["coverage80"])})')
        # The forecasts by the market's shock state at them (V7.1 Stage 11).
        by_state = row.get('byState')
        if by_state:
            print(f'  {h:10} by state: ' + '; '.join(f'{s} {m["n"]} ({share(m["coverage80"])} in 80%, pinball {pct(m["pinball"])})' for s, m in by_state.items()))
    for h, row in section['horizons'].items():
        for variant, m in (row.get('variants') or {}).items():
            print(f'  {h:10} {variant.upper()}  n {m["n"]:5}  way right {share(m["direction"]):7} in 80% {share(m["coverage80"]):7} median error {pct(m["mae"]):9} bias {pct(m["bias"]):9} pinball {pct(m["pinball"])}' + worth(m))
    classes = section.get('classes')
    if classes:
        print(f'  calls at the lead horizon: {json.dumps(classes["calls"])}; coin classes: {json.dumps(classes["pairClasses"])}')
    for name in ('top', 'best', 'worst'):
        for row in section.get(name) or []:
            print(f'  {name:5} {row["pair"]:12} {clock(row["t"])} {row["horizon"]:10} {row["call"]:15} quality {row["quality"]} median {pct(row["medianPct"])} moved {pct(row["movePct"])} in80 {row["in80"]}')
    t = section['trades']
    print(f'  forecast trader: {t["opened"]} opened, {t["closed"]} closed, {t["wins"]} ahead, net {t["netQuote"]:.2f}, fees {t.get("feesQuote", 0):.2f}, slippage {t.get("slippageQuote", 0):.3f}, best {json.dumps(t.get("best"))}, worst {json.dumps(t.get("worst"))}' + (f'  -- {section["sampleNote"]}' if section.get('sampleNote') else ''))
    # The paper laboratory's trades in the span, by strategy (V7.1 Stage 4), and the path's figures (Stage 3).
    lab = section.get('lab')
    if lab:
        print('  paper laboratory: ' + '; '.join(f'{s.upper()} {v["opened"]} opened, {v["closed"]} closed, net {v["netQuote"]:.2f}' for s, v in lab.items()))
    else:
        print('  paper laboratory: no trade opened in the span')
    for h, row in section['horizons'].items():
        t = row.get('timing')
        if t is not None:
            ex = t['excursion']
            print(f'  {h:10} arrival: {t["n"]} judged, chance said {share(t["predicted"])} reached {share(t["reached"])}, UNLIKELY {t["unlikely"]} (reached {share(t["unlikelyReached"])}), minutes said {t["saidMinutes"]} seen {t["seenMinutes"]}; likely levels on {ex["n"]}: high held {share(ex["high80"])} low held {share(ex["low80"])}')
    for g in section['gates']:
        print(f'  {g["id"]:18} {g["status"]:13} {g["detail"]}')


for f in sorted(glob.glob(os.path.join(OUT, 'experiment-*.json'))):
    run = load(f)
    report = run.get('report') or {}
    print(f'\n===== {os.path.basename(f)}: {run["kind"]} {run["minutes"]} min {run["mode"]}, models {", ".join(run["models"]) or "none"}; passed={report.get("passed")}; verdict {report.get("verdict")}; AI ${(report.get("costs") or {}).get("aiUsd", 0):.4f}')
    for g in report.get('gates', []):
        print(f'  {g["id"]:20} {g["status"]:13} {g["detail"]}')
    if report.get('forecast'):
        forecast_of(report['forecast'], 'the forecast as the report filed it, at the run\'s end')
settled = load(os.path.join(OUT, 'forecast-section.json'))
if settled:
    print()
    forecast_of(settled, 'the forecast once the run\'s last forecasts came due')
spend = load(os.path.join(ROOT, 'real-ai-spend.json'))
if spend:
    print(f'\n===== real models: runs {", ".join(spend["runs"])}; retired profiles ${spend["retiredUsd"]:.4f}; ceiling ${spend["ceilingUsd"]}')

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
        print(f'  NOTICE {clock(n["at"] / 1000)} [{n["severity"]}] {n.get("kind") or "-"} {n["title"]} :: {n["body"][:220]}')

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
