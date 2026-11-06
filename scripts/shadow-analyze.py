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
import re
import subprocess
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
    # The tape (V7.2 Stage 5): one line a minute per streamed pair's book, and Bitcoin's minutes.
    tape = section.get('tape')
    print('  tape: ' + (f'{tape["lines"]} book lines of {tape["pairs"]} pairs, {tape["minutes"]} Bitcoin minutes' if tape else 'none in the span'))
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

# --- the V7.2-R gates (Stage 9, 22 October 2026) ---------------------------------------------------
# Read from the profile's own records over the run: the models asked against the roles applied and the model that
# answered (V72R-S1-ROUTING's lines), every paper or demo order opened with its record and, once stopped, how it ended,
# the research ZIP read back by scripts/research-analyze.py, and the challenger's shadow week (V72R-S8-SHADOW). The
# forecast's own gates (every due forecast judged, every notice's sound on file) are the forecast section's above.
SAME_SUFFIX = re.compile(r'^-(\d{4}-?\d{2}-?\d{2}|\d{4}|v\d+(\.\d+)*|latest|preview)$')
EFFORTS = ('low', 'minimal')


def slug_of(model):
    at = model.rfind('@')
    return model[:at] if at >= 0 and model[at + 1:] in EFFORTS else model


def served_family(asked, served):
    """shared/aiRouting.ts servedFamilyOf, read the same way."""
    if not served or not served.strip():
        return 'unknown'
    slug = slug_of(asked).lower()
    name = served.strip().lower()
    if name == slug or (name.startswith(slug + '-') and SAME_SUFFIX.match(name[len(slug):])):
        return 'same'
    if '/' not in name:
        return 'same' if slug.endswith('/' + name) or name.startswith(slug[slug.find('/') + 1:]) else 'variant'
    provider = lambda text: text[:text.find('/')] if '/' in text else ''
    return 'variant' if provider(name) == provider(slug) else 'other'


def gate_line(gid, status, detail):
    print(f'  {gid:15} {status:13} {detail}')


run_start = segments[0]['startedAt'] / 1000 if segments else 0
print(f'\n===== V7.2-R gates over the run, from {clock(run_start)}')

# Routing: every call since the run began asked a model of the roles applied, and was answered by it.
ai_config = load(os.path.join(PROFILE, 'aiConfig.json')) or {}
roles = ai_config.get('roles') or None
role_models = set()
if roles is not None:
    role_models = {m for m in (ai_config.get('defaultModel'), roles.get('gate'), roles.get('summarize')) if isinstance(m, str) and m}
run_calls = [c for c in jsonl(os.path.join(PROFILE, 'aiLedger', '*.jsonl')) if c.get('at', 0) >= run_start]
if roles is None:
    gate_line('roles', 'not measured', 'No roles were applied on this profile.')
elif not run_calls:
    gate_line('roles', 'not measured', f'No model was asked in the run; the roles: {sorted(role_models)}.')
else:
    outside = [c for c in run_calls if c.get('model') not in role_models]
    by_model = {}
    for c in run_calls:
        key = f'{c.get("model")} ({c.get("role") or "-"}, {c.get("addition") or c.get("source")})'
        by_model[key] = by_model.get(key, 0) + 1
    gate_line('roles', 'pass' if not outside else 'fail', f'{len(run_calls)} calls, {len(outside)} outside the roles {sorted(role_models)}; ' + '; '.join(f'{k}: {v}' for k, v in sorted(by_model.items())))
answered = [c for c in run_calls if c.get('status') in ('ok', 'rejected')]
if not answered:
    gate_line('served', 'not measured', 'No call was answered in the run.')
else:
    families = {}
    for c in answered:
        fam = served_family(c.get('model') or '', c.get('servedModel'))
        families[fam] = families.get(fam, 0) + 1
    others = [c for c in answered if served_family(c.get('model') or '', c.get('servedModel')) == 'other']
    gate_line('served', 'pass' if not others else 'fail', f'{len(answered)} answered: ' + ', '.join(f'{k} {v}' for k, v in sorted(families.items())) + ('' if not others else f'; another provider\'s model answered {others[0].get("model")} with {others[0].get("servedModel")}'))
