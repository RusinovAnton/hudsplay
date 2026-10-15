// Live widgets for the website: the overlay's own markup and CSS (docs/hud/, copied by
// packaging/build_site.py), driven by a small fake race instead of iRacing telemetry.
// Placeholders: <div class="live" data-w="relative"></div>. Plus the site theme picker.
"use strict";

// ---------------------------------------------------------------- theme picker

const THEME_STORE = "hudsplay.site.theme";
const themeVars = () => Object.keys(THEMES[DEFAULT_THEME]);

function applySiteTheme(name) {
  const vars = THEMES[name] || THEMES[DEFAULT_THEME];
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", vars["--c-bg"]);
  for (const sel of document.querySelectorAll(".theme-select")) sel.value = name;
  try { localStorage.setItem(THEME_STORE, name); } catch (_) {}
  readColors();
  for (const input of document.querySelectorAll("[data-var]")) input.value = colors[input.dataset.var] || "#000000";
}

function initThemePicker() {
  let saved = DEFAULT_THEME;
  try { saved = localStorage.getItem(THEME_STORE) || DEFAULT_THEME; } catch (_) {}
  if (!THEMES[saved]) saved = DEFAULT_THEME;
  for (const sel of document.querySelectorAll(".theme-select")) {
    for (const n of Object.keys(THEMES)) sel.add(new Option(n, n));
    sel.addEventListener("change", () => applySiteTheme(sel.value));
  }
  // edit panel demo: color pickers recolor the page live (not saved)
  for (const input of document.querySelectorAll("[data-var]")) {
    input.addEventListener("input", () => {
      document.documentElement.style.setProperty(input.dataset.var, input.value);
      readColors();
    });
  }
  document.querySelector(".btn-reset-colors")?.addEventListener("click", () =>
    applySiteTheme(document.querySelector(".theme-select")?.value || DEFAULT_THEME));
  applySiteTheme(saved);
}

// canvas colors, read once per theme change (never per frame)
const colors = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const k of themeVars()) colors[k] = cs.getPropertyValue(k).trim();
  colors.font = cs.getPropertyValue("--font").trim() || "monospace";
  colors.opacity = parseFloat(cs.getPropertyValue("--bg-opacity")) / 100 || 0.82;
  mapLayer.gen++; // any color change redraws the map layers
}

// ---------------------------------------------------------------- helpers

