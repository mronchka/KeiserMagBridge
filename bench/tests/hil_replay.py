"""Tier D (bench/V3_3_PLAN.md section 6): board-in-the-loop replay, host side.

Streams a scenario (magnetometer samples + timed commands) to the CLUE over USB
serial with the v3.3 injection commands, records what the board prints, runs
the same scenario through fw_model, and diffs the machine lines
(C/K/F/U/N/W/P/Z/E/A/L/J and the final Q dump, floats within 0.15 uT).

  #I                      toggle injected samples (USB only); real reads are ignored while on
  #S,<ms>,<x>,<y>,<z>     one magnetometer sample; the board's clock follows <ms>

Scenarios (JSON, optionally .json.gz):
  {"name", "note", "model", "initial_cal": cal dict | null,
   "events": [[ms, "S", [x, y, z]] | [ms, "C", "<char>"(, "ble")] | [ms, "L", "<# line without #>"] | [ms, "P", 0|1]]}
  "C" = a one-character command (c, n, u, x, s, k, v ...), "L" = a '#' line (D, M, J,..., R,u,12 ...),
  "P" = phone connected / disconnected (model only: can't be done over USB, so such scenarios are refused
  for the board).  Closed-loop runs write these (test_v33_sim.py --save-scenarios); logs convert with
  --from-log.

Usage:
  py -3 bench/tests/hil_replay.py SCENARIO.json --model-only          # dry run: model vs the model fed
                                                                      # through the serial protocol
  py -3 bench/tests/hil_replay.py SCENARIO.json --port COM3 [--speed 1] [--out board.log]
  py -3 bench/tests/hil_replay.py --from-log bench/logs/2026-10-16_v3_2b.log --save scenarios/v32b.json.gz
  py -3 bench/tests/hil_replay.py --all --model-only                  # every scenarios/*.json*

Board runs need pyserial and a board running v3.3 with #I / #S.  The board's
stored calibration must match the scenario's initial_cal (the harness sends
'k' first and compares; a first-ever scenario needs a board without one).
Exit code 1 on a difference.
"""
import difflib
import gzip
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_model as fw  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SCEN_DIR = os.path.join(HERE, "scenarios")
MACHINE = re.compile(r"^(?:[CKFUNWPZEALJ]),|^Q,")
TOL_UT = 0.15


# ====================================================================== scenario files
def load_scenario(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def save_scenario(sc, path):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "wt", encoding="utf-8") as fh:
        json.dump(sc, fh, separators=(",", ":"))


_LINE = re.compile(r"^\s*([\d.]+)\s+(.*)$")


