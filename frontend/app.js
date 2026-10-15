"use strict";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const IS_ELECTRON = navigator.userAgent.includes("Electron");
if (!IS_ELECTRON) document.body.classList.add("preview");

// ---------------------------------------------------------------- storage

const LAYOUT_KEY = "overlay.layout.v1";
const THEME_KEY = "overlay.theme.v1";
const HIDDEN_KEY = "overlay.hidden.v1";
const DEFAULT_HIDDEN = { "delta-closest": true };
const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------------------------------------------------------------- format

const BAR_RANGE = { best: 1.0, rival: 0.5 }; // seconds at full bar width

function fmtLap(s) {
  if (s == null || s <= 0) return "-:--.---";
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
}

function fmtClock(s) {
  if (s == null) return "--:--";
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(2, "0"), ss = String(sec).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtSigned(v, digits = 2) {
  if (v == null) return "";
  const sign = v > 0 ? "+" : v < 0 ? "-" : " ";
  return sign + Math.abs(v).toFixed(digits);
}

// round per-frame style values to visible steps: an unchanged value costs no restyle
const step = (v, q) => Math.round(v / q) * q;

function setText(el, text, cls) {
  if (el.textContent !== text) el.textContent = text;
  if (cls !== undefined && el.dataset.cls !== cls) {
    if (el.dataset.cls) el.classList.remove(...el.dataset.cls.split(" "));
    if (cls) el.classList.add(...cls.split(" "));
    el.dataset.cls = cls;
  }
}

// Delta bar. Side shows the sign (negative grows left, positive right); color shows
// where it's heading right now: green while the delta is falling (gaining time, even
// when still behind the reference), red while it's rising (losing time, even when
// still ahead). Intensity = how fast it's changing: a 3-color scale red - bone white
// (--c-neutral, steady) - green.
const BAR_RATE_FULL = { best: 0.08, rival: 0.08 }; // s/s of delta change for full intensity
const BAR_MIN_ALPHA = 0.25;

// -1 (gaining fast) .. 0 (steady) .. 1 (losing fast) -> green .. bone white .. red
function gainLossColor(k) {
  const pctK = step(Math.min(1, Math.abs(k)) * 100, 5);
  return `color-mix(in srgb, var(${k < 0 ? "--c-good" : "--c-bad"}) ${pctK}%, var(--c-neutral))`;
}

class DeltaBar {
  constructor(fill, range, rateFull) {
    Object.assign(this, { fill, range, rateFull, prev: null, t: 0, rate: 0 });
  }
  set(v) {
    const fill = this.fill;
    if (v == null) {
      fill.style.width = "0";
      this.prev = null;
      return;
    }
    const now = performance.now() / 1000;
    const mag = Math.abs(v);
    if (this.prev != null && v !== this.prev.v) {
      const dt = Math.max(now - this.t, 1e-3);
      const raw = (v - this.prev.v) / dt; // signed: < 0 = gaining time
      this.rate += (raw - this.rate) * (1 - Math.exp(-dt / 0.35)); // ~0.35 s smoothing
    }
    // value holding still (no new sample): the rate settles back to 0 = bone white
    if (this.prev != null && v === this.prev.v && this.last != null) {
      this.rate *= Math.exp(-(now - this.last) / 0.35);
    }
    this.last = now;
    if (this.prev == null || v !== this.prev.v) { this.prev = { v }; this.t = now; }
    const w = step(Math.min(mag / this.range, 1) * 50, 0.5); // rounded: no restyle for invisible changes
    fill.style.width = `${w}%`;
    fill.style.left = v < 0 ? `${50 - w}%` : "50%";
    fill.style.background = gainLossColor(this.rate / this.rateFull);
  }
}

// ---------------------------------------------------------------- widgets

// compares with the last string set, not innerHTML (the browser re-serializes markup,
// which would make it rewrite every frame)
function setHtml(el, html) {
  if (el._html !== html) { el.innerHTML = html; el._html = html; }
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const POS_FULL_PLACES = 5; // places gained/lost for full color

// "Lone Qualify" -> "qualify", "Offline Testing" -> "testing", unknown -> as-is
const SESSION_MODES = ["practice", "qualify", "warmup", "race", "testing"];
const sessionMode = (type) =>
  SESSION_MODES.find((m) => (type || "").toLowerCase().includes(m)) || (type || "session").toLowerCase();

function renderSession(s) {
  setText($("s-mode"), sessionMode(s.type));
  setText($("s-track"), s.track || "");
  setText($("s-config"), s.trackConfig || "");
  const total = s.lapsTotal == null ? "–" : `${s.lapsEstimated ? "~" : ""}${s.lapsTotal}`;
  setHtml($("s-lap"), `${s.lap}<span class="tot">/${total}</span>`);
  setHtml($("s-pos"), s.pos > 0 ? `${s.pos}<span class="tot">/${s.cars}</span>` : "–");
  // vs grid position: green = gained, red = lost; more places -> stronger color
  const pos = $("s-pos");
  if (s.startPos && s.pos > 0 && s.pos !== s.startPos) {
    const gained = s.startPos - s.pos;
    const k = Math.min(Math.abs(gained) / POS_FULL_PLACES, 1);
    pos.style.color = `color-mix(in srgb, var(${gained > 0 ? "--c-good" : "--c-bad"}) ${Math.round(35 + 65 * k)}%, var(--c-fg))`;
    pos.title = `started P${s.startPos}`;
  } else {
    pos.style.color = "";
  }
  setText($("s-time"), fmtClock(s.timeRemain));
}

function renderClock() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  setHtml($("clock"), `${p2(d.getHours())}:${p2(d.getMinutes())}<span class="sec">:${p2(d.getSeconds())}</span>`);
}

const INCIDENT_FULL_X = 17; // full red at the session limit, or this many when unlimited

function renderIncidents(inc) {
  const el = $("i-count");
  // alert keeps its last text while fading out
  $("w-incident-alert").classList.toggle("idle", !inc.alert);
  if (inc.alert) {
    setText($("ia-label"), inc.alert.label);
    setText($("ia-x"), `${inc.alert.x}x`);
  }
  if (inc.count == null) { setText(el, "–", ""); return; }
  // count / next penalty warning / DQ, like iRacing (each part only when the session has it)
  const limits = [inc.warn, inc.limit].filter(Boolean).map((x) => ` / ${x}x`).join("");
  setHtml(el, `${inc.count}x` + (limits ? `<span class="tot">${limits}</span>` : ""));
  // 0x gray, then ever more red toward the next limit
  // toward the warning limit, then (past it) toward the DQ limit
  const target = inc.warn && inc.count <= inc.warn ? inc.warn : inc.limit || inc.warn || INCIDENT_FULL_X;
  const k = Math.min(inc.count / target, 1);
  el.style.color = inc.count > 0
    ? `color-mix(in srgb, var(--c-bad) ${Math.round(25 + 75 * k)}%, var(--c-muted))`
    : "var(--c-muted)";
}

// pit limiter: "pit limiter" while it's on; "limiter off" in red when I'm moving on pit
// road without it (speeding penalty); hidden otherwise
function renderPit(p) {
  const missing = p.onPitRoad && p.moving && !p.limiter;
  const w = $("w-pit");
  w.classList.toggle("idle", !p.limiter && !missing);
  w.classList.toggle("missing", missing);
  setText($("pit-text"), missing ? "limiter off" : "pit limiter");
}

function renderLaps(l) {
  const pb = l.last != null && l.best != null && Math.abs(l.last - l.best) < 0.0005;
  setText($("l-last"), fmtLap(l.last), pb ? "good" : "");
  setText($("l-opt"), fmtLap(l.optimal));
}

function renderFuel(f) {
  setText($("f-level"), f.level == null ? "–" : `${f.level.toFixed(1)} L`);
  const fill = $("f-fill"), mark = $("f-mark");
  if (f.level != null && f.capacity) {
    fill.style.width = `${step(Math.min(f.level / f.capacity, 1) * 100, 0.5)}%`;
    const lapsLeft = f.lapsLeft ?? Infinity;
    fill.className = "tank-fill" + (lapsLeft < 2 ? " bad" : lapsLeft < 4 ? " warn" : "");
    // marker = fuel needed from here to the flag
    const needed = f.toFinish == null ? null : f.level + f.toFinish;
    const show = needed != null && needed > 0 && needed <= f.capacity;
    mark.style.display = show ? "block" : "none";
    if (show) mark.style.left = `${(needed / f.capacity) * 100}%`;
  } else {
    fill.style.width = "0";
    mark.style.display = "none";
  }
  setText($("f-per"), f.perLap == null ? "–" : `${f.perLap.toFixed(2)} L`);
  const lapsCls = f.lapsLeft != null && f.lapsLeft < 2 ? "bad" : "";
  setText($("f-laps"), f.lapsLeft == null ? "–" : f.lapsLeft.toFixed(1), lapsCls);
  if (f.toFinish == null) setText($("f-need"), "–", "");
  else if (f.toFinish > 0) setText($("f-need"), `+${f.toFinish.toFixed(1)} L`, "warn");
  else setText($("f-need"), "ok", "good");
}

// shown next to the name while that driver is on the radio
const RADIO_ICON =
  '<svg class="radio" viewBox="0 0 16 16" aria-hidden="true">' +
  '<rect x="6" y="2" width="4" height="7" rx="2" fill="currentColor"/>' +
  '<path d="M4 7.5a4 4 0 0 0 8 0M8 11.5V14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path class="wave" d="M1.8 5.5a6.5 6.5 0 0 0 0 4M14.2 5.5a6.5 6.5 0 0 1 0 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
  "</svg>";

const stRows = new Map(); // car id -> row elements
const ROW_MOVE_MS = 300;
function standingsRow() {
  const row = document.createElement("div");
  row.className = "srow";
  row.innerHTML =
    '<span class="pos"></span><span class="num"></span><span class="ir"></span><img class="flag" alt="">' +
    `<span class="name"></span>${RADIO_ICON}<span class="tag"></span><span class="tire"></span><span class="best"></span><span class="gap"></span>`;
  const [pos, num, ir, flag, name, radio, tag, tire, best, gap] = row.children;
  return { row, pos, num, flag, name, radio, tag, tire, ir, best, gap };
}

// rows keep their element per car; when the order changes they slide (FLIP)
function reorderRows(container, ids) {
  const current = [...container.children].map((el) => el.dataset.id);
  if (current.length === ids.length && current.every((id, i) => id === ids[i])) return;
  const before = new Map();
  for (const id of ids) {
    const el = stRows.get(id)?.row;
    if (el && el.isConnected) before.set(id, el.getBoundingClientRect().top);
  }
  // move only rows that are out of place: re-inserting a node restarts its animations
  ids.forEach((id, i) => {
    const el = stRows.get(id).row;
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] || null);
  });
  for (const [id, top] of before) {
    const el = stRows.get(id).row;
    const dy = top - el.getBoundingClientRect().top;
    if (!dy) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }], {
      duration: ROW_MOVE_MS,
      easing: "cubic-bezier(.2,.8,.2,1)",
    });
  }
}

