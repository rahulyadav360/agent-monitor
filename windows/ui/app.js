// agent-monitor for Windows: the panel UI. A port of Panel.swift (macOS SwiftUI) to plain HTML/CSS/JS.
// The Python host (windows/panel.py) runs status.py --serve and calls window.onStatus(snapshot) every 2 s.
// Opened in a normal browser (for development), it uses demo data and localStorage instead.
"use strict";

// ---------------------------------------------------------------- host bridge
const Host = {
  ready: false,
  api() { return window.pywebview && window.pywebview.api ? window.pywebview.api : null; },
  async call(name, ...args) {
    const a = this.api();
    if (a && a[name]) { try { return await a[name](...args); } catch (e) { console.warn(name, e); } }
    return Fallback[name] ? Fallback[name](...args) : null;
  },
};
// Browser fallback (no Python host): prefs and history in localStorage, demo data from demo.js.
const Fallback = {
  get_prefs() { try { return JSON.parse(localStorage.getItem("am.prefs") || "{}"); } catch (e) { return {}; } },
  set_prefs(p) { try { localStorage.setItem("am.prefs", JSON.stringify(p)); } catch (e) { /* private mode */ } },
  load_history() { try { return JSON.parse(localStorage.getItem("am.history") || "{}"); } catch (e) { return {}; } },
  save_history(h) { try { localStorage.setItem("am.history", JSON.stringify(h)); } catch (e) { /* quota */ } },
  set_collapsed() {},
  system_dark() { return window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches; },
  latest() { return null; },
};

// ---------------------------------------------------------------- state
const St = {
  status: null,
  layout: "studio", mode: "auto", systemDark: false,
  collapsed: false, workersOpen: false,
  expanded: new Set(), raw: new Set(), agentOpen: new Set(),
  th: makeTheme("studio", false), wp: new WorkerPalette(makeTheme("studio", false), []),
  graphs: {},
};

// ---------------------------------------------------------------- usage history (one sample a minute, 24 h)
const History = {
  samples: {}, last: 0, KEEP: 24 * 3600, EVERY: 60,
  async load() {
    const s = (await Host.call("load_history")) || {};
    const cut = Date.now() / 1000 - this.KEEP;
    for (const [k, arr] of Object.entries(s)) {
      const keep = (arr || []).filter((x) => x && x.t >= cut);
      if (keep.length) this.samples[k] = keep;
    }
  },
  key(a) { return a.wid ? a.wid : a.name; },
  spark(key) { return (this.samples[key] || []).slice(-60).map((s) => s.five); },
  record(s) {
    const now = Date.now() / 1000;
    if (!s || now - this.last < this.EVERY) return;
    this.last = now;
    for (const a of s.accounts || []) {
      if (a.unknown === true || !(((a.age || 0) < 600) || a.five >= 100)) continue;
      const k = this.key(a), arr = this.samples[k] || [];
      arr.push({ t: now, five: a.five, seven: a.seven, reset: a.resetIn > 0 ? now + a.resetIn : 0 });
      const i = arr.findIndex((x) => x.t >= now - this.KEEP);
      if (i > 0) arr.splice(0, i);
      this.samples[k] = arr;
    }
    Host.call("save_history", this.samples);
  },
};

// ---------------------------------------------------------------- formatting
const approx = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.max(1, Math.floor(s / 60))}m`);
const dur = (s) => { s = Math.floor(s); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`; };
const secs = (s) => (s < 0 ? "" : s < 60 ? `${s.toFixed(1)}s` : dur(s));
const tok = (t) => (t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : `${Math.floor(t / 1000)}k`);
const num = (v) => (v === Math.round(v) ? Math.round(v).toLocaleString() : v.toFixed(1));
const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
const words = (n) => (n < WORDS.length ? WORDS[n] : String(n));
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const shortDate = () => { const d = new Date(); return `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };
const longDate = () => { const d = new Date(); return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
function progressOf(t) {
  if (!t.steps || !t.steps.length) return 0;
  const done = t.steps.filter((s) => s.status === "done").length, active = t.steps.filter((s) => s.status === "active").length;
  return (done + active * 0.5) / t.steps.length;
}
function firstMetricLine(t) {
  const ms = t.metrics || [];
  const m = ms.find((x) => x.total != null) || ms[0];
  if (!m) return null;
  return `${m.label}: ${m.total != null ? `${num(m.done)} of ${num(m.total)}` : num(m.done)}${m.left ? " · " + m.left : ""}`;
}
/** "W0 Claude-A (orchestrator)" → ["W0", "Claude-A (orchestrator)"] */
function splitWorker(name) {
  const i = name.indexOf(" ");
  const p = i > 0 ? [name.slice(0, i), name.slice(i + 1)] : [name];
  return p.length === 2 && p[0].length <= 3 ? p : [name.slice(0, 2), name];
}
const activeStep = (t) => (t.steps || []).find((s) => s.status === "active");
/** Auto-found sessions without a to-do list have no measurable progress: show live/waiting instead of 0 %. */
const noSteps = (t) => !(t.steps && t.steps.length);
const waiting = (t) => (t.tags || []).includes("needs you");
const progText = (t) => (noSteps(t) ? (waiting(t) ? "your turn" : "live") : `${Math.floor(progressOf(t) * 100)}%`);
/** "3/5" steps done. */
const stepCount = (t) => (noSteps(t) ? "" : `${t.steps.filter((s) => s.status === "done").length}/${t.steps.length}`);
const stepsLabel = (t) => (t.stepsFrom === "asks" ? "YOUR REQUESTS" : t.stepsFrom === "phases" ? "PHASES (GUESSED)" : "SUBTASKS");
const progBar = (t, color, height, radius, segments) => (noSteps(t) ? bar(waiting(t) ? 0 : null, color, St.th.track, height, radius, 0) : bar(progressOf(t), color, St.th.track, height, radius, segments));
/** Main usage window of an account: "5h" normally, "7d" when the plan only has a weekly limit (some Codex plans). */
const win = (a) => (a && a.win === "7d" ? "7d" : "5h");
const winLong = (a) => (win(a) === "7d" ? "weekly" : "5-hour");
const pct = (v) => `${Math.floor(v)}%`;

// ---------------------------------------------------------------- html helpers
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const attr = esc;
const tip = (s) => (s ? ` title="${attr(s)}"` : "");
const when = (c, f) => (c ? (typeof f === "function" ? f() : f) : "");
const each = (arr, f) => (arr || []).map(f).join("");

// Fonts per layout. Studio: Space Grotesk titles, JetBrains Mono labels, Doto LCD digits.
// Mission Control: Barlow Semi Condensed titles, IBM Plex Mono everything else. Paper: Fraunces headlines, Source Sans 3 text.
const F = {
  title(size, w = 700) {
    const L = St.th.layout;
    if (L === "studio") return `font:${w} ${size}px/1.3 'Space Grotesk',var(--sys)`;
    if (L === "mission") return `font:${w >= 700 ? 700 : w >= 600 ? 600 : 500} ${size}px/1.25 'Barlow Semi Condensed','Segoe UI',var(--sys)`;
    return `font:${Math.min(600, Math.max(400, w - 200))} ${size}px/1.3 'Fraunces',Georgia,serif`;
  },
  text(size, w = 400) {
    const L = St.th.layout;
    if (L === "studio") return `font:${Math.max(400, w)} ${size}px/1.42 'Space Grotesk',var(--sys)`;
    if (L === "mission") return F.mono(size, w);
    return `font:${w} ${size}px/1.42 'Source Sans 3',var(--sys)`;
  },
  mono(size, w = 400) {
    const L = St.th.layout;
    if (L === "mission") return `font:${w >= 700 ? 700 : w >= 600 ? 600 : 400} ${size}px/1.4 'IBM Plex Mono',Consolas,monospace`;
    if (L === "paper") return `font:${w} ${size + 0.5}px/1.4 'Source Sans 3',var(--sys);font-variant-numeric:tabular-nums`;
    return `font:${w} ${size}px/1.4 'JetBrains Mono',Consolas,monospace`;
  },
  code(size, w = 400) { return St.th.layout === "mission" ? F.mono(size, w) : `font:${w} ${size}px/1.4 'JetBrains Mono',Consolas,monospace`; },
  lcd(size) { return `font:900 ${size}px/1.05 'Doto','JetBrains Mono',monospace`; },
};
const track = (px) => `letter-spacing:${px}px`;

const usageColor = (p) => (p >= 90 ? St.th.bad : p >= 60 ? St.th.warn : St.th.ok);
function tagRole(t) {
  switch (String(t).toLowerCase()) {
    case "bug": return "bad";
    case "enhancement": case "feature": return "sky";
    case "data": case "research": return "teal";
    case "money": return "warn";
    case "p1": return "hot";
    default: return "neutral";
  }
}
const chip = (r) => St.th.chips[r] || solid("#808080");

// ---------------------------------------------------------------- icons (inline SVG, replaces SF Symbols)
const ICON = {
  check: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.6 8.2l2.2 2.2 4.6-4.8" fill="none" stroke="var(--icon-on,#fff)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  xmark: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2" stroke="var(--icon-on,#fff)" stroke-width="1.8" stroke-linecap="round"/></svg>',
  dotted: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="1.6 2.1"/><circle cx="8" cy="8" r="3.4" fill="currentColor"/></svg>',
  circle: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  clock: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.4V8l2.6 1.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  down: '<svg viewBox="0 0 16 16"><path d="M3.5 6l4.5 4.5L12.5 6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="M6 3.5l4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  sun: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"/></g></svg>',
  moon: '<svg viewBox="0 0 16 16"><path d="M13.6 10.2A6 6 0 0 1 5.8 2.4a6 6 0 1 0 7.8 7.8z" fill="currentColor"/></svg>',
  half: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor"/></svg>',
  collapse: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="9.5" fill="currentColor"/><path d="M6 11.8L10 7.8l4 4" fill="none" stroke="var(--icon-on,#fff)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  expand: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="9.5" fill="currentColor"/><path d="M6 8.2l4 4 4-4" fill="none" stroke="var(--icon-on,#fff)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const icon = (name, size, color, extra = "") => `<span class="ico" style="width:${size}px;height:${size}px;color:${color};${extra}">${ICON[name]}</span>`;

// ---------------------------------------------------------------- shared building blocks
const led = (color, size = 8, glow = true) =>
  `<span class="led" style="width:${size}px;height:${size}px;background:${color};${glow ? `box-shadow:0 0 3px 1px ${withAlpha(color, 0.85)}` : ""}"></span>`;

function bar(value, color, trackC, height = 8, radius = null, segments = 0) {
  if (value != null && segments > 0) {
    const lit = value <= 0 ? 0 : Math.ceil(Math.min(1, value) * segments);
    let cells = "";
    for (let i = 0; i < segments; i++) cells += `<i style="background:${i < lit ? color : trackC}"></i>`;
    return `<div class="bar seg" style="height:${height}px">${cells}</div>`;
  }
  const r = radius == null ? height / 2 : radius;
  if (value == null) return `<div class="bar" style="height:${height}px;border-radius:${r}px;background:${trackC}"><b class="indet" style="background:linear-gradient(90deg,transparent,${color},transparent)"></b></div>`;
  const w = Math.min(1, Math.max(0, value)) * 100;
  return `<div class="bar" style="height:${height}px;border-radius:${r}px;background:${trackC}"><b style="width:max(${height}px,${w}%);border-radius:${r}px;background:${color}"></b></div>`;
}

function pill(text, role, size = 11.5) {
  const th = St.th, c = chip(role), L = th.layout;
  const r = L === "mission" ? 2 : 20;
  const font = L === "paper" ? F.text(size + 0.5, 600) : L === "mission" ? F.mono(size, 600) : F.mono(size, 800);
  return `<span class="pill" style="${font};${L === "studio" ? track(0.6) + ";text-transform:uppercase;" : ""}padding:${L === "mission" ? "2px 6px" : "3px 8px"};color:${c.ink};background:${c.fill};border:1px solid ${c.stroke};border-radius:${r}px">${esc(text)}</span>`;
}

function numTag(text, muted = false) {
  if (!text) return "";
  const th = St.th, c = chip(muted ? "numberMuted" : "number");
  const r = th.layout === "mission" ? 2 : th.layout === "paper" ? 8 : 5;
  return `<span class="pill" style="${F.mono(th.layout === "paper" ? 12.5 : 12, 800)};padding:2px 6px;color:${c.ink};background:${c.fill};border:1px solid ${c.stroke};border-radius:${r}px">${esc(text)}</span>`;
}

function workerBadge(label, wid, size = 11.5) {
  const th = St.th, wp = St.wp, c = wp.of(wid, label), L = th.layout;
  if (!c) return `<span${tip(label)}>${pill(label, "neutral", size)}</span>`;
  const r = L === "mission" ? 2 : 20;
  const font = L === "paper" ? F.text(size + 0.5, 600) : L === "mission" ? F.mono(size, 600) : F.mono(size, 800);
  return `<span class="pill" title="${attr(`${c.wid} · ${c.name}: ${c.hueName} everywhere on this panel.\nColour key: ${wp.key}`)}" style="${font};${L === "studio" ? track(0.6) + ";text-transform:uppercase;" : ""}padding:${L === "mission" ? "2px 6px" : "3px 8px"};color:${c.onFill};background:${c.fill};border:1px solid ${c.stroke};border-radius:${r}px">${esc(label)}</span>`;
}

function workerDot(wid, label, lcd = false, size = 9) {
  const c = St.wp.of(wid, label);
  return c ? `<span class="wdot" title="${attr(`${c.wid} · ${c.name}: ${c.hueName}`)}" style="width:${size}px;height:${size}px;background:${lcd ? c.lcd : c.ink}"></span>` : "";
}

function workerKeyRow(lcd = false) {
  const wp = St.wp;
  return `<span class="row g8 nowrap">${each(wp.workers, (w) => {
    const c = wp.of(w.id);
    if (!c) return "";
    const col = lcd ? c.lcd : c.ink;
    return `<span class="row g4" title="${attr(`${w.id} · ${w.name}: ${c.hueName}`)}"><span class="wdot" style="width:9px;height:9px;background:${col}"></span><span style="${F.mono(11.5, 700)};color:${col}">${esc(w.id)}</span></span>`;
  })}</span>`;
}

function healthRows(hs, labelColor) {
  const th = St.th;
  const groups = [...new Set(hs.map((h) => h.group || ""))].sort();
  return `<div class="col g8">${each(groups, (g) => `<div class="row g18 wrap" style="${F.mono(12.5)};color:${labelColor || th.dim}">${each(hs.filter((h) => (h.group || "") === g),
    (h) => `<span class="row g6 nowrap">${led(h.up ? th.ok : th.bad, 8, th.layout !== "paper")}<span>${esc(h.label)}</span></span>`)}</div>`)}</div>`;
}

function collapseButton() {
  const th = St.th;
  return `<button class="iconbtn" data-act="collapse" title="${St.collapsed ? "Expand" : "Collapse"}" style="--icon-on:${th.layout === "studio" ? "#0F0F10" : th.bg}">${icon(St.collapsed ? "expand" : "collapse", 19, th.layout === "studio" ? th.accent : th.accentText)}</button>`;
}

