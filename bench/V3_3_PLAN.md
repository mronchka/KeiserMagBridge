# v3.3 plan: issues, design, protocol, tests

Written 2026-10-16 after the first v3.2 bike runs (`bench/logs/2026-10-16_v3_2.log` has two aborted attempts; `..._v3_2b.log` has the full up-and-down run with the 50 Hz raw `R` stream and the per-turn `T` stream). The calibration report is https://claude.ai/artifact/FMUNUwBd9LDojKbS8xZ2rc. Before changing anything, read `bench/NOTES.md` (the v3.2 sections) and `bench/PROTOCOL.md` (the "v3.2 additions").

The baseline is `KeiserMagBridge_v3_2/KeiserMagBridge_v3_2.ino` as flashed now. It includes two bike fixes that are not committed yet: the stale `behindNow`, and the go-back cascade with its "rise" gate. v3.3 lives in `KeiserMagBridge_v3_3/`. Back up v3.2 to `bench/backups/` first.

## 1. Every open issue, and where v3.3 deals with it

| # | Issue (source) | v3.3 |
|---|---|---|
| 1 | About 20 tolerances are fixed µT values tuned at one mounting spot (user) | §2.1 survey + §2.2 tolerances worked out from measurements |
| 2 | Automatic go-back fired 12×, 11 of them the lever settling 0.1–0.8 µT (trigger 0.5 µT) (v3.2b run) | §2.2 `behind` = larger of 4×noise, 2×settle and 0.3×step; settle is learned during the run |
| 3 | Gear 15 saved 3.4 s after the prompt, while 1.2–1.5 µT from gear 14: lever drift, not a shift (v3.2b, user) | §2.2 must move at least the larger of 0.4×expected step and 4×noise (0.25×step at a new spot) |
| 4 | The hold-still give-up timer ran while the rider rested, then buzzed (user) | §2.5 pause: timers count pedalling time only; no beeps while paused |
| 5 | 28 hold-still notices vs 4 on v3.1 (v3.2b) | §2.2 drift/creep limits from noise; §6 C3 tests whether one extra settling turn saves time |
| 6 | The check flagged 11 points; it expected one up/down gap for all gears, but on the bike the gap runs 0.7–9.4 µT (median 6.2 µT ≈ 1.0× the local step) (v3.2b) | §2.3 the pair test compares each gap with its neighbours' (local median, ±3 edges) |
| 7 | The previous-calibration check was skipped ("board moved?"): the board slipped about 1.2 µT, and gears spread about 2 µT between runs (v3.2b) | §2.1 move detection from the survey sweep; §2.3 prior limit = larger of 4×noise and 0.5×local step, after aligning |
| 8 | Default console stickiness 0.6 µT; measured 6 µT, about 1× the local step (v3.2b) | §2.2 stickiness from the last down pass at the same spot, else 1.0×local step |
| 9 | Phone dropped (iOS auto-lock, code 0x13); the board kept calibrating and saved gear 4 blind (v3.2 attempt 1) | §2.5 a calibration started from the phone pauses while the phone is disconnected; app keeps the screen awake and shows an Auto-Lock tip |
| 10 | Too much in one go: wants checkpoints, rest without losing progress (user) | §2.4 steps, each saved; the down pass and gear check can resume later |
| 11 | "Shift down to 16 then up to 17" was confusing (user) | §3 the circle shows the gear to be in now: 16 → green → 17 |
| 12 | App: the guided redo of flagged gears never started (no `#R` reached the board) (v3.2b) | §3 bug fix + a test that drives the app's parser with real board lines |
| 13 | App: down-pass dots stayed green (user) | §3 bug fix + test |
| 14 | App: gear check never offered after the down pass (user) | §3 the gear check is a calibration step |
| 15 | App stuck-hint names the wrong gear at the first down point (app agent) | §3 |
| 16 | Unclear whether stop–shift–pedal is allowed (user) | §2.5 + §3: yes, said on screen |
| 17 | Cadence guide: the same for every rider, sliding window, 30 rpm fine at the top (user) | §3, numbers in one table |
| 18 | Calibration should be one flow of numbered steps, with a breadcrumb and no step names like "survey" (user) | §3 |
| 19 | Signal meters before calibrating: lever swing, crank dip, headroom, modern look (user) | §2.6 placement stream + §3 first step |
| 20 | `k`/`p` over BLE can take 6–8 s; the watchdog is fed, but the 2.5 s sample queue overflows (v3.2 review) | §2.7 Q/F/p output paced over loop passes |
| 21 | The check runs deep in the 50 Hz path (study) | §2.7 run it from `loop()` after a save (a flag), not from inside `calCommit` |
| 22 | Model gaps: `#` line input, binary v4/v5 load, flags B/M, BLE timing and float32 aren't modelled (v3.2 review) | §6 D (board-in-the-loop replay), plus model tests for line input and load |
| 23 | Phase 2 needs each point's capture cadence (future cadence correction) | §2.8 calibration v6 stores rpm per point, noise, step scale and stickiness ratio |
| 24 | Gear-check results stay on the phone; I can't analyse them (report) | §2.6 `#J,...` → board echoes `J,...` to USB for the log |
| 25 | After a very fast 10-gear lever flick, the turn detector takes up to ~8 s to resync (known) | Not changed; §6 B11 documents how long it takes |
| 26 | Not committed: v3.2 bike fixes and the app wording for new reasons | Ask the user before committing |
| 27 | Cadence correction | Phase 2, after a clean v3.3 run (not in v3.3) |