let multiclass = false;
// tire compound name (DriverTires TireCompoundType, lowercased) -> badge color class
const TIRE_KIND = { wet: "wet", rain: "wet", soft: "soft", medium: "medium", hard: "hard", primary: "hard", alternate: "soft" };


function renderStandings(rows) {
  setText($("st-title"), state.session?.standings ? "// standings" : state.session?.grid ? "// grid" : "// relative");
  const container = $("st-rows");
  const ids = rows.map((r) => String(r.id));
  for (const [id, el] of stRows) {
    if (!ids.includes(id)) { el.row.remove(); stRows.delete(id); }
  }
  for (const id of ids) {
    if (!stRows.has(id)) {
      const el = standingsRow();
      el.row.dataset.id = id;
      stRows.set(id, el);
      // fade in once, only for a car newly entering the list (not on reorder)
      el.row.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ROW_MOVE_MS, easing: "ease-out" });
    }
  }
  reorderRows(container, ids);
  rows.forEach((r) => {
    const el = stRows.get(String(r.id));
    el.row.classList.toggle("me", r.isMe);
    el.row.classList.toggle("leader", !!r.leader); // pinned P1, not next to me
    el.row.classList.toggle("pit", r.inPit);
    el.row.classList.toggle("talking", !!r.radio);
    el.row.classList.toggle("lap-up", r.lapRel > 0);
    el.row.classList.toggle("lap-down", r.lapRel < 0);
    setText(el.pos, r.pos > 0 ? `P${r.pos}` : "–");
    // multiclass: badge in the car's class color + class tag; lap up/down tag otherwise wins
    const clsColor = multiclass && r.clsColor ? r.clsColor : "";
    if (el.pos.dataset.cls !== clsColor) {
      el.pos.dataset.cls = clsColor;
      el.pos.style.setProperty("--badge", clsColor || "");
      el.pos.classList.toggle("class-color", !!clsColor);
    }
    const lapTag = r.lapRel ? `${r.lapRel > 0 ? "+" : ""}${r.lapRel}L` : "";
    // class: first letter only, bold, in the class color
    const clsTag = multiclass && r.cls ? r.cls.trim().charAt(0).toUpperCase() : "";
    setText(el.tag, lapTag || clsTag, lapTag ? (r.lapRel > 0 ? "lap-up" : "lap-down") : clsTag ? "cls" : "");
    if (!lapTag && multiclass) el.tag.style.color = r.clsColor || "";
    else el.tag.style.color = "";
    setText(el.num, `#${r.num}`);
    const src = r.cc ? `https://flagcdn.com/w40/${r.cc}.png` : "";
    if (el.flag.dataset.src !== src) {
      el.flag.dataset.src = src;
      el.flag.src = src;
      el.flag.classList.toggle("on", !!src);
    }
    setText(el.name, r.name);
    setText(el.ir, r.ir ? `${(r.ir / 1000).toFixed(1)}k` : "");
    // badge in the license color, dimmed by safety rating (0.x / 1.x / 2.x / 3+): the sim's
    // own LicColor (what the game UI shows) when it sends one, else --c-lic-*
    const lic = r.ir && r.lic ? r.lic.charAt(0).toLowerCase() : "";
    const level = Math.min(3, Math.max(0, Math.floor(r.sr ?? 0)));
    const base = lic ? r.licColor || colors[`--c-lic-${lic}`] || "" : "";
    const licKey = lic && `${lic}${level}${base}`;
    if (el.ir.dataset.lic !== licKey) {
      el.ir.dataset.lic = licKey;
      el.ir.className = licKey
        ? `ir lic sr${level}${lic === "p" ? " pro" : ""}` : "ir";
      if (lic) el.ir.style.setProperty("--lic", r.licColor || `var(--c-lic-${lic}, var(--c-irating))`);
      else el.ir.style.removeProperty("--lic");
      el.ir.title = licKey ? `${r.lic} ${r.sr?.toFixed(2)}` : "";
    }
    // tire compound (only sent when the series has a choice): first letter on a tire badge
    setText(el.tire, r.tire ? r.tire.charAt(0).toUpperCase() : "", r.tire ? `on ${TIRE_KIND[r.tire] || "other"}` : "");
    if (el.tire.title !== (r.tire || "")) el.tire.title = r.tire || "";
    setText(el.best, fmtLap(r.best), r.bestIsClassBest ? "class-best" : "");
    let gap = "", cls = "";
    if (!r.isMe && r.gap != null) {
      gap = fmtSigned(r.gap);
      cls = r.gap < 0 ? "ahead" : "behind";
    }
    setText(el.gap, gap, cls);
  });
}

const UP = "▲", DOWN = "▼";
const DELTA_WIDGETS = [
  { id: "delta-best", title: "best", kind: "best" },
  { id: "delta-ahead", title: UP, kind: "ahead" },
  { id: "delta-behind", title: DOWN, kind: "behind" },
  { id: "delta-closest", title: `${UP}${DOWN} closest`, kind: "closest" },
];

function buildDeltaWidgets() {
  const anchor = $("w-radar");
  for (const w of DELTA_WIDGETS) {
    const el = document.createElement("div");
    el.className = `widget delta ${w.kind}`;
    el.id = `w-${w.id}`;
    el.dataset.id = w.id;
    el.innerHTML =
      `<div class="title">// ${w.title}</div>` +
      '<div class="drow"><span class="v">–</span><div class="bar"><div class="fill"></div></div></div>' +
      (w.kind === "best" ? "" : '<div class="catch"></div>');
    document.body.insertBefore(el, anchor);
    const rateFull = w.kind === "best" ? BAR_RATE_FULL.best : BAR_RATE_FULL.rival;
    const range = w.kind === "best" ? BAR_RANGE.best : BAR_RANGE.rival;
    w.el = el;
    w.v = el.querySelector(".v");
    w.titleEl = el.querySelector(".title");
    w.catchEl = el.querySelector(".catch");
    w.fill = el.querySelector(".fill");
    if (w.kind === "best") w.bar = new DeltaBar(el.querySelector(".fill"), range, rateFull);
  }
}

const PROX_RANGE_S = 2.0; // proximity bar: empty at this gap, full at 0
const CLOSE_GAP_S = 0.5; // below this gap the cars are together: "on their / your tail"
const HOLD_S_PER_LAP = 0.05; // closing speed below this (s/lap, after rounding) reads as "holding"
const STATUS_HOLD_MS = 1200; // new status must be stable this long before it shows
const CLOSING_SMOOTH_S = 5; // closing speed (s/lap) is smoothed this much...
const STATUS_NUM_MS = 3000; // ...and a new 0.1 s/lap value must hold this long to show

const RIVAL_SWAP_MS = 250; // a different car in the widget: quick fade so a pass reads as one