def scenario_from_log(path, t0=0.0, t1=1e12, survey_skip=True, name=None):
    """A bike log (R stream + board lines) -> an open-loop scenario.

    Commands the rider sent from the phone aren't in the log, so they are put back from the board's
    answers, at the board time of the last R sample printed before the answer (serial order):
      '=== Calibration started' -> c;  'Cadence confirmed' -> n (+ n, n to skip the v3.3 survey: the
      2026-10-16 logs have no sweeps);  'Undo: back to point' -> u;  'A,cancelled by user' -> x;
      '>>> sent '<x>'' (USB) -> that command.
    initial_cal: the first Q dump in the log (crankBase isn't in Q lines: 0, the detector adapts)."""
    events, last_ms = [], None
    up, down, crank = {}, {}, None
    q_done = False
    for raw in open(path, encoding="utf-8", errors="replace"):
        m = _LINE.match(raw)
        if not m:
            continue
        t, text = float(m[1]), m[2].rstrip()
        if text.startswith("R,"):
            p = text.split(",")
            try:
                ms = int(p[1])
                last_ms = ms
                if t0 <= t <= t1:
                    events.append([ms, "S", [float(p[2]), float(p[3]), float(p[4])]])
            except (ValueError, IndexError):
                pass
            continue
        if not q_done:
            mq = re.match(r"Q,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$", text)
            if mq:
                up[int(mq[1])] = [float(mq[2]), float(mq[3]), float(mq[4])]
            mq = re.match(r"Q,down,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$", text)
            if mq:
                down[int(mq[1])] = [float(mq[2]), float(mq[3]), float(mq[4])]
            mq = re.match(r"Q,crank,(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?\d+)", text)
            if mq:
                crank = dict(crankOk=1, crankU=[float(mq[1]), float(mq[2]), float(mq[3])],
                             crankDepth=float(mq[4]), crankSign=int(mq[5]), crankBase=0.0)
            if text.startswith("Q,end"):
                q_done = True
        if last_ms is None or not (t0 <= t <= t1):
            continue
        cmds = []
        if text.startswith("=== Calibration started"):
            cmds = ["c"]
        elif text.startswith("Cadence confirmed"):
            cmds = ["n"] + (["n", "n"] if survey_skip else [])
        elif text.startswith("Undo: back to point"):
            cmds = ["u"]
        elif text.startswith("A,cancelled by user"):
            cmds = ["x"]
        else:
            ms_ = re.match(r">>> sent '(.+?)'", text)
            if ms_:
                c = ms_[1].replace("\\n", "")
                if c.startswith("#"):
                    events.append([last_ms, "L", c[1:]])
                elif c and c not in "rtdh1":                    # streams / help: not modelled
                    cmds = [c]
        for c in cmds:
            events.append([last_ms, "C", c])
    cal = None
    if len(up) == 25:
        cal = dict(pts=[up[i] for i in range(1, 26)], **(crank or dict(crankOk=0, crankSign=1, crankU=[1, 0, 0],
                                                                         crankDepth=0.0, crankBase=0.0)))
        cal["down"] = [down.get(i + 1, [0.0, 0.0, 0.0]) for i in range(25)]
        cal["downMask"] = sum(1 << (p - 1) for p in down)
    return dict(name=name or os.path.basename(path), note=f"from {os.path.basename(path)} {t0}-{t1} s",
                model="log", initial_cal=cal, events=events, survey_skip=survey_skip)


# ====================================================================== the model side
def copy_cal(cal):
    if cal is None:
        return None
    return json.loads(json.dumps(cal))


def run_model(sc, via_protocol=False, factory=None, on_event=None, end_dump=True):
    """Run a scenario through fw_model.  via_protocol: feed it exactly as the board gets it
    ('#I', '#S,...' lines and command characters through Firmware.input()), else call the model directly.
    on_event(f, ev) is called after each event (for tests).  Returns the Firmware."""
    f = (factory or fw.Firmware)(cal=copy_cal(sc.get("initial_cal")))
    if via_protocol:
        f.input("#I\n", "usb")
    for ev in sc["events"]:
        ms, kind, x = ev[:3]
        src = ev[3] if len(ev) > 3 else "usb"
        if kind == "S":
            if via_protocol:
                f.input(sample_line(ms, x), "usb")
            else:
                f.ms_now = ms
                f.process_sample(ms, x)
        elif kind == "C":
            if via_protocol:
                f.input(x, src)
            else:
                f.command(x, src)
        elif kind == "L":
            if via_protocol:
                f.input("#" + x + "\n", "usb")
            else:
                f.line(x, "usb")
        elif kind == "P":
            f.phone_connected(bool(x))
        if on_event:
            on_event(f, ev)
    if end_dump:
        if via_protocol:
            f.input("k", "usb")                       # still injecting: 'k' works either way
            n = len(f.out)
            f.input("#I\n", "usb")                    # leave injection (refused while calibrating);
            del f.out[n:]                             # the harness's own answer isn't compared
        else:
            f.command("k", "usb")
    return f


def sample_line(ms, x):
    return "#S,%d,%.2f,%.2f,%.2f\n" % (ms, x[0], x[1], x[2])


def machine_lines(lines):
    return [l for l in lines if MACHINE.match(l) and not l.startswith(("E,ok,inject", "E,fail,usb only"))]


# ====================================================================== the diff
_NUM = re.compile(r"^-?\d+(\.\d+)?$")


def _shape(line):
    """The line with its numbers blanked, for alignment."""
    return ",".join("#" if _NUM.match(x) else x for x in line.split(","))


