// Demo data for previewing the panel in a plain browser (no Python host): open windows/ui/index.html via a local server.
// Never used when the panel runs inside windows/panel.py.
"use strict";

(function () {
  const t0 = Date.now() / 1000;
  const W = [["W0", "Claude-Main"], ["W1", "Codex-A"], ["W2", "Codex-B"], ["W3", "Claude-Worker"]];

  /** A plausible 24 h of readings ending at the current value (port of UsageHistory.debugSeed). */
  function seed(five, seven, resetIn, s) {
    const now = Date.now() / 1000, next = now + Math.max(resetIn, 600), out = [];
    let x = (s * 2654435761 + 7) >>> 0;
    const rnd = () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x % 1000) / 1000; };
    const rates = [0, 1, 2, 3, 4, 5].map(() => 6 + rnd() * 22);
    for (let t = now - 24 * 3600; t <= now; t += 300) {
      const w = Math.floor((next - t) / (5 * 3600)), start = next - (w + 1) * 5 * 3600, inWin = (t - start) / 3600;
      let v;
      if (w === 0) { const span = (now - start) / 3600; v = span > 0 ? five * Math.min(1, inWin / span) : five; }
      else v = Math.min(100, inWin * rates[Math.min(w, rates.length - 1)]);
      if (!(w === 2 && inWin > 1.5 && inWin < 2.3)) out.push({ t, five: Math.round(v * 10) / 10, seven: Math.max(0, seven - ((now - t) / 86400) * 9), reset: next - w * 5 * 3600 });
    }
    return out;
  }

  window.DEMO = function () {
    const el = Math.floor(Date.now() / 1000 - t0);
    const d = new Date(), p = (n) => String(n).padStart(2, "0");
    const accounts = [
      { name: "W0 Claude-Main (orchestrator)", tool: "Claude", five: 42, seven: 18, resetIn: 7340 - el, lastLimit: "", age: 20, unknown: false, wid: "W0" },
      { name: "W1 Codex-A (worker)", tool: "Codex", five: 71, seven: 33, resetIn: 3020 - el, lastLimit: "", wid: "W1" },
      { name: "W2 Codex-B (worker)", tool: "Codex", five: 100, seven: 64, resetIn: 1830 - el, lastLimit: "14:05", wid: "W2" },
      { name: "W3 Claude-Worker (worker)", tool: "Claude", five: 12, seven: 9, resetIn: 15200 - el, lastLimit: "", age: 900, unknown: false, wid: "W3" },
    ];
    if (typeof History !== "undefined" && !History._demoSeeded) {
      History._demoSeeded = true;
      accounts.forEach((a, i) => { if (!(History.samples[a.wid] || []).length) History.samples[a.wid] = seed(Math.min(99, a.five), a.seven, a.resetIn, i + 3); });
    }
    return {
      time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
      title: "Demo project · background work",
      running: [
        { key: "041-data-profiling", id: "041", title: "Profile all source documents", summary: "Count pages, languages and scan quality in every file so the parser plan is grounded in facts",
          account: "W1 Codex-A", wid: "W1", elapsed: 2710 + el, note: "ETA ~38 min (≈15:42) · profiling batch 7 of 12",
          steps: [{ title: "Read sources", status: "done" }, { title: "Profile documents · ~22m left", status: "active" }, { title: "Write report · ~15m", status: "pending" }],
          metrics: [{ label: "Documents profiled", done: 620 + el, total: 3657, kind: "", rate: "≈42/min", left: "~1.2 h left" }, { label: "Unreadable files", done: 3, total: null, kind: "bad", rate: "", left: "" }],
          tags: ["data", "P1"], commands: 214, tokens: 1840000, edits: 12, lastActive: 8, estimated: false, failovers: 1,
          recent: [{ cmd: "python tools/profile.py --batch 7", state: "running", secs: 41.2 }, { cmd: "edit profile.py, report.md", state: "ok", secs: 0.4 }, { cmd: "npm test -- profile", state: "fail", secs: 12.8 }] },
        { key: "044-onboarding-copy", id: "044", title: "Rewrite onboarding copy", summary: "Plain-English welcome screens for first-time users",
          account: "W0 Claude-Main", wid: "W0", elapsed: 980 + el, note: "drafting screen 3",
          steps: [{ title: "Audit current screens", status: "done" }, { title: "Draft copy · ~12m left", status: "active" }, { title: "Review with owner · ETA ?", status: "pending" }],
          metrics: [{ label: "Screens drafted", done: 2, total: 5, kind: "", rate: "", left: "" }], tags: ["feature"], commands: 0, tokens: 0, edits: 0, lastActive: 140, estimated: false, failovers: 0, recent: [] },
      ],
      queued: [
        { id: "042", title: "API contract tests", summary: "Lock the public API shape before the mobile client ships", worker: "W2 Codex-B", wid: "W2", waitingFor: "starts when W2's limit resets", blocked: false },
        { id: "043", title: "Pick the brand colours", summary: "", worker: "W0 Claude-Main", wid: "W0", waitingFor: "needs your sign-off on the two palettes in docs/brand.md", blocked: true },
      ],
      agents: [{ title: "Search the codebase for unused feature flags", tools: 23, recent: ["Grep · featureFlag\\(", "Read · src/flags.ts", "Glob · **/*.flags.json"], lastActive: 12 }],
      finished: [
        { id: "040", title: "Set up repository and CI", time: "13:12", ok: true, wid: "W3" },
        { id: "039", title: "Import legacy customer data", time: "12:47", ok: false, wid: "W1" },
        { id: "038", title: "Draft privacy notice", time: "11:30", ok: true, wid: "W0" },
      ],
      accounts,
      commit: "0fa58b8 · docs: project-neutral v2 brief · 2 hours ago",
      changes: [{ area: "apps/web", files: 4 }, { area: "status.py", files: 1 }],
      health: [{ label: "App :3000", up: true, group: "local" }, { label: "API :4000", up: false, group: "local" }, { label: "Staging", up: true, group: "remote" }],
      workers: W.map(([id, name], slot) => ({
        id, name, color: null, slot, account: accounts[slot].name,
        lanes: slot === 1 ? [{ id: "041", title: "Profile all source documents", stale: false }] : slot === 0 ? [{ id: "044", title: "Rewrite onboarding copy", stale: false }] : [],
        doneToday: [1, 0, 2, 1][slot], failedToday: [0, 1, 0, 0][slot], doneIds: [["038"], ["039"], ["035", "036"], ["040"]][slot],
        lastDone: 1800, idleSecs: slot === 3 ? 2400 : slot === 2 ? 900 : 0,
        pipeline: slot === 2 ? [{ id: "042", title: "API contract tests", blocked: false, likely: false }] : slot === 0 ? [{ id: "043", title: "Pick the brand colours", blocked: true, likely: false }] : [],
      })),
    };
  };
})();
