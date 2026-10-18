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