/** Wrapping text, clamped to `lines`, full text in the tooltip. */
const wrap = (text, font, color, lines = 2, extra = "") =>
  `<div class="clamp" title="${attr(text)}" style="${font};color:${color || St.th.text};-webkit-line-clamp:${lines};${extra}">${esc(text)}</div>`;
const line1 = (text, font, color, extra = "") =>
  `<span class="one" title="${attr(text)}" style="${font};color:${color || St.th.text};${extra}">${esc(text)}</span>`;

// ---------------------------------------------------------------- task details (shared by all layouts)
function taskDetails(t) {
  const th = St.th, L = th.layout;
  const live = t.lastActive < 60 ? th.ok : t.lastActive < 300 ? th.warn : th.bad;
  const sub = (s) => (L === "paper"
    ? `<div style="${F.title(15, 600)};color:${th.dim}">${esc(s[0] + s.slice(1).toLowerCase())}</div>`
    : `<div style="${F.mono(11.5, 800)};${track(1.4)};color:${th.faint}">${esc(s)}</div>`);
  const raw = St.raw.has(t.key);
  let h = `<div class="col g12"><div class="rule" style="background:${th.line}"></div>`;
  h += `<div class="row g12 wrap" style="${F.mono(12.5)};color:${th.dim}"><span class="row g4">${icon("clock", 13, th.dim)}running ${dur(t.elapsed)}</span>${led(live, 8, L === "mission")}<span>${t.lastActive < 60 ? "active now" : `last activity ${dur(t.lastActive)} ago`}</span>${when(t.failovers > 0, () => pill(`switched account ×${t.failovers}`, "violet"))}</div>`;
  if (t.metrics && t.metrics.length) {
    h += `<div class="col g12">${sub("PROGRESS NUMBERS")}${each(t.metrics, (m) => {
      const bad = m.kind === "bad" && m.done > 0;
      return `<div class="col g6"><div class="row g8 base"><div class="grow">${wrap(m.label, F.text(13.5), bad ? th.bad : th.text)}</div><span class="nowrap" style="${F.mono(13, 700)};color:${bad ? th.bad : th.text}">${m.total != null ? `${num(m.done)} / ${num(m.total)}` : num(m.done)}</span></div>${
        when(m.total != null, () => bar(m.done / m.total, m.kind === "bad" ? th.bad : th.ok, th.track, L === "mission" ? 4 : 6, L === "mission" ? 0 : null, L === "mission" ? 24 : 0))}${
        when(m.rate || m.left, () => `<div style="${F.mono(11.5)};color:${th.faint}">${esc([m.rate, m.left].filter(Boolean).join(" · "))}</div>`)}</div>`;
    })}</div>`;
  }
  h += `<div class="col g8">${sub(stepsLabel(t))}${each(t.steps, (s) => {
    const ic = s.status === "done" ? icon("check", 14, th.ok, `--icon-on:${th.layout === "studio" ? th.surface : th.bg}`) : s.status === "active" ? icon("dotted", 14, th.accentText) : icon("circle", 14, th.faint);
    return `<div class="row g8 top">${ic}<div class="grow">${wrap(s.title, F.text(13.5, s.status === "active" ? 600 : 400), s.status === "pending" ? th.faint : th.text)}</div></div>`;
  })}</div>`;
  if ((t.recent && t.recent.length) || t.commands > 0) {
    h += `<div class="col g8"><button class="plain row g6" data-act="raw" data-key="${attr(t.key)}" style="${F.mono(11.5, 700)};color:${th.faint}">${icon(raw ? "down" : "right", 11, th.faint)}<span class="one">RAW ACTIVITY · ${t.commands} commands · ${t.edits} edits · ${tok(t.tokens)} tokens</span></button>${
      when(raw, () => each(t.recent, (c) => {
        const ic = c.state === "running" ? `<span class="spin" style="border-color:${th.accentText} transparent ${th.accentText} ${th.accentText}"></span>` : icon(c.state === "ok" ? "check" : "xmark", 13, c.state === "ok" ? th.ok : th.bad);
        return `<div class="row g8 top">${ic}<div class="grow">${wrap(c.cmd, F.code(12), c.state === "running" ? th.text : th.dim)}</div><span class="nowrap" style="${F.mono(11.5)};color:${c.state === "running" ? th.accentText : th.faint}">${secs(c.secs)}</span></div>`;
      }))}</div>`;
  }
  if (t.note) h += `<div class="col g6">${sub("LATEST NOTE")}${wrap(t.note, F.text(13.5), th.dim, 4)}</div>`;
  return h + "</div>";
}

// ---------------------------------------------------------------- worker stats, facts and graphs
function workerStats(a, samples) {
  const now = Date.now() / 1000;
  const limited = (a ? a.five : 0) >= 100;
  const resets = [];
  for (let i = 1; i < samples.length; i++) {
    const p = samples[i - 1], c = samples[i];
    const byTime = p.reset > 0 && p.reset <= c.t + 30;
    if (byTime || p.five - c.five >= 15) resets.push(byTime ? Math.max(p.t, p.reset) : c.t);
  }
  let burn = null;
  const from = Math.max(now - 90 * 60, resets.length ? resets[resets.length - 1] : 0);
  const s = samples.filter((x) => x.t >= from);
  if (s.length && s[s.length - 1].t - s[0].t >= 600) burn = Math.max(0, (s[s.length - 1].five - s[0].five) / ((s[s.length - 1].t - s[0].t) / 3600));
  const limitIn = a && !limited && burn != null && burn >= 0.2 ? Math.floor(((100 - a.five) / burn) * 3600) : null;
  const resetsFirst = limitIn != null && a && a.resetIn > 0 ? limitIn > a.resetIn : false;
  const limitText = limited ? "at limit" : burn == null ? "—" : limitIn == null ? "not at this rate" : resetsFirst ? "resets first" : "~" + approx(limitIn);
  const burnText = burn == null ? "—" : burn >= 10 ? `${burn.toFixed(0)}%/h` : `${burn.toFixed(1)}%/h`;
  return { limited, resets, burn, limitIn, limitText, burnText };
}

function workerFacts(w, a, st) {
  const five = a ? (a.unknown === true ? "—" : a.five >= 100 ? "LIMIT" : pct(a.five)) : "—";
  const seven = a ? (a.unknown === true ? "—" : pct(a.seven)) : "—";
  const resetIn = a && a.resetIn > 0 ? approx(a.resetIn) : "—";
  const live = w.lanes.filter((l) => !l.stale);
  const lanesValue = !w.lanes.length ? "0" : live.length === w.lanes.length ? `${w.lanes.length}` : `${live.length} +${w.lanes.length - live.length} stale`;
  const doneValue = `${w.doneToday}` + ((w.failedToday || 0) > 0 ? ` · ${w.failedToday} failed` : "");
  const idleValue = w.idleSecs === 0 ? "busy" : w.idleSecs < 0 ? "—" : approx(w.idleSecs);
  const spare = a && a.unknown !== true && !st.limited && w.idleSecs >= 600 && a.five < 85
    ? `Spare capacity: idle ${approx(w.idleSecs)} with ${100 - Math.floor(a.five)}% of the ${winLong(a)} window left` : null;
  const cells = [["Resets in", resetIn, "Time until the 5-hour window resets"],
    ["Burn", st.burnText, "5-hour usage per hour over the last 90 minutes"],
    ["Limit in", st.limitText, "Estimated time until 100% at the current rate"],
    ["Lanes now", lanesValue, "Jobs running in parallel now (stale = no update for 30+ min)"],
    ["Done today", doneValue, "Jobs this worker finished since midnight"],
    ["Idle", idleValue, "Time since its last job ended, while nothing is running"]];
  return { w, a, st, five, seven, resetIn, spare, cells };
}

