"""Run every test file in bench/tests and print a summary table.

Usage: py -3 bench/tests/run_all.py [--only PATTERN] [--skip PATTERN] [--quick] [-v]
  --only / --skip   substring of the file name (repeatable)
  --quick           pass --quick to the v3.3 files (fewer seeds)
  -v                print each file's full output (default: only its FAIL / SKIP / RESULT lines)

Exit code 1 if any file fails (exit code != 0).  A file's own RESULT line is
shown in the table; files that predate the RESULT convention are summarised
from their PASS/FAIL lines.
"""
import glob
import os
import re
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable


def main(argv):
    only, skip, quick, verbose = [], [], False, False
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--only":
            only.append(argv[i + 1]); i += 1
        elif a == "--skip":
            skip.append(argv[i + 1]); i += 1
        elif a == "--quick":
            quick = True
        elif a == "-v":
            verbose = True
        i += 1
    files = sorted(glob.glob(os.path.join(HERE, "test_*.py")))
    files = [f for f in files if (not only or any(o in os.path.basename(f) for o in only))
             and not any(s in os.path.basename(f) for s in skip)]
    rows = []
    t_all = time.time()
    for path in files:
        name = os.path.basename(path)
        args = [PY, "-X", "utf8", path]
        if quick and name.startswith("test_v33_"):
            args.append("--quick")
        t0 = time.time()
        p = subprocess.run(args, cwd=os.path.dirname(HERE), capture_output=True, text=True, encoding="utf-8",
                           errors="replace")
        dt = time.time() - t0
        out = p.stdout + ("\n" + p.stderr if p.stderr.strip() else "")
        lines = out.splitlines()
        npass = sum(1 for l in lines if re.match(r"^\s*PASS\b", l))
        nfail = sum(1 for l in lines if re.match(r"^\s*FAIL\b", l))
        nskip = sum(1 for l in lines if re.match(r"^\s*SKIP\b", l))
        res = [l for l in lines if l.startswith("RESULT")]
        crashed = "Traceback (most recent call last)" in out
        status = "PASS" if p.returncode == 0 else ("CRASH" if crashed else "FAIL")
        rows.append((name, status, npass, nfail, nskip, dt, res[-1] if res else ""))
        print(f"=== {name}: {status} ({npass} pass, {nfail} fail, {nskip} skip, {dt:.1f} s)")
        if verbose:
            print(out)
        else:
            for l in lines:
                if re.match(r"^\s*(FAIL|SKIP)\b", l):
                    print("   " + l.strip())
            if crashed:
                print("\n".join("   " + l for l in lines[-12:]))
        sys.stdout.flush()
    print("\n" + "=" * 100)
    print(f"{'file':28s} {'status':7s} {'pass':>5s} {'fail':>5s} {'skip':>5s} {'time':>7s}  result")
    for name, status, npass, nfail, nskip, dt, res in rows:
        r = res.replace("RESULT:", "").strip()
        print(f"{name:28s} {status:7s} {npass:5d} {nfail:5d} {nskip:5d} {dt:6.1f}s  {r[:120]}")
    bad = [r for r in rows if r[1] != "PASS"]
    print("=" * 100)
    print(f"{len(rows) - len(bad)} of {len(rows)} files passed in {time.time() - t_all:.0f} s" +
          (": failing " + ", ".join(r[0] for r in bad) if bad else ""))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
