# Pattern format

Patterns live in `patterns/`, one JSON file per mood (`patterns/<mood>.json`).
Each mood can be enabled or disabled in the extension settings. In API picker
mode only the enabled moods are sent to the picker model, and only their
`description` fields, so keep descriptions short and useful.

## File shape

```json
{
  "mood": "tease",
  "label": "Tease",
  "description": "Light, playful, barely-there touches. Flirting, anticipation, the scene is just warming up.",
  "keywords": ["tease", "teasing", "slowly", "barely", "light touch", "flirt", "brush"],
  "patterns": [
    {
      "id": "tease.feather_drift",
      "name": "Feather Drift",
      "description": "Faint wandering flutters that never settle.",
      "energy": 1,
      "tags": ["slow", "light"],
      "steps": [
        { "ms": 2000, "vibrate": 3 },
        { "ms": 1000, "vibrate": 0 },
        { "ms": 2500, "vibrate": 5, "pump": 1 }
      ]
    }
  ]
}
```

### Mood fields

| Field | Rules |
| --- | --- |
| `mood` | Must equal the file name without `.json`. Lowercase, `a-z` and `_` only. |
| `label` | Display name for the settings UI. |
| `description` | One or two sentences describing when this mood fits the scene. The API picker reads this. |
| `keywords` | 15–60 lowercase words or short phrases that suggest this mood when they appear in a message. Used by the script picker. Avoid generic words that would fit every mood ("moan", "yes"). |
| `patterns` | 12–48 patterns (aim for 20–24 in a new mood). |

### Pattern fields

| Field | Rules |
| --- | --- |
| `id` | `<mood>.<snake_case_name>`. Unique across **all** files. |
| `name` | Human-readable, unique across all files. |
| `description` | One short sentence (≤ 120 chars) describing the feel. The API picker reads this. |
| `energy` | Integer 1–5. 1 = barely there, 3 = medium, 5 = maximum. Should roughly match the average `vibrate` (`round(average / 4)`, clamped). Moods that are mostly quiet with brief intense bursts (denial, spikes) are rated by the peak hit instead, so a long silence does not drag them down to 1. |
| `tags` | 1–6 lowercase tags from: `slow`, `fast`, `light`, `heavy`, `build`, `drop`, `steady`, `random`, `pulse`, `wave`, `burst`, `silence`, `long`, `short`, `motion`, `squeeze`, `dual`. |
| `steps` | 6–60 steps (200 for `long` patterns). Played in order, then loop from the start (if looping is on). |

### Step fields

Every step needs `ms` and `vibrate`. Everything else is optional.

| Field | Range | Meaning |
| --- | --- | --- |
| `ms` | 300–60000 (integer) | How long this step lasts. |
| `vibrate` | 0–20 | Main vibration. **Required on every step.** `0` is silence. |
| `vibrate2` | 0–20 | Second motor on dual-motor toys (Edge, Gemini, Dolce…). If omitted it copies `vibrate`. |
| `rotate` | 0–20 | Rotation (Nora, Ridge…). |
| `pump` | 0–3 | Air pump / constriction (Max, Max 2). |
| `thrust` | 0–20 | Thrusting / stroking speed (Gravity, Solace, sex machines). |
| `suction` | 0–20 | Suction (Tenera). |
| `fingering` | 0–20 | Fingering motion (Flexer). |
| `oscillate` | 0–20 | Oscillation (Osci). |

**How toys adapt.** At play time each step is sent only on the channels the
connected toys actually have. If a toy has a channel that a step leaves out,
that channel follows `vibrate`, scaled to its own range. An explicit `0` keeps
it off. So:

- Leave a secondary channel out when "follow the vibe" is what you want.
- Set it explicitly when you want it to move differently from the vibe
  (counter-rhythm, a squeeze on the peaks only, rotation that stays steady
  while the vibe pulses, and so on).

### Total length

The sum of `ms` across a pattern's steps must be between 8 000 and 180 000
(8 seconds to 3 minutes). Most patterns should be 15–90 seconds. Patterns
tagged `long` (whole-session marathons) may run up to 30 minutes.

## Writing good patterns

- Every pattern should feel different from every other one in its file. Vary
  tempo, contour (rising, falling, flat, jagged), silence, and which secondary
  channels move.
- Don't just scale another pattern up or down. Two patterns with the same shape
  at different levels count as duplicates.
- Use silence on purpose. A gap is part of the rhythm.
- Lovense firmware silently drops Bluetooth writes closer than 100 ms apart,
  and every extra channel is another write. The LAN API is slower still. So
  300 ms is the floor; 500 ms or more is safer for multi-channel steps.
- **Avoid numbness.** A flat level held for a long time stops registering.
  Change something (level, rhythm, a secondary channel) at least every
  15–20 seconds, even in calm patterns.
- **Contrast beats volume.** A drop from 6 to 0 and back to 10 feels stronger
  than a flat 14. Build tension with anticipation: pauses, near-misses, a
  ramp that stalls.
- **Ramp into high levels.** Jumping from 0 straight to 18+ reads as a jolt.
  Use that on purpose (spikes, ambushes), otherwise climb through a few steps.
- **Rhythm families.** Mix steady pulses, uneven heartbeat (short-long),
  triplets, accelerando (steps getting shorter), ritardando (getting longer),
  call-and-response between `vibrate` and a secondary channel.
- **Carrier + modulation.** A steady base level with a slow swell or wobble
  on top (e.g. 8 → 11 → 8 → 12 → 8 over a few seconds) feels alive where a flat
  8 feels dead. This is how many commercial toy patterns avoid monotony.
- **Ambient, rhythmic, or both.** Think of each pattern as an ambient bed, a
  rhythmic figure, or a rhythm riding on a bed. Make sure your file has all
  three.
- **Not everyone wants surprises.** Plenty of people find erratic patterns
  distracting and prefer a steady rhythm. Even in wild moods, include a couple
  of patterns that are predictable and easy to settle into.
- **Answer both motors.** Dual-motor toys are often worn as a pair, and one
  side left hanging is miserable. If a step drives one motor and not the
  other, the other must get its turn within 5 seconds (the validator checks
  this, including across the loop). Different levels are fine; one-sided
  silence isn't.
- **Air pump (`pump`) is slow.** It takes a second or two to inflate and
  deflate, so hold a pump level for at least ~1.5 s and don't flicker it.
- **Thrust and stroke toys are mechanical.** Very fast thrust changes can
  stutter; prefer holding a thrust speed for 2 s or more.
- Names and descriptions should be evocative but not explicit. They show up in
  a settings list.

## Checking your work

```bash
node tools/validate_patterns.mjs            # all files
node tools/validate_patterns.mjs tease      # just patterns/tease.json (plus cross-file id/name checks)
```

It must print `OK` with no errors before a pattern file is done.
