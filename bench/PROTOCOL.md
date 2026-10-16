# Bridge ↔ phone page protocol (sketch v2, v3)

**v3 changes are marked [v3].** In v3 the board detects pedal turns itself from the crank magnet, and works out the gear from the average over each full turn. Calibration is done **while pedalling**. A page must still accept v2 lines: every field added in v3 goes at the end of a line, and new values are only used when present.

The link uses the Nordic UART Service. That is the same service the Bluefruit Connect "UART" screen uses.

| Role | UUID |
|---|---|
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| RX: the page writes commands here | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| TX: the board notifies lines here | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |

**How lines arrive.** The board sends text lines ending in `\n`. They arrive in notification chunks of up to 20 bytes, so the page must buffer them and split on `\n`.

**Which lines are for the page.** A line is machine-readable when it starts with one of the prefixes below. The board prints every other line for humans. The page shows those in a log.

## Commands (page → board)

Each command is a single ASCII character. Send one character per write.

| Char | Meaning |
|---|---|
| `1` | Status stream ON: an `S` line about 4 times a second. Send this on connect. |
| `0` | Status stream OFF. |
| `c` | Start calibration. |
| `n` | Capture the current calibration point (manual capture). [v3.1] Refused with an `N` line if the lever has not moved from the previous point. While `cal`=4 it confirms the cadence instead. |
| `l` | [v3.1] Learn the crank again. Accepted while `cal`=4 (cadence check), or at point 1 of a calibration that fell back to the hold-still method. |
| `u` | Undo: go back one calibration point. |
| `x` | Abort calibration. |
| `a` | Toggle auto-capture. Default is ON. |
| `p` | Print the stored calibration (human-readable lines). |
| `k` | Dump the stored calibration as `Q` lines (machine-readable). |
| `g` | Start a diagnostics recording. This clears any previous recording. |
| `m` | Mark "a new step starts now" in the recording. Ignored when not recording. |
| `e` | Stop the recording. |
| `y` | Send the recording as `Y`/`D` lines. |
| `h` | Help (human-readable lines). |
| `d` | Toggle the human debug stream. Avoid this from the page, because it is chatty. |
| `t` | [v3] Toggle the per-turn stream (`T` lines, one per pedal turn). |

## Lines (board → page)

### `S`: status

About 4 times a second while the status stream is on.

```
S,<gear>,<res>,<watts>,<cad>,<cal>,<step>,<stab>,<off>,<flags>,<rec>,<src>,<lturns>
```

[v3.1] `lturns` is the number of full pedal turns seen so far while learning the crank (`cal`=3), else 0. While learning, `cad` is the provisional rpm from those turns. Absent on earlier firmware.

[v3] `src` is the cadence source currently in use:

| `src` | Meaning |
|---|---|
| `B` | The board itself, from the crank magnet |
| `W` | A Wahoo or other cadence pod |
| `-` | None, because not pedalling |

It is absent on v2.

`rec` was added after the first version of this spec, so a page must also accept lines without it. It is the number of samples recorded so far. It stays at its last value after recording stops.

| Field | Meaning |
|---|---|
| `gear` | Integer 1–24. `0` = not calibrated. |
| `res` | Keiser resistance 0–100, 1 decimal. |
| `watts` | Integer. |
| `cad` | rpm, 1 decimal. |
| `cal` | `0` idle, `1` waiting for a point, `2` capturing (averaging), `3` [v3] learning the crank ("pedal steadily"; `step` stays 0), `4` [v3.1] cadence check: the crank is learned and the board waits for `n` (the rpm matches the console) or `l` (learn again). |
| `step` | Current calibration point, 0-based (0–24). Only meaningful when `cal` is not 0. |
| `stab` | 0–100: progress towards auto-capture. v2: the "held steady" timer. [v3]: agreeing pedal turns (0, 33, 67, 100 for 0–3 turns). While `cal`=3 it is the crank-learning progress: [v3] time, 0–100 over 10 s; [v3.1] turns, `lturns` / 6 × 100, at most 95 until learning succeeds. |
| `off` | Distance of the current reading from the calibrated path, in µT, 1 decimal. Large = something disturbing. |
| `flags` | Letters, any order; empty if none. See below. |

| Flag | Meaning |
|---|---|
| `V` | Calibration valid |
| `P` | Cadence pod connected |
| `Z` | An app (Zwift) is receiving power |
| `S` | Magnetometer saturated |
| `H` | Holding the last good gear because the reading is off-path |
| `A` | Auto-capture is on |
| `G` | A diagnostics recording is running |
| `Y` | The recording is being sent (status lines pause during the send) |
| `R` | [v3] Pedalling: the board is detecting turns right now |

**Calibration prompt for `step`:**

| `step` | Prompt (v2) | Prompt [v3] (keep pedalling throughout) |
|---|---|---|
| (cal=3) | — | "Pedal steadily at 60–80 rpm so the bridge can learn your crank" (5–15 s) |
| (cal=4) | — | [v3.1] "Check the cadence matches the Keiser console" |
| 0 | "Push the gear lever ALL THE WAY DOWN" | "Keep pedalling. Push the gear lever ALL THE WAY DOWN" |
| 1–23 | "Move the lever up until the console FIRST shows gear `step+1`, then stop pedalling" | "Keep pedalling. Move the lever up until the console FIRST shows gear `step+1`, then hold it there" |
| 24 | "Push the gear lever ALL THE WAY UP" | "Keep pedalling. Push the gear lever ALL THE WAY UP" |