function renderRival(w, r, arrow) {
  const ahead = arrow === UP;
  const car = r ? `${arrow}${r.num}` : null;
  if (w.lastCar !== car) {
    if (w.lastCar && car) w.el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: RIVAL_SWAP_MS, easing: "ease-out" });
    w.lastCar = car;
  }
  if (!r) {
    setText(w.v, "–", ""); setHtml(w.titleEl, `// ${arrow}`); setText(w.catchEl, "", "");
    w.v.style.color = "";
    w.fill.style.width = "0";
    return;
  }
  // car ahead "+", car behind "-". Hue is always the global ahead/behind color;
  // gaining vs losing right now only changes saturation: full color when gaining,
  // washed out toward the light text gray when losing
  const sign = ahead ? "+" : "-";
  const gapAbs = Math.abs(r.gap);
  const gain = (r.gain ?? 0) / BAR_RATE_FULL.rival;
  const k = (Math.max(-1, Math.min(1, gain)) + 1) / 2; // 0 = losing fast, 1 = gaining fast
  setText(w.v, `${sign}${gapAbs.toFixed(2)}`, "");
  const base = ahead ? "var(--c-ahead)" : "var(--c-behind)";
  const tint = `color-mix(in srgb, ${base} ${step(10 + 90 * k, 5)}%, var(--c-fg))`;
  w.v.style.color = tint;
  // standing position + name in bold, a dot in the class color (multiclass), and the
  // lapped / lapping tag like the relative
  const pos = r.pos > 0 ? `<b class="rp">P${r.pos}</b> ` : "";
  const dot = multiclass && r.clsColor ? ` <span class="cls-dot" style="--dot:${r.clsColor}" title="${esc(r.cls)}"></span>` : "";
  const lap = r.lapRel ? ` ${r.lapRel > 0 ? "+" : ""}${r.lapRel}L` : "";
  setHtml(w.titleEl, `// ${arrow} ${pos}#${esc(r.num)} <b class="rn">${esc(r.name)}</b>${dot}${lap}`);

  // proximity: the closer the car, the fuller the bar
  const prox = Math.min(1, Math.max(0, 1 - gapAbs / PROX_RANGE_S));
  w.fill.style.left = "0";
  w.fill.style.width = `${step(prox * 100, 0.5)}%`;
  w.fill.style.opacity = "1";
  w.fill.style.background = tint;
  w.fill.className = "fill prox";

  // status line, calm on purpose, in spotter words: the closing speed in s/lap (gap
  // shrinking or growing), smoothed (CLOSING_SMOOTH_S) and rounded to 0.1; a new value
  // must hold STATUS_NUM_MS and a new status STATUS_HOLD_MS before they show
  const now = performance.now();
  const st = (w.status ??= { car: null, kind: "", rate: null, pending: null, since: 0, smooth: null, t: now, nextRate: null, rateSince: 0 });
  if (st.car !== r.num) st.smooth = null; // new car: start over
  const dt = Math.min((now - st.t) / 1000, 1);
  st.t = now;
  st.smooth = r.closing == null ? null
    : st.smooth == null ? r.closing : st.smooth + (r.closing - st.smooth) * (1 - Math.exp(-dt / CLOSING_SMOOTH_S));
  const rate = st.smooth == null ? null : Math.round(Math.abs(st.smooth) * 10) / 10; // s/lap
  let kind = "";
  if (gapAbs < CLOSE_GAP_S) kind = "close"; // already together
  else if (r.catchAfterFlag) kind = "flag"; // closing, but the race ends first
  else if (rate != null) kind = rate < HOLD_S_PER_LAP ? "hold" : st.smooth > 0 ? "closing" : "away";
  const shown = kind === "closing" || kind === "away" ? rate : null;
  if (st.car !== r.num) {
    Object.assign(st, { car: r.num, kind, rate: shown, pending: null, nextRate: null });
  } else if (kind !== st.kind) {
    if (st.pending !== kind) { st.pending = kind; st.since = now; }
    if (now - st.since >= STATUS_HOLD_MS) Object.assign(st, { kind, rate: shown, pending: null, nextRate: null });
  } else {
    st.pending = null;
    if (shown != null && shown !== st.rate) {
      if (st.nextRate !== shown) { st.nextRate = shown; st.rateSince = now; }
      if (now - st.rateSince >= STATUS_NUM_MS) { st.rate = shown; st.nextRate = null; }
    } else st.nextRate = null;
  }
  const v = st.rate == null ? "" : ` ${st.rate.toFixed(1)} s/lap`;
  const text = {
    closing: ahead ? `closing${v}` : `closing on you${v}`,
    away: `pulling away${v}`, // spotter wording, either way
    close: ahead ? "on their tail" : "on your tail",
    flag: ahead ? "won't catch by the flag" : "safe to the flag",
    hold: "holding",
  }[st.kind] || "";
  setText(w.catchEl, text, "");
}

const CLOSEST_HOLD_S = 0.1; // "closest" widget switches cars only when the other is this much closer
const RIVAL_HIDE_DEFAULT_S = 10; // ▲/▼ widgets hide beyond this gap (per widget in edit mode)

function renderDelta(d) {
  // no car there, or too far away to matter
  const gone = (w, r) => !r || Math.abs(r.gap) > (parseFloat(w.el.dataset.hide) || RIVAL_HIDE_DEFAULT_S);
  for (const w of DELTA_WIDGETS) {
    if (w.kind === "best") {
      w.el.classList.toggle("idle", d.best == null);
      if (d.ref) setText(w.el.querySelector(".title"), `// Δ ${d.ref}`);
      setText(w.v, d.best == null ? "–" : fmtSigned(d.best), d.best == null ? "" : d.best < 0 ? "good" : "bad");
      w.bar.set(d.best);
      // number: hue by sign, intensity by how fast the delta is changing (like the bar)
      const k = d.best == null ? 0 : Math.min(1, Math.abs(w.bar.rate) / w.bar.rateFull);
      w.v.style.color = d.best == null ? ""
        : `color-mix(in srgb, var(${d.best < 0 ? "--c-good" : "--c-bad"}) ${step(35 + 65 * k, 5)}%, var(--c-neutral))`;
    } else if (w.kind === "ahead") {
      w.el.classList.toggle("idle", gone(w, d.ahead));
      renderRival(w, d.ahead, UP);
    } else if (w.kind === "behind") {
      w.el.classList.toggle("idle", gone(w, d.behind));
      renderRival(w, d.behind, DOWN);
    } else {
      // closest on track by time gap
      // the nearer of the two; when both are about as close, stick with the current one
      const key = (r) => (r ? Math.abs(r.gap) : Infinity);
      let ahead = key(d.ahead) <= key(d.behind);
      if (w.pickAhead != null && ahead !== w.pickAhead && Math.abs(key(d.ahead) - key(d.behind)) < CLOSEST_HOLD_S) ahead = w.pickAhead;
      w.pickAhead = ahead;
      const r = ahead ? d.ahead : d.behind;
      w.el.classList.toggle("idle", gone(w, r));
      w.el.classList.toggle("ahead", !!r && ahead);
      w.el.classList.toggle("behind", !!r && !ahead);
      renderRival(w, r, ahead ? UP : DOWN);
    }
  }
}

// ---------------------------------------------------------------- radar

// lateral position as a fraction of radar radius (SDK has no real lateral distance)
const LANE = { L: -0.45, L2: -0.75, C: 0, R: 0.45, R2: 0.75 };
const CAR = { len: 4.6, wid: 1.9 };
let colors = {};
// "40%" -> 0.4; 0 is a valid value, only unparsable falls back
function pct(value, fallback) {
  const v = parseFloat(value);
  return Number.isNaN(v) ? fallback : v / 100;
}

function refreshColors() {
  const cs = getComputedStyle(root);
  for (const k of ["--c-bg", "--c-border", "--c-me", "--c-muted", "--c-radar-car", "--c-radar-danger", "--c-fg", "--c-good", "--c-bad", "--c-neutral", "--c-ahead", "--c-behind", "--c-lap-up", "--c-lap-down",
    "--c-lic-r", "--c-lic-d", "--c-lic-c", "--c-lic-b", "--c-lic-a", "--c-lic-p"]) {
    colors[k] = cs.getPropertyValue(k).trim();
  }
  colors.opacity = pct(cs.getPropertyValue("--bg-opacity"), 0.8);
  colors.font = getComputedStyle(document.body).fontFamily; // canvas text (radar)
}

const RADAR_DEFAULT_RANGE = 20; // metres
// radar shows when a car is this close bumper to bumper (or alongside); per widget in edit mode
const RADAR_SHOW_AHEAD_M = 2;
const RADAR_SHOW_BEHIND_M = 3;
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;
const RADAR_DIM = 0.55; // opacity of in-line (not alongside) cars
const RADAR_SLIDE_MS = 120; // sideways easing time constant
const radarAnim = { t: 0, lat: new Map() }; // car id -> current sideways position

