# Hand-off: firmware changes the phone page is waiting for

From the app chat (branch `app-refactor`, page build v3.3-2026-10-18.6) to the firmware chat. 2026-10-18.

The page side of these issues is blocked on the board. This note covers, for each issue, what the rider asked for, what the page needs from the board, and what the page already does. The command and line names below are suggestions only. Choose what fits the sketch, write it into `bench/PROTOCOL.md`, and I'll build the page to match.

**Who owns what:** this chat changes `webapp/` and `bench/tests/app_harness/`. The firmware chat owns the `.ino`, `bench/tests/fw_model.py` and `bench/PROTOCOL.md`.

**Suggested order:** #5 first, because #4, #7, #8 and #11 phase 2 all build on its press. Then #7, #8, #4, and finally #11 phase 2 and #12 option 1.

---

## Rules for staying compatible with the page in use now

The current page is strict about some lines. If a line breaks these rules, the page drops it as malformed, and that can break a calibration on phones that haven't reloaded.

- **`C`, `C,down`, `Q,<n>`, `Q,down`, `Q,crank`:** the page needs exactly the number of fields it has now (5, 6, 5, 6 and 7). **Don't add fields to them.** Put new data in new lines.
- **`K`:** needs at least 6 fields.
- **`S`:**
  - **Field count:** 16 fields today. Up to 23 are accepted (the page reads the first 16), but after 3 such lines it shows "The bridge has newer firmware than this page knows. Reload the page." That's fine if the new page ships at the same time.
  - **`cal`:** must stay **0–9** on v3.3-style lines, or the whole S line is rejected.
  - **`pass`:** any 1–3 lowercase letters (or `-`).
  - **`stepNo`:** one digit.
  - **New flag letters:** ignored by the current page.
- **New line letters:** a letter outside `S C K A U Q G M Y D L N W P F E X Z J` is shown in the page's console as text and otherwise ignored, so it's harmless.
- **New `Q,<word>,...` kinds:** logged as malformed and ignored, also harmless. Pages before v3.2 handled `Q,down` the same way.
- **Acks the page waits for:** `E,ok,redo` when a `#R` starts, `E,ok,down` for `#D`, and `E,ok,saved` after a save. Please keep these, and give any new mode an `E,ok,<word>` ack the same way.
- **Version:** the page can only tell firmware versions apart by the S field count. Before it shows a press button, it needs to know the board supports presses. Please add a version marker: a 17th S field, or a reply to a version command such as `E,ok,v3.4`. Whichever you pick, put it in PROTOCOL.md.

---

## #5: confirm each gear with a press (the base for the rest)

**The rider wants:** to move to gear N, tap the circle when the console shows it, and have the bridge measure there. No guessing about when it auto-captures.

**Today:**
- Auto-capture is on by default. It captures after 3 agreeing turns and a check turn.
- `n` with auto-capture off ("Capture now") saves at once from the noise floor. It doesn't measure the next turns.

**What the page needs:**
1. **A press command, sent when the circle is tapped.** It starts a 2–3 turn measurement at the current spot, and nothing is saved before it. The existing checks still apply (`W` when the lever moves, `N,behind`, the same-spot test). Button A on the board should do the same.
2. **A way to switch press mode on**, kept like auto-capture (`a`) or as its own command, so riders can still use auto-capture.
3. **The state the circle shows, readable from `S`:**
   - waiting for a press ("move to gear N, then tap");
   - measuring (`stab` already gives the progress);
   - got it (the `C` line, as now).
   This could be a new flag or a `cal` value of 8 or 9.
4. **A refused press:** an `N,<reason>` line (no turn yet, not moved, still moving), as `n` does now.

**Page side once it's in:** the circle becomes the button, labelled "Move to gear N", "Tap when the console shows N", "Measuring…", "Got it". Auto-capture stays available as an option.

## #7: down pass from the top of gear 24, with a press at each gear

**The rider wants:** to start the down pass at the top of gear 24 and press at each gear on the way down.

**Today:**
- After point 24 the board saves and waits at `cal` 7.
- `n` starts the down pass, and its first prompt is "first shows gear 22" (`step` 22).
- In the rider's log (540–600 s), "Paused — pedal to continue" (flag `O`) showed from 563 to 570 s, right as the down pass started. The rider had stopped pedalling at the top, so the start felt like an error. Consider not counting the checkpoint and its first few seconds as a pause.

