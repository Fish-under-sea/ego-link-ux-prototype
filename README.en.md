> **🟢 Actively maintained** · Last updated: 2026-09-28
>
> The course is in progress; work is committed incrementally week by week.

<div align="center">

# Ego Link · AI Interaction Prototype

**A minimal interaction loop: ESP32-S3-EYE → server → web**

Course project for *AI Interaction Prototyping and UX Design* · S2 experimental class · 18 weeks × 4 hours

<sub>Running example: the **Ego Link wearable smart terminal** — this repository carries its minimum viable loop and evolves week by week.</sub>

[简体中文](README.md) · **English**

</div>

---

## 📌 What this repository does

It wires an ESP32-S3-EYE board, a server, and a web page into a **loop that actually runs**:

```
┌─────────────────────┐        ┌──────────────────┐        ┌─────────────────┐
│  ESP32-S3-EYE       │        │  Server          │        │  Web page       │
│  On-board capture   │ ─────► │  Receive · store │ ─────► │  Control and    │
│  and feedback       │  serial│  · query         │  HTTP  │  status display │
│  (camera + IMU +    │ network│  (student VPS    │        │                 │
│   LCD + microphone) │        │   role)          │        │                 │
└─────────────────────┘        └──────────────────┘        └─────────────────┘
```

The course runs in **six units over 18 weeks**, one theme per unit and one verifiable increment per week.

## 🎯 Six-unit progress

| Unit | Weeks | Theme | Status |
|:----:|:-----:|-------|--------|
| 1 | 1–3 | Minimal interaction loop and device feedback | ✅ **Weeks 1–3 accepted** |
| 2 | 4–6 | Natural-language and voice task interaction | 🔄 **Week 4 accepted**, in progress |
| 3 | 7–9 | Visual perception and event feedback | ⬜ Not started |
| 4 | 10–12 | Multi-source state and proactive interaction | ⬜ Not started |
| 5 | 13–15 | Device-cloud collaboration and failure recovery | ⬜ Not started |
| 6 | 16–18 | Technical experience testing and prototype iteration | ⬜ Not started |

## 🧰 Hardware and environment

| Item | Specification |
|------|---------------|
| Development board | **ESP32-S3-EYE** |
| MCU | ESP32-S3-WROOM-1-**N8R8** (8 MB flash / 8 MB PSRAM) |
| Camera | **OV2640** |
| Display | **ST7789** 240×240 LCD |
| Motion sensing | **QMA6100P** six-axis IMU |
| Audio | On-board microphone |
| Storage | microSD |
| Serial port | **COM4** (ESP32-S3 native USB serial, VID:PID = `303A:1001`) |

**Tech stack**:

| Layer | Implementation |
|-------|----------------|
| Board | PlatformIO + Arduino/ESP32-S3 |
| Server | **Python standard-library `http.server`** (`ThreadingHTTPServer`, zero third-party dependencies — runs directly on any classroom machine) |
| Frontend | Plain HTML / JS (served by the server, see `web/`) |
| Helper tooling | Node.js — `imu-monitor` (`serialport` + `ws`, serial monitoring and push) |

**Scripts provided by `package.json`** (`imu-monitor`):

| Script | Purpose |
|--------|---------|
| `npm start` | Start the serial monitoring service |
| `npm run ports` | List available serial ports |
| `npm run test` | Run tests |
| `npm run firmware:build` | Build the firmware |
| `npm run firmware:flash` | Flash the firmware |
| `npm run firmware:monitor` | Monitor the serial port |
| `npm run wifi:set` | Configure Wi-Fi |

## 🚀 Quick start

### 1️⃣ Board (PlatformIO)

```bash
cd board
cp src/secrets.example.h src/secrets.h   # First run: fill in Wi-Fi and server address
pio run -t upload -t monitor
```

> `secrets.h` is ignored by `.gitignore` and **never** enters version control — credentials stay on your machine only.

### 2️⃣ Server + page

```bash
python server/app.py                     # Listens on 0.0.0.0:8000 and also serves web/
```

Open `http://<your-ip>:8000/` in a browser to view the sensor data.

## 📁 Directory structure

| Directory | Purpose |
|-----------|---------|
| `board/` | Board application (PlatformIO + Arduino/ESP32-S3) |
| `server/` | Receive + store + query service (the student-run VPS role) |
| `web/` | Control and status pages |
| `docs/` | Weekly reports, test records, interface and state documentation |
| `firmware/`, `public/`, `scripts/`, `test/` | Firmware, static assets, helper scripts, and tests |

## 📅 Weekly acceptance records

Every week's acceptance process is archived and can be reviewed week by week:

| Week | Record |
|:----:|--------|
| Week 1 | [`docs/week-01-验收记录.md`](docs/week-01-验收记录.md) |
| Week 2 | [`docs/week-02-验收记录.md`](docs/week-02-验收记录.md) |
| Week 3 | [`docs/week-03-验收记录.md`](docs/week-03-验收记录.md) |
| Week 4 | [`docs/week-04-验收记录.md`](docs/week-04-验收记录.md) |

Supplementary documents:

- [`docs/imu-monitor-README.md`](docs/imu-monitor-README.md) — IMU monitoring notes
- [`docs/week2-remote-collect.md`](docs/week2-remote-collect.md) — Week 2 remote collection
- [`docs/week3-button-feedback.md`](docs/week3-button-feedback.md) — Week 3 button feedback
- [`docs/经验总结-ESP32-S3-EYE.md`](docs/经验总结-ESP32-S3-EYE.md) — development board pitfalls and lessons
- [`ASSIGNMENT.md`](ASSIGNMENT.md) · [`INTEGRATION.md`](INTEGRATION.md) — assignment requirements and integration notes

## 📝 Commit conventions

**One independent commit per week**, in this strict order:

```
Finish this week's task  →  Pass in-class verification  →  Commit this week  →  Move on to the next week
```

Commit message format: `feat(w0N): <short description>`

## 🔒 Safety conventions

- Keys, server passwords, and real location data **never** enter source code, screenshots, or reports (see `.gitignore`)
- The camera is **triggered on request/event**, not continuously recording; the teaching scenario contains no personal sensitive information
- **Unverified capabilities are never written up as "passed"**; simulated and replayed results must be clearly labelled

---

<sub>Course page: https://ai.openkub.com/courses/ai-interaction-ux/ · This repository is a course project, committed incrementally week by week</sub>