def fields_match(a, b, tol=TOL_UT):
    fa, fb = a.split(","), b.split(",")
    if len(fa) != len(fb):
        return False
    for i, (x, y) in enumerate(zip(fa, fb)):
        if x == y:
            continue
        if _NUM.match(x) and _NUM.match(y):
            if "." in x or "." in y:
                if abs(float(x) - float(y)) <= tol + 1e-9:
                    continue
            elif fa[0] == "L" and i == 3 and abs(int(x) - int(y)) <= 1:      # rpm, %.0f of a float32
                continue
        return False
    return True


def diff_lines(model, board, tol=TOL_UT, context=2):
    """Machine lines of the model vs the board.  Returns (ok, report lines)."""
    a, b = machine_lines(model), machine_lines(board)
    sm = difflib.SequenceMatcher(a=[_shape(x) for x in a], b=[_shape(x) for x in b], autojunk=False)
    rep, bad = [], 0
    for op, i1, i2, j1, j2 in sm.get_opcodes():
        if op == "equal":
            for k in range(i2 - i1):
                if not fields_match(a[i1 + k], b[j1 + k], tol):
                    bad += 1
                    rep.append(f"  value  model[{i1 + k}] {a[i1 + k]}  |  board[{j1 + k}] {b[j1 + k]}")
        else:
            bad += 1
            rep.append(f"  {op:7s} model[{i1}:{i2}] {a[i1:i2][:6]}  |  board[{j1}:{j2}] {b[j1:j2][:6]}")
    head = f"{len(a)} model lines, {len(b)} board lines, {bad} difference(s)"
    return bad == 0, [head] + rep[:60]


# ====================================================================== the board side (never run with --model-only)
class Board:
    def __init__(self, port, baud=115200):
        import serial                                   # pyserial, imported only for board runs
        self.ser = serial.Serial(port, baud, timeout=0)
        self.buf = b""
        self.lines = []                                 # (last injected ms when received, line)
        self.last_ms = 0

    def write(self, s):
        self.ser.write(s.encode())

    def poll(self):
        data = self.ser.read(4096)
        if data:
            self.buf += data
            while b"\n" in self.buf:
                ln, self.buf = self.buf.split(b"\n", 1)
                self.lines.append((self.last_ms, ln.decode("utf-8", "replace").rstrip("\r")))

    def wait_quiet(self, s=0.5):
        end = time.time() + s
        while time.time() < end:
            self.poll()
            time.sleep(0.01)

    def close(self):
        self.ser.close()


def run_board(sc, port, speed=1.0, log=None):
    if any(ev[1] == "P" or (len(ev) > 3 and ev[3] != "usb") for ev in sc["events"]):
        raise SystemExit("this scenario uses the phone (BLE commands / disconnects): not possible over USB (model-only)")
    bd = Board(port)
    try:
        bd.write("0")                                   # status stream off
        bd.wait_quiet(0.5)
        n0 = len(bd.lines)
        bd.write("k")
        bd.wait_quiet(1.5)
        q = [l for _, l in bd.lines[n0:] if l.startswith("Q,")]
        check_initial_cal(sc.get("initial_cal"), q)
        bd.lines = []
        bd.write("#I\n")
        bd.wait_quiet(0.3)
        t_start, ms0 = time.time(), None
        for ev in sc["events"]:
            ms, kind, x = ev[:3]
            if ms0 is None:
                ms0 = ms
            if speed > 0:
                due = t_start + (ms - ms0) / 1000.0 / speed
                while time.time() < due:
                    bd.poll()
                    time.sleep(0.002)
            bd.last_ms = ms
            if kind == "S":
                bd.write(sample_line(ms, x))
            elif kind == "C":
                bd.write(x)
            elif kind == "L":
                bd.write("#" + x + "\n")
            bd.poll()
        bd.wait_quiet(2.0)
        bd.write("k")                                   # the final dump, still injecting
        bd.wait_quiet(2.0)
        keep = len(bd.lines)
        bd.write("#I\n")                                # leave injection; its answer isn't compared
        bd.wait_quiet(0.5)
        if any("busy calibrating" in l for _, l in bd.lines[keep:]):
            print("  note: the scenario ends mid-calibration and '#I' was refused: send 'x', then '#I'")
        bd.lines = bd.lines[:keep]
        if log:
            with open(log, "w", encoding="utf-8") as fh:
                for ms, l in bd.lines:
                    fh.write(f"{ms:10d}  {l}\n")
        return [l for _, l in bd.lines]
    finally:
        bd.close()


