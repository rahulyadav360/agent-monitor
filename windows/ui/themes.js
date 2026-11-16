// Design tokens, ported 1:1 from Theme.make in Panel.swift (macOS). Three layouts, each light and dark.
//   Studio          PhoneDeck look: warm-grey body, dark LCD blocks, chunky ink-bordered keys
//   Mission Control dense, thin rules, LEDs, monospace numerals, sparklines, ticker, key hints
//   Paper           editorial: serif headlines, humanist text, pastel pills, soft cards, quota rings
// All text/background pairs meet WCAG AA (4.5:1). Data and behaviour are identical in every theme.
"use strict";

const LAYOUTS = ["studio", "mission", "paper"];
const LAYOUT_LABEL = { studio: "Studio", mission: "Mission Control", paper: "Paper" };
const MODES = ["light", "dark", "auto"];

// Chip kinds: solid(fill, ink = white) · outline(colour) → 10 % fill, 55 % stroke · tint(bg, ink)
const solid = (c, ink = "#FFFFFF") => ({ fill: c, ink, stroke: "transparent" });
const outline = (c) => ({ fill: c + "1A", ink: c, stroke: c + "8C" });
const tint = (bg, ink) => ({ fill: bg, ink, stroke: "transparent" });

const BASE = {
  bgTop: "#000000", bg: "#000000", bg2: "#000000", surface: "#000000", surfaceAlt: "#000000",
  line: "#808080", lineStrong: "#808080", ink: "#000000",
  text: "#FFFFFF", dim: "#808080", faint: "#808080",
  accent: "#FF9500", accentText: "#FF9500", onAccent: "#000000",
  ok: "#34C759", warn: "#FFCC00", bad: "#FF3B30", info: "#007AFF", magenta: "#FF2D55", violet: "#AF52DE",
  claude: "#FF9500", codex: "#007AFF", track: "#808080", progress: "#FF9500",
  lcd: "#000000", lcdText: "#FFFFFF", lcdDim: "#808080", lcdLine: "#808080",
  keyAlert: "#FFFFFF", keyQueue: "#FFFFFF",
};

const STUDIO_CHIPS = (numberMuted) => ({
  ok: solid("#0F7A46"), warn: solid("#E3A13A", "#000000"), bad: solid("#B42318"), hot: solid("#FF5A1F", "#000000"),
  claude: solid("#B05A3C"), codex: solid("#2F5FE0"), violet: solid("#7A3FB0"), teal: solid("#0B6E66"),
  sky: solid("#2F5FE0"), neutral: solid("#5E5A52"), number: solid("#FF5A1F", "#000000"), numberMuted,
});

