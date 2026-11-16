#!/usr/bin/env python3
"""Write/update an agent-monitor task card (one JSON file per task) from any script or agent.
  card.py <progressDir> <task-id> start  --title "Plain name" --summary "one line" --account "W1 Codex" --steps "Plan:10,Build:30,Test:15"
  card.py <progressDir> <task-id> step   <n|title> active|done        (sets startedAt when a step becomes active)
  card.py <progressDir> <task-id> metric "Files processed" 120 [--total 500] [--bad]
  card.py <progressDir> <task-id> note   "current activity"
  card.py <progressDir> <task-id> queue  --title … --account … --waiting "starts when X"   (shows under UP NEXT)
  card.py <progressDir> <task-id> done
Continuation runs keep existing steps and metrics (never restart a card from zero)."""
import argparse, json, os, sys, time
p = argparse.ArgumentParser(); p.add_argument('dir'); p.add_argument('task'); p.add_argument('cmd'); p.add_argument('args', nargs='*')
for o in ('--title', '--summary', '--account', '--steps', '--total', '--waiting', '--tags'): p.add_argument(o)
p.add_argument('--bad', action='store_true')
a = p.parse_args(); os.makedirs(a.dir, exist_ok=True); path = os.path.join(a.dir, a.task + '.json'); now = int(time.time())
try:
    with open(path, encoding='utf-8-sig') as fh: c = json.load(fh)
except Exception: c = {}
c.setdefault('source', 'interactive'); c.setdefault('steps', []); c.setdefault('metrics', [])
if a.title: c['title'] = a.title
if a.summary: c['summary'] = a.summary
if a.account: c['account'] = a.account
if a.tags: c['tags'] = a.tags.split(',')
if a.cmd == 'start':
    c.update(active=True, status='in-progress'); c.setdefault('startedAt', now)
    for s in (a.steps or '').split(','):
        if s and not any(x['title'] == s.split(':')[0] for x in c['steps']):
            t, _, eta = s.partition(':'); c['steps'].append({'title': t, 'status': 'pending', 'etaMin': int(eta or 15)})
elif a.cmd == 'step':
    key, state = a.args[0], a.args[1]
    st = c['steps'][int(key)] if key.isdigit() else next(x for x in c['steps'] if x['title'] == key)
    st['status'] = state
    if state == 'active': st['startedAt'] = now
elif a.cmd == 'metric':
    m = next((x for x in c['metrics'] if x['label'] == a.args[0]), None) or {'label': a.args[0]}
    if m not in c['metrics']: c['metrics'].append(m)
    m['done'] = float(a.args[1])
    if a.total: m['total'] = float(a.total)
    if a.bad: m['kind'] = 'bad'
elif a.cmd == 'note': c['note'] = ' '.join(a.args)
elif a.cmd == 'queue': c.update(active=False, status='queued', waitingFor=a.waiting or '')
elif a.cmd == 'done':
    c.update(active=False, status='done')
    for s in c['steps']: s['status'] = 'done'
else: sys.exit('unknown command ' + a.cmd)
tmp = path + '.tmp'
with open(tmp, 'w', encoding='utf-8') as fh: json.dump(c, fh, indent=1)
os.replace(tmp, path)  # atomic on macOS and Windows