const graphSpan = (s) => { const now = Date.now() / 1000; return Math.min(24 * 3600, Math.max(3 * 3600, now - (s.length ? s[0].t : now))); };

/** A placeholder the post-render pass draws into once its width is known. */
function usageGraph(id, samples, resets, color, height) {
  St.graphs[id] = { samples, resets, color, height };
  return `<div class="graph" data-keep data-graph="${attr(id)}" style="height:${height}px"></div>`;
}

function drawGraph(el, g) {
  const th = St.th, W = Math.max(40, Math.floor(el.clientWidth)), H = g.height;
  const now = Date.now() / 1000, span = graphSpan(g.samples), t0 = now - span;
  const sig = [th.id, W, H, g.color, g.samples.length, g.samples.length ? g.samples[g.samples.length - 1].t : 0, Math.floor(now / 60)].join("|");
  if (el.dataset.sig === sig) return;
  el.dataset.sig = sig;
  const xOf = (t) => ((t - t0) / span) * W;
  const yOf = (v) => H * (1 - Math.min(100, Math.max(0, v)) / 100);
  const resetColor = th.layout === "studio" ? "rgba(255,255,255,0.45)" : th.faint;
  let svg = "";
  if (th.layout === "studio") {
    // Dot matrix, 5 px pitch: 5h fills columns from the bottom; 7d is one bright dot per column; resets light a dashed column.
    const pitch = 5, dot = 3, cols = Math.floor(W / pitch), rows = Math.floor(H / pitch);
    for (let ci = 0; ci < cols; ci++) {
      const a = t0 + (span * ci) / cols, b = t0 + (span * (ci + 1)) / cols;
      const bucket = g.samples.filter((s) => s.t >= a && s.t < b);
      let near = null;
      if (!bucket.length) for (let i = g.samples.length - 1; i >= 0; i--) { const s = g.samples[i]; if (s.t < a) { if (a - s.t < 600) near = s; break; } }
      const v5 = bucket.length ? Math.max(...bucket.map((s) => s.five)) : near ? near.five : null;
      const v7 = bucket.length ? bucket[bucket.length - 1].seven : near ? near.seven : null;
      const isReset = g.resets.some((r) => r >= a && r < b);
      const lit = v5 == null ? -1 : Math.round((v5 / 100) * rows);
      const r7 = v7 == null ? -1 : Math.max(0, Math.round((v7 / 100) * rows) - 1);
      for (let ri = 0; ri < rows; ri++) {
        let c;
        if (isReset && ri % 2 === 0) c = resetColor;
        else if (ri === r7) c = "rgba(255,255,255,0.85)";
        else if (ri < lit) c = ri === lit - 1 ? g.color : withAlpha(g.color, 0.78);
        else c = "rgba(255,255,255,0.07)";
        svg += `<rect x="${ci * pitch + 1}" y="${H - (ri + 1) * pitch + 1}" width="${dot}" height="${dot}" rx="0.8" fill="${c}"/>`;
      }
    }
  } else {
    for (const gl of [0.25, 0.5, 0.75, 1.0]) {
      const y = (H * (1 - gl)) + (gl === 1 ? 0.5 : 0);
      svg += `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="${gl === 1 ? th.line : withAlpha(th.line, 0.8)}" stroke-width="1"${th.layout === "paper" && gl < 1 ? ' stroke-dasharray="2 4"' : ""}/>`;
    }
    const runs = [];
    for (const s of g.samples) {
      if (s.t < t0 - 300) continue;
      const r = runs[runs.length - 1];
      if (r && s.t - r[r.length - 1].t <= 900) r.push(s); else runs.push([s]);
    }
    const gid = "g" + Math.random().toString(36).slice(2, 8);
    if (th.layout === "paper") svg += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${g.color}" stop-opacity="${th.dark ? 0.35 : 0.22}"/><stop offset="1" stop-color="${g.color}" stop-opacity="0.02"/></linearGradient></defs>`;
    for (const run of runs) {
      const f = run[0], l = run[run.length - 1];
      const area = `M${xOf(f.t)},${H} ` + run.map((s) => `L${xOf(s.t).toFixed(1)},${yOf(s.five).toFixed(1)}`).join(" ") + ` L${xOf(l.t)},${H} Z`;
      svg += `<path d="${area}" fill="${th.layout === "paper" ? `url(#${gid})` : withAlpha(g.color, th.dark ? 0.16 : 0.10)}"/>`;
      const p5 = run.map((s, i) => `${i ? "L" : "M"}${xOf(s.t).toFixed(1)},${yOf(s.five).toFixed(1)}`).join(" ");
      const p7 = run.map((s, i) => `${i ? "L" : "M"}${xOf(s.t).toFixed(1)},${yOf(s.seven).toFixed(1)}`).join(" ");
      svg += `<path d="${p7}" fill="none" stroke="${withAlpha(g.color, 0.75)}" stroke-width="1.25" stroke-linecap="round" stroke-dasharray="3 3"/>`;
      svg += `<path d="${p5}" fill="none" stroke="${g.color}" stroke-width="${th.layout === "paper" ? 2 : 1.5}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    for (const r of g.resets) if (r >= t0) svg += `<line x1="${xOf(r)}" x2="${xOf(r)}" y1="0" y2="${H}" stroke="${resetColor}" stroke-width="1" stroke-dasharray="2 3"/>`;
    if (g.samples.length) { const l = g.samples[g.samples.length - 1]; svg += `<circle cx="${xOf(l.t)}" cy="${yOf(l.five)}" r="3" fill="${g.color}"/>`; }
  }
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${svg}</svg>`;
}

function graphCaption(samples, color, lcd = false) {
  const th = St.th, S = th.layout === "studio";
  const hours = Math.round(graphSpan(samples) / 3600);
  const dim = lcd ? th.lcdDim : th.dim, reset = lcd ? "rgba(255,255,255,0.6)" : th.faint;
  const seven = lcd ? `<span class="led" style="width:4px;height:4px;background:rgba(255,255,255,0.85)"></span>`
    : `<span class="row" style="gap:2px">${"<i style=\"display:block;width:3px;height:1.5px;background:" + withAlpha(color, 0.75) + "\"></i>".repeat(3)}</span>`;
  return `<div class="row g8 nowrap" style="${F.mono(11.5, S ? 700 : 400)};color:${dim}">
    <span>${S ? `−${hours}H` : `−${hours} h`}</span><span class="grow"></span>
    <span class="row g4"><i style="display:block;width:12px;height:3px;background:${color}"></i>${S ? "5H" : "5-hour"}</span>
    <span class="row g4">${seven}${S ? "7D" : "7-day"}</span>
    <span class="row g4"><span style="color:${reset}">┆</span>${S ? "RESET" : "reset"}</span>
    <span class="grow"></span><span>${S ? "NOW" : "now"}</span></div>`;
}

function workerJobs(f, color, text, dim) {
  const th = St.th, tx = text || th.text, dm = dim || th.faint, L = th.layout, w = f.w;
  let h = `<div class="col g6">`;
  if (!w.lanes.length && !w.pipeline.length && !w.doneIds.length) h += `<div style="${F.mono(12.5)};color:${dm}">${L === "studio" ? "NO JOBS YET TODAY" : "No jobs yet today"}</div>`;
  h += each(w.lanes, (l) => `<div class="row g8 base"><span class="mark" style="${F.mono(12.5, 800)};color:${l.stale ? dm : color}">${l.stale ? "◌" : "▶"}</span><span class="nowrap" style="${F.mono(13, 700)};color:${l.stale ? dm : color}">${esc(l.id)}</span>${line1(l.title + (l.stale ? " · stale" : ""), F.text(13), l.stale ? dm : tx)}</div>`);
  if (w.pipeline.length) {
    h += `<div style="${L === "paper" ? F.text(13, 600) : F.mono(11.5, 700) + ";" + track(1.2)};color:${dm};padding-top:2px">${L === "paper" ? "Up next" : "UP NEXT"}</div>`;
    h += each(w.pipeline, (q) => `<div class="row g8 base"><span class="mark" style="${F.mono(12.5, 800)};color:${dm}">${q.blocked ? "✋" : q.likely ? "?" : "⧗"}</span><span class="nowrap" style="${F.mono(13, 700)};color:${tx}">${esc(q.id)}</span>${line1(q.title + (q.likely ? " · likely" : "") + (q.blocked ? " · needs you" : ""), F.text(13), dm)}</div>`);
  }
  if (w.doneIds.length) h += `<div class="row g8 base"><span class="mark" style="${F.mono(12.5, 800)};color:${dm}">✓</span>${line1((L === "paper" ? "Finished today: " : "DONE: ") + w.doneIds.slice(-6).join(" · "), F.mono(12.5), dm)}</div>`;
  return h + "</div>";
}

function workersDrawer(s) {
  const th = St.th, wp = St.wp;
  return `<div class="col" style="gap:${th.layout === "mission" ? 0 : 12}px">${each(wp.workers, (w) => {
    const a = (s.accounts || []).find((x) => (x.wid || "") === w.id) || (s.accounts || []).find((x) => x.name === w.account);
    const samples = a ? History.samples[History.key(a)] || [] : [];
    const f = workerFacts(w, a, workerStats(a, samples));
    const c = wp.of(w.id);
    if (!c) return "";
    return th.layout === "studio" ? studioWorker(f, c, samples) : th.layout === "mission" ? mcWorker(f, c, samples) : paperWorker(f, c, samples);
  })}</div>`;
}

// ---------------------------------------------------------------- theme picker (styled per layout)
function themePicker() {
  const th = St.th, L = th.layout;
  const modeLabel = (m) => (m === "auto" ? "Auto" : m === "dark" ? "Dark" : "Light");
  const tipL = (l) => `${LAYOUT_LABEL[l]} · ${th.dark ? "Dark" : "Light"}  (Ctrl+T cycles layouts)`;
  const tipM = (m) => (m === "auto" ? "Auto: follow Windows light/dark  (Ctrl+Shift+T flips light/dark)" : `${LAYOUT_LABEL[St.layout]} · ${modeLabel(m)}  (Ctrl+Shift+T flips light/dark)`);
  if (L === "studio") {
    const key = (inner, on, act, val, t, w) => `<button class="key" data-act="${act}" data-val="${val}" title="${attr(t)}" style="${w ? `flex:0 0 ${w}px;` : "flex:1;"}${F.mono(11.5, 800)};${track(1.2)};color:${on ? "#000" : th.text};background:${on ? th.accent : th.surface};border-color:${th.ink};--drop:${th.ink}">${inner}</button>`;
    return `<div class="row g8" style="padding-bottom:3px">${each(LAYOUTS, (l) => key(l === "mission" ? "MISSION" : LAYOUT_LABEL[l].toUpperCase(), St.layout === l, "layout", l, tipL(l)))}
      <span style="width:1px;height:26px;background:${th.line}"></span>
      ${each(MODES, (m) => key(icon(m === "auto" ? "half" : m === "dark" ? "moon" : "sun", 14, St.mode === m ? "#000" : th.text), St.mode === m, "mode", m, tipM(m), 40))}</div>`;
  }
  if (L === "mission") {
    let h = `<div class="row mc-pick" style="align-items:stretch">`;
    for (const l of LAYOUTS) {
      const on = St.layout === l;
      h += `<button class="plain col" data-act="layout" data-val="${l}" title="${attr(tipL(l))}" style="flex:1;min-width:0;gap:3px;padding:7px 9px;align-items:flex-start;background:${on ? th.surfaceAlt : "transparent"};${on ? `box-shadow:inset 0 -2px 0 ${th.accent}${th.dark ? `, 0 2px 6px -2px ${withAlpha(th.accent, 0.8)}` : ""}` : ""}">
        <span class="row g4" style="color:${on ? th.accent : th.text}">${led(on ? th.accent : th.faint, 6, on)}<span class="one" style="${F.title(13.5, 600)};${track(1.4)}">${l === "mission" ? "MISSION" : LAYOUT_LABEL[l].toUpperCase()}</span></span>
        <span class="one" style="${F.mono(11.5)};color:${th.dim}">${l === "studio" ? "LCD · keys" : l === "mission" ? "dense · rules" : "serif · calm"}</span></button><span style="width:1px;background:${th.line}"></span>`;
    }
    MODES.forEach((m, i) => {
      const on = St.mode === m;
      h += `<button class="plain" data-act="mode" data-val="${m}" title="${attr(tipM(m))}" style="flex:0 0 50px;${F.mono(11.5, 600)};${track(1)};color:${on ? th.accent : th.dim};background:${on ? th.surfaceAlt : "transparent"};${on ? `box-shadow:inset 0 -2px 0 ${th.accent}` : ""}">${m.toUpperCase()}</button>${i < 2 ? `<span style="width:1px;background:${th.line}"></span>` : ""}`;
    });
    return h + "</div>";
  }
  const seg = (label, on, act, val, t) => `<button class="plain" data-act="${act}" data-val="${val}" title="${attr(t)}" style="flex:1;min-width:0;padding:6px 4px;border-radius:10px;${F.text(13.5, on ? 600 : 400)};color:${on ? th.text : th.faint};background:${on ? th.surface : "transparent"};${on ? `box-shadow:0 1px 3px rgba(0,0,0,${th.dark ? 0.35 : 0.08})` : ""}"><span class="one">${esc(label)}</span></button>`;
  return `<div class="row g8"><div class="row g4 grow" style="padding:4px;border-radius:14px;background:${th.bg2}">${each(LAYOUTS, (l) => seg(LAYOUT_LABEL[l], St.layout === l, "layout", l, tipL(l)))}</div>
    <div class="row g4" style="flex:0 0 168px;padding:4px;border-radius:14px;background:${th.bg2}">${each(MODES, (m) => seg(modeLabel(m), St.mode === m, "mode", m, tipM(m)))}</div></div>`;
}

// ================================================================ STUDIO layout (warm-grey body, LCD blocks, chunky keys)
function lcd(inner, edge = null, extra = "") {
  const th = St.th;
  return `<div class="lcd" style="background:${edge ? `linear-gradient(90deg,${edge} 9px,${th.lcd} 9px)` : th.lcd};border-color:${th.lcdLine};color:${th.lcdText};${edge ? "padding-left:18px;" : ""}${extra}">${inner}</div>`;
}
function keyCard(inner, { fill = null, highlight = false, edge = null, act = "", key = "" } = {}) {
  const th = St.th, f = fill || th.surface;
  return `<div class="keycard${act ? " click" : ""}"${act ? ` data-act="${act}" data-key="${attr(key)}"` : ""} style="background:${edge ? `linear-gradient(90deg,${edge} 7px,${f} 7px)` : f};border-color:${highlight ? th.accent : th.ink};--drop:${edge || th.ink};--dropline:${th.ink};${edge ? "padding-left:18px;" : ""}">${inner}</div>`;
}
function studioLabel(title, count = null, open = null) {
  const th = St.th;
  return `<div class="row g8 nowrap">${when(open != null, () => icon(open ? "down" : "right", 11, th.accentText))}<span class="one" style="${F.mono(11.5, 800)};${track(2.2)};color:${open == null ? th.faint : th.text};flex:0 1 auto">${esc(title)}</span><span class="grow rule" style="background:${th.line}"></span>${when(open != null, () => workerKeyRow())}${when(count, () => `<span class="nowrap" style="${F.mono(11.5, 800)};${track(1.6)};color:${th.accentText}">${esc(String(count).toUpperCase())}</span>`)}</div>`;
}
function studioTask(t) {
  const th = St.th, wp = St.wp, ex = St.expanded.has(t.key), a = activeStep(t), m = firstMetricLine(t);
  const inner = `<div class="col" style="gap:10px">
    <div class="row g8 top">${`<span style="padding-top:2px">${numTag(t.id)}</span>`}<div class="grow">${wrap(t.title, F.title(16, 700), th.text)}</div>${workerBadge(t.account, t.wid)}</div>
    ${when(t.summary, () => wrap(t.summary, F.text(13.5, 400), th.dim))}
    ${when(t.tags && t.tags.length, () => `<div class="row g6 wrap">${each(t.tags, (g) => pill(g, tagRole(g)))}</div>`)}
    <div class="row base"><span style="${F.mono(11.5, 800)};${track(1.4)};color:${th.faint}">${noSteps(t) ? (waiting(t) ? "WAITING FOR YOU" : "WORKING") : t.estimated ? "PROGRESS (ESTIMATED)" : "PROGRESS"}</span><span class="grow"></span>${when(!noSteps(t), () => `<span style="${F.mono(11.5, 700)};color:${th.faint};margin-right:8px">${stepCount(t)} done</span>`)}<span style="${F.mono(14, 800)}">${noSteps(t) ? "" : progText(t)}</span></div>
    ${progBar(t, th.progress, 8)}
    ${when(!ex && a, () => line1(`● ${a.title}`, F.mono(12.5, 700), th.accentText))}
    ${when(!ex && m, () => line1(m, F.mono(12.5, 700), th.text))}
    ${when(ex, () => taskDetails(t))}</div>`;
  return keyCard(inner, { highlight: ex, edge: (wp.of(t.wid, t.account) || {}).ink, act: "task", key: t.key });
}
function studioAgent(a) {
  const th = St.th, ex = St.agentOpen.has(a.title);
  const inner = `<div class="col g8">
    <div class="row g8">${pill("Claude agent", "claude")}<span style="${F.mono(11.5, 800)};${track(1)};color:${th.faint}">${a.tools} ACTIONS</span><span class="grow"></span>${led(a.lastActive < 60 ? th.ok : th.warn, 8, false)}</div>
    ${wrap(a.title, F.title(15, 700), th.text, ex ? 3 : 2)}
    ${bar(null, th.claude, th.track, 6)}
    ${when(!ex && a.recent.length, () => line1(`▸ ${a.recent[0]}`, F.mono(12.5), th.dim))}
    ${when(ex, () => a.recent.map((r, i) => wrap((i === 0 ? "▶ " : "✓ ") + r, F.code(12.5), i === 0 ? th.text : th.dim)).join(""))}</div>`;
  return keyCard(inner, { highlight: ex, act: "agent", key: a.title });
}
function studioWorker(f, c, samples) {
  const th = St.th;
  return lcd(`<div class="col g8">
    <div class="row g8">${workerBadge(f.w.id, f.w.id, 12)}${line1(f.w.name.toUpperCase(), F.mono(13, 700), "#FFFFFF")}${when(f.a, () => pill(f.a.tool, "neutral", 11))}<span class="grow"></span>
      <span class="nowrap" style="${F.lcd(30)};color:${f.st.limited ? "#FF6B5E" : c.lcd};text-shadow:0 0 5px ${withAlpha(c.lcd, 0.35)}">${esc(f.five)}</span>
      <span class="col nowrap" style="${F.mono(11.5, 700)};color:${th.lcdDim};line-height:1.25"><span>${win(f.a).toUpperCase()}</span><span>${win(f.a) === "7d" ? "WEEKLY" : `7D ${esc(f.seven)}`}</span></span></div>
    ${usageGraph("w-" + f.w.id, samples, f.st.resets, c.lcd, 60)}
    ${graphCaption(samples, c.lcd, true)}
    <div class="rule" style="background:${th.lcdLine}"></div>
    <div class="grid3">${each(f.cells, (cell) => `<div class="col" style="gap:2px;min-width:0" title="${attr(cell[2])}"><span class="one" style="${F.mono(11.5, 700)};${track(1)};color:${th.lcdDim}">${esc(cell[0].toUpperCase())}</span><span class="one" style="${F.mono(13.5, 700)};color:#EEEEEE">${esc(cell[1].toUpperCase())}</span></div>`)}</div>
    ${when(f.spare, () => wrap("◆ " + f.spare, F.mono(12.5, 700), "#35E07F"))}
    <div class="rule" style="background:${th.lcdLine}"></div>
    ${workerJobs(f, c.lcd, "#DDDDDD", th.lcdDim)}</div>`, c.lcd);
}
function studioPanel() {
  const th = St.th, wp = St.wp, s = St.status, C = St.collapsed;
  let h = `<div class="col g16" style="padding:14px;color:${th.text}">`;
  let top = `<div class="col g6"><div class="row g8">${led("#35E07F", 7)}${line1((s ? s.title : "Agent monitor").toUpperCase(), F.mono(11.5, 700) + ";" + track(1.8), th.lcdDim)}<span class="grow"></span><span class="nowrap" style="${F.mono(11.5, 700)};${track(1.8)};color:${th.lcdDim}">${shortDate().toUpperCase()}</span>${collapseButton()}</div>`;
  if (!C) top += `<div style="${F.lcd(40)};color:#F4F4F4;text-shadow:0 0 7px rgba(255,255,255,0.28)">${esc(s ? s.time : "--:--:--")}</div>`;
  if (s) {
    const q = s.queued || [], blocked = q.filter((x) => x.blocked).length;
    top += `<div class="row g12 nowrap clip" style="${F.mono(11.5, 700)};${track(1)};color:#BDBDBD">
      <span style="color:#fff">${C ? `▶${s.running.length}` : `▶ ${s.running.length} RUNNING`}</span><span>${C ? `⧗${q.length}` : `${q.length} WAITING`}</span>
      ${when(blocked > 0, () => `<span style="color:#FF7A45">${C ? `✋${blocked}` : `${blocked} NEED YOU`}</span>`)}
      ${when(s.agents.length, () => `<span>${C ? `◆${s.agents.length}` : `${s.agents.length} AGENTS`}</span>`)}
      ${when(C, () => each(s.accounts, (a) => `<span style="color:${a.five >= 100 ? "#FF6B5E" : (wp.of(a.wid, a.name) || {}).lcd || "#BDBDBD"}">${esc(splitWorker(a.name)[0])} ${a.five >= 100 ? "LIMIT" : pct(a.five)}</span>`))}</div>`;
    if (!C && wp.workers.length) {
      top += `<button class="plain row g12 nowrap clip" data-act="workers" title="${attr(`Workers: click to ${St.workersOpen ? "close" : "open"} the drawer.  Colour key: ${wp.key}`)}" style="${F.mono(11.5, 700)};${track(1)};width:100%">${each(wp.workers, (w) => {
        const a = (s.accounts || []).find((x) => (x.wid || "") === w.id);
        const txt = a ? (a.unknown === true ? "—" : a.five >= 100 ? "LIMIT" : pct(a.five)) : "—";
        return `<span class="row g4">${workerDot(w.id, null, true, 8)}<span style="color:${a && a.five >= 100 ? "#FF6B5E" : (wp.of(w.id) || {}).lcd || "#BDBDBD"}">${esc(w.id)} ${txt}</span></span>`;
      })}<span class="grow"></span><span style="color:${th.lcdDim}">${St.workersOpen ? "WORKERS ▾" : "WORKERS ▸"}</span></button>`;
    }
  }
  h += lcd(top + "</div>");
  if (!C) {
    h += themePicker();
    h += s ? studioSections(s) : `<div style="${F.mono(12, 800)};color:${th.faint}">LOADING…</div>`;
  }
  return h + "</div>";
}
function studioSections(s) {
  const th = St.th, wp = St.wp, q = s.queued || [];
  let h = `<div class="col g10"><button class="plain" data-act="workers" title="${St.workersOpen ? "Close the Workers drawer" : "Open the Workers drawer: usage graph, burn rate, lanes and pipeline per worker"}" style="width:100%">${studioLabel("WORKERS", null, St.workersOpen)}</button>`;
  if (St.workersOpen && wp.workers.length) h += workersDrawer(s);
  else h += each(s.accounts, (a) => {
    const stale = (a.age || 0) >= 600, wc = wp.of(a.wid, a.name);
    const right = a.unknown === true ? `<span style="${F.mono(12.5)};color:${th.lcdDim}">not known yet</span>`
      : a.five >= 100 ? `<span class="nowrap" style="${F.mono(12.5, 800)};color:#FF6B5E">LIMIT → ${dur(a.resetIn)}</span>`
        : `<span class="nowrap" style="${F.mono(12.5, 600)};color:${stale ? th.lcdDim : "#DDDDDD"}">${win(a) === "7d" ? `7d ${pct(a.five)} (weekly)` : `5h ${pct(a.five)} · 7d ${pct(a.seven)}`}</span>`;
    const barC = stale ? "#777777" : a.five >= 90 ? "#FF6B5E" : (wc && wc.lcd) || (a.five >= 60 ? "#E3A13A" : "#35E07F");
    return lcd(`<div class="col g6"><div class="row g8 base">${line1(a.name, F.mono(13, 700), (wc && wc.lcd) || "#FFFFFF")}${pill(a.tool, "neutral", 11)}<span class="grow"></span>${right}</div>
      ${bar(a.unknown === true ? 0 : a.five / 100, barC, "#2A2A2A", 6, 3)}
      <div class="row g8 wrap" style="${F.mono(11.5)};color:${th.lcdDim}">${when(a.resetIn > 0 && a.five < 100 && a.unknown !== true, () => `<span>↻ ${winLong(a)} window resets in ${dur(a.resetIn)}</span>`)}${when(a.age != null && a.age >= 600, () => `<span style="color:#F0B54A">· reading from ${dur(a.age)} ago</span>`)}</div></div>`, wc ? wc.lcd : null);
  });
  h += `</div><div class="col g10">${studioLabel("IN PROGRESS", String(s.running.length))}${s.running.length ? "" : `<div style="${F.mono(12.5)};color:${th.faint}">Nothing running</div>`}${each(s.running, studioTask)}</div>`;
  if (q.length) {
    h += `<div class="col g10">${studioLabel("UP NEXT", `${q.length} waiting`)}${each(q, (x) => keyCard(`<div class="col g6">
      <div class="row g8 top"><span style="padding-top:2px">${numTag(x.id, true)}</span><div class="grow">${wrap(x.title, F.title(15, 700), th.text)}</div>${when(x.worker, () => workerBadge(x.worker, x.wid))}</div>
      ${when(x.summary, () => wrap(x.summary, F.text(13.5), th.dim))}
      <div class="row g8 base"><span style="${F.mono(12.5, 800)}">${x.blocked ? "✋" : "⧗"}</span><div class="grow">${wrap(x.waitingFor, F.mono(12.5, x.blocked ? 700 : 400), x.blocked ? th.accentText : th.faint)}</div></div></div>`,
    { fill: x.blocked ? th.keyAlert : th.keyQueue }))}</div>`;
  }
  if (s.agents.length) h += `<div class="col g10">${studioLabel("CLAUDE AGENTS", `${s.agents.length} running`)}${each(s.agents, studioAgent)}</div>`;
  h += `<div class="col g10">${studioLabel("RECENTLY FINISHED", s.finished.length ? String(s.finished.length) : null)}${lcd(`<div class="col g8">${s.finished.length ? "" : `<div style="${F.mono(12.5)};color:${th.lcdDim}">nothing yet</div>`}${each(s.finished, (d) => {
    const c = wp.of(d.wid);
    return `<div class="row g8 base"><span class="mark" style="${F.mono(13, 800)};color:${d.ok ? "#35E07F" : "#FF6B5E"}">${d.ok ? "✓" : "✕"}</span><span style="${F.mono(12.5, 800)};color:#F4F4F4;min-width:30px">${esc(d.id)}</span>${line1(d.title, F.mono(12.5), "#DDDDDD")}<span class="grow"></span>${when(c, () => `<span class="nowrap" title="${attr(`${c.wid} · ${c.name}`)}" style="${F.mono(12.5, 800)};color:${c.lcd}">${esc(c.wid)}</span>`)}<span class="nowrap" style="${F.mono(12.5)};color:${th.lcdDim}">${esc(d.time)}</span></div>`;
  })}</div>`)}</div>`;
  h += `<div class="col g10">${studioLabel("REPO & HEALTH", s.repo || null)}${lcd(`<div class="col g8">${wrap(s.commit, F.code(12.5), "#DDDDDD")}${s.changes.length ? "" : `<div style="${F.mono(12)};color:${th.lcdDim}">working tree clean</div>`}${each(s.changes, (c) => `<div class="row g8">${line1(c.area, F.code(12.5), th.lcdText)}<span class="grow"></span><span class="nowrap" style="${F.mono(12.5, 700)};color:#F0B54A">${c.files} files changed</span></div>`)}${
    when(s.health && s.health.length, () => `<div class="rule" style="background:${th.lcdLine}"></div>${healthRows(s.health, "#DDDDDD")}`)}</div>`)}</div>`;
  return h;
}

