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

function setText(el, text, cls) {
  if (el.textContent !== text) el.textContent = text;
  if (cls !== undefined && el.dataset.cls !== cls) {
    if (el.dataset.cls) el.classList.remove(...el.dataset.cls.split(" "));
    if (cls) el.classList.add(...cls.split(" "));
    el.dataset.cls = cls;
  }
}

// Delta bar. Sign picks the color: negative = good (green, grows left),
// positive = bad (red, grows right). Intensity shows direction: bright while
// |delta| is growing, faded while it's shrinking back toward zero.
const BAR_RATE_FULL = { best: 0.15, rival: 0.08 }; // s/s of |delta| change for full intensity
const BAR_MIN_ALPHA = 0.25;

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
      const raw = (mag - Math.abs(this.prev.v)) / dt;
      this.rate += (raw - this.rate) * (1 - Math.exp(-dt / 0.35)); // ~0.35 s smoothing
    }
    if (this.prev == null || v !== this.prev.v) { this.prev = { v }; this.t = now; }
    const k = Math.max(-1, Math.min(1, this.rate / this.rateFull));
    const alpha = BAR_MIN_ALPHA + (1 - BAR_MIN_ALPHA) * (k + 1) / 2;
    const w = Math.min(mag / this.range, 1) * 50;
    fill.style.width = `${w}%`;
    fill.style.left = v < 0 ? `${50 - w}%` : "50%";
    fill.style.opacity = alpha.toFixed(2);
    fill.className = "fill " + (v < 0 ? "good" : "bad");
  }
}

// ---------------------------------------------------------------- widgets

function setHtml(el, html) {
  if (el.innerHTML !== html) el.innerHTML = html;
}

const POS_FULL_PLACES = 5; // places gained/lost for full color

