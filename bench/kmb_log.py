"""Talk to the Keiser M3 Bridge over USB serial and log its output.

Usage: py -3 kmb_log.py PORT LOGFILE STEP [STEP ...]
  STEP is "<cmd>:<seconds>" -> send cmd (one letter, or "" to send nothing),
  then keep reading for <seconds>. Every received line is timestamped,
  printed, and appended to LOGFILE.
"""
import sys
import time

import serial


def main():
    port, logfile, steps = sys.argv[1], sys.argv[2], sys.argv[3:]
    t0 = time.monotonic()
    with serial.Serial(port, 115200, timeout=0.1) as ser, \
            open(logfile, "a", encoding="utf-8") as log:
        ser.dtr = True  # nRF52 USB serial only talks once DTR is asserted
        buf = b""

        def pump(seconds):
            nonlocal buf
            end = time.monotonic() + seconds
            while time.monotonic() < end:
                buf += ser.read(512)
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    text = line.decode("utf-8", "replace").rstrip("\r")
                    stamped = f"{time.monotonic() - t0:8.2f}  {text}"
                    print(stamped, flush=True)
                    log.write(stamped + "\n")
            log.flush()

        pump(0.5)
        for step in steps:
            cmd, _, secs = step.rpartition(":")
            if cmd:
                ser.write(cmd.encode())
                log.write(f"{time.monotonic() - t0:8.2f}  >>> sent '{cmd}'\n")
            pump(float(secs))


if __name__ == "__main__":
    main()
