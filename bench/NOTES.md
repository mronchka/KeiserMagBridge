# Keiser M3 Bridge: setup notes

## Status (2026-10-15)

| Step | Status |
|---|---|
| 1. Toolchain | Done. arduino-cli 1.5.1 (`C:\Program Files\Arduino CLI\arduino-cli.exe`), adafruit:nrf52 1.7.0, Adafruit LIS3MDL 1.2.5 + BusIO 1.17.4 + Unified Sensor 1.1.15 |
| 2. Board on USB | Done. CLUE shows up as COM3 (bootloader COM4); the USB-C to micro-USB cable carries data |
| 3. Upload | Done. Current KeiserMagBridge.ino (phone-console version) is on the board, unmodified |
| 4. Bench test | Passed. ~59 µT at rest, ±0.3 µT noise, fridge magnet moved it up to ~300 µT, no SAT |
| Phone console | Works. Bluefruit Connect → Keiser M3 Bridge → UART; `h` and `p` reply on the phone and also on USB |
| 5. Mounting spot | Spot 1 (plastic cover below the resistance magnet): ~146 µT lever span, smooth one-way change, no SAT |
| 6. Crank magnet | **Spot 1 fails.** One slow crank turn changes the field by up to 61 µT (~40% of the lever span) |
| 7–10 | Not started |

## Key findings at spot 1

- **Lever span:** about 146 µT from fully down to fully up. Most of the change is in the lower part of the travel (about 40% in the first quarter, about 7% in the last quarter).
- **Board movement check:** the lever-change vector was identical before and after all the pedalling tests (146.5 vs 146.3 µT, same direction), so the board did not move.
- **The crank magnet adds a field that depends on where the crank is resting,** up to about 61 µT. That explains the earlier "gear 7→8 jump", the offset while pedalling, and the jumps when sitting or leaning.
- **Spinning the flywheel by hand** showed no effect of its own.
- **The debug stream runs at about 3.5 Hz** while the phone is connected (5 Hz nominal). That is too slow to resolve per-revolution effects, which alias into slow drift.

## What's known about Keiser's own sensors (web research)