function renderRadar(r) {
  const canvas = $("radar");
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = canvas.height = Math.round(size * dpr);
  }
  const ctx = canvas.getContext("2d");

  const c = size / 2;
  const rad = c - 2;
  // per-widget settings (edit mode -> select radar): view range = what's drawn,
  // show ahead/behind = bumper gap that makes the radar appear
  const w = $("w-radar");
  const range = parseFloat(w.dataset.range) || RADAR_DEFAULT_RANGE;
  const ppm = rad / range; // pixels per metre
  const sideAlert = { left: "L", left2: "L", right: "R", right2: "R", both: "LR" }[r.spotter] || "";
  const visibleCars = r.cars.filter((x) => Math.abs(x.d) <= range);
  const showAhead = parseFloat(w.dataset.sa ?? RADAR_SHOW_AHEAD_M);
  const showBehind = parseFloat(w.dataset.sb ?? RADAR_SHOW_BEHIND_M);
  const close = r.cars.some((x) => Math.abs(x.d) - (r.carLen || 0) <= (x.d >= 0 ? showAhead : showBehind));

  const idle = !sideAlert && !close;
  w.classList.toggle("idle", idle);
  // nothing to show: skip the drawing (it's fading out with its last frame anyway), unless
  // placing it in edit mode. Even clearing would make the browser repaint the canvas.
  if (idle && !document.body.classList.contains("edit")) {
    radarAnim.t = 0;
    radarAnim.lat.clear();
    return;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  // disc
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, rad, 0, Math.PI * 2);
  ctx.globalAlpha = pct(w.dataset.bg, colors.opacity); // per-widget bg, else global
  ctx.fillStyle = colors["--c-bg"];
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colors["--c-border"];
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();

  // three (or more) wide: glow flashes rapidly (~6 Hz)
  const threeWide = r.spotter === "both" || r.spotter === "left2" || r.spotter === "right2";
  // (accessibility: "3-wide flashing" off in edit mode, default off with reduced motion)
  const flashOn = parseFloat(w.dataset.flash ?? (REDUCED_MOTION ? 0 : 1)) > 0;
  const flash = threeWide && flashOn ? (Math.floor(performance.now() / 85) % 2 ? 1 : 0.15) : 1;

  // side warning glow (ACC style): brightest at the rim beside me, fading toward the
  // centre and toward ahead/behind (radial, so no hard line down the middle)
  const [dr, dg, db] = hexRgb(colors["--c-radar-danger"]);
  const glow = (a) => `rgba(${dr},${dg},${db},${a})`;
  for (const side of sideAlert) {
    const x0 = side === "L" ? c - rad : c + rad;
    const g = ctx.createRadialGradient(x0, c, 0, x0, c, rad); // zero by the centre: no seam
    g.addColorStop(0, glow(1));
    g.addColorStop(0.35, glow(0.6));
    g.addColorStop(1, glow(0));
    ctx.globalAlpha = 0.9 * flash;
    ctx.fillStyle = g;
    ctx.fillRect(side === "L" ? c - rad : c, c - rad, rad, rad * 2);
    // bright rim on the occupied side, fading out toward 12 and 6 o'clock
    const rim = ctx.createLinearGradient(0, c - rad, 0, c + rad);
    rim.addColorStop(0, glow(0));
    rim.addColorStop(0.5, glow(1));
    rim.addColorStop(1, glow(0));
    ctx.beginPath();
    const a0 = side === "L" ? Math.PI * 0.5 : -Math.PI * 0.5;
    ctx.arc(c, c, rad - 2, a0, a0 + Math.PI);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 4;
    ctx.globalAlpha = flash;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // range rings every 5 m: always the same thin dots (set the width here, the side
  // glow's rim above leaves it at 4 px)
  ctx.strokeStyle = colors["--c-border"];
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  for (let m = 5; m < range; m += 5) {
    ctx.beginPath();
    ctx.arc(c, c, m * ppm, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  const drawCar = (x, y, fill, stroke) => {
    const w = CAR.wid * ppm, h = CAR.len * ppm;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  };

  // ease each car's sideways position so moving alongside slides instead of jumping;
  // color and brightness blend from dim ahead/behind to alongside red with it
  const now = performance.now();
  const dt = radarAnim.t ? Math.min(now - radarAnim.t, 100) : 0;
  radarAnim.t = now;
  const ease = 1 - Math.exp(-dt / RADAR_SLIDE_MS);
  const seen = new Set();
  const danger = hexRgb(colors["--c-radar-danger"]);
  for (const car of visibleCars) {
    const target = LANE[car.side];
    const prev = radarAnim.lat.get(car.id);
    const lat = prev == null ? target : prev + (target - prev) * ease;
    radarAnim.lat.set(car.id, lat);
    seen.add(car.id);
    const t = Math.min(Math.abs(lat) / Math.abs(LANE.L), 1); // 0 = in line, 1 = alongside
    const base = hexRgb(car.d > 0 ? colors["--c-ahead"] : colors["--c-behind"]);
    const [r, g, b] = mixRgb(base, danger, t);
    ctx.globalAlpha = RADAR_DIM + (1 - RADAR_DIM) * t;
    drawCar(c + lat * rad, c - car.d * ppm, `rgb(${r},${g},${b})`);
    ctx.globalAlpha = 1;
  }
  for (const id of radarAnim.lat.keys()) if (!seen.has(id)) radarAnim.lat.delete(id);
  drawCar(c, c, null, colors["--c-me"]);

  // nearest ahead / behind distance
  ctx.font = `${Math.round(size * 0.065)}px ${colors.font}`;
  ctx.fillStyle = colors["--c-fg"];
  ctx.textAlign = "center";
  const inLine = visibleCars.filter((x) => x.side === "C");
  const ahead = inLine.filter((x) => x.d > 0).sort((a, b) => a.d - b.d)[0];
  const behind = inLine.filter((x) => x.d <= 0).sort((a, b) => b.d - a.d)[0];
  if (ahead) ctx.fillText(`${ahead.d.toFixed(1)}m`, c, c - rad + size * 0.1);
  if (behind) ctx.fillText(`${(-behind.d).toFixed(1)}m`, c, c + rad - size * 0.05);
  ctx.restore();
}

// ---------------------------------------------------------------- map

// delta change per metre for full paint intensity (bar: 0.08 s/s at ~50 m/s)
const PAINT_FULL_S_PER_M = 0.0016;
// performance: the map redraws at MAP_FPS (cars move a pixel or two per frame), and the
// static layer (road, paint, start line) is rebuilt at most every PAINT_REBUILD_MS
const MAP_FPS = 30;
const PAINT_REBUILD_MS = 300;
const mapCache = { version: -1, points: null };
const mapView = { heading: null };
const MAP_ROAD_W = 11; // px, base track
const MAP_PAINT_W = 7; // px, delta paint on top of the road
const MAP_FOLLOW_DEFAULT_M = 400; // follow mode: metres of track from me to the top edge
const MAP_FOLLOW_Y = 0.72; // follow mode: my car sits this far down the widget
const MAP_HEADING_LOOK = 0.004; // lap % either side used to measure my heading
const MAP_ROTATE_EASE = 0.2; // per-frame easing of the follow rotation

// ---------- map paint: smooth gradient
// Each ~10 m piece gets a signed strength, like the delta bar: time gained in that piece =
// green, lost = red, stronger the faster it went. Then it's blurred along the track so
// colors flow into each other. Rendered to an offscreen canvas only when the paint changes.
const PAINT_BLUR_M = 60; // gaussian sigma along the track
const paintCache = { geo: "", paintKey: "", builtAt: 0, canvas: null, smKey: "", sm: null };

function hexRgb(hex) {
  const h = (hex || "#888888").replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function smoothPaint(paint, segLen, paintNow) {
  const S = paint.length;
  const raw = new Array(S).fill(null);
  const fullStep = PAINT_FULL_S_PER_M * segLen;
  for (let k = 0; k < S; k++) {
    const p = paint[k];
    if (!p || p[1] == null) continue;
    // p[1] = delta change across the piece: < 0 gained (green), > 0 lost (red)
    const kk = Math.max(-1, Math.min(1, p[1] / fullStep));
    const strength = BAR_MIN_ALPHA + (1 - BAR_MIN_ALPHA) * Math.abs(kk);
    raw[k] = { v: (p[1] < 0 ? -1 : 1) * strength, w: 1 };
  }
  const sigma = Math.max(1, PAINT_BLUR_M / segLen);
  const R = Math.ceil(sigma * 2.5);
  const kernel = [];
  for (let i = -R; i <= R; i++) kernel.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const out = new Array(S);
  for (let k = 0; k < S; k++) {
    let sv = 0, sw = 0, sd = 0;
    for (let i = -R; i <= R; i++) {
      const r = raw[(k + i + S) % S];
      if (!r) continue;
      const g = kernel[i + R];
      sv += r.v * g; sd += r.w * g; sw += g;
    }
    out[k] = sw ? { v: sv / sw, dim: sd / sw, cover: Math.min(1, sw / (sigma * 2.5)) } : null;
  }
  return out;
}

// smoothed paint, recomputed only when the paint data changes
function smoothedPaint(m) {
  const paint = m.paint || [];
  const key = `${m.version}|${m.paintNow}|${paint.length}|${m.segLen}`;
  if (paintCache.smKey !== key) {
    paintCache.smKey = key;
    paintCache.sm = smoothPaint(paint, m.segLen, m.paintNow);
  }
  return paintCache.sm;
}

// overview: road + paint + start line in an offscreen layer; each frame only copies it
// (and draws the cars). Geometry changes rebuild at once, paint updates at most every
// PAINT_REBUILD_MS.
function drawStaticLayer(ctx, m, at, W, H, N) {
  const dpr = window.devicePixelRatio || 1;
  const geo = [mapCache.version, N, m.segLen, W, H, dpr, m.mirror, colors["--c-good"], colors["--c-bad"], colors["--c-neutral"], colors["--c-muted"], colors["--c-fg"]].join("|");
  const now = performance.now();
  const paintKey = `${m.paintNow}|${(m.paint || []).length}`;
  const stale = paintCache.geo !== geo || (paintCache.paintKey !== paintKey && now - paintCache.builtAt >= PAINT_REBUILD_MS);
  if (stale) {
    Object.assign(paintCache, { geo, paintKey, builtAt: now });
    const off = paintCache.canvas || (paintCache.canvas = document.createElement("canvas"));
    off.width = Math.round(W * dpr);
    off.height = Math.round(H * dpr);
    const o = off.getContext("2d");
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, W, H);
    drawRoad(o, at, N);
    const S = (m.paint || []).length;
    if (S) strokePaint(o, smoothedPaint(m), S, at, () => true, true);
    drawStartLine(o, at);
  }
  ctx.drawImage(paintCache.canvas, 0, 0, W, H);
}

function drawRoad(ctx, at, N) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (let i = 0; i < N; i++) ctx[i ? "lineTo" : "moveTo"](...at(i / N));
  ctx.closePath();
  ctx.strokeStyle = colors["--c-muted"];
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = MAP_ROAD_W;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function drawStartLine(ctx, at) {
  const [sx, sy] = at(0);
  const [tx, ty] = at(0.003);
  const nx = -(ty - sy), ny = tx - sx, nl = Math.hypot(nx, ny) || 1;
  ctx.beginPath();
  ctx.moveTo(sx - (nx / nl) * 9, sy - (ny / nl) * 9);
  ctx.lineTo(sx + (nx / nl) * 9, sy + (ny / nl) * 9);
  ctx.strokeStyle = colors["--c-fg"];
  ctx.lineWidth = 2;
  ctx.stroke();
}

// gradient = smooth color flow between pieces (cached overview); follow mode redraws
// every frame, so it uses one flat color per piece (gradients are the expensive part)
function strokePaint(o, sm, S, at, visible, gradient) {
    o.lineWidth = MAP_PAINT_W;
    o.lineCap = "butt"; // round caps would stack alpha at every joint
    // red - bone white - green, like the delta bar
    const good = hexRgb(colors["--c-good"]), bad = hexRgb(colors["--c-bad"]), mid = hexRgb(colors["--c-neutral"]);
    const colorAt = (k) => {
      const p = sm[k % S];
      if (!p) return null;
      const t = Math.min(1, Math.abs(p.v));
      const [r, g, b] = mixRgb(mid, p.v < 0 ? good : bad, Math.min(1, t * 1.4));
      return `rgba(${r},${g},${b},${((0.25 + 0.75 * t) * p.dim * p.cover).toFixed(2)})`;
    };
    for (let k = 0; k < S; k++) {
      const c0 = colorAt(k), c1 = colorAt(k + 1);
      if (!c0 || !c1) continue;
      // from this piece's centre to the next one's: no visible steps
      const [x0, y0] = at((k + 0.5) / S), [x1, y1] = at((k + 1.5) / S);
      if (!visible(x0, y0) && !visible(x1, y1)) continue;
      if (gradient) {
        const grad = o.createLinearGradient(x0, y0, x1, y1);
        grad.addColorStop(0, c0);
        grad.addColorStop(1, c1);
        o.strokeStyle = grad;
      } else {
        o.strokeStyle = c0;
      }
      o.beginPath();
      o.moveTo(x0, y0);
      o.lineTo(...at((k + 1) / S));
      o.lineTo(x1, y1);
      o.stroke();
    }
}

function placeholderShape(lengthM) {
  if (placeholderShape.len === lengthM) return placeholderShape.pts;
  const r = lengthM / (2 * Math.PI), n = 360;
  // start/finish at the bottom, driving counter-clockwise
  placeholderShape.pts = Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
    return [r * Math.cos(a), r * Math.sin(a)];
  });
  placeholderShape.len = lengthM;
  return placeholderShape.pts;
}

