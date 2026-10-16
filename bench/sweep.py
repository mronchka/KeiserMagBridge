"""Analyse a lever sweep in live.log.

Usage: py -3 sweep.py LOGFILE [T_START [T_END]]
Prints a decimated table of field readings with magnitude and a
projection onto the lever axis (axis from the lowest-|proj| hold at the
start to the reading farthest from it), plus SAT counts.
"""
import math
import re
import sys

PAT = re.compile(r"^\s*([\d.]+)\s+B=\(\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+)\)uT\s+(SAT)?")

log = sys.argv[1]
t_start = float(sys.argv[2]) if len(sys.argv) > 2 else 0.0
t_end = float(sys.argv[3]) if len(sys.argv) > 3 else 1e12

rows = []
for line in open(log, encoding="utf-8", errors="replace"):
    m = PAT.match(line)
    if m:
        t = float(m.group(1))
        if t_start <= t <= t_end:
            rows.append((t, (float(m.group(2)), float(m.group(3)), float(m.group(4))), bool(m.group(5))))

if not rows:
    sys.exit("no B= lines in range")

start = rows[0][1]
far = max(rows, key=lambda r: math.dist(r[1], start))[1]
span = math.dist(far, start)
axis = [(f - s) / span for f, s in zip(far, start)] if span else [0, 0, 0]


def proj(p):
    return sum((p[i] - start[i]) * axis[i] for i in range(3))


def off(p):
    s = proj(p)
    return math.dist(p, [start[i] + s * axis[i] for i in range(3)])


print(f"rows={len(rows)}  t={rows[0][0]:.1f}..{rows[-1][0]:.1f}  SAT={sum(r[2] for r in rows)}")
print(f"start B={tuple(round(v, 1) for v in start)}  far B={tuple(round(v, 1) for v in far)}  span={span:.1f} uT")
step = max(1, len(rows) // 60)
prev = None
for t, b, sat in rows[::step]:
    s = proj(b)
    d = "" if prev is None else f"{s - prev:+6.1f}"
    prev = s
    bar = "#" * max(0, min(60, int(s / max(span, 1) * 60)))
    print(f"{t:7.1f}  s={s:6.1f} {d:>7} off={off(b):5.1f} |B|={math.hypot(*b):6.1f} {'SAT' if sat else '   '} {bar}")
end = rows[-1][1]
print(f"end vs start: {math.dist(end, start):.1f} uT (along axis {proj(end):+.1f}, off-axis {off(end):.1f})")
