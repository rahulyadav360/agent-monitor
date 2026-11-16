#!/usr/bin/env python3
"""agent-monitor: live status of AI-agent / background work as JSON for the floating panel.
Local files only (plus optional localhost health checks): no network, no AI, no tokens.
All project-specific settings come from a JSON config (see README.md and examples/):
  --config <path>  or  $AGENT_MONITOR_CONFIG  or  ~/.config/agent-monitor/config.json"""
import glob, json, os, re, subprocess, tempfile, time, urllib.request

try:  # cross-platform process list (required on Windows; optional on macOS, where `ps` is the fallback)
    import psutil
except ImportError:
    psutil = None

WINDOWS = os.name == "nt"
TMP = tempfile.gettempdir()  # /tmp on macOS/Linux, %TEMP% on Windows
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)  # no console flash for child processes on Windows

# Every Claude session has its own scratchpad; runner logs and background-agent transcripts can be in any of them.
import sys as _sys


def _load_config():
    path = None
    if "--config" in _sys.argv:
        path = _sys.argv[_sys.argv.index("--config") + 1]
    path = path or os.environ.get("AGENT_MONITOR_CONFIG") or os.path.expanduser("~/.config/agent-monitor/config.json")
    try:
        with open(os.path.expanduser(path), encoding="utf-8-sig") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        cfg = {}
    cfg["_dir"] = os.path.dirname(os.path.abspath(os.path.expanduser(path)))
    return cfg


CFG = _load_config()
def X(p):
    """Config path -> absolute path: ~ and environment variables (%TEMP%, %USERPROFILE%, $HOME) expanded, relative to the config's folder."""
    p = os.path.expandvars(os.path.expanduser(p or ""))
    return os.path.join(CFG["_dir"], p) if p and not os.path.isabs(p) else p
LOG_DIR_GLOBS = [X(g) for g in CFG.get("runnerLogDirGlobs", [])]          # folders holding "<task>.log" runner logs
CLAUDE_TASKS_GLOBS = [X(g) for g in CFG.get("claudeTaskOutputGlobs", [])]  # Claude Code background agent transcripts


def log_files():
    return [f for g in LOG_DIR_GLOBS for f in glob.glob(os.path.join(g, "*.log"))]


def find_log(name):
    hits = [f for f in log_files() if os.path.basename(f) == name + ".log"]
    return max(hits, key=os.path.getmtime) if hits else ""
REPO = X(CFG.get("repo", ""))                                   # git repo whose changes / task branches are shown ("" = none)
WORKTREES = X(CFG.get("worktreesDir", os.path.join(os.path.dirname(REPO), os.path.basename(REPO) + "-worktrees") if REPO else ""))
PROGRESS = X(CFG.get("progressDir", os.path.join(TMP, "agent-progress")))   # one JSON card per task (README: card format)
# Codex accounts: {"label": "Codex-A (worker)", "home": "~/.codex", "runnerAlias": "rahul", "short": "Codex-A"}
CODEX = CFG.get("codexAccounts", [])
# Auto-discovery (default on Windows): show running Claude Code sessions, Codex jobs and usage with no task cards and
# almost no config. Anything configured explicitly still wins.
AUTO = bool(CFG.get("autoDiscover", WINDOWS))
CLAUDE_HOME = X(CFG.get("claudeHome", os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude"))
if AUTO:
    if not CODEX and os.path.isdir(os.path.expanduser("~/.codex")):
        CODEX = [{"label": "Codex", "home": "~/.codex", "runnerAlias": "codex", "short": "Codex"}]
    if "claudeAccounts" not in CFG:
        CFG["claudeAccounts"] = [{"label": "Claude", "statusFile": os.path.join(TMP, "agent-monitor-claude-status.json")}]
    if "workers" not in CFG:
        CFG["workers"] = [["Claude", "W0"], ["Codex", "W1"]]
    if "claudeTaskOutputGlobs" not in CFG:
        CLAUDE_TASKS_GLOBS = [os.path.join(TMP, "claude", "*", "*", "tasks", "*.output")]
HOMES = {a["label"]: X(a["home"]) for a in CODEX}
NOW = time.time()
PHASES = ["Explore", "Build", "Verify", "Handoff"]


def sh(cmd):
    try:
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=3, creationflags=NO_WINDOW).stdout
    except Exception:
        return ""


def git(*args):
    """git in the configured repo, without a shell (same on macOS and Windows). Never takes locks."""
    if not REPO:
        return ""
    try:
        return subprocess.run(["git", "--no-optional-locks", "-C", REPO, *args], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=3, creationflags=NO_WINDOW).stdout or ""
    except Exception:
        return ""


def _etime(s):
    """ps etime '[[dd-]hh:]mm:ss' -> seconds."""
    try:
        parts = [int(x) for x in re.split(r"[-:]", s)]
    except ValueError:
        return 0
    return sum(p * mu for p, mu in zip(reversed(parts), [1, 60, 3600, 86400]))


# A running `codex exec …`: plain `codex exec` on macOS; on Windows also `codex.js exec`, `codex.exe exec`, `codex-x86_64-pc-windows-msvc.exe exec`.
CODEX_EXEC = CFG.get("codexExecPattern", r"codex[^/\s\"']*[\"']?\s+exec\b")
# A headless Claude worker: `claude -p …` (claude.exe / claude.cmd / node …/claude-code/cli.js on Windows).
CLAUDE_P = CFG.get("headlessClaudePattern", r"claude(?:\.exe|\.cmd|-code/cli\.js)?[\"']?\s+(?:-p|--print)\b")


_PROCS = {"t": -1, "v": []}
# Reading a command line is slow on Windows (~2 s for every process), so only likely agent processes are read:
# the process name must match this (codex.exe, codex-x86_64-….exe, claude.exe, node.exe, bun.exe, …).
AGENT_PROC_NAMES = re.compile(CFG.get("agentProcessNames", r"codex|claude|node|bun|deno|python|pwsh|powershell|bash|sh\b|zsh"), re.I)


def _proc_table():
    """All candidate agent processes with their command lines, read once per tick (psutil)."""
    if _PROCS["t"] == NOW:
        return _PROCS["v"]
    me, out = os.getpid(), []
    for p in psutil.process_iter(["pid", "name"]):
        try:
            if p.info["pid"] == me or not AGENT_PROC_NAMES.search(p.info.get("name") or ""):
                continue
            cl = p.cmdline()
            if not cl:
                continue
            out.append({"pid": p.info["pid"], "secs": max(0, int(NOW - p.create_time())), "cmd": " ".join(cl).replace("\\", "/"),
                        "name": (p.info.get("name") or "").lower(), "env": (lambda p=p: p.environ()), "cwd": (lambda p=p: p.cwd())})
        except (psutil.Error, OSError):
            continue
    _PROCS["t"], _PROCS["v"] = NOW, out
    return out


def procs(pattern):
    """Processes whose command line matches `pattern`: [{"pid", "secs" (running time), "cmd", "env"()}].
    Command lines use forward slashes on every OS, so the config's task patterns work unchanged on Windows."""
    rx, out = re.compile(pattern), []
    if psutil:
        for p in _proc_table():
            if rx.search(p["cmd"]):
                out.append(p)
        return out
    for line in sh("ps -axww -o pid=,etime=,command=").splitlines():  # macOS fallback without psutil
        f = line.split(None, 2)
        if len(f) < 3 or not f[0].isdigit() or not rx.search(f[2]):
            continue
        pid = f[0]
        out.append({"pid": int(pid), "secs": _etime(f[1]), "cmd": f[2],
                    "env": (lambda pid=pid: dict(re.findall(r"(?:^|\s)(\w+)=(\S+)", sh(f"ps eww -o command= -p {pid}"))))})
    return out


def tail(path, n=4000):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - n))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def _titles():
    try:
        with open(X(CFG.get("titlesFile", "titles.json")), encoding="utf-8-sig") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


TITLES = _titles()


def pretty(name):
    """Task number and plain-English title: the configured titles file first, then the file slug."""
    m = re.match(r"(?:TASK-)?(\d+)-(.*)", name)
    if not m:
        return ("", name)
    t = TITLES.get(m.group(1), {}).get("title")
    return (m.group(1), t or m.group(2).replace("-", " ").capitalize())


def summary_for(num):
    return TITLES.get(num, {}).get("summary", "")