## 2. Firmware design

### 2.1 Survey (part of the calibration flow, not a separate name for the rider)
After the cadence check (`n`) and before point 1:
1. **Noise**: measured from the crank-learning turns (lever still), plus 4 extra turns if learning ended early. `noiseUT` = median |Δ| between consecutive turn averages (3-D), floored at 0.15 µT. Today, at held points, this is about 0.8 µT; during learning, with nothing settling, expect less.
2. **Sweep up**: "Pedal and slowly push the lever up as far as you can still pedal, then tap Next" (`n` / button A). Every turn average is kept, up to 120 turns.
3. **Sweep down**: "Slowly back down to the bottom, then tap Next".
4. **Survey result** (`Z` line, §5):
   - path length L: chained distance along the turn averages, lightly de-noised by dropping points closer than 2×noise to the previous one;
   - signal checks: saturation, L under 15×noise means too weak, the path folding back;
   - move detection, if a calibration exists: the sweep turns' median distance from the stored path. Under the larger of 1.5 µT and 3×noise → same spot (`spot=same`); otherwise `spot=new`. A user command (`#M`, "I moved the board") forces new;
   - expected step per gear: same spot → the stored calibration's steps; new spot → L shared out by Keiser's gear-table widths.

The sweeps need no prompts per gear and take about 30–40 s.

### 2.2 Tolerances worked out from noise, step and settle
Use one function `deriveTolerances()`, called after the survey and on load, and keep the numbers in a struct that is printed with `p`.

Starting multipliers (the test agent tunes them on the logs, §6 C1):