The page tells v2 from v3 by whether `S` lines carry `src`.

### `L`: crank learning result [v3.1]

Sent once when learning ends.

```
L,<ok>,<turns>,<rpm>,<depth>,<reason>
```

| Field | Meaning |
|---|---|
| `ok` | `1` = crank learned (the board goes to `cal`=4), `0` = not found (it falls back to the hold-still method, `cal`=1) |
| `turns` | Full turns counted |
| `rpm` | From the median turn |
| `depth` | Dip depth in µT |
| `reason` | `ok`, `dip too shallow`, `too few turns`, `irregular turns`, or `too fast - counting twice per turn?` |

Learning ends early once 6 turns are seen, most of them (75 %) within 0.75–1.33 × the median turn, and the rpm is at most 160. Otherwise it ends after 15 s, accepting 4 turns. `bench/replay_learn.py` replays this on a recording.

### `N`: manual capture refused [v3.1]

```
N,<reason>
```

`reason` is `noturn` (no full pedal turn yet) or `notmoved` (the reading is within 1 µT of the previous point).

### `C`: point captured

```
C,<point>,<x>,<y>,<z>
```

`point` is 1-based (1–25). `x`, `y`, `z` are in µT.

### `K`: calibration finished

```
K,<ok>,<span>,<minstep>,<minstepAt>,<msg>
```

| Field | Meaning |
|---|---|
| `ok` | `1` = saved, `0` = rejected |
| `span` | Path length in µT |
| `minstep` | Smallest µT between consecutive points |
| `minstepAt` | Gear where the smallest step occurs |
| `msg` | Short text reason or "saved" |

### `A`: calibration aborted

```
A,<reason>
```

### `U`: undo done

```
U,<step>
```

`step` is the new current step, 0-based.

### `Q`: stored calibration

Sent in reply to `k`.

```
Q,<point>,<x>,<y>,<z>
Q,end,<span>,<minstep>,<minstepAt>
```

- There are 25 `Q,<point>` lines, with `point` 1–25 and `x`, `y`, `z` in µT.
- `Q,end` closes the list. Its fields mean the same as in `K`.
- If there is no valid calibration, the board sends only `Q,none`.
- [v3] Before `Q,end`, the board also sends `Q,crank,<ux>,<uy>,<uz>,<depth>,<sign>`: the crank's main direction (unit vector), the typical dip depth in µT, and its polarity (+1 or −1).

### `T`: one pedal turn [v3]

Sent while the per-turn stream (`t`) is on, once per detected turn. **From v3.1 these lines go to USB only, not to the phone.** That keeps Bluetooth traffic down.

```
T,<ms>,<period_ms>,<x>,<y>,<z>,<gear>,<res>
```

| Field | Meaning |
|---|---|
| `ms` | Board time of the dip, in ms. |
| `period_ms` | Time since the previous dip. |
| `x`, `y`, `z` | Average raw field over that turn, in µT, 1 decimal. |
| `gear`, `res` | The resulting gear and resistance. |

### Diagnostics recording

The board reads the sensor 50 times a second. While recording, it stores the average of each pair of raw (unsmoothed) readings, so it stores 25 samples a second. It can hold 12000 samples, which is 8 minutes.

```
G,start,<capacity>,<period_ms>
G,stop,<count>,<duration_ms>
G,full,<count>,<duration_ms>
M,<k>,<index>
```

| Line | When it is sent |
|---|---|
| `G,start` | In reply to `g`. `period_ms` is 40. |
| `G,stop` | In reply to `e`. |
| `G,full` | When recording stops by itself because memory is full. |
| `M` | In reply to `m`. Marker number `k` (1-based) is at sample `index` (0-based); it is the first sample of the new step. There are at most 32 markers. |

**Sending the recording.** In reply to `y`, the board sends:

```
Y,begin,<count>,<period_ms>,<markers>
Y,m,<k>,<index>          (one per marker)
D,<x>,<y>,<z>,<revs>,<dt>  (one per sample, in order)
Y,end,<count>,<checksum>
```

| Field in `D` | Meaning |
|---|---|
| `x`, `y`, `z` | Integers in units of 0.1 µT, raw (not smoothed). |
| `revs` | The Wahoo's cumulative crank revolutions (wraps at 65535), or `-1` if no cadence pod is connected. |
| `dt` | Milliseconds since the previous sample. `0` for the first sample; capped at 255. |

- **Checksum:** `(sum of all x + y + z) mod 65536`, as a non-negative integer, so the page can confirm nothing was lost.
- **Speed:** the board sends about 8 lines per loop pass, so a 3-minute recording takes roughly 20–40 s over Bluetooth.
- **During the send:** the `Y` flag is set and status lines pause. If `y` arrives while recording, the recording is stopped first.

## Beeps on the board (CLUE speaker)

| Sound | Meaning |
|---|---|
| Short high beep | Point captured |
| Two quick high beeps | [v3] Crank learned. Start the 25 points. [v3.1] Check the cadence, then confirm. |
| Two low beeps | Undo |
| Rising chime | Calibration saved |
| Long low buzz | Calibration rejected or aborted |
