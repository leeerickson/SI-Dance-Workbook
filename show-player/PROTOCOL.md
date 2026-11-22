# Recital Show Player ↔ Recital Live (WordPress) protocol

The desktop app pushes the show's state to the WordPress site. Phones read it from the site.
The desktop never waits on the site: if the site is slow or offline, the show keeps running
and the app retries in the background.

## Connecting

In WordPress (**Recital Live → Shows → Edit**), each show has:

- a **slug** (for example `spring-2027`) → mobile link `https://site/recital/spring-2027/`
- a **desktop key**: a random 32-character secret the desktop app sends to publish
- an optional **crew code**: viewers who enter it see cues and props; without it they see the program and timers
- **Listed**: whether the show appears in the "Other shows" menu on the mobile page

The admin page shows a **connection code** to paste into the desktop app. It's base64 of
`{"url":"https://site","show":"spring-2027","key":"<desktop key>"}`.

## Endpoints (all under `/wp-json/recital-live/v1`)

| Method | Path | Auth | Body / result |
| --- | --- | --- | --- |
| GET  | `/ping` | none | `{ ok:true, plugin:"recital-live", version, server_now }` |
| POST | `/shows/{slug}/program` | header `X-Recital-Key` | Program JSON (below). Stored as-is (max 512 KB). Returns `{ ok:true, server_now }` |
| POST | `/shows/{slug}/status` | header `X-Recital-Key` | Status JSON (below). Stored with `received_at` = server time in ms. Returns `{ ok:true, server_now }` |
| GET  | `/shows/{slug}` | optional header `X-Recital-Code` or `?code=` | `{ show:{slug,title,has_code}, crew:bool, program, status, received_at, server_now }` |
| GET  | `/shows` | none | `{ shows:[{slug,title,url}] }` (listed, published shows only) |

- Wrong or missing key → 403 `{ code:"recital_bad_key" }`. Unknown slug → 404.
- Times are milliseconds. `server_now` lets phones correct their clock: the phone works out
  how long ago the status was sent as `server_now - received_at` and adds that to running timers.
- When the viewer is **not crew** (the show has a crew code and it wasn't given, or was wrong),
  the site removes `cues`, `props` and `notes` from every track in the program, and `cue`,
  `next_cue`, `upcoming_cues` and `props` from the status before sending.
- Props are only ever sent for tracks where `show_props` is true (the desktop already leaves the rest out).

## Program JSON (sent when the playlist changes)

```json
{
  "show": "Spring Recital 2027",
  "updated": 1767225600000,
  "tracks": [
    {
      "id": "t1", "n": 1, "title": "Rise Up", "dance": "Senior Jazz", "class": "Jazz 4",
      "duration": 192.4, "type": "audio", "transition": "stop",
      "notes": "Teacher: Ms Kim",
      "show_props": true,
      "props": ["2 chairs SL", "Red umbrella"],
      "cues": [ { "t": 12.0, "type": "light", "text": "LX 14 go" } ]
    }
  ]
}
```

`transition` is `stop`, `straight` or `crossfade`. Cue `type` is `light`, `prop`, `spot`, `sound`, `stage` or `note`.

## Status JSON (sent every 2 s while anything is happening, and at once on any change)

```json
{
  "state": "playing",
  "sent_at": 1767225600000,
  "index": 3,
  "track_id": "t4",
  "position": 41.2,
  "duration": 192.4,
  "rate": 1,
  "show_remaining": 2710.5,
  "next_track_id": "t5",
  "cue": { "t": 40.0, "type": "light", "text": "LX 22 go" },
  "next_cue": { "t": 58.5, "type": "spot", "text": "Spot 1 pick up Ava DSL" },
  "upcoming_cues": [ { "t": 58.5, "type": "spot", "text": "…" } ],
  "props": ["2 chairs SL"],
  "filler": { "playing": true, "title": "Intermission mix" },
  "message": "Intermission — 15 minutes",
  "countdown_left": 900
}
```

- `state`: `idle` (show not started), `standby` (waiting for GO on track `index`), `playing`, `paused`,
  `intermission`, `ended`.
- While `playing`, phones count `position` up and `duration - position` down using the clock correction.
- `message` and `countdown_left` (seconds left when the status was sent; phones subtract the age the same
  way) are optional: the desktop's "Message to phones" box and intermission countdown.