function renderMap(m) {
  if (m.points !== undefined && (m.version !== mapCache.version || !mapCache.points)) {
    mapCache.version = m.version;
    mapCache.points = m.points;
    mapCache.bbox = null;
  }
  // cars move a pixel or two per frame: half the frame rate is enough
  const tNow = performance.now();
  if (tNow - (mapCache.drawnAt || 0) < 1000 / MAP_FPS - 2) return;
  mapCache.drawnAt = tNow;
  const canvas = $("map");
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  // no recorded shape yet: cars and paint go on a circle of the track's length
  const recorded = !!mapCache.points;
  const pts = mapCache.points || placeholderShape((m.segLen || 10) * ((m.paint || []).length || 400));
  // re-recording keeps showing the old shape until the new lap is in
  const redo = m.status === "rerecording";
  setText($("map-title"), m.recording != null ? `// map · ${redo ? "re-" : ""}recording ${Math.round(m.recording * 100)}%`
    : redo ? "// map · re-record: drive 1 clean lap"
    : recorded ? "// map"
    : "// map · drive 1 clean lap to record");

  // world position (metres, y up) at a lap %, mirror applied
  const N = pts.length;
  const mir = m.mirror ? -1 : 1;
  const world = (pct) => {
    const f = (((pct % 1) + 1) % 1) * N;
    const i = Math.floor(f) % N, j = (i + 1) % N, t = f - Math.floor(f);
    return [mir * (pts[i][0] + (pts[j][0] - pts[i][0]) * t), pts[i][1] + (pts[j][1] - pts[i][1]) * t];
  };

  // world -> screen: whole-track overview, or follow mode (me centred low, heading up)
  const w = $("w-map");
  const me = (m.cars || []).find((c) => c[1] === 1);
  const follow = w.dataset.follow === "1" && !!me && recorded;
  let toS;
  if (follow) {
    const range = parseFloat(w.dataset.frange) || MAP_FOLLOW_DEFAULT_M;
    const [cx, cy] = world(me[0]);
    const [ax, ay] = world(me[0] + MAP_HEADING_LOOK);
    const [bx, by] = world(me[0] - MAP_HEADING_LOOK);
    const target = Math.atan2(ay - by, ax - bx);
    // ease the rotation so the map doesn't twitch
    if (mapView.heading == null) mapView.heading = target;
    const diff = Math.atan2(Math.sin(target - mapView.heading), Math.cos(target - mapView.heading));
    mapView.heading += diff * MAP_ROTATE_EASE;
    const phi = Math.PI / 2 - mapView.heading; // rotate heading onto screen-up
    const c = Math.cos(phi), s = Math.sin(phi);
    const sc = (H * MAP_FOLLOW_Y) / range; // `range` metres from me to the top edge
    toS = (x, y) => {
      const dx = x - cx, dy = y - cy;
      return [W / 2 + (dx * c - dy * s) * sc, H * MAP_FOLLOW_Y - (dx * s + dy * c) * sc];
    };
  } else {
    mapView.heading = null;
    // bounding box only changes with the shape
    if (!mapCache.bbox || mapCache.bbox.pts !== pts || mapCache.bbox.mir !== mir) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x0, y] of pts) {
        const x = mir * x0;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
      mapCache.bbox = { pts, mir, minX, maxX, minY, maxY };
    }
    const { minX, maxX, minY, maxY } = mapCache.bbox;
    const pad = 10;
    const sc = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
    const ox = (W - (maxX - minX) * sc) / 2, oy = (H - (maxY - minY) * sc) / 2;
    toS = (x, y) => [(x - minX) * sc + ox, H - ((y - minY) * sc + oy)];
  }
  const at = (pct) => toS(...world(pct));

  if (follow) {
    // view moves every frame: draw road + paint directly, only pieces on screen
    drawRoad(ctx, at, N);
    const S = (m.paint || []).length;
    if (S) strokePaint(ctx, smoothedPaint(m), S, at, (x, y) => x > -20 && y > -20 && x < W + 20 && y < H + 20, false);
    drawStartLine(ctx, at);
  } else {
    drawStaticLayer(ctx, m, at, W, H, N);
  }

  // cars: others first, me on top
  // [pct, kind, class color, lapRel]: cars in their class color (pit: muted), a lap
  // up / down gets a lap-up / lap-down ring, everything else a dark border so it
  // stands out on the paint
  const radius = { 0: 4.5, 1: 6.5, 2: 3.5 };
  const cars = [...(m.cars || [])].sort((a, b) => (a[1] === 1) - (b[1] === 1));
  for (const [pct, kind, clsColor, lapRel] of cars) {
    const [x, y] = at(pct);
    if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
    const r = radius[kind] ?? radius[0];
    const lapped = kind !== 1 && lapRel ? (lapRel > 0 ? "--c-lap-up" : "--c-lap-down") : "";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = kind === 1 ? colors["--c-me"] : kind === 2 ? colors["--c-muted"] : clsColor || colors["--c-radar-car"];
    ctx.fill();
    ctx.strokeStyle = colors[lapped || "--c-bg"];
    ctx.lineWidth = lapped ? 2 : kind === 1 ? 2 : 1.5;
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- data loop

let state = null;
const shown = (id) => document.body.classList.contains("edit") || !$(id).classList.contains("off");
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => { state = JSON.parse(e.data); };
  ws.onclose = () => { state = null; setTimeout(connect, 1000); };
}

