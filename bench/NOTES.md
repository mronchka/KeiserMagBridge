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
