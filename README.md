# Keiser M3 Bridge

DIY Bluetooth power bridge for a Keiser M3 bike, built on an Adafruit CLUE (nRF52840). A magnetometer reads the resistance magnet position to infer gear, and the bridge reports power and cadence over Bluetooth.

- `KeiserMagBridge_v3_1/` – current firmware (earlier versions in `KeiserMagBridge_v2/`, `KeiserMagBridge_v3/` and the root `.ino`)
- `webapp/` – phone page for riding, calibrating and diagnostics. Live at https://mronchka.github.io/KeiserMagBridge/ (deployed from `main` by `.github/workflows/pages.yml` whenever `webapp/` changes)
- `product/` – product page source (template, field data, `build.py`). Built into `webapp/product/` and live at https://mronchka.github.io/KeiserMagBridge/product/
- `bench/` – USB loggers, analysis scripts, test protocol, notes and raw logs
- `dashboard/` – findings dashboard and its data
