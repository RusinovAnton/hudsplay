"""Frame-difference encoding for the website demo (docs/demo/frames.json).

Each recorded frame is stored as the change from the previous one, mirrored by
apply() in docs/demo/replay.js:
  dict -> {key: change} with removed keys in "$del"; same-length list -> {"$a": [[i, change]]};
  anything else -> the new value. The first frame is stored whole.
"""

from __future__ import annotations

_SAME = object()


def diff(prev, cur):
    """Change from prev to cur, or _SAME."""
    if prev == cur:
        return _SAME
    if isinstance(prev, dict) and isinstance(cur, dict):
        out = {}
        for k, v in cur.items():
            d = diff(prev.get(k, _SAME), v) if k in prev else v
            if d is not _SAME:
                out[k] = d
        gone = [k for k in prev if k not in cur]
        if gone:
            out["$del"] = gone
        return out
    if isinstance(prev, list) and isinstance(cur, list) and len(prev) == len(cur):
        changes = [[i, d] for i, (a, b) in enumerate(zip(prev, cur)) if (d := diff(a, b)) is not _SAME]
        return {"$a": changes}
    return cur


def apply(prev, d):
    if isinstance(d, dict) and "$a" in d and isinstance(prev, list):
        out = list(prev)
        for i, sub in d["$a"]:
            out[i] = apply(out[i], sub)
        return out
    if isinstance(d, dict) and isinstance(prev, dict):
        out = dict(prev)
        for k, v in d.items():
            if k == "$del":
                for gone in v:
                    out.pop(gone, None)
            else:
                out[k] = apply(prev.get(k), v)
        return out
    return d


def encode(frames: list) -> list:
    out, prev = [], None
    for f in frames:
        out.append(f if prev is None else diff(prev, f))
        prev = f
    return out


def decode(encoded: list) -> list:
    out, state = [], None
    for d in encoded:
        state = d if state is None else apply(state, d)
        out.append(state)
    return out
