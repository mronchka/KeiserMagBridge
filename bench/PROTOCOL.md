# Bridge ↔ phone page protocol (sketch v2, v3, v3.1, v3.2)

**v3 changes are marked [v3].** In v3 the board detects pedal turns itself from the crank magnet, and works out the gear from the average over each full turn. Calibration is done **while pedalling**. A page must still accept v2 lines: every field added in v3 goes at the end of a line, and new values are only used when present.

The link uses the Nordic UART Service. That is the same service the Bluefruit Connect "UART" screen uses.

| Role | UUID |
|---|---|
| Service | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` |
| RX: the page writes commands here | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| TX: the board notifies lines here | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |

**How lines arrive.** The board sends text lines ending in `\n`. They arrive in notification chunks of up to 20 bytes, so the page must buffer them and split on `\n`. (v3.1 sends each line in 20-byte pieces: the default link cuts any longer write at 23 bytes.)

**Which lines are for the page.** A line is machine-readable when it starts with one of the prefixes below. The board prints every other line for humans. The page shows those in a log.

## Commands (page → board)

Each command is a single ASCII character. Send one character per write.

| Char | Meaning |
|---|---|
| `1` | Status stream ON: an `S` line about 4 times a second. Send this on connect. |
| `0` | Status stream OFF. |
| `c` | Start calibration. |
| `n` | Capture the current calibration point (manual capture). [v3.1] Refused with an `N` line if the lever has not moved from the previous point. While `cal`=4 it confirms the cadence instead. While `cal`=5 it captures the point anyway. |
| `l` | [v3.1] Learn the crank again. Accepted while `cal`=4 (cadence check), or at point 1 of the calibration (`cal`=1, `step`=0), in either method. |
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
| `cal` | `0` idle, `1` waiting for a point, `2` capturing (averaging), `3` [v3] learning the crank ("pedal steadily"; `step` stays 0), `4` [v3.1] cadence check: the crank is learned and the board waits for `n` (the rpm matches the console) or `l` (learn again). `5` [v3.1] can't settle: for 15 s the reading at point `step` (0-based) kept changing. The board waits for `u` (redo it) or `n` (capture it anyway). See the `P` line. |
| `step` | Current calibration point, 0-based (0–24). Only meaningful when `cal` is not 0. |
| `stab` | 0–100: progress towards auto-capture. v2: the "held steady" timer. [v3]: agreeing pedal turns: 0, 34, 68, then 100 for 0–3 turns. [v3.1] It stays at 100 for one more turn while the board checks that the lever has stopped. It drops back to 34 when the board asks the rider to hold still (see `W`). It is 0 while `cal`=5. While `cal`=3 it is the crank-learning progress: [v3] time, 0–100 over 10 s; [v3.1] turns, `lturns` / 6 × 100, at most 95 until learning succeeds. |
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
| `M` | [v3.1] The reading at the current point is still changing. Show "Hold the lever still" until the point is captured. |

**Calibration prompt for `step`:**

| `step` | Prompt (v2) | Prompt [v3] (keep pedalling throughout) |
|---|---|---|
| (cal=3) | — | "Pedal steadily at 60–80 rpm so the bridge can learn your crank" (5–15 s) |
| (cal=4) | — | [v3.1] "Check the cadence matches the Keiser console" |
| 0 | "Push the gear lever ALL THE WAY DOWN" | "Keep pedalling. Push the gear lever ALL THE WAY DOWN" — [v3.1] "…ALL THE WAY DOWN and hold it there" |
| 1–23 | "Move the lever up until the console FIRST shows gear `step+1`, then stop pedalling" | "Keep pedalling. Move the lever up until the console FIRST shows gear `step+1`, then hold it there" — [v3.1] "Keep pedalling. Move the lever up to where the Keiser console FIRST shows gear `step+1`, then hold it there" |
| 24 | "Push the gear lever ALL THE WAY UP" | "Keep pedalling. Push the gear lever ALL THE WAY UP" — [v3.1] "…ALL THE WAY UP and hold it there" |
| (redo) | — | [v3.1] After `u` in `cal`=5: "Redo point N: lever DOWN below gear N first, then up to where the console first shows gear N, then hold." Point 25: "push the lever back down a little, then all the way up again and hold." |
| (`M` set) | — | [v3.1] "Hold the lever still — the reading is still changing. It will capture by itself once the lever stops." |

The page splits each prompt into a large heading and a smaller line under the calibration circle. For example, v3.1 points 2–24 show "Shift up to N", then "Keep pedalling. Stop where the Keiser console FIRST shows N, then hold it there". Points 1 and 25 show "Lever all the way down" or "Lever all the way up", then "Keep pedalling and hold it there". The page tells v2 from v3 by whether `S` lines carry `src`, and v3.1 from v3 by whether they also carry `lturns`.

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
| `reason` | `ok`, `no signal`, `dip too shallow`, `too few turns`, `irregular turns`, or `too fast - counting twice per turn?` |

Learning ends early once 6 turns are seen, most of them (75 %) within 0.75–1.33 × the median turn, and the rpm is at most 130. (60–80 rpm is asked for, so a double count shows as 120+.) Otherwise it ends after 15 s, accepting 4 turns. `bench/replay_learn.py` replays this on a recording.

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

### `W`: hold the lever still [v3.1]

```
W,<point>,<drift>,<creep>
```

Sent when 3 turns agreed but the check turn shows that the lever was still moving at point `point` (1-based). The board throws that capture away **and keeps going**: it shows nothing extra, sets the `M` flag, and waits for 3 fresh agreeing turns plus a check turn. Once the lever is still, the point is captured normally, with the usual `C` line. The page should show "Hold the lever still" while `M` is set; the rider doesn't need to tap anything.

| Field | Meaning |
|---|---|
| `drift` | How far, in µT, the turn after the 3 agreeing turns moved further in the direction of travel. |
| `creep` | How far the 3 turns themselves crept in that direction. |

**When it is sent:** if `drift` ≥ 1.0, or if `creep` ≥ 0.8 and `drift` ≥ 0.4. These thresholds were tuned on the 2026-10-15 gear-change recording and on a slowly creeping lever in `bench/tests/test_fw_stress.py`. Point 1 is never questioned. `W` can repeat for the same point.

### `P`: point can't settle [v3.1]

```
P,<point>
```

Sent when the reading at point `point` (1-based) has kept changing for 15 s since the first `W`. The board enters `cal`=5 and stops auto-capturing until the rider answers:

| Answer | What happens |
|---|---|
| `u`: redo | `U,<step>` follows (the same step), and the prompt starts with "Redo: first move the lever DOWN below this gear." The page should show matching instructions: move the lever down below gear N, then up until the console first shows gear N, then hold it. |
| `n` or button A: capture anyway | The point is stored from the latest agreeing turns, and the usual `C` line follows. |
| `x` or a long press | Aborts, as usual. |

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
| `revs` | Cumulative crank revolutions (wraps at 65535): the board's own turn count when it detects the crank itself [v3], otherwise the Wahoo's; `-1` if neither. |
| `dt` | Milliseconds since the previous sample. `0` for the first sample; capped at 255. |

- **Checksum:** `(sum of all x + y + z) mod 65536`, as a non-negative integer, so the page can confirm nothing was lost.
- **Speed:** the board sends about 8 lines per loop pass, so a 3-minute recording takes roughly 20–40 s over Bluetooth.
- **During the send:** the `Y` flag is set and status lines pause. If `y` arrives while recording, the recording is stopped first.

## v3.2 additions [v3.2]

The page tells v3.2 from v3.1 by a 14th field on `S` lines, `pass`. Everything below is new in v3.2; older lines keep their meaning.

### What changes for the rider

- **Up pass:** point 1 (lever all the way down), then points 2–24, "where the console FIRST shows gear N". **Point 25 is no longer pedalled.** As soon as point 24 is saved, the board works out the top point from points 23 and 24 (0.3 × the 23→24 step beyond 24). It sends `C,25,...` by itself, so the page marks dot 25 done.
- **Down pass (crank mode only), straight after the up pass:** the rider is still at gear 24 and comes back down. Down points are 23, 22, …, 2 (22 of them); point 24 has none, because the rider starts the pass right on that edge and the board can't tell a tiny move from noise (that edge keeps the normal stickiness). Down point `k` is "move the lever DOWN to where the console FIRST shows gear k−1". It measures the same gear edge as up point `k`, approached from above. Each gear edge then has an up and a down reading. The gear display copies the console's own stickiness from them, and the path used for watts runs through the middle of each pair. `s` skips the rest of the down pass and saves what has been measured. With the v2 hold-still method (no crank magnet), there is no down pass.
- **Faster capture:** 2 agreeing turns, then 1 check turn. If the check turn agrees and the lever wasn't still moving, the point is the average of all 3 turns. `stab`: `0`, `34` (1 turn), `67` (2 turns agree; the board is now on the check turn: "Turn 3 of 3, checking the lever has stopped"), and `100` briefly when saved.
- **Forward only:** a point is only taken once its reading is at least 1.0 µT from the previous point, with at least 0.5 µT of that **in the pass's direction**. Up: away from the previous point, along the direction of the previous step. Down: towards the lower gears, along the up-pass path. **If turns that agree sit 0.5 µT or more behind the previous point, that point went too far** (the lever overshot). The board goes back to it **by itself**: it sends `N,behind` and then `U,<step>` (`U,<step>,d` in the down pass), and prompts the point again. The rider doesn't tap anything. The page should say e.g. "Gear 22 was saved a little too far up. Shift DOWN into gear 21, then back up to where the console first shows gear 22." (Down pass: "…too far down. Shift UP into gear N+1, then back down to where the console first shows gear N.") Flag `B` stays set until the reading has gone back at least halfway from the point before. While it's set, say "keep going: into gear 21". Then the point is captured as usual. Where there is no point to go back to (point 2, or the first down point), `N,behind` comes alone, once.
- **Any pace:** the prompts no longer ask for 60–80 rpm.

### `S`: status, 14th field `pass`

```
S,<gear>,<res>,<watts>,<cad>,<cal>,<step>,<stab>,<off>,<flags>,<rec>,<src>,<lturns>,<pass>
```

| `pass` | Meaning |
|---|---|
| `-` | Not calibrating |
| `u` | Up pass (also crank learning and the cadence check) |
| `d` | Down pass. `step` is the 0-based point being measured (22 down to 1; the first prompt is "first shows gear 22"). The prompt gear is `step` itself ("first shows gear `step`"). |
| `ru` | Redoing up point `step+1` (see `#R`) |
| `rd` | Redoing down point `step+1` |

