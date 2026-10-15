# Track maps

Track outlines that ship with HUDsplay, so the map widget works on a track you haven't
driven yet. One file per track layout: `<TrackID>-<config>.json`.

## Where they come from

- Every map is drawn by HUDsplay from a driver's own clean lap, using the speed and
  compass heading that iRacing's public telemetry SDK reports while driving
  (dead reckoning, see `src/hudsplay/trackmap.py`).
- Nothing here is taken from iRacing's files. No track models, textures, logos or other
  iRacing assets are read, extracted or included. A map is a rough outline: 1000 points
  along the racing line, in metres.
- Track names and IDs are only used to identify which track a map belongs to.
- `0-Grand_Prix.json` was recorded by HUDsplay driving its mock race, whose track is the
  Monza outline from [bacinger/f1-circuits](https://github.com/bacinger/f1-circuits) (MIT).

## Contributing

Drivers share maps they recorded with the tray menu's "Share my track maps", which
opens a pull request. By contributing a map you agree to license it under this
repository's [MIT license](../LICENSE).

## Takedown

If you hold rights to something here and want it removed, open an issue at
https://github.com/RusinovAnton/hudsplay/issues or contact the maintainer through
GitHub, and it will be taken down.

## Format

```json
{"key": "<TrackID>-<config>", "track": "<name>", "recorded": "YYYY-MM-DD", "points": [[x, y], ...]}
```

`track` and `recorded` are missing in maps recorded by older versions.
`points` are evenly spaced by lap distance, starting at the start/finish line.