def ts(s):
    try:
        return time.mktime(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except Exception:
        return None


def phase_of(cmd):
    c = cmd.lower()
    if re.search(r"handoff|result-0\d\d|result\.md", c) and re.search(r"cat >|write|tee|>>|edit |out-file|set-content", c):
        return 3
    if re.search(r"jest|vitest|tsc\b|next build|playwright|smoke-crawl|check\.js|npm test|pnpm test|verify|audit|sha256|get-filehash", c):
        return 2
    if re.search(r"^edit |apply patch|\bcat >|cat <<|> [\w./-]+\.(ts|tsx|js|mjs|md|json|ps1|py|css)|set-content|out-file|copy-item|move-item|mkdir", c):
        return 1
    return 0


def clean_cmd(raw):
    if "write_stdin" in raw:
        return None  # polling a running process, not a new command
    m = re.search(r'cmd:"((?:[^"\\]|\\.)*)"', raw)
    if m:
        c = m.group(1).encode().decode("unicode_escape", "ignore")
    elif "apply_patch" in raw or "*** Begin Patch" in raw:
        files = re.findall(r"\*\*\* (?:Add|Update|Delete) File: ([^\\\n]+)", raw)
        c = "edit " + ", ".join(os.path.basename(f) for f in files[:3]) if files else "apply patch"
    else:
        c = raw
    c = re.sub(r"\s+", " ", c).strip()
    c = re.sub(r"^cd \S+ (&&|;) ", "", c)
    return c[:140]


_HEAD = {}  # (path, task name) -> bool; the brief name appears in the first prompt, so one check per file is enough


def session_for(name):
    best = None
    for home in HOMES.values():
        for f in glob.glob(f"{home}/sessions/*/*/*/*.jsonl"):
            try:
                mt = os.path.getmtime(f)
                if NOW - mt > 6 * 3600:
                    continue
                key = (f, name)
                if key not in _HEAD:
                    with open(f, "rb") as fh:
                        _HEAD[key] = name.encode() in fh.read(400_000)
                if _HEAD[key] and (best is None or mt > os.path.getmtime(best)):
                    best = f
            except OSError:
                pass
    return best


_SESS = {}  # path -> {"off": bytes read, "calls": [...], "outputs": {...}, "tokens": int, "last": str}


def session_details(f):
    d = {"commands": 0, "tokens": 0, "last": "", "recent": [], "phase": 0, "edits": 0, "lastActive": 0}
    if not f:
        return d
    st = _SESS.setdefault(f, {"off": 0, "calls": [], "outputs": {}, "tokens": 0, "last": ""})
    calls, outputs = st["calls"], st["outputs"]
    d["tokens"], d["last"] = st["tokens"], st["last"]
    try:
        with open(f, "rb") as fb:
            fb.seek(st["off"])
            chunk = fb.read()
        end = chunk.rfind(b"\n") + 1  # only complete lines; the rest is read next tick
        st["off"] += end
        for line in chunk[:end].decode("utf-8", "replace").splitlines():
            if True:
                if '"payload":{"type":"custom_tool_call"' in line or '"payload":{"type":"function_call"' in line:
                    try:
                        j = json.loads(line)
                    except Exception:
                        continue
                    p = j.get("payload", {})
                    if p.get("name") == "update_plan":  # Codex's own step list: real subtasks with status
                        try:
                            plan = json.loads(p.get("arguments") or "{}").get("plan") or []
                            m = {"completed": "done", "in_progress": "active"}
                            st["plan"] = [{"title": str(x.get("step", ""))[:70], "status": m.get(x.get("status"), "pending")} for x in plan if isinstance(x, dict)][:10]
                        except (ValueError, AttributeError):
                            pass
                        continue
                    c = clean_cmd(p.get("input") or p.get("arguments") or "")
                    if c is None:
                        continue
                    calls.append({"id": p.get("call_id"), "cmd": c, "t": ts(j.get("timestamp", ""))})
                    st["edits"] = st.get("edits", 0) + (c.startswith("edit ") or c == "apply patch")
                    st["phase"] = max(st.get("phase", 0), phase_of(c))
                elif '"payload":{"type":"custom_tool_call_output"' in line or '"payload":{"type":"function_call_output"' in line:
                    cid = re.search(r'"call_id":"([^"]+)"', line)
                    wall = re.search(r"Wall time ([\d.]+) seconds", line)
                    code = re.search(r"(?:exited with code|Exit code:?) (-?\d+)", line)
                    if cid:
                        outputs[cid.group(1)] = (float(wall.group(1)) if wall else None, int(code.group(1)) if code else None)
                elif '"total_token_usage"' in line:
                    m = re.search(r'"total_token_usage":\{[^}]*"total_tokens":(\d+)', line)
                    if m:
                        d["tokens"] = int(m.group(1))
                if '"payload":{"type":"agent_message"' in line or ('"type":"message"' in line and '"role":"assistant"' in line):
                    m = re.search(r'"(?:message|text)":"((?:[^"\\]|\\.){10,240})', line)
                    if m:
                        d["last"] = m.group(1).encode().decode("unicode_escape", "ignore")
        st["tokens"], st["last"] = d["tokens"], d["last"]
        if len(calls) > 400:  # keep memory bounded; counts stay right via the offset
            st.setdefault("dropped", 0)
            st["dropped"] += len(calls) - 400
            del calls[:-400]
            keep = {c["id"] for c in calls}
            for k in [k for k in outputs if k not in keep]:
                del outputs[k]
    except OSError:
        return d
    d["commands"] = len(calls) + st.get("dropped", 0)
    d["edits"], d["phase"], d["plan"] = st.get("edits", 0), st.get("phase", 0), st.get("plan", [])
    stamps = [c["t"] for c in calls if c["t"]]
    d["lastActive"] = int(NOW - max(stamps)) if stamps else 0
    for c in calls[-7:][::-1]:
        wall, code = outputs.get(c["id"], (None, None))
        state = "running" if c["id"] not in outputs else ("fail" if code not in (None, 0) else "ok")
        dur = wall if wall is not None else (NOW - c["t"] if state == "running" and c["t"] else None)
        d["recent"].append({"cmd": c["cmd"], "state": state, "secs": round(dur, 1) if dur is not None else -1})
    return d


_RATE = {}  # (task, metric label) -> [(t, done)] samples, for speed and time-left


def metrics_of(task, raw):
    """Normalise card metrics and add speed/time left from successive readings (kept in memory in --serve mode)."""
    out = []
    if isinstance(raw, dict):  # {"Files": [3, 10]} or {"Files": 3} forms
        raw = [{"label": k, "done": (v[0] if isinstance(v, (list, tuple)) else v), "total": (v[1] if isinstance(v, (list, tuple)) and len(v) > 1 else None)} for k, v in raw.items()]
    for m in (raw or [])[:6]:
        try:
            label, done = str(m.get("label", ""))[:40], float(m.get("done"))
        except (TypeError, ValueError, AttributeError):
            continue
        total = m.get("total")
        total = float(total) if isinstance(total, (int, float)) and total > 0 else None
        item = {"label": label, "done": done, "total": total, "kind": str(m.get("kind", ""))[:10], "rate": "", "left": ""}
        hist = _RATE.setdefault((task, label), [])
        if not hist or hist[-1][1] != done:
            hist.append((NOW, done))
        del hist[:-30]
        old = [h for h in hist if NOW - h[0] <= 1800]
        if len(old) >= 2 and old[-1][1] > old[0][1] and old[-1][0] > old[0][0]:
            per_min = (old[-1][1] - old[0][1]) / ((old[-1][0] - old[0][0]) / 60)
            item["rate"] = f"≈{per_min:.0f}/min" if per_min >= 1 else f"≈{per_min * 60:.0f}/h"
            if total and done < total and item["kind"] != "bad":
                mins = (total - done) / per_min
                item["left"] = f"~{mins:.0f} min left" if mins < 120 else f"~{mins / 60:.1f} h left"
        out.append(item)
    return out


_AUTO = {}  # task -> (time, metrics) cache for git-derived metrics


def auto_metrics(name):
    """Cheap facts for cards that report no metrics: commits on the task branch, files changed, handoff written."""
    hit = _AUTO.get(name)
    if hit and NOW - hit[0] < 30:
        return hit[1]
    m = []
    branch = f"task/{name}"
    n = git("rev-list", "--count", f"main..{branch}").strip()
    if n.isdigit():
        m.append({"label": "Commits on task branch", "done": float(n), "total": None, "kind": "", "rate": "", "left": ""})
        files = git("diff", "--name-only", f"main...{branch}").split()
        m.append({"label": "Files changed", "done": float(len(files)), "total": None, "kind": "", "rate": "", "left": ""})
    wt = os.path.join(WORKTREES, name) if WORKTREES else ""
    if wt and os.path.isdir(wt):
        num = name.split("-")[0]
        has = bool(glob.glob(os.path.join(wt, "docs", "tasks", f"{num}*handoff*.md")))
        m.append({"label": "Handoff written", "done": 1.0 if has else 0.0, "total": 1.0, "kind": "", "rate": "", "left": ""})
    _AUTO[name] = (NOW, m)
    return m


def with_eta(steps, note):
    """Adds per-step and whole-task ETAs from each step's etaMin (estimated minutes) and
    startedAt (unix seconds when the step became active). Steps without etaMin show 'ETA ?'."""
    out, left, known = [], 0.0, True
    for s in steps[:10]:
        # accept "title", "name" or "label" — agents don't all use the same key
        title, status = str(s.get("title") or s.get("name") or s.get("label") or "")[:70], s.get("status", "pending")
        eta = s.get("etaMin")
        if status != "done":
            if isinstance(eta, (int, float)):
                rem = float(eta)
                if status == "active" and s.get("startedAt"):
                    rem = eta - (NOW - float(s["startedAt"])) / 60
                if rem < 0:
                    title += f" · overrun {-rem:.0f}m"
                    rem = 1
                else:
                    title += f" · ~{max(1, round(rem))}m" + (" left" if status == "active" else "")
                left += max(1, rem)
            else:
                known = False
                title += " · ETA ?"
        out.append({"title": title, "status": status})
    if out and any(s["status"] != "done" for s in out):
        finish = time.strftime("%H:%M", time.localtime(NOW + left * 60))
        prefix = f"ETA ~{max(1, round(left))} min (≈{finish})" if known else (f"ETA ≥{round(left)} min" if left else "ETA ?")
        note = f"{prefix} · {note}"
    return out, note


def codex_short(alias):
    """Display name for a Codex runner alias (from the runner log or CODEX_HOME)."""
    for a in CODEX:
        if alias and alias.lower() in (str(a.get("runnerAlias", "")).lower(), a["label"].lower()):
            return a.get("short", a["label"])
    return CODEX[0].get("short", CODEX[0]["label"]) if CODEX else "Codex"


def running():
    out = []
    for pr in procs(CODEX_EXEC):
        line = pr["cmd"]
        m = re.search(CFG.get("codexTaskPattern", r"complete (\S+\.md)"), line)
        if m:
            name = os.path.basename(m.group(1))[:-3]
        elif AUTO:  # no configured pattern matched: name the job after the brief it was given, else its folder
            m2 = re.findall(r"([^\s\"'/:]+)\.md\b", line)
            name = m2[-1] if m2 else "codex-" + os.path.basename(_cwd(pr) or "job").replace(" ", "-")
        else:
            continue
        if any(t["key"] == name for t in out):
            continue
        log = find_log(name)
        txt = tail(log, 200000)
        try:
            with open(log, encoding="utf-8", errors="replace") as fh:
                accts = re.findall(r"codex account '(\w+)'", fh.read())  # whole log: switches can be far from the end
        except OSError:
            accts = []
        # The process environment is authoritative for the account (CODEX_HOME), logs are a fallback.
        try:
            home = (pr["env"]() or {}).get("CODEX_HOME", "")
        except Exception:
            home = ""
        if home:
            hp = os.path.normcase(os.path.realpath(os.path.expanduser(home.rstrip("/\\"))))
            for a in CODEX:
                if os.path.normcase(os.path.realpath(X(a["home"]))) == hp:
                    accts.append(a.get("runnerAlias", a["label"]))
        num, title = pretty(name)
        secs = pr["secs"]
        sess = session_for(name)
        sd = session_details(sess)
        if AUTO and (not sess or os.path.getmtime(sess) < NOW - secs - 60):  # `--ephemeral` jobs keep no session: read their output log
            sess = ""
            xl = _redirect_log(name) or find_log(name)
            sd = exec_log_details(xl) if xl else {"commands": 0, "tokens": 0, "last": "", "recent": [], "phase": 0, "edits": 0, "lastActive": 0}
        task = {"summary": summary_for(num), "key": name, "id": num, "title": title, "account": codex_short(accts[-1] if accts else ""),
                "elapsed": secs, "steps": [], "note": "", "commands": sd["commands"], "tokens": sd["tokens"], "edits": sd["edits"],
                "recent": sd["recent"], "lastActive": sd["lastActive"], "estimated": True,
                "failovers": len(re.findall(r"hit its limit", txt))}
        try:
            with open(os.path.join(PROGRESS, name + ".json"), encoding="utf-8-sig") as fh:
                p = json.load(fh)
            task["steps"], task["note"] = with_eta(p.get("steps", []), str(p.get("note", ""))[:200])
            task["estimated"] = False
            task["title"] = str(p.get("title") or task["title"])[:80]
            task["metrics"] = metrics_of(name, p.get("metrics"))
            task["tags"] = [str(t)[:20] for t in (p.get("tags") or [])][:6]
            task["summary"] = str(p.get("summary") or summary_for(num))[:160]
        except Exception:
            ph = sd["phase"]
            task["steps"] = [{"title": n, "status": "done" if i < ph else "active" if i == ph else "pending"} for i, n in enumerate(PHASES)]
            if sd.get("plan"):  # Codex's own plan beats the guessed phases
                task["steps"], task["estimated"], task["stepsFrom"] = sd["plan"], False, "todos"
        if not task.get("metrics"):
            task["metrics"] = auto_metrics(name)
        if not task["note"]:
            task["note"] = sd["last"][:200]
        if AUTO and not num:  # auto-found job: name it after its folder and brief, show what it was asked to do
            proj = os.path.basename(_cwd(pr).rstrip("/\\")) or "Codex"
            task["title"] = f"{proj} · {name.replace('_', ' ')}"[:80]
            ask = _codex_prompt(line, _cwd(pr))
            task["summary"] = (f"Asked: {ask}" if ask else f"Codex job in {proj}")[:160]
            task["tags"] = [proj[:20]]
            task["_session"] = sess
            if not task["note"]:
                task["note"] = "Codex is working (no commands logged yet)"
        out.append(task)
    if AUTO:
        out += claude_sessions(out)
        out += codex_live_sessions(out)
    # Headless Claude workers (`claude -p "... docs/tasks/NNN-x.md ..."`): shown even before they write a card.
    for pr in ([] if AUTO else procs(CLAUDE_P)):  # in auto mode they appear as Claude sessions instead
        m = re.search(CFG.get("headlessTaskPattern", r"docs/tasks/(\d{3}-[\w-]+)\.md"), pr["cmd"])
        if not m:
            continue
        name = m.group(1)
        if any(t["key"] == name for t in out):
            continue
        card = os.path.join(PROGRESS, name + ".json")
        if os.path.exists(card):
            continue  # its interactive card is listed below
        num, title = pretty(name)
        out.append({"key": name, "id": num, "title": title, "summary": summary_for(num), "account": CFG.get("headlessClaudeLabel", "Claude (headless)"),
                    "elapsed": 0, "steps": [], "note": "Headless Claude worker running (no progress card yet)", "commands": 0, "tokens": 0,
                    "edits": 0, "recent": [], "lastActive": 0, "estimated": True, "failovers": 0})
    # Interactive Codex sessions do not run under `codex exec`.
    for path in glob.glob(os.path.join(PROGRESS, '*.json')):
        try:
            with open(path, encoding="utf-8-sig") as fh:
                p = json.load(fh)
            if p.get('source') != 'interactive' or not p.get('active'):
                continue
            name = os.path.basename(path)[:-5]
            if any(t['key'] == name for t in out):
                continue
            num, title = pretty(name)
            steps, note = with_eta(p.get('steps', []), str(p.get('note', ''))[:200])
            idle = int(NOW - os.path.getmtime(path))
            if idle > 1800:
                note = f"STALE: no update for {idle // 60} min · {note}"
            out.append({'key': name, 'id': num, 'title': str(p.get('title') or title)[:80], 'summary': str(p.get('summary') or summary_for(num))[:160],
                        'account': p.get('account', 'agent'),
                        'elapsed': max(0, int(NOW - p.get('startedAt', NOW))),
                        'steps': steps, 'note': note,
                        'metrics': metrics_of(name, p.get('metrics')) or auto_metrics(name),
                        'tags': [str(t)[:20] for t in (p.get('tags') or [])][:6],
                        'commands': 0, 'tokens': 0, 'edits': 0, 'recent': [],
                        'lastActive': max(0, int(NOW - os.path.getmtime(path))),
                        'estimated': False, 'failovers': 0})
        except (OSError, ValueError, TypeError):
            continue
    return out


# ---------------------------------------------------------------- auto-discovery: Claude Code sessions and live Codex sessions


def _cwd(pr):
    try:
        return pr["cwd"]() if "cwd" in pr else ""
    except Exception:
        return ""


def _codex_prompt(line, cwd):
    """The task text given to `codex exec`: what follows the working-folder option, else the last part of the command."""
    c = cwd.replace("\\", "/").rstrip("/")
    if c and f"-C {c} " in line:
        return line.split(f"-C {c} ", 1)[1].strip()
    m = re.search(r"\bexec\b.*?\s([A-Z][^-].{10,})$", line)
    return m.group(1).strip() if m else ""


def _redirect_log(name):
    """Where a `codex exec` job's output is redirected (`… > ~/.codex-tools/run3.log`), read from its parent shell's command line."""
    for p in _proc_table() if psutil else []:
        if name not in p["cmd"]:
            continue
        for m in re.finditer(r"(?<![0-9&])>>?\|?\s*['\"]?([^\s'\";|&<>]+)", p["cmd"]):
            f = m.group(1)
            if f.startswith("/dev/") or not re.search(r"\.(log|txt|out)$", f, re.I):
                continue
            f = re.sub(r"^/([a-zA-Z])/", r"\1:/", f)  # Git Bash /c/Users/... -> C:/Users/...
            f = os.path.expandvars(os.path.expanduser(f))
            if not os.path.isabs(f):
                f = os.path.join(_cwd(p) or "", f)
            if os.path.isfile(f):
                return f
    return ""


_XL = {}  # codex exec text log -> parsed state


def exec_log_details(f):
    """Commands, results, Codex's latest message and tokens from a `codex exec` text log (its stdout/stderr)."""
    st = _XL.setdefault(f, {"off": 0, "calls": [], "last": "", "tokens": 0, "phase": 0, "edits": 0, "mode": "", "n": 0, "buf": []})
    try:
        with open(f, "rb") as fh:
            fh.seek(st["off"])
            chunk = fh.read(32 * 1024 * 1024)
    except OSError:
        chunk = b""
    end = chunk.rfind(b"\n") + 1
    st["off"] += end
    t = os.path.getmtime(f) if os.path.exists(f) else NOW
    for raw in chunk[:end].decode("utf-8", "replace").splitlines():
        s = raw.rstrip()
        head = s.strip()
        if s in ("exec", "codex", "user", "thinking", "tokens used", "file update", "apply_patch"):
            if st["mode"] == "codex" and st["buf"]:
                st["last"] = re.sub(r"\s+", " ", " ".join(st["buf"])).strip()[:240]
            st["mode"], st["buf"] = s, []
            if s in ("file update", "apply_patch"):
                st["edits"] += 1
            continue
        if st["mode"] == "exec" and not st["buf"] and head:
            cmd = re.sub(r"\s+in\s+[A-Za-z]:\\.*$|\s+in\s+/\S*$", "", head)
            shell = re.match(r"^\"?[^\"]*?\b(powershell|pwsh|bash|cmd)(?:\.exe)?\"?\s+(?:-Command|-c|/c)\s+", cmd, re.I)
            cmd = (cmd[shell.end():] if shell else cmd).strip().strip("\"").replace("\\\\", "\\")
            script = cmd in ("@'", "@\"", "")
            if script:  # a here-string script: name it after its first line
                cmd = ("PowerShell" if shell and shell.group(1).lower() in ("powershell", "pwsh") else "Script") + " script"
            st["calls"].append({"cmd": cmd[:140], "state": "running", "t": t, "secs": -1, "script": script})
            del st["calls"][:-60]
            st["n"] += 1
            st["phase"] = max(st["phase"], phase_of(cmd))
            st["buf"].append(head)
            continue
        if st["mode"] == "exec" and st["calls"] and st["calls"][-1].get("script") and head and not head.startswith("#"):
            c = st["calls"][-1]
            c["cmd"], c["script"] = f"{c['cmd']} · {head}"[:140], False
            st["phase"] = max(st["phase"], phase_of(head))
            continue
        m = re.match(r"\s*(succeeded|exited (-?\d+)) in (\d+)ms", s)
        if m and st["calls"] and st["calls"][-1]["state"] == "running":
            c = st["calls"][-1]
            c["state"] = "ok" if m.group(1) == "succeeded" or m.group(2) == "0" else "fail"
            c["secs"] = int(m.group(3)) / 1000
            st["mode"] = ""
            continue
        if st["mode"] == "codex" and head:
            st["buf"].append(head)
        elif st["mode"] == "tokens used" and head:
            n = re.sub(r"[^\d]", "", head)
            if n:
                st["tokens"] = int(n)
    last = st["last"]
    if st["mode"] == "codex" and st["buf"]:
        last = re.sub(r"\s+", " ", " ".join(st["buf"])).strip()[:240]
    recent = [{"cmd": c["cmd"], "state": c["state"], "secs": round(c["secs"], 1) if c["state"] != "running" else round(NOW - c["t"], 1)}
              for c in st["calls"][-7:][::-1]]
    return {"commands": st["n"], "tokens": st["tokens"], "last": last, "recent": recent, "phase": st["phase"],
            "edits": st["edits"], "lastActive": int(NOW - t) if os.path.exists(f) else 0}


def _claude_dir(cwd):
    """Claude Code keeps each project's transcripts in ~/.claude/projects/<cwd with every non-alphanumeric char as '-'>."""
    return os.path.join(CLAUDE_HOME, "projects", re.sub(r"[^A-Za-z0-9]", "-", cwd.rstrip("/\\")))


def _iso(s):
    try:
        return time.mktime(time.strptime(str(s)[:19], "%Y-%m-%dT%H:%M:%S")) - time.timezone
    except Exception:
        return None


_CT = {}  # transcript path -> parsed state, read incrementally (only new complete lines each tick)
EDIT_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")


def _tool_desc(name, inp):
    inp = inp if isinstance(inp, dict) else {}
    for k in ("description", "command", "file_path", "pattern", "url", "query", "prompt", "skill", "subject"):
        v = inp.get(k)
        if isinstance(v, str) and v.strip():
            v = re.sub(r"\s+", " ", v).strip()
            if k == "file_path":
                v = os.path.basename(v)
            return f"{name} · {v}"[:140]
    return name[:140]


def _new_ct():
    return {"off": 0, "title": "", "first": "", "last_prompt": "", "calls": [], "results": {}, "todos": [], "tasks": {},
            "tokens": 0, "t0": None, "t1": None, "text": "", "waiting": False, "edits": 0, "limit": None, "cwd": "", "n": 0}


def claude_transcript(path):
    """Title, latest request, to-do steps, tool calls, tokens and timing from a Claude Code transcript (.jsonl)."""
    st = _CT.setdefault(path, _new_ct())
    try:
        size = os.path.getsize(path)
        if size < st["off"]:  # file was rewritten: read it again from the start
            st.clear()
            st.update(_new_ct())
        with open(path, "rb") as fh:
            if st["off"] == 0 and size > 16 * 1024 * 1024:
                # Long-running sessions grow to hundreds of MB: the latest 8 MB holds the current title, asks and work.
                fh.seek(size - 8 * 1024 * 1024)
                fh.readline()  # skip the partial line
                st["off"] = fh.tell()
            else:
                fh.seek(st["off"])
            chunk = fh.read(min(size - st["off"], 64 * 1024 * 1024))
    except OSError:
        return st
    end = chunk.rfind(b"\n") + 1
    st["off"] += end
    for line in chunk[:end].decode("utf-8", "replace").splitlines():
        if not line.startswith("{"):
            continue
        try:
            d = json.loads(line)
        except ValueError:
            continue
        if d.get("isSidechain"):
            continue  # a subagent's turn, not the main conversation
        typ, ts = d.get("type"), _iso(d.get("timestamp"))
        if ts and typ in ("user", "assistant"):
            st["t0"] = st["t0"] or ts
            st["t1"] = ts
        if d.get("cwd"):
            st["cwd"] = d["cwd"]
        if typ == "ai-title" and d.get("aiTitle"):
            st["title"] = str(d["aiTitle"])
        elif typ == "summary" and d.get("summary") and not st["title"]:
            st["title"] = str(d["summary"])
        elif typ == "last-prompt" and d.get("lastPrompt") and not st["first"]:
            st["last_prompt"] = str(d["lastPrompt"])  # only until real messages are seen: this record can lag behind them
        elif typ == "user":
            c = (d.get("message") or {}).get("content")
            parts = [{"type": "text", "text": c}] if isinstance(c, str) else (c if isinstance(c, list) else [])
            for part in parts:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "tool_result":
                    st["results"][part.get("tool_use_id")] = (bool(part.get("is_error")), ts)
                elif part.get("type") == "text" and not d.get("isMeta"):
                    t = str(part.get("text", "")).strip()
                    if t and not t.startswith("<") and not t.startswith("[Request interrupted"):
                        st["first"] = st["first"] or t
                        st["last_prompt"] = t
                        st["waiting"] = False
                        st.setdefault("asks", []).append(re.sub(r"\s+", " ", t)[:70])
                        del st["asks"][:-8]
        elif typ == "assistant":
            msg = d.get("message") or {}
            u = msg.get("usage") or {}
            st["tokens"] += int(u.get("output_tokens") or 0) + int(u.get("input_tokens") or 0)
            if isinstance(d.get("quotaLimits"), dict):
                q = d["quotaLimits"]
                st["limit"] = (q.get("status"), q.get("resetsAt"), q.get("rateLimitType"))
            uses = False
            for part in msg.get("content") or []:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text" and str(part.get("text", "")).strip():
                    st["text"] = re.sub(r"\s+", " ", part["text"]).strip()[:240]
                elif part.get("type") == "tool_use":
                    uses = True
                    name, inp = part.get("name", ""), part.get("input") or {}
                    st["n"] += 1
                    st["calls"].append({"id": part.get("id"), "cmd": _tool_desc(name, inp), "t": ts})
                    del st["calls"][:-60]
                    st["edits"] += name in EDIT_TOOLS
                    if name == "TodoWrite" and isinstance(inp.get("todos"), list):
                        st["todos"] = [{"title": str(t.get("content") or t.get("activeForm") or "")[:70], "status": str(t.get("status", "pending"))}
                                       for t in inp["todos"] if isinstance(t, dict)]
                    elif name == "TaskCreate" and inp.get("subject"):
                        st["tasks"][str(len(st["tasks"]) + 1)] = {"title": str(inp["subject"])[:70], "status": "pending"}
                    elif name == "TaskUpdate" and str(inp.get("taskId", "")) in st["tasks"]:
                        t = st["tasks"][str(inp["taskId"])]
                        if inp.get("status"):
                            t["status"] = str(inp["status"])
                        if inp.get("subject"):
                            t["title"] = str(inp["subject"])[:70]
            st["waiting"] = msg.get("stop_reason") == "end_turn" and not uses
        if len(st["results"]) > 400:
            keep = {c["id"] for c in st["calls"]}
            st["results"] = {k: v for k, v in st["results"].items() if k in keep}
    return st


def _steps_of(st, waiting=False):
    """The session's own to-do list (TodoWrite / TaskCreate) as steps; without one, its requests: earlier ones done, the latest in progress."""
    raw = st["todos"] or [t for t in st["tasks"].values() if t["status"] != "deleted"]
    m = {"completed": "done", "done": "done", "in_progress": "active", "active": "active"}
    if raw:
        return [{"title": t["title"], "status": m.get(t["status"], "pending")} for t in raw][:10], "todos"
    asks = st.get("asks") or []
    if not asks:
        return [], ""
    return [{"title": a, "status": "done" if i < len(asks) - 1 or waiting else "active"} for i, a in enumerate(asks)], "asks"


def _live_claude_sessions():
    """Claude Code's own registry of open sessions (~/.claude/sessions/<pid>.json): session id, folder, busy/idle, start time."""
    out = []
    for f in glob.glob(os.path.join(CLAUDE_HOME, "sessions", "*.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                d = json.load(fh)
            pid = int(d.get("pid") or 0)
            if not pid or not d.get("sessionId") or (psutil and not psutil.pid_exists(pid)):
                continue
            hits = glob.glob(os.path.join(CLAUDE_HOME, "projects", "*", d["sessionId"] + ".jsonl"))
            if hits:
                out.append({"file": hits[0], "pid": pid, "cwd": d.get("cwd", ""), "status": d.get("status", ""),
                            "started": float(d.get("startedAt") or 0) / 1000, "name": d.get("name", "")})
        except (OSError, ValueError, TypeError):
            continue
    return out


def _nice_title(st, proj):
    t = st["title"]
    if t and re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)+", t):  # slug-style title: "ribbon-masterplan-v10"
        t = t.replace("-", " ").capitalize()
    t = t or re.sub(r"\s+", " ", st["first"]).strip()
    return (t or f"Claude session in {proj}")[:80]


_CLAUDE_LIMIT = {"until": 0.0}  # a session was refused with "5-hour limit reached" until this time (from transcripts)


def claude_sessions(already):
    """Running Claude Code sessions: claude processes (matched to transcripts by working folder) plus any
    transcript written in the last 5 minutes (Claude desktop app, VS Code, sessions without a visible process)."""
    out, seen = [], set()
    by_dir = {}
    reg = _live_claude_sessions()  # exact: Claude Code's own list of open sessions
    reg_pids = {r["pid"] for r in reg}
    if psutil:
        for pr in _proc_table():
            if not re.match(r"claude(\.exe)?$", pr.get("name", "")) or "--type=" in pr["cmd"] or pr["pid"] in reg_pids:
                continue  # the Claude desktop app's helper processes are not sessions
            cwd = _cwd(pr)
            d = cwd
            while d:  # a session that moved into a subfolder keeps its transcripts under the folder it started in
                if glob.glob(os.path.join(_claude_dir(d), "*.jsonl")):
                    by_dir.setdefault(_claude_dir(d), []).append((pr, cwd))
                    break
                up = os.path.dirname(d.rstrip("/\\"))
                d = "" if up == d.rstrip("/\\") else up
    cands = [(r["file"], {"secs": int(NOW - r["started"]) if r["started"] else 0, "status": r["status"]}, r["cwd"]) for r in reg]
    for d, plist in by_dir.items():
        files = sorted(glob.glob(os.path.join(d, "*.jsonl")), key=os.path.getmtime, reverse=True)
        for (pr, cwd), f in zip(sorted(plist, key=lambda x: x[0]["secs"]), files):  # newest process <-> newest transcript
            cands.append((f, pr, cwd))
    claimed = {c[0] for c in cands}
    for f in glob.glob(os.path.join(CLAUDE_HOME, "projects", "*", "*.jsonl")):
        try:
            if f not in claimed and NOW - os.path.getmtime(f) < 300:
                cands.append((f, None, ""))
        except OSError:
            pass
    for f, pr, cwd in cands:
        if f in seen:
            continue
        seen.add(f)
        st = claude_transcript(f)
        if not st["t1"]:
            continue
        cwd = cwd or st["cwd"] or ""
        proj = os.path.basename(cwd.rstrip("/\\")) or os.path.basename(os.path.dirname(f))
        if pr and pr.get("status"):  # registry status is authoritative: busy = working, anything else = your turn
            st["waiting"] = pr["status"] != "busy"
        steps, steps_from = _steps_of(st, st["waiting"])
        recent = []
        for c in st["calls"][-7:][::-1]:
            res = st["results"].get(c["id"])
            state = "running" if res is None else ("fail" if res[0] else "ok")
            secs = (res[1] - c["t"]) if res and res[1] and c["t"] else (NOW - c["t"] if state == "running" and c["t"] else -1)
            recent.append({"cmd": c["cmd"], "state": state, "secs": round(max(secs, 0), 1) if secs != -1 else -1})
        try:
            last = max(st["t1"], os.path.getmtime(f))
        except OSError:
            last = st["t1"]
        idle = max(0, int(NOW - last))
        if st["waiting"]:
            note = "Waiting for your reply" + (f" · {st['text']}" if st["text"] else "")
        else:
            note = st["text"] or ("Working…" if idle < 60 else "")
        lim = st["limit"]
        if lim and lim[0] == "rejected" and lim[1]:
            try:
                if float(lim[1]) > NOW:
                    _CLAUDE_LIMIT["until"] = max(_CLAUDE_LIMIT["until"], float(lim[1]))
            except (TypeError, ValueError):
                pass
        tags = [proj[:20]] + (["needs you"] if st["waiting"] and idle > 30 else [])
        ask = re.sub(r"\s+", " ", st["last_prompt"]).strip()
        out.append({"key": "claude-" + os.path.basename(f)[:8], "id": "", "title": _nice_title(st, proj),
                    "summary": (f"Last ask: {ask}" if ask else f"Claude Code in {proj}")[:160],
                    "account": "Claude Code", "elapsed": pr["secs"] if pr else int(NOW - (st["t0"] or NOW)),
                    "steps": steps, "note": note[:200], "metrics": [], "tags": tags,
                    "commands": st["n"], "tokens": st["tokens"], "edits": st["edits"], "recent": recent,
                    "lastActive": idle, "estimated": steps_from != "todos", "stepsFrom": steps_from, "failovers": 0, "_cwd": cwd, "_t": last})
    return out


def codex_live_sessions(already):
    """Interactive Codex sessions (Codex app, VS Code, CLI) whose log was written in the last 10 minutes."""
    out = []
    taken = {t.get("_session") for t in already if t.get("_session")}
    for home in HOMES.values():
        for f in glob.glob(os.path.join(home, "sessions", "*", "*", "*", "*.jsonl")):
            try:
                if NOW - os.path.getmtime(f) > 600 or f in taken:
                    continue
                with open(f, encoding="utf-8", errors="replace") as fh:
                    head = fh.readline()
                meta = (json.loads(head).get("payload") or {}) if head.startswith("{") else {}
            except (OSError, ValueError):
                continue
            sd = session_details(f)
            cwd = str(meta.get("cwd") or "")
            proj = os.path.basename(cwd.rstrip("/\\")) or "Codex"
            ph = sd["phase"]
            out.append({"key": "codex-" + os.path.basename(f)[-14:-6], "id": "", "title": f"{proj} · Codex session",
                        "summary": f"Codex ({meta.get('source') or meta.get('originator') or 'session'}) in {cwd or proj}"[:160],
                        "account": "Codex", "elapsed": int(NOW - (_iso(meta.get("timestamp")) or os.path.getctime(f))),
                        "steps": sd.get("plan") or [{"title": n, "status": "done" if i < ph else "active" if i == ph else "pending"} for i, n in enumerate(PHASES)],
                        "stepsFrom": "todos" if sd.get("plan") else "phases",
                        "note": sd["last"][:200], "metrics": [], "tags": [proj[:20]], "commands": sd["commands"], "tokens": sd["tokens"],
                        "edits": sd["edits"], "recent": sd["recent"], "lastActive": sd["lastActive"] or int(NOW - os.path.getmtime(f)),
                        "estimated": not sd.get("plan"), "failovers": 0, "_cwd": cwd, "_t": os.path.getmtime(f)})
    return out


def queued():
    """Cards waiting to start: status 'queued' (waits on a condition) or 'blocked' (waits on the owner)."""
    out = []
    for path in glob.glob(os.path.join(PROGRESS, '*.json')):
        try:
            with open(path, encoding="utf-8-sig") as fh:
                p = json.load(fh)
            st = p.get('status')
            if st not in ('queued', 'blocked') or p.get('active'):
                continue
            num, title = pretty(os.path.basename(path)[:-5])
            out.append({'id': num, 'title': str(p.get('title') or title)[:80], 'summary': str(p.get('summary') or summary_for(num))[:160],
                        'worker': str(p.get('account', ''))[:40], 'waitingFor': str(p.get('waitingFor') or p.get('note', ''))[:160],
                        'blocked': st == 'blocked'})
        except (OSError, ValueError, TypeError):
            continue
    return sorted(out, key=lambda q: q['id'])


def claude_agents():
    """Background Claude agents of this Claude Code session, from their local transcripts."""
    out = []
    for f in [f for g in CLAUDE_TASKS_GLOBS for f in glob.glob(g)]:
        try:
            if NOW - os.path.getmtime(f) > 120 or os.path.getsize(f) < 200:
                continue
            title, tools, recent = "", 0, []
            with open(f, encoding="utf-8", errors="replace") as fh:
                for i, line in enumerate(fh):
                    if not line.startswith("{"):
                        break  # plain command output, not an agent transcript
                    if not title and '"type":"user"' in line:
                        m = re.search(r'"(?:text|content)":"((?:[^"\\]|\\.){3,300})', line)
                        if m and not m.group(1).startswith("You are powered"):
                            title = re.sub(r"\\n.*", "", m.group(1))[:80]
                    if '"tool_use"' in line:
                        for mm in re.finditer(r'"type":"tool_use","id":"[^"]+","name":"(\w+)","input":\{(.{0,500})', line):
                            tools += 1
                            desc = re.search(r'"description":"((?:[^"\\]|\\.){1,110})"', mm.group(2)) or re.search(r'"(?:command|file_path|pattern|prompt)":"((?:[^"\\]|\\.){1,110})', mm.group(2))
                            recent.append(f"{mm.group(1)} · {desc.group(1) if desc else ''}".rstrip(" ·"))
            if tools or title:
                out.append({"title": title or "Claude agent", "tools": tools, "recent": recent[-6:][::-1], "lastActive": int(NOW - os.path.getmtime(f))})
        except OSError:
            pass
    return out


def finished():
    rows, seen = [], set()
    for f in sorted(log_files(), key=os.path.getmtime, reverse=True)[:12]:
        m = re.findall(r"\[(\d\d:\d\d:\d\d)\] (\S+) finished with exit (\d+)", tail(f))
        if m:
            t, name, code = m[-1]
            if name in seen:
                continue
            seen.add(name)
            try:
                with open(os.path.join(PROGRESS, name + ".json"), encoding="utf-8-sig") as fh:
                    if json.load(fh).get("active"):
                        continue  # paused/resuming task: it is shown in progress, not as finished
            except (OSError, ValueError):
                pass
            num, title = pretty(name)
            info = _log_finish(f) or {}
            rows.append({"id": num, "title": title, "time": t[:5], "ok": code == "0", "_t": os.path.getmtime(f),
                         "_acct": codex_short(info["alias"]) if info.get("alias") else "", "_name": name})
    # Tasks finished by the orchestrator or Claude workers: progress cards marked done in the last 12 h.
    for path in glob.glob(os.path.join(PROGRESS, "*.json")):
        try:
            mt = os.path.getmtime(path)
            if NOW - mt > 12 * 3600:
                continue
            with open(path, encoding="utf-8-sig") as fh:
                p = json.load(fh)
            name = os.path.basename(path)[:-5]
            if p.get("active") or p.get("status") != "done" or "demo" in name:
                continue
            if name in seen:  # finished by a runner log: the card names the worker more reliably
                for r in rows:
                    if r.get("_name") == name and p.get("account"):
                        r["_acct"] = str(p["account"])
                continue
            seen.add(name)
            num, title = pretty(name)
            rows.append({"id": num, "title": str(p.get("title") or title)[:80], "time": time.strftime("%H:%M", time.localtime(mt)), "ok": True, "_t": mt,
                         "_acct": str(p.get("account", ""))})
        except (OSError, ValueError, TypeError):
            continue
    for d in _auto_done().get("done", []) if AUTO else []:  # auto-found jobs and sessions that ended
        if NOW - d.get("t", 0) < 12 * 3600 and d.get("key") not in seen:
            seen.add(d.get("key"))
            rows.append({"id": "", "title": str(d.get("title", ""))[:80], "time": time.strftime("%H:%M", time.localtime(d["t"])),
                         "ok": True, "_t": d["t"], "_acct": str(d.get("account", ""))})
    rows.sort(key=lambda r: -r["_t"])
    for r in rows:
        r.pop("_t", None)
        r.pop("_name", None)
    return rows[:8]


def usage():
    res, lim = [], []
    for f in sorted(log_files(), key=os.path.getmtime, reverse=True)[:8]:
        lim += re.findall(r"\[(\d\d:\d\d):\d\d\] '(\w+)' hit its limit", tail(f, 100000))
    for label, home in HOMES.items():
        p5 = p7 = 0.0
        reset = reset7 = 0
        # Several sessions can run on one account at once. Use the reading with the newest
        # timestamp across recently active sessions, not the last line of the newest file.
        latest = ""
        files = [f for f in glob.glob(f"{home}/sessions/*/*/*/*.jsonl") if NOW - os.path.getmtime(f) < 8 * 3600]
        for f in sorted(files, key=os.path.getmtime, reverse=True)[:12]:
            for line in tail(f, 400000).splitlines():
                if '"rate_limits"' not in line or '"primary":{' not in line:
                    continue
                try:
                    d = json.loads(line)
                except ValueError:
                    continue
                rl = (d.get("payload") or {}).get("rate_limits") or {}
                pr, se, ts = rl.get("primary"), rl.get("secondary") or {}, str(d.get("timestamp", ""))
                if pr and rl.get("limit_id", "codex") == "codex" and ts > latest:
                    latest = ts
                    weekly_only = int(pr.get("window_minutes") or 300) >= 1440 and not se  # some plans have no 5-hour window
                    if weekly_only:
                        se = pr
                    p5, reset = float(pr.get("used_percent") or 0), int(pr.get("resets_at") or 0)
                    p7, reset7 = float(se.get("used_percent") or 0), int(se.get("resets_at") or 0)
        if reset and reset < NOW:
            p5, reset = 0.0, 0
        if reset7 and reset7 < NOW:
            p7 = 0.0
        alias = next((str(a.get("runnerAlias", "")).lower() for a in CODEX if a["label"] == label), "")
        l = [t for t, a in lim if a.lower() == alias]
        row = {"name": label, "tool": "Codex", "five": p5, "seven": p7, "resetIn": max(0, int(reset - NOW)) if reset else 0, "lastLimit": l[-1] if l else ""}
        if latest and weekly_only:
            row["win"] = "7d"  # the main number is the weekly window: the panel labels it 7d instead of 5h
        if not latest:
            row["unknown"] = True  # no usage reading in the last 8 h
        res.append(row)
    # One status file per Claude account (each account's statusline.sh writes its own).
    # Claude accounts: {"label": "Claude-A (orchestrator)", "statusFile": "/tmp/claude-status-a.json", "limitLogGlobs": ["…/*w3*.log"]}
    claude = [(a["label"], X(a["statusFile"])) for a in CFG.get("claudeAccounts", [])]
    for i, (label, path) in enumerate(claude):
        try:
            with open(path, encoding="utf-8-sig") as fh:
                c = json.load(fh)
            rl = c.get("rate_limits", {})
            five, seven = rl.get("five_hour"), rl.get("seven_day") or {}
            age = int(NOW - os.path.getmtime(path))
            reset = float((five or {}).get("resets_at") or 0)
            expired = bool(reset) and reset < NOW  # window rolled over since the reading: the old % no longer applies
            row = {"name": label, "tool": "Claude", "five": 0.0 if (expired or not five) else float(five.get("used_percentage") or 0),
                   "seven": float(seven.get("used_percentage") or 0), "resetIn": max(0, int(reset - NOW)) if reset else 0,
                   "lastLimit": "", "age": age, "unknown": expired or not five}
            hit = claude_limit_from_logs(label)  # from headless worker logs (configured per account)
            if hit:  # a headless run reported "You've hit your 5-hour limit · resets 3:50pm" and the reset is still ahead
                row.update(five=100.0, resetIn=hit, unknown=False)
            res.insert(i, row)
        except Exception:
            row = {"name": label, "tool": "Claude", "five": 0.0, "seven": 0.0, "resetIn": 0, "lastLimit": "", "age": -1, "unknown": True}
            if AUTO and _CLAUDE_LIMIT["until"] > NOW:  # no status line yet, but a session was just refused at its limit
                row.update(five=100.0, resetIn=int(_CLAUDE_LIMIT["until"] - NOW), unknown=False, age=0)
            res.insert(i, row)
    return res


def claude_limit_from_logs(label):
    """Seconds until reset if a recent headless Claude worker log says the 5-hour limit was hit."""
    globs = next((a.get("limitLogGlobs", []) for a in CFG.get("claudeAccounts", []) if a["label"] == label), [])
    newest = None
    for f in [f for g in globs for f in glob.glob(X(g))]:
        if NOW - os.path.getmtime(f) > 6 * 3600:
            continue
        t4 = tail(f, 4000)
        m = re.findall(r"hit your 5-hour limit\D+resets (\d{1,2}):?(\d{2})?\s*([ap]m)", t4)
        # Only a limit message that is still the LAST real output counts: if the worker resumed after the reset and
        # wrote more lines, the old message must not be re-read as "resets tomorrow" (W3 showed 100% for 24 h).
        last = [ln for ln in t4.strip().splitlines() if ln.strip() and not ln.startswith(("Warning:", "Plugin "))][-3:]
        if m and not any("hit your 5-hour limit" in ln for ln in last):
            m = []
        if m and (newest is None or os.path.getmtime(f) > newest[0]):
            newest = (os.path.getmtime(f), m[-1])
    if not newest:
        return 0
    h, mi, ap = int(newest[1][0]) % 12 + (12 if newest[1][2] == "pm" else 0), int(newest[1][1] or 0), None
    t = time.localtime(newest[0])
    reset = time.mktime((t.tm_year, t.tm_mon, t.tm_mday, h, mi, 0, 0, 0, -1))
    if reset < newest[0]:
        reset += 86400
    return int(reset - NOW) if reset > NOW else 0


def cached_usage(path=None, ttl=20):
    """Usage parsing is the slowest part; the panel refreshes every 2 s, so reuse it for 20 s."""
    path = path or X(CFG.get("usageCacheFile", os.path.join(TMP, "agent-monitor-usage.json")))
    try:
        if NOW - os.path.getmtime(path) < ttl:
            with open(path, encoding="utf-8-sig") as fh:
                return json.load(fh)
    except (OSError, ValueError):
        pass
    res = usage()
    try:
        with open(path + ".tmp", "w", encoding="utf-8") as fh:
            json.dump(res, fh)
        os.replace(path + ".tmp", path)
    except OSError:
        pass
    return res


def repo_changes():
    areas = {}
    for l in git("status", "--short").splitlines():
        parts = l[3:].strip().strip('"').split("/")
        key = "/".join(parts[:2]) if parts[0] in ("apps", "packages", "docs", "scripts") and len(parts) > 1 else parts[0]
        areas[key] = areas.get(key, 0) + 1
    return [{"area": k, "files": v} for k, v in sorted(areas.items(), key=lambda x: -x[1])[:8]]


def up(url):
    try:
        urllib.request.urlopen(url, timeout=0.8)
        return True
    except Exception:
        return False


_HEALTH = {}  # url -> up, kept fresh by a background thread in --serve mode


def health_rows():
    """Health checks run in parallel; in --serve mode a background thread keeps them fresh, so a slow or refused
    port (Windows waits ~2 s on a refused localhost connection) never delays a tick."""
    hs = CFG.get("health", [])
    if not _HEALTH:
        _check_health(hs)
    return [{"label": h["label"], "up": _HEALTH.get(h["url"], False), "group": h.get("group", "")} for h in hs]


def _check_health(hs):
    from concurrent.futures import ThreadPoolExecutor
    urls = list({h["url"] for h in hs})
    if urls:
        with ThreadPoolExecutor(max_workers=min(8, len(urls))) as ex:
            _HEALTH.update(zip(urls, ex.map(up, urls)))


def _health_loop(every=5.0):
    while True:
        try:
            _check_health(CFG.get("health", []))
        except Exception:
            pass
        time.sleep(every)


def _worker_defs():
    """config "workers": [["Claude-A", "W0"], ["Codex-B", "W1", "#0072B2"], {"name": "Codex-C", "id": "W2", "color": "#E69F00"}, …]
    The optional colour overrides the panel's default (assigned by order: W0, W1, … then any extra accounts)."""
    out = []
    for w in CFG.get("workers", []):
        if isinstance(w, dict):
            name, wid, col = w.get("name", ""), w.get("id", ""), w.get("color")
        elif isinstance(w, (list, tuple)) and len(w) >= 2:
            name, wid, col = w[0], w[1], (w[2] if len(w) > 2 else None)
        else:
            continue
        out.append({"name": str(name), "id": str(wid), "color": col if isinstance(col, str) and re.match(r"^#?[0-9A-Fa-f]{6}$", col) else None})
    return out


WORKER_DEFS = _worker_defs()
WORKERS = [(w["name"], w["id"]) for w in WORKER_DEFS]  # prefixes shown on the panel


def numbered(label):
    """Prefix the worker number (W0 orchestrator, W1-W3 workers) to any account label that names one."""
    if not isinstance(label, str) or label[:1] == "W" and label[1:2].isdigit():
        return label
    for name, num in WORKERS:
        label = label.replace(name, f"{num} {name}")
    return label


def worker_id(label):
    """'W2 Codex-B', 'W2' or 'Codex-B (worker)' -> 'W2'; '' when no worker is named."""
    m = re.match(r"^(W\d+)\b", str(label or ""))
    if m:
        return m.group(1)
    for name, num in WORKERS:
        if name and name in str(label or ""):
            return num
    return ""


def _midnight():
    t = time.localtime(NOW)
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))


