# Hand-off: firmware → app

Reply to `bench/HANDOFF_app_to_firmware.md`. From the firmware chat, 2026-10-18.

## #5 press to capture: firmware v3.4 is ready (not flashed yet)

- **Spec:** `bench/PROTOCOL.md`, section "v3.4 additions". In short:
  - `#V` → `E,ok,v3.4`.
  - `#A,press` / `#A,auto` → `E,ok,capture,<mode>`.
  - Flag `T` means press mode is on; flag `I` means measuring after a press.
  - A press is `n` (or button A), answered with `N,press`.
  - A refused press is `N,notmoved`. A second press for the same point saves it anyway, unless it's within 0.4 µT of the previous point.
  - `S` keeps 16 fields and `cal` stays 0–9. No new fields on `C`/`Q`/`K`.
  - Auto is the power-up default, so the page in use today is unaffected. Send `#A,press` after `#V` on every connection.
- **Acks unchanged:**
  - `E,ok,redo`, `E,ok,down`, `E,ok,saved`;
  - `x`/`s`/`u` do what they did, and `u` also cancels a measurement in progress.
- **Removed:** `N,stuck` is no longer sent, so the page's handling of it can stay or go.
- **Also changed** (both modes): a go-back to an overshot point happens at most once per point per pass, and the auto-mode soft-hold guard is tighter.
- **Model:** `bench/tests/fw_model.py` mirrors it, and `riders.run_cal(press=True)` runs a pressing rider. `test_v34_press.py` has 87 checks; all 9 test files and the 5 model replays pass.
- **Not done yet:**
  - flashing (the rider says when);
  - a real board log with presses. It will be `bench/logs/2026-10-1x_v3_4_cal.log` after the next bike run.

## Next (firmware chat)

#7 (down pass from the top of 24, press per point), then #8 (guided go-to), #4 (guided sweep), #11 phase 2 and #12 option 1, in the order the hand-off suggests.

---

## Update 2026-10-25: firmware v3.5 is on the board (#87, #91, #92)

The spec is in `bench/PROTOCOL.md`, section "v3.5 additions". `#V` now answers `E,ok,v3.5`, which your `^v3\.(\d+)$` check already accepts as press-capable. Please keep that regex; the board will never send a third number.

**#87, whole-gear redo by taps: `#R,g,<gear>`**
- **Start:** answered `E,ok,redo`. The stages show as `pass` `g1` (tap in the gear below), `g2` (tap where the gear first shows going up), `g3` (tap in the gear above) and `g4` (tap where it first shows coming down). The `step` field is gear − 1 throughout, and `cal` stays 1.
- **Taps:** each tap is `n` → `N,press`, with flag `I` while measuring. A tap in the wrong gear at a reference stage gets `N,notmoved` and stays on that stage. Flag `B` never shows during a gear redo.
- **Saving:** both points are saved together at the end: `C,<g>,…` (sent at stage 2), `C,down,<g+1>,…`, then `E,ok,saved`, `K` and the `F` list once.
- **The ends:** gear 1 is `g3`–`g4` only, and gears 23 and 24 are `g1`–`g2` only.
- **`x`:** cancels with nothing changed (`A,cancelled by user`).
- **`u`:** cancels a tap that's measuring; otherwise it goes back one stage (`U,<g−1>` / `U,<g>,d`).
- **Taps in any mode:** a gear redo works by taps whatever the capture mode.
- **Not yet on the board's own tests:** the board-in-the-loop scenario `G1_gear_redo.json` is recorded, but not run on the board yet, because it erases the rider's calibration. 38 model checks pass, including 12 redos across gears 2–22 with no refused taps.

**#91 / #92, dropped Bluetooth lines: fixed on the board**
- **How it works now:**
  - **Status** keeps only the newest line. It's sent when something changes (at most 4 a second), otherwise once a second.
  - **Every other line** is queued whole and sent by its own task, so nothing arrives half-sent and none are dropped while connected.
  - **Paced output** (`k`, `p`, `F`, `D`) waits for room.
- **Measured from a PC:** a readback came through 49 of 49 lines intact, none glued, with status never more than 1.4 s apart.
- **For you:** your glued-message cleanup and quiet re-read can stay as a safety net. They should no longer trigger.

**New: `#H,0` / `#H,1`** turns the human-readable text to the phone off / on (`E,ok,text,off|on`). It's on by default, and set on again at every connection. Suggestion: send `#H,0` after connecting, `#H,1` while the Console tab is open, and `#H,0` when it closes. That's about 10% less traffic, and the page never reads that text.

**Status is sparser:** while idle you'll see about one `S` line a second instead of four. Your 2.5 s "Waiting for the bridge" note and 5 s staleness limit are fine with that. Anything that assumed four lines a second, such as counting lines as time, should use clock time instead.

## Next (firmware chat)

#7 (down pass from the top of 24), #4 (guided sweep), #11 phase 2 (now mostly covered by `#R,g`), #12 option 1.
