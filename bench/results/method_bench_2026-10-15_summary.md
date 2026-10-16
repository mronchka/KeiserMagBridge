# Method test bench: first results (2026-10-15 recording)

- **Script:** `bench/method_bench.py`.
- **Input:** `bench/logs/2026-10-15_cadence_test.log`, the 50 Hz raw readings at spot 1 with no phone connected, plus `_clicks.json`.
- **Raw numbers:** `method_bench_2026-10-15_cadence_test.csv`. The reference plateaus are in `_steps.csv`.

All values are in µT of lever position along the lever direction. The full lever range is 146.9 µT, and the gear steps in this recording run from 3.3 to 30.6 µT (median 6.8).

| Method | Wobble while pedalling (sd) | Resolution (4 × sd) | Gear steps resolved | Bias vs reference | Delay* | Drift once stopped |
|---|---|---|---|---|---|---|
| Sketch v1/v2 smoothing (130 ms) | 13.7 | 54.8 | 0 / 10 | 0.4 | n/a | −11.4 |
| Plain smoothing 1 s | 2.7 | 10.9 | 3 / 10 | 0.2 | 5.6 s | −11.0 |
| Plain smoothing 2 s | 1.4 | 5.5 | 7 / 10 | 0.3 | 5.5 s | −10.3 |
| Moving average 2 s | 2.3 | 9.2 | 3 / 10 | 0.2 | 5.5 s | −11.0 |
| Smoothing + crank-blind direction | 6.5 | 26.2 | 2 / 10 | 0.4 | 3.9 s | −5.7 |
| **Per-turn average (v3)** | **0.35** | **1.4** | **10 / 10** | 0.15 | 3.2 s | +0.5 |
| **Average of last 2 turns** | **0.12** | **0.5** | **10 / 10** | 0.08 | 3.7 s | +0.3 |
| Average of last 3 turns | 0.15 | 0.6 | 10 / 10 | 0.06 | 4.3 s | −0.3 |

*Delay runs from the last steady turn before a shift to 90 % of the new level. It includes the time you took to move the lever, so only compare it between methods.

**With simulated Bluetooth stalls** (80 ms every 250 ms, the problem v3 had on the bike), the wobble while pedalling rises:

| Method | Wobble (sd) | Gear steps resolved |
|---|---|---|
| Per-turn | 1.38 | 7 / 10 |
| 2-turn | 1.03 | 8 / 10 |
| 3-turn | 0.67 | 10 / 10 |

Turn counting also slips at high cadence: 28 of 30 fast turns detected.

**Turn counting** (clean data): 20 / 20 and 30 / 30 against the hand counts; cadence 35.2 and 82.1 rpm against the console's ~35 and ~84. The slow hand turns came out 9 / 10, but at 12 rpm that's below riding speed.

## What it says

- **Per-turn averaging beats every plain smoothing method** by 4–40× on wobble. It resolves every gear step, where 2 s smoothing resolves 7 of 10 and still lags more.
- **Averaging over 2 turns is the best balance.** It's about 3× steadier than a single turn, because errors at the turn boundaries cancel out between neighbouring turns, and costs only about half a second more delay.
- **Methods that read the field directly drift by about 11 µT (roughly 2 gears) after you stop pedalling,** because the crank parks at a random angle. The per-turn methods hold the last turn, so they don't drift.
- **The crank-blind direction is not useful at this spot** (2 / 10 steps).
- **Stalls are what broke v3 on the bike.** v3.1's sampling task is meant to bring the board back to the "clean" rows.

## Limits

- **The reference is the long-run average of whole turns.** The per-turn methods share those turn boundaries, so their near-zero bias is partly by construction.
- **Accuracy against the Keiser console's own gear and watts isn't measured yet.** The recording has no console labels.
- **One recording, one spot, upshifts only.**
