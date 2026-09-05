# Jarvis — Hardware Guide

## Parts list (per room topology)

### Central hub (~1 per home)
| Part | Notes |
|---|---|
| Raspberry Pi 5 (or 4, 4 GB+) | The brain: hub service, wake-word/STT fallback, skill orchestration |
| Official 7" touchscreen **or** repurposed tablet | Runs `dashboard.html` in kiosk mode (see below) |
| Pi Camera v3 **or** USB webcam | Vision features; fit a physical shutter for privacy |
| MicroSD 32 GB+ / NVMe | Pi OS Lite 64-bit |
| Good PSU (official 27 W for Pi 5) | Undervoltage breaks audio pipelines |

### Satellite node (~1 per room)
| Part | Notes |
|---|---|
| ESP32 DevKit (ESP32-S3 if you want on-device wake via ESP-SR) | Runs `satellite/esp32/jarvis_satellite` |
| INMP441 I2S microphone | Mic for STT streaming |
| MAX98357A I2S amp + 4–8 Ω speaker | Spoken replies |
| DHT22 (AM2302) | Temp/humidity |
| HC-SR501 PIR **or** LD2410 mmWave | Presence (mmWave is better at detecting still people) |
| Optional: MH-Z19 / SGP30 | CO2 / air quality |
| USB-C 5 V 2 A PSU | |

## Wiring (ESP32 satellite)

Default pins used by `jarvis_satellite.ino` — change the `#define`s to taste.

| Peripheral | Peripheral pin | ESP32 pin |
|---|---|---|
| INMP441 | SCK | GPIO26 (shared BCLK) |
| INMP441 | WS | GPIO25 |
| INMP441 | SD | GPIO33 |
| INMP441 | L/R | GND (left channel) |
| INMP441 | VCC / GND | 3V3 / GND |
| MAX98357A | BCLK | GPIO26 (shared) |
| MAX98357A | LRC | GPIO25 |
| MAX98357A | DIN | GPIO27 |
| MAX98357A | VCC / GND | 5V (VIN) / GND |
| DHT22 | DATA | GPIO15 (+10 kΩ pull-up to 3V3) |
| DHT22 | VCC / GND | 3V3 / GND |
| PIR (HC-SR501) | OUT | GPIO13 |
| PIR | VCC / GND | 5V (VIN) / GND — check level at OUT stays 3.3 V-compatible |
| Wake button | — | GPIO0 ↔ GND (BOOT button works) |

## Hub kiosk display

On the Pi (or any tablet), point a fullscreen browser at the hub:

```bash
# Raspberry Pi OS — chromium kiosk
chromium-browser --kiosk --autoplay-policy=no-user-gesture-required \
  http://192.168.1.10:8080/dashboard.html
```

The dashboard shows the breathing ring, clock, weather, calendar, sensors,
satellites, and camera thumbnails — same cream/coral theme as the app.

## Enclosure

Any off-the-shelf Pi case with GPIO/camera ribbon clearance works for the hub.
For satellites, a small 3D-printable wedge targeting ~100 × 70 × 35 mm fits the
DevKit + INMP441 + MAX98357A + speaker; print in matte PLA, include:

- 3 mm mic port holes above the INMP441 slot
- speaker grille (≥40% open area) over the MAX98357A chamber
- rear venting for the DHT22 (never seal temp sensors inside)
- a lid over the camera if you mount vision hardware — software privacy is
  table stakes, a physical shutter is the guarantee

(STL files intentionally not checked in — dimensions above are the spec any
parametric model can follow, e.g. a 20-minute OpenSCAD job. Flagged in the
README as a physical-build deliverable.)

## Networking & graceful degradation

- Everything is LAN: hub binds `0.0.0.0:8080`; satellites hard-fail to
  backoff-and-retry and the hub **announces dropouts** (toast + event log)
  instead of failing silently.
- Commands addressed to an offline satellite queue per-node (max 50) on the
  hub and flush on reconnect.
- Give the Pi a DHCP reservation (`192.168.1.10` in the examples).
