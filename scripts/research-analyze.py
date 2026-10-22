#!/usr/bin/env python3
"""What a TraderSpider research export holds, and whether it holds up (V7.2-R Stage 2, 20 October 2026).

    python scripts/research-analyze.py <trader-spider-report-....zip | the folder it was unpacked to>
                                       [--csv DIR] [--json FILE]

The app packs the export (Settings > Research record > Export now, and every day at 00:05 UTC): an allowlist of
its records from the last fortnight, the configuration it ran under with every secret field left out, and a
manifest of every file with its size and SHA-256 (electron/services/researchFolderService.ts, shared/research.ts).
This reads it and prints, in order: the manifest checked; any secret field (its file and name, never its value);
the configuration and who asks which model; the AI requests by caller and model, the model that answered against
the model asked, and the cost; the forecasts and their outcomes by horizon (the 80% and 50% ranges held, with 95%
intervals, the moves of 1%, 2% and 5%, the direction called and how it went, every quarter-hour forecast made where
the app ran, every due horizon judged); the trade decisions; the paper trades and the account; the hour's and the
day's reports and their gates; the errors and warnings; the market records. Then the checks.

The intervals are by hour blocks as long as the horizon, as the app's (shared/forecast/uncertainty.ts), with the
same two widenings (overlapping outcomes, few blocks), computed analytically here rather than by the app's seeded
bootstrap, so they can differ from the app's in the last digit.

--csv DIR  writes forecasts.csv and outcomes.csv (a row per forecast and horizon), for a spreadsheet.
--json FILE writes the summary and the checks as JSON.

Exit status 1 where a check failed; 0 where every check passed or warned. Standard library only; it reads the
archive and writes only where --csv or --json says.
"""

import argparse
import bisect
import collections
import csv
import gzip
import hashlib
import json
import math
import os
import re
import sys
import zipfile
from datetime import datetime, timezone

# As shared/research.ts SECRET_FIELDS: matched exactly, case aside, at any depth.
SECRET_FIELDS = ['apiKey', 'apiSecret', 'secretKey', 'secret', 'passphrase', 'apiPassphrase', 'password', 'token',
                 'accessToken', 'refreshToken', 'privateKey', 'apiKeyEnc', 'apiSecretEnc', 'apiPassphraseEnc']
