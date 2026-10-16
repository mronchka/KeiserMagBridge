# Keiser M3 Bridge web app

A single-file phone page (`index.html`) for the Keiser M3 Bridge (Adafruit CLUE nRF52840). It connects over Web Bluetooth (Nordic UART Service) and lets you:

- **Ride**: see a large gear number, watts, cadence and resistance, plus status chips (pod, Zwift, calibrated) and warnings (saturated, off-path hold).
- **Calibrate**: run the 25-point gear calibration from the handlebars.
- **Diagnose**: run a guided diagnostic recording, and find every saved calibration and recording (with Share, Download and Copy).
- **Console**: read the bridge's text output and send single-character commands.

Everything is inline: there is no build step and no network access beyond Bluetooth. It needs the bridge running the v2 firmware, which sends the status lines this page reads; with older firmware only the Console tab works.

## Which browser

| Device | Browser |
|---|---|
| iPhone / iPad | **Bluefy** (free in the App Store). Safari and Chrome on iOS do not support Web Bluetooth. |
| Android | Chrome or Edge |
| Windows / macOS / Linux | Chrome or Edge |

Web Bluetooth only works on secure pages: `https://`, or `http://localhost` on a desktop. Host `index.html` on any static https host (for example GitHub Pages), then type or bookmark that URL in Bluefy.

## How to use

1. Power the bridge. Open the page and tap **Connect**. Pick "Keiser M3 Bridge" in the list.
   The page turns on the status stream automatically and keeps the screen awake where the browser allows it.
2. **Ride** tab: mount the phone and ride. If it says "Not calibrated", go to Calibrate first.
   An amber gear means the bridge is holding the last good gear because the reading is off-path.
3. **Calibrate** tab: tap **Start calibration** and follow the prompt for each of the 25 points:
   - Point 1: push the gear lever all the way down.
   - Points 2 to 24: move the lever up until the console first shows the next gear, then stop pedalling.
   - Point 25: push the gear lever all the way up.

   With **Auto-capture** on, each point is taken once the ring fills (about 2 seconds held steady). Turn it off to use **CAPTURE** yourself. **UNDO** goes back one point. **CANCEL** needs a second tap to confirm.
   At the end you get a result card with the path span and the smallest step between gears. A smallest step under 1.5 µT is flagged as marginal.
   **Firmware v3: calibrate while pedalling.** v3 works out the gear from each full pedal turn (it sees the crank magnet), so calibration is done while you pedal and the Calibrate tab changes to match (the page detects v3 by itself):
   - First the bridge learns your crank: pedal steadily for about 10 seconds while the ring fills. The board gives **two quick high beeps** when it is done, and the page shows "Crank learned".
   - Then the same 25 points, but **keep pedalling throughout**: move the lever until the console first shows the next gear, then hold it there. The console keeps showing the gear while you pedal.
   - The meter shows "Turns agreeing: n of 3". With auto-capture on, the point is taken at 3 of 3.
   - On the Ride tab the cadence shows where it comes from (crank magnet or Wahoo pod). When you stop pedalling it says "Not pedalling" and dims the gear, because the gear only updates on whole turns. Watts at 0 is normal then.

   Every finished calibration (saved or rejected) is saved on the phone automatically. A calibration that ends early (cancelled, aborted, or the connection drops) is also saved, with the points captured so far, as "Calibration incomplete (N of 25 points)". If the connection drops and you reconnect while the bridge is still calibrating, the page carries on with the same run. **Save stored calibration** reads the calibration currently stored on the bridge and saves it the same way; if the bridge has no complete calibration yet, the page says so.

   Bluetooth text from the bridge can arrive in bursts. The page keeps showing the last values when status lines are late; during calibration a small "Waiting for the bridge..." note appears after about 2.5 s of silence, and on the Ride tab after 5 s.