- **Cadence:** the bike counts pedal turns with a magnetic reed switch that "closes once per crank revolution" as a magnet on the crank assembly passes it. Gear is read by a 10K potentiometer linked to the resistance magnet assembly. Both sit on one sensor board (source: KBikeBLE README, https://github.com/ajs123/KBikeBLE).
- **Where that board is:** the shifter cable moves the "magnet cover", whose internal teeth mesh with a gear on the "speed pickup assembly with circuit board (lower circuit board)" (source: Sportsmith M3 calibration guide).
- **Inference:** the reed switch sits right at the resistance magnet assembly, so the crank magnet must pass close to that area on every turn. That's why spot 1 picked it up. Avoid the lower board / pickup area, and anything near the crank's path past it.
- **Finding the crank magnet:** turn the crank slowly while holding a steel paperclip on a thread near the crank and pulley area; it will tug toward the magnet.

## Sketch v2 (prepared 2026-10-15, compiled, NOT uploaded yet)

**Files**

| File | What it is |
|---|---|
| `KeiserMagBridge_v2/KeiserMagBridge_v2.ino` | The new sketch |
| `KeiserMagBridge.ino` | The original, unchanged (it's what's on the board now) |
| `KeiserMagBridge.ino.orig` | Byte-identical backup of the original |
| `KeiserMagBridge_v2/build/KeiserMagBridge_v2.uf2` | Drag-and-drop firmware: double-tap reset, then drop it on CLUEBOOT |

**Changes from the original**

1. **Follow-the-path gear detection.** The 25 calibration readings are kept as a chain of points in 3-D, and each reading is located along that chain. It reports `off` (the distance from the path, in µT). Off-path readings above 8 µT hold the last good gear for up to 2 s, and set flag `H`.
2. **Auto-capture calibration with beeps.** The reading must be held steady within 0.6 µT for 2 s, and at least 1 µT away from the previous point. `u` = undo. `a` = toggle auto-capture. The beep sounds are listed in `PROTOCOL.md`.
3. **`r` fast raw stream** at 50 Hz, USB only, with lines of the form `R,ms,rawx,rawy,rawz,smoothx,smoothy,smoothz`.
4. **`1`/`0` status stream** for the phone page; see `PROTOCOL.md`.
5. **Calibration checks:** path length ≥ 20 µT; reject consecutive points < 0.3 µT apart; reject if the path folds back within 1 µT of itself; warn if any step is < 1.5 µT. Calibration file v2: old v1 calibrations are not reused.
6. **`k`:** dumps the stored calibration as `Q` lines.
7. **Diagnostics recording:** `g` start, `m` mark a step, `e` stop, `y` send. It stores raw field and Wahoo crank revs at 25 Hz (each pair of 50 Hz readings averaged), up to 12,000 samples (8 min), in a 108 KB RAM buffer. RAM use is 52%, with 112 KB free. The send is spread over loop passes so the watchdog stays fed. Status lines pause during the send.

**Things to verify on the real board** (only compiled so far):
- The beeps play.
- Bluetooth is stable with the larger RAM buffer.
- How long a dump takes over Bluetooth to Bluefy.

**The phone page** (`webapp/`, live at https://mronchka.github.io/keiser-m3-bridge/) has Ride, Calibrate, Diagnose and Console tabs. It saves calibration and diagnostic runs as CSV for sharing.

**To upload** (board plugged in on COM3):

```
arduino-cli upload --fqbn adafruit:nrf52:cluenrf52840 -p COM3 KeiserMagBridge_v2
```

## Sketch v3 (prepared 2026-10-15 late, compiled, NOT uploaded; v2 is on the board)

**Files**

| File | What it is |
|---|---|
| `KeiserMagBridge_v3/KeiserMagBridge_v3.ino` | The new sketch |
| `KeiserMagBridge_v3/build/KeiserMagBridge_v3.uf2` | Drag-and-drop firmware |

**What's new**
- **Crank-magnet turn detector:** it runs on raw 50 Hz samples along a learned direction. A dip is counted at 0.5 × the learned depth below the baseline; the turn boundary comes when the signal climbs back above 0.25 × depth. Other settings: 200 ms refractory period, and a stall resync (running mean, re-arm after 3 s). It mirrors `bench/replay_v3.py`.
- **Replay of the 2026-10-15 log:**
  - Counts 10 / 20 / 30 against the hand counts 10 / 20 / 30. The 10 hand turns detect as 9: at 12 rpm, that's below riding speed.
  - Cadence 35.2 and 82.1 rpm (console ~35 and ~84).
  - Resyncs within about 1.5 turns after the lever is moved while stopped. Before the fix it missed 12 s of pedalling there.
- **Cadence:** comes from the board's own turns, as does the crank data sent to Zwift. A cadence pod is used only if the crank can't be learned.
- **Gear:** from per-turn averages, without dwell. When stopped, the board holds the last gear.
- **Calibration while pedalling:** ~10 s of crank learning (two quick beeps when learned), then 25 points, each auto-captured when 3 turns agree within 1.0 µT and the reading has moved ≥ 1.0 µT. The replay captured 20–21 points for ~20 real lever moves, all in order. If the crank isn't found, calibration falls back to the v2 hold-still method.
- **Calibration file v3:** adds the crank direction, polarity, depth and baseline. Recalibrate after uploading.
- **`t` stream:** T lines, one per turn. `Q,crank` is added to `k`. The S line gains a `src` field and the `R` flag.
- **RAM:** 56% used, 104 KB free.

**The phone page** supports v3: the learning card, the "turns agreeing" meter, the cadence source, the Turns button, and demo `&v3=1`. It's live on GitHub Pages.

**First v3 session:**
1. Upload v3.
2. Calibrate while pedalling.
3. Ride low, middle and high gears, comparing gear and watts with the Keiser console.
4. Then downshifts, stops and restarts, a sprint above 100 rpm, standing, and a little back-pedalling.

## v3.1 (2026-10-15 late, compiled, NOT uploaded; v3 is on the board)

**What happened with v3:** the first bike calibration with the phone connected got stuck at "2 of 3". Turn-to-turn changes were 2.5–5 µT, getting worse with cadence, against 0.45 µT in the replay. Status-line gaps reached 1.3 s, a sign the loop was stalling on Bluetooth sends. Simulating those stalls on the 2026-10-15 recording reproduced it (0.75 → 3–4 µT). Time-weighting the readings did not help.

**The fix in v3.1** (`KeiserMagBridge_v3_1/`):
- A FreeRTOS sensor task reads at a fixed rate into a 128-entry queue (2.5 s) of timestamped readings, which `loop()` drains.
- Phone output goes out a whole line per notification.
- T lines go to USB only.
- `TURN_AGREE_UT` is 2.0.
- The debug line shows queue drops.

**Check before riding:**
1. Board on USB, phone connected to the page, the `r` stream on, for 1 minute.
2. Gaps between R-line timestamps should be a steady ~20 ms, with drops = 0.

**Phone page fixes (in progress):**
- Stale status no longer flips the Calibrate view (5 s threshold, a "waiting" note, v3 latched).
- Incomplete calibrations are saved on cancel or disconnect.
- A clearer message for `Q,none`.

## Method test bench and gear ladder (2026-10-16)

**Bench:** `bench/method_bench.py` scores 8 processing methods on wobble, resolution, bias, delay, drift once stopped and turn counting, on clean data and with simulated stalls. Results are in `bench/results/`, summarised in `method_bench_2026-10-15_summary.md`. The best method was **averaging the last 2 turns**: wobble 0.12 µT, all 10 gear steps resolved, 0.3 µT drift once stopped.

**Ground truth:** the Bike Test Panel (https://claude.ai/artifact/VKnU6LFQCicTpvGkxeZXri) has a **Gear ladder** tab. Pedal steadily, tap "Holding gear N" when the console shows N, hold for 5 s, and go 1 → 24 → 1. Console watts and rpm are optional per gear.

**Two kinds of ladder** (panel v11, switch "Where to hold each gear", key E; each hold is tagged `at: mid|edge`):
- **Middle of the gear:** hold anywhere the console shows the gear. Used to score the methods and the board's gear in riding conditions.
- **Where it first shows (edges):** move the lever slowly until the console *first* shows the gear, then hold. Going up that is the bottom of each gear; coming down, the top. Gear 1 starts with the lever all the way down. At 24 there is one extra hold with the lever all the way up (the top of 24). Used for the per-gear range and play check.

**Scoring:** `bench/ladder_eval.py LOG CLICKS [--cal FILE]`:
1. **Methods** (mid ladder): calibrates on the way up, tests on the way down. Reports gear % correct (exact and within 1), position bias and spread, watts vs the console, and up vs down difference.
2. **Gear range** (edge ladder): per gear, bottom, top, range (top − bottom along the lever path), width going up, **play** at each gear change (where the console changes going up minus coming down), turn-to-turn noise, and flags (narrow < 1.5 µT, noisy < 4 noise SDs, play > 25 % of the gear). It ends with a verdict on whether calibrating on the way down would help. Output: `bench/results/ladder_<log>_gears.csv`.
3. **Board calibration check:** replays the sketch v3.1 gear logic (path-following, off-path hold, 20 % hysteresis, one update per turn) with the stored calibration. The calibration comes from `--cal` (a phone page calibration CSV, or a log with the board's `p` printout) or from a `p` printout in LOG. Mid holds give the % of time the board shows the console's gear (up and down). Edge holds show where the board puts each console gear change, in gear widths.

`--dry-run` checks the pipeline on the 2026-10-15 log with made-up gears (and a made-up calibration).

**Tap timing tolerance:** each hold is taken as the cluster of pedal turns where the lever sat still near the tap (within 3 s either side of the 5 s window; all turns within 1.0 µT of the cluster's median). It isn't the exact tap window, so tapping a bit early or late, or moving on before the bar fills, doesn't matter much. `--window tap` restores the exact window. The output gives a timing line saying how far the steady stretch was from the taps.

Tested with `bench/test_ladder_timing.py` on 3 simulated sessions (`bench/sim_ladder.py`). They use real crank dips and noise from the 2026-10-15 fast-pedalling step, a curved 120 µT lever path and a known play. Taps were from 2 s early to 3 s late, and the rider moved on from 1.5 s early to 1.5 s late (at least 1.5 s at each gear):

| Taps | Hold taken as | Range error, median / max | Play error, median / max | Board shows console gear (mid, up / down) |
|---|---|---|---|---|
| perfect | tap window | 0.08 / 0.27 µT | 0.05 / 0.14 µT | 94 / 99 % |
| sloppy | tap window | 0.20 / 2.01 µT | 0.21 / 5.00 µT | 86 / 90 % |
| sloppy | steady stretch | 0.10 / 1.09 µT | 0.15 / 1.05 µT | 92 / 95 % |

The remaining worst cases are holds where the lever sat still for only about 2 turns. Staying until the bar fills keeps the error near the median.

**Down-pass calibration in the app:** not yet. Decide from the edge ladder's play numbers. Under about 10 % of a gear it isn't needed. At 10–25 %, calibrate both ways and use the midpoint. Over 25 %, calibrate both ways, possibly with direction-aware edges. It would be a sketch and app change (backup and OK first).

**To capture (one session, about 25 min of pedalling with rests):**
1. Board on USB, logger running with `r` (50 Hz raw).
2. Phone page **disconnected** (or v3.1 uploaded), so there are no stalls.
3. Calibrate in the app (v3, while pedalling), then send `p` through the logger so the stored calibration lands in the log.
4. Panel open on the computer: edges ladder (1 → 24 → 1), rest, then middle ladder.
5. Afterwards, export the clicks from the panel's `events` collection into `bench/logs/<date>_ladder_clicks.json`.

## v3.1 review fixes (2026-10-16, compiled, NOT uploaded)

A review agent tested the v3.1 sketch, including the other session's in-place additions. Its tests are in `bench/tests/`:

```
py -3 bench/tests/test_fw_log.py
py -3 bench/tests/test_fw_stress.py
py -3 bench/tests/test_ble_lines.py
```

The backup from before these fixes is `bench/backups/KeiserMagBridge_v3_1.before-review-fixes.2026-10-16.ino`.

**Fixes made:**
- **Blocker:** phone text is sent in 20-byte pieces. Without `configPrphBandwidth`, the link cuts any longer write at 23 bytes, so every line over 23 characters was being cut off.
- **Learning cap 130 rpm** (was 160). This catches double counts from about 65 rpm. Below that, the rider's cadence check catches them.
- **Real 19.53 ms tick clock in `crankLearn()`.** The learned rpm read about 2.3% low before.
- **DualLog:** a half-line from a previous connection is dropped.
- **Learning resets the self-cadence**, so the check doesn't show the old cadence.
- **Lost readings** (`sampleDrops`) reset the turn timing.
- **Calibration format v4.** v3 calibrations are rejected; recalibrate after uploading.
- **The sensor task's creation is checked**, and the unused `lastSampleMs` is removed.

**New: the "lever still moving" check (hold-still design, chosen by the user).**
- After 3 turns agree, the board checks one more turn. The capture is dropped if that turn moved ≥ 1.0 µT further along the direction of travel, or if the 3 turns crept ≥ 0.8 µT and the next turn kept going ≥ 0.4 µT.
- When a capture is dropped, the board sends `W`, sets flag `M` ("hold the lever still") and simply waits for fresh agreement. It captures by itself once the lever is still, with no taps.
- Only after 15 s of no settling does it send `P` and enter cal state 5, where the rider can redo (`u`) or capture anyway (`n`).

**Why there is no "wait for it to settle" step:** raw data shows the carrier stops when the lever stops (at most ~1 µT bounce for under 1 s at the top end stop). Cadence affects the reading only 0.05 µT per rpm. Two steady stretches crept 1.5–1.8 µT; possibly a hand resting on the lever, still to test with hands off the lever at a middle gear.

**Tuning:**
- On the free-shifting gear-change recording, "hold still" notices appeared on 5 points, and the lever never failed to settle.
- A lever creeping slowly (0.6 µT/s) now gets 1 capture at the end stop, against 11 before.
- A capture now needs about 4–5 turns (~4 s at 70 rpm).

Backups:
- `bench/backups/KeiserMagBridge_v3_1.before-review-fixes.2026-10-16.ino`
- `bench/backups/KeiserMagBridge_v3_1.keep-redo-version.2026-10-16.ino`

**Results:** all three test suites pass. Compile: 19% storage, 58% RAM, no warnings.

## First bike calibration on v3.1 and the ride test (2026-10-16)

- **Calibration** (from the phone app, logged over USB):
  - Crank learned first time (6 regular turns at 68 rpm).
  - 25 points in about 3½ minutes, with 4 "hold still" notices that settled by themselves. Path 134.4 µT.
  - Two points went backwards. Gear 20 was saved before the lever moved (the rider says it captured early). Gear 22 overshot to about gear 23's position, so 23 landed behind it.
  - The top end was hard work at 60–80 rpm, and point 25 is the brake, so it can't really be pedalled.
- **Ride test:**
  - Gear is mostly right. Gears 11–14 read about one low near the gear edges.
  - The "Not calibrated" flash is on the phone side: every USB status line had `V` and a valid gear.
  - Watts were about 40 % below the console (112 vs 180 at gear 14, 66 rpm).
- **Watts:** the sketch uses KBikeBLE's table, which copies Keiser's console v4.06 (Keiser's dynamometer-measured "actual" power). Keiser's v1.15 → v4.06 chart shows the old v1.15 console reading gear 14 as 264 W at 90 rpm: × 0.65 at 66 rpm ≈ 173 W, matching this console's 180 W. So this console is most likely v1.15. **Decision: keep v4.06 (measured power) for Zwift.**
- **Per-turn scatter at a held lever** (97 turns, 2026-10-15): one turn is off by 0.35 µT typically, 1.16 µT at the 90th percentile; 2 turns 0.25 / 1.08; 3 turns 0.19 / 0.91. Consecutive turns are correlated (lag-1 0.58).

## v3.2 (2026-10-16, built and tested)

Folder `KeiserMagBridge_v3_2/`. Backup of v3.1 before it: `bench/backups/KeiserMagBridge_v3_1.final.2026-10-16.ino` (v3.1 is also in git). Protocol: `bench/PROTOCOL.md`, "v3.2 additions".

- **Faster capture, same precision:** 2 agreeing turns, then the check turn. If the check turn agrees and the lever wasn't still moving, the point is the average of all 3. That's one turn less per point than v3.1.
  - The "still moving" check uses creep from the first agreeing turn to the check turn, which keeps v3.1's 3-turn span. The first try measured creep over 2 turns and let a slowly creeping lever through (11 points instead of 1).
- **Forward only:** a point needs ≥ 1.0 µT from the previous point, with ≥ 0.5 µT of that in the pass's direction (the direction of the previous step, or the up path for the down pass). In the 2026-10-16 calibration, good steps bend by at most cos 0.58 from the previous step. Agreeing turns ≥ 0.5 µT behind send `N,behind`, so the page can suggest Undo.
- **No pedalling into the brake:** the top point is point 24 + (gear-24 width ÷ gear-23 width) × (24 − 23).
- **Down pass:** after point 24, the rider comes down through "first shows gear 22" … "first shows gear 1" (points 23..2). Point 24 gets no down reading, because the rider starts the pass right on that edge.
  - The path for gear and watts runs through the middle of each up/down pair.
  - Each measured edge switches gear at its own up and down readings (a band of at least 10 % of the gear width). Unmeasured edges keep the old 20 % band. `s` skips the rest.
- **Check after every save and on `k`** (`F` lines), deliberately conservative:
  - `behind`: a point not 0.5 µT past the one before. The later point is blamed, unless the step into the earlier one was more than 1.6 × the usual nearby step (an overshoot).
  - `updown`: an up/down offset more than max(1.5 µT, 0.6 × the smaller neighbouring step) away from the median offset.
  - Guess: the other pass plus the median offset, else interpolation in proportion to Keiser's gear table. Nothing is changed without the rider (`#G`).
- **`#` line commands:**
  - `#R,u|d,N`: redo one point by pedalling. It only captures after the reading has been in the far half of the neighbouring gear and come back.
  - `#G,u|d,N`: use the guess.
  - `#P,u|d,N,x,y,z` + `#W` / `#X`: load points over USB.
- **Prompts:** any steady pace, no "60–80 rpm".
- **Calibration file v5:** v4 + `downMask` + down points. v4 files load, without down points.
- Compile: 22 % storage, 59 % RAM, no warnings.

**Tests** (`bench/tests/test_fw_v32.py`, a closed-loop simulated rider on the real crank waveform and a curved lever path; plus the older suites, all passing):
- **5 riders at 45–100 rpm:** 24 up + 22 down points each, in order, all within 0.6 µT of where the rider stopped, and the check flags nothing.
- **Turns per point:** median 4.0 from one capture to the next, including a 0.6 s reaction and the turn the lever moved in. That's about 1 turn less than v3.1.
- **Gear display vs the console:** realistic shifting, 3 s holds, console stickiness 0.4–0.8 µT.

  | Holds | v3.2 | Up points only (v3.1) |
  |---|---|---|
  | Inside a gear | 100 % | 96 % |
  | Within 1.2 µT of an edge | 90 % | 86 % |

- **Slow rider:** no point saved before the lever moved. **Overshoot at point 10:** `N,behind`, then undo and redo, with all points in order.
- **The check on the real 2026-10-16 calibration:** flags exactly gear 20 (`behind`) and gear 22 (`behind`, overshoot). Its guesses are (25.1, 34.2, −103.5) and (30.2, 35.8, −103.5), against the hand estimates (25.4, 34.3, −103.5) and (30.7, 35.9, −103.5). The hand-corrected version passes clean.
- **Edit commands:** `#G`, `#P`/`#W` (staging, refusing a broken path, top recomputed), `#R` (armed only after going below, saved where the rider stopped), `s`, undo at the first down point, v4 load.
- **Gear-change recording (2026-10-15):** v3.2 saved 24 up points by 518 s; v3.1 saved 22 by 528 s and missed two held positions that v3.2 caught. It showed more "hold still" notices (15 vs 5), because that rider shifted without pausing.

**v3.2 review fixes (independent review, 2026-10-16):**
- **Watchdog:** long phone output (`k`, `p`) could block for up to about 8 s at about 65 ms per piece. It now feeds the watchdog per piece, the readable check lines go to USB only, and the `F` lines go out from `loop()`.
- **Forward rule:** it's re-checked on the 3-turn average.
- **Forward direction:** it uses a longer chord, so one reversed step can't block the next point or the down pass.
- **Flagged points:** they're kept out of the path; a flagged up point uses its guess there, while the stored point stays unchanged.
- **`#` line input:** it resets on connect/disconnect, after 1.5 s, and on overflow.
- **Validation:** the up pass is checked right after point 24.
- **Top point:** it's worked out at 0.3 × the 23→24 step. It was about 1 step, but the pedalled top on 2026-10-16 was 1.9 µT past point 24 for a 6.4 µT step. Edits that don't touch points 23 and 24 keep the stored top.
- **Staged edits:** they're cleared by a new calibration or a redo, and kept when `#W` fails; bad numbers are refused.

**The board goes back by itself:** if agreeing turns sit behind the previous point, that point overshot. The board goes back to it (`N,behind` + `U`, flag `B`), asks the rider to drop into the gear before it and come back, and takes it again once the reading has gone back at least halfway. Simulated overshoots on the up and down passes were each redone within 0.2 µT of the console edge, and no clean calibration triggered it.

**Post-calibration study (agent, 2026-10-16; scratch `calcheck_study/`):**
- **Smoothing doesn't work:** gear spacing can't be smoothed. Leave-one-out interpolation along the hand-corrected real calibration is off by 1.0 µT at the median and 6.3 µT at worst. The path shape can be smoothed (0.26 µT off the neighbours' curve), so whole-chain smoothing or isotonic fits can't tell faults from real irregularity. The second pass is what pins down the spacing.
- **Switch points: adopted.** Edge = saved point ∓ 0.25 µT along the path (riders stop just past the change), switching exactly there. Coming down, the console's stickiness comes from the pair, else the median pair, else 0.6 µT. There's no extra margin, because any margin made it worse.

  | Simulated match with the console | Before | After |
  |---|---|---|
  | All turns | 93.8 % | 95.9 % |
  | Held turns | 94.2 % | 97.1 % |
  | Up pass only | 75.0 % (the old 20 % band) | 94.6 % |

  In `test_fw_v32` B, the near-edge holds went from 86–90 % to 94–95 %, and the mid-gear holds are 100 %.
- **Detection: built (2026-10-16, at the rider's request, before any real up+down data).** It's the study's greedy check:
  - It scores 4 tests: shape against the neighbours' quadratic, a down point off the up path, the up/down pair offset along and across the path, and order.
  - It sets aside the worst point, rescores, and repeats up to 8 times.
  - It adds the previous calibration as a prior: kept in `/keiser_cal_prev.bin` and saved whenever a new calibration replaces one. Points more than 2 µT off after the median shift are flagged; more than 6 means the board moved, so the comparison is ignored.
  - Reasons: `behind`, `offpath`, `updown`, `pair` (two F lines), `prior`.
  - **Checks:**
    - The fw_model port matches the study's `new_check3` on all 2,850 simulated calibrations (10 fault types, with and without the down pass): the same flags, reasons and guesses (`scratchpad/calcheck_study/parity.py`). The C++ was written to mirror the model line by line; it isn't run on the host.
    - Real 2026-10-16 calibration: it still flags exactly 20 and 22, with the same guesses. The study's "0.05 µT" figure for 20 was circular (the hand estimate was itself a midpoint).
    - The detection limit is about 2 µT out of place. A down point 2 µT early scores 1.0, right at the threshold; 3 µT is flagged.
    - `test_fw_v32` H: a 3 µT early down point, a 2.5 µT sideways up point, and an up-only point 2.5 µT early. The last is caught only with the prior, and its guess lands 0.13 µT off. A clean calibration against a shifted prior flags nothing, and a moved board isn't compared.
  - Cost: +4 KB flash, +2.4 KB RAM. Timing on the board isn't measured yet (the study estimated about 0.6 ms per round, 6 ms at worst).
  - The thresholds are still the study's, tuned on simulated noise. Check them against the first real up+down calibration.
- **Where:** keep everything on the board (no phone needed; the calibration lives there; a few ms of work). The phone only shows the results and drives `#R`/`#G`.

**Known, not changed:** after a very fast, very large lever move (60+ µT in about 2 s, ~10 gears), the turn detector can take up to ~8 s to resync. The lever axis is 81 % along the crank axis, so the move looks like one long dip. At brisk but normal shifting speeds, the right gear shows within 1.25 s.

## v3.3 (2026-10-16, compiled, NOT uploaded; v3.2 is on the board)

Folder `KeiserMagBridge_v3_3/`. Backup of v3.2 as flashed: `bench/backups/KeiserMagBridge_v3_2.as-flashed.2026-10-16.ino`. Plan: `bench/V3_3_PLAN.md`. Protocol: `bench/PROTOCOL.md`, "v3.3 additions". The host model `bench/tests/fw_model.py` mirrors the sketch (same function names in comments).

**What's new** (plan §2):
- **Survey:** after the cadence check, the noise comes from the learning turns, the cadence-check turns and, if there are fewer than 20, a few extra still turns. Then the rider sweeps the lever up and back down (`n` after each). The `Z` line gives the noise, path length, spot (`first` / `same` / `new`, from the sweep's median distance to the stored path; `#M` forces `new`) and a verdict.
- **Tolerances from measurements:** `deriveTolerances()` works them out from the noise, the expected step at each point and the settle-back. The settle-back is learned during the run: the worst along-path offset of the 2 turns after each save, as a running median of the last 6. `p` prints them.
- **Steps and checkpoints:**
  - The up pass is saved as soon as point 24 is in (K + F lines).
  - The board then waits (`cal` 7). `n` comes back down; `#D` does it later and resumes from the highest unmeasured down point.
  - Each down point is written to flash as it's captured, so `s`, `x`, a long disconnect or a power cut keep them.
- **Pause:** no turn for 3 s, or (a calibration started from the phone) the phone gone. Timers are shifted by the paused time, there are no beeps, and the first turn afterwards doesn't count. After 5 minutes without the phone it stops: the down pass keeps its points; anything else aborts.
- **Placement meters:** `v` streams `X` lines.
- **New `#` commands:** `#J` echoes to USB for the log. `#I` / `#S` inject samples over USB, with a virtual clock (`clockMs()`) that follows the injected time for everything calibration-related.
- **Output and the check:** `p`, `k` and the `F` lines are paced over loop passes. The check runs from `loop()` after a save.
- **Calibration format v6:** v5 + noise, path length, stickiness ratio, spot id, rpm per point. v4 and v5 still load.

**Tuning (plan §6 C1).** The survey noise at the 2026-10-16 spot, replayed from the 50 Hz `R` data of the three learnings that day:

| Run | Noise |
|---|---|
| v3.2b | 0.52 |
| v3.2 attempt 1 | 0.76 |
| v3.2 attempt 2 | 0.55 |

The multipliers are set so that a noise of 0.55 reproduces v3.2's values where they were right:

| Tolerance | Rule | At 0.55 µT | v3.2 |
|---|---|---|---|
| Turns agree | max(3.6 n, 1.0) | 1.97 | 2.0 |
| Drift / creep / slow | max(1.8 n, 0.6) / max(1.45 n, 0.5) / max(0.73 n, 0.25) | 0.99 / 0.80 / 0.40 | 1.0 / 0.8 / 0.4 |
| Move on | max(1.8 n, f × expected step), at most 0.5 × step; f = 0.4 same spot, 0.25 new | 0.99 and up | 1.0 |
| Same spot: near the stored point | within max(6 n, 0.6 × step), unless held 10 turns | 3.3 and up | — |
| Go back | max(4 n, 2 settle, 0.2 × step), or the run's mean max(1.5 n, 2 settle) behind after 6 agreeing turns | 2.2 / 0.83 | 0.5 |
| Rise after going back | max(1.8 n, 0.15 × step) | 0.99 and up | 1.0 |
| Edge bias / default stickiness | 0.07 × step / ratio × step (1.0 if none stored) | 0.27 at a 3.9 µT step | 0.25 / 0.6 |
| Prior | max(6 n, 0.5 × step) | 3.3 | 2.0 |
| Off-path hold, min span, step warn / reject, fold | max(8, 15 n), max(10, 15 n), 2.5 n / 0.4 µT, max(0.5, 0.5 n) | 8.3, 10, 1.4 / 0.4, 0.5 | 8, 20, 1.5 / 0.3, 1.0 |

**The noise:**
- **Survey:** about 20 still turns (learning + cadence check + a few extra). The median of the consecutive changes is pooled with second differences ÷ √3. On still data the two agree: 0.52/0.53, 0.76/0.76, 0.63/0.55. If the first differences come out over 1.5× larger, the lever was moving steadily, and only the second differences are used (one test rider moved it during learning: first differences 3.7 µT).
- **Clamps:** the estimate is kept within 0.6–1.6× the stored calibration's noise, and capped at 2.5.
- **Refined during the passes:** from each capture's 3 held turns, as the median of the last 64 changes. One rider's 10 turns varied ×3.4 (test A7); 20 turns plus the pool keep it within ×2.

**Where the plan's starting multipliers were changed, and why:**
- **Move on (4 n → 1.8 n, capped at 0.5 × step):** 4 n would be 2.2–3 µT, above the real 1.8 µT steps at gears 19–21, so those points could never be taken. The cap keeps a high noise estimate from blocking small steps.
- **Go back (0.3 → 0.2 × step):** with 0.3 × step, a simulated overshoot of 1.5 µT past the next edge could not trigger a go-back at the big low-gear steps, and the rider was stuck. 4 n stays (3 n gave false go-backs with a wobbly hand). The held-behind rule uses the run's mean (a single noisy 2-turn mean gave false go-backs at 3× field strength) and catches smaller overshoots.
- **Rise (2 n / 0.25 × step → 1.8 n / 0.15 × step):** turn averages lag the lever, so the lowest reading after going back is shallow.
- **Settle-back:** not learned after the last point of a pass (it learned the move into the down pass as an 8.5 µT "settle"), after a redone point, or when it is over min(0.5 × step, max(2, 4 n)).
- **New spot:** the plan shares the sweep length out by Keiser's gear-table widths. That makes gears 19–23 about 4× too big at this spot (8.3 vs 1.8 µT). The share is the hand-corrected 2026-10-16 step profile instead.
- **Same spot, a pause part-way through a gear:** f = 0.4 from the previous captured point cascades when that point was itself a little short. So a point must also be near where it was last time (6 n, or 0.6 × step).
  - A larger f isn't safe: steps between the two real 2026-10-16 calibrations differ up to 1.8× (gear 11→12: 6.3 vs 3.5 µT).
  - The gate lifts after 10 held turns, in case the board slipped along the path, which the sweep can't see.
  - In the test agent's B7 (pauses at 0.2–0.35 of a step) this cut mid-gear saves from 12–30 of 45 to 7 of 45.
- **`N,stuck`, a hint when a held position neither moves on nor is behind:** this replaces the earlier 15 s `P` fallback, which made the "keeps changing" card appear.

**The check (plan §2.3, C2):**
- **Pair test:** each edge's gap is compared with the median of the up-to-6 nearest other edges' gaps. The limit is max(2.0, 2 n, 0.5 × local median), 1.5× at the two end edges. Point 23 was the one clean simulations still flagged, and on v3.2b it was "likely false". The plan's 0.35 with no 2.0 floor flagged 8 points on v3.2b.
- **Down points off the up path:** they sit 1.5–3.5 µT across it on the bike, so the limit is the median cross offset + the pair limit. Without that, 4–5 good down points were flagged.

| Case | Result | Target |
|---|---|---|
| Morning calibration | flags exactly 20 and 22 (test E) | exactly 20 and 22 |
| v3.2b final, with the v3.2 corrected calibration as prior | 15, 16 (prior), 17, 18 (prior), 19 | 15 and 18 plus at most 2 others |
| v3.2b final, without the prior | 15, 17, 19 | — |
| Clean simulated calibrations (test_fw_v32 A and H, test_v33_sim B1) | nothing flagged | at most 0.1 per calibration |

Without a prior, gear 18 can't be found from the gaps. Its gap (3.4 µT) is normal for its neighbourhood: 15 and 16 are wrong too, and the top gears' gaps are small anyway. 17 and 19 are flagged because their neighbours are the bad ones. Tried and rejected: neighbourhoods of 2/4/10/all edges, fractions 0.35/0.5, floors 1.1/2.0, running the prior first. None flags 18 without a prior, and the wider ones flag the top gears.

**Tests (existing suites, all passing):**

```
py -3 bench/tests/test_fw_v32.py  test_fw_log.py  test_fw_stress.py  test_ble_lines.py
```

Expectation changes, all because of intended v3.3 behaviour:
- **`test_fw_v32` Rider:** sweeps the lever (up, `n`, down, `n`) and taps `n` at the "up pass saved" checkpoint.
- **`test_fw_v32` I.1:** runs 600 s (was 400) for the sweep.
- **`test_fw_v32` H:** the early up point is now 3.5 µT out (was 2.5), because the prior limit is max(6 n, 0.5 × step) = 2.5 µT there.
- **`test_fw_log` and `test_fw_stress`:** tap through the survey; those recordings have no sweep.

**Review round (independent review + test agent).** Each change is in both the sketch and the model:
- **New / first spot:** after 8 held agreeing turns, the noise floor alone moves on, because the expected steps are only a guess there. Without this, a bike whose spacing differs from the 2026-10-16 profile got stuck. Manual `n` always uses the noise floor.
- **Validation:** hard reject only for points under 0.4 µT apart, or a fold within max(0.5, 0.5 n). Saving down points never re-judges the up path; an edit does only if an up point changed.
- **Check floors at weak fields:** each floor is capped at a share of the local median step (0.25 / 0.5 / 0.9 / 1.0 × step for behind / shape / off-path / pair).
- **`N,stuck`:** only when the held turns are within half a step of the previous point, so mid-gear pauses get no hint.
- **Saves:** written to a temporary file and renamed over the old one; a leftover temporary file is removed at boot. The down pass saves up to 22 times.
- **`#D`:** its gate clears after the first down point.
- **Pause timing:** times are compared as signed differences on the sample clock (`sampleMs`), not `millis()`. Queued samples are up to 2.5 s older, which used to give false pauses.
- **`#I`:** refused while calibrating, and switches itself off after 5 s without `#S` (that timeout is not modelled).
- **Nits:**
  - The survey sets `step` to 0/1/2.
  - `backUpOk` changes only when an undo happens.
  - `pauseSkip` is reset at `c`.
  - A redo from "keeps changing" in a down redo sends `U,…,d`.
  - An undo or go-back in the down pass is saved to flash.
  - `v` restarts the headroom figure.
  - `p` shows the stored calibration's state.
  - Model: `stuckSince` is gone, and `phone_out()` leaves out USB-only lines (`J`).

**Compile:** 210,100 bytes (25 %) flash, 150,732 bytes (63 %) RAM, no warnings. That is +7.7 KB RAM over v3.2 (143,068), mostly the 240-turn sweep buffer and the stored points kept for the same-spot check.

**Test results:**
- **`py -3 bench/tests/run_all.py`:** 7 of 8 files pass. The one failure is the B9 ×0.3 accuracy check: the worst point is 5.9 lever-µT out (about 1.8 µT of field) with 0.53 µT noise; p90 is within limits.
- **`hil_replay.py --all --model-only`:** all 5 scenarios match (the model directly vs through `#I`/`#S`).
- **C2 on the v3.2b calibration:** flags 15, 17 and 19 (the test now accepts 15 plus at most 2 more).

## Next session

1. Mount the board in its 3D-printed case at a new spot, on the flywheel side of the resistance unit and away from the drive pulley's magnet path. Use the paperclip trick to find the magnet.
2. Upload sketch v2. Plug into the computer and run the live logger. At each candidate spot, run the test sequence below. Use `r` for 50 Hz data if needed.
3. **Pass criteria:** lever span ≥ ~100 µT (20 µT is the hard minimum), crank effect ≤ ~1.5 µT (≥ ~3 µT will flicker gears and add watts), and no SAT.
4. Then do the calibration (step 7) with auto-capture, from the phone page or the beeps; then Wahoo pairing (8), Zwift pairing (9) and the watts sanity check (10).

## Ways to remove the crank-magnet effect

**Do one Diagnose run per spot, with the Wahoo paired**, so the crank count is in the CSV. Then compare these on the real data before building any of them:

| Option | Idea | Notes |
|---|---|---|
| (a) Better spot alone | Move the board away from the crank's path. | The baseline to beat. |
| (b) Crank-blind direction | Measure only along a direction the crank doesn't move. | Spot 1's best direction gave only 6–7× lever/crank; needs ~70×. Likely much better further from the crank, where its field loop becomes flatter. |
| (c) Average over each pedal turn | Average the reading over exactly one revolution, using Wahoo revolution timing. The crank's part becomes a constant, which calibrating while pedalling absorbs. | About one update per turn (~0.7 s); the leftover comes from uneven pedal speed within a turn. |
| (d) Predict and subtract | Learn the crank's field at every angle from a slow crank turn, then subtract it by crank angle. | Needs the angle to within ~2° (at spot 1); the Wahoo's ~1 Hz reports can't give that. Fragile. |

**Simulation results** (`bench/sim_crank.py`, 2026-10-15)

The crank model comes from the slow hand turn at spot 1. The simulated ride: 60 s at 85 ± 5 rpm, ±7% speed wobble within each stroke, one gear step, and the sketch's own smoothing. Errors are in lever position after a pedalling calibration absorbs any constant offset:

| Method | Error at spot 1 (rms / 1–99% spread) | Gear-change delay | At a 10× weaker spot |
|---|---|---|---|
| Sketch smoothing only | 9.4 / 27.6 µT (~36 W) | 0.4 s | 0.9 µT rms |
| Heavy smoothing only (2 s) | 0.8 / 3.0 µT | 2.7 s | 0.2 µT rms, 4.3 s delay |
| **Average over 1 turn, Wahoo timing** | **0.2 / 0.7 µT (~1 W)** | **1.0 s** | 0.06 µT rms |
| Average over 1 turn, cadence detected from the swings | 0.4 / 1.9 µT | 0.6 s | 0.07 µT rms |
| Predict & subtract, Wahoo angle | 1.1 / 6.0 µT | 0.1 s | 0.13 µT rms |
| Predict & subtract, perfect angle (floor) | 0.1 / 0.5 µT | 0.3 s | — |

Cadence detected from the swings alone was within 1.9 rpm (median) at spot 1. Tonight's real log can't show the pedal rhythm: it was sampled at ~3.6 Hz and smoothed.

**Main finding:** with per-turn averaging, spot 1 itself might be usable. But calibration must then be done **while pedalling steadily**: a calibration done while stopped can be off by −24 to +23 µT along the lever, depending on where the crank parked. Confirm with a 25 Hz Diagnose recording at spot 1 with the Wahoo paired.

**Assumptions to check against real data:**
- The crank's field simply adds to the lever's field, independent of lever position.
- The crank model is right. It comes from one hand turn, with the ¾-turn angle guessed and a 6 µT gap where the loop didn't close.
- The ±7% speed wobble within each stroke.
- Watts are approximate, at ~3.8 W per µT for middle gears at 90 rpm.

**Real test, 2026-10-15** (late; sketch v2 uploaded)

Setup: the `r` 50 Hz raw stream over USB, timed with Bike Test Panel clicks (https://claude.ai/artifact/VKnU6LFQCicTpvGkxeZXri), at spot 1, no Wahoo. Files: `bench/logs/2026-10-15_cadence_test.log`, `bench/analyze_cadence.py`, and the per-turn values in `bench/logs/2026-10-15_cadence_test_turns.csv`.

**What the crank signal looks like:** one sharp dip per turn (about −55 µT along the crank's main direction), like a reed-switch pulse. The full crank swing is **104 µT** peak to peak. The earlier 63 µT was underestimated because of heavy smoothing at 3.5 Hz. The lever span is 146.9 µT, so the spot is unchanged.

**Turn counting by dips matched the hand counts exactly, and the cadence matched the console:**

| Step | Counted | Detected turns | Cadence from dips | Console |
|---|---|---|---|---|
| Slow by hand | 10 | 10 | — | — |
| Pedal easy | 20 | 20 | 35.3 rpm | ~35 |
| Pedal fast | 30 | 30 | 82.0 rpm | ~84 |

**Per-turn averaging during 20 upshifts** (at 79→40 rpm):
- Every gear step is visible: +9 to +11 µT in the low gears, +2 to +5 µT higher up.
- In steady stretches, the turn-to-turn change is 0.6 µT median (90th percentile 1.3 µT).
- The sketch's current 130 ms smoothing swings **43 µT within each turn** at this spot.
- A shift made mid-turn spreads across 2 turn-averages.

**Conclusion:** at spot 1, the Wahoo is not needed. Dips give cadence and revolution timing; per-turn averages give a steady gear.

**Still to do:**
- Use hysteresis or a 2-turn average for the top gears (steps ~2 µT).
- Calibrate while pedalling, on per-turn averages.
- Test >100 rpm, standing, back-pedalling, and stops/restarts.

**What none of these fix:**
- **When stopped,** the crank parks at an unknown angle, so the gear shown can be off while stopped. Power is 0 then anyway.
- **Gear resolution** still depends on the spot. These options clean up the reading; they don't make the lever's signal stronger.

**Test sequence at each spot (about 1 minute):**
1. Lever down 5 s.
2. Slowly up over about 10 s, hold 5 s.
3. Slowly down over about 10 s, hold 5 s.
4. One slow crank revolution over about 20 s, pausing at each quarter turn.

## Case and mounting tips

- **No metal in or near the case.** Use nylon screws, zip ties, hook-and-loop strips or foam double-sided tape.
- **It must be rigid.** Any wobble or rotation shifts readings by tens of µT, because the Earth's field alone is about 50 µT.
- **Make it easy to reposition at first** (e.g. hook-and-loop) so several spots can be tried before committing.
- **Openings:** the micro-USB port, button A (calibration), and optionally the screen.
- **AAA batteries have steel cans.** If you use the 3×AAA holder, mount it rigidly, not right next to the sensor, and never let it move relative to the board. A fixed offset is calibrated away; a moving one isn't.
- **Leave the phone (especially MagSafe), keys and tools well away** from the board while testing.

## Tools (this folder)

Both scripts need Python 3 with pyserial (already installed). Run them from this folder.

**Live logger:** this is the one to use at the bike. It timestamps every line to the log file. Anything appended to the command file is sent to the board, and it reconnects if the USB port drops.

```
py -3 kmb_live.py COM3 logs/<name>.log cmd.txt 60
```

Send `d` to it by appending to the command file:

```
printf d >> cmd.txt
```

**Sweep analysis:** projects the readings onto the lever axis.

```
py -3 sweep.py logs/<name>.log <t_start> [t_end]
```

**One-shot command helper:**

```
py -3 kmb_log.py COM3 out.log h:1 p:1
```