| Tolerance | v3.2 fixed | v3.3 |
|---|---|---|
| Turns agree | 2.0 | max(2.5×noise, 1.0) |
| Still moving: drift / creep / slow | 1.0 / 0.8 / 0.4 | 1.2× / 1.0× / 0.5× noise (floors 0.6 / 0.5 / 0.25) |
| Must move on (distance) | 1.0 | max(4×noise, f×expected step g), f = 0.4 same spot, 0.25 new spot |
| ...along the pass direction | 0.5 | half of the above |
| Behind (go back) | 0.5 | max(4×noise, 2×settle, 0.3×local step) |
| Rise after going back | 1.0 | max(2×noise, 0.25×local step) |
| Edge bias (rider stops past the change) | 0.25 | 0.07×local step |
| Stickiness default | 0.6 | stored ratio (from the last down pass at this spot) × local step, else 1.0×local step |
| Check: order / shape / off / pair / perp | 0.5 / 1.0+0.12c / 1.8 / 1.1+0.15s / 1.8 | multiples of noise and local step: tune so the 2026-10-16 cases pass (§6 C2) |
| Prior | 2.0 | max(4×noise, 0.5×local step), after a translation-only alignment |
| Off-path hold | 8.0 | max(8, 15×noise) |
| Min span / step warn / step reject / fold | 20 / 1.5 / 0.3 / 1.0 | 15×noise / 3×noise / 1.0×noise / max(1.0, 1.5×noise) |

- **Settle:** learned during the run. After each save, take the along-path offset of the next 2 turns, and keep a running median of the last 6 saves, starting at 1.0×noise.
- **Ratios stay as they are:** 2+check, the top at 0.3 of the 23→24 step, and the check's 8 rounds.

### 2.3 Check changes
- **Pair test:** each edge's along-path gap s is compared with the median of the up-to-6 nearest other edges' gaps. The limit is max(2×noise, 0.35×that local median). Across the path, q is compared the same way, against max(2×noise, 0.35×median q).
- **Prior:** translation alignment as now, with the limit from §2.2. Ignore the prior when the survey said `spot=new`.
- **Acceptance (C2):**
  - the morning calibration flags exactly 20 and 22;
  - the v3.2b final calibration flags 15 and 18 plus no more than 2 others;
  - clean simulated calibrations flag no more than 0.1 per calibration.

### 2.4 Steps and checkpoints
A calibration is one flow. The board reports the step number; the rider doesn't see internal names.
1. Placement (live meters; nothing saved; the rider taps Next in the app; the board just streams `X` lines)
2. Crank (learning + cadence confirm + noise)
3. Sweep (up and down)
4. Up pass (points 1–24). **Saved when finished**, usable straight away (K + F lines).
5. Down pass (points 23..2). Starts on `n`/Next after step 4, or later with `#D`. Each captured down point is kept; on `s`, `x`, a disconnect pause timeout or power loss, the down points so far are committed (partial mask).
6. Gear check (the app drives it; results logged with `#J`)

Status `S` gets field 15, `step` (1–6, 0 when idle), and field 16, `steps` (6). Fields 13/14 stay as they are.

### 2.5 Pause
- **When:** no pedal turn for `CADENCE_TIMEOUT_MS` during steps 2–5 → paused (flag `O`).
- **While paused:**
  - give-up timers freeze (shift `settleSince` and any timer by the paused time);
  - no beeps;
  - turn history is cleared when pedalling resumes, so the first turn after a pause never counts towards agreement.
- **Phone disconnects:** if the calibration was started over BLE and the phone disconnects, the calibration pauses (flag `O`, human line) until the phone reconnects. A calibration started from USB or the button doesn't pause.

### 2.6 New lines and commands (see §5)
- **`v`:** toggles the placement stream, `X` lines at 4 Hz.
- **`#M`:** board moved; forget the stored path for move detection and the prior.
- **`#D`:** start (or resume) the down pass on an existing calibration.
- **`#J,<text>`:** echo `J,<text>` (for logging gear-check results).

### 2.7 Output and timing
- **Paced output:** `k` Q/F lines and `p` lines are queued and sent a few per loop pass, as the recording dump is.
- **Check timing:** the check computes once after a save, from `loop()` (flag), then prints F lines.

### 2.8 Calibration v6
v5 + `noiseUT`, `stepScale` (L), `stickRatio`, `capRpm[25]` (uint8), `downRpm[25]` (uint8), and `spotId`, a 32-bit hash of the path for move detection. v4 and v5 still load; the missing fields get defaults and are derived.