4. **Diagnose** tab: a guided recording of the raw magnetometer field, for troubleshooting. Tap **Start diagnostic run** and follow the cards. Each step has a countdown and moves on by itself; **NEXT** skips ahead and **BACK** repeats the previous step. The 11 steps cover the lever held down, a slow sweep up, a hold at the top, a sweep down, a hold at the bottom, one slow crank revolution by hand, setting a middle gear, easy and fast pedalling, stopping, and an optional lean step (switch it off before starting). The whole run is about 2.5 minutes; the bridge can hold 8 minutes.
   When the run ends, the page downloads the recording, checks the sample count and checksum, and saves it. If anything was lost on the way, it says "Transfer incomplete"; tap **Retry**, because the bridge still has the recording. **CANCEL** needs a second tap and discards the run.
   Diagnostics need the bridge running **firmware v2 with recording** (`g`/`m`/`e`/`y`). With older firmware the page says so and does nothing else.
5. **Console** tab: shows the bridge's text lines. Quick buttons send `h` (help), `p` (print calibration), `d` (debug stream, chatty) and `t` (**Turns**: one line per pedal turn). Current v3 firmware sends the turn lines over USB only, so over Bluetooth this usually shows nothing; when turn lines do arrive, the time of the last turn and its rpm appear above the log. The text box sends any single character. "Show machine lines" also shows the raw machine lines (only the first 10 `D` lines of each recording transfer).

If the connection drops, tap **Reconnect**. If it drops during a diagnostic run, reconnect and tap **Download recording**.

## Saved runs and export

Calibrations and diagnostic recordings are kept in this browser's storage on the phone (up to about 4 MB; when it is full the oldest are removed and the page says so). They are listed under **Saved runs** at the bottom of the Diagnose tab. Each one has:

- **Share**: opens the phone's share sheet with the CSV file (on iPhone: Save to Files, AirDrop, Mail and so on). Shown only when the browser supports sharing.
- **Download**: saves the CSV file (desktop and Android).
- **Copy**: copies the CSV text. If the browser blocks that, the text appears selected in a box so you can copy it yourself.
- **Delete**: tap twice.

Files are CSV with a few `#` comment lines at the top (record type, time, summary, and for recordings the table of step markers), then a header row:

- `keiser-cal-YYYY-MM-DD-HHMM.csv`: `point,label,x_uT,y_uT,z_uT,dist_prev_uT` (25 rows, Bottom, Gear 2 to Gear 24, Top). A stored calibration read from v3 firmware also has a `# crank:` comment line (crank direction, dip depth and polarity).
- `keiser-diag-YYYY-MM-DD-HHMM.csv`: `i,t_ms,step,x_uT,y_uT,z_uT,revs`, one row per 40 ms sample. `step` is the step that was running; `revs` is the cadence pod's crank count, empty when no pod was connected.

Saved data stays on that phone and in that browser only. Export anything you want to keep.

## Demo mode (no hardware)

Add `?demo=1` to the URL, for example `index.html?demo=1`. A built-in simulator stands in for the bridge, feeding protocol lines through the same parser as Bluetooth. It cycles gear, watts and cadence, and runs a full calibration (ending with span 146.0 µT, smallest step 3.8 µT at gear 6).

The simulator also answers the stored-calibration request and runs diagnostic recordings with synthetic 25 Hz data.

Extra options, added after `?demo=1`:

- `&v3=1`: simulate firmware v3 (cadence from the crank magnet, short pedalling stops, crank learning, calibration while pedalling at about 75 rpm, the Turns stream, and crank data in the stored calibration). Without it the simulator behaves like v2.
- `&uncal=1`: start uncalibrated.
- `&fast=1`: divide the diagnostic step times by 5 (the whole run takes about 35 s).
- `&drop=1`: lose one line in the first recording transfer, to see "Transfer incomplete" and Retry.
- `&stall=1`: hold back status lines for 3 s every 12 s, like a stalling Bluetooth link.
- `&oldfw=1`: behave like firmware without recording, to see the "update to v2" message.
