"""agent-monitor for Windows: an always-on-top panel on the right edge of the screen.

Runs ONE long-lived `status.py --serve` process (local files only: no network, no AI, no tokens), streams its JSON
snapshots into the panel UI (windows/ui, rendered by Edge WebView2 through pywebview) and restarts it if it dies.

    pythonw windows\\panel.py [config.json]     (default: %AGENT_MONITOR_CONFIG% or ~/.config/agent-monitor/config.json)
"""
import ctypes
import functools
import http.server
import json
import os
import subprocess
import sys
import threading
import time

import webview

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
STATUS_PY = os.path.join(REPO, "status.py")
DATA_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "agent-monitor")
WIDTH = 520
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def config_path():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    p = args[0] if args else os.environ.get("AGENT_MONITOR_CONFIG") or os.path.expanduser("~/.config/agent-monitor/config.json")
    return os.path.abspath(os.path.expandvars(os.path.expanduser(p)))


CONFIG = config_path()
CONFIG_NAME = os.path.splitext(os.path.basename(CONFIG))[0].replace("/", "_")


def read_json(path, default):
    try:
        with open(path, encoding="utf-8-sig") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh)
    os.replace(tmp, path)


PREFS_FILE = os.path.join(DATA_DIR, "prefs.json")
HISTORY_FILE = os.path.join(DATA_DIR, f"usage-history-{CONFIG_NAME}.json")


# ---------------------------------------------------------------- Windows helpers
def work_area():
    """The screen area not covered by the taskbar, in logical (DPI-scaled) pixels as pywebview expects."""
    try:
        class RECT(ctypes.Structure):
            _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long), ("right", ctypes.c_long), ("bottom", ctypes.c_long)]
        r = RECT()
        ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(r), 0)  # SPI_GETWORKAREA
        scale = 1.0
        try:
            scale = ctypes.windll.user32.GetDpiForSystem() / 96.0
            if not ctypes.windll.user32.IsProcessDPIAware():
                scale = 1.0  # not DPI aware yet: Windows already reports scaled values
        except Exception:
            pass
        return (int(r.left / scale), int(r.top / scale), int((r.right - r.left) / scale), int((r.bottom - r.top) / scale))
    except Exception:
        return (0, 0, 1440, 900)


def system_dark():
    """Windows 'Choose your app mode' setting: True when apps should be dark."""
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as k:
            return winreg.QueryValueEx(k, "AppsUseLightTheme")[0] == 0
    except Exception:
        return False


def own_windows():
    """Visible top-level windows of this process (the panel)."""
    from ctypes import wintypes as wt
    user32, pid, out = ctypes.windll.user32, os.getpid(), []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, wt.HWND, wt.LPARAM)
    def cb(h, _):
        p = wt.DWORD()
        user32.GetWindowThreadProcessId(h, ctypes.byref(p))
        if p.value == pid and user32.IsWindowVisible(h):
            out.append(h)
        return True
    user32.EnumWindows(cb, 0)
    return out


def set_titlebar_dark(window, dark):
    """Dark or light native title bar (Windows 10 1809+ / 11), so the frame matches the panel's theme."""
    try:
        from ctypes import wintypes as wt
        val = ctypes.c_int(1 if dark else 0)
        for h in own_windows():
            for attr in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE (20; 19 on older Windows 10 builds)
                if ctypes.windll.dwmapi.DwmSetWindowAttribute(wt.HWND(h), attr, ctypes.byref(val), 4) == 0:
                    break
            # repaint the frame now: SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED
            ctypes.windll.user32.SetWindowPos(wt.HWND(h), None, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0004 | 0x0010 | 0x0020)
            # Windows 10 only repaints the caption on (de)activation: send WM_NCACTIVATE off, then back to its real state.
            active = 1 if ctypes.windll.user32.GetForegroundWindow() == h else 0
            ctypes.windll.user32.SendMessageW(wt.HWND(h), 0x0086, 1 - active, 0)
            ctypes.windll.user32.SendMessageW(wt.HWND(h), 0x0086, active, 0)
    except Exception:
        pass


def stop_other_panels():
    """One panel at a time: starting it again replaces the running one (like start.sh on macOS)."""
    try:
        import psutil
    except ImportError:
        return
    me, mine = os.getpid(), os.path.normcase(os.path.abspath(__file__))
    for p in psutil.process_iter(["pid", "name"]):
        try:
            if p.info["pid"] == me or "python" not in (p.info["name"] or "").lower():
                continue
            if any(os.path.normcase(os.path.abspath(c)) == mine for c in p.cmdline()[1:3]):
                for child in p.children(recursive=True):
                    child.kill()
                p.kill()
        except Exception:
            continue


# ---------------------------------------------------------------- local file server for the UI (127.0.0.1 only)
class UIHandler(http.server.SimpleHTTPRequestHandler):
    """Serves windows/ui and fonts/ only (fonts need http://, not file://, to load in WebView2)."""
    def translate_path(self, path):
        p = path.split("?", 1)[0].split("#", 1)[0]
        if not (p.startswith("/windows/ui/") or p.startswith("/fonts/")):
            return os.path.join(REPO, "__nothing__")
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