// ================================================================ MISSION CONTROL layout (dense rows, rules, LEDs, ticker, KPIs, sparklines)
const rule = (op = 1) => `<div class="rule" style="background:${op === 1 ? St.th.line : withAlpha(St.th.line, op)}"></div>`;
const vrule = () => `<span style="width:1px;align-self:stretch;background:${St.th.line}"></span>`;
function mcHead(title, count = null, trailing = null, open = null) {
  const th = St.th;
  return `<div class="row g8 nowrap" style="padding:16px 12px 8px">${when(open != null, () => icon(open ? "down" : "right", 10, th.accent))}<span style="${F.mono(11.5, 600)};${track(2.4)};color:${open == null ? th.dim : th.text}">${esc(title)}</span>${when(count, () => `<span style="${F.mono(11.5, 600)};${track(1)};color:${th.accent}">${esc(String(count).toUpperCase())}</span>`)}<span class="grow rule" style="background:${th.line}"></span>${when(open != null, () => workerKeyRow())}${when(trailing, () => `<span style="${F.mono(11.5)};color:${th.dim}">${esc(trailing)}</span>`)}</div>`;
}
function ticker(text) {
  const th = St.th, secsFor = Math.max(8, (text.length * 7.2 + 40) / 28);
  return `<div class="ticker" style="background:${th.bg2}"><span class="live" style="${F.mono(11, 700)};${track(2)};color:${th.onAccent};background:${th.accent}">LIVE</span><div class="tk-view"><div class="tk-track" style="animation-duration:${secsFor.toFixed(0)}s">${`<span style="${F.mono(12)};color:${th.dim}">${esc(text)}</span>`.repeat(2)}</div></div></div>`;
}
function sparkline(points, color) {
  const pts = points.length >= 2 ? points : [points[0] || 0, points[0] || 0];
  const y = (v) => 100 - Math.min(100, Math.max(0, v));
  const step = 100 / Math.max(1, pts.length - 1);
  const line = pts.map((v, i) => `${i ? "L" : "M"}${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(" ");
  return `<div class="spark"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><path d="M0,100 ${line.replace(/^M/, "L")} L100,100 Z" fill="${withAlpha(color, 0.14)}"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg><i style="top:${y(pts[pts.length - 1])}%;background:${color}"></i></div>`;
}
function mcKpi(value, unit, label, color) {
  const th = St.th;
  return `<div class="col" style="flex:1;min-width:0;gap:5px;padding:9px 10px"><div class="row base" style="gap:1px"><span style="${F.mono(21, 600)};color:${color}">${esc(value)}</span>${when(unit, () => `<span style="${F.mono(12.5)};color:${th.dim}">${esc(unit)}</span>`)}</div><div class="row g4 nowrap">${led(color, 6, th.dark)}<span class="one" style="${F.mono(11.5)};${track(1.2)};color:${th.dim}">${esc(label)}</span></div></div>`;
}
function mcTaskRow(t) {
  const th = St.th, wp = St.wp, ex = St.expanded.has(t.key), live = t.lastActive < 60 ? th.ok : t.lastActive < 300 ? th.warn : th.bad;
  const a = activeStep(t), m = firstMetricLine(t), wc = wp.of(t.wid, t.account);
  const edge = wc ? `box-shadow:inset ${ex ? 4 : 3}px 0 0 ${wc.ink}` : ex ? `box-shadow:inset 2px 0 0 ${th.accent}` : "";
  return `<div class="col g8 click" data-act="task" data-key="${attr(t.key)}" style="padding:10px 12px;background:${ex ? th.bg2 : "transparent"};${edge}">
    <div class="row" style="gap:10px">${led(live, 7, th.dark)}<div class="col grow" style="gap:3px;min-width:0"><div class="row base" style="gap:6px;min-width:0"><span style="${F.mono(13, 600)};color:${th.accent}">${esc(t.id)}</span>${line1(t.title, F.title(16, 600), th.text)}</div>${line1(a ? "▸ " + a.title : t.summary || "", F.mono(12), th.dim)}</div>
      <div class="col nowrap" style="gap:3px;align-items:flex-end"><span style="${F.mono(14, 600)};color:${waiting(t) ? th.warn : th.text}">${progText(t)}</span><span style="${F.mono(11.5)};color:${th.dim}">${noSteps(t) ? dur(t.elapsed) : `${stepCount(t)} · ${dur(t.elapsed)}`}</span></div></div>
    <div style="padding-left:17px">${progBar(t, th.progress, 5, 0, 32)}</div>
    <div class="row g6 wrap" style="padding-left:17px">${workerBadge(t.account, t.wid)}${each(t.tags, (g) => pill(g, tagRole(g)))}</div>
    ${when(!ex && m, () => `<div style="padding-left:17px">${line1(m, F.mono(12, 600), th.text, "display:block")}</div>`)}
    ${when(ex, () => `<div class="col g8" style="padding-left:17px">${when(t.summary, () => wrap(t.summary, F.title(15, 500), th.text, 3))}${taskDetails(t)}</div>`)}</div>`;
}
function mcWorker(f, c, samples) {
  const th = St.th;
  const cell = (k) => `<div class="col" style="flex:1;min-width:0;gap:3px;padding:6px 8px" title="${attr(k[2])}"><span class="one" style="${F.mono(11.5)};${track(1.2)};color:${th.dim}">${esc(k[0].toUpperCase())}</span><span class="one" style="${F.mono(13.5, 600)};color:${th.text}">${esc(k[1])}</span></div>`;
  return `<div class="col g8" style="padding:10px 12px 10px 16px;box-shadow:inset 3px 0 0 ${c.ink};border-bottom:1px solid ${th.line}">
    <div class="row" style="gap:10px">${led(f.st.limited ? th.bad : usageColor(f.a ? f.a.five : 0), 7, th.dark)}<span style="${F.mono(15, 600)};color:${c.ink}">${esc(f.w.id)}</span>${line1(`${f.a ? f.a.tool : ""} · ${f.w.name}`, F.mono(12), th.dim)}<span class="grow"></span>
      <span class="nowrap" style="${F.mono(18, 600)};color:${f.st.limited ? th.bad : th.text}">${esc(f.five)}</span><span class="col nowrap" style="${F.mono(11.5)};color:${th.dim};line-height:1.25"><span>${win(f.a).toUpperCase()}</span><span>${win(f.a) === "7d" ? "WEEKLY" : `7D ${esc(f.seven)}`}</span></span></div>
    <div title="Top rule = 100%; dotted rules every 25%">${usageGraph("w-" + f.w.id, samples, f.st.resets, c.ink, 64)}</div>
    ${graphCaption(samples, c.ink)}
    <div class="col" style="border:1px solid ${th.line}"><div class="row" style="align-items:stretch">${cell(f.cells[0])}${vrule()}${cell(f.cells[1])}${vrule()}${cell(f.cells[2])}</div>${rule()}<div class="row" style="align-items:stretch">${cell(f.cells[3])}${vrule()}${cell(f.cells[4])}${vrule()}${cell(f.cells[5])}</div></div>
    ${when(f.spare, () => wrap("◆ " + f.spare, F.mono(12.5, 600), th.ok))}
    ${workerJobs(f, c.ink)}</div>`;
}
function missionPanel() {
  const th = St.th, wp = St.wp, s = St.status;
  const title = (s ? s.title : "Agent monitor").toUpperCase(), parts = title.split(" · ");
  let h = `<div class="col">
    <div class="row g8" style="padding:10px 12px">${led(th.ok, 8, th.dark)}<span class="one" title="${attr(s ? s.title : "")}" style="${F.title(17, 600)};${track(2.2)}"><span style="color:${th.text}">${esc(parts[0])}</span>${when(parts.length > 1, () => `<span style="color:${th.accent}">/${esc(parts.slice(1).join(" · "))}</span>`)}</span>
      <span class="row g4" style="color:${th.ok}">${led(th.ok, 5, th.dark)}<span style="${F.mono(11, 600)};${track(1.6)}">LIVE</span></span><span class="grow"></span>
      <span class="nowrap" style="${F.mono(17, 600)};color:${th.text}">${esc(s ? s.time : "--:--:--")}</span>${collapseButton()}</div>${rule()}`;
  if (St.collapsed && s) {
    h += `<div class="row g12 nowrap clip" style="${F.mono(12.5, 600)};padding:10px 12px"><span style="color:${th.text}">▶${s.running.length} run</span><span style="color:${th.accent}">⧗${(s.queued || []).length} wait</span>${each(s.accounts, (a) => `<span class="row g4"><span style="color:${(wp.of(a.wid, a.name) || {}).ink || th.text}">${esc(splitWorker(a.name)[0])}</span><span style="color:${a.five >= 90 ? th.bad : th.text}">${a.five >= 100 ? "LIMIT" : pct(a.five)}</span></span>`)}</div>`;
    return h + "</div>";
  }
  let tk = "waiting for status…";
  if (s) {
    const p = s.finished.map((d) => `${d.time}  ${d.ok ? "DONE" : "FAIL"} ${d.id} ${d.title}`)
      .concat(s.running.map((t) => { const a = activeStep(t); return `RUN ${t.id} ${t.title}${a ? " · " + a.title : ""}`; }));
    tk = p.join("   ·   ") || "all quiet";
  }
  h += ticker(tk) + rule() + themePicker() + rule();
  h += s ? missionContent(s) : `<div style="${F.mono(12)};color:${th.dim};padding:12px">LOADING…</div>`;
  return h + "</div>";
}
function missionContent(s) {
  const th = St.th, wp = St.wp, q = s.queued || [], hs = s.health || [];
  const blocked = q.filter((x) => x.blocked).length, up = hs.filter((x) => x.up).length;
  const limited = s.accounts.filter((a) => a.five >= 100).length, files = s.changes.reduce((n, c) => n + c.files, 0), failed = s.finished.filter((d) => !d.ok).length;
  let h = `<div class="col"><div class="row" style="align-items:stretch">${mcKpi(String(s.running.length), null, "RUNNING", th.ok)}${vrule()}${mcKpi(String(q.length - blocked), null, "QUEUED", th.info)}${vrule()}${mcKpi(String(blocked), null, "NEED YOU", blocked > 0 ? th.warn : th.dim)}${vrule()}${mcKpi(String(s.agents.length), null, "AGENTS", th.magenta)}</div>${rule()}
    <div class="row" style="align-items:stretch">${mcKpi(String(s.finished.length - failed), failed > 0 ? `/${failed}✕` : null, "DONE", th.ok)}${vrule()}${mcKpi(String(up), `/${hs.length}`, "HEALTH", up === hs.length ? th.ok : th.bad)}${vrule()}${mcKpi(String(limited), null, "AT LIMIT", limited > 0 ? th.bad : th.dim)}${vrule()}${mcKpi(String(files), null, "CHANGED", files > 0 ? th.warn : th.dim)}</div>${rule()}</div>`;
  h += `<button class="plain" style="width:100%" data-act="workers" title="${St.workersOpen ? "Close the Workers drawer" : "Open the Workers drawer: usage graph, burn rate, lanes and pipeline per worker"}">${mcHead("WORKERS", String(s.accounts.length), null, St.workersOpen)}</button>`;
  if (St.workersOpen && wp.workers.length) h += rule() + workersDrawer(s);
  else h += each(s.accounts, (a) => {
    const [wid, rest] = splitWorker(a.name), stale = (a.age || 0) >= 600, c = stale ? th.faint : usageColor(a.five), wc = wp.of(a.wid, a.name);
    const sp = History.spark(History.key(a));
    return `<div class="row" style="gap:10px;padding:9px 12px;${wc ? `box-shadow:inset 3px 0 0 ${wc.ink}` : ""}">${led(c, 7, th.dark)}
      <div class="col" style="flex:0 0 132px;gap:3px;min-width:0"><span style="${F.mono(14, 600)};color:${wc ? wc.ink : th.text}">${esc(wid)}</span>${line1(`${a.tool} · ${rest}`, F.mono(11.5), th.dim)}</div>
      <div class="grow" style="height:26px;min-width:20px">${sparkline(sp.length ? sp : [a.five], stale ? th.faint : (wc ? wc.ink : c))}</div>
      <div class="col" style="flex:0 0 100px;gap:3px;align-items:flex-end;min-width:0"><span style="${F.mono(14, 600)};color:${a.five >= 100 ? th.bad : th.text}">${a.unknown === true ? "—" : pct(a.five)}</span><span class="one" style="${F.mono(11.5)};color:${th.dim}">${win(a) === "7d" ? "weekly limit" : `5h · 7d ${pct(a.seven)}`}</span></div>
      <div class="col" style="flex:0 0 92px;gap:3px;align-items:flex-end;min-width:0"><span style="${F.mono(14, 600)};color:${th.text}">${a.resetIn > 0 ? dur(a.resetIn) : "—"}</span><span class="one" style="${F.mono(11.5)};color:${stale ? th.warn : th.dim}">${stale ? `read ${dur(a.age || 0)} ago` : "reset"}</span></div></div>${rule()}`;
  });
  h += mcHead("IN PROGRESS", String(s.running.length));
  if (!s.running.length) h += `<div style="${F.mono(12)};color:${th.dim};padding:0 12px">nothing running</div>`;
  h += each(s.running, (t) => mcTaskRow(t) + rule());
  if (q.length) {
    h += mcHead("UP NEXT", `${q.length} waiting`);
    h += each(q, (x) => `<div class="row" style="gap:10px;padding:9px 12px">${led(x.blocked ? th.warn : th.faint, 7, th.dark && x.blocked)}<div class="col grow" style="gap:3px;min-width:0">
      <div class="row base" style="gap:6px;min-width:0"><span style="${F.mono(13, 600)};color:${th.accent}">${esc(x.id)}</span>${line1(x.title, F.title(16, 600), th.text)}</div>
      ${when(x.summary, () => line1(x.summary, F.mono(12), th.dim, "display:block"))}${wrap((x.blocked ? "✋ " : "⧗ ") + x.waitingFor, F.mono(12), x.blocked ? th.warn : th.faint)}</div>${when(x.worker, () => workerBadge(x.worker, x.wid))}</div>${rule()}`);
  }
  if (s.agents.length) {
    h += mcHead("CLAUDE AGENTS", `${s.agents.length} running`);
    h += each(s.agents, (a) => `<div class="row" style="gap:10px;padding:9px 12px">${led(a.lastActive < 60 ? th.ok : th.warn, 7, th.dark)}<div class="col grow" style="gap:3px;min-width:0">${line1(a.title, F.title(15, 600), th.text, "display:block")}${line1(a.recent.length ? "▸ " + a.recent[0] : "", F.mono(12), th.dim, "display:block")}</div><div class="col nowrap" style="gap:3px;align-items:flex-end"><span style="${F.mono(14, 600)}">${a.tools}</span><span style="${F.mono(11.5)};color:${th.dim}">actions</span></div></div>${rule()}`);
  }
  h += mcHead("TIMELINE", s.finished.length ? String(s.finished.length) : null, "recently finished");
  h += each(s.finished, (d) => {
    const c = wp.of(d.wid);
    return `<div class="row base" style="gap:10px;padding:6px 12px"><span style="${F.mono(12)};color:${th.dim};flex:0 0 46px">${esc(d.time)}</span><span style="${F.mono(11.5, 600)};${track(1)};color:${d.ok ? th.ok : th.bad};flex:0 0 40px">${d.ok ? "DONE" : "FAIL"}</span><span style="${F.mono(12, 600)};color:${th.accent}">${esc(d.id)}</span>${line1(d.title, F.mono(12), th.text)}<span class="grow"></span>${when(c, () => `<span class="nowrap" title="${attr(`${c.wid} · ${c.name}`)}" style="${F.mono(12, 600)};color:${c.ink}">${esc(c.wid)}</span>`)}</div>${rule(0.7)}`;
  });
  const parts = (s.commit || "").split(" · ");
  const cell = (k, v, color) => `<div class="col" style="flex:1;min-width:0;gap:3px;padding:6px 8px"><span style="${F.mono(11.5)};${track(1.4)};color:${th.dim}">${k}</span>${line1(v, F.mono(13, 600), color || th.text)}</div>`;
  h += mcHead("REPO · HEALTH", null, s.repo || null);
  h += `<div class="col g8" style="padding:0 12px"><div class="row" style="align-items:stretch;border:1px solid ${th.line}">${cell("COMMIT", parts[0] || "—")}${vrule()}${cell("AGE", parts.length > 2 ? parts[parts.length - 1] : "—")}${vrule()}${cell("CHANGES", s.changes.length ? `${files} files` : "clean", s.changes.length ? th.warn : th.ok)}</div>
    ${when(parts.length > 1, () => wrap(parts.slice(1, parts.length > 2 ? -1 : undefined).join(" · "), F.mono(12), th.dim))}
    ${each(s.changes, (c) => `<div class="row g8">${line1(c.area, F.mono(12), th.text)}<span class="grow"></span><span class="nowrap" style="${F.mono(12)};color:${th.warn}">${c.files} files changed</span></div>`)}
    ${when(hs.length, () => `<div style="padding-top:4px">${healthRows(hs)}</div>`)}</div>`;
  const keycap = (k) => `<span style="${F.mono(11, 600)};color:${th.accent};padding:2px 5px;border-radius:3px;background:${withAlpha(th.accent, 0.10)};border:1px solid ${withAlpha(th.accent, 0.5)}">${k}</span>`;
  h += `<div class="row g8 wrap" style="${F.mono(11.5)};padding:8px 12px;margin-top:16px;background:${th.bg2};border-top:1px solid ${th.line}">${keycap("CTRL+T")}<span style="color:${th.dim}">layout</span>${keycap("CTRL+⇧+T")}<span style="color:${th.dim}">light/dark</span>${keycap("CLICK")}<span style="color:${th.dim}">expand row</span></div>`;
  return h;
}

// ================================================================ PAPER layout (editorial: greeting, story lede, soft cards, rings)
function paperCard(inner, { edge = null, highlight = false, act = "", key = "" } = {}) {
  const th = St.th;
  return `<div class="papercard${act ? " click" : ""}"${act ? ` data-act="${act}" data-key="${attr(key)}"` : ""} style="background:${edge ? `linear-gradient(90deg,${edge} 6px,${th.surface} 6px)` : th.surface};border-color:${highlight ? withAlpha(th.accent, 0.6) : th.dark ? th.line : withAlpha(th.line, 0.6)};box-shadow:0 3px 8px rgba(0,0,0,${th.dark ? 0.3 : 0.07});${edge ? "padding-left:22px;" : ""}">${inner}</div>`;
}
const paperH2 = (title, count = null) => `<div class="row base" style="padding-top:8px"><span style="${F.title(20, 600)};color:${St.th.text}">${esc(title)}</span><span class="grow"></span>${when(count, () => `<span style="${F.text(14)};color:${St.th.faint}">${esc(count)}</span>`)}</div>`;
const kicker = (text, color) => `<span class="one" style="${F.text(12, 600)};${track(1)};text-transform:uppercase;color:${color}">${esc(text)}</span>`;
function paperRing(a) {
  const th = St.th, wp = St.wp, stale = (a.age || 0) >= 600, wc = wp.of(a.wid, a.name);
  const c = stale ? th.faint : a.five >= 90 ? th.bad : (wc && wc.ink) || usageColor(a.five);
  const R = 28.5, L = 2 * Math.PI * R, frac = Math.min(1, a.five / 100);
  return `<div class="col" style="align-items:center;gap:6px;min-width:0">
    <div class="ring"><svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="${R}" fill="none" stroke="${th.track}" stroke-width="7"/>${when(a.unknown !== true && frac > 0, () => `<circle cx="32" cy="32" r="${R}" fill="none" stroke="${c}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${(L * frac).toFixed(2)} ${L.toFixed(2)}" transform="rotate(-90 32 32)"/>`)}</svg>
      <span style="${F.mono(14, 600)};color:${a.five >= 90 && !stale ? th.bad : th.text}">${a.unknown === true ? "—" : pct(a.five)}</span></div>
    <div class="row g4 nowrap" title="${attr(a.name)}">${workerDot(a.wid, a.name, false, 8)}<span style="${F.text(13, 700)};color:${(wc && wc.ink) || th.text}">${esc(splitWorker(a.name)[0])}</span><span style="${F.text(13, 600)};color:${th.text}">· ${esc(a.tool)}</span></div>
    <span class="one" style="${F.text(12.5)};color:${a.five >= 100 ? th.bad : th.faint}">${a.five >= 100 ? `resting · ${dur(a.resetIn)}` : a.unknown === true ? "not known yet" : `${win(a) === "7d" ? "weekly" : `7d ${pct(a.seven)}`} · ↻ ${dur(a.resetIn)}`}</span>
    ${when(a.age != null && a.age >= 600, () => `<span class="one" style="${F.text(12)};color:${th.warn}">read ${dur(a.age)} ago</span>`)}</div>`;
}
function paperTask(t) {
  const th = St.th, wp = St.wp, ex = St.expanded.has(t.key), live = t.lastActive < 60 ? th.ok : t.lastActive < 300 ? th.warn : th.bad;
  const a = activeStep(t), m = firstMetricLine(t);
  return paperCard(`<div class="col g6">
    <div class="row g8">${kicker(`In progress · ${t.id}`, th.ok)}<span class="grow"></span><span class="led" style="width:9px;height:9px;background:${live}"></span></div>
    ${wrap(t.title, F.title(18, 600), th.text)}${when(t.summary, () => wrap(t.summary, F.text(14.5), th.faint))}
    <div class="row g8" style="padding-top:4px"><div class="grow">${progBar(t, th.progress, 6)}</div><span class="nowrap" style="${F.mono(13.5, 600)};color:${waiting(t) ? th.warn : th.text}">${noSteps(t) ? progText(t) : `${stepCount(t)} · ${progText(t)}`}</span></div>
    ${when(!ex && a, () => line1(`Now: ${a.title}`, F.text(13.5), th.dim, "display:block"))}
    ${when(!ex && m, () => line1(m, F.text(13.5, 600), th.text, "display:block"))}
    <div class="row g6 wrap" style="padding-top:4px">${workerBadge(t.account, t.wid)}${each(t.tags, (g) => pill(g, tagRole(g)))}</div>
    ${when(ex, () => `<div style="padding-top:4px">${taskDetails(t)}</div>`)}</div>`, { edge: (wp.of(t.wid, t.account) || {}).ink, highlight: ex, act: "task", key: t.key });
}
function paperWorker(f, c, samples) {
  const th = St.th;
  return paperCard(`<div class="col g8">
    <div class="row g8">${kicker(`${f.w.id} · ${f.w.name}`, c.ink)}<span class="grow"></span>${when(f.a, () => pill(f.a.tool, "neutral"))}</div>
    <div><span style="${F.title(19, 600)};color:${th.text}">${f.st.limited ? "Resting" : `${esc(f.five)} used`}</span><span style="${F.title(16.5, 400)};color:${th.dim}">${f.st.limited ? ` until the ${winLong(f.a)} window resets` : ` of the ${winLong(f.a)} window`}</span></div>
    ${line1(`7-day ${f.seven} · burning ${f.st.burnText} · resets in ${f.resetIn}`, F.text(14), th.faint, "display:block")}
    <div style="padding-top:4px">${usageGraph("w-" + f.w.id, samples, f.st.resets, c.ink, 72)}</div>
    ${graphCaption(samples, c.ink)}
    <div class="grid3" style="padding-top:4px;row-gap:12px">${each(f.cells, (k) => `<div class="col" style="gap:2px;min-width:0" title="${attr(k[2])}"><span class="one" style="${F.mono(15, 600)};color:${th.text}">${esc(k[1])}</span><span class="one" style="${F.text(13)};color:${th.faint}">${esc(k[0])}</span></div>`)}</div>
    ${when(f.spare, () => `<div style="padding:6px 10px;border-radius:10px;background:${chip("ok").fill}">${wrap(f.spare, F.text(13.5, 600), chip("ok").ink)}</div>`)}
    <div style="padding-top:4px">${workerJobs(f, c.ink)}</div></div>`, { edge: c.ink });
}
function paperQueued(q) {
  const th = St.th, hot = chip("hot").ink;
  return paperCard(`<div class="col g6">${kicker(q.blocked ? `Waiting for you · ${q.id}` : `Up next · ${q.id}`, q.blocked ? hot : th.accent)}
    ${wrap(q.title, F.title(17, 600), th.text)}${when(q.summary, () => wrap(q.summary, F.text(14), th.faint))}
    ${wrap(q.waitingFor, F.text(13.5, q.blocked ? 600 : 400), q.blocked ? hot : th.faint)}
    ${when(q.worker, () => `<div style="padding-top:2px">${workerBadge(q.worker, q.wid)}</div>`)}</div>`, { edge: q.blocked ? hot : th.accent });
}
function paperLede(s) {
  const th = St.th, q = s.queued || [], blocked = q.filter((x) => x.blocked).length, n = s.running.length;
  let t = `${words(n)} task${n === 1 ? " is" : "s are"} moving`;
  t += s.agents.length ? ` and ${words(s.agents.length).toLowerCase()} Claude agent${s.agents.length === 1 ? " is" : "s are"} working. ` : ". ";
  t = esc(t);
  if (q.length) {
    t += esc(`${words(q.length)} more ${q.length === 1 ? "waits" : "wait"}`);
    if (blocked > 0) t += `, and <mark style="background:${chip("warn").fill};color:inherit">${esc(`${words(blocked).toLowerCase()} of them ${blocked === 1 ? "needs" : "need"} you`)}</mark>. `;
    else t += ". ";
  }
  const r = s.accounts.find((a) => a.five >= 100);
  if (r) t += `${esc(splitWorker(r.name)[0])} is resting for <b>${dur(r.resetIn)}</b>. `;
  const free = s.accounts.filter((a) => a.unknown !== true && a.five < 100).sort((a, b) => a.five - b.five)[0];
  if (free) t += esc(`${splitWorker(free.name)[0]} has the most quota to spare (${pct(free.five)} used).`);
  return t;
}
function paperPanel() {
  const th = St.th, s = St.status, hr = new Date().getHours();
  const greeting = hr < 5 ? "Good night." : hr < 12 ? "Good morning." : hr < 17 ? "Good afternoon." : "Good evening.";
  let h = `<div class="col g12" style="padding:16px 18px">
    <div class="row g8"><span class="led" style="width:8px;height:8px;background:${th.ok}"></span><span class="one" style="${F.text(13.5)};color:${th.faint}">${esc(longDate())} · ${esc(s ? s.time : "")}</span><span class="grow"></span>${line1(s ? s.title : "", F.text(13.5), th.faint)}${collapseButton()}</div>`;
  if (St.collapsed && s) {
    h += `<div class="row g8 wrap">${pill(`${s.running.length} running`, "ok")}${pill(`${(s.queued || []).length} waiting`, "violet")}${each(s.accounts.filter((a) => a.five >= 100), (a) => pill(`${splitWorker(a.name)[0]} resting`, "bad"))}</div>`;
    return h + "</div>";
  }
  h += `<div style="${F.title(32, 500)};color:${th.text}">${greeting}</div>`;
  if (s) h += `<div style="${F.title(16.5, 400)};color:${th.text};line-height:1.55">${paperLede(s)}</div>`;
  h += `<div style="padding:4px 0">${themePicker()}</div>`;
  h += s ? paperSections(s) : `<div style="${F.text(14)};color:${th.faint}">Loading…</div>`;
  return h + "</div>";
}
function paperSections(s) {
  const th = St.th, wp = St.wp, q = s.queued || [];
  let h = "";
  if (q.some((x) => x.blocked)) h += paperH2("Needs you", `${q.filter((x) => x.blocked).length} things`) + each(q.filter((x) => x.blocked), paperQueued);
  h += `<button class="plain row g8 base" style="width:100%;padding-top:8px" data-act="workers" title="${St.workersOpen ? "Close the Workers drawer" : "Open the Workers drawer: usage graph, burn rate, lanes and pipeline per worker"}">${icon(St.workersOpen ? "down" : "right", 13, th.accentText)}<span style="${F.title(20, 600)};color:${th.text}">Workers</span><span class="grow"></span>${workerKeyRow()}</button>`;
  if (St.workersOpen && wp.workers.length) h += workersDrawer(s);
  else h += paperCard(`<div style="display:grid;grid-template-columns:repeat(${Math.min(4, Math.max(1, s.accounts.length))},minmax(0,1fr));gap:12px 8px">${each(s.accounts, paperRing)}</div>`);
  h += paperH2("In progress", `${s.running.length} moving`);
  if (!s.running.length) h += `<div style="${F.text(14)};color:${th.faint}">Nothing running</div>`;
  h += each(s.running, paperTask);
  if (q.some((x) => !x.blocked)) h += paperH2("Up next", `${q.filter((x) => !x.blocked).length} waiting`) + each(q.filter((x) => !x.blocked), paperQueued);
  if (s.agents.length) {
    h += paperH2("Claude agents", `${s.agents.length} running`);
    h += each(s.agents, (a) => paperCard(`<div class="col g6"><div class="row">${kicker(`Claude agent · ${a.tools} actions`, th.claude)}<span class="grow"></span><span class="led" style="width:9px;height:9px;background:${a.lastActive < 60 ? th.ok : th.warn}"></span></div>${wrap(a.title, F.title(16.5, 600), th.text)}${when(a.recent.length, () => line1(a.recent[0], F.text(13.5), th.faint, "display:block"))}</div>`));
  }
  h += paperH2("Recently finished", s.finished.length ? String(s.finished.length) : null);
  h += paperCard(`<div class="col g10">${s.finished.length ? "" : `<div style="${F.text(13.5)};color:${th.faint}">Nothing yet</div>`}${each(s.finished, (d) => {
    const c = wp.of(d.wid);
    return `<div class="row g8 base"><span class="led" style="width:9px;height:9px;background:${d.ok ? th.ok : th.bad}"></span><span style="${F.mono(13, 600)};color:${th.faint};min-width:30px">${esc(d.id)}</span>${line1(d.title, F.text(14.5), th.text)}<span class="grow"></span>${when(c, () => `<span class="nowrap" title="${attr(`${c.wid} · ${c.name}`)}" style="${F.mono(13, 700)};color:${c.ink}">${esc(c.wid)}</span>`)}<span class="nowrap" style="${F.mono(13)};color:${th.faint}">${esc(d.time)}</span></div>`;
  })}</div>`);
  h += paperH2("Repository & health", s.repo || null);
  h += paperCard(`<div class="col g8">${wrap(s.commit, F.code(12.5), th.dim)}${s.changes.length ? "" : `<div style="${F.text(13.5)};color:${th.faint}">Working tree clean</div>`}${each(s.changes, (c) => `<div class="row g8">${line1(c.area, F.code(12.5), th.text)}<span class="grow"></span>${pill(`${c.files} files changed`, "warn")}</div>`)}${when(s.health && s.health.length, () => `<div style="padding-top:4px">${healthRows(s.health)}</div>`)}</div>`);
  return h;
}

// ---------------------------------------------------------------- render loop (small DOM morph keeps animations, scroll and focus)
function syncAttrs(f, t) {
  for (const a of [...f.attributes]) if (!t.hasAttribute(a.name) && a.name !== "data-sig") f.removeAttribute(a.name);
  for (const a of [...t.attributes]) if (f.getAttribute(a.name) !== a.value) f.setAttribute(a.name, a.value);
}
function morphChildren(fromEl, toEl) {
  if (fromEl.hasAttribute && fromEl.hasAttribute("data-keep")) return;
  const a = [...fromEl.childNodes], b = [...toEl.childNodes];
  for (let i = 0; i < b.length; i++) {
    const f = a[i], t = b[i];
    if (!f) { fromEl.appendChild(t); continue; }
    if (f.nodeType !== t.nodeType || f.nodeName !== t.nodeName) { fromEl.replaceChild(t, f); continue; }
    if (f.nodeType !== 1) { if (f.nodeValue !== t.nodeValue) f.nodeValue = t.nodeValue; continue; }
    syncAttrs(f, t);
    morphChildren(f, t);
  }
  for (let i = a.length - 1; i >= b.length; i--) fromEl.removeChild(a[i]);
}

function applyTheme() {
  const dark = St.mode === "dark" || (St.mode === "auto" && St.systemDark);
  const th = makeTheme(St.layout, dark);
  St.th = th;
  St.wp = new WorkerPalette(th, (St.status && St.status.workers) || []);
  const root = document.documentElement;
  root.dataset.layout = th.layout;
  root.dataset.theme = th.id;
  root.style.colorScheme = dark ? "dark" : "light";
  root.style.setProperty("--bg", th.bg);
  root.style.setProperty("--text", th.text);
  root.style.setProperty("--scroll", th.lineStrong);
  document.body.style.background = th.layout === "studio" ? `linear-gradient(${th.bgTop}, ${th.bg}) fixed` : th.bg;
  if (applyTheme.dark !== dark) { applyTheme.dark = dark; Host.call("set_dark", dark); } // native title bar follows the theme
  return th;
}

let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const th = applyTheme();
    St.graphs = {};
    const html = th.layout === "studio" ? studioPanel() : th.layout === "mission" ? missionPanel() : paperPanel();
    const tpl = document.createElement("div");
    tpl.innerHTML = html;
    const root = document.getElementById("root");
    const switched = root.dataset.theme !== th.id;
    if (switched) { root.innerHTML = ""; root.dataset.theme = th.id; }
    morphChildren(root, tpl);
    for (const el of root.querySelectorAll("[data-graph]")) {
      const g = St.graphs[el.dataset.graph];
      if (g) drawGraph(el, g);
    }
  });
}

function savePrefs() { Host.call("set_prefs", { layout: St.layout, mode: St.mode, workersOpen: St.workersOpen }); }
function setLayout(l) { St.layout = l; savePrefs(); render(); }
function setMode(m) { St.mode = m; savePrefs(); render(); }
function cycleLayout() { setLayout(LAYOUTS[(LAYOUTS.indexOf(St.layout) + 1) % LAYOUTS.length]); }
function toggleMode() { setMode(St.th.dark ? "light" : "dark"); }

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  if (window.getSelection && String(window.getSelection()).length > 0 && el.classList.contains("click")) return; // selecting text, not toggling
  const act = el.dataset.act, key = el.dataset.key, val = el.dataset.val;
  const flip = (set, k) => (set.has(k) ? set.delete(k) : set.add(k));
  if (act === "task") flip(St.expanded, key);
  else if (act === "raw") flip(St.raw, key);
  else if (act === "agent") flip(St.agentOpen, key);
  else if (act === "workers") { St.workersOpen = !St.workersOpen; savePrefs(); }
  else if (act === "collapse") { St.collapsed = !St.collapsed; Host.call("set_collapsed", St.collapsed); }
  else if (act === "layout") return setLayout(val);
  else if (act === "mode") return setMode(val);
  render();
});
// Ctrl+T cycles the layout (Studio → Mission Control → Paper); Ctrl+Shift+T flips light/dark.
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "t" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
  e.preventDefault();
  if (e.shiftKey) toggleMode(); else cycleLayout();
});
window.addEventListener("resize", () => render());

/** Called by the Python host with each status.py snapshot. */
window.onStatus = (s) => {
  if (!s || typeof s !== "object") return;
  St.status = s;
  History.record(s);
  render();
};

function configLayout(cfg) {
  cfg = String(cfg || "").toLowerCase();
  const layout = cfg.includes("mission") ? "mission" : cfg.includes("paper") ? "paper" : cfg.includes("studio") || cfg.includes("deck") ? "studio" : null;
  const mode = cfg.includes("dark") ? "dark" : cfg.includes("light") ? "light" : cfg.includes("auto") ? "auto" : null;
  return { layout, mode };
}

async function boot() {
  const p = (await Host.call("get_prefs")) || {};
  const c = configLayout(p.configTheme);
  St.layout = LAYOUTS.includes(p.layout) ? p.layout : c.layout || "studio";
  St.mode = MODES.includes(p.mode) ? p.mode : c.mode || "auto";
  St.workersOpen = !!p.workersOpen;
  // Preview overrides for development: index.html?layout=mission&mode=dark&open=workers,041-data-profiling
  const qs = new URLSearchParams(location.search);
  if (LAYOUTS.includes(qs.get("layout"))) St.layout = qs.get("layout");
  if (MODES.includes(qs.get("mode"))) St.mode = qs.get("mode");
  for (const k of (qs.get("open") || "").split(",").filter(Boolean)) { if (k === "workers") St.workersOpen = true; else { St.expanded.add(k); St.raw.add(k); } }
  const mq = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;
  St.systemDark = mq ? mq.matches : false;
  const sys = await Host.call("system_dark");
  if (typeof sys === "boolean") St.systemDark = sys;
  if (mq) mq.addEventListener("change", (e) => { St.systemDark = e.matches; render(); });
  // Windows' app light/dark setting, re-checked every 30 s (WebView2 does not always forward the change).
  setInterval(async () => { const d = await Host.call("system_dark"); if (typeof d === "boolean" && d !== St.systemDark) { St.systemDark = d; render(); } }, 30000);
  await History.load();
  render();
  const latest = await Host.call("latest");
  if (latest) window.onStatus(latest);
  else if (!Host.api() && window.DEMO) { window.onStatus(window.DEMO()); setInterval(() => window.onStatus(window.DEMO()), 2000); }
  // Clocks and countdowns stay live between snapshots.
  setInterval(render, 30000);
}

// pywebview injects its API after the page loads; boot as soon as it is ready (or straight away in a browser).
let booted = false;
const start = () => { if (!booted) { booted = true; boot(); } };
window.addEventListener("pywebviewready", start);
window.addEventListener("DOMContentLoaded", () => setTimeout(() => { if (!booted && !window.pywebview) start(); }, 400));