const THEMES = {
  "studio-light": {
    bgTop: "#F5F4F0", bg: "#E6E4DD", bg2: "#EDEBE6", surface: "#FBFAF7", surfaceAlt: "#F2F0EA", line: "#CFCCC4", lineStrong: "#B9B5AC", ink: "#141414",
    text: "#141414", dim: "#3B3832", faint: "#5E5A52",
    accent: "#FF5A1F", accentText: "#B93A0A", onAccent: "#000000",
    ok: "#0F7A46", warn: "#8A5A00", bad: "#B42318", info: "#2F5FE0", violet: "#7A3FB0",
    claude: "#B05A3C", codex: "#2F5FE0", track: "#D9D6CE", progress: "#FF5A1F",
    lcd: "#0F0F10", lcdText: "#EEEEEE", lcdDim: "#9A9A9A", lcdLine: "#2A2A2A",
    keyAlert: "#FFF0ED", keyQueue: "#FFFBEA",
    chips: STUDIO_CHIPS(solid("#141414")),
    inkBgs: ["#E6E4DD", "#FBFAF7", "#F2F0EA", "#FFFBEA", "#FFF0ED"], cardHex: "#FBFAF7", bgHex: "#EDEBE6", lcdHex: "#0F0F10",
  },
  "studio-dark": {
    bgTop: "#2A2926", bg: "#1C1B19", bg2: "#232220", surface: "#2D2B28", surfaceAlt: "#262522", line: "#3D3B36", lineStrong: "#55524B", ink: "#050505",
    text: "#F3F1EC", dim: "#D6D2CA", faint: "#B3ADA3",
    accent: "#FF5A1F", accentText: "#FF7A45", onAccent: "#000000",
    ok: "#35E07F", warn: "#F0B54A", bad: "#FF6B5E", info: "#7FA2FF", violet: "#C39BFF",
    claude: "#B05A3C", codex: "#2F5FE0", track: "#3A3833", progress: "#FF5A1F",
    lcd: "#0B0B0C", lcdText: "#EEEEEE", lcdDim: "#9A9A9A", lcdLine: "#333333",
    keyAlert: "#3A2420", keyQueue: "#37301A",
    chips: STUDIO_CHIPS(solid("#F3F1EC", "#000000")),
    inkBgs: ["#1C1B19", "#2D2B28", "#262522", "#3A2420", "#37301A"], cardHex: "#2D2B28", bgHex: "#232220", lcdHex: "#0B0B0C",
  },
  "mission-dark": {
    bg: "#0A0C0F", bgTop: "#0A0C0F", bg2: "#0F1318", surface: "#0F1318", surfaceAlt: "#141A21",
    line: "#1F2731", lineStrong: "#2C3744", ink: "#1F2731",
    text: "#DBE4EE", dim: "#A3B0BF", faint: "#8A97A8",
    accent: "#2EE6FF", accentText: "#2EE6FF", onAccent: "#001318",
    ok: "#3DFF9A", warn: "#FFC53D", bad: "#FF5872", info: "#2EE6FF", magenta: "#FF7AD9", violet: "#B9A2FF",
    claude: "#FF9A4A", codex: "#B9A2FF", track: "#1A222B", progress: "#2EE6FF",
    chips: {
      ok: outline("#3DFF9A"), warn: outline("#FFC53D"), bad: outline("#FF5872"), hot: outline("#FF9A4A"),
      claude: outline("#FF9A4A"), codex: outline("#B9A2FF"), violet: outline("#B9A2FF"), teal: outline("#3DFF9A"),
      sky: outline("#2EE6FF"), neutral: outline("#A3B0BF"), number: outline("#2EE6FF"), numberMuted: outline("#A3B0BF"),
    },
    inkBgs: ["#0A0C0F", "#0F1318", "#141A21"], cardHex: "#0F1318", bgHex: "#0A0C0F", lcdHex: "#0F0F10",
  },
  "mission-light": {
    bg: "#F3F6F9", bgTop: "#F3F6F9", bg2: "#E8EDF2", surface: "#FFFFFF", surfaceAlt: "#DFE6ED",
    line: "#D3DBE4", lineStrong: "#B3BFCC", ink: "#D3DBE4",
    text: "#0D1620", dim: "#3E4C5C", faint: "#56657A",
    accent: "#006F80", accentText: "#006F80", onAccent: "#FFFFFF",
    ok: "#0A7A43", warn: "#8A5A00", bad: "#C0213F", info: "#006F80", magenta: "#A3237F", violet: "#5B45B0",
    claude: "#A84A00", codex: "#5B45B0", track: "#DCE3EA", progress: "#0094AA",
    chips: {
      ok: outline("#0A7A43"), warn: outline("#8A5A00"), bad: outline("#C0213F"), hot: outline("#A84A00"),
      claude: outline("#A84A00"), codex: outline("#5B45B0"), violet: outline("#5B45B0"), teal: outline("#0A7A43"),
      sky: outline("#006F80"), neutral: outline("#3E4C5C"), number: outline("#006F80"), numberMuted: outline("#3E4C5C"),
    },
    inkBgs: ["#F3F6F9", "#FFFFFF", "#E8EDF2"], cardHex: "#FFFFFF", bgHex: "#F3F6F9", lcdHex: "#0F0F10",
  },
  "paper-light": {
    bg: "#F6F2EA", bgTop: "#F6F2EA", bg2: "#ECE9E3", surface: "#FFFDF8", surfaceAlt: "#FBF7EF",
    line: "#E6DFD2", lineStrong: "#D6CCBB", ink: "#E6DFD2",
    text: "#2A2723", dim: "#4A453E", faint: "#655F56",
    accent: "#58429A", accentText: "#58429A", onAccent: "#FFFFFF",
    ok: "#2C6A3D", warn: "#735600", bad: "#A02D33", info: "#2A5A88", violet: "#58429A",
    claude: "#934514", codex: "#2A5A88", track: "#ECE9E3", progress: "#2A5A88",
    keyQueue: "#F6EDCB",
    chips: {
      ok: tint("#E2EFE1", "#2C6A3D"), warn: tint("#F6EDCB", "#735600"), bad: tint("#F8DFDF", "#A02D33"), hot: tint("#FBE5D4", "#934514"),
      claude: tint("#FBE5D4", "#934514"), codex: tint("#E0EBF7", "#2A5A88"), violet: tint("#EBE5F6", "#58429A"), teal: tint("#DBEEEC", "#1D625C"),
      sky: tint("#E0EBF7", "#2A5A88"), neutral: tint("#ECE9E3", "#6B665E"), number: tint("#EBE5F6", "#58429A"), numberMuted: tint("#ECE9E3", "#6B665E"),
    },
    inkBgs: ["#F6F2EA", "#FFFDF8", "#ECE9E3", "#FBF7EF"], cardHex: "#FFFDF8", bgHex: "#F6F2EA", lcdHex: "#0F0F10",
  },
  "paper-dark": {
    bg: "#1B1A17", bgTop: "#1B1A17", bg2: "#2F2D29", surface: "#25231F", surfaceAlt: "#211F1C",
    line: "#38352F", lineStrong: "#4A463E", ink: "#38352F",
    text: "#EFE9DF", dim: "#D2CBC0", faint: "#B0A89C",
    accent: "#CBBCF2", accentText: "#CBBCF2", onAccent: "#1B1A17",
    ok: "#A3D9B1", warn: "#EAD17C", bad: "#F4A6AC", info: "#A8CAEF", violet: "#CBBCF2",
    claude: "#F3BB8F", codex: "#A8CAEF", track: "#2F2D29", progress: "#A8CAEF",
    keyQueue: "#3A3219",
    chips: {
      ok: tint("#22362A", "#A3D9B1"), warn: tint("#3A3219", "#EAD17C"), bad: tint("#40232A", "#F4A6AC"), hot: tint("#3E2B1D", "#F3BB8F"),
      claude: tint("#3E2B1D", "#F3BB8F"), codex: tint("#1E2F42", "#A8CAEF"), violet: tint("#2E2842", "#CBBCF2"), teal: tint("#1C3634", "#97D8D1"),
      sky: tint("#1E2F42", "#A8CAEF"), neutral: tint("#2F2D29", "#A39D93"), number: tint("#2E2842", "#CBBCF2"), numberMuted: tint("#2F2D29", "#A39D93"),
    },
    inkBgs: ["#1B1A17", "#25231F", "#2F2D29", "#211F1C"], cardHex: "#25231F", bgHex: "#1B1A17", lcdHex: "#0F0F10",
  },
};

