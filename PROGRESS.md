# SafeBand / RakshaBand — Engineering Progress & System Status

**Repository:** `c:\android_dev\SIH`  
**Date:** September 30, 2026  
**Project:** SafeBand / RakshaBand Wearable Health & Emergency Intelligence System (SIH)

---

## 📑 Executive Summary

Over the recent development cycle, the SafeBand / RakshaBand system has been upgraded from raw prototype telemetry to a production-grade, 100% offline, privacy-first wearable health monitoring system. Key breakthroughs include:
1. **Clinical-Grade Physiological DSP:** Multi-stage artifact rejection, harmonic/dicrotic notch correction, and EWMA filtering on the MAX30102 PPG sensor.
2. **Deterministic Multi-Core FreeRTOS Architecture:** Decoupling high-frequency 100 Hz sampling (Core 1) from heavy mathematical inference and background sensing (Core 0), eliminating watchdog timeouts and schedule drift.
3. **BLE Stack Hardening & Auto-Recovery:** Eliminating GATT descriptor collisions, handshake race conditions, and packet burst storms over Bluetooth Low Energy.
4. **NOAA Environmental Heat Index Integrity:** Fixing unit conversion discrepancies to provide real-time ambient heat risk classification in both °F and °C.
5. **Mobile AI Inference Engine:** 21-class motion classification, Mahalanobis distance physiological anomaly detection, PPG morphology extraction (vascular age & arterial stiffness), and on-device Gemma 3n emergency reasoning.

---

## 🏗️ System Architecture & Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                ESP32 WEARABLE FIRMWARE                                  │
├────────────────────────────────────────────────────┬────────────────────────────────────┤
│                    CORE 1                          │              CORE 0                │
│             (High-Frequency 100 Hz)                │      (Background 1 Hz / 0.5 Hz)    │
├────────────────────────────────────────────────────┼────────────────────────────────────┤
│ • MPU-6050 6-DoF I2C Read (<0.4 ms)                │ • DHT11 Temperature & Humidity     │
│ • MAX30102 FIFO Ingestion (<0.5 ms)                │ • NOAA Heat Index Calculation (°F) │
│ • Fall Detection State Machine                     │ • Maxim HR & SpO2 DSP (0.5 Hz)     │
│ • Staggered BLE Notify (50Hz Motion, 50Hz Vitals)  │ • Clinical Artifact & EWMA Filter  │
│ • taskYIELD() & Schedule Drift Guard               │ • Serial Diagnostics & Buzzer      │
└─────────────────────────┬──────────────────────────┴─────────────────┬──────────────────┘
                          │                                            │
                          │   BLE GATT Stream (18-byte packets)        │
                          ▼                                            ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                REACT NATIVE MOBILE APP                                  │
├─────────────────────────────────────────────────────────────────────────────────────────┤
│ • useBle Hook: Auto-reconnect, Mutex-guarded connection, 100ms staggered CCCD monitor   │
│ • EpisodeEngine (2 Hz Windowing): 200-sample sliding windows, 1332 feature extraction   │
│ • FeatureExtraction: 4th-order Butterworth filter, PPG morphology, HRV (RMSSD), cBP    │
│ • MathematicalEngine: Mahalanobis distance outlier detection, NEWS2 baseline EWMA       │
│ • DiagnosticReasoningEngine: Multi-hypothesis clinical rule engine                      │
│ • LocationEngine: GPS accuracy gating, spatial vector radar, familiar centroid dwell    │
│ • Gemma 3n On-Device Agent: Privacy-first local LLM emergency guidance & tool calling   │
│ • SQLite Database: 10 relational tables, 30-day automated retention policy              │
└─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Work Done & Key Milestones

