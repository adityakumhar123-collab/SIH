# SafeBand / RakshaBand — Project Current Status
**Last Updated:** 2026-09-29  
**Workspace:** `c:\android_dev\SIH`  
**Purpose:** Full context handoff document for any agent continuing this codebase.

---

## 1. Project Overview

SafeBand (branded RakshaBand in the mobile app) is a wearable health monitoring system submitted for SIH (Smart India Hackathon). It consists of two sub-projects:

| Sub-Project | Path | Language |
|---|---|---|
| ESP32 Firmware | `esp firmware/` | C++ (Arduino / PlatformIO) |
| Mobile App | `mobile_app/` | React Native (JavaScript) |

**Core purpose:** Detect falls, monitor physiological vitals (HR, SpO2, HRV), classify activity (21 classes), and generate AI-driven health guidance — all in real-time via BLE.

---

## 2. Hardware

| Component | Part | Status |
|---|---|---|
| Microcontroller | ESP32 (custom MAC: `90:70:69:11:69:55`) | Working |
| IMU | MPU-6050 (I2C: 0x68/0x69) | Working |
| PPG / Pulse Oximeter | MAX30102 (I2C: 0x57) | Working |
| Environment Sensor | DHT11 (GPIO 33) | Working |
| Barometric Pressure | BMP280 — **REMOVED** | Not present — never re-add |
| Buzzer | GPIO 26 | Working |
| Battery ADC | `VBAT_READ_PIN = -1` | Not wired — stub returns 100% |

**Pin Mapping (`Config.h`):**
```
I2C_SDA = GPIO 27   I2C_SCL = GPIO 25
BUZZER  = GPIO 26   DHT11   = GPIO 33
```

> **CRITICAL:** BMP280 / pressure is completely removed. Never re-add it to the packet design or processing pipeline. `envWelford` only tracks `[Temp, Humidity]` (2D, not 3D).

---

## 3. BLE Protocol — Canonical Packet Specification

**BLE Device Name:** `SafeBand-ESP32`  
**Service UUID:** `4fafc201-1fb5-459e-8fcc-c5c9c331914b`  
**MTU:** 64 bytes (negotiated)  
**Endianness:** Little-Endian for all multi-byte integers  
**Checksum:** XOR of all bytes from index 0 to N-2

### Characteristics

| UUID | Direction | Purpose |
|---|---|---|
| `c083bcf3-...` | Write | Commands (0x01–0x05, 0xFF) |
| `d2b781e9-...` | Read | Device Info / firmware version string |
| `8f1f7e34-...` | Notify | `0x02` Status packets |
| `c9298492-...` | Notify | `0x01` Motion packets (100 Hz) |
| `e2e0a294-...` | Notify | `0x03` Environment + `0x04` Vital packets |

### Packet Layouts (CANONICAL — as of 2026-09-29)

#### `0x01` MOTION — 18 bytes — 100 Hz
```
[0]      uint8_t   0x01
[1..4]   uint32_t  timestamp ms (little-endian)
[5..6]   int16_t   ax  (milli-g, 1000 mg = 1.0g)
[7..8]   int16_t   ay  (milli-g)
[9..10]  int16_t   az  (milli-g)
[11..12] int16_t   gx  (0.1 deg/sec units)
[13..14] int16_t   gy  (0.1 deg/sec units)
[15..16] int16_t   gz  (0.1 deg/sec units)
[17]     uint8_t   XOR checksum
```
> Note: `packet_design.md` spec calls gyro `int32_t` milli-dps. The **implemented** version uses `int16_t` at 0.1 dps. Do NOT change — mobile app parser matches this.

#### `0x02` STATUS — 10 bytes — every 5 min or on 1% battery change
```
[0]      uint8_t   0x02
[1]      uint8_t   battery %
[2]      uint8_t   firmware major
[3]      uint8_t   firmware minor
[4..7]   uint32_t  uptime seconds
[8]      uint8_t   BLE connected flag (1/0)
[9]      uint8_t   XOR checksum
```