_LOGINFO = {}  # path -> (mtime, size, {"task", "alias", "code", "t"})


def _log_finish(f):
    """Last 'finished with exit N' of a runner log and the Codex account it ran on (cached by mtime/size)."""
    try:
        st = os.stat(f)
    except OSError:
        return None
    hit = _LOGINFO.get(f)
    if hit and hit[0] == st.st_mtime and hit[1] == st.st_size:
        return hit[2]
    info = None
    try:
        with open(f, encoding="utf-8", errors="replace") as fh:
            txt = fh.read()
        fin = list(re.finditer(r"\[(\d\d:\d\d:\d\d)\] (\S+) finished with exit (\d+)", txt))
        if fin:
            m = fin[-1]
            al = re.findall(r"codex account '(\w+)'", txt[:m.start()])
            info = {"task": m.group(2), "alias": al[-1] if al else "", "code": int(m.group(3)), "t": st.st_mtime}
    except OSError:
        pass
    _LOGINFO[f] = (st.st_mtime, st.st_size, info)
    return info


_EVENTS = {"t": 0, "v": []}


def _finish_events(since):
    """[(task, worker id, ok, time)] for tasks finished since `since`: runner logs + progress cards marked done.
    Re-read at most every 15 s (a running worker's log grows every tick)."""
    if NOW - _EVENTS["t"] < 15:
        return _EVENTS["v"]
    ev = {}
    for f in log_files():
        try:
            if os.path.getmtime(f) < since:
                continue
        except OSError:
            continue
        i = _log_finish(f)
        if i:
            ev[i["task"]] = (i["task"], worker_id(numbered(codex_short(i["alias"]))) if i["alias"] else "", i["code"] == 0, i["t"])
    for path in glob.glob(os.path.join(PROGRESS, "*.json")):
        try:
            mt = os.path.getmtime(path)
            if mt < since:
                continue
            with open(path, encoding="utf-8-sig") as fh:
                p = json.load(fh)
            if p.get("active") or p.get("status") != "done":
                continue
            name = os.path.basename(path)[:-5]
            wid = worker_id(numbered(str(p.get("account", ""))))
            if wid or name not in ev:
                ev[name] = (name, wid or (ev.get(name) or ("", ""))[1], True, mt)
        except (OSError, ValueError, TypeError):
            continue
    for d in _auto_done().get("done", []) if AUTO else []:
        if d.get("t", 0) >= since:
            ev[d.get("key", "")] = (d.get("key", ""), worker_id(numbered(str(d.get("account", "")))), True, d["t"])
    _EVENTS["t"], _EVENTS["v"] = NOW, list(ev.values())
    return _EVENTS["v"]


