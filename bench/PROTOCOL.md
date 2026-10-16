# Bridge ↔ phone page protocol (sketch v2, v3, v3.1, v3.2, v3.3)

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

## v3.3 additions [v3.3]

The page tells v3.3 from v3.2 by a 15th and 16th field on `S` lines. Everything below is new in v3.3; older lines keep their meaning.

### The calibration flow, as the board sees it

| Step (`S` field 15) | What the rider does | Board state (`cal`, `step` field 7, `pass`) |
|---|---|---|
| 1 Placement | The page shows meters from `X` lines (`v` on); Next is app-side. The page sends `v` again (off), then `c`. | `cal` 0; step 1 while `v` is on |
| 2 Crank | Pedal while the crank is learned, confirm the cadence (`n`), then a few more turns with the lever still (the noise). | `cal` 3, then 4, then 6 with `step` 0 (`pass` `u`) |
| 3 Sweep | Lever all the way down, slowly up as far as you can pedal, `n`; slowly back to the bottom, `n`. A `Z` line follows. | `cal` 6, `step` 1 (`pass` `su`), then `step` 2 (`pass` `sd`) |
| 4 Up pass | Points 1–24 as in v3.2. After point 24 the board saves at once (`C,25`, `K`, then the `F` list) and waits. | `cal` 1/2/5, `pass` `u`; then `cal` 7 (checkpoint, `pass` `d`, `step` 22), still S step 4 |
| 5 Down pass | `n` at the checkpoint, or later `#D`. Each down point is saved as soon as it's captured. | `cal` 1/5, `pass` `d` |
| 6 Gear check | App-driven; results are sent as `#J,check,...`. A redo (`#R`) shows step 6. | `pass` `ru` / `rd` |

New `cal` values: **6** = survey (`step` field 7 is 0 during the noise turns, 1 sweeping up, 2 sweeping down); **7** = the up pass is saved, waiting.

- **At `cal` 7:** `n` (or button A) comes back down; `s` or `x` stops there (the up pass stays saved, and `#D` does the down pass later); `u` goes back to point 24.
- **`x` during the down pass** works like `s`: the down points so far are saved (`K` and the `F` list follow), with no `A` line. Anywhere else in a calibration `x` aborts as before (`A,...`), and nothing new is saved.
- **The noise turns** (`cal` 6, `step` 0) end by themselves once 20 still turns are in (learning and the cadence check count, so usually about 5–10 s more); `n` there skips ahead.
- **`n` in the sweep is never refused.** A skipped sweep gives a `Z` line with a short path and the verdict `weak`; the calibration carries on with tolerances from the noise alone.

### `S`: status, fields 15 and 16, flag `O`

```
S,<gear>,<res>,<watts>,<cad>,<cal>,<step>,<stab>,<off>,<flags>,<rec>,<src>,<lturns>,<pass>,<stepNo>,<steps>
```

| Field | Meaning |
|---|---|
| `stepNo` | The flow's step, 1–6 (table above); 0 when idle (1 while `v` is on). |
| `steps` | 6. |

New `pass` values: `su` (sweep up) and `sd` (sweep down). During the noise turns `pass` is `u`.

New flag:

| Flag | Meaning |
|---|---|
| `O` | Paused: no pedal turn for 3 s (steps 2–5, and a redo), or the phone that started the calibration is disconnected. Timers stop and nothing is captured. Show "Paused — pedal to continue", without alarm styling. |

- **While paused** there are no beeps, and the first full turn after the pause never counts towards a point.
- **Phone gone:** a calibration started from the phone (`c`, `#D` or `#R` sent over Bluetooth) pauses while the phone is disconnected and carries on when it reconnects. After 5 minutes disconnected the board stops: the down pass saves its points, and any other step is aborted (`A,phone disconnected`).
- **USB or the button:** a calibration started that way doesn't pause for the phone.

### New lines

```
X,<fieldMag>,<swing>,<dip>,<headroomPct>,<noise>   placement stream ('v'), 4 Hz
Z,<noise>,<pathLen>,<spot>,<offMedian>,<verdict>    survey result
J,<text>                                             echo of #J (USB only)
```

**`X` fields** (µT except `headroomPct`):