#### `0x03` ENVIRONMENT — 18 bytes — 1 Hz
```
[0]      uint8_t   0x03
[1..4]   uint32_t  timestamp ms
[5..8]   float32   temperature deg C
[9..12]  float32   relative humidity %
[13..16] float32   heat index deg F  (NOAA Rothfusz)
[17]     uint8_t   XOR checksum
```
> Note: `packet_design.md` spec says fixed-point int16 x10. **Implemented** version uses float32. Do NOT change — mobile parser uses `readFloat32LE`.

#### `0x04` VITAL — 18 bytes — 100 Hz  (UPDATED 2026-09-29)
```
[0]      uint8_t   0x04
[1..4]   uint32_t  timestamp ms
[5..8]   uint32_t  raw Red channel (MAX30102 ADC count)
[9..12]  uint32_t  raw IR channel  (MAX30102 ADC count)
[13..14] int16_t   heartRate BPM  (-1 = calculating / accumulating optical buffer)
[15]     int8_t    spo2 %         (-1 = calculating / accumulating optical buffer)
[16]     uint8_t   0x00 (reserved)
[17]     uint8_t   XOR checksum
```
> The firmware reports HR/SpO2 from the **Maxim algorithm (`spo2_algorithm.h`) evaluated every 2 seconds**. Mobile consumes these directly. Mobile does NOT recompute HR, SpO2, or Heat Index — it only processes Motion features and 3 vital features: PPG Morphology, HRV, and Continuous Blood Pressure (cBP).

### BLE Commands (write to COMMAND characteristic)
```
0x01 = Start streaming
0x02 = Stop streaming
0x03 = Request immediate status packet
0x04 = Acknowledge event
0x05 = Calibration request
0xFF = Emergency cancel (fall alarm)
```

---

## 4. Firmware Architecture (`esp firmware/src/`)

### File Map

| File | Role |
|---|---|
| `main.cpp` | FreeRTOS tasks: `SamplerTask` (100 Hz, Core 1), `EnvironmentTask` (1 Hz, Core 0), `BuzzerTask` (20 Hz, Core 0) |
| `Config.h` (in `include/`) | All constants, pins, thresholds, UUIDs |
| `IMUSensor.h/.cpp` | MPU-6050 driver — produces `IMUData {ax,ay,az,gx,gy,gz}` in g and dps |
| `VitalSensor.h/.cpp` | MAX30102 driver — produces `VitalData {red,ir,heartRate,spo2,signalQuality,fingerDetected}` |
| `EnvironmentSensor.h/.cpp` | DHT11 driver — produces `EnvironmentData {temperature,humidity,heatIndexF,isAvailable}` |
| `BLEManager.h/.cpp` | All BLE GATT setup and packet serialization |
| `EdgeAnalytics.h/.cpp` | On-device heuristic: fall detection state machine + 3-class motion + physio anomaly |
| `FeatureExtractor.h/.cpp` | 144-feature vector extraction from 200-sample IMU window |
| `ModelRunner.h/.cpp` | TFLite Micro inference runner — outputs anomaly score + 16D motion embedding |
| `PowerManager.h/.cpp` | Battery % (stub — VBAT pins unconnected) |
| `BuzzerManager.h/.cpp` | Non-blocking tone sequencer |

### FreeRTOS Task Summary

```
Core 1 — SamplerTask (priority 10, 10ms / 100 Hz)
  IMUSensor.readSample()  -> EdgeAnalytics.processIMUSample() -> BLE sendMotionPacket()
  VitalSensor.readSample() -> EdgeAnalytics.processVitalSample() -> BLE sendVitalPacket()

Core 0 — EnvironmentTask (priority 3, 1000ms / 1 Hz)
  EnvironmentSensor.readSample() -> EdgeAnalytics.processEnvironmentSample() -> BLE sendEnvironmentPacket()
  Battery check -> BLE sendStatusPacket() (if changed or 5min elapsed)
  Serial diagnostics dump (every 2s)

Core 0 — BuzzerTask (priority 2, 20ms)
  BuzzerManager.update()
  BLEManager.handleConnectionStatus()
```