function makeTheme(layout, dark) {
  const id = `${layout}-${dark ? "dark" : "light"}`;
  return Object.assign({}, BASE, THEMES[id], { id, layout, dark, name: `${LAYOUT_LABEL[layout]} · ${dark ? "Dark" : "Light"}` });
}

// ---- colour maths (WCAG relative luminance and contrast), ported from struct RGB ----
class RGB {
  constructor(r, g, b) { this.r = r; this.g = g; this.b = b; }
  static hex(h) {
    if (!h) return null;
    h = String(h).trim().replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const v = parseInt(h, 16);
    return new RGB(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
  }
  get lum() {
    const f = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    return 0.2126 * f(this.r) + 0.7152 * f(this.g) + 0.0722 * f(this.b);
  }
  contrast(o) { const a = this.lum, b = o.lum; return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); }
  mix(o, t) { return new RGB(this.r + (o.r - this.r) * t, this.g + (o.g - this.g) * t, this.b + (o.b - this.b) * t); }
  get css() { const c = (x) => Math.round(x * 255).toString(16).padStart(2, "0").toUpperCase(); return `#${c(this.r)}${c(this.g)}${c(this.b)}`; }
  alpha(a) { return `rgba(${Math.round(this.r * 255)},${Math.round(this.g * 255)},${Math.round(this.b * 255)},${a})`; }
  /** Darken (light surfaces) or lighten (dark surfaces) until the colour reaches `target` contrast on every surface. */
  readable(bgs, target = 4.5) {
    if (!bgs.length) return this;
    const light = bgs.reduce((s, b) => s + b.lum, 0) / bgs.length > 0.25;
    let c = this;
    for (let i = 0; i <= 40; i++) {
      if (bgs.every((b) => c.contrast(b) >= target)) return c;
      c = this.mix(light ? RGB.black : RGB.white, (i + 1) * 0.025);
    }
    return c;
  }
  /** Black or white, whichever reads better. */
  get bestInk() { return this.contrast(RGB.black) >= this.contrast(RGB.white) ? RGB.black : RGB.white; }
}
RGB.black = new RGB(0, 0, 0);
RGB.white = new RGB(1, 1, 1);