### 1. 🫀 MAX30102 Clinical Vital Processing & Artifact Rejection
- **The Problem:** Raw peak detection algorithms suffered from **dicrotic notch double-counting** (falsely jumping to ~150–200 BPM) and **missed-peak half-counting** (falsely dropping to ~38–46 BPM) on minor finger pressure variations.
- **The Solution ([`VitalSensor.cpp`](file:///c:/android_dev/SIH/esp%20firmware/src/VitalSensor.cpp)):**
  1. **Finger Contact Gating:** When IR amplitude $< 20,000$, outputs `-1` ("Calculating") and auto-resets baseline states.
  2. **Harmonic / Sub-Harmonic Correction:** Detects if a new reading is $\sim 2\times$ baseline ($1.75\times$ to $2.25\times$) or $\sim 0.5\times$ baseline ($0.40\times$ to $0.60\times$) and scales back to the fundamental cardiac frequency.
  3. **Physiological Slew-Rate Limiter:** Clamps instantaneous jumps $> 18\text{ BPM}$ in 2 seconds to at most $\pm 4\text{ BPM}$ unless sustained over 3 consecutive cycles (handling true exertion shifts).
  4. **Clinical EWMA Smoothing:** Applied temporal smoothing ($\alpha = 0.30$ for HR, $\alpha = 0.20$ for SpO2) for stable, glitch-free clinical display.

### 2. ⚡ FreeRTOS Multi-Core Scheduling & Loop Optimization
- **The Problem:** Running the heavy Maxim SpO2 algorithm inside the 100 Hz `SamplerTask` on Core 1 blocked the loop for 15–25 ms, exceeding the 10.0 ms budget and causing `vTaskDelayUntil` to burst 5 packets in 8 ms, overflowing the BLE buffer and dropping connections.
- **The Solution ([`main.cpp`](file:///c:/android_dev/SIH/esp%20firmware/src/main.cpp)):**
  1. **Decoupled Tasks:** `SamplerTask` (Core 1) does only pure FIFO sensor reads and BLE transmissions ($< 1.2\text{ ms}$ runtime).
  2. **Extracted Heavy DSP:** Extracted `VitalSensor::updateVitalsCalculation()` to run at **0.5 Hz in `EnvironmentTask` on Core 0**.
  3. **Schedule Drift Protection:** Added `if ((nowTick - xLastWakeTime) > (xFrequency * 2)) xLastWakeTime = nowTick;` to prevent burst storms after any transient I2C delay.
  4. **Task Stack Expansion:** `SamplerTask` stack expanded from 4 KB $\rightarrow$ 8 KB; `EnvironmentTask` expanded to 6 KB.

### 3. 📡 BLE Reliability, CCCD Negotiation & Auto-Reconnect
- **The Problem:** Android's Bluetooth stack aborted connections due to concurrent CCCD descriptor writes (`GATT_BUSY`) and simultaneous connection attempts from un-cleared event listeners.
- **The Solution ([`useBle.js`](file:///c:/android_dev/SIH/mobile_app/src/hooks/useBle.js) & [`BLEManager.cpp`](file:///c:/android_dev/SIH/esp%20firmware/src/BLEManager.cpp)):**
  1. **Staggered Subscriptions:** Added 100 ms delays between characteristic monitor attachments (`STATUS`, `SENSOR`, `FEATURE`) so Android writes descriptors cleanly.
  2. **Connection Mutex & Subscription Hygiene:** Added `isConnectingRef` guard and `disconnectSubscriptionRef` to cancel stale listeners and prevent connection storms.
  3. **Auto-Reconnect Guard:** Automatically schedules reconnection 3 seconds after an unexpected loss while respecting user-initiated disconnects.
  4. **Standard GAP Parameters:** Removed intrusive connection parameter updates in `onConnect`, relying on standard BLE advertising interval hints (`setMinPreferred(0x10); setMaxPreferred(0x20)`).

### 4. 🌡️ NOAA Environmental Heat Index Calculation
- **The Problem:** The Adafruit DHT `computeHeatIndex` formula expects Fahrenheit input when `isFahrenheit = true`. Passing Celsius caused the formula to calculate a 25°F baseline, outputting freezing/negative numbers on the dashboard.
- **The Solution ([`EnvironmentSensor.cpp`](file:///c:/android_dev/SIH/esp%20firmware/src/EnvironmentSensor.cpp)):**
  - Converted temperature to Fahrenheit (`tF = (t * 1.8f) + 32.0f`) prior to computing the heat index.
  - Handled floating-point signed zero `Object.is(val, -0)` in [`SignalsCard.js`](file:///c:/android_dev/SIH/mobile_app/src/components/SignalsCard.js). Ambient heat index now reads accurately (e.g., 93.7°F / 34.3°C).

### 5. 🧠 Mobile Inference & UI Modernization
- **PPG Morphology Pipeline:** Decoupled vascular age and arterial stiffness from raw HR/SpO2 gating in [`SignalsCard.js`](file:///c:/android_dev/SIH/mobile_app/src/components/SignalsCard.js) so the 4th-order Butterworth filter displays morphology as soon as the optical buffer fills.
- **"Acquiring..." UI States:** Replaced confusing `--` placeholders with clear "Acquiring..." badges during the initial 5-second calibration window for HRV and Vascular Age.
- **Dashboard Section Renaming:** Updated UI card header from "Diagnostic Reasoning Engine" to **"Inference Engine"** in [`DashboardTab.js`](file:///c:/android_dev/SIH/mobile_app/src/components/DashboardTab.js).
- **Infinite Render Loop Fix:** Fixed `setCurrentPacket` trigger frequency by throttling packet distribution to the 2 Hz inference window in `useBle.js`.

---

## 📦 Canonical BLE Packet Specification

| Packet Type | ID | Size | Rate | Description |
|---|---|---|---|---|
| **MOTION** | `0x01` | 18 B | 100 Hz (staggered) | `[0x01, ts(4B), ax(2B), ay(2B), az(2B), gx(2B), gy(2B), gz(2B), chk(1B)]` |
| **STATUS** | `0x02` | 10 B | 1% Batt / 5 min | `[0x02, batt(1B), fwMaj(1B), fwMin(1B), uptimeSec(4B), isConn(1B), chk(1B)]` |
| **ENVIRONMENT** | `0x03` | 18 B | 1 Hz | `[0x03, ts(4B), tempC(4B float), humid(4B float), heatIndexF(4B float), chk(1B)]` |
| **VITAL** | `0x04` | 18 B | 100 Hz (staggered) | `[0x04, ts(4B), red(4B), ir(4B), heartRate(2B int16), spo2(1B int8), rsv(1B), chk(1B)]` |

---

## ✅ Test & Verification Results

### 1. ESP32 Firmware Build
- **Toolchain:** PlatformIO (`esp32dev` / `framework-arduinoespressif32`)
- **Result:** `[SUCCESS] Took 12.53 seconds`
- **RAM Usage:** 14.2% (46.4 KB / 327.6 KB)
- **Flash Usage:** 38.0% (1.19 MB / 3.14 MB)

### 2. Mobile App Unit & Integrity Test Suites
- **Test Command:** `node test_packet_pipeline.mjs; node test_engines.mjs`
- **Results:**
  - ✅ **Database Initialization & 10 Tables Schema Check** — PASS
  - ✅ **Feature Extraction & Model v3 Pipeline (1332 features + 32D embedding)** — PASS
  - ✅ **PPG Morphology, HRV (RMSSD), and Continuous Blood Pressure (cBP)** — PASS
  - ✅ **NOAA Heat Index Normal & Danger Tiers** — PASS
  - ✅ **Mathematical Engine (Mahalanobis & NEWS2 Baselines)** — PASS
  - ✅ **Diagnostic Reasoning Engine (Exertion, Heat Stress, Respiratory, Fall)** — PASS
  - ✅ **Location Engine (Centroid Dwell, Proximity Radar, Stale Watchdog)** — PASS
  - ✅ **Context Engine Threat Scoring & Emergency Thresholds** — PASS
  - ✅ **Gemma 3n On-Device AI Guidance & Function Tool Calling** — PASS
  - ✅ **Background 30-Day Retention Policy & Recalibration** — PASS
  - ✅ **Packet Serialization & Translation Pipeline** — PASS

---

## 🚀 Quick Start / Running the Codebase

### Flashing Firmware
```powershell
cd "c:\android_dev\SIH\esp firmware"
pio run -t upload
```

### Running Mobile App
```powershell
cd "c:\android_dev\SIH\mobile_app"
npx expo start
```
Scan the QR code in Expo Go / Development Client to launch RakshaBand.