### VitalSensor — Important Detail
- MAX30102 at 400 Hz hardware ADC, 4x average -> ~100 Hz effective output
- Rolling 100-sample buffer (`redBuffer[100]`, `irBuffer[100]`)
- Maxim `spo2_algorithm.h` runs **every 2000ms** when `latestIr >= 20000` (finger detected)
- `signalQuality` field still exists in `VitalData` but is **no longer transmitted** in the BLE packet

### EdgeAnalytics — Heuristic Engine (Firmware-Side)
- **Fall Detection FSM:** IDLE -> TROUGH (< 0.65g) -> IMPACT (> 2.2g + gyro > 180 dps) -> MONITORING_REST -> COUNTDOWN (10s)
- **Motion Classification:** 3-class (REST/WALK/RUN) via 4D Welford/Mahalanobis [AccelRMS, GyroRMS, Periodicity, Cadence]
- **Physiological Anomaly:** 2D [HR, SpO2] Welford deviation check
- **Environmental Anomaly:** 2D [Temp C, Humidity%] Welford deviation check
- Does NOT transmit its classifications directly — it controls buzzer and fall countdown locally only

---

## 5. Mobile App Architecture (`mobile_app/src/`)

### File Map

| File | Role |
|---|---|
| `BleService.js` | Binary packet deserializer (all 4 packet types). Import `parseIncomingPacket`, `base64ToUint8Array`. |
| `hooks/useBle.js` | React hook — manages BLE state machine, dispatches packets to EpisodeEngine |
| `EpisodeEngine.js` | Central 2 Hz inference orchestrator — sliding window, activity classification, PPG processing, episode management |
| `FeatureExtraction.js` | 144-feature IMU pipeline + `processPpgWaveform()` + `computeHeatIndex()` |
| `MathematicalEngine.js` | Mahalanobis distance, per-dimension z-scores, EWMA baseline adaptation |
| `DiagnosticReasoningEngine.js` | 5-hypothesis explainable clinical reasoning engine |
| `GemmaAgent.js` | Conversational health agent with on-device SQLite tool calling |
| `GemmaService.js` | Gemma 3n inference via `NativeModules.GemmaLocalModule` (or fallback synthesizer) |
| `ContextEngine.js` | Fuses vitals + location + activity into spatial health context |
| `LocationEngine.js` | GPS familiarity scoring, geofencing |
| `Database.js` | SQLite schema + all read/write queries (episodes, diagnostic_events, baseline_states, contacts, etc.) |

### Data Flow (Per 500ms Inference Tick)

```
BLE Notification
  useBle.js: base64ToUint8Array() -> parseIncomingPacket()
       MOTION packet -> EpisodeEngine.pushMotionSample([ax,ay,az,gx,gy,gz])
       VITAL  packet -> EpisodeEngine.pushVitalSample(red, ir)
                        (parsed.heartRate, parsed.spo2 also available from firmware — informational)
       ENV    packet -> EpisodeEngine.pushEnvironmentSample(tempC, humPct, heatIndexF)

EpisodeEngine.processWindow() — fires every 50 IMU samples (500ms)
  1. extractWindowFeatures(imuBuffer[200])    -> { seqRaw[1320], globRaw[12] }
  2. standardizeFeatures(seqRaw, globRaw)     -> { seqNorm, globNorm }
  3. generateFallbackEmbedding(...)            -> 32D unit vector
  4. classifyEmbedding(embedding)             -> activityClass (21 classes) + confidence
  5. processPpgWaveform(redBuffer, irBuffer, imuWindow)
     -> ONLY 3 vital features: { hrv, arterialStiffness, vascularAge, pttMs, cBP: {sys, dia} }
     -> (HR and SpO2 are consumed directly from firmware Maxim algorithm)
  6. Environmental Heat Index: Consumed directly from firmware DHT computeHeatIndex()
     -> mapped to hazard tier { heatIndexF, heatIndexC, tier, riskLevel }
  7. MathematicalEngine.evaluateDomain('physiology', [hr, spo2])   -> physEval
  8. MathematicalEngine.evaluateDomain('environment', [temp, rh])  -> envEval
  9. DiagnosticReasoningEngine.evaluate(context)                   -> diagnosticContract
 10. GemmaService.generateGuidance(diagnosticContract)             -> latestGuidance
 11. Episode open/extend/close in SQLite
```