**What the page needs:** where the pass starts and which gear the first prompt names (PROTOCOL.md), plus the press from #5 at each down point. `C,down` stays as it is.

## #8: an unsure gear, guided by the circle instead of a hint underneath

**The rider wants:** when the bridge isn't sure, the circle tells them where to go ("go to 16", then back to 17), and they press at each spot.

**Today:**
- The go-back after an overshoot (`N,behind`, then `U`, flag `B`) already shows "GO TO 16" in the circle, then turns green, then shows the target.
- `N,stuck` was removed, so nothing guides the rider for a pause part-way through a gear.

**What the page needs:**
- a line with the gear to go to, sent when the board wants the rider somewhere else (for example `N,goto,<gear>`, or flag `B` plus a target);
- a sign that they've arrived;
- the #5 press at both spots.

## #4: guided sweep, bottom → top → bottom, with presses and a travel ring

**The rider wants:**
1. press at the bottom;
2. move slowly up, with a ring filling as the lever travels;
3. press at the top;
4. move back down;
5. press at the bottom.

**Today:**
- The sweep (`cal` 6, `pass` `su`/`sd`) has no start press.
- The page sends `n` to switch halves and to end the sweep.
- Nothing tells the page how far along the path the lever is.

**What the page needs:**
1. a press at the bottom before the sweep starts (a sub-step before `su`);
2. the presses at the top and the bottom taking the place of `n`;
3. a live position for the ring at about 4 Hz during the sweep: how far along so far, and the expected length if known (the stored `pathLen` at the same spot). This could be an `X`-style line or a new letter.

## #11 phase 2: Improve a gear's two edges in one guided go

**Today (page, phase 1, done):**
- The "Calibration done" list colours each gear green, yellow or red.
- "Improve N gears" runs one `#R,u,<point>` or `#R,d,<point>` per edge, so a gear with both edges flagged takes two redos.
- Gear g's bottom edge is up point g; its top edge is down point g+1.

**The rider wants:** for gear g:
1. press in gear g−1 (below);
2. come up into g and press (the up edge);
3. go up into g+1 and press (above);
4. come back down to the top of g and press (the down edge).

Both edges are measured in one go.

**What the page needs:**
- a redo mode for a whole gear (for example `#R,g,<gear>`) that sends `E,ok,redo` at its start, prompts for each spot, saves both points, then `E,ok,saved`, `K` and the `F` list;
- `pass` values for its stages, so the page can say which spot is next;
- a cancel by `x` that leaves the stored calibration unchanged, as `#R` does now.

## #12 option 1: per-point quality stored on the board

**Why:** the page colours gears from what it saw during the calibration:
- the `W` tries per point;
- go-backs (`N,behind` + `U`);
- step sizes;
- the up/down gaps;
- the `F` list.

Since #12 option 2, it writes the tries and go-backs into the run file (`# point_stats:`) and reads them back. That only works on the phone that did the calibration. A copy on the board works on any phone.

**What the page needs:** per point and pass, the number of `W` tries, go-backs, and (if cheap) the spread of the agreeing turns at capture. Stored with the calibration and sent by `k`. **New lines, not new fields on `Q`**, for example:

```
Q,stat,<u|d>,<point>,<tries>,<backs>,<spreadUT>
```

Send these before `Q,end`. The capture rpm (`capRpm` / `downRpm`) is already stored, and could ride along too.

## #3 (not firmware)

The page only needs to know which way the board or magnet should face. I'll ask the rider; there's nothing for the firmware chat.

---

## When a piece is ready, please send me

1. **The PROTOCOL.md section** for it, with the commands, lines, flags and `pass` and `cal` values.
2. **A board log of a real run** with the new flow (`bench/logs/...`). I replay logs through the page with `bench/tests/app_harness/replay_board_log.js` and model the flow in the page's simulator (`webapp/js/demo-sim.js`).
3. **Any change to the acks or to what `x`/`s`/`u` do** in the new states.

I'll update the page, the simulator and the harness tests, publish to the preview, and the rider tests the pair together. Nothing goes to `main` (the live phone page) without the rider's OK.
