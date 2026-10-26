# Lovense Plus redesign plan

## Problem

The roleplay model currently has to write toy commands into its reply. It ends
up reasoning about the toys *and* the scene, and often runs out of output
tokens before it writes anything useful.

## New design in one paragraph

The roleplay model just writes the roleplay. After a character message is
sent (and has stayed put for a configurable delay, so swipes don't fire the
toys), a **picker** reads that message and chooses a pattern from the pattern
library. The picker is either a free local **script** (keyword scoring) or a
separate **API call** to a cheap model, using a SillyTavern Connection Profile
that's independent of the chat model. The chosen pattern plays on whatever
toys are connected right now, through either **Lovense Remote** (LAN API) or
**Intiface Central** (Buttplug). Optionally it loops until the next pick.

The old "model writes commands in the message" behaviour stays as **Legacy
Mode**, off by default.

## Components

### 1. Transport layer (`src/transports/`)

One interface, two implementations, chosen by a dropdown in settings.

```
connect() / disconnect()
listDevices() -> [{ id, name, channels: { vibrate: n, rotate: n, pump: n, thrust: n, ... } }]
send(deviceId, { vibrate, vibrate2, rotate, pump, thrust, suction, fingering, oscillate })
stopAll()
onDevicesChanged(cb)
```

- **Lovense Remote** (`lovense_remote.js`): wraps the existing server plugin
  (`server/lovense.mjs`) and the `Function` command. Channel map comes from the
  existing `TOY_CAPABILITIES` table, moved into the transport.
- **Intiface** (`intiface.js`): talks Buttplug v3 to `ws://127.0.0.1:12345`
  straight from the browser (Intiface allows it, no server plugin needed).
  Channels come from each device's `ScalarCmd` / `RotateCmd` / `LinearCmd`
  actuators: Vibrate → `vibrate`/`vibrate2`, Rotate → `rotate`,
  Constrict/Inflate → `pump`, Oscillate → `oscillate`, Position/Linear →
  `thrust`. Scale 0–20 (or 0–3 for pump) onto each actuator's `StepCount`.
  Ports logic from the FreeReign `events_listener.mjs` controller (device
  add/remove events, rescan). Works for non-Lovense toys too.

Settings: transport dropdown (Lovense Remote / Intiface), host/port per
transport, connect button, live device list showing detected channels.

### 2. Pattern library (`patterns/*.json`)

One JSON file per mood. Format and authoring rules in
[`PATTERN_FORMAT.md`](PATTERN_FORMAT.md), validated by
`node tools/validate_patterns.mjs`. Target: ~16 moods × 12–24 patterns
(~250+). The existing FreeReign patterns and `*_loop.sh` scripts get converted
into a `classics` mood and the shell scripts are deleted.

Settings: a checklist of moods, each enable/disable. Disabled moods are never
picked and never sent to the API picker.

### 3. Player (`src/player.js`)

- Plays a pattern's steps on every connected device. For each device, for each
  channel it has: use the step's explicit value, otherwise derive from
  `vibrate` scaled to the channel's range.
- One pattern at a time. A new pick cross-fades (short ramp) instead of
  hard-cutting.
- **Loop**: on (default) or off. Off plays the pattern once and stops.
- **Idle pattern**: optional. If no new pick arrives within N minutes, switch
  to a chosen idle pattern (or mood). Off by default.
- Global stop button, and stop on chat change / extension disable.

### 4. Picker (`src/picker/`)

Triggered by the scheduler (below) with the final message text.

- **Script picker** (`script.js`): counts keyword hits per enabled mood
  (weighting by position, with recency favouring the end of the message),
  plus a simple intensity read (exclamation marks, caps, short punchy
  sentences push energy up). Picks the best mood, then a pattern in it whose
  `energy` fits, avoiding the last few patterns played. No match → keep the
  current pattern.
- **API picker** (`api.js`): uses a SillyTavern Connection Profile chosen in
  settings (separate from the chat model). Sends a short system prompt, the
  message, and a compact menu: for enabled moods, `mood: description`; then
  the model replies with a mood. Second, smaller call (or the same call, if
  "single step" is on) lists that mood's patterns as `id — description` and
  the model replies with one id. Output is parsed strictly; anything invalid
  falls back to the script picker. Low max tokens, no reasoning needed.

Settings: picker mode (Script / API), connection profile dropdown, optional
custom picker prompt.

### 5. Scheduler (`src/scheduler.js`)

- **Delay** after send (seconds, default 4). The timer restarts on swipe,
  regenerate, edit, delete, or a new generation starting. When it runs out, the
  message currently shown is sent to the picker.
- **Trigger on**: checkboxes for "character messages" and "my messages" (any
  combination).
- Streaming: wait for generation end, then start the delay.

### 6. Legacy Mode

The existing prompt-injection + `[Lovense:…]` tag parsing, moved into
`src/legacy.js` and only active when Legacy Mode is ticked. When it's on, the
picker is off.

### 7. Docs and cleanup

- `README.md`: rewritten for the upstream PR (keeps upstream branding and
  links, documents the new modes, Intiface setup, pattern format).
- `README.fork.md` (untracked): provisional README in case this ships as a
  standalone fork instead.
- Delete runtime leftovers: `state.json`, `listener.*`, `*.bak`. Add them to
  `.gitignore`.
- `SKILL.md` / `PATTERNS.md` / `scripts/` (FreeReign) are folded in: useful
  device notes go into README troubleshooting, the controller logic into the
  Intiface transport, the rest is removed.

## Order of work

1. Pattern format + validator ✅
2. Pattern library (parallel agents, one mood each) ✅
3. Transport layer: Lovense Remote and Intiface ✅
4. Player ✅
5. Scheduler + script picker ✅
6. API picker ✅ (not yet tried against a real model)
7. Settings UI ✅
8. Legacy Mode split-out ✅
9. FreeReign conversion to `classics` / `loops` / `marathons`, READMEs ✅
10. Test with real toys and a real picker model, then PR (or fork)

## Mood assignments

| Mood file | Covers |
| --- | --- |
| `tease` | Light, playful, barely there. Flirting, anticipation, warming up. |
| `slow_build` | Long gradual climbs from almost nothing to strong. Patient, inevitable. |
| `edging` | Bring close to the peak, then pull back, again and again. |
| `denial` | Cruel cut-offs, long empty gaps, withheld relief. Power play. |
| `rhythm` | Steady beats: heartbeat, metronome, marching, clockwork. Hypnotic. |
| `waves` | Smooth swells and ebbs. Ocean, breathing, rocking, sine-like. |
| `chaos` | Unpredictable, erratic, glitchy, random-feeling. Keeps you guessing. |
| `intense` | High and relentless. Overwhelming, punishing, no mercy. |
| `climax` | The final push: escalation into a sustained peak, then release. |
| `aftercare` | Gentle cool-down after a peak. Soothing, low, slowly fading. |
| `ambient` | Very low background hum and drift. Idle, cuddling, talking. |
| `spikes` | Mostly silence, broken by sudden short bursts. Ambushes, jolts. |
| `rough` | Hard rhythmic pounding. Motion-heavy (thrust, pump, oscillate). |
| `oral` | Mouth-like: bobbing rhythms, suction, licks, swirls. |
| `dance` | Musical, syncopated: waltz 3/4, swing, drum fills, breakbeats. |
| `overstim` | Keeps going after the peak. Sensitive, too much, can't escape. |
| `classics` | Converted FreeReign patterns (hand-tuned favourites). |
| `loops` | Converted FreeReign shell loops. |
| `marathons` | Converted FreeReign 5–30 minute sessions (tagged `long`). |
