# RakshaBand — Mobile App Implementation Specification

## 1. Architecture Recap

```
Smart Wrist Wearable (ESP32-S3 + MAX30102 + MPU6050 + BMP/BME280)
        │ BLE
        ▼
┌─────────────────────────────────────────────────────────┐
│                      Mobile App                          │
│                                                            │
│  BLE Ingestion ──▶ Episode Engine ──▶ Mathematical Model  │
│  (packet parse)    (preprocess +      Engine (Mahalanobis │
│                     motion cluster)    + cold-start)      │
│                          │                    │            │
│                          ▼                    ▼            │
│                   Location Engine ──▶ Diagnostic Reasoning │
│                   (known-location       Engine (NEW)       │
│                    nodes)                     │             │
│                                                ▼             │
│                                        Gemma 3n             │
│                                   (communication layer only)│
│                                                │              │
│                                                ▼              │
│                              SQLite  ◀──▶  UI Interface      │
│                          (feedback loop)   (dashboard, alerts,│
│                                              emergency)        │
│                                                │                │
│                                                ▼                │
│                                   Emergency Escalation           │
│                                  (Twilio WhatsApp/SMS, Resend)   │
└─────────────────────────────────────────────────────────┘
```

Design principle carried through every module: **cheap, transparent computation runs always; expensive computation (the LLM) runs only when the cheap layer flags something.**

---

## 2. BLE Packet Schema (from ESP32)

| Type byte | Packet | Fields |
|---|---|---|
| `0x01` | Motion | `timestamp, ax, ay, az, gx, gy, gz` |
| `0x02` | Status | firmware version, uptime, battery %, `isBleConnected` |
| `0x03` | Environment | `timestamp, temperature, pressure, humidity` |
| `0x04` | Vital | `timestamp, red_raw, ir_raw` |

Motion + Vital streamed at 100 Hz, Environment at 1 Hz, Status on battery-% change (per the firmware plan already agreed). The app's BLE ingestion layer parses each type byte into its own typed buffer and timestamp-aligns them before handing off to the Episode Engine.

---

## 3. Episode Engine

The Episode Engine owns all preprocessing — nothing downstream touches raw sensor data.

### 3.1 Motion feature engineering

Computed per sub-window (`M = 20` samples), 10 sub-windows batched together (200 samples ≈ 2 s at 100 Hz) into a `[1, 10, 132]` sequence tensor for the motion-embedding model.

**Tier 1 — Statistical (90 features/sub-window)**
- 9 channels: `Ax, Ay, Az, Gx, Gy, Gz, ResultantA (=√(Ax²+Ay²+Az²)), Jerk (=diff(ResultantA)), SMA (=(|Ax|+|Ay|+|Az|)/3)`
- 10 statistics per channel: Mean, Std, RMS, Skewness, Kurtosis, Zero Crossing Rate, Mean Crossing Rate, IQR, Peak-to-Peak, P90/P10 ratio
- 9 × 10 = 90 features

**Tier 2 — Spectral & autocorrelation (42 features/sub-window)**
- 6 raw channels: `Ax, Ay, Az, Gx, Gy, Gz`, Hanning-windowed
- 7 features per channel: Dominant Frequency (peak FFT bin, 1–10), Spectral Entropy (normalized Shannon entropy on PSD), Peak Frequency Ratio, Autocorrelation Lag 1 (10ms), Lag 5 (50ms), Lag 10 (100ms), Dominant Band Energy Ratio (5–20 Hz)
- 6 × 7 = 42 features

**Total: 132 features/sub-window → `[1, 10, 132]` fed to the motion embedding model.**

### 3.2 PPG feature engineering

From raw `red`/`ir` channels: reconstruct PPG waveform → extract Heart Rate (mean, variance, min, max), SpO2 (mean, variance, min, max), HRV.

### 3.3 Environmental derived feature

Heat index from temperature + humidity (Rothfusz regression, NOAA):

```
HI = -42.379 + 2.04901523·T + 10.14333127·RH
     - 0.22475541·T·RH - 0.00683783·T² - 0.05481717·RH²
     + 0.00122874·T²·RH + 0.00085282·T·RH² - 0.00000199·T²·RH²
```
(T in °F, RH as a plain number e.g. 60, not 0.60. Valid for HI ≥ 80°F per NOAA.)