spent = sum((c.get('usage') or {}).get('costUsd') or 0 for c in run_calls)
print(f'  the run\'s calls cost ${spent:.4f}')

# Paper and demo orders: each opened in the run is on the research folder's record, and each stopped says how it ended.
settings_now = load(os.path.join(PROFILE, 'settings.json')) or {}
orders = [e for e in settings_now.get('executors', []) if e.get('mode') in ('paper', 'demo') and (e.get('createdAt') or 0) >= run_start]
events_on_file = jsonl(os.path.join(PROFILE, 'trader-spider-research', 'trades', 'paper-orders-*.jsonl'))
opened_on_file = {e['id'] for e in events_on_file if e.get('kind') == 'opened'}
ended_on_file = {e['id'] for e in events_on_file if e.get('kind') in ('closed', 'stopped')}
if not orders:
    gate_line('orders_whole', 'not measured', 'No paper or demo order was opened in the run.')
else:
    # A V8 book's trade keeps how it ended on its book stamp ({id, startedAt, ledger, result}).
    def mark_of(e):
        return e.get('lab') or e.get('forecast') or e.get('watch') or e.get('newsRule') or (e.get('book') if isinstance(e.get('book'), dict) else None) or {}
    no_open = [e for e in orders if e['id'] not in opened_on_file]
    unended = [e for e in orders if e.get('status') == 'stopped' and mark_of(e).get('result') is None]
    unrecorded_end = [e for e in orders if e.get('status') == 'stopped' and e['id'] not in ended_on_file]
    by_origin = {}
    for e in orders:
        origin = 'lab' if e.get('lab') else 'forecast' if e.get('forecast') else 'watch' if e.get('watch') else 'news' if e.get('newsRule') else f'book {e["book"].get("id")}' if isinstance(e.get('book'), dict) else 'person'
        by_origin[f'{origin}/{e.get("mode")}'] = by_origin.get(f'{origin}/{e.get("mode")}', 0) + 1
    ok = not no_open and not unended and not unrecorded_end
    gate_line('orders_whole', 'pass' if ok else 'fail', f'{len(orders)} opened ({", ".join(f"{k} {v}" for k, v in sorted(by_origin.items()))}), {sum(1 for e in orders if e.get("status") == "stopped")} ended; without their opening on file {len(no_open)}, stopped without how it ended {len(unended)}, ended off the record {len(unrecorded_end)}')

# The research ZIP: the newest export read back by the analyzer, its manifest's checksums holding.
zips = sorted(glob.glob(os.path.join(PROFILE, 'trader-spider-research', 'exports', 'trader-spider-report-*.zip')))
if not zips:
    gate_line('zip_read', 'not measured', 'No export was made in the run.')
else:
    analyzer = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'research-analyze.py')
    made = subprocess.run([sys.executable, analyzer, zips[-1]], capture_output=True, text=True, encoding='utf-8', errors='replace')
    text = made.stdout or ''
    # Read back whole: its manifest's sizes and checksums hold and nothing secret is in it. The analyzer's other checks
    # are about the record it carries, said beside.
    held = 'PASS  manifest' in text and 'PASS  no secret' in text
    others = [line.strip() for line in text.splitlines() if line.strip().startswith('FAIL')]
    gate_line('zip_read', 'pass' if held else 'fail', f'{os.path.basename(zips[-1])} ({len(zips)} on file): {"read back, its manifest and no secret held" if held else "not read back: " + (made.stderr or text)[-200:]}' + (f'; the record in it: {"; ".join(others)}' if others else ''))

# The challenger's shadow week (V72R-S8-SHADOW): the closes it forecast beside the run in use, its owed outcomes, and
# no line of the run in use's naming it.
current_file = load(os.path.join(PROFILE, 'forecastModels', 'current.json')) or {}
training_log = jsonl(os.path.join(PROFILE, 'forecastModels', 'training-*.jsonl'))
shadows = [line for line in training_log if line.get('kind') in ('shadow', 'shadow-adopted', 'shadow-dropped', 'skipped')]
seed = load(os.path.join(OUT, 'shadow-seed.json'))
held_shadow = current_file.get('shadow') or (seed or {}).get('shadow')
shadow_lines = jsonl(os.path.join(PROFILE, 'forecasts', 'shadow-predictions-*.jsonl'))
if held_shadow is None and not shadow_lines:
    gate_line('shadow', 'not measured', 'No challenger was in its shadow week in the run.')