## 3. App (`webapp/index.html`, `README.md`)
- **One flow:** calibration is a numbered flow with a breadcrumb at the top ("Step 3 of 6" plus 6 small segments, done = filled). No phase names in titles: each step's title is an instruction ("Find a good spot", "Learn your pedalling", "Sweep the lever", "Up through the gears", "Back down through the gears", "Check a few gears").
- **Step 1, placement:** three meters: lever swing as a big arc gauge, crank dip and headroom as capsule bars. Weak/good/great zones and a verdict card, then "Next". Use the theme tokens.
- **Where the rider should be:** the big circle always shows the gear the rider should be in now. During a go-back or redo it shows the gear below or above first, turns green when the flag `B` clears, then switches to the target gear.
- **Pause:** "Paused — pedal to continue" when `O` is set. A "You can stop any time" note on the gear steps. No alarm styling while paused.
- **Checkpoints:** after step 4, a "Saved" card with "Continue down" / "Later". The Calibrate start screen offers to resume the down pass or the gear check when they aren't done.
- **Fixes:** guided redo start, down-pass dots, the stuck hint's gear at the first down point, and the gear check as step 6, with results sent as `#J,check,<gear_shown>,<gear_console>,<rpm>`.
- **Cadence guide:** a sliding green window from one table: gears 1–10 → 60–90 rpm, sliding linearly to 30–55 at gear 24. Red only below 30 / above 120.
- **Screen:** keep the screen awake (Wake Lock where supported) and show an Auto-Lock tip on step 1 on iOS.
- **Simulator:** covers all of the above (placement, survey, steps, pause, resume, `#D`, `#J`).

## 4. Not in v3.3
- Cadence correction (phase 2).
- Standing detection.
- Changing the turn detector's resync after huge flicks.

## 5. Protocol additions (to be copied into `bench/PROTOCOL.md` by the firmware agent)
```
S,...,<pass>,<step>,<steps>        fields 15/16 (v3.3); flag O = paused
X,<fieldMag>,<swing>,<dip>,<headroomPct>,<noise>   placement stream ('v'), 4 Hz, uT except headroom
Z,<noise>,<pathLen>,<spot>,<offMedian>,<verdict>    survey result; spot = same|new|first; verdict = ok|weak|saturated|folded
J,<text>                            echo of #J
E,ok|fail,...                       as v3.2 (also for #M, #D)
```
- **`X` fields:**
  - `swing` is the range covered since `v` was switched on (it resets each time `v` is turned on);
  - `dip` is the last turn's crank dip depth (or the peak-to-peak of a 1 s high-passed window before the crank is learned);
  - `headroomPct` is 100×(1 − max |raw axis| / saturation).
- **Breadcrumb:** the app reads `step` / `steps` from `S`.

## 6. Test plan
All new tests go in `bench/tests/`. Each prints PASS/FAIL lines and exits 1 on failure. A runner, `bench/tests/run_all.py`, runs everything and summarises.

**A. Unit (model)**
- **A1, `deriveTolerances`:** given noise/steps → expected values; the floors work.
- **A2, survey maths:** path length, de-noising, move detection (same / shifted 1 µT / moved), on recorded and synthetic sweeps.
- **A3, `#` line parser:**
  - fragments across 20-byte writes, `\r\n`, overflow, timeout, a `#` arriving mid-command;
  - bad numbers;
  - `#M`, `#D`, `#J`.
- **A4, calibration file load:** v4, v5 and v6 byte layouts round-trip (pack them with `struct` exactly as the C struct, using sizes from `static_assert`s in the sketch).
- **A5, pause bookkeeping:** timers freeze; the first turn after a pause doesn't count.

