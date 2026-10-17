"""Record what the phone page would receive from the real board during a calibration.

Replays a scenario on the board (injected samples, as hil_replay.py) with the board's status
stream ON ('1'), and saves every line the board prints with its time in seconds, for
app_harness/replay_board.js to play through the page in Bluetooth mode.

Usage: py -3 bench/tests/hil_record_page.py SCENARIO.json COM3 OUT.log [--speed 3]
The board must be erased first for a first-ever scenario ('x', then '#E').
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import hil_replay as H  # noqa: E402

path, port, out = sys.argv[1], sys.argv[2], sys.argv[3]
speed = float(sys.argv[sys.argv.index("--speed") + 1]) if "--speed" in sys.argv else 3.0
sc = H.load_scenario(path)
bd = H.Board(port)
t0 = time.time()
stamped = []                                   # (seconds since start, line)


def take():
    while bd.lines:
        _, ln = bd.lines.pop(0)
        stamped.append((time.time() - t0, ln))


try:
    bd.write("1")                              # status stream on, as the page does on connect
    bd.wait_quiet(0.5)
    take()
    bd.write("#I\n")
    bd.wait_quiet(0.3)
    take()
    t_start, ms0, n = time.time(), None, 0
    for ev in sc["events"]:
        ms, kind, x = ev[:3]
        ms0 = ms if ms0 is None else ms0
        due = t_start + (ms - ms0) / 1000.0 / speed
        while time.time() < due:
            bd.poll()
            time.sleep(0.002)
        if kind == "S":
            bd.write(H.sample_line(ms, x))
            n += 1
            if n % H.SYNC_EVERY == 0:
                bd.sync(n)
        elif kind == "C":
            bd.write(x)
        elif kind == "L":
            bd.write("#" + x + "\n")
        bd.poll()
        take()
    bd.sync(n + 1, timeout=20.0)               # the last save and the check
    bd.wait_quiet(3.0)
    take()
finally:
    bd.close()
with open(out, "w", encoding="utf-8") as fh:
    for t, ln in stamped:
        fh.write("%10.3f  %s\n" % (t, ln))
print("recorded %d lines (%d status lines) in %.0f s -> %s" %
      (len(stamped), sum(1 for _, l in stamped if l.startswith("S,")), time.time() - t0, out))
