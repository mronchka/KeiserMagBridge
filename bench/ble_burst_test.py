"""Bluetooth bench test for issue #91: does the board drop 20-byte pieces of lines in a burst?

Connects to "Keiser M3 Bridge" over Bluetooth LE (Nordic UART, as the phone page does), turns the
status stream on, asks for the stored calibration ('k') and the long printout ('p') several times
in quick succession, and checks every line it gets back:
  - each 'k' should give Q,1..Q,25, 22 Q,down lines (if the board has them), Q,crank and Q,end;
  - no line may contain a second line's start (",F,u," / "Q," / "S," mid-line): that is a lost piece;
  - every S line has 16 fields.
It also prints the notification sizes seen. Read-only: it never changes the board's calibration.

Usage: py -3 bench/ble_burst_test.py [rounds] [--log out.txt]
"""
import asyncio
import re
import sys
import time

from bleak import BleakClient, BleakScanner

NUS_TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"     # board -> phone (notify)
NUS_RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"     # phone -> board (write)
ROUNDS = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 3
LOG = sys.argv[sys.argv.index("--log") + 1] if "--log" in sys.argv else None

MID_START = re.compile(r".(?:[SCKAUQGMYDLNWPFEXZJ]),(?:\d|u,|d,|down,|crank,|end|none|ok,|fail,)")


async def main():
    dev = await BleakScanner.find_device_by_name("Keiser M3 Bridge", timeout=15.0)
    if not dev:
        sys.exit("board not found over Bluetooth")
    rx = bytearray()
    lines, sizes = [], []
    t0 = time.time()

    def on_notify(_, data: bytearray):
        sizes.append(len(data))
        rx.extend(data)
        while b"\n" in rx:
            i = rx.index(b"\n")
            lines.append((time.time() - t0, rx[:i].decode("utf-8", "replace").rstrip("\r")))
            del rx[:i + 1]

    async with BleakClient(dev) as cl:
        print("connected; MTU", cl.mtu_size)
        await cl.start_notify(NUS_TX, on_notify)
        await asyncio.sleep(1.0)

        async def send(s):
            for i in range(0, len(s), 20):                 # the page writes in pieces of at most 20 bytes
                await cl.write_gatt_char(NUS_RX, s[i:i + 20].encode(), response=False)

        await send("1")                                    # status stream on, as the page does
        await asyncio.sleep(2.0)
        marks = []
        for r in range(ROUNDS):
            marks.append(len(lines))
            await send("k")
            await asyncio.sleep(0.05)
            await send("p")
            await asyncio.sleep(0.05)
            await send("k")
            await asyncio.sleep(8.0)                       # let it all come out
        await send("0")
        await asyncio.sleep(1.0)
        await cl.stop_notify(NUS_TX)

    if LOG:
        with open(LOG, "w", encoding="utf-8") as fh:
            for t, l in lines:
                fh.write(f"{t:9.3f}  {l}\n")
    # ---- checks
    glued = [l for _, l in lines if MID_START.search(l)]
    s_bad = [l for _, l in lines if l.startswith("S,") and len(l.split(",")) != 16]
    q_up = sum(1 for _, l in lines if re.match(r"Q,\d+,-?[\d.]+,-?[\d.]+,-?[\d.]+$", l))
    q_down = sum(1 for _, l in lines if re.match(r"Q,down,\d+,-?[\d.]+,-?[\d.]+,-?[\d.]+$", l))
    q_end = sum(1 for _, l in lines if l.startswith("Q,end,"))
    q_crank = sum(1 for _, l in lines if l.startswith("Q,crank,"))
    q_bad = [l for _, l in lines if l.startswith("Q,") and not re.match(
        r"Q,(\d+|down,\d+),-?[\d.]+,-?[\d.]+,-?[\d.]+$|Q,crank,[-\d.,]+$|Q,end,[-\d.,]+$|Q,none$", l)]
    dumps = 2 * ROUNDS
    print(f"lines {len(lines)}, notifications {len(sizes)} (sizes seen: {sorted(set(sizes))})")
    print(f"'k' x{dumps}: Q up {q_up} (want {25 * dumps}), Q down {q_down} (22 each: {22 * dumps}), "
          f"Q,crank {q_crank}, Q,end {q_end} (want {dumps} each)")
    print(f"glued lines (a lost piece): {len(glued)}")
    for l in glued[:8]:
        print("   ", l[:120])
    print(f"malformed Q lines: {len(q_bad)}  {q_bad[:4]}")
    print(f"S lines with != 16 fields: {len(s_bad)}  {s_bad[:3]}")
    lost = len(glued) + len(q_bad) + len(s_bad) + max(0, 25 * dumps - q_up) + max(0, dumps - q_end)
    print("RESULT:", "pieces were lost" if lost else "no loss seen")


asyncio.run(main())
