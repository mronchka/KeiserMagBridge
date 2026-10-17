# Keiser M3 Bridge web app

A single-file phone page (`index.html`) for the Keiser M3 Bridge (Adafruit CLUE nRF52840). It connects over Web Bluetooth (Nordic UART Service) and lets you:

- **Ride**: see a large gear number, watts, cadence and resistance, plus status chips (pod, Zwift, calibrated) and warnings (saturated, off-path hold).
- **Calibrate**: run the 25-point gear calibration from the handlebars.
- **Diagnose**: run a guided diagnostic recording, and find every saved calibration and recording (with Share, Download and Copy).
- **Console**: read the bridge's text output and send single-character commands.

The page is dark by default, whatever the phone is set to; the sun/moon button in the header switches between dark and light, and the phone remembers the choice.

Everything is inline: there is no build step, and the only network access besides Bluetooth is a check for a newer published copy of the page. It needs the bridge running the v2 firmware, which sends the status lines this page reads; with older firmware only the Console tab works.

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
3. **Calibrate** tab: a short walkthrough explains the steps one page at a time (tap **Continue** or swipe). On the last page tap **Start calibration** and follow the prompt for each of the 25 points:
   - Point 1: push the gear lever all the way down.
   - Points 2 to 24: move the lever up until the console first shows the next gear, then stop pedalling.
   - Point 25: push the gear lever all the way up.

   With **Auto-capture** on, each point is taken once the ring fills (about 2 seconds held steady). Turn it off (on the Calibrate tab, before you start) to use **CAPTURE** yourself.

   While a calibration step is on, the screen is focused: the tab bar and the connection controls step aside and the top bar reads **✕ Calibrate Undo**. **Undo** goes back one point. **✕** cancels (a second tap confirms); on step 1, the Saved checkpoint and the gear check it goes back, does "Later" or skips the rest. Everything for the current step fits on an iPhone 16 screen without scrolling: the circle gives up room when a notice, the hold-still banner or "Finish without the down pass" is showing.
   At the end you get a result card with the path span and the smallest step between gears. A smallest step under 1.5 µT is flagged as marginal.
   **Firmware v3: calibrate while pedalling.** v3 works out the gear from each full pedal turn (it sees the crank magnet), so calibration is done while you pedal and the Calibrate tab changes to match (the page detects v3 by itself):
   - The screen shows one big circle for the current position, with the 25 positions as dots around it. Grey means move the lever; blue means hold it there (the three segments around the circle fill one per matching pedal turn); green with a tick means saved. A dot at the top shows your cadence. Any steady pace works, so it stays green; it turns red only below 30 rpm or above 120 rpm, where pedal turns can be missed or counted twice.
   - First the bridge learns your crank: pedal steadily at any comfortable pace with the lever still. With firmware v3.1 this ends as soon as 6 regular pedal turns are seen (about 5 s at 80 rpm, up to 15 s), and the circle counts the turns. The board gives **two quick high beeps**.
   - [v3.1] Then check the rpm in the circle against the Keiser console and tap **Yes, it matches**, or **Learn again**. If the crank was not found, the page says why and offers to try again; otherwise calibration carries on with the hold-still method.
   - Then the 25 points, **keep pedalling throughout**: move the lever until the console first shows the next gear, then hold it there. With auto-capture on, the point is taken at 3 of 3; **Capture now** (small) saves early once 2 of 3 agree. With auto-capture off, tap the big **CAPTURE**. [v3.1] A manual capture is refused if the lever hasn't moved from the previous point.
   - [v3.1] **Hold the lever still.** After 3 matching turns the circle says "Checking the lever has stopped…" for one more turn. If that turn shows the lever was still moving, the bridge throws the reading away and keeps waiting. A bright amber strip at the top says "Hold the lever still — the reading is still changing", and the phone vibrates once. The turn counter starts again underneath. You don't need to tap anything: once the lever stops, the point is saved by itself and the strip goes away. If the reading still hasn't settled after 15 seconds, a large amber card replaces the circle ("Point N: the reading keeps changing"). It has two big buttons. **Redo point N**: move the lever DOWN below gear N, then up to where the console first shows gear N, and hold. For point 25: push the lever down a little, then all the way up again. An amber reminder stays above the circle until that point is saved. **Capture anyway** saves the point as it is.
   - **[v3.2] Firmware v3.2** (the page detects it by itself from the 14th status field):
     - **Faster capture:** 2 matching pedal turns, then one check turn. The circle says "Turn 1 of 3", then "Turn 3 of 3 · checking the lever has stopped…". Prompts never ask for a particular rpm.
     - **No top point to pedal:** after gear 24 the bridge works out the top point from gears 23 and 24 by itself, a little beyond gear 24 ("Top worked out from gears 23 and 24").
     - **Down pass:** straight after the top, come back down: "Shift down to 22 … where the Keiser console FIRST shows 22, then hold it there", down to gear 1. There are 22 down points (gear 24 has none: you start right on it). All dots are green from the way up; each gear saved on the way down turns blue, and the one being measured has a ring. The count reads "Down pass: N of 22". **UNDO** works on the way down too. **Finish without the down pass** (tap twice) saves what has been measured so far.
     - **Went too far:** if the last gear was saved a little past its edge, the bridge goes back to it by itself; nothing to tap. An amber note by the circle says e.g. "Gear 22 was saved a little too far up. Shift DOWN into gear 21, then back up to where the console first shows gear 22" (coming down: "…too far down. Shift UP into gear N+1…"). While the bridge waits for the lever to go back, the prompt says "Keep going: down into gear 21", then "Now up to where gear 22 first shows". At gear 2 and the first gear coming down there is nothing to go back to, so the note just says to keep moving the lever until the console first shows the gear.
     - **Still on the same gear?** If you're pedalling but no turn has counted at a gear for over 10 s, the note says "Still on gear 10? Move up until the console first shows gear 11. If it already shows 11, ease back down into gear 10." (mirrored coming down). Easing back lets the bridge redo it as above.
     - **Gears that need another look:** after saving, the bridge checks the calibration. If it flags a gear, the page starts a redo of it straight away ("Gear 20 needs another look: lever DOWN below gear 20 first, then up to where the console FIRST shows gear 20, then hold"), then the next one. Under the circle, small links offer **Use best guess instead** (the bridge's estimate) and **Skip this gear**. If a gear is still flagged after 2 redos, a card offers **Use best guess** or **Keep it as it is** instead of a third. If you cancel a redo, or the bridge refuses, the same card waits for you, with the reason. **Save stored calibration** shows flagged gears on the card but doesn't start a redo by itself.
     - **Undo** at the first gear coming down goes back to gear 24 going up.
     - **Redo one gear:** the circle comes back for just that gear: "Redo gear 20: lever DOWN below gear 20 first, then up to where the console FIRST shows gear 20, then hold" (coming down: from above, down to where the console first shows the gear). Until the reading has been past the gear, the line under the circle says to go past it first. **CANCEL** stops the redo; the saved calibration is unchanged.
     - **Gear check:** once no gear needs another look (or you close that card), the page offers a short ride (app only, nothing changes on the bridge): a low gear (about 5), a middle gear (about 12) at an easy pace, the same gear faster, and a high gear (about 19). Each shows the bridge's gear big and asks "Does the Keiser console show gear N?". **No** opens a − / + picker for the console's gear. The summary offers **Redo gear G** for each mismatch (the higher of the two gears: that's the gear edge between them). Watts read a little below the console on purpose, because the bridge uses Keiser's measured power scale, so only the gear is checked. **Skip** is always there. The answers are added to the saved calibration file as `# gear_check` lines.
   - **[v3.3] Firmware v3.3: one flow of six numbered steps.** A breadcrumb at the top shows "STEP 3 OF 6 · Sweep the lever" and six small segments (done = green, current = blue). The step titles are plain instructions:
     1. **Find a good spot.** Pedal and move the lever from the bottom to the top and back. Three live meters show how well the bridge sees the magnets: **Lever swing** (a big arc gauge, µT covered by the lever), **Crank dip** (how clearly each pedal turn shows) and **Headroom** (room before the sensor saturates), each with weak / good / great zones. A verdict card says "Good spot" or "Great spot", or what to change ("Move closer to the magnets", "Too close to the magnets", "Move closer to the crank"). On iPhone a tip explains how to stop the screen locking (Settings → Display & Brightness → Auto-Lock → Never). **Next** starts the calibration.
     2. **Learn your pedalling.** As before: pedal steadily, then check the rpm against the console, then a few more turns with the lever still.
     3. **Sweep the lever.** Pedal and slowly push the lever up as far as you can still pedal, tap **Next**, then slowly back down to the bottom and tap **Next**. No stops at each gear. (The board says which half it is in, `su` / `sd`; the page also counts its Next taps as a fallback.)
     4. **Up through the gears.** As before. When the gears going up are done they are **saved and ready to ride**, and a **Saved** card offers **Continue down** (`n`; the board waits at this checkpoint) or **Later** (`x`, which keeps everything saved).
     5. **Back down through the gears.** As before. Gears saved coming down turn blue; each is saved as soon as it is measured, so stopping (`x` or **Finish without the down pass**) keeps them.
     6. **Check a few gears.** Starts by itself once any gears that needed another look are done. Each answer is also sent to the bridge (`#J,check,<bridge gear>,<console gear>,<rpm>`) so it lands in the USB log. **Skip this step** is always there.
     - **Stop any time.** On the gear steps the page says so: stop pedalling, shift, then pedal again. When the bridge pauses (no pedal turn for a few seconds, flag `O`) the circle goes quiet and says "Paused — pedal to continue". Nothing is lost.
     - **Pick up later.** If you chose **Later**, or stopped the down pass, the Calibrate start screen offers **Continue down through the gears** (`#D`) and **Check a few gears** until they are done (remembered on this phone).
     - **The circle shows the gear to be in now.** When the bridge goes back to a gear (a redo, or a gear saved too far), the circle first shows the gear to go back into ("GO TO 16", "Shift down into gear 16"), turns green when you're there, then shows the gear to aim for ("Now up to gear 17").
     - **Cadence guide.** Under the rpm dot a small bar shows a green window for the gear you're in: 60–90 rpm for gears 1–10, sliding to 30–55 rpm at gear 24 (the same for every rider). Outside the window the dot goes grey with "Comfortable here: …"; it turns red only below 30 or above 120 rpm.
     - **Gears that need another look** wait until the down pass is done (or you tap **Later**), then the guided redos run as with v3.2. If the end of the check list (`F,end`) never arrives, the page uses the flags it received after 3 s.
     - **Turns agree but the reading stays put** (`N,stuck`): a gentle note says "If the console already shows gear N, ease back into gear N−1 and come up to it again" (coming down: into gear N+1, then down).
     - The breadcrumb always follows the board while it is calibrating (e.g. a `#D` started during the gear check shows step 5).
     - **Stuck hint** at the first gear coming down now says "Still on gear 24 or 23?", because you start that pass in gear 24.
   - **Reload bar.** A tab left open keeps old code, and GitHub Pages lets phones cache the page for 10 minutes. The page compares its build with the published copy when it opens and when you come back to it, and shows **Reload** if they differ. It also shows **Reload** if the bridge sends status lines with more fields than this page knows. (This is why the v3.2 bike run showed no guided redo and green down-pass dots: the phone was still on the v3.1 page.)
   - On the Ride tab the cadence shows where it comes from (crank magnet or Wahoo pod). When you stop pedalling it says "Not pedalling" and dims the gear, because the gear only updates on whole turns. Watts at 0 is normal then.

   Every finished calibration (saved or rejected) is saved on the phone automatically. A calibration that ends early (cancelled, aborted, or the connection drops) is also saved, with the points captured so far, as "Calibration incomplete (N of 25 points)". If the connection drops and you reconnect while the bridge is still calibrating, the page carries on with the same run. **Save stored calibration** reads the calibration currently stored on the bridge and saves it the same way; if the bridge has no complete calibration yet, the page says so.

   Bluetooth text from the bridge can arrive in bursts. The page keeps showing the last values when status lines are late; during calibration a small "Waiting for the bridge..." note appears after about 2.5 s of silence, and on the Ride tab after 5 s.
   If a piece of a line is lost, two status lines can arrive glued together. With firmware v3 and later the page only accepts status lines of the right length (13 fields for v3.1, 14 for v3.2) with letter-only flags and a valid cadence source, and drops the rest. Once the bridge has been calibrated on this connection, the Ride tab only says "Not calibrated" (and shows **Go to Calibrate**) after 2 seconds of uncalibrated status lines in a row; until then it keeps showing the last good gear.
4. **Diagnose** tab: a guided recording of the raw magnetometer field, for troubleshooting. Tap **Start diagnostic run** and follow the cards. Each step has a countdown and moves on by itself; **NEXT** skips ahead and **BACK** repeats the previous step. The 11 steps cover the lever held down, a slow sweep up, a hold at the top, a sweep down, a hold at the bottom, one slow crank revolution by hand, setting a middle gear, easy and fast pedalling, stopping, and an optional lean step (switch it off before starting). The whole run is about 2.5 minutes; the bridge can hold 8 minutes.
   When the run ends, the page downloads the recording, checks the sample count and checksum, and saves it. If anything was lost on the way, it says "Transfer incomplete"; tap **Retry**, because the bridge still has the recording. **CANCEL** needs a second tap and discards the run.
   Diagnostics need the bridge running **firmware v2 with recording** (`g`/`m`/`e`/`y`). With older firmware the page says so and does nothing else.
5. **Console** tab: shows the bridge's text lines. Quick buttons send `h` (help), `p` (print calibration), `d` (debug stream, chatty) and `t` (**Turns**: one line per pedal turn). Current v3 firmware sends the turn lines over USB only, so over Bluetooth this usually shows nothing; when turn lines do arrive, the time of the last turn and its rpm appear above the log. The text box sends any single character, or a whole v3.2 edit command starting with `#` (for example `#G,u,20`); the page adds the newline and sends it in 20-byte pieces. "Show machine lines" also shows the raw machine lines (only the first 10 `D` lines of each recording transfer).

If the connection drops, tap **Reconnect**. If it drops during a diagnostic run, reconnect and tap **Download recording**.

## Saved runs and export

Calibrations and diagnostic recordings are kept in this browser's storage on the phone (up to about 4 MB; when it is full the oldest are removed and the page says so). They are listed under **Saved runs** at the bottom of the Diagnose tab. Each one has:

- **Share**: opens the phone's share sheet with the CSV file (on iPhone: Save to Files, AirDrop, Mail and so on). Shown only when the browser supports sharing.
- **Download**: saves the CSV file (desktop and Android).
- **Copy**: copies the CSV text. If the browser blocks that, the text appears selected in a box so you can copy it yourself.
- **Delete**: tap twice.

Files are CSV with a few `#` comment lines at the top (record type, time, summary, and for recordings the table of step markers), then a header row:

- `keiser-cal-YYYY-MM-DD-HHMM.csv`: `point,label,x_uT,y_uT,z_uT,dist_prev_uT` (25 rows, Bottom, Gear 2 to Gear 24, Top). A stored calibration read from v3 firmware also has a `# crank:` comment line (crank direction, dip depth and polarity). With v3.2 there are three more columns, `down_x_uT,down_y_uT,down_z_uT`: the reading for that gear edge coming down (point N = where the console first shows gear N−1 coming down; empty when not measured, always empty for points 1, 24 and 25), and a `# down_points:` line. A calibration changed with Redo or Use best guess is saved again with an `# edit:` line, and the gear check adds `# gear_check` lines.
- `keiser-diag-YYYY-MM-DD-HHMM.csv`: `i,t_ms,step,x_uT,y_uT,z_uT,revs`, one row per 40 ms sample. `step` is the step that was running; `revs` is the cadence pod's crank count, empty when no pod was connected.

Saved data stays on that phone and in that browser only. Export anything you want to keep.

## Demo mode (no hardware)

Add `?demo=1` to the URL, for example `index.html?demo=1`. A built-in simulator stands in for the bridge, feeding protocol lines through the same parser as Bluetooth. It acts like firmware v3.3: it cycles gear, watts and cadence, and runs the six-step calibration.

The simulator also answers the stored-calibration request and runs diagnostic recordings with synthetic 25 Hz data.

Extra options, added after `?demo=1`:

- v3.3 is the default (`&v3=1` still works): the six-step flow (placement `X` stream on `v`, the sweep and its `Z` result, steps in the status line, the Saved checkpoint, `#D`, `#J` echoes, pause with flag `O`) on top of everything v3.2 does. `&v32=1` simulates v3.2 instead (cadence from the crank magnet, short pedalling stops, turn-based crank learning and the cadence check, calibration while pedalling with 2 turns plus a check turn, the automatic top point, the down pass with **Finish without the down pass** and undo, the check after saving, `#R` redo and `#G` best guess, the Turns stream, and crank data and down points in the stored calibration).
- `&v2=1`: the old v2 simulator (its calibration ends with span 146.0 µT, smallest step 3.8 µT at gear 6).
- `&nstuck=1` (v3.3): an `N,stuck` at point 5, to see its hint.
- `&rest=1` (v3.3): short pedalling breaks while calibrating, to see "Paused — pedal to continue".
- `&v31=1`: simulate firmware v3.1 instead (3 turns, top point pedalled, no down pass, no `pass` field).
- `&review=1` (v3.2): after saving, the check flags gear 20 going up (`behind`) and gear 22 coming down (`updown`, if it was measured), to see the guided redos, **Use best guess instead** and **Skip**. A redo shows the "go past it first" line for a few seconds. Also flags them on **Save stored calibration**.
- `&stubborn=1` (with `&review=1`): gear 20 stays flagged after every redo, to see the card that appears after 2 tries.
- `&behind=1` (v3.2): point 7 was saved too far up. At point 8 the simulator sends `N,behind`, goes back to point 7 (`U,6`) and holds flag `B` for a few seconds, to see "Keep going: down into gear 6" and then "Now up to where gear 7 first shows".
- `&cad=NN` (v3.3): the cadence while calibrating, default 72 rpm. Try `&cad=25` or `&cad=130` to see the cadence dot turn red.
- `&suspect=1` (v3.3): every 4th point gets one or two "hold the lever still" notices, then saves by itself.
- `&stuck=1` (v3.3): point 6 never settles. After 15 s (3 s with `&fast=1`) the "reading keeps changing" card appears, to try **Redo point 6** and **Capture anyway**.
- `&learnfail=1` (v3.3): the first crank learning fails, to see the message and **Try learning the crank again**.
- `&uncal=1`: start uncalibrated.
- `&fast=1`: divide the diagnostic step times by 5 (the whole run takes about 35 s).
- `&drop=1`: lose one line in the first recording transfer, to see "Transfer incomplete" and Retry.
- `&stall=1`: hold back status lines for 3 s every 12 s, like a stalling Bluetooth link.
- `&oldfw=1`: behave like firmware without recording, to see the "update to v2" message.

## Tests in node

`bench/tests/app_harness/harness.js` runs this page's script in node (a small DOM stub, a virtual clock, writes captured), so board lines go through the same parser as on the phone.

- `node bench/tests/app_harness/replay_v32b.js [log] [--page file]`: replays a real board log (default `bench/logs/2026-10-16_v3_2b.log`) and checks that the guided redo starts after `F,end` and that the down-pass dots turn blue. `--page` runs an older copy of the page (e.g. from `git show`).
- `node bench/tests/app_harness/demo_v33_flow.js`: drives the v3.3 simulator through all six steps and checks the breadcrumb, meters, sweep, pause, checkpoint, dots, guided redo and gear check.