else:
    run_id = (held_shadow or {}).get('runId') or (shadow_lines[0]['run'] if shadow_lines else None)
    since = (held_shadow or {}).get('since') or run_start
    until = (held_shadow or {}).get('until') or 1e12
    mine = [p for p in shadow_lines if p.get('run') == run_id and p.get('why') == 'grid']
    champion = [p for p in jsonl(os.path.join(PROFILE, 'forecasts', 'predictions-*.jsonl')) if p.get('why') == 'grid' and since <= p['t'] < until]
    last_close = max([p['t'] for p in champion], default=since)
    champion_keys = {(p['pair'], p['t']) for p in champion}
    shadow_keys = {(p['pair'], p['t']) for p in mine}
    paired = len(champion_keys & shadow_keys) / len(champion_keys) if champion_keys else None
    shadow_outcomes = {(o['id'], o['h']) for o in jsonl(os.path.join(PROFILE, 'forecasts', 'shadow-outcomes-*.jsonl'))}
    seconds = {'minutes5': 300, 'minutes15': 900, 'hour1': 3600, 'hours4': 14400, 'hours24': 86400}
    due = [(p['id'], h) for p in mine for h in p.get('h', {}) if p['t'] + seconds[h] + 600 + 3600 <= last_close]
    settled = sum(1 for key in due if key in shadow_outcomes)
    # Within its week: adopted at its end, the run in use's lines after it name it, as they should.
    named = 0
    if run_id:
        for pattern in ('predictions-*.jsonl', 'passes-*.jsonl'):
            named += sum(1 for line in jsonl(os.path.join(PROFILE, 'forecasts', pattern)) if since <= line.get('t', 0) < until and run_id in json.dumps(line))
        named += sum(1 for e in settings_now.get('executors', []) if since <= (e.get('createdAt') or 0) < until and run_id in json.dumps(e))
    ok = paired is not None and paired >= 0.99 and (not due or settled / len(due) >= 0.99) and named == 0
    gate_line('shadow', 'pass' if ok else 'fail', f'{run_id} since {clock(since)}: {len(mine)} grid forecasts; the run in use\'s {len(champion_keys)} paired {share(paired)}; due horizons settled {settled} of {len(due)}; lines of the run in use\'s naming it {named}')
    for line in shadows:
        print(f'  training log {clock(line["at"])} {line["kind"]:15} {line.get("runId")} {line.get("why") or ""} {line.get("summary") or ""}')

# --- V8's gates (V8-S12-GATES), each read per span ----------------------------------------------
# A span is a stretch of the harness's status ticks (every ten minutes) with no gap of more than 30 minutes: an outage,
# a power loss or a restart ends one, and a gate that needs an hour inside a span reads only whole spans.
ticks = sorted(t['at'] / 1000 for t in jsonl(os.path.join(OUT, 'status.jsonl')) if isinstance(t.get('at'), (int, float)))
spans = []
for t in ticks:
    if spans and t - spans[-1][1] <= 30 * 60:
        spans[-1][1] = t
    else:
        spans.append([t, t])
print(f'\n===== V8 gates, read over {len(spans)} span(s): ' + '; '.join(f'{clock(a)} to {clock(b)}' for a, b in spans))
in_span = lambda t: any(a <= t <= b for a, b in spans)
# A book trade's stamp is {id, startedAt, ledger, result}: its book is its id.
book_of = lambda e: (e.get('book') or {}).get('id') if isinstance(e.get('book'), dict) else e.get('book')