def check_initial_cal(cal, q_lines):
    up = {}
    for l in q_lines:
        m = re.match(r"Q,(\d+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)$", l)
        if m:
            up[int(m[1])] = [float(m[2]), float(m[3]), float(m[4])]
    if cal is None:
        if up:
            raise SystemExit("the scenario starts without a calibration but the board has one (Q lines): "
                             "erase it first, or use a scenario with initial_cal")
        return
    if len(up) != 25:
        raise SystemExit("the scenario needs the board's calibration to match initial_cal, but the board has none")
    worst = max(fw.dist3(up[i + 1], cal["pts"][i]) for i in range(25))
    if worst > TOL_UT:
        raise SystemExit(f"the board's stored calibration differs from initial_cal by up to {worst:.2f} uT")


# ====================================================================== command line
def replay(path_or_sc, model_only=True, port=None, speed=1.0, out=None, quiet=False):
    sc = load_scenario(path_or_sc) if isinstance(path_or_sc, str) else path_or_sc
    nS = sum(1 for e in sc["events"] if e[1] == "S")
    nC = len(sc["events"]) - nS
    dur = (sc["events"][-1][0] - sc["events"][0][0]) / 1000.0 if sc["events"] else 0
    if not quiet:
        print(f"Scenario {sc.get('name')}: {nS} samples, {nC} commands, {dur:.0f} s; {sc.get('note', '')}")
    direct = run_model(sc)
    ref = [l for _, l in direct.out]
    if model_only:
        other = [l for _, l in run_model(sc, via_protocol=True).out]
        label = "model (direct) vs model (through #I/#S, as the board gets it)"
    else:
        other = run_board(sc, port, speed=speed, log=out)
        label = f"model vs board on {port}"
    ok, rep = diff_lines(ref, other)
    if not quiet:
        print(f"  {label}: " + rep[0])
        for r in rep[1:]:
            print(r)
        mk = machine_lines(ref)
        print(f"  model: {sum(1 for l in mk if l.startswith('C,'))} C, {sum(1 for l in mk if l.startswith('K,'))} K, "
              f"{sum(1 for l in mk if l.startswith('W,'))} W, {sum(1 for l in mk if l.startswith('U,'))} U, "
              f"{sum(1 for l in mk if l.startswith('Z,'))} Z, last F: "
              f"{[l for l in mk if l.startswith('F,end')][-1:]}")
    return ok, rep


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    model_only = "--model-only" in argv
    port = argv[argv.index("--port") + 1] if "--port" in argv else None
    speed = float(argv[argv.index("--speed") + 1]) if "--speed" in argv else 1.0
    out = argv[argv.index("--out") + 1] if "--out" in argv else None
    if "--from-log" in argv:
        log = argv[argv.index("--from-log") + 1]
        t0 = float(argv[argv.index("--t0") + 1]) if "--t0" in argv else 0.0
        t1 = float(argv[argv.index("--t1") + 1]) if "--t1" in argv else 1e12
        sc = scenario_from_log(log, t0, t1)
        dest = argv[argv.index("--save") + 1] if "--save" in argv else None
        if dest:
            save_scenario(sc, dest)
            print(f"saved {dest}: {len(sc['events'])} events")
        if not model_only and not port:
            return 0
        paths = [sc]
    elif "--all" in argv:
        paths = sorted(os.path.join(SCEN_DIR, p) for p in os.listdir(SCEN_DIR) if ".json" in p) \
            if os.path.isdir(SCEN_DIR) else []
    else:
        paths = [a for a in argv if not a.startswith("--") and (".json" in a)]
    if not model_only and not port:
        print("give --port COMx for a board run, or --model-only for a dry run")
        return 2
    bad = 0
    for p in paths:
        ok, _ = replay(p, model_only=model_only, port=port, speed=speed, out=out)
        print(("PASS " if ok else "FAIL ") + (p if isinstance(p, str) else p.get("name", "scenario")))
        bad += not ok
    print(f"\nRESULT: hil_replay: {len(paths) - bad} of {len(paths)} scenario(s) match")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