const step = (v, q) => Math.round(v / q) * q;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmtSigned = (v, d = 2) => (v > 0 ? "+" : v < 0 ? "-" : " ") + Math.abs(v).toFixed(d);
function fmtLap(s) {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
}
function setText(el, text) { if (el && el.textContent !== text) el.textContent = text; }
function setHtml(el, html) { if (el && el.innerHTML !== html) el.innerHTML = html; }
function hexRgb(hex) {
  const h = (hex || "#888888").replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
// -1 gaining fast .. 0 steady (bone white) .. 1 losing fast, like the overlay's delta bar
function gainLossColor(k) {
  return `color-mix(in srgb, var(${k < 0 ? "--c-good" : "--c-bad"}) ${step(Math.min(1, Math.abs(k)) * 100, 5)}%, var(--c-neutral))`;
}

// ---------------------------------------------------------------- the fake race

const DRIVERS = [
  // pos, number, name, country, iRating, license, SR, class (GT3 / GT4), best lap
  [1, 12, "L. Hartmann", "de", 4120, "A", 3.6, "GT3", 106.412],
  [5, 88, "S. Marchetti", "it", 2870, "B", 2.4, "GT3", 106.902],
  [6, 21, "J. O'Neill", "ie", 1980, "C", 3.1, "GT3", 107.344],
  [2, 41, "R. Costa", "br", 2240, "B", 1.7, "GT4", 112.758],
  [7, 42, "Y. Driver", "ua", 2410, "A", 2.9, "GT3", 106.519],
  [8, 55, "M. Ruiz", "es", 1730, "D", 1.2, "GT3", 107.272],
  [9, 19, "L. Nowak", "pl", 3910, "A", 3.8, "GT3", 106.436],
  [10, 3, "E. Laurent", "fr", 1310, "R", 0.6, "GT3", 107.805],
];
const ME = 42;
const CLASS_COLORS = { GT3: "#ffda59", GT4: "#53ff77" };
// relative gap base (iRacing convention: ahead "-") and lap offset per car
const REL = { 12: [-41.2, 0], 88: [-4.7, 0], 21: [-2.3, 0], 41: [-1.05, -1], 42: [0, 0], 55: [0.42, 0], 19: [1.9, 0], 3: [3.4, 0] };
const RADIO_ICON =
  '<svg class="radio" viewBox="0 0 16 16" aria-hidden="true">' +
  '<rect x="6" y="2" width="4" height="7" rx="2" fill="currentColor"/>' +
  '<path d="M4 7.5a4 4 0 0 0 8 0M8 11.5V14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>' +
  '<path class="wave" d="M1.8 5.5a6.5 6.5 0 0 0 0 4M14.2 5.5a6.5 6.5 0 0 1 0 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
  "</svg>";

// smooth pseudo-random wobble: a few sines
const wobble = (t, seed) => Math.sin(t * 0.37 + seed) * 0.6 + Math.sin(t * 0.91 + seed * 2.3) * 0.3 + Math.sin(t * 2.1 + seed * 0.7) * 0.1;

const LAP_S = 107;
function race(t) {
  // delta to session best: drifts between gaining and losing, corner by corner
  const delta = 0.18 * Math.sin(t / 7) + 0.07 * Math.sin(t / 2.3 + 1);
  const dRate = 0.18 / 7 * Math.cos(t / 7) + 0.07 / 2.3 * Math.cos(t / 2.3 + 1);
  // car ahead: reeling him in, then he pulls away again (60 s cycle)
  const ahead = 1.25 + 0.95 * Math.sin(t / 9.5);
  const aheadRate = 0.95 / 9.5 * Math.cos(t / 9.5); // + = gap growing = losing
  const behind = 0.55 + 0.35 * Math.sin(t / 6 + 2);
  const behindRate = 0.35 / 6 * Math.cos(t / 6 + 2); // + = gap growing = gaining
  return { delta, dRate, ahead, aheadRate, behind, behindRate };
}

// ---------------------------------------------------------------- widget templates

const TEMPLATES = {
  session: () => `<div class="widget" data-id="session">
    <div class="title">// <span id="s-mode">race</span></div>
    <div class="big-row">
      <div><div class="k">lap</div><div class="big" data-f="lap"></div></div>
      <div><div class="k">pos</div><div class="big" id="s-pos" data-f="pos"></div></div>
    </div>
    <div class="kv"><span class="k">left</span><span class="v" data-f="left"></span></div>
    <div id="s-track">Monza</div><div id="s-config">Grand Prix</div></div>`,
  clock: () => `<div class="widget" data-id="clock"><div class="title">// time</div><div class="big" id="clock" data-f="clock"></div></div>`,
  relative: () => `<div class="widget" data-id="relative"><div class="title">// relative</div><div data-f="rows"></div></div>`,
  fuel: () => `<div class="widget" id="w-fuel" data-id="fuel"><div class="title">// fuel</div>
    <div class="kv"><span class="k">tank</span><span class="v" data-f="level"></span></div>
    <div class="tank"><div class="tank-fill" data-f="fill"></div><div class="tank-mark" data-f="mark" style="display:block"></div></div>
    <div class="kv"><span class="k">/lap</span><span class="v">2.71 L</span></div>
    <div class="kv"><span class="k">laps</span><span class="v" data-f="laps"></span></div>
    <div class="kv"><span class="k">need</span><span class="v good">ok</span></div></div>`,
  laps: () => `<div class="widget" id="w-laps" data-id="laps"><div class="title">// laps</div>
    <div class="kv"><span class="k">last</span><span class="v" id="l-last" data-f="last"></span></div>
    <div class="kv"><span class="k">optimal</span><span class="v" id="l-opt">1:46.288</span></div></div>`,
  incidents: () => `<div class="widget" data-id="incidents"><div class="title">// incidents</div>
    <div class="big" data-f="inc"></div></div>`,
  "incident-alert": () => `<div class="widget" id="w-incident-alert" data-id="incident-alert">
    <span>contact</span> <span id="ia-x">4x</span></div>`,
  "delta-best": () => deltaTemplate("best", "// Δ session best"),
  "delta-ahead": () => deltaTemplate("ahead", "// ▲ #21 J. O'Neill"),
  "delta-behind": () => deltaTemplate("behind", "// ▼ #55 M. Ruiz"),
  map: () => `<div class="widget" id="w-map" data-id="map"><div class="title">// map</div><canvas id="map"></canvas></div>`,
  radar: () => `<div class="widget" id="w-radar" data-id="radar"><canvas id="radar"></canvas></div>`,
};
function deltaTemplate(kind, title) {
  return `<div class="widget delta ${kind}" data-id="delta-${kind}"><div class="title">${title}</div>
    <div class="drow"><span class="v">–</span><div class="bar"><div class="fill"></div></div></div>
    ${kind === "best" ? "" : '<div class="catch"></div>'}</div>`;
}

function relativeRows(box) {
  // leader pinned on top, then 3 ahead, me, 3 behind (like the overlay)
  for (const d of DRIVERS) {
    const [pos, num, name, cc, ir, lic, sr, cls] = d;
    const row = document.createElement("div");
    row.className = "srow" + (num === ME ? " me" : "") + (num === 12 ? " leader" : "") + (REL[num][1] < 0 ? " lap-down" : "");
    const lap = REL[num][1];
    const tag = lap ? `<span class="tag lap-down">${lap}L</span>`
      : `<span class="tag cls" style="color:${CLASS_COLORS[cls]}">${cls[0]}</span>`;
    row.innerHTML =
      `<span class="pos class-color" style="--badge:${CLASS_COLORS[cls]}">P${pos}</span>` +
      `<span class="num">#${num}</span>` +
      `<span class="ir lic sr${Math.min(3, Math.floor(sr))}" style="--lic:var(--c-lic-${lic.toLowerCase()})" title="${lic} ${sr.toFixed(2)}">${(ir / 1000).toFixed(1)}k</span>` +
      `<img class="flag on" alt="" src="https://flagcdn.com/w40/${cc}.png">` +
      `<span class="name">${name}</span>${RADIO_ICON}${tag}` +
      `<span class="best${num === 12 ? " class-best" : ""}">${fmtLap(d[8])}</span><span class="gap"></span>`;
    row.dataset.num = num;
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------- instances

const instances = [];

function mount(el) {
  const kind = el.dataset.w;
  el.innerHTML = TEMPLATES[kind]();
  const w = el.firstElementChild;
  const f = (name) => w.querySelector(`[data-f="${name}"]`);
  const inst = { kind, el: w, f };
  if (kind === "relative") relativeRows(f("rows"));
  if (kind.startsWith("delta-")) Object.assign(inst, { v: w.querySelector(".v"), fill: w.querySelector(".fill"), catchEl: w.querySelector(".catch") });
  if (kind === "map" || kind === "radar") inst.canvas = w.querySelector("canvas");
  instances.push(inst);
}

// ---------------------------------------------------------------- per-widget updates

function updateText(inst, t, r) {
  const { kind, f } = inst;
  if (kind === "session") {
    setHtml(f("lap"), `${7 + Math.floor(t / LAP_S)}<span class="tot">/~24</span>`);
    setHtml(f("pos"), `7<span class="tot">/22</span>`);
    f("pos").style.color = "color-mix(in srgb, var(--c-good) 61%, var(--c-fg))"; // 2 places gained
    const left = Math.max(0, 1795 - t);
    setText(f("left"), `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, "0")}`);
  } else if (kind === "clock") {
    const d = new Date();
    setHtml(f("clock"), `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` +
      `<span class="sec">:${String(d.getSeconds()).padStart(2, "0")}</span>`);
  } else if (kind === "relative") {
    for (const row of inst.el.querySelectorAll(".srow")) {
      const num = +row.dataset.num;
      const base = REL[num][0];
      const gap = num === ME ? null : base + (num === 21 ? r.ahead - 2.3 : num === 55 ? r.behind - 0.42 : 0.08 * wobble(t, num));
      const g = row.querySelector(".gap");
      setText(g, gap == null ? "" : fmtSigned(gap));
      g.className = "gap" + (gap == null ? "" : gap < 0 ? " ahead" : " behind");
      // someone keys the radio now and then
      row.classList.toggle("talking", num === (Math.floor(t / 9) % 2 ? 55 : 88) && t % 9 < 4);
    }
  } else if (kind === "fuel") {
    const level = 51.4 - ((t * 2.71) / LAP_S) % 30;
    setText(f("level"), `${level.toFixed(1)} L`);
    f("fill").style.width = `${step(level / 60 * 100, 0.5)}%`;
    f("mark").style.left = "38%";
    setText(f("laps"), (level / 2.71).toFixed(1));
  } else if (kind === "laps") {
    const last = 106.519 + 0.35 * wobble(Math.floor(t / LAP_S) * 3, 1);
    setText(f("last"), fmtLap(last));
  } else if (kind === "incidents") {
    setHtml(f("inc"), `1x<span class="tot"> / 17x / 25x</span>`);
    f("inc").style.color = "color-mix(in srgb, var(--c-bad) 29%, var(--c-muted))";
  } else if (kind === "incident-alert") {
    inst.el.classList.toggle("idle", t % 14 > 4); // pops up, fades out
  } else if (kind === "delta-best") {
    setText(inst.v, fmtSigned(r.delta));
    const k = Math.min(1, Math.abs(r.dRate) / 0.08);
    inst.v.style.color = `color-mix(in srgb, var(${r.delta < 0 ? "--c-good" : "--c-bad"}) ${step(35 + 65 * k, 5)}%, var(--c-neutral))`;
    const w = step(Math.min(Math.abs(r.delta) / 0.5, 1) * 50, 0.5);
    inst.fill.style.width = `${w}%`;
    inst.fill.style.left = r.delta < 0 ? `${50 - w}%` : "50%";
    inst.fill.style.background = gainLossColor(r.dRate / 0.08);
  } else if (kind === "delta-ahead" || kind === "delta-behind") {
    const ahead = kind === "delta-ahead";
    const gap = ahead ? r.ahead : r.behind;
    // gaining: ahead gap shrinking, or behind gap growing
    const gain = ahead ? -r.aheadRate : r.behindRate;
    const k = (clamp(gain / 0.08, -1, 1) + 1) / 2;
    setText(inst.v, `${ahead ? "+" : "-"}${gap.toFixed(2)}`);
    const tint = `color-mix(in srgb, var(${ahead ? "--c-ahead" : "--c-behind"}) ${step(10 + 90 * k, 5)}%, var(--c-fg))`;
    inst.v.style.color = tint;
    Object.assign(inst.fill.style, { left: "0", width: `${step(clamp(1 - gap / 2, 0, 1) * 100, 0.5)}%`, background: tint });
    inst.fill.className = "fill prox";
    const closing = ahead ? -r.aheadRate * LAP_S : -r.behindRate * LAP_S; // s/lap
    let text;
    if (gap < 0.5) text = ahead ? "in range" : "on your tail";
    else if (Math.abs(closing) < 0.6) text = "holding";
    else if (closing > 0) {
      const laps = gap / closing;
      text = laps < 1 ? (ahead ? "catching this lap" : "catches you this lap")
        : `${ahead ? "catching in" : "catches you in"} ${(Math.round(laps * 2) / 2).toFixed(1)} laps`;
    } else text = ahead ? "pulling away" : "dropping back";
    setText(inst.catchEl, text);
  }
}

// ---------------------------------------------------------------- radar

const LANE = { L: -0.45, C: 0, R: 0.45 };
const CAR = { len: 4.6, wid: 1.9 };
function radarCars(t) {
  // 16 s cycle: a car closes from behind, sits alongside on the left, then pulls ahead
  const c = (t % 16) / 16;
  const d = -14 + 28 * c; // metres, + = ahead
  const lat = Math.abs(d) < 6.5 ? LANE.L * Math.min(1, (6.5 - Math.abs(d)) / 2) : 0;
  return [{ d, lat }, { d: -9 - 3 * Math.sin(t / 3), lat: 0 }];
}
function drawRadar(inst, t) {
  const canvas = inst.canvas;
  const dpr = devicePixelRatio || 1;
  const size = canvas.clientWidth;
  if (!size) return;
  if (canvas.width !== Math.round(size * dpr)) canvas.width = canvas.height = Math.round(size * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  const c = size / 2, rad = c - 2, range = 20, ppm = rad / range;
  const cars = radarCars(t);
  const left = cars.some((x) => Math.abs(x.lat) > 0.3);

  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, rad, 0, Math.PI * 2);
  ctx.globalAlpha = colors.opacity;
  ctx.fillStyle = colors["--c-bg"];
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = colors["--c-border"];
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.clip();
  const danger = hexRgb(colors["--c-radar-danger"]);
  if (left) {
    const g = ctx.createRadialGradient(c - rad, c, 0, c - rad, c, rad);
    g.addColorStop(0, rgb(danger, 1));
    g.addColorStop(0.35, rgb(danger, 0.6));
    g.addColorStop(1, rgb(danger, 0));
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = g;
    ctx.fillRect(c - rad, c - rad, rad, rad * 2);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = colors["--c-border"];
  ctx.setLineDash([2, 4]);
  for (let m = 5; m < range; m += 5) { ctx.beginPath(); ctx.arc(c, c, m * ppm, 0, Math.PI * 2); ctx.stroke(); }
  ctx.setLineDash([]);
  const drawCar = (x, y, fill, stroke) => {
    const w = CAR.wid * ppm, h = CAR.len * ppm;
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - h / 2, w, h, 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.stroke(); }
  };
  for (const car of cars) {
    const k = Math.min(Math.abs(car.lat) / Math.abs(LANE.L), 1);
    const base = hexRgb(car.d > 0 ? colors["--c-ahead"] : colors["--c-behind"]);
    ctx.globalAlpha = 0.55 + 0.45 * k;
    drawCar(c + car.lat * rad, c - car.d * ppm, rgb(mixRgb(base, danger, k)));
    ctx.globalAlpha = 1;
  }
  drawCar(c, c, null, colors["--c-me"]);
  const inLine = cars.filter((x) => x.lat === 0 && x.d < 0).sort((a, b) => b.d - a.d)[0];
  if (inLine) {
    ctx.font = `${Math.round(size * 0.065)}px ${colors.font}`;
    ctx.fillStyle = colors["--c-fg"];
    ctx.textAlign = "center";
    ctx.fillText(`${(-inLine.d).toFixed(1)}m`, c, c + rad - size * 0.05);
  }
  ctx.restore();
}

// ---------------------------------------------------------------- map

let track = null; // [[x, y], ...] Monza, metres
const mapLayer = { gen: 0 };
// time gained / lost per ~10 m piece of track (Monza ~5.8 km): -1 .. 1, smooth along the
// track like the overlay's blurred paint
const PAINT = Array.from({ length: 580 }, (_, i) => clamp(Math.sin(i / 26) * 0.8 + Math.sin(i / 8.5 + 1) * 0.35, -1, 1));
// [lap %, speed laps/s, class, lap offset]
const MAP_CARS = [
  [0.02, 1 / 106.4, "GT3", 0], [0.09, 1 / 106.9, "GT3", 0], [0.1, 1 / 107.3, "GT3", 0],
  [0.12, 1 / 112.8, "GT4", -1], [0.14, 1 / 107.2, "GT3", 0], [0.17, 1 / 106.4, "GT3", 0],
  [0.47, 1 / 107.8, "GT3", 0], [0.63, 1 / 113.2, "GT4", 0],
];
const ME_START = 0.13;

let bbox = null;
function mapTransform(W, H) {
  if (!bbox) {
    bbox = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const [x, y] of track) {
      bbox.minX = Math.min(bbox.minX, x); bbox.maxX = Math.max(bbox.maxX, x);
      bbox.minY = Math.min(bbox.minY, y); bbox.maxY = Math.max(bbox.maxY, y);
    }
  }
  const { minX, maxX, minY, maxY } = bbox;
  const pad = 10;
  const sc = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
  const ox = (W - (maxX - minX) * sc) / 2, oy = (H - (maxY - minY) * sc) / 2;
  const N = track.length;
  return (pct) => {
    const f = (((pct % 1) + 1) % 1) * N, i = Math.floor(f) % N, j = (i + 1) % N, u = f - Math.floor(f);
    const x = track[i][0] + (track[j][0] - track[i][0]) * u, y = track[i][1] + (track[j][1] - track[i][1]) * u;
    return [(x - minX) * sc + ox, H - ((y - minY) * sc + oy)];
  };
}

function drawMap(inst, t) {
  const canvas = inst.canvas;
  if (!track) return;
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (!W || !H) return;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const at = mapTransform(W, H);
  const myPct = ME_START + t / LAP_S;
  const painted = Math.floor(((myPct % 1) + 1) % 1 * PAINT.length); // this lap's paint so far
  // static layer (road + paint + start line), per instance, rebuilt when the paint grows
  // geometry / colors: rebuild now; new paint: at most ~3x a second (like the overlay)
  const geo = `${W}|${H}|${dpr}|${colors["--c-good"]}|${colors["--c-bad"]}|${colors["--c-neutral"]}|${mapLayer.gen}`;
  const now = performance.now();
  if (inst.geo !== geo || (inst.painted !== painted && now - (inst.builtAt || 0) > 300)) {
    Object.assign(inst, { geo, painted, builtAt: now });
    const off = inst.layer || (inst.layer = document.createElement("canvas"));
    off.width = canvas.width;
    off.height = canvas.height;
    const o = off.getContext("2d");
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    o.lineCap = o.lineJoin = "round";
    const N = track.length;
    o.beginPath();
    for (let i = 0; i < N; i++) o[i ? "lineTo" : "moveTo"](...at(i / N));
    o.closePath();
    o.strokeStyle = colors["--c-muted"];
    o.globalAlpha = 0.35;
    o.lineWidth = 11;
    o.stroke();
    o.globalAlpha = 1;
    const good = hexRgb(colors["--c-good"]), bad = hexRgb(colors["--c-bad"]), mid = hexRgb(colors["--c-neutral"]);
    const S = PAINT.length;
    o.lineWidth = 7;
    o.lineCap = "butt";
    // driven this lap: fresh paint; ahead of me: last lap's (a shifted pattern)
    const value = (k) => { k = ((k % S) + S) % S; return k < painted ? PAINT[k] : PAINT[(k + 137) % S] * 0.8; };
    const colorAt = (k) => {
      const v = value(k), a = Math.abs(v);
      return rgb(mixRgb(mid, v < 0 ? good : bad, Math.min(1, a * 1.4)), (0.25 + 0.75 * a).toFixed(2));
    };
    for (let k = 0; k < S; k++) {
      // gradient from this piece's centre to the next one's, like the overlay: no steps
      const [x0, y0] = at((k + 0.5) / S), [x1, y1] = at((k + 1.5) / S);
      const grad = o.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, colorAt(k));
      grad.addColorStop(1, colorAt(k + 1));
      o.strokeStyle = grad;
      o.beginPath();
      o.moveTo(x0, y0);
      o.lineTo(...at((k + 1) / S));
      o.lineTo(x1, y1);
      o.stroke();
    }
    const [sx, sy] = at(0), [tx, ty] = at(0.004);
    const nx = -(ty - sy), ny = tx - sx, nl = Math.hypot(nx, ny) || 1;
    o.beginPath();
    o.moveTo(sx - (nx / nl) * 9, sy - (ny / nl) * 9);
    o.lineTo(sx + (nx / nl) * 9, sy + (ny / nl) * 9);
    o.strokeStyle = colors["--c-fg"];
    o.lineWidth = 2;
    o.stroke();
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(inst.layer, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dot = (pct, fill, r, ring) => {
    const [x, y] = at(pct);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = ring || colors["--c-bg"];
    ctx.lineWidth = ring ? 2 : 1.5;
    ctx.stroke();
  };
  for (const [p0, v, cls, lap] of MAP_CARS) dot(p0 + v * t, CLASS_COLORS[cls], 4.5, lap < 0 ? colors["--c-lap-down"] : lap > 0 ? colors["--c-lap-up"] : null);
  dot(myPct, colors["--c-me"], 6.5);
}

// ---------------------------------------------------------------- loop

const t0 = performance.now();
let lastMap = 0, lastText = 0;
function frame(now) {
  const t = (now - t0) / 1000 + 30; // start mid-race
  const r = race(t);
  const textDue = now - lastText > 50; // text 20x/s is plenty
  const mapDue = now - lastMap > 33; // map ~30 fps
  if (textDue) lastText = now;
  if (mapDue) lastMap = now;
  for (const inst of instances) {
    if (!inst.visible) continue;
    if (inst.kind === "radar") drawRadar(inst, t);
    else if (inst.kind === "map") { if (mapDue) drawMap(inst, t); }
    else if (textDue) updateText(inst, t, r);
  }
  requestAnimationFrame(frame);
}

function init() {
  initThemePicker();
  for (const el of document.querySelectorAll(".live[data-w]")) mount(el);
  // only animate widgets on screen
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const inst = instances.find((i) => i.el === e.target);
      if (inst) inst.visible = e.isIntersecting;
    }
  }, { rootMargin: "100px" });
  for (const inst of instances) io.observe(inst.el);
  fetch("hud/track.json").then((res) => res.json()).then((pts) => { track = pts; }).catch(() => {});
  requestAnimationFrame(frame); // rAF pauses by itself while the tab is hidden
}

init();