**B. Closed-loop simulated riders** (extend `test_fw_v32.py` Sim/Rider/Console; realistic lever: settles back 0.1–0.8 µT after each hold, creeps 0.6 µT/s sometimes; noise as measured)
- **B1:** normal rider, 3 cadences: 46 points in order, each within 0.6 µT of where the rider stopped, no false go-backs, no false flags.
- **B2:** slow shifter (2.5 s reaction): nothing saved before moving.
- **B3:** stop–shift–pedal rider (stops for 3–8 s at every gear): completes, never shows the "keeps changing" card or a buzzer.
- **B4:** rest mid-calibration (60 s) in the up pass and the down pass: resumes; nothing lost.
- **B5:** overshoot on the up and down passes: one go-back, redone at the edge.
- **B6:** rider lets the lever settle back after every save (the v3.2b behaviour): zero go-backs.
- **B7:** rider pauses mid-gear: the point isn't saved mid-gear when the expected step is known (same spot).
- **B8:** phone disconnect during the up pass: pauses, resumes on reconnect; nothing saved while disconnected.
- **B9:** field strength ×0.3 and ×3 (board moved further / closer): tolerances scale; B1 still passes; placement meters reflect it.
- **B10:** first-ever calibration (no stored cal) and board moved (stored cal at a different place): spot=first/new, gentler f, completes.
- **B11:** fast 10-gear flicks: measure the resync time (documented, not a pass/fail).
- **B12:** stop the down pass halfway (`s`, `x`, power loss), then `#D` later: the partial down points are kept, and resuming finishes it.

**C. Replays of real logs** (open loop: raw `R` samples through the model)
- **C1, tune multipliers:** from v3.2b and the 2026-10-15 recordings, the derived tolerances at this spot reproduce the tuned v3.2 values where those were right (agree ≈ 2.0, drift ≈ 1.0), and give a behind of at least 1.5 µT.
- **C2, check acceptance:** see §2.3.
- **C3, hold-still notices:** on the v3.2b raw data, count W with 0 vs 1 extra settling turn, and pick the one with fewer notices and no loss of accuracy.
- **C4:** on the v3.2b raw data, gear 15 isn't saved early (§1 #3).

**D. Board-in-the-loop replay** (the real C code, run on the CLUE)
- **Firmware:** `#I` (USB only) switches the board to injected samples. `#S,<ms>,<x>,<y>,<z>` lines (USB) are processed as magnetometer readings; real reads are ignored until `#I` again. Time comes from the injected `ms`, and `millis()`-based timers use a virtual clock that follows the injected time.
- **Harness:** `bench/tests/hil_replay.py` streams a scenario's samples at real-time pace (or as fast as the board keeps up, if the virtual clock makes that safe), records the board's output, runs the same samples through the model, and diffs C/K/F/U/N/W/P/Z lines and the final Q dump.
- **Scenarios:** B1, B5 and B12 (generated from the closed-loop model run, then replayed open loop), and the v3.2b raw recording (open loop).

**E. App**
- `node --check`.
- A node script loads the page's parser and feeds it real board lines from the D runs and the v3.2b log. Expected results:
  - the guided redo starts after `F,end`;
  - down-pass dots turn blue;
  - the step and breadcrumb are right;
  - pause is shown.
- Then a demo-mode check at phone size, in dark and light.

**F. Independent review** of the firmware diff (v3.2 → v3.3) and of the test results, before flashing.

## 7. Who does what
- **Firmware agent:** `KeiserMagBridge_v3_3/`, `bench/tests/fw_model.py` (mirror), the PROTOCOL.md v3.3 section, the NOTES.md v3.3 section.
- **App agent:** `webapp/index.html`, `webapp/README.md` only.
- **Test agent:** `bench/tests/test_v33_*.py`, `bench/tests/run_all.py`, `bench/tests/hil_replay.py`, scenario files under `bench/tests/scenarios/`. It doesn't edit firmware, the model or the app; it reports bugs to the lead with file:line and a reproducing test.
- **Lead (main session):** integration, deciding on tuning, running D on the board, the commit / flash / publish questions to the user.
