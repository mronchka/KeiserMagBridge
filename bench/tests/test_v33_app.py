"""Tier E (bench/V3_3_PLAN.md section 6), parser feed: the phone page's own parser fed with board lines.

Usage: py -3 bench/tests/test_v33_app.py [--quick]

Uses the app agent's harness (bench/tests/app_harness/harness.js: webapp/index.html's script in node with a
DOM stub and a virtual clock).  SKIPs with a message if node or the harness isn't there.

  E0  node --check on the page's script and on the harness scripts
  E1  the app agent's own checks: replay_v32b.js (real v3.2b lines), demo_v33_flow.js (the page's simulator)
  E2  lines from the v3.3 MODEL (closed-loop riders, S lines from Firmware.status_line() every 250 ms):
        - breadcrumb 'STEP n OF 6' follows the board's step field
        - 'Paused - pedal to continue' while flag O is set, no alarm styling
        - down-pass dots turn blue
        - after F,end with something flagged: the gear list shows it red and offers Improve (#11),
          or (an edit's F list) the guided redo starts (a #R is written)
        - no page errors; Z / J / X lines don't upset the page
Exit code 1 if a check fails.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fw_model as fw  # noqa: E402
import riders as R  # noqa: E402
from riders import API  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
HARN = os.path.join(HERE, "app_harness")
PAGE = os.path.join(ROOT, "webapp", "index.html")
QUICK = "--quick" in sys.argv
ck = R.Checker("test_v33_app")
NODE = shutil.which("node")


def node(args, timeout=600):
    p = subprocess.run([NODE] + args, capture_output=True, text=True, encoding="utf-8", errors="replace",
                       timeout=timeout, cwd=ROOT)
    return p.returncode, p.stdout, p.stderr


if not NODE:
    ck.skip("E: node isn't on PATH")
    ck.finish()
if not os.path.exists(os.path.join(HARN, "harness.js")):
    ck.skip("E: bench/tests/app_harness/harness.js isn't there yet (the app agent creates it)")
    ck.finish()

TMP = tempfile.mkdtemp(prefix="v33app_")

# ====================================================================== E0
print("E0. node --check")
html = open(PAGE, encoding="utf-8").read()
scripts = re.findall(r"<script>([\s\S]*?)</script>", html)
for i, sc in enumerate(scripts):
    p = os.path.join(TMP, f"page_script_{i}.js")
    open(p, "w", encoding="utf-8").write(sc)
    rc, out, err = node(["--check", p])
    ck.check(rc == 0, f"E0 webapp/index.html <script> #{i + 1} ({len(sc) // 1024} KB) parses" + (f": {err.strip()[:300]}" if rc else ""))
WEB = os.path.join(ROOT, "webapp")
page_js = sorted(os.path.relpath(os.path.join(d, f), WEB).replace(os.sep, "/")
                 for d, _, fs in os.walk(os.path.join(WEB, "js")) for f in fs if f.endswith(".js"))
for rel in page_js:
    rc, out, err = node(["--check", os.path.join(WEB, rel)])
    ck.check(rc == 0, f"E0 webapp/{rel} parses" + (f": {err.strip()[:300]}" if rc else ""))
# The loader lists every file (the demo simulator separately), and every asset URL carries this build.
loader = next((s for s in scripts if "var APP_FILES = [" in s), "")
listed = re.findall(r"'(js/[^']+\.js)'", loader)
ck.check(sorted(listed) == page_js, f"E0 index.html loads every webapp/js file once ({len(listed)} listed, {len(page_js)} on disk)"
         + ("" if sorted(listed) == page_js else f": listed {listed}, on disk {page_js}"))
build = re.search(r"var APP_BUILD = '([^']+)'", html)
vers = re.findall(r"""(?:href|src)="[^"]+\?v=([^"]+)\"""", html)
ck.check(bool(build) and len(vers) >= 1 and all(v == build.group(1) for v in vers),
         f"E0 asset URLs in index.html carry ?v=APP_BUILD ({build.group(1) if build else 'no APP_BUILD'}: {vers})")
for js in sorted(os.listdir(HARN)):
    if js.endswith(".js"):
        rc, out, err = node(["--check", os.path.join(HARN, js)])
        ck.check(rc == 0, f"E0 app_harness/{js} parses" + (f": {err.strip()[:200]}" if rc else ""))

# ====================================================================== E1
def required_args(path):
    """Positional arguments a harness script needs, from its 'Usage: node ...js ARGS' header line
    (optional ones are in [brackets]; '(exit 1 on failure)' and later text is ignored)."""
    head = "".join(open(path, encoding="utf-8").readlines()[:15])
    m = re.search(r"Usage: node \S+\.js([^\n(]*)", head)
    if not m:
        return []
    args = re.sub(r"\[[^\]]*\]", " ", m.group(1)).split()
    return args


print("\nE1. The app agent's harness scripts")
for js in sorted(os.listdir(HARN)):
    if not js.endswith(".js") or js == "harness.js":
        continue
    need = required_args(os.path.join(HARN, js))
    if need:   # a tool run by hand on a given log (e.g. replay_board_log.js LOG), not a self-contained check
        ck.skip(f"E1 {js}: needs {' '.join(need)} (run it by hand)")
        continue
    rc, out, err = node([os.path.join(HARN, js)])
    fails = [l for l in out.splitlines() if l.startswith("FAIL")]
    for l in fails:
        print("    " + l)
    ck.check(rc == 0, f"E1 {js}: {sum(1 for l in out.splitlines() if l.startswith('PASS'))} pass, {len(fails)} fail"
             + (f"; stderr {err.strip()[-300:]}" if rc and err.strip() else ""))

# ====================================================================== E2
print("\nE2. The page fed with lines from the v3.3 model")
DRIVER = r"""
'use strict';
const { loadApp, readLog } = require(process.argv[2]);
(async function main() {
  const lines = readLog(process.argv[3]);
  const app = loadApp({ search: '' });
  app.connect();
  const $ = app.$;
  const crumb = () => ($('crumbs') && !$('crumbs').hidden ? $('crumbT').textContent : '');
  const txt = (id) => ($(id) ? $(id).textContent : '');
  const rec = [], dotProblems = [];
  let fEndAt = null, fEndN = 0;
  for (const [t, text] of lines) {
    await app.feed(t, text);
    if (/^F,end,/.test(text)) { fEndAt = t; fEndN = +text.split(',')[2]; }
    if (/^S,/.test(text)) {
      const f = text.split(',');
      rec.push({ t: t, step: +(f[14] || 0), flags: f[9], cal: +f[5], crumb: crumb(), head: txt('calHead'),
                 disc: $('disc') ? $('disc').className : '', focus: !!app.M3.state.calFocus, view: app.M3.state.view,
                 undo: !$('topUndo').hidden, pass: f[13] || '', point: +f[6] });
      const s = app.M3.state.s;
      if (s && s.pass === 'd' && s.cal !== 0) {
        const dots = $('calDots') ? $('calDots').children : [];
        for (const q of (app.M3.state.downPoints || [])) {
          const cls = dots[q.point - 1] ? dots[q.point - 1].className : '(no dot)';
          if (!/\b(down|cur)\b/.test(cls)) dotProblems.push(t.toFixed(1) + ' point ' + q.point + ': ' + cls);
        }
      }
    }
  }
  await app.advance(8);
  const st = app.M3.state;
  console.log(JSON.stringify({ rec, fEndAt, fEndN, dotProblems: dotProblems.slice(0, 10), nDotProblems: dotProblems.length,
    cmds: app.commands(), errors: app.errors.map(String), downPoints: (st.downPoints || []).length,
    review: st.review ? st.review.items.map((i) => i.pass + i.point) : null,
    gearList: !!st.gearList && !$('gearList').hidden, improve: !$('glImprove').hidden,
    red: app.win.gearQuality ? Object.keys(app.win.gearQuality()).filter((g) => app.win.gearQuality()[g].level === 2) : [] }));
})().catch((e) => { console.log(JSON.stringify({ fatal: String(e && e.stack || e) })); process.exit(2); });
"""
drv = os.path.join(TMP, "feed_driver.js")
open(drv, "w", encoding="utf-8").write(DRIVER)


def model_feed(label, rider_kw=None, sim_kw=None, seed=1, extra=None, start="ble"):
    """A closed-loop model run, written as a board log with S lines every 250 ms."""
    f = fw.Firmware()
    sim = R.Sim(f, seed=seed, **(sim_kw or {}))
    rider = R.Rider(sim, **(rider_kw or {}))
    status = []
    nxt = [0]

    def pol(s):
        if s.f.ms_now >= nxt[0]:
            nxt[0] = s.f.ms_now + 250
            status.append((s.f.ms_now, s.f.status_line()))
        return rider(s)
    sim.run(2)
    sim.src = start
    API.start(f, start)
    sim.run(1500, pol)
    if extra:
        extra(sim, pol)
    for _ in range(12):                               # a few seconds after the end
        sim.run(0.25)
        status.append((f.ms_now, f.status_line()))
    lines = sorted([(ms, 1, l) for ms, l in f.out] + [(ms, 2, l) for ms, l in status], key=lambda x: (x[0], x[1]))
    path = os.path.join(TMP, re.sub(r"\W+", "_", label) + ".log")
    with open(path, "w", encoding="utf-8") as fh:
        for ms, _, l in lines:
            fh.write("%10.2f  %s\n" % (ms / 1000.0, l))
    return f, path


def run_page(label, path):
    rc, out, err = node([drv, os.path.join(HARN, "harness.js"), path])
    try:
        res = json.loads(out.strip().splitlines()[-1])
    except Exception:  # noqa: BLE001
        ck.check(False, f"E2 {label}: the driver ran ({rc}: {err.strip()[-300:]})")
        return None
    if "fatal" in res:
        ck.check(False, f"E2 {label}: {res['fatal'][:300]}")
        return None
    return res


def page_checks(label, f, res):
    ck.check(not res["errors"], f"E2 {label}: no page errors {res['errors'][:2]}")
    rec = res["rec"]
    inflow = [r for r in rec if r["step"] > 0]
    good = [r for r in inflow if f"STEP {r['step']} OF 6" in r["crumb"].upper()]
    bad = [(round(r["t"], 1), r["step"], r["crumb"]) for r in inflow if r not in good]
    ck.check(inflow and len(good) >= 0.97 * len(inflow),
             f"E2 {label}: breadcrumb follows the board's step ({len(good)}/{len(inflow)} S lines) {bad[:3]}")
    steps = sorted({r["step"] for r in inflow})
    ck.info(f"E2 {label}: steps seen {steps}")
    # the focused calibration screen: no tab bar while the board calibrates; Undo in the top bar on the points
    calib = [r for r in rec if r["cal"] not in (0, 7)]
    foc = [r for r in calib if r["focus"] and r["view"] == "cal"]
    ck.check(calib and len(foc) >= 0.97 * len(calib), f"E2 {label}: focused screen while calibrating ({len(foc)}/{len(calib)} S lines)")
    pts = [r for r in calib if r["cal"] == 1 and r["pass"] in ("u", "d") and r["point"] > 0]
    und = [r for r in pts if r["undo"]]
    ck.check(not pts or len(und) >= 0.9 * len(pts), f"E2 {label}: Undo in the top bar on the gear points ({len(und)}/{len(pts)})")
    paused = [r for r in rec if "O" in r["flags"] and r["cal"] != 0]
    if paused:
        shown = [r for r in paused if re.search(r"Paused", r["head"])]
        calm = [r for r in paused if not re.search(r"amber|red|alarm", r["disc"])]
        ck.check(len(shown) >= 0.9 * len(paused), f"E2 {label}: 'Paused' shown while flag O ({len(shown)}/{len(paused)}) "
                                                 f"{[r['head'] for r in paused if r not in shown][:2]}")
        ck.check(len(calm) == len(paused), f"E2 {label}: no alarm styling while paused ({len(calm)}/{len(paused)})")
    if f.cal and f.cal.get("downMask"):
        ck.check(res["nDotProblems"] == 0, f"E2 {label}: down-pass dots blue {res['dotProblems'][:3]}")
    if res["fEndN"]:
        redo = [c for c in res["cmds"] if res["fEndAt"] is not None and c["t"] >= res["fEndAt"] and
                re.match(r"^#R,[ud],\d+$", c["cmd"])]
        listed = res.get("gearList") and res.get("improve") and res.get("red")
        ck.check(bool(redo) or bool(listed), f"E2 {label}: after F,end,{res['fEndN']} the flagged gear is redone or shown red "
                 f"with Improve ({redo[0]['cmd'] if redo else 'gear list, red ' + ','.join(res.get('red') or []) if listed else [c['cmd'] for c in res['cmds'][-8:]]})")


def bad_point(sim, pol):
    """After the calibration, load up point 12 moved 3 uT up the lever (#P + #W): the check flags it."""
    f = sim.f
    p = f.cal["pts"][11]
    q = [p[k] + 3.0 * R.LEV[k] for k in range(3)]
    sim.run(3, lambda s: pol(s) and False)
    sim.hash_line("P,u,12,%.1f,%.1f,%.1f" % tuple(q))
    sim.hash_line("W")
    sim.run(4, lambda s: pol(s) and False)


cases = [("stop-shift-pedal rider (pauses, flag O)", dict(stop_shift=0.6, pause_s=(4.0, 7.0)), {}, 23, None),
         ("normal rider, then a bad point 12 loaded", {}, {}, 3, bad_point)]
if not QUICK:
    cases.append(("overshoot at up point 10", dict(overshoot_at={(fw.PASS_UP, 9)}), {}, 41, None))
for label, rk, sk, seed, extra in cases:
    f, path = model_feed(label, rk, sk, seed, extra=extra)
    res = run_page(label, path)
    if res:
        page_checks(label, f, res)

# down pass stopped with 'x', then '#D' later (the resume offer / step 5)
f = fw.Firmware()
sim = R.Sim(f, seed=121)
rider = R.Rider(sim)
status, nxt, sent = [], [0], []


def pol(s):
    if s.f.ms_now >= nxt[0]:
        nxt[0] = s.f.ms_now + 250
        status.append((s.f.ms_now, s.f.status_line()))
    rider(s)
    if not sent and s.f.calPass == fw.PASS_DOWN and s.f.calStep == 11 and s.f.calState == fw.CAL_WAITING:
        sent.append(1)
        s.cmd('x')
        return True
    return False


sim.run(2)
sim.src = "ble"
API.start(f, "ble")
sim.run(900, pol)
sim.run(5, lambda s: pol(s) and False)
sim.hash_line("D")
rider2 = R.Rider(sim)
sim.run(600, lambda s: (pol(s) and False) or rider2(s))
lines = sorted([(ms, 1, l) for ms, l in f.out] + [(ms, 2, l) for ms, l in status], key=lambda x: (x[0], x[1]))
path = os.path.join(TMP, "down_x_then_D.log")
with open(path, "w", encoding="utf-8") as fh:
    for ms, _, l in lines:
        fh.write("%10.2f  %s\n" % (ms / 1000.0, l))
res = run_page("down pass 'x' then #D", path)
if res:
    page_checks("down pass 'x' then #D", f, res)
    ck.check(res["downPoints"] >= 11, f"E2 'x' then #D: the page kept the down points ({res['downPoints']})")

shutil.rmtree(TMP, ignore_errors=True)
ck.finish()
