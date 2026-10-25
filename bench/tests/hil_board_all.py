"""Run every board-capable scenario through the real board (tier D), one after another.

Usage: py -3 bench/tests/hil_board_all.py COM3 [--speed 3]

Every scenario starts from an erased board in auto-capture mode ('x', '#E', '#A,auto'). A scenario with an initial calibration
(the v3.2b log) runs from an erased board too, model and board alike: '#P' can't set point 25 or
clear the down points the previous scenario left, so the board can't be given that calibration exactly.
Output: bench/logs/hil/<scenario>_board.log and a summary. Exit code 1 if any scenario differs.
"""
import json
import os
import subprocess
import sys
import time

import serial

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hil_replay as H  # noqa: E402

PORT = sys.argv[1] if len(sys.argv) > 1 else "COM3"
SPEED = sys.argv[sys.argv.index("--speed") + 1] if "--speed" in sys.argv else "3"
LOGS = os.path.join(HERE, "..", "logs", "hil")
os.makedirs(LOGS, exist_ok=True)


def talk(lines, wait=1.5):
    s = serial.Serial(PORT, 115200, timeout=0.2)
    time.sleep(1.2)
    s.reset_input_buffer()
    out = []
    for ln in lines:
        s.write(ln.encode())
        time.sleep(wait if ln.startswith("#W") else 0.15)
        out += s.read(20000).decode(errors="replace").splitlines()
    time.sleep(0.5)
    out += s.read(20000).decode(errors="replace").splitlines()
    s.close()
    return [l for l in out if l.startswith(("E,", "A,", "K,"))]


results = []
for name in ("B1.json", "B5.json", "B12.json", "P1_press.json", "P5_press_refused.json", "G1_gear_redo.json", "v32b.json.gz"):
    path = os.path.join(HERE, "scenarios", name)
    sc = H.load_scenario(path)
    if sc.get("initial_cal") is not None:
        sc["initial_cal"] = None
        sc["note"] = sc.get("note", "") + "; started from an erased board"
        path = os.path.join(LOGS, name.split(".")[0] + "_erased.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(sc, fh)
    # erased, in auto-capture as a freshly started board: the mode survives '#E' (a press scenario sets press itself)
    print(name, "erase:", talk(["x", "#E\n", "#A,auto\n"]))
    log = os.path.join(LOGS, name.split(".")[0] + "_board.log")
    t0 = time.time()
    r = subprocess.run([sys.executable, os.path.join(HERE, "hil_replay.py"), path, "--port", PORT,
                        "--speed", SPEED, "--out", log], capture_output=True, text=True)
    tail = [l for l in r.stdout.splitlines() if l.startswith(("PASS", "FAIL", "  note", "the scenario"))]
    ok = r.returncode == 0
    results.append((name, ok, round(time.time() - t0), tail))
    print(name, "PASS" if ok else "FAIL", f"{time.time() - t0:.0f} s", tail[-2:])
    if not ok:
        print("\n".join(r.stdout.splitlines()[-30:]))
    talk(["x"])

print("\nRESULT:", sum(1 for _, ok, _, _ in results if ok), "of", len(results), "scenarios match on the board")
sys.exit(0 if all(ok for _, ok, _, _ in results) else 1)