def workers_block(d):
    """Per-worker facts for the panel's Workers drawer: lanes now, jobs done today, idle time, pipeline. Local files only."""
    ids = [(w["id"], w["name"], w["color"]) for w in WORKER_DEFS]
    for a in d["accounts"]:  # extra accounts that no configured worker names
        if not a.get("wid"):
            short = re.sub(r"\s*\(.*\)$", "", a["name"]).strip() or a["name"]
            a["wid"] = short
            if short not in [i[0] for i in ids]:
                ids.append((short, short, None))
    events = _finish_events(NOW - 24 * 3600)
    today = _midnight()
    out = []
    for slot, (wid, name, col) in enumerate(ids):
        acct = next((a["name"] for a in d["accounts"] if a.get("wid") == wid), "")
        lanes = [{"id": t.get("id") or t["key"], "title": t["title"], "stale": t.get("lastActive", 0) > 1800}
                 for t in d["running"] if t.get("wid") == wid]
        done = sorted([e for e in events if e[1] == wid], key=lambda e: e[3])
        done_today = [e for e in done if e[3] >= today]
        live_lanes = [l for l in lanes if not l["stale"]]
        idle = 0 if live_lanes else (int(NOW - done[-1][3]) if done else -1)
        pipe = []
        for q in d["queued"]:
            if q.get("wid") == wid:
                pipe.append({"id": q["id"], "title": q["title"], "blocked": q["blocked"], "likely": False})
            elif not q.get("wid") and re.search(rf"\b{re.escape(wid)}\b", q.get("waitingFor", "")):
                pipe.append({"id": q["id"], "title": q["title"], "blocked": q["blocked"], "likely": True})
        out.append({"id": wid, "name": name, "color": col, "slot": slot, "account": acct, "lanes": lanes,
                    "doneToday": len([e for e in done_today if e[2]]), "failedToday": len([e for e in done_today if not e[2]]),
                    "doneIds": [pretty(e[0])[0] or e[0] for e in done_today][-8:],
                    "lastDone": int(NOW - done[-1][3]) if done else -1, "idleSecs": idle, "pipeline": pipe[:6]})
    return out