### 3.4 Motion clustering & episode boundary

- Each `[1,10,132]` sequence → motion embedding model → nearest cluster assignment (still / walking / running, or whatever taxonomy the trained embedding model uses).
- An **episode** = a contiguous run of embeddings belonging to one cluster, carrying all physiological + environmental features computed during that run.
- **Boundary rule**: track the last 10 consecutive embeddings; if ≥8 of them belong to a new cluster, end the current episode and start a new one under the new cluster label. This is a majority-vote debounce — the phone-side equivalent of the "require N consecutive windows" hysteresis already used in the ESP32 motion classifier, just tuned for the phone's embedding cadence instead of raw feature windows.

---

## 4. Location Engine

**Known-location node registration:**
1. Define two radii: `entry_radius < exit_radius` (hysteresis — prevents boundary flapping from GPS jitter).
2. When the user stops (motion cluster = still, or GPS shows no meaningful movement), start a dwell timer while the user stays within `exit_radius` of the stop point.
3. If dwell duration > threshold, register the centroid of all GPS samples taken during the dwell as a new known-location node.
4. On future visits, arrival at a registered node is detected via the tighter `entry_radius`.

**Gating recommendation:** ignore GPS samples with poor reported accuracy/HDOP when computing the centroid or evaluating radius crossings — otherwise a low-accuracy fix can spuriously trigger a dwell registration or fail to register a real one indoors.

**UI implications:**
- Live map view showing nodes as they're captured; prompt "Know this location? Name it: ___" on first registration.
- Attach environmental history and last-known physiological condition per node.
- Enables place-aware nudges: *"Temperature at this location has been trending higher than your past visits — consider moving somewhere cooler."*
- Feeds the Diagnostic Reasoning Engine's prior adjustment (Section 6.3).

---

## 5. Mathematical Model Engine

- `ml-matrix`, full Mahalanobis distance (mean vector + covariance) per domain: physiological `[HR, SpO2]`, environmental `[temperature, humidity, pressure]`, motion (per-cluster centroid using `[accelRMS, gyroRMS, periodicity, cadence]`, matching the ESP32 fallback feature set for consistency when reconciling BLE-off period data).
- **Cold-start seeding** from the same population sources already used for the ESP32 firmware: NEWS2 (RCP UK) for HR/SpO2, NOAA/OSHA heat-index tiers for environment, CPCB breakpoints for air quality if/when a PM2.5 sensor is added.
- Progressive EWMA baseline update with a purity gate (same principle as the ESP32 centroid scheme, richer covariance instead of diagonal variance).
- **Output for each domain**: aggregate Mahalanobis distance **and** the per-dimension z-score decomposition — the latter is what feeds the Diagnostic Reasoning Engine below; the raw aggregate alone isn't enough to diagnose anything.

---

## 6. Diagnostic Reasoning Engine (new)

Sits between the Mathematical Model Engine and Gemma. A lightweight, hand-authored weighted-evidence rule system — not a trained model, no training data required, fully explainable.

### 6.1 Hypothesis set

Taken directly from the problem statement's target conditions:

- `EXERTION_BENIGN`
- `HEAT_STRESS_DEHYDRATION`
- `RESPIRATORY_CONCERN`
- `CARDIOVASCULAR_CONCERN`
- `ENVIRONMENTAL_HAZARD` (independent of physiology — heat/AQI tier breach alone)
- (Fall and confirmed hard-limit breaches bypass this engine entirely — they escalate directly.)

### 6.2 Evidence scoring (illustrative, weights to be calibrated)

```
score(HEAT_STRESS_DEHYDRATION) =
      w1 · rise(HR_zscore)
    + w2 · (heat_index_tier >= EXTREME_CAUTION)
    + w3 · (motion_cluster in {REST, LOW})
    + w4 · rise(persistence_minutes)
    + w5 · (SpO2 within normal band)   // rules out primary respiratory cause

score(EXERTION_BENIGN) =
      w1 · rise(HR_zscore)
    + w2 · (motion_cluster in {RUN, HIGH_INTENSITY})
    - w3 · rise(persistence_minutes beyond expected activity duration)
```

