"""Claude Code status line for Windows that also feeds agent-monitor with this account's usage (rate limits).
Python version of bin/claude-statusline.sh (no bash needed).

In <CLAUDE_CONFIG_DIR>\\settings.json (usually %USERPROFILE%\\.claude\\settings.json):
  "statusLine": {"type": "command", "command": "python \\"D:/path/to/agent-monitor/windows/claude-statusline.py\\" \\"C:/Users/you/AppData/Local/Temp/claude-status-main.json\\""}
and point that account's "statusFile" in your agent-monitor config at the same path.
"""
import json
import os
import sys
import tempfile


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(tempfile.gettempdir(), "agent-monitor-claude-status.json")
    out = os.path.expandvars(os.path.expanduser(out))
    raw = sys.stdin.buffer.read().decode("utf-8", "replace")
    try:
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        tmp = f"{out}.{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(raw)
        os.replace(tmp, out)  # atomic: the panel never reads a half-written file
    except OSError:
        pass
    try:
        d = json.loads(raw)
    except ValueError:
        d = {}
    model = (d.get("model") or {}).get("display_name", "")
    five = ((d.get("rate_limits") or {}).get("five_hour") or {}).get("used_percentage")
    line = f"{model} · 5h {int(five) if isinstance(five, (int, float)) else '?'}%"
    sys.stdout.buffer.write(line.encode("utf-8"))  # Claude Code reads UTF-8; the Windows console default would garble "·"
    sys.stdout.flush()


if __name__ == "__main__":
    main()