### 21 Activity Classes
```
bicep_curl, catching, drinking_bottle, eating, handshake, handwash,
jumping, keeping_shoes, laying, proud_cheer, pushups, running,
scrolling, stairs_slowly, stairs_vigorously, standing, tricep_curl,
typing, walking_briskly, walking_fast, wearing_shoes
```

### `processPpgWaveform()` — PPG DSP Pipeline
Inputs: `redSamples[]`, `irSamples[]`, optional `imuWindow[]`  
Requires minimum 50 samples; optimal window is 200+ samples.

1. Moving average low-pass filter (7-sample = 70ms) -> `filteredIr`, `filteredRed`
2. DC baseline via mean -> `dcRed`, `dcIr`; finger check: `dcIr < 1000` -> abort
3. AC signal = filtered - DC; peak-to-peak amplitude
4. Systolic peak detection (prominence > 40% of p2p, min 400ms apart = 150 BPM cap)
5. Heart Rate from median-filtered RR intervals (350-1500ms valid range)
6. HRV RMSSD from successive RR differences
7. SpO2 via Ratio-of-Ratios: `R = (acRed/dcRed) / (acIr/dcIr)`, `SpO2 = 110 - 25*R`
   - Clinical gate: if quality < 30 or R out of [0.35, 1.25] -> fallback 98.0%
8. VPG (first derivative) and APPG (second derivative) of AC IR signal
9. Arterial Stiffness from a-wave / b-wave ratio in APPG (`-b/a`)
10. Vascular Age = `25 + (stiffness - 0.60) * 45` (clamped 18-85)
11. PTT from IMU mechanical spike vs PPG systolic peak cross-match
12. Continuous BP = `cBP = alpha*ln(PTT) + beta` (sys: `120 - 22*ln(PTT/220)`, dia: `80 - 15*ln(PTT/220)`)

---

## 6. Inference Engine Status

### Firmware-Side

| Component | Status | Notes |
|---|---|---|
| Fall detection FSM | DONE | `EdgeAnalytics.cpp` — 5-state machine, thresholds in `Config.h` |
| 3-class motion (Welford) | DONE | Online Welford + N-dim Mahalanobis; seeded centroids in `EdgeAnalytics::begin()` |
| TFLite Micro ModelRunner | IMPLEMENTED BUT DISCONNECTED | `ModelRunner.cpp` fully implemented. `EdgeAnalytics` does NOT call it. |
| FeatureExtractor | DONE | Full 144-feature extraction — same schema as mobile-side `extractWindowFeatures()` |
| Model file | PRESENT | `include/model_data.h` — 954 KB. Autoencoder: reconstruction error (anomaly) + 16D embedding output |

> **Gap:** Wire `FeatureExtractor` -> `ModelRunner` inside `EdgeAnalytics::evaluateMotionWindow()`. Currently only Welford Mahalanobis is used. `sendFeaturePacket()` exists in BLEManager but is never called.

### Mobile-Side

| Component | Status | Notes |
|---|---|---|
| 21-class activity classification | DONE | Uses `generateFallbackEmbedding()` (JS projection) when native TFLite unavailable |
| Native TFLite path | NOT WIRED | `fast-tflite` native module path not yet connected. Fallback always used. |
| PPG waveform DSP | DONE | `processPpgWaveform()` — full pipeline per §5 above |
| Mahalanobis baselines | DONE | `MathematicalEngine.js` — 3 domains: physiology, environment, motion |
| Diagnostic reasoning | DONE | `DiagnosticReasoningEngine.js` — 5 hypotheses + hard-bound bypass |
| Gemma guidance | DONE | `GemmaAgent.js` + `GemmaService.js` |
| Episode persistence | DONE | SQLite via `Database.js` |

---

## 7. Known Bugs & Issues