/** "#RRGGBB" or "#RRGGBBAA" → rgba() with an extra opacity factor. */
function withAlpha(hex, a) {
  const h = String(hex).replace(/^#/, "");
  const base = RGB.hex(h.slice(0, 6));
  if (!base) return hex;
  const own = h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1;
  return base.alpha(+(own * a).toFixed(3));
}

// ---- worker colours: one colour per worker (W0, W1…) everywhere on the panel ----
// Okabe–Ito palette (stays distinct with the common colour-vision deficiencies), assigned by the order of the
// config's "workers" list; each theme derives readable variants (≥ 4.5:1 on every surface they sit on).
const WORKER_HUES = [["#0072B2", "blue"], ["#E69F00", "orange"], ["#009E73", "green"], ["#CC79A7", "pink"],
  ["#D55E00", "vermilion"], ["#56B4E9", "sky"], ["#F0E442", "yellow"], ["#8C8C8C", "grey"]];

class WorkerPalette {
  constructor(th, workers) {
    this.th = th;
    this.workers = workers || [];
    this.colors = {};
    for (const w of this.workers) this.colors[w.id] = WorkerPalette.make(th, w);
  }
  static make(th, w) {
    const n = WORKER_HUES.length, h = WORKER_HUES[(((w.slot || 0) % n) + n) % n];
    const custom = RGB.hex(w.color);
    const base = custom || RGB.hex(h[0]);
    const bgs = th.inkBgs.map((x) => RGB.hex(x));
    const ink = base.readable(bgs);
    const lcd = base.readable([RGB.hex(th.lcdHex)]);
    const card = RGB.hex(th.cardHex);
    let fill, on, stroke;
    if (th.layout === "studio") { fill = base; on = base.bestInk; stroke = "transparent"; }
    else if (th.layout === "mission") { fill = RGB.hex(th.bgHex).mix(ink, th.dark ? 0.16 : 0.10); on = ink.readable([fill]); stroke = ink.alpha(0.6); }
    else { fill = card.mix(base, th.dark ? 0.26 : 0.18); on = base.readable([fill]); stroke = "transparent"; }
    return {
      wid: w.id, name: w.name || "", hueName: custom ? "custom" : h[1],
      ink: ink.css, lcd: lcd.css, fill: fill.css, onFill: on.css, stroke,
      tint: card.mix(base, th.dark ? 0.12 : 0.07).css,
    };
  }
  /** By worker id ("W2"), or from a label that starts with one ("W2 Codex-B (worker)"), or names one. */
  of(wid, label) {
    if (wid && this.colors[wid]) return this.colors[wid];
    if (label) {
      const first = String(label).split(" ")[0];
      if (this.colors[first]) return this.colors[first];
      for (const c of Object.values(this.colors)) if (c.name && String(label).includes(c.name)) return c;
    }
    return null;
  }
  /** "W0 blue · W1 orange · …" for tooltips. */
  get key() { return this.workers.filter((w) => this.colors[w.id]).map((w) => `${w.id} ${this.colors[w.id].hueName}`).join(" · "); }
}