# The prediction record (V8-S2-RECORD): every source prediction made in a span whose outcome was due before the span's
# end, its grace and the record's settling allowed, answered -- settled, late, or missing with its reason -- and the
# missing ones at most 1% outside outages.
sources = jsonl(os.path.join(PROFILE, 'predictions', 'sources-*.jsonl'))
outcomes = {o['id']: o for o in jsonl(os.path.join(PROFILE, 'predictions', 'source-outcomes-*.jsonl'))}
due = [p for p in sources if p.get('madeAt', 0) >= run_start and any(a <= p['madeAt'] and p['madeAt'] + p['horizonSec'] + 600 + 1800 <= b for a, b in spans)]
if not due:
    gate_line('record_whole', 'not measured', f'No source prediction came due inside a span ({len(sources)} on file).')
else:
    unanswered = [p for p in due if p['id'] not in outcomes]
    missing = [p for p in due if outcomes.get(p['id'], {}).get('status') == 'missing']
    by_source = {}
    for p in due:
        by_source[p['source']] = by_source.get(p['source'], 0) + 1
    ok = not unanswered and len(missing) <= 0.01 * len(due)
    gate_line('record_whole', 'pass' if ok else 'fail', f'{len(due)} due ({", ".join(f"{k} {v}" for k, v in sorted(by_source.items()))}): unanswered {len(unanswered)}, missing {len(missing)}' + (f'; first unanswered {unanswered[0]["id"]}' if unanswered else ''))

# The books (V8 Stage 9): Stop putting back exactly what Start turned on, each running book's equity marked every whole
# hour inside a span, and every book trade a paper one.
started_file = load(os.path.join(PROFILE, 'paperBooks', 'started.json'))
book_runs = jsonl(os.path.join(PROFILE, 'paperBooks', 'runs-*.jsonl'))
marks = jsonl(os.path.join(PROFILE, 'paperBooks', 'equity-*.jsonl'))
books_cfg = settings_now.get('paperBooks') or {}
if not book_runs and not started_file and not books_cfg.get('running'):
    gate_line('books', 'not measured', 'Paper testing was not started in the run.')