SECRET = {name.lower() for name in SECRET_FIELDS}
# Text that looks like a key wherever it is: an OpenRouter or Anthropic key's prefix, a private key's armour.
KEY_TEXT = [re.compile(rb'sk-or-v1-[0-9a-f]{16,}'), re.compile(rb'sk-ant-[A-Za-z0-9_-]{16,}'),
            re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----')]
# Names a key file has on the profile: none may be in an export.
KEY_FILES = re.compile(r'(^|/)(credentials\.json|aiCredentials\.json|Local State)$|\.bak-')

HORIZON_BARS = {'minutes5': 1, 'minutes15': 3, 'hour1': 12, 'hours4': 48, 'hours24': 288}
HORIZONS = list(HORIZON_BARS)
BAR_SEC = 300
QUARTER_SEC = 900
# A due horizon is judged at the first pass after its due close; allowed this long before it is owed.
SETTLE_GRACE_SEC = 30 * 60
# shared/forecast/uncertainty.ts BLOCK_HOURS, and each horizon's overlap in hours.
BLOCK_HOURS = {'minutes5': 1, 'minutes15': 1, 'hour1': 1, 'hours4': 4, 'hours24': 24}
OVERLAP_HOURS = {'minutes5': 1, 'minutes15': 1, 'hour1': 1, 'hours4': 4, 'hours24': 24}
AUTOMATIC = re.compile(r'^(watch|addition:|bot:)')

CHECKS = []
# The spans the app ran in, from --spans (ISO start/end pairs): the quarter-hour check reads only inside them.
SPANS = []


def check(name, status, detail):
    CHECKS.append({'check': name, 'status': status, 'detail': detail})


def utc(sec):
    if not isinstance(sec, (int, float)):
        return '-'
    return datetime.fromtimestamp(sec, tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')


def share(k, n):
    return '-' if n == 0 else f'{100 * k / n:.1f}%'


def money(value):
    return '-' if value is None else f'${value:.4f}'


# --- the archive or the folder ---------------------------------------------------------------------------------

class Bundle:
    """The export as files by their path in it: a zip, or the folder it was unpacked to."""

    def __init__(self, path):
        self.path = path
        if os.path.isdir(path):
            self.zip = None
            self.files = sorted(os.path.relpath(os.path.join(root, name), path).replace(os.sep, '/')
                                for root, _, names in os.walk(path) for name in names)
        else:
            self.zip = zipfile.ZipFile(path)
            self.files = sorted(info.filename for info in self.zip.infolist() if not info.is_dir())

    def read(self, name):
        if self.zip is not None:
            return self.zip.read(name)  # checks the entry's CRC-32 as it reads
        with open(os.path.join(self.path, name), 'rb') as handle:
            return handle.read()

    def matching(self, pattern):
        rx = re.compile(pattern)
        return [name for name in self.files if rx.search(name)]

    def json(self, name):
        if name not in self.files:
            return None
        try:
            return json.loads(self.read(name).decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            return None

    def lines(self, name):
        """Each JSON line of a file, a gzip'd one unpacked; a line that does not parse is skipped and counted."""
        data = self.read(name)
        if name.endswith('.gz'):
            data = gzip.decompress(data)
        out, bad = [], 0
        for raw in data.decode('utf-8', errors='replace').split('\n'):
            if raw.strip() == '':
                continue
            try:
                out.append(json.loads(raw))
            except ValueError:
                bad += 1
        return out, bad

    def all_lines(self, pattern):
        out, bad = [], 0
        for name in self.matching(pattern):
            rows, skipped = self.lines(name)
            out.extend(rows)
            bad += skipped
        return out, bad


# --- the figures' intervals ------------------------------------------------------------------------------------

def dependence_factor(overlap, block):
    w = max(1, int(overlap))
    b = max(w, int(block))
    long_run, captured = 1.0, 1.0
    for k in range(1, w):
        long_run += 2 * (1 - k / w)
        captured += 2 * (1 - k / w) * (1 - k / b)
    return math.sqrt(long_run / captured)


def small_sample_factor(blocks):
    df = blocks - 1
    if df < 1:
        return float('nan')
    z = 1.959964
    t = z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2) + \
        (3 * z ** 7 + 19 * z ** 5 + 17 * z ** 3 - 15 * z) / (384 * df ** 3)
    return t / z


def block_share(rows, horizon):
    """A share's point and 95% interval from (seconds, 0 or 1) rows, by hour blocks as long as the horizon:
    the blocks' spread about the point, widened for overlapping outcomes and for few blocks."""
    n = len(rows)
    if n == 0:
        return None
    block_sec = BLOCK_HOURS[horizon] * 3600
    blocks = collections.defaultdict(lambda: [0, 0])
    for sec, hit in rows:
        cell = blocks[int(sec // block_sec)]
        cell[0] += hit
        cell[1] += 1
    p = sum(hit for _, hit in rows) / n
    if len(blocks) < 2:
        return {'value': p, 'low': None, 'high': None, 'blocks': len(blocks), 'n': n}
    se = math.sqrt(sum((k - p * m) ** 2 for k, m in blocks.values())) / n
    se *= dependence_factor(OVERLAP_HOURS[horizon], BLOCK_HOURS[horizon]) * small_sample_factor(len(blocks))
    return {'value': p, 'low': max(0.0, p - 1.959964 * se), 'high': min(1.0, p + 1.959964 * se), 'blocks': len(blocks), 'n': n}


def figure(made):
    if made is None:
        return '-'
    if made['low'] is None:
        return f'{100 * made["value"]:.1f}% (one block: no interval)'
    return f'{100 * made["value"]:.1f}% [{100 * made["low"]:.1f}%, {100 * made["high"]:.1f}%]'


# --- the sections ----------------------------------------------------------------------------------------------

def manifest_of(bundle):
    print('===== the manifest')
    manifest = bundle.json('manifest.json')
    if manifest is None:
        print('  no manifest.json: not an export of this app, or a damaged one')
        check('manifest', 'FAIL', 'no manifest.json')
        return None
    app = manifest.get('app', {})
    print(f'  made {manifest.get("madeAt")} ({manifest.get("reason")}), {manifest.get("windowDays")} days back; '
          f'app {app.get("version")}, engine {app.get("engineVersion")}, config {app.get("configVersion")}, '
          f'record {manifest.get("version")}')
    listed = {entry['path']: entry for entry in manifest.get('files', [])}
    bad, absent = [], []
    total = 0
    for path, entry in listed.items():
        if path not in bundle.files:
            absent.append(path)
            continue
        try:
            data = bundle.read(path)
        except (zipfile.BadZipFile, OSError) as failure:
            bad.append(f'{path}: {failure}')
            continue
        total += len(data)
        if len(data) != entry.get('bytes') or hashlib.sha256(data).hexdigest() != entry.get('sha256'):
            bad.append(f'{path}: size or SHA-256 differs from the manifest')
    extra = [name for name in bundle.files if name != 'manifest.json' and name not in listed]
    print(f'  {len(listed)} files, {total / 1e6:.1f} MB unpacked; {len(bad)} differ, {len(absent)} missing, '
          f'{len(extra)} not in the manifest')
    for line in (bad + [f'{path}: missing' for path in absent] + [f'{name}: not in the manifest' for name in extra])[:20]:
        print(f'    {line}')
    for skipped in manifest.get('skipped', []):
        print(f'  left out by the app: {skipped.get("path")}: {skipped.get("why")}')
    folders = collections.Counter(name.split('/')[0] for name in listed)
    print('  by folder: ' + ', '.join(f'{folder} {count}' for folder, count in sorted(folders.items())))
    ok = not bad and not absent and not extra
    check('manifest', 'PASS' if ok else 'FAIL',
          f'{len(listed)} files, every size and SHA-256 as listed' if ok else f'{len(bad)} differ, {len(absent)} missing, {len(extra)} extra')
    return manifest


def secret_paths(value, path=''):
    if isinstance(value, list):
        for index, entry in enumerate(value):
            yield from secret_paths(entry, f'{path}[{index}]')
    elif isinstance(value, dict):
        for key, entry in value.items():
            here = f'{path}.{key}' if path else key
            if key.lower() in SECRET:
                yield here
            yield from secret_paths(entry, here)


def secrets_of(bundle):
    print('\n===== secrets (a file and a field name where one is found; never a value)')
    found = []
    for name in bundle.files:
        if KEY_FILES.search(name):
            found.append(f'{name}: a key file')
            continue
        try:
            data = bundle.read(name)
        except (zipfile.BadZipFile, OSError):
            continue
        if name.endswith('.gz'):
            try:
                data = gzip.decompress(data)
            except OSError:
                continue
        for rx in KEY_TEXT:
            if rx.search(data):
                found.append(f'{name}: text shaped like a key')
                break
        if name.endswith('.csv'):
            header = data.split(b'\n', 1)[0].decode('utf-8', errors='replace').strip().split(',')
            found.extend(f'{name}: column {column}' for column in header if column.lower() in SECRET)
            continue
        if name.endswith('.json'):
            try:
                value = json.loads(data.decode('utf-8'))
            except (ValueError, UnicodeDecodeError):
                continue
            found.extend(f'{name}: {path}' for path in secret_paths(value))
        elif name.endswith('.jsonl') or name.endswith('.jsonl.gz'):
            for number, raw in enumerate(data.decode('utf-8', errors='replace').split('\n'), start=1):
                if raw.strip() == '' or not any(word in raw.lower() for word in SECRET):
                    continue
                try:
                    value = json.loads(raw)
                except ValueError:
                    continue
                found.extend(f'{name} line {number}: {path}' for path in secret_paths(value))
    if found:
        for line in found[:30]:
            print(f'  {line}')
        if len(found) > 30:
            print(f'  ... and {len(found) - 30} more')
    else:
        print(f'  none in {len(bundle.files)} files')
    check('no secret', 'FAIL' if found else 'PASS', f'{len(found)} found' if found else 'no key file, secret field or key-shaped text')


def config_of(bundle):
    print('\n===== the configuration')
    effective = bundle.json('config/effective-config.json') or {}
    ai = bundle.json('config/ai-config.json') or {}
    routing = bundle.json('config/model-routing.json') or {}
    settings = bundle.json('config/settings.json') or {}
    print(f'  engine {effective.get("engineVersion")}, config {effective.get("configVersion")}')
    roles = routing.get('roles') or ai.get('roles')
    default = routing.get('defaultModel') or ai.get('defaultModel')
    print(f'  default model {default}; roles {json.dumps(roles) if roles else "not set (each caller its own model)"}')
    print(f'  enabled models: {", ".join(ai.get("enabledModels", [])) or "-"}')
    watch = ai.get('watch') or {}
    paper = ai.get('watchPaper') or {}
    print(f'  daily cap {money(ai.get("dailyCapUsd"))}; watch {"ON" if watch.get("enabled") else "off"} asking '
          f'{watch.get("models")} (first model gates: {watch.get("firstModelGates")}); its paper trades '
          f'{"ON" if paper.get("enabled") else "off"} on {paper.get("model")}')
    print(f'  additions: {json.dumps(ai.get("additions"))}')
    callers = routing.get('callers') or []
    if callers:
        print('  who asks which model:')
        for caller in callers:
            print(f'    {caller.get("id", "?"):24} {"on " if caller.get("on") else "off"} asks {", ".join(caller.get("asks", [])) or "-":40} '
                  f'follows {caller.get("follows")}, role {caller.get("role")}')
    executors = settings.get('executors') or []
    by_state = collections.Counter(f'{e.get("mode")}/{e.get("status")}' for e in executors)
    account = settings.get('paperAccount') or {}
    print(f'  settings: {len(settings.get("bots") or [])} bots, {len(executors)} executors '
          f'({", ".join(f"{k} {v}" for k, v in sorted(by_state.items())) or "none"}); paper account '
          f'{json.dumps((account.get("balances") or {}).get("USDT"))} USDT of {json.dumps((account.get("initialBalances") or {}).get("USDT"))}')
    return {'ai': ai, 'routing': routing, 'settings': settings, 'roles': roles, 'default': default}


def ai_of(bundle, config, made_sec):
    print('\n===== the AI requests (logs/ai-requests.jsonl: the ledger\'s calls of the window)')
    rows, bad = bundle.all_lines(r'^logs/ai-requests\.jsonl$')
    if not rows:
        print('  none')
        check('answered as asked', 'PASS', 'no AI request in the window')
        return {'requests': 0}
    cost = sum(row.get('costUsd') or 0 for row in rows)
    print(f'  {len(rows)} requests from {utc(min(r["at"] for r in rows))} to {utc(max(r["at"] for r in rows))}, '
          f'{money(cost)}{f"; {bad} lines unreadable" if bad else ""}')
    table = collections.defaultdict(lambda: [0, 0.0, []])
    for row in rows:
        cell = table[(row.get('component'), row.get('asked'))]
        cell[0] += 1
        cell[1] += row.get('costUsd') or 0
        cell[2].append(row.get('latencyMs') or 0)
    print(f'  {"caller":28} {"model asked":42} {"calls":>6} {"cost":>10} {"median s":>9}')
    for (component, asked), (count, spent, latencies) in sorted(table.items(), key=lambda item: -item[1][0]):
        latencies.sort()
        print(f'  {str(component):28} {str(asked):42} {count:6} {money(spent):>10} {latencies[len(latencies) // 2] / 1000:9.1f}')
    by_day = collections.defaultdict(lambda: [0, 0.0])
    for row in rows:
        cell = by_day[utc(row['at'])[:10]]
        cell[0] += 1
        cell[1] += row.get('costUsd') or 0
    print('  by day: ' + '; '.join(f'{day} {count} calls {money(spent)}' for day, (count, spent) in sorted(by_day.items())))
    statuses = collections.Counter(row.get('status') for row in rows)
    print('  status: ' + ', '.join(f'{status} {count}' for status, count in statuses.most_common()))
    other = [row for row in rows if row.get('servedMismatch') == 'other']
    variant = [row for row in rows if row.get('servedMismatch') == 'variant']
    renamed = [row for row in rows if row.get('served') and row.get('served') != row.get('asked') and not row.get('servedMismatch')]
    print(f'  answered by another provider\'s model: {len(other)}; by a variant: {len(variant)}; '
          f'by the model asked under another name (a dated name, the effort dropped): {len(renamed)}')
    for row in (other + variant)[:10]:
        print(f'    {utc(row["at"])} {row.get("component")} asked {row.get("asked")} answered {row.get("served")} ({row.get("servedMismatch")})')
    check('answered as asked', 'FAIL' if other else ('WARN' if variant else 'PASS'),
          f'{len(other)} by another provider\'s model, {len(variant)} by a variant, of {len(rows)}')
    # The last day: a model disabled now, and an automatic caller outside the roles (both may predate a change).
    recent = [row for row in rows if row['at'] >= made_sec - 86_400]
    enabled = set(config['ai'].get('enabledModels') or [])
    disabled = collections.Counter(row.get('asked') for row in recent if enabled and row.get('asked') not in enabled)
    check('only enabled models (last 24 h)', 'WARN' if disabled else 'PASS',
          ('asked a model disabled now: ' + ', '.join(f'{m} {c}' for m, c in disabled.items()) + ' (it may have been disabled since)')
          if disabled else f'{len(recent)} requests, every model enabled at the export')
    roles = config['roles']
    if roles:
        allowed = {config['default'], roles.get('gate'), roles.get('summarize')} - {None}
        outside = collections.Counter(f'{row.get("component")} -> {row.get("asked")}' for row in recent
                                      if AUTOMATIC.match(str(row.get('component'))) and row.get('asked') not in allowed)
        check('automatic callers on the roles (last 24 h)', 'WARN' if outside else 'PASS',
              ('outside the roles: ' + ', '.join(f'{k} {v}' for k, v in outside.items()) + ' (a move may have come after them)')
              if outside else f'every automatic request named {", ".join(sorted(allowed))}')
    return {'requests': len(rows), 'costUsd': cost, 'other': len(other), 'variant': len(variant)}


def forecasts_of(bundle, made_sec, csv_dir, tape):
    print('\n===== the forecasts')
    predictions, bad_p = bundle.all_lines(r'^forecasts/predictions-\d{4}-\d{2}\.jsonl$')
    outcomes, bad_o = bundle.all_lines(r'^forecasts/outcomes-\d{4}-\d{2}\.jsonl$')
    passes, bad_s = bundle.all_lines(r'^forecasts/passes-\d{4}-\d{2}\.jsonl$')
    if not predictions:
        print('  none')
        return {}
    grid = [p for p in predictions if p.get('why') == 'grid']
    pairs = sorted({p.get('pair') for p in predictions})
    print(f'  {len(predictions)} forecasts ({len(grid)} at the quarter-hours, {len(predictions) - len(grid)} made again) of '
          f'{len(pairs)} pairs, {utc(min(p["t"] for p in predictions))} to {utc(max(p["t"] for p in predictions))}; '
          f'{len(outcomes)} outcome lines; {len(passes)} passes'
          f'{f"; unreadable lines {bad_p + bad_o + bad_s}" if bad_p + bad_o + bad_s else ""}')
    runs = collections.Counter(p.get('run') for p in predictions)
    print('  models: ' + ', '.join(f'{run} {count}' for run, count in runs.most_common(4)))

    # Every quarter-hour forecast made where the app ran. A pass line is written only where a quarter-hour was
    # recorded, so a close the app missed leaves none: it ran at a quarter-hour where the tape holds a line within
    # ten minutes of it, or where the quarter-hours either side of it were recorded.
    passed = sorted({line['t'] for line in passes if isinstance(line.get('t'), (int, float))})
    made = {p['t'] for p in grid}
    # Only the tape's book lines say when the app ran: each is the minute it was written. A minute line is a candle
    # Bitcoin closed, and the stream fills an hour or two of them back when it starts (22 October 2026).
    seen = sorted({int(t / 1000 if t > 1e11 else t) for t in (line.get('t') for line in tape if line.get('kind') == 'book') if isinstance(t, (int, float))})

    def near(times, q, within):
        i = bisect.bisect_left(times, q - within)
        return i < len(times) and times[i] <= q + within

    expected = []
    # The spans the app ran in, if the caller names them (--spans): only quarter-hours inside them are expected.
    inside = (lambda q: any(start <= q <= end for start, end in SPANS)) if SPANS else (lambda q: True)
    if passed:
        for q in range(int(passed[0]), int(min(passed[-1] + 4 * 3600, made_sec - BAR_SEC)) + 1, QUARTER_SEC):
            if inside(q) and (q in made or near(passed, q, 0) or near(seen, q, 600) or (near(passed, q - QUARTER_SEC, 0) and near(passed, q + QUARTER_SEC, 0))):
                expected.append(q)
    missed = [q for q in expected if q not in made]
    print(f'  quarter-hours the app ran at: {len(expected)}; forecast at {len(expected) - len(missed)}; missed {len(missed)}'
          + (': ' + ', '.join(utc(q)[5:16] for q in missed[:12]) + (' ...' if len(missed) > 12 else '') if missed else ''))
    check('every quarter-hour forecast made', 'FAIL' if missed else 'PASS',
          f'{len(missed)} of {len(expected)} quarter-hours the app ran at had no forecast' if missed else f'{len(expected)} quarter-hours')

    # Every due horizon judged.
    judged = {(o.get('id'), o.get('h')) for o in outcomes}
    missing_lines = [o for o in outcomes if 'missing' in o]
    owed = collections.Counter()
    due_total = 0
    for p in predictions:
        for h in (p.get('h') or {}):
            if h not in HORIZON_BARS:
                continue
            due = p['t'] + HORIZON_BARS[h] * BAR_SEC
            if due + SETTLE_GRACE_SEC > made_sec:
                continue
            due_total += 1
            if (p.get('id'), h) not in judged:
                owed[h] += 1
    print(f'  due horizons: {due_total}; judged {due_total - sum(owed.values())}; not judged '
          f'{sum(owed.values())} ({", ".join(f"{h} {c}" for h, c in owed.items()) or "none"}); '
          f'could not be read (a missing line): {len(missing_lines)}')
    check('every due horizon judged', 'FAIL' if owed else ('WARN' if missing_lines else 'PASS'),
          f'{sum(owed.values())} of {due_total} not judged' if owed else
          (f'{due_total} judged, {len(missing_lines)} of them could not be read' if missing_lines else f'{due_total} judged'))

    # The outcomes by horizon.
    measured = [o for o in outcomes if 'missing' not in o and isinstance(o.get('move'), (int, float))]
    by_h = collections.defaultdict(list)
    for o in measured:
        by_h[o.get('h')].append(o)
    said = collections.defaultdict(list)
    for p in predictions:
        for h, line in (p.get('h') or {}).items():
            q = line.get('q') or []
            if len(q) == 5:
                said[h].append(q)
    print(f'  {"horizon":10} {"n":>6} {"in 80% range":>26} {"in 50% range":>26} {"said P10..P90 (median)":>24} '
          f'{"|move|>=1%":>11} {">=2%":>7} {">=5%":>7} {"touched +-1%":>13} {"went up":>8}')
    summary = {}
    for h in HORIZONS:
        rows = by_h.get(h, [])
        if not rows:
            continue
        in80 = block_share([(o['t'], 1 if o.get('in80') else 0) for o in rows], h)
        in50 = block_share([(o['t'], 1 if o.get('in50') else 0) for o in rows], h)
        q = sorted(said.get(h, []), key=lambda levels: levels[4] - levels[0])
        middle = q[len(q) // 2] if q else None
        width = '-' if middle is None else f'{middle[0]:+.2f}% .. {middle[4]:+.2f}%'
        moves = [abs(o['move']) for o in rows]
        touched = sum(1 for o in rows if (o.get('best') or 0) >= 1 or (o.get('worst') or 0) <= -1)
        up = sum(1 for o in rows if o.get('up'))
        print(f'  {h:10} {len(rows):6} {figure(in80):>26} {figure(in50):>26} {width:>24} '
              f'{share(sum(1 for m in moves if m >= 1), len(rows)):>11} {share(sum(1 for m in moves if m >= 2), len(rows)):>7} '
              f'{share(sum(1 for m in moves if m >= 5), len(rows)):>7} {share(touched, len(rows)):>13} {share(up, len(rows)):>8}')
        summary[h] = {'n': len(rows), 'in80': in80, 'in50': in50, 'upShare': up / len(rows)}
    print('  the direction called, and how it went:')
    for h in HORIZONS:
        rows = by_h.get(h, [])
        calls = [o for o in rows if o.get('dir') in ('BULLISH', 'BEARISH')]
        if not rows:
            continue
        right = block_share([(o['t'], 1 if (o['dir'] == 'BULLISH') == bool(o.get('up')) else 0) for o in calls], h)
        neutral = [o for o in rows if o.get('dir') == 'NEUTRAL']
        print(f'    {h:10} called {len(calls):6} of {len(rows):6}; right {figure(right)}; NEUTRAL went up '
              f'{share(sum(1 for o in neutral if o.get("up")), len(neutral))}')
        summary.setdefault(h, {})['calls'] = len(calls)
        summary[h]['callsRight'] = right

    # The trade decisions.
    decisions = [p['trade'] for p in predictions if isinstance(p.get('trade'), dict)]
    traded = [d for d in decisions if d.get('ok')]
    reasons = collections.Counter(reason for d in decisions if not d.get('ok') for reason in (d.get('why') or ['(none given)']))
    print(f'  decisions: {len(decisions)}; TRADE {len(traded)} ({", ".join(f"{s} {c}" for s, c in collections.Counter(d.get("side") for d in traded).items()) or "none"}); '
          f'NO TRADE {len(decisions) - len(traded)}')
    for reason, count in reasons.most_common(8):
        print(f'    {count:7}  {reason}')

    if csv_dir:
        os.makedirs(csv_dir, exist_ok=True)
        with open(os.path.join(csv_dir, 'forecasts.csv'), 'w', newline='', encoding='utf-8') as handle:
            out = csv.writer(handle)
            out.writerow(['id', 'pair', 'time', 'why', 'price', 'horizon', 'p10', 'p25', 'p50', 'p75', 'p90', 'pUp', 'direction', 'reliability', 'trade'])
            for p in predictions:
                for h, line in (p.get('h') or {}).items():
                    q = (line.get('q') or []) + [None] * 5
                    trade = p.get('trade') or {}
                    out.writerow([p.get('id'), p.get('pair'), utc(p.get('t')), p.get('why'), p.get('price'), h, *q[:5], line.get('pUp'), line.get('dir'),
                                  line.get('rel'), ('TRADE ' + str(trade.get('side'))) if trade.get('ok') and trade.get('h') == h else ''])
        with open(os.path.join(csv_dir, 'outcomes.csv'), 'w', newline='', encoding='utf-8') as handle:
            out = csv.writer(handle)
            out.writerow(['id', 'pair', 'horizon', 'time', 'due', 'move', 'best', 'worst', 'in80', 'in50', 'up', 'direction', 'pUp', 'missing'])
            for o in outcomes:
                out.writerow([o.get('id'), o.get('pair'), o.get('h'), utc(o.get('t')), utc(o.get('due')), o.get('move'), o.get('best'), o.get('worst'),
                              o.get('in80'), o.get('in50'), o.get('up'), o.get('dir'), o.get('pUp'), o.get('missing', '')])
        print(f'  wrote forecasts.csv and outcomes.csv to {csv_dir}')
    return {'forecasts': len(predictions), 'outcomes': len(outcomes), 'missedQuarterHours': len(missed),
            'unjudged': sum(owed.values()), 'horizons': summary, 'trades': len(traded)}


def trades_of(bundle, config):
    print('\n===== the paper trades')
    events, bad = bundle.all_lines(r'^trades/paper-orders-\d{4}-\d{2}\.jsonl$')
    opened = [e for e in events if e.get('kind') == 'opened']
    closed = [e for e in events if e.get('kind') == 'closed']
    stopped = [e for e in events if e.get('kind') == 'stopped']
    print(f'  the folder\'s trade log: {len(opened)} opened, {len(closed)} closed with a result, {len(stopped)} stopped without one'
          f'{f"; {bad} lines unreadable" if bad else ""}')
    by_origin = collections.defaultdict(lambda: [0, 0, 0.0])
    for e in closed:
        key = f'{e.get("origin")}{":" + e["strategy"] if e.get("strategy") else ""}'
        pnl = (e.get('result') or {}).get('pnlQuote') or 0
        cell = by_origin[key]
        cell[0] += 1
        cell[1] += 1 if pnl > 0 else 0
        cell[2] += pnl
    for key, (count, wins, pnl) in sorted(by_origin.items()):
        print(f'    {key:28} closed {count:4}, won {share(wins, count):>6}, net {pnl:+.4f} USDT')
    # The settings at the export: every paper trade the app still holds, with its result.
    executors = (config['settings'].get('executors') or [])
    marked = []
    for e in executors:
        if e.get('mode') == 'live':
            continue
        for mark_name in ('lab', 'forecast', 'watch', 'newsRule'):
            mark = e.get(mark_name)
            if isinstance(mark, dict):
                marked.append((mark_name if mark_name != 'lab' else f'lab:{mark.get("strategy")}', e, mark))
                break
    held = collections.defaultdict(lambda: [0, 0, 0, 0.0])
    for key, e, mark in marked:
        cell = held[key]
        result = mark.get('result')
        if isinstance(result, dict):
            cell[1] += 1
            cell[2] += 1 if (result.get('pnlQuote') or 0) > 0 else 0
            cell[3] += result.get('pnlQuote') or 0
        elif e.get('status') == 'active':
            cell[0] += 1
    if held:
        print('  the settings at the export (every automatic paper trade still on file):')
        for key, (active, count, wins, pnl) in sorted(held.items()):
            print(f'    {key:28} open {active:3}, closed {count:4}, won {share(wins, count):>6}, net {pnl:+.4f} USDT')
    money_rows, _ = bundle.all_lines(r'^trades/paper-account-\d{4}-\d{2}\.jsonl$')
    if money_rows:
        by_reason = collections.defaultdict(float)
        for row in money_rows:
            by_reason[f'{row.get("reason")} {row.get("asset")}'] += row.get('delta') or 0
        print('  the account\'s money: ' + ', '.join(f'{k} {v:+.4f}' for k, v in sorted(by_reason.items())))
    refusals, _ = bundle.all_lines(r'^trades/refusals/refusals-\d{4}-\d{2}\.jsonl$')
    if refusals:
        print(f'  refused before opening: {len(refusals)}')
        for text, count in collections.Counter(str(r.get('text'))[:110] for r in refusals).most_common(5):
            print(f'    {count:5}  {text}')
    return {'opened': len(opened), 'closed': len(closed), 'net': sum((e.get('result') or {}).get('pnlQuote') or 0 for e in closed)}


def reports_of(bundle):
    print('\n===== the reports')
    hours = sorted(bundle.matching(r'^reports/hour-\d{4}-\d{2}-\d{2}-\d{2}\.json$'))
    days = sorted(bundle.matching(r'^reports/day-\d{4}-\d{2}-\d{2}\.json$'))
    print(f'  {len(hours)} hour reports{f", {hours[0][13:26]} to {hours[-1][13:26]}" if hours else ""}; {len(days)} day reports'
          f'{f", {days[0][12:22]} to {days[-1][12:22]}" if days else ""}')
    failed = collections.Counter()
    passed = 0
    gaps = []
    previous = None
    for name in hours:
        stamp = datetime.strptime(name[13:26], '%Y-%m-%d-%H').replace(tzinfo=timezone.utc).timestamp()
        if previous is not None and stamp - previous > 3600:
            gaps.append(f'{utc(previous + 3600)[:16]} for {int((stamp - previous) / 3600) - 1} h')
        previous = stamp
        session = (bundle.json(name) or {}).get('session') or {}
        if session.get('passed'):
            passed += 1
        for gate in session.get('gates') or []:
            if gate.get('status') == 'failed':
                failed[gate.get('id')] += 1
    if hours:
        print(f'  hours passed every gate: {passed} of {len(hours)}' + (f'; gates failed: {", ".join(f"{g} {c}" for g, c in failed.most_common())}' if failed else ''))
    if gaps:
        print(f'  hours with no report (the app closed, or the window): {"; ".join(gaps[:8])}{" ..." if len(gaps) > 8 else ""}')
    if hours:
        check('hour reports', 'PASS' if passed == len(hours) else 'WARN', f'{passed} of {len(hours)} passed every gate')
    return {'hours': len(hours), 'days': len(days), 'hoursPassed': passed}


def logs_of(bundle, made_sec):
    print('\n===== errors and warnings')
    rows, _ = bundle.all_lines(r'^logs/application(\.\d+)?\.jsonl(\.gz)?$')
    levels = collections.Counter(row.get('level') for row in rows)
    print(f'  {len(rows)} lines: ' + (', '.join(f'{level} {count}' for level, count in levels.most_common()) or 'none'))
    normal = collections.Counter(re.sub(r'\s+', ' ', re.sub(r'\d+(\.\d+)?', '#', str(row.get('text')).split('\n')[0]))[:130] for row in rows if row.get('level') == 'error')
    for text, count in normal.most_common(10):
        print(f'    {count:6}  {text}')
    warns = collections.Counter(re.sub(r'\s+', ' ', re.sub(r'\d+(\.\d+)?', '#', str(row.get('text')).split('\n')[0]))[:130] for row in rows if row.get('level') == 'warn')
    for text, count in warns.most_common(5):
        print(f'    {count:6}  (warning) {text}')
    errors = levels.get('error', 0)
    check('errors', 'PASS' if errors == 0 else 'WARN', f'{errors} errors, {levels.get("warn", 0)} warnings in the folder\'s log')
    return {'errors': errors, 'warnings': levels.get('warn', 0)}


def market_of(bundle, tape):
    print('\n===== the market records')
    kinds = collections.Counter(line.get('kind') for line in tape)
    books = {line.get('pair') for line in tape if line.get('kind') == 'book'}
    print(f'  tape: {len(tape)} lines ({", ".join(f"{k} {v}" for k, v in kinds.items()) or "none"}) over '
          f'{len(bundle.matching(r"^market/tape/"))} days, {len(books)} pairs\' books')
    bars = collections.Counter()
    first, last = None, None
    for name in bundle.matching(r'^market/price-history/[A-Z0-9]+-\d{4}-\d{2}\.jsonl$'):
        rows, _ = bundle.lines(name)
        pair = name.split('/')[-1].rsplit('-', 2)[0]
        bars[pair] += len(rows)
        times = [row[0] for row in rows if isinstance(row, list) and row]
        if times:
            first = min(times) if first is None else min(first, min(times))
            last = max(times) if last is None else max(last, max(times))
    print(f'  bars: {sum(bars.values())} five-minute bars of {len(bars)} pairs, {utc(first)} to {utc(last)}')
    for label, pattern in (('events', r'^market/events/'), ('news', r'^market/news/feed-'), ('news reactions', r'^market/news/reactions-'),
                           ('alerts', r'^logs/alerts/')):
        rows, _ = bundle.all_lines(pattern)
        kinds = collections.Counter(str(row.get('kind') or row.get('type') or row.get('severity') or '-') for row in rows)
        print(f'  {label}: {len(rows)}' + (f' ({", ".join(f"{k} {v}" for k, v in kinds.most_common(6))})' if rows else ''))
    return {'tape': len(tape), 'bars': sum(bars.values()), 'pairs': len(bars)}


def replay_of(bundle):
    """The replay out of sample the app keeps (V7.2-R Stage 5): the newest walk forward that kept its weeks' models,
    replayed with each week's own models and a calibration from the weeks before it, and each strategy's figures."""
    print('\n===== the replay out of sample')
    kept = bundle.json('forecasts/models/replay.json') if 'forecasts/models/replay.json' in bundle.files else None
    if not kept:
        print('  none in the export (no walk forward kept its weeks\' models yet, or the replay has not run)')
        return {'replayed': False}
    summary = kept.get('summary') or {}
    print(f'  {kept.get("runId")}, replayed {utc(kept.get("madeAt"))[:16]} in {round((kept.get("ms") or 0) / 1000)} s: '
          f'{summary.get("closes")} closes, {summary.get("forecasts")} forecasts, {summary.get("outcomes")} outcomes')
    for segment in summary.get('segments') or []:
        print(f'    {segment.get("label")} [{segment.get("sample")}] {utc(segment.get("from"))[:16]} to {utc(segment.get("to"))[:16]}')

    def mean(figure):
        if not figure:
            return '-'
        return f'{figure["value"]:+.3f}% ({figure["low"]:+.3f} to {figure["high"]:+.3f})'

    for cell in summary.get('cells') or []:
        if cell.get('sample') == 'in':
            print(f'  {cell.get("cell"):14} [in sample] {cell.get("orders")} orders, {cell.get("trades")} trades: no P&L is read')
            continue
        win = cell.get('winRate')
        print(f'  {cell.get("cell"):14} {cell.get("orders"):6} orders {cell.get("trades"):6} trades  net a trade {mean(cell.get("net"))}  '
              f'won {"-" if win is None else f"{100 * win:.1f}%"}  held long {mean(cell.get("baseline"))}  -> {cell.get("verdict")}')
    for line in summary.get('assumptions') or []:
        print(f'    assumed: {line}')
    trades, _ = bundle.lines('forecasts/models/replay-trades.jsonl') if 'forecasts/models/replay-trades.jsonl' in bundle.files else ([], None)
    filled = sum(cell.get('trades') or 0 for cell in summary.get('cells') or [] if cell.get('sample') == 'out')
    print(f'  replay-trades.jsonl: {len(trades)} trades (the cells count {filled})')
    check('replay trades whole', 'PASS' if len(trades) == filled else 'WARN', f'{len(trades)} trades on file against {filled} in the summary')
    return {'replayed': True, 'runId': kept.get('runId'), 'cells': {cell.get('cell'): cell.get('verdict') for cell in summary.get('cells') or [] if cell.get('sample') == 'out'}}


def main():
    parser = argparse.ArgumentParser(description='What a TraderSpider research export holds, and whether it holds up.')
    parser.add_argument('export', help='trader-spider-report-....zip, or the folder it was unpacked to')
    parser.add_argument('--csv', help='write forecasts.csv and outcomes.csv here')
    parser.add_argument('--json', help='write the summary and the checks here')
    parser.add_argument('--spans', help='the spans the app ran in, start/end ISO pairs joined by commas (2026-10-22T10:32Z/2026-10-22T11:11Z,...): the quarter-hour check reads only inside them')
    args = parser.parse_args()
    for span in (args.spans or '').split(','):
        if span.strip() == '':
            continue
        start, end = span.split('/')
        SPANS.append((datetime.fromisoformat(start.replace('Z', '+00:00')).timestamp(), datetime.fromisoformat(end.replace('Z', '+00:00')).timestamp()))
    bundle = Bundle(args.export)
    print(f'{args.export}: {len(bundle.files)} files')
    manifest = manifest_of(bundle)
    made_sec = datetime.fromisoformat(manifest['madeAt'].replace('Z', '+00:00')).timestamp() if manifest and manifest.get('madeAt') else datetime.now(timezone.utc).timestamp()
    secrets_of(bundle)
    config = config_of(bundle)
    tape, _ = bundle.all_lines(r'^market/tape/tape-\d{4}-\d{2}-\d{2}\.jsonl$')
    summary = {
        'export': os.path.basename(args.export),
        'madeAt': manifest.get('madeAt') if manifest else None,
        'app': manifest.get('app') if manifest else None,
        'ai': ai_of(bundle, config, made_sec),
        'forecasts': forecasts_of(bundle, made_sec, args.csv, tape),
        'trades': trades_of(bundle, config),
        'reports': reports_of(bundle),
        'logs': logs_of(bundle, made_sec),
        'market': market_of(bundle, tape),
        'replay': replay_of(bundle),
    }
    print('\n===== the checks')
    for entry in CHECKS:
        print(f'  {entry["status"]:5} {entry["check"]:44} {entry["detail"]}')
    summary['checks'] = CHECKS
    if args.json:
        with open(args.json, 'w', encoding='utf-8') as handle:
            json.dump(summary, handle, indent=2, default=str)
        print(f'\nwrote {args.json}')
    return 1 if any(entry['status'] == 'FAIL' for entry in CHECKS) else 0


if __name__ == '__main__':
    sys.exit(main())