def start_ui_server():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(UIHandler, directory=REPO))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_address[1]}/windows/ui/index.html"


# ---------------------------------------------------------------- status.py stream
class Feed:
    def __init__(self):
        self.window = None
        self.latest = None
        self.ready = False
        self.proc = None
        self.stopping = False

    def python(self):
        exe = sys.executable
        if exe.lower().endswith("pythonw.exe"):  # the child needs a real stdout; python.exe with CREATE_NO_WINDOW shows no console
            alt = exe[:-len("pythonw.exe")] + "python.exe"
            if os.path.exists(alt):
                exe = alt
        return exe

    def run(self):
        while not self.stopping:
            env = dict(os.environ, AGENT_MONITOR_CONFIG=CONFIG, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
            try:
                self.proc = subprocess.Popen([self.python(), "-X", "utf8", STATUS_PY, "--serve", "--config", CONFIG],
                                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                                             env=env, cwd=REPO, creationflags=NO_WINDOW, bufsize=1, text=True, encoding="utf-8")
                for line in self.proc.stdout:
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    self.latest = line
                    if self.ready and self.window:
                        try:
                            self.window.evaluate_js(f"window.onStatus({line})")
                        except Exception:
                            pass
            except Exception:
                pass
            if not self.stopping:
                time.sleep(2)  # it exited: restart after 2 s

    def stop(self):
        self.stopping = True
        try:
            if self.proc:
                self.proc.kill()
        except Exception:
            pass


FEED = Feed()


class Api:
    """Called from the panel's JavaScript (window.pywebview.api.*). Attributes are private so pywebview does not expose them."""
    def __init__(self):
        self._window = None
        self._full = None

    def get_prefs(self):
        p = read_json(PREFS_FILE, {})
        p["configTheme"] = read_json(CONFIG, {}).get("theme", "")
        FEED.ready = True
        return p

    def set_prefs(self, p):
        cur = read_json(PREFS_FILE, {})
        cur.update({k: p[k] for k in ("layout", "mode", "workersOpen") if k in (p or {})})
        write_json(PREFS_FILE, cur)

    def latest(self):
        FEED.ready = True
        return json.loads(FEED.latest) if FEED.latest else None

    def load_history(self):
        return read_json(HISTORY_FILE, {})

    def save_history(self, h):
        try:
            write_json(HISTORY_FILE, h)
        except OSError:
            pass

    def system_dark(self):
        return system_dark()

    def set_dark(self, dark):
        if self._window:
            set_titlebar_dark(self._window, bool(dark))

    def set_collapsed(self, collapsed):
        """Shrink to a strip at the top-right (or restore the full height)."""
        w = self._window
        if not w:
            return
        x, y, aw, ah = work_area()
        if collapsed:
            self._full = (w.x, w.y, w.width, w.height)
            w.resize(w.width, 170)
        elif self._full:
            fx, fy, fw, fh = self._full
            self._full = None
            w.resize(fw, fh)
            w.move(fx, fy)


def main():
    stop_other_panels()
    prefs = read_json(PREFS_FILE, {})
    cfg = read_json(CONFIG, {})
    x, y, aw, ah = work_area()
    geo = prefs.get("window") or {}
    width, height = int(geo.get("width") or WIDTH), int(geo.get("height") or ah)
    left, top = int(geo.get("x", x + aw - width)), int(geo.get("y", y))
    if not (x - width < left < x + aw and y - 40 < top < y + ah):  # off-screen (monitor removed): back to the right edge
        left, top, height = x + aw - width, y, ah
    mode = prefs.get("mode") or ("dark" if "dark" in str(cfg.get("theme", "")) else "auto")
    dark = mode == "dark" or (mode == "auto" and system_dark())
    api = Api()
    window = webview.create_window(cfg.get("title", "Agent monitor"), start_ui_server(), js_api=api,
                                   width=width, height=height, x=left, y=top, on_top=True, resizable=True,
                                   min_size=(380, 150), background_color="#1C1B19" if dark else "#E6E4DD", text_select=True)
    api._window = window
    FEED.window = window

    def on_shown():
        set_titlebar_dark(window, dark)

    def on_closing():
        try:
            p = read_json(PREFS_FILE, {})
            if not api._full:  # don't remember the collapsed strip as the window size
                p["window"] = {"x": window.x, "y": window.y, "width": window.width, "height": window.height}
            write_json(PREFS_FILE, p)
        except Exception:
            pass
        FEED.stop()

    window.events.shown += on_shown
    window.events.closing += on_closing
    threading.Thread(target=FEED.run, daemon=True).start()
    webview.start(gui="edgechromium", debug="--debug" in sys.argv)
    FEED.stop()


DEFAULT_CONFIG = {"title": "My agents", "autoDiscover": True, "theme": "studio-auto"}

if __name__ == "__main__":
    if not os.path.exists(CONFIG):
        # No config yet: start in auto-discovery mode (running Claude Code sessions, Codex jobs, usage) with nothing to fill in.
        try:
            write_json(CONFIG, DEFAULT_CONFIG)
        except OSError:
            ctypes.windll.user32.MessageBoxW(None, f"Could not create the config at:\n{CONFIG}", "agent-monitor", 0x30)
            sys.exit(1)
    main()