Pick the highest-scoring hypothesis above a minimum confidence floor. If nothing clears the floor: output `ANOMALY_UNCLEAR` — an honest fallback, same philosophy as the `UNKNOWN` state in the ESP32 motion classifier. Never force a confident-sounding diagnosis the evidence doesn't support.

### 6.3 Context modifiers (not features — prior adjustments)

- **Persistence**: tracked as its own signal (consecutive episodes / elapsed minutes flagged), independent of magnitude.
- **Location**: if this evidence pattern has occurred at this known location before and was dismissed via the feedback loop, raise the confidence threshold before re-flagging here specifically.
- **Historical baseline at this location** (from Section 4): informs whether current environmental readings are unusual *for this place*, not just unusual in the abstract.

### 6.4 Output contract (this is Gemma's entire input)

```json
{
  "domain": "physiology | environment | motion",
  "primary_hypothesis": "HEAT_STRESS_DEHYDRATION",
  "confidence": 0.0-1.0,
  "contributing_evidence": ["HR +2.1σ", "heat index: Extreme Caution", "motion: resting"],
  "severity_tier": "informational | advisory | urgent",
  "suggested_action_category": "hydration | rest | seek_shade | medical_consult | emergency"
}
```

### 6.5 Calibration

Same methodology as the motion-score calibration already planned: hand-set initial weights, run a handful of deliberate scenarios (hot+resting vs. hot+running vs. cold+resting), verify the winning hypothesis matches intuition, adjust weights. No training pipeline needed.

---

## 7. Gemma 3n — Communication Layer Only

- Input: the Diagnostic Reasoning Engine's structured output (Section 6.4) + minimal relevant user history.
- Output: a clear, natural-language message for the dashboard/alert/notification — tone and phrasing, not diagnosis.
- Invoked **only** when the Reasoning Engine produces a non-`ANOMALY_UNCLEAR`, above-floor result — gatekept by the cheap layers above it, for both battery and latency.
- Gemma never receives raw sensor data or is asked to weigh competing causes itself.

---

## 8. SQLite Schema (brief)

- `episodes` — motion cluster, feature summary, timestamps
- `baseline_state` — per-domain mean/covariance, last-updated
- `anomaly_events` — Reasoning Engine outputs, linked to episode
- `known_locations` — centroid, name, radii, environmental/physiological history
- `feedback` — user confirm/dismiss on alerts, linked to anomaly_events + location
- `emergency_contacts`, `settings`

---

## 9. UI Interface (brief)

- Today's summary / wellness dashboard (daily trends, per-domain risk scores)
- Alert detail screens (shows Reasoning Engine's `contributing_evidence`, not just a verdict — transparency matters for trust)
- Known-locations map view with naming prompts
- Emergency response screen with a cancel/confirm window before escalating
- Settings: emergency contacts, known locations, duress-PIN configuration

---

## 10. Emergency Escalation

- Triggers: Mathematical Model Engine hard-limit breach, Reasoning Engine `severity_tier = urgent`, ESP32 fall event (synced over BLE), duress-PIN entry.
- Twilio (WhatsApp/SMS) + Resend (email), with live location from the Location Engine in the message body.
- Cancel/confirm window before actually firing, mirroring the ESP32-side fall-detector cancel button.

---

## 11. Suggested Build Order

1. BLE ingestion + raw data display
2. SQLite schema + episode buffering
3. Mathematical Model Engine with population cold-start seeding
4. Episode engine (feature extraction + motion clustering)
5. Location engine
6. Diagnostic Reasoning Engine
7. Gemma 3n integration (communication layer)
8. Emergency escalation + duress-PIN
9. Feedback loop + dashboard polish

---

## 12. Open Items to Pin Down Before Coding

- Exact rule weights in Section 6.2 (start hand-tuned, calibrate against recorded scenarios)
- Persistence thresholds (minutes) per hypothesis
- Entry/exit radius and dwell-duration defaults for the Location Engine
- Confidence floor below which `ANOMALY_UNCLEAR` is returned