function frame() {
  const online = !!(state && state.connected);
  document.body.classList.toggle("offline", !online);
  document.body.classList.toggle("qualify", !!(online && state.session?.qualify));
  document.body.classList.toggle("away", !!(online && (state.replay || state.simFocused === false)));
  // widgets can't be seen (faded out for replay / sim not focused): don't render at all
  const hidden = !document.body.classList.contains("edit") && document.body.classList.contains("away");
  if (online && !hidden) {
    // each widget isolated: one failing render must not blank the others
    for (const [render, data] of [
      [renderSession, state.session],
      [(rows) => { multiclass = !!state.session?.multiclass; renderStandings(rows); }, state.relative],
      [renderFuel, state.fuel],
      [renderIncidents, state.incidents],
      [renderPit, state.pit],
      [renderLaps, state.laps],
      [renderDelta, state.delta],
      // canvases of switched-off widgets (display: none outside edit mode) aren't drawn
      [renderRadar, shown("w-radar") && !state.session?.qualify && state.radar],
      [renderMap, shown("w-map") && state.map],
      [renderClock, true],
    ]) {
      try {
        if (data) render(data);
      } catch (err) {
        if (!frame.errored) console.error(err); // log once, not 60x/s
        frame.errored = true;
      }
    }
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- layout + edit mode

const DEFAULT_LAYOUT = {
  session: { x: 1.5, y: 3 },
  clock: { x: 10, y: 3 },
  relative: { x: 1.5, y: 21 },
  fuel: { x: 1.5, y: 50 },
  "delta-best": { x: 40, y: 3 },
  "delta-ahead": { x: 40, y: 10 },
  "delta-behind": { x: 40, y: 18 },
  "delta-closest": { x: 40, y: 26 },
  radar: { x: 44, y: 55 },
  map: { x: 78, y: 3 },
  incidents: { x: 1.5, y: 71 },
  laps: { x: 10, y: 50 },
  "incident-alert": { x: 44, y: 40 },
  pit: { x: 44, y: 33 },
};

// widgets switched off stay visible (dimmed) in edit mode, each with an on/off switch
function applyVisibility() {
  const hidden = { ...DEFAULT_HIDDEN, ...load(HIDDEN_KEY) };
  for (const el of document.querySelectorAll(".widget")) {
    const off = !!hidden[el.dataset.id];
    el.classList.toggle("off", off);
    let btn = el.querySelector(":scope > .w-toggle");
    if (!btn) {
      btn = document.createElement("button");
      btn.className = "w-toggle";
      btn.addEventListener("click", () => setWidgetHidden(el.dataset.id, !el.classList.contains("off")));
      el.appendChild(btn);
    }
    btn.textContent = off ? "off" : "on";
    btn.title = off ? "show this widget" : "hide this widget";
    const input = document.querySelector(`#widget-rows input[data-widget="${el.dataset.id}"]`);
    if (input) input.checked = !off;
  }
}

function setWidgetHidden(id, off) {
  const h = { ...DEFAULT_HIDDEN, ...load(HIDDEN_KEY) };
  h[id] = off;
  save(HIDDEN_KEY, h);
  applyVisibility();
}

// per-widget settings, saved with the position:
//   s  = size (everything inside a widget is em-based, so scaling its font scales it all)
//   bg = card background opacity %, unset -> global "bg opacity"
//   op = whole widget opacity %
function applyWidgetProps(el, p) {
  el.dataset.scale = p.s ?? 1;
  el.style.fontSize = `calc(13px * var(--ui-scale) * ${p.s ?? 1})`;
  if (p.bg != null) el.style.setProperty("--bg-opacity", `${p.bg}%`);
  else el.style.removeProperty("--bg-opacity");
  if (p.bg != null) el.dataset.bg = p.bg; // canvas widgets read it without a style recalc
  else delete el.dataset.bg;
  el.style.setProperty("--w-opacity", (p.op ?? 100) / 100);
  // widget-specific settings (radar range, map follow...) live on dataset
  for (const [key, , , , , , , only] of WIDGET_SLIDERS) {
    if (!only) continue;
    if ([].concat(only).includes(el.dataset.id) && p[key] != null) el.dataset[key] = p[key];
    else delete el.dataset[key];
  }
}

function widgetProps(el) {
  const saved = load(LAYOUT_KEY);
  return { x: 10, y: 10, ...DEFAULT_LAYOUT[el.dataset.id], ...saved[el.dataset.id] };
}

// Positions are saved in % of the screen but placed on whole device pixels: text at
// fractional positions looks smeared on 1x (non-retina) displays.
const devicePx = (v) => Math.round(v * (window.devicePixelRatio || 1)) / (window.devicePixelRatio || 1);
function placeWidget(el, xPct, yPct) {
  el.dataset.x = xPct;
  el.dataset.y = yPct;
  el.style.left = `${devicePx((xPct / 100) * innerWidth)}px`;
  el.style.top = `${devicePx((yPct / 100) * innerHeight)}px`;
}

function applyLayout() {
  for (const el of document.querySelectorAll(".widget")) {
    const p = widgetProps(el);
    placeWidget(el, p.x, p.y);
    applyWidgetProps(el, p);
  }
}
addEventListener("resize", () => {
  for (const el of document.querySelectorAll(".widget")) placeWidget(el, +el.dataset.x, +el.dataset.y);
});

function updateWidget(el, changes) {
  const layout = load(LAYOUT_KEY);
  const p = { ...widgetProps(el), x: +el.dataset.x, y: +el.dataset.y, ...changes };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  layout[el.dataset.id] = p;
  save(LAYOUT_KEY, layout);
  applyWidgetProps(el, p);
  if (el === selected) syncSelectedPanel();
}

// ---------- selected widget (edit mode)

let selected = null;
function selectWidget(el) {
  if (selected) selected.classList.remove("selected");
  selected = el;
  if (el) el.classList.add("selected");
  syncSelectedPanel();
}

const WIDGET_SLIDERS = [
  // key, label, min, max, step, fallback, unit ("x" | "%" | "m" | "s" | "check"), only for widget id(s)
  ["s", "size", 0.5, 3, 0.05, () => 1, "x"],
  ["bg", "background", 0, 100, 1, () => parseFloat(getComputedStyle(root).getPropertyValue("--bg-opacity")), "%"],
  ["op", "opacity", 10, 100, 1, () => 100, "%"],
  ["range", "view range", 5, 50, 1, () => RADAR_DEFAULT_RANGE, "m", "radar"],
  ["sa", "show ahead", 0, 20, 1, () => RADAR_SHOW_AHEAD_M, "m", "radar"],
  ["sb", "show behind", 0, 20, 1, () => RADAR_SHOW_BEHIND_M, "m", "radar"],
  ["flash", "3-wide flashing", 0, 1, 1, () => (REDUCED_MOTION ? 0 : 1), "check", "radar"],
  ["follow", "follow me", 0, 1, 1, () => 0, "check", "map"],
  ["frange", "follow range", 100, 1500, 25, () => MAP_FOLLOW_DEFAULT_M, "m", "map"],
  ["hide", "hide beyond", 1, 60, 1, () => RIVAL_HIDE_DEFAULT_S, "s", ["delta-ahead", "delta-behind", "delta-closest"]],
];
const slidersFor = (el) => WIDGET_SLIDERS.filter((x) => !x[7] || [].concat(x[7]).includes(el.dataset.id));

// edit panel: drag by its header (position saved), sections collapsed until opened;
// selecting a widget opens its settings
const PANEL_KEY = "overlay.editpanel.v1";

function placePanel(x, y) {
  const p = $("edit-panel");
  const r = p.getBoundingClientRect();
  x = Math.min(Math.max(0, x), innerWidth - Math.min(r.width, innerWidth));
  y = Math.min(Math.max(0, y), innerHeight - 40); // keep the header reachable
  // never taller than what's left below its top edge, so it scrolls instead of being cut
  Object.assign(p.style, { left: `${x}px`, top: `${y}px`, right: "auto", maxHeight: `${innerHeight - y - 16}px` });
  return { x, y };
}

function enablePanelDrag() {
  const head = document.querySelector("#edit-panel .panel-head");
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    const r = $("edit-panel").getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    head.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  head.addEventListener("pointermove", (e) => {
    if (drag) drag.pos = placePanel(e.clientX - drag.dx, e.clientY - drag.dy);
  });
  head.addEventListener("pointerup", () => {
    if (drag?.pos) save(PANEL_KEY, drag.pos);
    drag = null;
  });
}

function restorePanel() {
  const pos = load(PANEL_KEY);
  if (pos.x != null) placePanel(pos.x, pos.y);
}

function syncSelectedPanel() {
  const box = $("selected-rows");
  if (!selected) {
    $("selected-name").textContent = "click a widget";
    box.innerHTML = "";
    return;
  }
  $("selected-name").textContent = selected.dataset.id;
  $("sec-selected").open = true;
  const p = widgetProps(selected);
  if (box.dataset.for !== selected.dataset.id) {
    box.dataset.for = selected.dataset.id;
    box.innerHTML = "";
    for (const [key, label, min, max, step, , unit] of slidersFor(selected)) {
      const row = document.createElement("label");
      row.className = "row";
      const input = unit === "check"
        ? `<input type="checkbox" data-key="${key}">`
        : `<input type="range" min="${min}" max="${max}" step="${step}" data-key="${key}">`;
      row.innerHTML = `<span>${label} <span class="muted" data-out="${key}"></span></span>${input}`;
      row.querySelector("input").addEventListener("input", (e) => {
        updateWidget(selected, { [key]: unit === "check" ? (e.target.checked ? 1 : 0) : parseFloat(e.target.value) });
      });
      box.appendChild(row);
    }
    const reset = document.createElement("button");
    reset.textContent = "reset widget";
    reset.addEventListener("click", () =>
      updateWidget(selected, Object.fromEntries(slidersFor(selected).map((x) => [x[0], undefined]))));
    box.appendChild(reset);
  }
  for (const [key, , , , , fallback, unit] of slidersFor(selected)) {
    const v = p[key] ?? fallback();
    const input = box.querySelector(`input[data-key="${key}"]`);
    if (unit === "check") input.checked = !!v;
    else if (document.activeElement !== input) input.value = v;
    box.querySelector(`[data-out="${key}"]`).textContent =
      unit === "check" ? ""
      : unit === "x" ? `${Math.round(v * 100)}%`
      : unit === "m" ? `${Math.round(v)} m`
      : unit === "s" ? `${Math.round(v)} s`
      : `${Math.round(v)}%${key === "bg" && p.bg == null ? " (global)" : ""}`;
  }
}

// Figma-style snapping while dragging: the widget's left / centre / right (top / middle /
// bottom) snap to the same lines of other widgets and of the screen, with a guide line.
// Hold Ctrl to place freely.
const SNAP_PX = 6;
const SNAP_SCREEN_PX = 10; // screen centre / edges: wider range and they win over widget lines

function snapGuide(axis) {
  let g = document.getElementById(`snap-${axis}`);
  if (!g) {
    g = document.createElement("div");
    g.id = `snap-${axis}`;
    g.className = `snap-guide ${axis}`;
    document.body.appendChild(g);
  }
  return g;
}

function hideSnapGuides() {
  for (const a of ["x", "y"]) snapGuide(a).style.display = "none";
}

// best snap on one axis: [shift px, guide position, target rect] or null.
// Screen lines first (centre lines matter most), else the nearest widget line.
function snapAxis(lines, targets, screen) {
  let best = null, bestScreen = false;
  for (const [pos, rect] of targets) {
    const isScreen = rect === screen;
    if (bestScreen && !isScreen) continue;
    for (const l of lines) {
      const d = pos - l;
      if (Math.abs(d) > (isScreen ? SNAP_SCREEN_PX : SNAP_PX)) continue;
      if (!best || (isScreen && !bestScreen) || Math.abs(d) < Math.abs(best[0])) {
        best = [d, pos, rect];
        bestScreen = isScreen;
      }
    }
  }
  return best;
}

function snapDrag(el, x, y, free) {
  hideSnapGuides();
  if (free) return [x, y];
  const r = el.getBoundingClientRect();
  const w = r.width, h = r.height;
  const screen = { left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight };
  const xs = [[0, screen], [innerWidth / 2, screen], [innerWidth, screen]];
  const ys = [[0, screen], [innerHeight / 2, screen], [innerHeight, screen]];
  for (const o of document.querySelectorAll(".widget")) {
    if (o === el) continue;
    const q = o.getBoundingClientRect();
    if (!q.width || !q.height) continue; // not displayed
    xs.push([q.left, q], [q.left + q.width / 2, q], [q.right, q]);
    ys.push([q.top, q], [q.top + q.height / 2, q], [q.bottom, q]);
  }
  const sx = snapAxis([x, x + w / 2, x + w], xs, screen);
  const sy = snapAxis([y, y + h / 2, y + h], ys, screen);
  if (sx) x += sx[0];
  if (sy) y += sy[0];
  // guide spans both the dragged widget and the one it lines up with
  if (sx) {
    const g = snapGuide("x"), t = sx[2];
    const top = Math.min(y, t.top), bottom = Math.max(y + h, t.bottom);
    Object.assign(g.style, { display: "block", left: `${sx[1]}px`, top: `${top}px`, height: `${bottom - top}px` });
  }
  if (sy) {
    const g = snapGuide("y"), t = sy[2];
    const left = Math.min(x, t.left), right = Math.max(x + w, t.right);
    Object.assign(g.style, { display: "block", top: `${sy[1]}px`, left: `${left}px`, width: `${right - left}px` });
  }
  return [x, y];
}

function enableDrag() {
  let drag = null;
  document.addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("edit")) return;
    if (e.target.closest(".w-toggle")) return; // on/off switch: a click, not a drag
    const el = e.target.closest(".widget");
    if (!el) return;
    selectWidget(el);
    const rect = el.getBoundingClientRect();
    drag = { el, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    el.setPointerCapture(e.pointerId);
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const [x, y] = snapDrag(drag.el, e.clientX - drag.dx, e.clientY - drag.dy, e.ctrlKey);
    placeWidget(drag.el, (x / innerWidth) * 100, (y / innerHeight) * 100);
  });
  document.addEventListener("pointerup", () => {
    if (!drag) return;
    hideSnapGuides();
    updateWidget(drag.el, {});
    drag = null;
  });
  // edit mode: mouse wheel over a widget resizes it
  document.addEventListener("wheel", (e) => {
    if (!document.body.classList.contains("edit")) return;
    const el = e.target.closest(".widget");
    if (!el) return;
    e.preventDefault();
    selectWidget(el);
    const s = parseFloat(el.dataset.scale) || 1;
    const next = Math.min(3, Math.max(0.5, Math.round((s * (e.deltaY < 0 ? 1.05 : 1 / 1.05)) * 100) / 100));
    updateWidget(el, { s: next });
  }, { passive: false });
}

