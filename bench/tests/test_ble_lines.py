"""What the phone page receives from DualLog in KeiserMagBridge_v3_1.ino.

Usage: py -3 bench/tests/test_ble_lines.py

Models, from the Adafruit nRF52 core 1.7.0 sources:
  - DualLog::write(): buffers a whole line (up to 160 bytes) and calls
    bleuart.write(conn, buf, n) once per line;
  - BLEUart::write() (unbuffered, the default) -> BLECharacteristic::notify():
        remaining = min(len, _max_len)          # _max_len = TXD max len
        sends remaining in (MTU - 3)-byte notifications
    where the TXD characteristic's max len is Bluefruit.getMaxMtu(PERIPH),
    which is BLE_GATT_ATT_MTU_DEFAULT = 23 unless configPrphBandwidth()/
    configPrphConn() is called before Bluefruit.begin() (the sketch does not);
  - the page's line assembly (webapp/index.html onBytes/handleLine):
    concatenate, split on '\n', drop the buffer past 2048 bytes.
Compares the v3.1 sketch with the v3 20-byte buffer and with the fix
(send the line in <= 20-byte pieces).
"""
import sys

MAX_LEN = 23          # TXD characteristic max length (default MTU, no configPrph* call)
MTU = 23
RX_BUF_MAX = 2048

LINES = [
    "S,12,45.3,180,84.2,1,7,67,0.5,VZAR,0,B,0\n",
    "C,8,-77.4,56.0,-128.1\n",
    "L,1,6,86,59.9,ok\n",
    "N,notmoved\n",
    "K,1,121.9,1.08,15,saved\n",
    "S,0,0.0,0,82.0,3,0,95,0.0,A,0,-,5\n",
    "Q,crank,0.9600,-0.0200,-0.2800,60.1,-1\n",
    "W,7,1.4,1.6\n",
    "S,9,30.1,120,72.0,5,6,0,0.4,VZAR,0,B,0\n",
]


def notify(data):
    """BLECharacteristic::notify(): returns the notification payloads actually sent."""
    remaining = min(len(data), MAX_LEN)
    out, i = [], 0
    while remaining:
        n = min(MTU - 3, remaining)
        out.append(data[i:i + n])
        i += n
        remaining -= n
    return out


def duallog(lines, bufsize, chunk=None):
    pk = []
    for line in lines:
        b = line.encode()
        buf = b""
        for c in b:
            buf += bytes([c])
            if c == 10 or len(buf) >= bufsize:
                if chunk:
                    for i in range(0, len(buf), chunk):
                        pk += notify(buf[i:i + chunk])
                else:
                    pk += notify(buf)
                buf = b""
    return pk


def page(packets):
    rx, got = "", []
    for p in packets:
        rx += p.decode(errors="replace")
        while "\n" in rx:
            line, rx = rx.split("\n", 1)
            got.append(line)
        if len(rx) > RX_BUF_MAX:
            rx = ""
    return got, rx


fails = 0
for name, bufsize, chunk in (("v3   (20-byte buffer)", 20, None),
                             ("v3.1 (160-byte buffer, one write per line)", 160, None),
                             ("v3.1 + fix (160-byte buffer, written in 20-byte pieces)", 160, 20)):
    got, rest = page(duallog(LINES * 3, bufsize, chunk))
    ok = got == [l.rstrip("\n") for l in LINES * 3]
    print(f"{name}: page got {len(got)} of {len(LINES) * 3} lines intact={ok}")
    if not ok:
        print(f"   first lines received: {got[:2]}  pending buffer: {rest[:70]!r}...")
    if ("v3.1" in name and "fix" not in name) == ok:
        fails += 1
# Does the sketch itself send the buffered line in <= 20-byte pieces?
import os
import re
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "KeiserMagBridge_v3_1",
                        "KeiserMagBridge_v3_1.ino"), encoding="utf-8").read()
m = re.search(r"void sendLocked\(uint16_t conn\) \{(.*?)\n  \}", src, re.S)
uses_pieces = bool(m and "i += 20" in m.group(1) and "min(n_ - i, (size_t)20)" in m.group(1))
print(f"sketch DualLog::sendLocked writes 20-byte pieces: {uses_pieces}")
if not uses_pieces:
    fails += 1
print("\nRESULT:", "pass: the sketch sends 20-byte pieces, so every line arrives intact" if not fails else "FAIL")
sys.exit(1 if fails else 0)