### Bug 1 — `DiagnosticReasoningEngine` comment mentions pressure in envEval
**File:** `mobile_app/src/DiagnosticReasoningEngine.js` line ~50  
**Issue:** The `envEval` param description says `[temp, rh, press]` (3D), but the Mahalanobis baseline is only 2D `[Temp, Humidity]`. Verify that the actual `evaluateDomain('environment', ...)` call at its invocation site only passes `[temp, rh]`.  
**Action:** Audit `DiagnosticReasoningEngine.js` lines 50-80 and the call in `EpisodeEngine.js`.

### Bug 2 — `ContextEngine.js` references 3D environmental space including pressure
**File:** `mobile_app/src/ContextEngine.js` line 13  
**Issue:** Comment says "3D environmental space [Temp, Humidity, Pressure]" — pressure removed.  
**Action:** Audit whether `ContextEngine` passes pressure to any distance calculation. Update.

### Bug 3 — `Database.js` has `pressure_mean` column in episodes schema (dead column)
**File:** `mobile_app/src/Database.js` lines 185, 642, 662, 679, 700  
**Issue:** `episodes` table has `pressure_mean REAL`. Always written as `null`.  
**Severity:** Low — doesn't break anything. Leave as-is or add schema migration.

### Bug 4 — Stale closure in `useBle.js` `handleIncomingPacket`
**File:** `mobile_app/src/hooks/useBle.js` line ~56 (documented in file's own comment)  
**Mitigation:** Uses `handleIncomingPacketRef.current`. Works for most cases.

### Bug 5 — Battery percentage always returns 100%
**File:** `esp firmware/src/PowerManager.cpp`  
**Issue:** `VBAT_READ_PIN = -1`. ADC reads stubbed.  
**Action:** Wire voltage divider to ADC-capable GPIO, update `Config.h`.

### Bug 6 — `ModelRunner` is never invoked from the main loop
**Files:** `EdgeAnalytics.cpp`, `main.cpp`  
**Issue:** TFLite Micro autoencoder + `FeatureExtractor` fully implemented but disconnected.  
**Action:** See §8.

### Bug 7 — `sendFeaturePacket` is never called
**File:** `BLEManager.cpp`  
**Issue:** 46-byte legacy feature packet serializer exists but has no call site.  
**Action:** Wire from `EdgeAnalytics` after ModelRunner integration or deprecate.

### Bug 8 — `SignalsCard.js` and `DashboardTab.js` comments reference barometric pressure
**Files:** `components/SignalsCard.js` line 18, `components/DashboardTab.js` line 284  
**Issue:** UI component comments mention barometric pressure. No actual pressure data displayed.  
**Severity:** Comment-only — no functional impact.

---

## 8. Next Steps — Recommended Work Queue

### Priority 1: Wire Firmware TFLite Inference
1. In `EdgeAnalytics.cpp:processIMUSample()`, call `FeatureExtractor::getInstance().addSample(sample, featureVector)` each tick
2. When it returns `true` (window ready), call `ModelRunner::getInstance().runInference(featureVector, out_embedding)`
3. Use reconstruction error as anomaly score, 16D `out_embedding` for classification
4. Call `BLEManager::getInstance().sendFeaturePacket(...)` with the result to enable mobile side to receive real model output

### Priority 2: Native TFLite on Mobile Side
1. Wire `fast-tflite` (or `@tensorflow/tfjs-react-native`) in `EpisodeEngine.processWindow()`
2. Replace `generateFallbackEmbedding()` with actual model output on real device
3. Model artifacts: `mobile_app/model/scaling_params_v3.json`, `class_centroids_v3.json`
4. Input: `[1, 10, 132]` (sequence) + `[1, 12]` (global) -> Output: 32D unit embedding

### Priority 3: Fix Pressure References
1. Audit `DiagnosticReasoningEngine.js` — ensure `evaluateDomain('environment', ...)` passes `[temp, rh]` only
2. Audit `ContextEngine.js` environmental distance computation
3. Update stale comments in those files

### Priority 4: Battery ADC
1. Wire voltage divider to ESP32 ADC GPIO
2. Update `VBAT_READ_PIN`, `VBAT_CTRL_PIN` in `Config.h`
3. Implement real ADC reading in `PowerManager.cpp`

---

## 9. Packet Design Doc vs Actual Implementation — Delta Table

| Field | `packet_design.md` says | Actual implementation | Status |
|---|---|---|---|
| `packetIndex` in all packets | uint32_t counter in every packet | Not implemented — only `timestamp` present | Leave as-is (existing code wins for metadata) |
| MOTION gyro type | `int32_t` milli-dps | `int16_t` 0.1 dps | Leave as-is |
| ENV encoding | int16 x10 fixed-point | float32 raw | Leave as-is |
| ENV pressure field | Not in spec | Never present | Aligned |
| VITAL heartRate | `int16_t` | `int16_t` | DONE 2026-09-29 |
| VITAL spo2 | `int8_t` | `int8_t` | DONE 2026-09-29 |
| VITAL signalQuality | Not in spec | Was `uint8_t` byte 13 — removed | DONE 2026-09-29 |

---

## 10. Key Firmware Constants (Quick Reference)

```c
SAMPLE_RATE_HZ       = 100       // IMU + Vital polling rate
SAMPLE_INTERVAL_MS   = 10        // SamplerTask tick
WINDOW_SIZE          = 200       // 2.0s sliding window
STRIDE_SIZE          = 50        // 0.5s stride
FIRMWARE_VERSION     = "SafeBand-ESP32 v1.0.0"
SPO2_CRITICAL_LOW    = 90.0f
HR_CRITICAL_BRADY    = 45.0f
HR_CRITICAL_TACHY    = 135.0f
FALL_TROUGH_G        = 0.65f
FALL_IMPACT_G        = 2.20f
FALL_CANCEL_TIMEOUT  = 10000     // 10s alarm window
HEAT_INDEX_DANGER    = 104.0f    // deg F
DEFAULT_THRESHOLD    = 1.01309f  // TFLite anomaly threshold
HYSTERESIS_WINDOWS   = 5
```

---

## 11. File Tree Snapshot

```
SIH/
├── current_status.md          <- this file
├── README.md
├── esp firmware/
│   ├── include/
│   │   ├── Config.h           <- ALL constants and pin definitions
│   │   └── model_data.h       <- 954 KB TFLite flatbuffer (autoencoder)
│   ├── src/
│   │   ├── main.cpp           <- FreeRTOS tasks + setup
│   │   ├── BLEManager.h/.cpp  <- BLE GATT + all packet serializers
│   │   ├── IMUSensor.h/.cpp
│   │   ├── VitalSensor.h/.cpp <- MAX30102 + Maxim SpO2 algorithm
│   │   ├── EnvironmentSensor.h/.cpp  <- DHT11
│   │   ├── EdgeAnalytics.h/.cpp      <- Heuristic fall+motion+physio engine
│   │   ├── FeatureExtractor.h/.cpp   <- 144-feature IMU pipeline (DISCONNECTED from inference)
│   │   ├── ModelRunner.h/.cpp        <- TFLite Micro runner (DISCONNECTED from main loop)
│   │   ├── BuzzerManager.h/.cpp
│   │   └── PowerManager.h/.cpp
│   └── mds/
│       ├── packet_design.md          <- Reference spec (may differ from impl -- see §9)
│       ├── readme_for_reading_from_sensor.md
│       └── reading_samples.md
└── mobile_app/
    └── src/
        ├── BleService.js             <- Binary packet decoder (all 4 types)
        ├── EpisodeEngine.js          <- 2 Hz inference orchestrator
        ├── FeatureExtraction.js      <- IMU features + PPG DSP + heat index
        ├── MathematicalEngine.js     <- Mahalanobis + EWMA baselines
        ├── DiagnosticReasoningEngine.js <- 5-hypothesis clinical reasoning
        ├── GemmaAgent.js             <- Conversational health agent
        ├── GemmaService.js           <- Gemma 3n inference service
        ├── ContextEngine.js          <- Location + environment fusion
        ├── LocationEngine.js         <- GPS familiarity + geofencing
        ├── Database.js               <- SQLite schema + all queries
        ├── BackgroundServices.js
        ├── hooks/
        │   └── useBle.js             <- Core BLE hook (packet routing)
        └── components/
            ├── DashboardTab.js
            ├── SignalsCard.js
            └── (other UI components)
```