const THEME_VARS = [
  ["--c-name", "driver name"],
  ["--c-number", "car number"],
  ["--c-pos", "position"],
  ["--c-best", "best lap"],
  ["--c-best-class", "fastest lap in class"],
  ["--c-ahead", "car ahead (global)"],
  ["--c-behind", "car behind (global)"],
  ["--c-me", "me"],
  ["--c-lap-up", "car a lap up on me"],
  ["--c-lap-down", "car a lap down"],
  ["--c-good", "gain / good"],
  ["--c-bad", "loss / bad"],
  ["--c-neutral", "steady (between gain and loss)"],
  ["--c-warn", "warning"],
  ["--c-limiter", "pit limiter"],
  ["--c-fuel", "fuel"],
  ["--c-incidents", "incident alert points"],
  ["--c-clock", "clock"],
  ["--c-mode", "session mode"],
  ["--c-track", "track name"],
  ["--c-irating", "iRating (no license)"],
  ["--c-lic-r", "license R"],
  ["--c-lic-d", "license D"],
  ["--c-lic-c", "license C"],
  ["--c-lic-b", "license B"],
  ["--c-lic-a", "license A"],
  ["--c-lic-p", "license Pro"],
  ["--c-last-lap", "last lap"],
  ["--c-optimal-lap", "optimal lap"],
  ["--c-radio", "radio (talking)"],
  ["--c-tire-wet", "tire: wet"],
  ["--c-tire-soft", "tire: soft"],
  ["--c-tire-medium", "tire: medium"],
  ["--c-tire-hard", "tire: hard / dry"],
  ["--c-label", "labels"],
  ["--c-comment", "titles"],
  ["--c-fg", "text"],
  ["--c-muted", "muted"],
  ["--c-bg", "background"],
  ["--c-border", "border"],
  ["--c-radar-car", "map car"],
  ["--c-radar-danger", "radar alongside"],
];
const THEME_SLIDERS = [
  ["--bg-opacity", "bg opacity", 0, 100, 1, "%"],
  ["--ui-scale", "ui scale", 0.6, 2, 0.05, ""],
];