| Field | Meaning |
|---|---|
| `fieldMag` | Size of the smoothed field. |
| `swing` | Range covered since `v` was switched on: the diagonal of the box the readings have covered (per-turn averages once the crank is known, else a 1 s average). It starts again each time `v` is turned on. |
| `dip` | The last turn's crank dip depth once the crank is known (a stored calibration counts); before that, the peak-to-peak of the last 1 s window of the high-passed field (the crank's swing). |
| `headroomPct` | `100 × (1 − largest |raw axis| / saturation)` over the last 250 ms. Saturation is about 1520 µT on the 16-gauss range. |
| `noise` | Median change between consecutive turn averages over the last 8 turns (only meaningful with the lever still); before 4 turns, the noise in use. |

**`Z` fields:**

| Field | Meaning |
|---|---|
| `noise` | Turn-to-turn noise, µT, from about 20 still turns (learning, cadence check, extra): the median of the changes between consecutive turns pooled with second differences ÷ √3 (if the first differences come out over 1.5× larger, the lever moved steadily and only the second differences are used); kept within 0.6–1.6× the stored calibration's noise, and between 0.15 and 2.5. During the up and down passes it is refined from the held turns of each capture (median of the last 64 changes). |
| `pathLen` | Path length of the sweep, µT: chained turn averages, skipping turns within 2 × noise of the last one kept; the longer of up and down. |
| `spot` | `first` (no stored calibration), `same` (the sweep's median distance from the stored path is under max(1.5 µT, 3 × noise)), `new` (further away, or after `#M`). |
| `offMedian` | That median distance, µT; `-1.0` when it wasn't measured (no stored calibration, `#M`, or fewer than 3 sweep turns). |
| `verdict` | `ok`, `weak` (path under 15 × noise), `saturated` (during the survey), or `folded` (the sweep up ends more than max(3 µT, 0.15 × path) nearer its start than its farthest point). The board carries on whatever it says; the up pass's own checks still apply. |

### New and changed commands

| Command | Meaning |
|---|---|
| `v` | Placement stream on/off (`X` lines at 4 Hz, to the phone too). |
| `#M` | The board was moved: the next survey says `new`, and the previous calibration is forgotten as a prior. Replies `E,ok,moved`. |
| `#D` | Start or resume the down pass on the stored calibration, from the highest down point not measured yet. It needs a calibration made while pedalling, no calibration running, and an unfinished down pass (`E,fail,...` otherwise). Replies `E,ok,down`, then the usual prompts. Flag `B` stays set until the reading has been in the upper half of the gear above the first point (shift up first); that is needed only for the first point of the resumed pass. `u` there doesn't go back into the up pass. |
| `#J,<text>` | Echoed as `J,<text>` to USB only (for the log), e.g. `#J,check,<gear_shown>,<gear_console>,<rpm>`. |
| `#I` | USB only: injected-sample mode on/off (`E,ok,inject on` / `off`; over Bluetooth `E,fail,usb only`; while calibrating `E,fail,busy calibrating`). While it's on, real magnetometer reads are ignored and every calibration timer runs on the injected samples' time. With no `#S` for 5 s it switches itself off (`E,ok,inject off`). |
| `#S,<ms>,<x>,<y>,<z>` | USB only, while injecting: one magnetometer sample (µT; `ms` is its time), processed exactly like a sensor-task sample. No reply on success; `E,fail,bad number` or `E,fail,not injecting` on errors. Up to 512 characters are read per loop pass, so samples can be sent faster than real time if the board keeps up. |
| `s` | Stop the down pass and save its points (also at `cal` 7). |
| `p`, `k` | Now sent a few lines per loop pass. `p` ends with the stored calibration's state (spot id, path length, noise, down points, stickiness; "default" where it's unknown), the spot of a calibration in progress, and the tolerances in use. |

### Timing of the check

The check runs from `loop()` after every save (no longer from inside the sample path), and its `F` lines follow. So the `F` lines can come after other lines of the same moment, such as a prompt or a `C` line.

### What the board now works out from measurements

Tolerances come from the survey noise `n`, the expected step into the current point, and the lever's settle-back after a save. The settle-back is learned: the worst along-path offset of the 2 turns after each save, as a running median of the last 6 saves, starting at `n`. At the 2026-10-16 spot (`n` ≈ 0.55 µT) the tolerances are about v3.2's fixed values; `bench/NOTES.md` ("v3.3") has the table.

