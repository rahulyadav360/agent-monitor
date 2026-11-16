# agent-monitor

A floating, always-on-top panel for macOS and Windows that shows what your AI agents and background jobs are doing — across any project. It reads local files only (task cards, runner logs, Codex session logs, Claude Code status lines) plus optional localhost health checks: **no network calls, no AI, no tokens**.

It was built while orchestrating one Claude Code orchestrator (W0) and several Codex/Claude workers (W1–W3) on a real project, and is project-agnostic: everything project-specific lives in one JSON config.

## What it shows
- **Workers** — 5-hour / 7-day usage per Claude Code and Codex account, reset countdown, "LIMIT" when a headless worker reports it, the age of each reading (never a fake 0%). Click **Workers** (section header, or the colour key in Studio's top display) to open a drawer per worker: a usage graph over the last 24 h (5-hour solid, 7-day dashed, window resets marked), time to reset, burn rate (%/h over the last 90 min), estimated time until the limit at that rate, jobs running now (parallel lanes, with task ids), jobs finished today, idle time with a *spare capacity* hint, and its pipeline (queued tasks assigned to it, or that name it in `waitingFor`). Open/closed is remembered. Usage samples (one a minute) are saved to `~/Library/Application Support/agent-monitor/usage-history-<config>.json` so graphs survive restarts.
- **Worker colours** — each worker has one colour used everywhere: the left stripe and badge on its task cards (and the key-cap edge in Studio), its account row, sparkline and graph, the drawer, and its "Recently finished" rows. Hover a badge for the colour key. Defaults follow the colour-blind-safe Okabe–Ito palette in `workers` order (W0 blue, W1 orange, W2 green, W3 pink, then vermilion, sky, yellow, grey); each theme darkens or lightens them until text reaches 4.5:1 on every surface, and badge text is checked against its badge.
- **In progress** — one card per task: plain-English title + one-line summary, worker badge (W0, W1…), tags, steps with per-step and whole-task ETA, **progress numbers** (e.g. "Documents profiled 620 / 3,657 · ≈42/min · ~1.2 h left"), last activity, stale warning after 30 min without an update; raw shell activity is collapsed.
- **Up next** — queued tasks (waiting on a condition) and blocked ones (waiting on a person).
- **Recently finished** — from runner logs and done cards, by any agent.
- **Health** — your app/API URLs (green/red), grouped.
- **Repository** — last commit and uncommitted changes (uses `git --no-optional-locks`, so it never blocks your agents' commits).

**Themes**: three layouts, each in light and dark, taken from the v2 mockups. *Studio* is PhoneDeck's hardware look, with a warm-grey body, dark LCD blocks and chunky ink-bordered keys. *Mission Control* is dense and data-first: monospace numerals, LEDs, thin rules, a KPI grid, sparklines, a live ticker and key hints. *Paper* is editorial: serif headlines, a one-paragraph summary, soft cards, pastel pills and quota rings. Pick the layout and Light, Dark or Auto (Auto follows macOS) in the panel header. **⌘T** cycles layouts and **⌘⇧T** flips light and dark while the panel is focused. Both choices are remembered. Colours, fonts and spacing are tokens in the `Theme` struct in `Panel.swift`, and every theme meets WCAG AA contrast. Fonts are bundled in `fonts/` (SIL OFL) and registered for the panel process only.

## Install / run
```bash
git clone <this repo> ~/agent-monitor            # or copy the folder
mkdir -p ~/.config/agent-monitor
cp examples/minimal.config.json ~/.config/agent-monitor/config.json   # then edit it
./start.sh                                       # or ./start.sh path/to/other-config.json
```
Requirements: macOS 13+, Xcode command-line tools (`swiftc`), Python 3.9+. `start.sh` compiles `Panel.swift` to `~/.local/bin/agent-monitor-panel` when it changed and starts it; close the window to stop. The panel keeps **one** long-lived `status.py --serve` process (≈15 ms CPU per 2-s tick) and restarts it if it dies.

## Windows
The same panel runs on Windows 10/11, in the same three layouts (Studio, Mission Control, Paper, each light/dark/auto) and with the same data. The window is drawn by Edge WebView2, which is built into Windows, through [pywebview](https://pywebview.flowrl.com/). The UI lives in `windows/ui/` (HTML/CSS/JS ported from `Panel.swift`), and `windows/panel.py` hosts it and streams `status.py --serve` into it.

**Install (once):**
1. Install **Python 3.9+** from [python.org](https://www.python.org/downloads/) and tick **"Add python.exe to PATH"**.
2. Download this repo (green **Code** button → *Download ZIP*, then unzip it), or `git clone` it.
3. Double-click **`windows\install.bat`**. It installs `pywebview` and `psutil`, creates `%USERPROFILE%\.config\agent-monitor\config.json` from `examples\windows.config.json`, and adds an **Agent Monitor** shortcut to your Desktop and Start menu.
4. Open that `config.json` in Notepad and set your project's `title`, `repo` and accounts (see the config reference below).

**Run:** double-click **Agent Monitor** on the Desktop, or `windows\start.bat [path\to\config.json]`. The panel opens on the right edge of the screen and stays on top. Close it to stop. Starting it again replaces the running panel. **Ctrl+T** cycles layouts, **Ctrl+Shift+T** flips light/dark, and Auto follows Windows' app light/dark setting. The window's size and position, theme, and Workers drawer are remembered in `%APPDATA%\agent-monitor\`, along with the usage history.

**Auto-discovery (on by default on Windows):** with no config at all, the panel shows your real work.
- **Claude Code sessions** that are running: it finds each `claude` process, matches it to its transcript in `~/.claude/projects`, and shows the title, your last request, the to-do list as steps, recent tool calls, tokens, and "your turn" when Claude is waiting for you. A transcript written in the last 5 minutes without a visible process (desktop app, VS Code) also counts.
- **`codex exec` jobs:** each is named after its brief or folder and shows the prompt it was given, its commands and results, and Codex's latest message. `--ephemeral` jobs are read from the log their output is redirected to.
- **Live Codex sessions** in the Codex app or VS Code: any session log written in the last 10 minutes.
- **Usage:** Codex comes from `~/.codex/sessions`, including plans that only have a weekly window (shown as "7d"). Claude comes from your status line: add the block from `windows/claude-statusline.py`, or call it, so the 5h and 7d numbers appear. Even without it, a "limit reached" is picked up from transcripts.
- **Recently finished:** jobs and sessions that stop running move here, with the time they ended.
- **Repository:** the git repo of the most recently active session.

Set `"autoDiscover": false` to use only task cards and configured accounts, as on macOS. Everything you configure explicitly (`workers`, `codexAccounts`, `claudeAccounts`, `repo`…) still wins.

**Windows notes:**
- Config paths may use `~`, `%TEMP%`, `%USERPROFILE%` and forward or back slashes, e.g. `"progressDir": "%TEMP%/agent-progress"`. In JSON a backslash must be doubled (`"D:\\code\\app"`), so forward slashes are easier.
- Running `codex exec` and `claude -p` workers are found with `psutil`. That covers `codex.exe`, `codex.js` under Node, the native `codex-…-windows-msvc.exe`, `claude.exe` and `claude.cmd`. Command lines are matched with forward slashes, so the default task patterns (`docs/tasks/…`) work unchanged. Optional overrides: `codexExecPattern`, `headlessClaudePattern`, `agentProcessNames`.
- Claude Code background-agent transcripts on Windows are under `%TEMP%\claude\…\tasks\*.output`, so use `"claudeTaskOutputGlobs": ["%TEMP%/claude/*/*/tasks/*.output"]`.
- Health URLs: prefer `http://127.0.0.1:3000` over `localhost`. Windows spends about 2 s on a refused `localhost` connection. Checks run in the background either way, so they never slow the panel.
- Claude Code usage on the panel: use the Python status line, which needs no bash. In `%USERPROFILE%\.claude\settings.json`:
  ```json
  "statusLine": {"type": "command", "command": "python \"D:/path/to/agent-monitor/windows/claude-statusline.py\" \"C:/Users/<you>/AppData/Local/Temp/claude-status-main.json\""}
  ```
  Then set that account's `statusFile` to the same path.
- Preview the UI in a browser without Python (demo data): run `python -m http.server` in the repo folder, then open `http://127.0.0.1:8000/windows/ui/index.html?layout=mission&mode=dark&open=workers`.

## Config reference (`examples/full.config.json` shows every key)
| Key | Meaning |
|---|---|
| `title` | Window title |
| `progressDir` | Folder of task cards (`<task-id>.json`), see below |
| `titlesFile` | Optional `{ "037": {"title": "…", "summary": "…"} }` plain names by task number (cards' own `title`/`summary` win) |
| `repo`, `worktreesDir` | Git repo for "Repository" + auto-metrics (commits on `task/<name>`, files changed, handoff written) |
| `runnerLogDirGlobs` | Folders with runner logs `<task>.log` ("finished with exit N", "hit its limit") |
| `claudeTaskOutputGlobs` | Claude Code background-agent transcripts (`*.output`) to show as Claude agents |
| `codexAccounts[]` | `label`, `home` (CODEX_HOME), `runnerAlias` (name used in runner logs), `short` (badge) |
| `codexTaskPattern` | Regex (group 1 = brief path) to find the task in a running `codex exec` command line |
| `claudeAccounts[]` | `label`, `statusFile` (written by `bin/claude-statusline.sh`), optional `limitLogGlobs` (headless logs with "You've hit your 5-hour limit · resets 3:50pm") |
| `headlessTaskPattern`, `headlessClaudeLabel` | Detect `claude -p "… <task> …"` workers that haven't written a card yet |
| `workers` | `[["Claude-A","W0"], …]` prefixes shown on badges and account rows; an optional third item (or `{"name","id","color"}`) sets that worker's colour, e.g. `["Codex-B","W1","#E69F00"]` |
| `health[]` | `label`, `url`, optional `group` (one row per group) |
| `usageCacheFile` | Where usage parsing is cached (20 s) |
| `theme` | Optional default look, e.g. `"studio"`, `"mission-dark"`, `"paper-auto"` (your last choice in the panel wins) |

Relative paths are resolved against the config file's folder; `~` is expanded.

## Task card format (`<progressDir>/<task-id>.json`)
Any agent, script or human can write these (atomically: write `x.tmp`, then rename). `bin/card.py` does it for you.
```json
{
  "source": "interactive", "active": true, "status": "in-progress",
  "account": "W1 Codex-Rahul", "startedAt": 1794700000,
  "title": "Plain-English name", "summary": "One line: what and why", "tags": ["data", "P1"],
  "steps": [{"title": "Read sources", "status": "done|active|pending", "etaMin": 15, "startedAt": 1794700000}],
  "metrics": [{"label": "Files processed", "done": 620, "total": 3657}, {"label": "Errors", "done": 3, "kind": "bad"}],
  "note": "current activity"
}
```
- `status: "queued"` (with `waitingFor`) or `"blocked"` and `active: false` → shown under **Up next**.
- `status: "done"`, `active: false` → shown under **Recently finished** for 12 h.
- Task ids starting with a number (`037-data-understanding`) show that number as the card badge.
- **Continuation runs must keep existing done steps and metrics** — append, never restart a card from zero.

Prompt snippet for agents: *"Keep `<progressDir>/<task>.json` updated: title, summary, tags, steps with etaMin and startedAt, metrics with real done/total counts updated every few minutes; on a continuation keep existing steps and append yours."*

## Claude Code usage on the panel
Add to each account's `settings.json`:
```json
"statusLine": {"type": "command", "command": "~/agent-monitor/bin/claude-statusline.sh /tmp/claude-status-<account>.json"}
```
and use the same path as that account's `statusFile`.

## Files
`Panel.swift` (SwiftUI panel, macOS) · `windows/` (Windows panel: `panel.py`, `ui/`, `install.bat`, `start.bat`, `claude-statusline.py`) · `fonts/` · `status.py` (data, `--serve` streaming mode, `--config`) · `start.sh` · `bin/card.py` · `bin/claude-statusline.sh` · `examples/*.config.json`.

## Licence
MIT — see [LICENSE](LICENSE).
