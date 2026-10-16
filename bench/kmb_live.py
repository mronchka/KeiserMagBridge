"""Long-running logger for the Keiser M3 Bridge.

Usage: py -3 kmb_live.py PORT LOGFILE CMDFILE MINUTES
  Every line from the board is timestamped and appended to LOGFILE
  (flushed immediately, so it can be read while this runs).
  Any characters appended to CMDFILE are sent to the board, so commands
  can be issued while logging. Reconnects if the port drops.
  Every 5 s it writes "### clock <epoch_ms>" so the log's relative times
  can be lined up with timestamps from elsewhere (e.g. a button panel).
"""
import os
import sys
import time

import serial


def main():
    port, logfile, cmdfile, minutes = sys.argv[1], sys.argv[2], sys.argv[3], float(sys.argv[4])
    open(cmdfile, "w").close()
    cmd_pos = 0
    t0 = time.monotonic()
    end = t0 + minutes * 60
    log = open(logfile, "a", encoding="utf-8", buffering=1)

    def note(text):
        log.write(f"{time.monotonic() - t0:8.2f}  {text}\n")

    ser = None
    buf = b""
    next_clock = 0.0
    while time.monotonic() < end:
        if time.monotonic() >= next_clock:
            note(f"### clock {int(time.time() * 1000)}")
            next_clock = time.monotonic() + 5.0
        if ser is None:
            try:
                ser = serial.Serial(port, 115200, timeout=0.1)
                ser.dtr = True
                note(f"### port {port} open")
            except serial.SerialException:
                time.sleep(1)
                continue
        try:
            buf += ser.read(512)
            size = os.path.getsize(cmdfile)
            if size > cmd_pos:
                with open(cmdfile, "rb") as f:
                    f.seek(cmd_pos)
                    data = f.read()
                cmd_pos = size
                if data:
                    ser.write(data)
                    note(f">>> sent {data.decode(errors='replace')!r}")
        except (serial.SerialException, OSError):
            note("### port lost, retrying")
            ser = None
            continue
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            note(line.decode("utf-8", "replace").rstrip("\r"))
    note("### logger stopped")


if __name__ == "__main__":
    main()