- **Turns agree:** max(3.6 n, 1.0).
- **Still moving (`W`):** drift / creep / slow = max(1.8 n, 0.6) / max(1.45 n, 0.5) / max(0.73 n, 0.25).
- **Move on:** at least max(1.8 n, f × the expected step), but never more than 0.5 × the expected step; half of it along the pass. f = 0.4 at the same spot (the stored steps), 0.25 at a new or first spot (the sweep's length shared out like the 2026-10-16 path). The down pass uses its own up pass's steps (f = 0.4).
- **New or first spot:** the expected step is only a guess there, so after 8 agreeing turns held in one place the noise floor (1.8 n, half of it along the pass) is enough.
- **Manual `n`:** always needs only the noise floor (`N,notmoved` otherwise).
- **Same spot only:** the reading must also have got to within max(6 n, 0.6 × step) of where that point was in the stored calibration (along the pass; down points only where the stored calibration has one), so a pause part-way through a gear isn't taken. After 10 agreeing turns held in one place this no longer applies.
- **Go back (`N,behind`):** agreeing turns at least max(4 n, 2 × settle, 0.2 × step) behind the previous point, or, after 6 agreeing turns, their mean at least max(1.5 n, 2 × settle) behind.
- **Settle-back:** not learned after the last point of a pass, after a point redone by going back, or when it is over min(0.5 × step, max(2 µT, 4 n)) (the rider moving on, not the lever settling).
- **`N,stuck`** (new reason for `N`): sent once per point when 6 agreeing turns are held within half a step of the previous point (the expected step; the noise floor if there is none) that neither move on nor sit far enough behind. A pause further on, part-way through the gear, gets no hint. Human line: "If the console already shows gear N, ease back into gear N−1 and come up to it again" (coming down: into gear N+1, then down). The page can show the same hint; nothing else changes.
- **Switch points:** edge bias 0.07 × the local step. Where no down point measured the stickiness, it is the measured pairs' median ratio to the local step, else the stored ratio from the last down pass at this spot, else 1.0 × the local step.

### The check (`F`), changed

- **`updown` / `pair`:** each edge's up/down gap along the path is compared with the median of the up-to-6 nearest other edges' gaps (not one median for all), with the limit max(2.0 µT, 2 n, 0.5 × that median), 1.5× wider at the end edges (points 2 and 23, which have neighbours on one side only). The gap across the path is judged the same way. Guesses use the local median gap too.
- **`offpath` (down point):** the limit is max(1.8 µT, 3 n, the median cross offset + max(2.0, 2 n)), because down points normally sit 1.5–3.5 µT across the up path.
- **`prior`:** the limit is max(6 n, 0.5 × the local step), after the translation alignment. There is no prior when the survey said `new` (the previous calibration is dropped then, and by `#M`).
- **`behind` and the shape test:** limits max(0.5, 0.8 n) and max(1.0, 1.7 n) + 0.12 × chord.
- **Weak fields:** every fixed floor above (0.5 / 1.0 / 1.8 / 2.0 µT for behind / shape / off-path / pair) is capped at 0.25 / 0.5 / 0.9 / 1.0 × the median up step around that point (points i−3 to i+3), so a board far from the magnets isn't judged by limits as big as its gear steps. The noise terms still apply.

### What a calibration must pass (changed)

- **Points the same:** a hard reject only when two consecutive points are under 0.4 µT apart. Smaller steps than 2.5 n only give the "very close together" warning.
- **Fold:** a hard reject only when the path comes back within max(0.5, 0.5 n) µT of itself.
- **What is re-judged:** saving down points never re-judges the up path. An edit re-judges it only when an up point changed.

### Stored format

Files are written whole: to `/keiser_tmp.bin` first, then renamed over the old file, so a power cut mid-write keeps the old one. A leftover temporary file is removed at boot.

Calibration **v6** (704 bytes) is v5 (636 bytes) plus:

- `noiseUT`;
- `stepScale` (path length);
- `stickRatio` (stickiness / local step, from the last down pass at this spot; 0 = none);
- `spotId`: a 32-bit id of the spot, an FNV-1a hash of the up points when a calibration is made at a new spot, kept while the board stays put;
- `capRpm[25]` and `downRpm[25]`: the cadence at each capture (uint8);
- 2 bytes of padding.

v4 (332 bytes) and v5 files still load. The noise is unknown (0.6 µT is used), the path length and spot id are worked out, there is no stickiness ratio, and the rpm are 0. `bench/tests/fw_model.py` mirrors the layouts in `pack_cal()` / `unpack_cal()`.

## Beeps on the board (CLUE speaker)

| Sound | Meaning |
|---|---|
| Short high beep | Point captured |
| Two quick high beeps | [v3] Crank learned. Start the 25 points. [v3.1] Check the cadence, then confirm. |
| Two low beeps | Undo |
| Rising chime | Calibration saved |
| Long low buzz | Calibration rejected or aborted |