function renderSession(s) {
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

function renderFuel(f) {
  setText($("f-level"), f.level == null ? "–" : `${f.level.toFixed(1)} L`);
  const fill = $("f-fill"), mark = $("f-mark");
  if (f.level != null && f.capacity) {
    fill.style.width = `${Math.min(f.level / f.capacity, 1) * 100}%`;
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
    '<span class="pos"></span><span class="num"></span><img class="flag" alt="">' +
    `<span class="name"></span>${RADIO_ICON}<span class="tag"></span><span class="best"></span><span class="gap"></span>`;
  const [pos, num, flag, name, radio, tag, best, gap] = row.children;
  return { row, pos, num, flag, name, radio, tag, best, gap };
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

function renderStandings(rows) {
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
    setText(el.tag, lapTag || (multiclass ? r.cls : ""), lapTag ? (r.lapRel > 0 ? "lap-up" : "lap-down") : multiclass ? "cls" : "");
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
const CLOSE_GAP_S = 0.5; // below this gap the cars are together: no catch estimate
const GAIN_FULL_S_PER_LAP = 0.3; // gain/loss rate for full / minimum intensity
const HOLD_S_PER_LAP = 0.02; // gap change below this per lap reads as "holding"
const STATUS_HOLD_MS = 1500; // new status must be stable this long before it shows
const STATUS_NUM_MS = 1000; // lap count refresh interval

function renderRival(w, r, arrow) {
  const ahead = arrow === UP;
  if (!r) {
    setText(w.v, "–", ""); setText(w.titleEl, `// ${arrow}`); setText(w.catchEl, "", "");
    w.v.style.color = "";
    w.fill.style.width = "0";
    return;
  }
  // car ahead "+", car behind "-". Hue is always the global ahead/behind color;
  // gaining vs losing only changes saturation: full color when gaining, washed out
  // toward the light text gray when losing
  const sign = ahead ? "+" : "-";
  const gain = r.closing == null ? 0 : (ahead ? r.closing : -r.closing) / GAIN_FULL_S_PER_LAP;
  const k = (Math.max(-1, Math.min(1, gain)) + 1) / 2; // 0 = losing fast, 1 = gaining fast
  setText(w.v, r.laps ? `${sign}${r.laps}L` : `${sign}${r.gap.toFixed(2)}`, "");
  const base = ahead ? "var(--c-ahead)" : "var(--c-behind)";
  const tint = `color-mix(in srgb, ${base} ${Math.round(10 + 90 * k)}%, var(--c-fg))`;
  w.v.style.color = tint;
  setText(w.titleEl, `// ${arrow} #${r.num} ${r.name}`);

  // proximity: the closer the car, the fuller the bar
  const prox = r.laps ? 0 : Math.max(0, 1 - r.gap / PROX_RANGE_S);
  w.fill.style.left = "0";
  w.fill.style.width = `${prox * 100}%`;
  w.fill.style.opacity = "1";
  w.fill.style.background = tint;
  w.fill.className = "fill prox";

  // status line, debounced: a new status must hold STATUS_HOLD_MS before it shows,
  // the lap count refreshes at most every STATUS_NUM_MS
  let kind = "", laps = null;
  if (!r.laps && r.gap < CLOSE_GAP_S) {
    kind = "close"; // already together: a catch estimate means nothing here
  } else if (r.catchLaps != null && r.catchLaps < 1) {
    kind = "soon";
  } else if (r.catchLaps != null) {
    kind = "catch";
    laps = r.catchLaps < 10 ? Math.round(r.catchLaps * 2) / 2 : Math.round(r.catchLaps);
  } else if (r.closing != null && !r.laps) {
    kind = Math.abs(r.closing) < HOLD_S_PER_LAP ? "hold" : "away";
  }
  const now = performance.now();
  const st = (w.status ??= { car: null, kind: "", laps: null, pending: null, since: 0, numAt: 0 });
  if (st.car !== r.num) {
    Object.assign(st, { car: r.num, kind, laps, pending: null, numAt: now });
  } else if (kind !== st.kind) {
    if (st.pending !== kind) { st.pending = kind; st.since = now; }
    if (now - st.since >= STATUS_HOLD_MS) Object.assign(st, { kind, laps, pending: null, numAt: now });
  } else {
    st.pending = null;
    if (kind === "catch" && now - st.numAt >= STATUS_NUM_MS) { st.laps = laps; st.numAt = now; }
  }
  const n = st.laps == null ? "" : st.laps < 10 ? st.laps.toFixed(1) : String(st.laps);
  const text = {
    catch: ahead ? `catching in ${n} laps` : `catches you in ${n} laps`,
    close: ahead ? "in range" : "on your tail",
    soon: ahead ? "catching this lap" : "catches you this lap",
    hold: "holding",
    away: ahead ? "pulling away" : "dropping back",
  }[st.kind] || "";
  setText(w.catchEl, text, st.kind === "catch" && r.catchAfterFlag ? "after-flag" : "");
}

function renderDelta(d) {
  for (const w of DELTA_WIDGETS) {
    if (w.kind === "best") {
      if (d.ref) setText(w.el.querySelector(".title"), `// Δ ${d.ref}`);
      setText(w.v, d.best == null ? "–" : fmtSigned(d.best), d.best == null ? "" : d.best < 0 ? "good" : "bad");
      w.bar.set(d.best);
    } else if (w.kind === "ahead") {
      renderRival(w, d.ahead, UP);
    } else if (w.kind === "behind") {
      renderRival(w, d.behind, DOWN);
    } else {
      // closest by time gap; a car laps away never wins over one on the same lap
      const key = (r) => (r ? (r.laps ? 1e6 : 0) + r.gap : Infinity);
      const ahead = key(d.ahead) <= key(d.behind);
      const r = ahead ? d.ahead : d.behind;
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
  for (const k of ["--c-bg", "--c-border", "--c-me", "--c-muted", "--c-radar-car", "--c-radar-danger", "--c-fg", "--c-good", "--c-bad", "--c-ahead", "--c-behind"]) {
    colors[k] = cs.getPropertyValue(k).trim();
  }
  colors.opacity = pct(cs.getPropertyValue("--bg-opacity"), 0.8);
}

const RADAR_DEFAULT_RANGE = 20; // metres
const RADAR_DIM = 0.55; // opacity of in-line (not alongside) cars

function renderRadar(r) {
  const canvas = $("radar");
  const dpr = window.devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (canvas.width !== Math.round(size * dpr)) {
    canvas.width = canvas.height = Math.round(size * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const c = size / 2;
  const rad = c - 2;
  // per-widget view range (edit mode -> select radar); radar hides when no car is inside it
  const w = $("w-radar");
  const range = parseFloat(w.dataset.range) || RADAR_DEFAULT_RANGE;
  const ppm = rad / range; // pixels per metre
  const sideAlert = { left: "L", left2: "L", right: "R", right2: "R", both: "LR" }[r.spotter] || "";
  const visibleCars = r.cars.filter((x) => Math.abs(x.d) <= range);

  w.classList.toggle("idle", !sideAlert && visibleCars.length === 0);

  // disc
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, rad, 0, Math.PI * 2);
  ctx.globalAlpha = pct(getComputedStyle($("w-radar")).getPropertyValue("--bg-opacity"), colors.opacity);
  ctx.fillStyle = colors["--c-bg"];
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colors["--c-border"];
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();

  // three (or more) wide: glow flashes rapidly (~6 Hz)
  const threeWide = r.spotter === "both" || r.spotter === "left2" || r.spotter === "right2";
  const flash = threeWide ? (Math.floor(performance.now() / 85) % 2 ? 1 : 0.15) : 1;

  // side warning glow (ACC style): solid at the edge, fading toward the centre
  for (const side of sideAlert) {
    const x0 = side === "L" ? c - rad : c + rad;
    const g = ctx.createLinearGradient(x0, 0, c, 0);
    g.addColorStop(0, colors["--c-radar-danger"]);
    g.addColorStop(0.35, colors["--c-radar-danger"] + "b0");
    g.addColorStop(1, colors["--c-radar-danger"] + "00");
    ctx.globalAlpha = 0.9 * flash;
    ctx.fillStyle = g;
    ctx.fillRect(side === "L" ? c - rad : c, c - rad, rad, rad * 2);
    ctx.globalAlpha = 1;
    // bright rim on the occupied half
    ctx.beginPath();
    const a0 = side === "L" ? Math.PI * 0.5 : -Math.PI * 0.5;
    ctx.arc(c, c, rad - 2, a0, a0 + Math.PI);
    ctx.strokeStyle = colors["--c-radar-danger"];
    ctx.lineWidth = 4;
    ctx.globalAlpha = flash;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // range rings every 5 m
  ctx.strokeStyle = colors["--c-border"];
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

  for (const car of visibleCars) {
    // alongside = danger; in line: global ahead/behind color, dimmed
    const inLine = car.side === "C";
    const col = !inLine ? colors["--c-radar-danger"] : car.d > 0 ? colors["--c-ahead"] : colors["--c-behind"];
    ctx.globalAlpha = inLine ? RADAR_DIM : 1;
    drawCar(c + LANE[car.side] * rad, c - car.d * ppm, col);
    ctx.globalAlpha = 1;
  }
  drawCar(c, c, null, colors["--c-me"]);

  // nearest ahead / behind distance
  ctx.font = `${Math.round(size * 0.065)}px ${getComputedStyle(document.body).fontFamily}`;
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

// |delta| change per metre for full paint intensity (bar: 0.15 s/s at ~50 m/s)
const PAINT_FULL_S_PER_M = 0.003;
const mapCache = { version: -1, points: null };
const mapView = { heading: null };
const MAP_ROAD_W = 11; // px, base track
const MAP_PAINT_W = 7; // px, delta paint on top of the road
const MAP_FOLLOW_DEFAULT_M = 400; // follow mode: metres of track from me to the top edge
const MAP_FOLLOW_Y = 0.72; // follow mode: my car sits this far down the widget
const MAP_HEADING_LOOK = 0.004; // lap % either side used to measure my heading
const MAP_ROTATE_EASE = 0.2; // per-frame easing of the follow rotation

// ---------- map paint: smooth gradient
// Each ~10 m piece gets a signed strength (sign of delta = green/red side, delta-bar
// intensity rule for strength), then it's blurred along the track so colors flow
// into each other. Rendered to an offscreen canvas only when the paint changes.
const PAINT_BLUR_M = 60; // gaussian sigma along the track
const paintCache = { key: "", canvas: null };

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
    if (!p || p[0] === 0) continue;
    const kk = Math.max(-1, Math.min(1, p[1] / fullStep));
    const strength = BAR_MIN_ALPHA + (1 - BAR_MIN_ALPHA) * (kk + 1) / 2;
    // pieces not driven yet this lap keep last lap's color at full strength
    raw[k] = { v: (p[0] < 0 ? -1 : 1) * strength, w: 1 };
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

function drawPaint(ctx, m, at, W, H, follow) {
  const paint = m.paint || [];
  const S = paint.length;
  if (!S) return;
  if (follow) {
    // view rotates every frame: no cache, draw only pieces on screen
    if (paintCache.followKey !== `${m.version}|${m.paintNow}|${S}`) {
      paintCache.followKey = `${m.version}|${m.paintNow}|${S}`;
      paintCache.sm = smoothPaint(paint, m.segLen, m.paintNow);
    }
    strokePaint(ctx, paintCache.sm, S, at, (x, y) => x > -20 && y > -20 && x < W + 20 && y < H + 20);
    return;
  }
  const dpr = window.devicePixelRatio || 1;
  const key = [m.version, m.paintNow, S, W, H, dpr, m.mirror, colors["--c-good"], colors["--c-bad"], colors["--c-muted"]].join("|");
  if (paintCache.key !== key) {
    paintCache.key = key;
    const off = paintCache.canvas || (paintCache.canvas = document.createElement("canvas"));
    off.width = Math.round(W * dpr);
    off.height = Math.round(H * dpr);
    const o = off.getContext("2d");
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.clearRect(0, 0, W, H);
    strokePaint(o, smoothPaint(paint, m.segLen, m.paintNow), S, at, () => true);
  }
  ctx.drawImage(paintCache.canvas, 0, 0, W, H);
}

function strokePaint(o, sm, S, at, visible) {
    o.lineWidth = MAP_PAINT_W;
    o.lineCap = "butt"; // round caps would stack alpha at every joint
    const good = hexRgb(colors["--c-good"]), bad = hexRgb(colors["--c-bad"]), mid = hexRgb(colors["--c-muted"]);
    const colorAt = (k) => {
      const p = sm[k % S];
      if (!p) return null;
      const t = Math.min(1, Math.abs(p.v));
      const [r, g, b] = mixRgb(mid, p.v < 0 ? good : bad, Math.min(1, t * 1.4));
      return `rgba(${r},${g},${b},${((0.25 + 0.75 * t) * p.dim * p.cover).toFixed(3)})`;
    };
    for (let k = 0; k < S; k++) {
      const c0 = colorAt(k), c1 = colorAt(k + 1);
      if (!c0 || !c1) continue;
      // gradient from this piece's centre to the next one's: no visible steps
      const [x0, y0] = at((k + 0.5) / S), [x1, y1] = at((k + 1.5) / S);
      if (!visible(x0, y0) && !visible(x1, y1)) continue;
      const grad = o.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, c0);
      grad.addColorStop(1, c1);
      o.strokeStyle = grad;
      o.beginPath();
      o.moveTo(x0, y0);
      o.lineTo(...at((k + 1) / S));
      o.lineTo(x1, y1);
      o.stroke();
    }
}

function renderMap(m) {
  if (m.points !== undefined && (m.version !== mapCache.version || !mapCache.points)) {
    mapCache.version = m.version;
    mapCache.points = m.points;
  }
  const pts = mapCache.points;
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

  const title = $("map-title");
  if (!pts) {
    setText(title, m.recording != null
      ? `// map · recording ${Math.round(m.recording * 100)}%`
      : "// map · drive 1 clean lap to record");
    return;
  }
  setText(title, "// map");

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
  const follow = w.dataset.follow === "1" && !!me;
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
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x0, y] of pts) {
      const x = mir * x0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    const pad = 10;
    const sc = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
    const ox = (W - (maxX - minX) * sc) / 2, oy = (H - (maxY - minY) * sc) / 2;
    toS = (x, y) => [(x - minX) * sc + ox, H - ((y - minY) * sc + oy)];
  }
  const at = (pct) => toS(...world(pct));

  // base track
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

  drawPaint(ctx, m, at, W, H, follow);

  // start/finish
  const [sx, sy] = at(0);
  const [tx, ty] = at(0.003);
  const nx = -(ty - sy), ny = tx - sx, nl = Math.hypot(nx, ny) || 1;
  ctx.beginPath();
  ctx.moveTo(sx - (nx / nl) * 9, sy - (ny / nl) * 9);
  ctx.lineTo(sx + (nx / nl) * 9, sy + (ny / nl) * 9);
  ctx.strokeStyle = colors["--c-fg"];
  ctx.lineWidth = 2;
  ctx.stroke();

  // cars: others first, me on top
  // [color, radius px]; every dot gets a dark border so it stands out on the paint
  const style = { 0: ["--c-radar-car", 4.5], 2: ["--c-muted", 3.5], 3: ["--c-ahead", 5.5], 4: ["--c-behind", 5.5], 1: ["--c-me", 6.5] };
  const cars = [...(m.cars || [])].sort((a, b) => (a[1] === 1) - (b[1] === 1));
  for (const [pct, kind] of cars) {
    const [x, y] = at(pct);
    if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
    const [col, r] = style[kind] || style[0];
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = colors[col];
    ctx.fill();
    ctx.strokeStyle = colors["--c-bg"];
    ctx.lineWidth = kind === 1 ? 2 : 1.5;
    ctx.stroke();
  }
}

// ---------------------------------------------------------------- data loop

let state = null;
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => { state = JSON.parse(e.data); };
  ws.onclose = () => { state = null; setTimeout(connect, 1000); };
}

function frame() {
  const online = !!(state && state.connected);
  document.body.classList.toggle("offline", !online);
  if (online) {
    // each widget isolated: one failing render must not blank the others
    for (const [render, data] of [
      [renderSession, state.session],
      [(rows) => { multiclass = !!state.session?.multiclass; renderStandings(rows); }, state.relative],
      [renderFuel, state.fuel],
      [renderDelta, state.delta],
      [renderRadar, state.radar],
      [renderMap, state.map],
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
  relative: { x: 1.5, y: 15 },
  fuel: { x: 1.5, y: 35 },
  "delta-best": { x: 40, y: 3 },
  "delta-ahead": { x: 40, y: 10 },
  "delta-behind": { x: 40, y: 18 },
  "delta-closest": { x: 40, y: 26 },
  radar: { x: 44, y: 55 },
  map: { x: 78, y: 3 },
};

function applyVisibility() {
  const hidden = { ...DEFAULT_HIDDEN, ...load(HIDDEN_KEY) };
  for (const el of document.querySelectorAll(".widget")) {
    el.classList.toggle("off", !!hidden[el.dataset.id]);
  }
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
  el.style.setProperty("--w-opacity", (p.op ?? 100) / 100);
  // widget-specific settings (radar range, map follow...) live on dataset
  for (const [key, , , , , , , only] of WIDGET_SLIDERS) {
    if (!only) continue;
    if (only === el.dataset.id && p[key] != null) el.dataset[key] = p[key];
    else delete el.dataset[key];
  }
}

function widgetProps(el) {
  const saved = load(LAYOUT_KEY);
  return { x: 10, y: 10, ...DEFAULT_LAYOUT[el.dataset.id], ...saved[el.dataset.id] };
}

function applyLayout() {
  for (const el of document.querySelectorAll(".widget")) {
    const p = widgetProps(el);
    el.style.left = `${p.x}%`;
    el.style.top = `${p.y}%`;
    applyWidgetProps(el, p);
  }
}

function updateWidget(el, changes) {
  const layout = load(LAYOUT_KEY);
  const p = { ...widgetProps(el), x: parseFloat(el.style.left), y: parseFloat(el.style.top), ...changes };
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
  // key, label, min, max, step, fallback, unit ("x" | "%" | "m" | "check"), only for widget id
  ["s", "size", 0.5, 3, 0.05, () => 1, "x"],
  ["bg", "background", 0, 100, 1, () => parseFloat(getComputedStyle(root).getPropertyValue("--bg-opacity")), "%"],
  ["op", "opacity", 10, 100, 1, () => 100, "%"],
  ["range", "view range", 5, 50, 1, () => RADAR_DEFAULT_RANGE, "m", "radar"],
  ["follow", "follow me", 0, 1, 1, () => 0, "check", "map"],
  ["frange", "follow range", 100, 1500, 25, () => MAP_FOLLOW_DEFAULT_M, "m", "map"],
];
const slidersFor = (el) => WIDGET_SLIDERS.filter((x) => !x[7] || x[7] === el.dataset.id);

function syncSelectedPanel() {
  const box = $("selected-rows");
  if (!selected) {
    $("selected-name").textContent = "click a widget";
    box.innerHTML = "";
    return;
  }
  $("selected-name").textContent = selected.dataset.id;
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
      : `${Math.round(v)}%${key === "bg" && p.bg == null ? " (global)" : ""}`;
  }
}

function enableDrag() {
  let drag = null;
  document.addEventListener("pointerdown", (e) => {
    if (!document.body.classList.contains("edit")) return;
    const el = e.target.closest(".widget");
    if (!el) return;
    selectWidget(el);
    const rect = el.getBoundingClientRect();
    drag = { el, dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    el.setPointerCapture(e.pointerId);
  });
  document.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.el.style.left = `${((e.clientX - drag.dx) / innerWidth) * 100}%`;
    drag.el.style.top = `${((e.clientY - drag.dy) / innerHeight) * 100}%`;
  });
  document.addEventListener("pointerup", () => {
    if (!drag) return;
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
  ["--c-warn", "warning"],
  ["--c-fuel", "fuel"],
  ["--c-clock", "clock"],
  ["--c-radio", "radio (talking)"],
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

// one-click palettes for every good/bad + ahead/behind color; individual pickers still override
const PALETTES = {
  "red / green": {
    "--c-good": "#89d185", "--c-bad": "#f48771",
    "--c-ahead": "#f48771", "--c-behind": "#89d185", "--c-radar-danger": "#f14c4c",
    "--c-lap-up": "#f48771", "--c-lap-down": "#3794ff",
  },
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
      for (const [k, v] of Object.entries(vars)) setThemeVar(k, v);
      buildEditPanel();
    });
    box.appendChild(b);
  }
}

function applyTheme() {
  for (const [k, v] of Object.entries(load(THEME_KEY))) root.style.setProperty(k, v);
  refreshColors();
}

function setThemeVar(k, v) {
  root.style.setProperty(k, v);
  if (selected) syncSelectedPanel();
  const theme = load(THEME_KEY);
  theme[k] = v;
  save(THEME_KEY, theme);
  refreshColors();
}

function buildEditPanel() {
  const wrows = $("widget-rows");
  wrows.innerHTML = "";
  const hidden = { ...DEFAULT_HIDDEN, ...load(HIDDEN_KEY) };
  for (const el of document.querySelectorAll(".widget")) {
    const id = el.dataset.id;
    const row = document.createElement("label");
    row.className = "row";
    row.innerHTML = `<span>${id}</span><input type="checkbox">`;
    const input = row.querySelector("input");
    input.checked = !hidden[id];
    input.addEventListener("change", () => {
      const h = { ...DEFAULT_HIDDEN, ...load(HIDDEN_KEY) };
      h[id] = !input.checked;
      save(HIDDEN_KEY, h);
      applyVisibility();
    });
    wrows.appendChild(row);
  }

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
  if (on) { buildEditPanel(); syncSelectedPanel(); }
  else selectWidget(null);
}

$("btn-copy").addEventListener("click", async () => {
  const css = themeCss();
  console.log(css);
  try { await navigator.clipboard.writeText(css); $("btn-copy").textContent = "copied ✓"; }
  catch { $("btn-copy").textContent = "see console"; }
  setTimeout(() => ($("btn-copy").textContent = "copy css"), 1500);
});
$("btn-reset-theme").addEventListener("click", () => {
  for (const k of Object.keys(load(THEME_KEY))) root.style.removeProperty(k);
  save(THEME_KEY, {});
  refreshColors();
  buildEditPanel();
});
$("btn-reset-layout").addEventListener("click", () => { save(LAYOUT_KEY, {}); applyLayout(); });

// browser preview: press "e" to toggle edit mode. Electron: Ctrl+Shift+O (see electron/main.js)
document.addEventListener("keydown", (e) => {
  if (e.key === "e" && !e.target.closest("input")) setEditMode(!document.body.classList.contains("edit"));
});
window.racehud = { setEditMode };

buildDeltaWidgets();
applyVisibility();
applyLayout();
applyTheme();
buildPaletteButtons();
enableDrag();
connect();
requestAnimationFrame(frame);
document.fonts?.ready.then(refreshColors);
