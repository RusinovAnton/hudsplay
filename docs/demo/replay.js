// Live demo for the website: plays a recorded mock race (frames.json, written by
// packaging/capture_screenshots.py) through the real HUD frontend by standing in for
// its WebSocket. Loops forever; app.js is unchanged.
// Frames are stored as changes from the previous frame (packaging/demo_diff.py):
// dict -> {key: change, $del: [removed keys]}, same-length list -> {$a: [[i, change]]}.
(() => {
  const framesUrl = new URL("frames.json", document.currentScript.src);
  const loaded = fetch(framesUrl).then((r) => r.json());

  const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  function apply(prev, d) {
    if (isObj(d) && "$a" in d && Array.isArray(prev)) {
      const out = prev.slice();
      for (const [i, sub] of d.$a) out[i] = apply(out[i], sub);
      return out;
    }
    if (isObj(d) && isObj(prev)) {
      const out = { ...prev };
      for (const [k, v] of Object.entries(d)) {
        if (k === "$del") for (const gone of v) delete out[gone];
        else out[k] = apply(prev[k], v);
      }
      return out;
    }
    return d;
  }

  class ReplaySocket {
    constructor() {
      this.closed = false;
      loaded.then((rec) => this.play(rec));
    }
    play({ hz, frames }) {
      let i = 0;
      let state = null;
      const tick = () => {
        if (this.closed) return;
        state = i === 0 ? frames[0] : apply(state, frames[i]); // frame 0 is whole: loops cleanly
        this.onmessage?.({ data: JSON.stringify(state) });
        i = (i + 1) % frames.length;
      };
      tick();
      this.timer = setInterval(tick, 1000 / hz);
    }
    close() {
      this.closed = true;
      clearInterval(this.timer);
    }
  }

  window.WebSocket = ReplaySocket;
})();