else:
    problems = []
    for r in book_runs:
        if r.get('restored') is not True:
            problems.append(f'the run of {clock(r.get("startedAt") or 0)} did not put every switch back ({json.dumps(r.get("restored"))[:120]})')
    # After the last Stop, with paper testing not running again, each switch it turned on reads as it was before.
    switch_paths = {'news.enabled': ('enabled',), 'news.delisting.paperShort': ('delisting', 'paperShort', 'enabled'), 'news.delisting.askModels': ('delisting', 'askModels')}
    news_now = load(os.path.join(PROFILE, 'news.json')) or {}
    if book_runs and not books_cfg.get('running') and started_file is None:
        for entry in book_runs[-1].get('switched') or []:
            value = news_now
            for key in switch_paths.get(entry.get('switch'), ('?',)):
                value = value.get(key) if isinstance(value, dict) else None
            if value != entry.get('was'):
                problems.append(f'{entry.get("switch")} reads {value} after Stop, not {entry.get("was")} as before Start')
    running_from = books_cfg.get('startedAt') if books_cfg.get('running') else None
    hours_owed = 0
    hours_marked = 0
    marked = {(m.get('book'), int(m.get('at', 0)) // 3600) for m in marks}
    for a, b in spans:
        for r in book_runs + ([{'startedAt': running_from, 'stoppedAt': None}] if running_from else []):
            s0 = max(a, r.get('startedAt') or a)
            s1 = min(b, r.get('stoppedAt') or b)
            hour = int(s0 // 3600) + 1
            while hour * 3600 + 120 <= s1:
                for book in ('news', 'copy', 'baseline'):
                    hours_owed += 1
                    hours_marked += 1 if (book, hour) in marked else 0
                hour += 1
    archived = jsonl(os.path.join(PROFILE, 'paperBooks', 'archive-*.jsonl'))
    book_trades = [e for e in settings_now.get('executors', []) + archived if book_of(e) in ('news', 'copy', 'baseline')]
    not_paper = [e for e in book_trades if e.get('mode') != 'paper']
    if not_paper:
        problems.append(f'{len(not_paper)} book trade(s) not on paper')
    if hours_owed and hours_marked < hours_owed:
        problems.append(f'{hours_owed - hours_marked} of {hours_owed} book-hours without their mark')
    by_book = {}
    for e in book_trades:
        by_book[book_of(e)] = by_book.get(book_of(e), 0) + 1
    gate_line('books', 'pass' if not problems else 'fail', f'{len(book_runs)} run(s) stopped, {"running since " + clock(running_from) if running_from else "not running"}; marks {hours_marked} of {hours_owed} book-hours; trades {", ".join(f"{k} {v}" for k, v in sorted(by_book.items())) or "none"}' + (f'; {"; ".join(problems)}' if problems else ''))

# Follows (V8 Stage 8): each leader event on file before the trade made on it, and no event acted on twice.
events_by_key = {}
for f in glob.glob(os.path.join(PROFILE, 'traders', '*', 'events-*.jsonl')):
    for e in jsonl(f):
        events_by_key[e.get('key')] = e
copy_trades = [e for e in settings_now.get('executors', []) + jsonl(os.path.join(PROFILE, 'paperBooks', 'archive-*.jsonl')) if book_of(e) == 'copy' and (e.get('follow') or {}).get('legs')]
if not copy_trades and not events_by_key:
    gate_line('follows', 'not measured', 'No leader event was read and no follow traded in the run.')
else:
    acted = set()
    opened_by = {}
    before_file = []
    twice = []
    for e in copy_trades:
        mine = {}
        for at, leg in enumerate((e.get('follow') or {}).get('legs', [])):
            key = leg.get('eventKey') or ''
            # A leg a leader's event made; a close of the follow's own (its time, its stake, a lost leader) is keyed by
            # the trade's id.
            if not key.startswith(('hyperliquid-', 'okx-')):
                continue
            acted.add(key)
            mine[key] = mine.get(key, 0) + 1
            if at == 0:
                opened_by[key] = opened_by.get(key, 0) + 1
            event = events_by_key.get(key)
            if event is None or (event.get('receivedMs') or 0) > (leg.get('atMs') or 0) + 1000:
                before_file.append(key)
        # Twice: one event applied twice to one trade, or one event opening two trades (a flip closes one and opens one).
        twice += [k for k, n in mine.items() if n > 1]
    twice += [k for k, n in opened_by.items() if n > 1]
    gate_line('follows', 'pass' if not before_file and not twice else 'fail', f'{len(events_by_key)} leader events on file, {len(copy_trades)} follows traded on {len(acted)} of them; acted on before on file {len(before_file)}, acted on twice {len(twice)}')

# The key copies (the user's answer of 26 October 2026): swept at every start, and none outliving the run.
sweeps = [load(f) or {} for f in sorted(glob.glob(os.path.join(OUT, 'key-sweep-*.json')))]
real_ai_run = any(s.get('realAi') for s in sweeps)
left = [name for name in ('aiCredentials.json', 'credentials.json') + (('Local State',) if real_ai_run else ()) if os.path.exists(os.path.join(PROFILE, name))]
ended = bool(segments) and all(seg.get('endedAt') for seg in segments)
if not sweeps:
    gate_line('keys', 'fail', 'No sweep of key copies was recorded at a start.')
else:
    gate_line('keys', ('pass' if not left else 'fail') if ended else 'not measured', f'{len(sweeps)} start(s) swept ({sum(len(s.get("removed", [])) for s in sweeps)} file(s) removed then); after the run {"the profile holds " + ", ".join(left) if left else "no copy is left"}' + ('' if ended else ' -- the run has not ended'))

# Real spend within the ceiling (the user's answer of 26 October 2026: up to $3 for the real run).
if real_ai_run:
    book = load(os.path.join(ROOT, 'real-ai-spend.json')) or {}
    total = (book.get('retiredUsd') or 0) + sum(sum((c.get('usage') or {}).get('costUsd') or 0 for c in jsonl(os.path.join(ROOT, f'{r}-profile', 'aiLedger', '*.jsonl'))) for r in book.get('runs', []))
    gate_line('spend', 'pass' if total <= 3 else 'fail', f'${total:.4f} spent by every real run together, of the $3.00 ceiling')
else:
    gate_line('spend', 'not measured', 'OpenRouter was faked: nothing could be spent.')

# --- V9's gates (V9-S8-GATES), each read per span ----------------------------------------------
print('\n===== V9 gates')
DAY = 86400
whole_days = sorted({d for a, b in spans for d in range(int(a // DAY + 1) * DAY, int(b), DAY) if d + DAY <= b})
found_lines = jsonl(os.path.join(PROFILE, 'discovery', 'discovery-*.jsonl'))
boards = [l for l in found_lines if l.get('kind') == 'boards' and l.get('at', 0) >= run_start]
founds = [l for l in found_lines if l.get('kind') == 'found' and l.get('at', 0) >= run_start]
skips = [l for l in found_lines if l.get('kind') == 'skipped' and l.get('at', 0) >= run_start]
holdings = [l for l in found_lines if l.get('kind') == 'holdings' and l.get('at', 0) >= run_start]


def passes_rule(row):
    """The finding rule (shared/traders/discovery.ts passesRule), as recorded on the day."""
    if not (row.get('pnlAllTime', 0) > 0 and row.get('last30d', 0) > 0 and row.get('accountUsd', 0) >= 50000):
        return False
    if row.get('volume30d') is not None and not row['volume30d'] <= 100 * row['accountUsd']:
        return False
    if row.get('venue') == 'okx' and not (row.get('leadDays') or 0) >= 90:
        return False
    return True


# Discovery: a read of the rankings on each whole UTC day, a venue read, at most ten found a read, each passing the rule.
problems = []
for d in whole_days:
    reads = [b for b in boards if d <= b['at'] < d + DAY]
    if not reads:
        problems.append(f'no read on {clock(d)[:5]}')
    elif not any(any(src.get('ok') for src in b.get('sources', [])) for b in reads):
        problems.append(f'no venue read on {clock(d)[:5]}')
for b in boards:
    if len(b.get('picked') or []) > 10:
        problems.append(f'{len(b["picked"])} found at {clock(b["at"])}')
failing = [f['key'] for f in founds if not passes_rule(f.get('board') or {})]
if failing:
    problems.append(f'{len(failing)} found not passing the rule ({failing[0]})')
if not whole_days and not boards:
    gate_line('discovery', 'not measured', 'No whole UTC day inside a span, and no read of the rankings.')
else:
    gate_line('discovery', 'pass' if not problems else 'fail', f'{len(boards)} read(s) on {len(whole_days)} whole day(s); {len(founds)} found, {len(skips)} set aside' + (f'; {"; ".join(problems[:4])}' if problems else ''))

# Analyses: each found trader analysed or set aside after it was found, once, the analyses at least 30 minutes apart.
analyses = []
problems = []
for f in founds:
    lines = jsonl(os.path.join(PROFILE, 'traders', f['key'], 'analyses-*.jsonl'))
    after = [l for l in lines if l.get('at', 0) >= f['at']]
    if len(after) > 1:
        problems.append(f'{f["key"]} analysed {len(after)} times')
    analyses += [(l['at'], f['key']) for l in after[:1]]
analyses.sort()
close = [(a, b) for a, b in zip(analyses, analyses[1:]) if b[0] - a[0] < 30 * 60]
if close:
    problems.append(f'{len(close)} analyses under 30 minutes after the one before (first {close[0][1][1]} at {clock(close[0][1][0])})')
skipped_keys = {sk['key'] for sk in skips}
waiting = [f['key'] for f in founds if f['key'] not in skipped_keys and not any(k == f['key'] for _, k in analyses)]
if not founds:
    gate_line('analyses', 'not measured', 'No trader was found in the run.')
else:
    gate_line('analyses', 'pass' if not problems else 'fail', f'{len(analyses)} analysed, {len(skipped_keys)} set aside, {len(waiting)} still waiting of {len(founds)} found' + (f'; {"; ".join(problems[:3])}' if problems else ''))

# Holdings: a holdings line on each UTC day whose first two hours a span covers with an analysed found trader before,
# and each day's 'top-traders' calls on file in the record.
problems = []
owed = 0
calls_on_file = [p for p in sources if p.get('source') == 'top-traders']
for d in sorted({int(a // DAY) * DAY for a, b in spans} | {int(a // DAY + 1) * DAY for a, b in spans}):
    if not any(a <= d and d + 7200 <= b for a, b in spans):
        continue
    if not any(at < d + 7200 for at, _ in analyses):
        continue
    owed += 1
    lines = [h for h in holdings if h.get('day') == d]
    if len(lines) != 1:
        problems.append(f'{len(lines)} holdings line(s) on {clock(d)[:5]}')
        continue
    made = [p for p in calls_on_file if d <= p.get('madeAt', 0) < d + 7200]
    if len(made) != lines[0].get('calls', 0):
        problems.append(f'{clock(d)[:5]}: {lines[0].get("calls")} calls said, {len(made)} on file')
if owed == 0:
    gate_line('holdings', 'not measured', 'No UTC day began inside a span with an analysed found trader.')
else:
    gate_line('holdings', 'pass' if not problems else 'fail', f'{len(holdings)} holdings line(s) for {owed} day(s) owed; {len(calls_on_file)} top-traders call(s) on file' + (f'; {"; ".join(problems[:3])}' if problems else ''))

# Feed: every loud hack or exploit notice a first report by its incident (research/v9FeedCheck.ts, the app's own rules).
bundle = os.path.join(os.path.dirname(__file__), '..', 'research', '.v9FeedCheck.mjs')
try:
    subprocess.run(['npx.cmd' if os.name == 'nt' else 'npx', 'esbuild', 'research/v9FeedCheck.ts', '--bundle', '--platform=node', '--format=esm', '--outfile=research/.v9FeedCheck.mjs', '--log-level=error'], cwd=os.path.join(os.path.dirname(__file__), '..'), check=True)
    out = subprocess.run(['node', bundle], cwd=os.path.join(os.path.dirname(__file__), '..'), env={**os.environ, 'PROFILE': PROFILE, 'FROM_SEC': str(int(run_start))}, capture_output=True, text=True, encoding='utf-8', check=True).stdout
    feed = json.loads(out.strip().splitlines()[-1])
    ok = feed['version'] == 'feed-v3' and not feed['notFirst']
    gate_line('feed', 'pass' if ok else 'fail', f'{feed["stories"]} stories read again under {feed["version"]}; {feed["loudHacks"]} loud hack or exploit notice(s) of {feed["loudNews"]} loud news notices; not first reports {len(feed["notFirst"])}' + (f' (first: {feed["notFirst"][0]["title"]} -- {feed["notFirst"][0]["why"]})' if feed['notFirst'] else ''))
except Exception as failure:  # noqa: BLE001 -- a check that could not run says why
    gate_line('feed', 'not measured', f'the feed check could not run: {failure}')

# Summaries: a day summary for each whole day of the run's clock.
summaries = sorted(glob.glob(os.path.join(OUT, 'day-summaries', 'day-*.json')))
run_minutes = int(os.environ.get('RUN_MINUTES_EXPECTED', '10080'))
owed_days = run_minutes // 1440
gate_line('summaries', ('pass' if len(summaries) >= owed_days else 'fail') if ended else 'not measured', f'{len(summaries)} day summaries of the {owed_days} the run\'s clock owes' + ('' if ended else ' -- the run has not ended'))

# AI: nothing reached OpenRouter -- the harness's fake answered every request, and the ledger spent nothing.
fakes = [load(f) or {} for f in sorted(glob.glob(os.path.join(OUT, 'main-fake-*.json')))]
spent = sum((c.get('usage') or {}).get('costUsd') or 0 for c in jsonl(os.path.join(PROFILE, 'aiLedger', '*.jsonl')) if c.get('at', 0) >= run_start)
if real_ai_run:
    gate_line('ai', 'not measured', 'This run asked the real models.')
else:
    gate_line('ai', 'pass' if fakes and spent == 0 else 'fail', f'{len(fakes)} segment fake(s) on file, {sum(len(f.get("asked", [])) for f in fakes)} request(s) answered by it; ${spent:.4f} spent')

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
    # A segment that ended before its fake was read back (one of 0 minutes) leaves {}.
    raw = load(f) or {}
    fake = {'asked': raw.get('asked', []), 'other': raw.get('other', []), 'notices': raw.get('notices', [])}
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