New flag:

| Flag | Meaning |
|---|---|
| `B` | Go back first. In a redo (`ru`/`rd`) or after the board went back to an overshot point (`N,behind`), the reading hasn't yet been past the point. Up: move the lever below gear N first. Down: move it above. Clears once it has. |

### New and changed lines

```
C,<point>,<x>,<y>,<z>          up point captured (as before); C,25 now comes by itself
C,down,<point>,<x>,<y>,<z>     down point captured (point 23 down to 2)
U,<step>,d                     undo in the down pass (step = 0-based point now being measured)
N,behind                       the previous point overshot; a U line follows when the board goes back to it
Q,down,<point>,<x>,<y>,<z>     stored down points ('k'), after the 25 up Q lines
F,<u|d>,<point>,<reason>,<gx>,<gy>,<gz>   a point that looks wrong, with the board's best guess
F,end,<count>                  end of the check (count may be 0)
E,ok,<what>                    an edit command worked (then K and the F list follow)
E,fail,<reason>                an edit command was refused; nothing changed
```

`Q,down` lines and `C,down` lines start with a word in place of a number, so pages from before v3.2 ignore them.

**The check (`F`)** runs after every saved calibration, after every edit, and at boot; `k` re-sends its result. It looks at one suspect at a time: the worst point is set aside, everything is scored again without it, and so on (up to 8). That way one bad point doesn't make its neighbours look bad. Reasons:

| `reason` | Meaning |
|---|---|
| `behind` | The point isn't past the previous point of its pass (taken early, or the one before it overshot). |
| `offpath` | Up point: off the smooth curve through its neighbours (the spacing itself is never judged; Keiser's gears are uneven). Down point: off the up path. |
| `updown` | This gear edge's up and down readings disagree (along the path) more than the other edges' do, or are offset across the path; this one is the reading that's off. |
| `pair` | As `updown`, but the board can't tell which of the two is off. It comes as two lines, `F,u,N,pair,…` and `F,d,N,pair,…`, so redo both. Needs 5 or more pairs. |
| `prior` | Up point that moved more than 2 µT from the previous calibration (kept in flash), after allowing for an overall shift. If more than 6 would be flagged, the board was probably moved, and the comparison is dropped. |

The guess (`gx,gy,gz`) is the board's estimate. It is:
- the other pass's reading plus the usual up/down offset when it has one;
- for `prior`, the point placed between its neighbours as it was in the previous calibration;
- otherwise, the point interpolated between its neighbours in proportion to Keiser's gear table.

The board never applies a guess by itself. The path for gear and watts uses the guess for a flagged up point, and leaves flagged down points out, until the rider redoes the point (`#R`) or accepts the guess (`#G`).

Detection limit: a point roughly 2 µT or more out of place (along the path, or across it).

### Edit commands (multi-character, start with `#`, end with `\n`)

Over Bluetooth, a write carries at most 20 bytes, so split longer commands into 20-byte writes; the board joins them up to the `\n`.

| Command | Meaning |
|---|---|
| `#R,u,<point>` | Redo up point 2–24 by pedalling (needs a saved calibration with the crank learned, and not calibrating). Prompt: "Redo gear N: move the lever DOWN below gear N, then up to where the console FIRST shows gear N, and hold it there." Flag `B` is set until the reading has been below the point. Then it captures like any point, saves, and sends `E,ok`, `K` and the `F` list. `x` cancels. |
| `#R,d,<point>` | Redo down point 2–23: from above, down to where the console first shows gear `point−1`. |
| `#G,<u|d>,<point>` | Use the board's best guess for a point from the latest `F` list. Saves, then `E,ok`, `K`, `F`. |
| `#P,<u|d>,<point>,<x>,<y>,<z>` | Stage a value for a point (USB use). Nothing changes until `#W`. Each one answers `E,ok,staged`. |
| `#W` | Check the staged calibration like a finished one, and save it if it passes. |
| `#X` | Throw away staged values. |

`s` (single character): skip the rest of the down pass and save now. Only while `pass` is `d`.

**Stored format:** calibration v5 (v4 plus down points). A saved v4 calibration still loads, without down points.

## Beeps on the board (CLUE speaker)

| Sound | Meaning |
|---|---|
| Short high beep | Point captured |
| Two quick high beeps | [v3] Crank learned. Start the 25 points. [v3.1] Check the cadence, then confirm. |
| Two low beeps | Undo |
| Rising chime | Calibration saved |
| Long low buzz | Calibration rejected or aborted |