// THEMES / DEFAULT_THEME: frontend/themes.js (shared with the website)

// Saved colors: chosen theme + the user's changes per theme (kept when switching themes
// and back) + theme-independent sliders (bg opacity, ui scale).
const COLORS_KEY = "overlay.colors.v2";
const SLIDER_KEYS = new Set(THEME_SLIDERS.map((s) => s[0]));
function colorState() {
  const s = load(COLORS_KEY);
  if (s.theme) return { overrides: {}, shared: {}, ...s };
  // first run after the update: old single color set = my changes to Dark+
  const old = load(THEME_KEY), state = { theme: DEFAULT_THEME, overrides: {}, shared: {} };
  for (const [k, v] of Object.entries(old)) {
    if (SLIDER_KEYS.has(k)) state.shared[k] = v;
    else (state.overrides[DEFAULT_THEME] ??= {})[k] = v;
  }
  save(COLORS_KEY, state);
  return state;
}

// one-click palettes for every good/bad + ahead/behind color; individual pickers still override
const PALETTES = {
  "red / green": null, // the selected theme's own red / green
  // Okabe-Ito: safe for protanopia / deuteranopia (red-green)
  "blue / orange": {
    "--c-good": "#56b4e9", "--c-bad": "#e69f00",
    "--c-ahead": "#e69f00", "--c-behind": "#56b4e9", "--c-radar-danger": "#d55e00",
    "--c-lap-up": "#e69f00", "--c-lap-down": "#56b4e9",
  },
  // safe for tritanopia (blue-yellow)
  "magenta / teal": {
    "--c-good": "#4ec9b0", "--c-bad": "#e0559a",
    "--c-ahead": "#e0559a", "--c-behind": "#4ec9b0", "--c-radar-danger": "#e0559a",
    "--c-lap-up": "#e0559a", "--c-lap-down": "#4ec9b0",
  },
};

function buildPaletteButtons() {
  const box = $("palette-buttons");
  box.innerHTML = "";
  for (const [name, vars] of Object.entries(PALETTES)) {
    const b = document.createElement("button");
    b.textContent = name;
    b.addEventListener("click", () => {
      const s = colorState();
      const keys = Object.keys(vars || PALETTES["blue / orange"]);
      if (vars) for (const k of keys) (s.overrides[s.theme] ??= {})[k] = vars[k];
      else for (const k of keys) delete s.overrides[s.theme]?.[k];
      save(COLORS_KEY, s);
      applyTheme();
      buildEditPanel();
    });
    box.appendChild(b);
  }
}

function applyTheme() {
  const s = colorState();
  for (const [k] of [...THEME_VARS, ...THEME_SLIDERS]) root.style.removeProperty(k);
  const vars = { ...(THEMES[s.theme] || THEMES[DEFAULT_THEME]), ...s.overrides[s.theme], ...s.shared };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  refreshColors();
}

function setThemeVar(k, v) {
  root.style.setProperty(k, v);
  if (selected) syncSelectedPanel();
  const s = colorState();
  if (SLIDER_KEYS.has(k)) s.shared[k] = v;
  else (s.overrides[s.theme] ??= {})[k] = v;
  save(COLORS_KEY, s);
  refreshColors();
  syncThemeSelect();
}

function setThemeName(name) {
  const s = colorState();
  s.theme = name;
  save(COLORS_KEY, s);
  applyTheme();
  buildEditPanel();
}

// "*" marks themes the user has changed
function syncThemeSelect() {
  const sel = $("theme-select"), s = colorState();
  const opts = Object.keys(THEMES).map((n) => [n, n + (Object.keys(s.overrides[n] || {}).length ? " *" : "")]);
  if (sel.options.length !== opts.length) {
    sel.innerHTML = "";
    for (const [n] of opts) sel.add(new Option(n, n));
  }
  opts.forEach(([, label], i) => { if (sel.options[i].text !== label) sel.options[i].text = label; });
  sel.value = THEMES[s.theme] ? s.theme : DEFAULT_THEME;
}
$("theme-select").addEventListener("change", (e) => setThemeName(e.target.value));

function buildEditPanel() {
  const wrows = $("widget-rows");
  wrows.innerHTML = "";
  const hidden = { ...DEFAULT_HIDDEN, ...load(HIDDEN_KEY) };
  for (const el of document.querySelectorAll(".widget")) {
    const id = el.dataset.id;
    const row = document.createElement("label");
    row.className = "row";
    row.innerHTML = `<span>${id}</span><input type="checkbox" data-widget="${id}">`;
    const input = row.querySelector("input");
    input.checked = !hidden[id];
    input.addEventListener("change", () => setWidgetHidden(id, !input.checked));
    wrows.appendChild(row);
  }

  syncThemeSelect();
  const rows = $("theme-rows");
  const cs = getComputedStyle(root);
  rows.innerHTML = "";
  for (const [k, label] of THEME_VARS) {
    const row = document.createElement("label");
    row.className = "row";
    row.innerHTML = `<span>${label}</span><input type="color">`;
    const input = row.querySelector("input");
    input.value = cs.getPropertyValue(k).trim();
    input.addEventListener("input", () => setThemeVar(k, input.value));
    rows.appendChild(row);
  }
  for (const [k, label, min, max, step, unit] of THEME_SLIDERS) {
    const row = document.createElement("label");
    row.className = "row";
    row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}">`;
    const input = row.querySelector("input");
    input.value = parseFloat(cs.getPropertyValue(k));
    input.addEventListener("input", () => setThemeVar(k, input.value + unit));
    rows.appendChild(row);
  }
}

function themeCss() {
  const cs = getComputedStyle(root);
  const vars = [...THEME_SLIDERS.map((s) => s[0]), ...THEME_VARS.map((v) => v[0])];
  return ":root {\n" + vars.map((k) => `  ${k}: ${cs.getPropertyValue(k).trim()};`).join("\n") + "\n}\n";
}

function setEditMode(on) {
  document.body.classList.toggle("edit", on);
  if (on) { buildEditPanel(); syncSelectedPanel(); restorePanel(); }
  else selectWidget(null);
}

$("btn-copy").addEventListener("click", async () => {
  const css = themeCss();
  console.log(css);
  try { await navigator.clipboard.writeText(css); $("btn-copy").textContent = "copied ✓"; }
  catch { $("btn-copy").textContent = "see console"; }
  setTimeout(() => ($("btn-copy").textContent = "copy css"), 1500);
});
// back to the selected theme's own colors (sliders and other themes' changes stay)
$("btn-reset-theme").addEventListener("click", () => {
  const s = colorState();
  delete s.overrides[s.theme];
  save(COLORS_KEY, s);
  applyTheme();
  buildEditPanel();
});
$("btn-reset-layout").addEventListener("click", () => { save(LAYOUT_KEY, {}); applyLayout(); });
// overlay window: the Electron shell owns click-through, so leaving edit mode goes through it
$("btn-done").addEventListener("click", () =>
  window.hudsplayShell ? window.hudsplayShell.setEditMode(false) : setEditMode(false));
$("btn-exit").addEventListener("click", () => window.hudsplayShell?.quit());
// banner close button: the overlay is click-through (mouse moves still forwarded), so take
// clicks only while the pointer is over it. Decided per real move: switching click-through
// fires a synthetic mouseleave, so enter/leave events would flicker.
let overClose = false;
document.addEventListener("mousemove", (e) => {
  const over = !!e.target.closest?.("#status-close");
  if (over !== overClose) { overClose = over; window.hudsplayShell?.setClickable(over); }
});
$("status-close").addEventListener("click", () => window.hudsplayShell?.quit());

// browser preview: press "e" to toggle edit mode. Electron: Ctrl+Shift+O (see electron/main.js)
document.addEventListener("keydown", (e) => {
  if (e.key === "e" && !e.target.closest("input")) setEditMode(!document.body.classList.contains("edit"));
});
window.hudsplay = { setEditMode };

buildDeltaWidgets();
applyVisibility();
applyLayout();
applyTheme();
buildPaletteButtons();
enableDrag();
enablePanelDrag();
connect();
requestAnimationFrame(frame);
document.fonts?.ready.then(refreshColors);
