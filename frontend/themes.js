// Color theme presets, shared by the overlay (app.js) and the website (docs/, copied by
// packaging/build_site.py). Plain script: defines THEMES, DEFAULT_THEME, themeFrom.

// Theme presets after popular VS Code themes. Each palette maps onto every color var;
// gain / loss (good, bad, ahead, behind, radar alongside) use the theme's most vivid
// red and green so they stand out on its background.
function themeFrom(p) {
  return {
    "--c-bg": p.bg, "--c-border": p.border, "--c-fg": p.fg, "--c-muted": p.muted,
    "--c-comment": p.comment, "--c-label": p.blue,
    "--c-pos": p.num, "--c-number": p.orange, "--c-name": p.cyan, "--c-best": p.yellow,
    "--c-best-class": p.purple, "--c-me": p.gold,
    "--c-lap-up": p.red, "--c-lap-down": p.lapDown,
    "--c-ahead": p.red, "--c-behind": p.green, "--c-good": p.green, "--c-bad": p.red,
    "--c-warn": p.warn, "--c-limiter": p.warn, "--c-hazard": p.orange, "--c-fuel": p.teal, "--c-incidents": p.orange, "--c-clock": p.fg,
    "--c-mode": p.yellow, "--c-track": p.cyan, "--c-irating": p.num, "--c-last-lap": p.fg,
    "--c-optimal-lap": p.purple, "--c-radio": p.teal,
    "--c-tire-wet": p.lapDown, "--c-tire-soft": p.red, "--c-tire-medium": p.gold, "--c-tire-hard": p.fg, "--c-radar-car": p.car,
    "--c-radar-danger": p.danger, "--c-neutral": p.neutral || "#ebe5d6",
  };
}
const DEFAULT_THEME = "Dark+";
const THEMES = {
  "Dark+": themeFrom({
    bg: "#1e1e1e", border: "#3c3c3c", fg: "#d4d4d4", muted: "#808080", comment: "#6a9955",
    blue: "#569cd6", num: "#b5cea8", orange: "#ce9178", cyan: "#9cdcfe", yellow: "#dcdcaa",
    purple: "#c586c0", gold: "#ffd700", red: "#ff5533", green: "#8fd448", lapDown: "#3794ff",
    warn: "#cca700", teal: "#4fc1ff", car: "#9e9e9e", danger: "#ff3d1f",
  }),
  "One Dark Pro": themeFrom({
    bg: "#282c34", border: "#3e4451", fg: "#abb2bf", muted: "#5c6370", comment: "#7f848e",
    blue: "#61afef", num: "#d19a66", orange: "#d19a66", cyan: "#56b6c2", yellow: "#e5c07b",
    purple: "#c678dd", gold: "#e5c07b", red: "#ff5c6c", green: "#8cd665", lapDown: "#4aa5f0",
    warn: "#d19a66", teal: "#56b6c2", car: "#9da5b4", danger: "#ff3b4e",
  }),
  "Dracula": themeFrom({
    bg: "#282a36", border: "#44475a", fg: "#f8f8f2", muted: "#6272a4", comment: "#6272a4",
    blue: "#bd93f9", num: "#bd93f9", orange: "#ffb86c", cyan: "#8be9fd", yellow: "#f1fa8c",
    purple: "#ff79c6", gold: "#f1fa8c", red: "#ff5555", green: "#50fa7b", lapDown: "#8be9fd",
    warn: "#ffb86c", teal: "#8be9fd", car: "#a4a8c0", danger: "#ff3030",
  }),
  "Monokai": themeFrom({
    bg: "#272822", border: "#49483e", fg: "#f8f8f2", muted: "#75715e", comment: "#75715e",
    blue: "#66d9ef", num: "#ae81ff", orange: "#fd971f", cyan: "#66d9ef", yellow: "#e6db74",
    purple: "#ae81ff", gold: "#e6db74", red: "#f92672", green: "#a6e22e", lapDown: "#66d9ef",
    warn: "#fd971f", teal: "#66d9ef", car: "#a59f85", danger: "#ff1f5a",
  }),
  "GitHub Dark": themeFrom({
    bg: "#0d1117", border: "#30363d", fg: "#e6edf3", muted: "#8b949e", comment: "#8b949e",
    blue: "#79c0ff", num: "#79c0ff", orange: "#ffa657", cyan: "#a5d6ff", yellow: "#e3b341",
    purple: "#d2a8ff", gold: "#e3b341", red: "#f85149", green: "#3fb950", lapDown: "#58a6ff",
    warn: "#d29922", teal: "#56d4dd", car: "#8b949e", danger: "#ff3b30",
  }),
  "Night Owl": themeFrom({
    bg: "#011627", border: "#1d3b53", fg: "#d6deeb", muted: "#637777", comment: "#637777",
    blue: "#82aaff", num: "#f78c6c", orange: "#f78c6c", cyan: "#7fdbca", yellow: "#ecc48d",
    purple: "#c792ea", gold: "#ffcb8b", red: "#ef5350", green: "#22da6e", lapDown: "#82aaff",
    warn: "#ffcb8b", teal: "#7fdbca", car: "#8badc1", danger: "#ff2c3b",
  }),
  "Tokyo Night": themeFrom({
    bg: "#1a1b26", border: "#292e42", fg: "#c0caf5", muted: "#565f89", comment: "#565f89",
    blue: "#7aa2f7", num: "#ff9e64", orange: "#ff9e64", cyan: "#7dcfff", yellow: "#e0af68",
    purple: "#bb9af7", gold: "#e0af68", red: "#ff5370", green: "#9ece6a", lapDown: "#7aa2f7",
    warn: "#e0af68", teal: "#73daca", car: "#a9b1d6", danger: "#ff3355",
  }),
  "Solarized Dark": themeFrom({
    bg: "#002b36", border: "#073642", fg: "#93a1a1", muted: "#657b83", comment: "#586e75",
    blue: "#268bd2", num: "#2aa198", orange: "#cb4b16", cyan: "#2aa198", yellow: "#b58900",
    purple: "#6c71c4", gold: "#b58900", red: "#ff4136", green: "#a6c400", lapDown: "#268bd2",
    warn: "#b58900", teal: "#2aa198", car: "#839496", danger: "#ff2a1f",
  }),
};