def _number_all(d):
    for t in d["running"]:
        t["account"] = numbered(t.get("account", ""))
        t["wid"] = worker_id(t["account"])
    for q in d["queued"]:
        q["worker"] = numbered(q.get("worker", ""))
        q["wid"] = worker_id(q["worker"])
    for a in d["accounts"]:
        a["name"] = numbered(a["name"])
        a["wid"] = worker_id(a["name"])
    d["accounts"].sort(key=lambda a: a["name"][:2])
    for r in d["finished"]:
        r["wid"] = worker_id(numbered(r.pop("_acct", "")))
    d["workers"] = workers_block(d)
    return d


def snapshot():
    return _number_all(_snapshot())


AUTO_DONE_FILE = os.path.join(TMP, "agent-monitor-auto-finished.json")


def _auto_done():
    try:
        with open(AUTO_DONE_FILE, encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _auto_track(run):
    """Auto-found work that stops running (job ended, session closed) moves to Recently finished, at the time it was last seen."""
    if not AUTO:
        return
    st = _auto_done()
    live, done = st.get("live", {}), st.get("done", [])
    cur = {t["key"]: {"title": t["title"], "account": t.get("account", ""), "t": NOW} for t in run}
    ended = [k for k in live if k not in cur]
    for k in ended:
        v = live[k]
        done = [d for d in done if d.get("key") != k]  # a session can finish several times: keep its latest finish only
        done.append({"key": k, "title": v.get("title", k), "account": v.get("account", ""), "t": v.get("t", NOW)})
    done = [d for d in done if NOW - d.get("t", 0) < 24 * 3600][-40:]
    if ended or set(cur) != set(live) or NOW - max([v.get("t", 0) for v in live.values()] or [0]) > 60:
        try:
            with open(AUTO_DONE_FILE + ".tmp", "w", encoding="utf-8") as fh:
                json.dump({"live": cur, "done": done}, fh)
            os.replace(AUTO_DONE_FILE + ".tmp", AUTO_DONE_FILE)
        except OSError:
            pass


def _auto_repo(run):
    """No repo configured: show the git repo of the most recently active session's folder."""
    global REPO
    if not AUTO or CFG.get("repo"):
        return
    for t in sorted(run, key=lambda t: -(t.get("_t") or 0)):
        c = t.get("_cwd") or ""
        if c and os.path.exists(os.path.join(c, ".git")):
            REPO = c
            return
    REPO = ""


def _snapshot():
    run = running()
    if AUTO:  # most recently active first
        run.sort(key=lambda t: t.get("lastActive", 0))
    _auto_repo(run)
    # Only ongoing work is shown: a task whose steps are all done (100 %) leaves "In progress" and moves to
    # Recently finished; it comes back by itself when new work starts in it (e.g. you send that session a new request).
    if CFG.get("hideCompleted", True):
        run = [t for t in run if not (t.get("steps") and all(s.get("status") == "done" for s in t["steps"]))]
    _auto_track(run)
    for t in run:
        for k in [k for k in t if k.startswith("_")]:
            del t[k]
    return {
    "time": time.strftime("%H:%M:%S"),
    "running": run,
    "queued": queued(),
    "agents": claude_agents(),
    "finished": finished(),
    "accounts": cached_usage(),
    "commit": git("log", "-1", "--format=%h · %s · %ar").strip()[:90],
    "repo": os.path.basename(REPO.rstrip("/\\")) if REPO else "",
    "changes": repo_changes(),
    "title": CFG.get("title", "Agent monitor"),
    "health": health_rows(),
    }


_USAGE = {"t": 0, "v": []}


def serve(interval=2.0):
    """Long-lived mode for the panel: one JSON line per tick, caches kept in memory (no process start per refresh)."""
    import sys
    global NOW, cached_usage
    file_cached = cached_usage

    def mem_usage():
        if NOW - _USAGE["t"] > 20:
            _USAGE["v"], _USAGE["t"] = file_cached(), NOW
        return _USAGE["v"]
    cached_usage = mem_usage
    if CFG.get("health"):
        import threading
        _check_health(CFG["health"])
        threading.Thread(target=_health_loop, daemon=True).start()
    while True:
        NOW = time.time()
        try:
            sys.stdout.write(json.dumps(snapshot()) + "\n")
            sys.stdout.flush()
        except BrokenPipeError:
            return
        except Exception as e:  # never die on one bad file; report and keep going
            sys.stderr.write(f"status error: {e}\n")
        time.sleep(max(0.2, interval - (time.time() - NOW)))


if __name__ == "__main__":
    import sys
    if "--serve" in sys.argv:
        serve()
    else:
        print(json.dumps(snapshot()))
