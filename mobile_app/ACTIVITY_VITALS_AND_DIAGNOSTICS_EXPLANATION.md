# RakshaBand: Activity, Vitals & Diagnostic Reasoning Reference

This document provides complete technical specifications explaining how RakshaBand derives physical activity classifications, physiological oxygen saturation ($SpO_2$), diagnostic evidence scores, and learned geofenced locations.

---

## 1. Real-Time Activity Panel & Model Confidence

### 1.1 Purpose of the Panel
The **Real-Time Activity (Model v3)** card in the Dashboard (`src/components/DashboardTab.js`) categorizes physical human movement into **21 discrete activity classes**:

| Category | Classes | Clinical / Emergency Utility |
| :--- | :--- | :--- |
| **Resting** | `sitting`, `lying`, `standing` | Serves as the control baseline for resting heart rate and autonomic tone. |
| **Locomotion** | `walking_slowly`, `walking_briskly`, `running`, `jogging`, `cycling` | Distinguishes elevated heart rate caused by healthy aerobic exercise vs. cardiac distress. |
| **Elevation** | `ascending_stairs`, `descending_stairs`, `climbing` | Accounts for acute cardiovascular strain during vertical physical labor. |
| **Gestures & Dynamics** | `proud_cheer`, `punching`, `jumping`, `bending` | Captures acute dynamic gestures and potential physical struggle. |
| **Transitions** | `sit_to_stand`, `stand_to_sit`, `stumble` | Detects postural transitions and early loss-of-balance precursors. |

### 1.2 Mathematical Derivation of Confidence
The confidence meter ($0\% - 100\%$) is **not** an arbitrary estimate; it is the exact **cosine similarity (dot product)** in latent feature space computed in `src/FeatureExtraction.js` (`classifyEmbedding()`):

```
Raw IMU (100 Hz, 2.0s = 200 samples)
  │
  ▼
Tier 1: 90 Stats × 10 Subwindows = 900 features
Tier 2: 42 Spectral FFT × 10 Subwindows = 420 features
Tier 3: 12 Global Structural Jacobi Eigenvalues
  │
  ▼
Total: 1,332 Features standardized against model/scaling_params_v3.json
  │
  ▼
Model v3 Embedding Projection (model_v3.tflite)
  │
  ▼
32-Dimensional L2-Normalized Unit Vector z  (||z||₂ = 1.0)
  │
  ▼
Dot Product with 21 Centroids in model/class_centroids_v3.json:
  Sim(k) = z · cₖ = ∑ (zᵢ × cₖ,ᵢ)
  │
  ▼
Activity = argmax Sim(k)
Confidence = max Sim(k) × 100%
```

Because both the live vector $\mathbf{z}$ and the stored centroid $\mathbf{c}_k$ are normalized unit vectors, the dot product directly equals the cosine of the angle between them:
$$\text{Confidence} = \cos(\theta) = \mathbf{z} \cdot \mathbf{c}_{\text{best}} = \sum_{i=1}^{32} z_i \cdot c_{\text{best}, i}$$

- **$\text{Confidence} \ge 85\%$**: Strong directional alignment with the trained activity cluster.
- **$\text{Confidence} < 50\%$**: Transitional movement, ambiguous gesture, or high sensor noise.

---

## 2. Derivation of Oxygen Percentage ($SpO_2$)

### 2.1 Optical Sensor Hardware
The band uses a **Maxim Integrated MAX30102** optical pulse oximetry sensor placed flush against the dorsal side of the wrist. It emits two precise optical wavelengths:
1. **Red LED ($\lambda_1 \approx 660\text{ nm}$)**
2. **Infrared (IR) LED ($\lambda_2 \approx 880\text{ nm}$)**

### 2.2 Biological Physics of Pulse Oximetry
- **Oxygenated Hemoglobin ($HbO_2$)** absorbs more Infrared light ($880\text{ nm}$) and allows Red light ($660\text{ nm}$) to transmit through.
- **Deoxygenated Hemoglobin ($Hb$)** absorbs more Red light ($660\text{ nm}$) and allows Infrared light ($880\text{ nm}$) to transmit through.

As the heart pumps, arterial blood vessels in the wrist expand and contract, modulating the amount of light that returns to the photodiode.

### 2.3 Mathematical Algorithm in `src/FeatureExtraction.js`
The function `processPpgWaveform(redSamples, irSamples)` processes raw 100 Hz photodiode samples:

1. **Separates DC and AC components**:
   - **$DC$ (Baseline)**: Average optical absorption from skin, bone, muscle, and venous blood:
     $$DC = \frac{1}{N} \sum_{i=0}^{N-1} x_i$$
   - **$AC$ (Pulsatile)**: Peak-to-peak amplitude fluctuation produced by pulsatile arterial blood volume:
     $$AC = \max(x) - \min(x)$$

2. **Ratio of Ratios ($R$)**:
   Computes the relative optical modulation ratio:
   $$R = \frac{AC_{\text{Red}} / DC_{\text{Red}}}{AC_{\text{IR}} / DC_{\text{IR}}}$$

3. **Standard Pulse Oximetry Empirical Calibration**:
   $$SpO_2 = 110.0 - 25.0 \times R$$
   *(Clamped to physiological clinical limits: $70.0\% \le SpO_2 \le 100.0\%$)*.

4. **Wrist Contact Gating**:
   If $DC_{\text{Red}} < 1000$ or $DC_{\text{IR}} < 1000$ counts, the band has lost optical contact with the skin (device taken off wrist). The engine returns `quality = 0` and sets `wearConfidence < 40%`, immediately suppressing alarms.

---

## 3. Diagnostic Reasoning Engine Scoring

### 3.1 Architecture Overview
The score displayed on the circular dashboard gauge is a **fused contextual threat assessment** computed across two pipeline stages:
1. **Clinical Evidence Scoring** in `src/DiagnosticReasoningEngine.js`
2. **Context & Geofence Fusing** in `src/ContextEngine.js`

### 3.2 Stage 1: Hypothesis Evidence Weighting
The engine evaluates 5 clinical hypotheses by aggregating points based on physiological and environmental criteria:

$$\text{Score}(\mathcal{H}) = \sum_{j} w_j \cdot \mathbb{I}(\text{Condition}_j)$$

#### A. `EXERTION_BENIGN` (Healthy Physical Workout)
- Motion class $\in \text{ACTIVE}$ (`running`, `walking`): $+0.40$
- Heart Rate elevated ($Z_{\text{HR}} \ge 1.2$): $+0.12 \times Z_{\text{HR}}$ (capped at $+0.40$)
- Oxygen stable ($SpO_2 \ge 95\%$, $Z_{\text{SpO}_2} \ge -1.0$): $+0.15$
- Environment normal: $+0.05$

#### B. `RESPIRATORY_CONCERN` (Hypoxemia / Oxygen Deprivation)
- Oxygen desaturation ($SpO_2 \le 92\%$ or $Z_{\text{SpO}_2} \le -1.8$): $+0.25 \times |Z_{\text{SpO}_2}|$ (capped at $+0.55$)
- Compensatory tachycardia ($Z_{\text{HR}} \ge 1.2$): $+0.25$
- Normal environmental weather: $+0.15$
- Persists $>2$ minutes: $+0.10$

#### C. `CARDIOVASCULAR_CONCERN` (Resting Tachycardia / Arrhythmia)
- Unexplained high HR at rest ($Z_{\text{HR}} \ge 2.2$ while `sitting` or `lying`): $+0.18 \times Z_{\text{HR}}$ (capped at $+0.50$)
- Normal ambient climate: $+0.25$
- Sustained resting elevation $>5$ minutes: $+0.20$

#### D. `HEAT_STRESS_DEHYDRATION` (Hyperthermia / Heat Exhaustion)
- Elevated HR ($Z_{\text{HR}} \ge 1.5$): $+0.35$
- NOAA Heat Index in Caution/Danger tier: $+0.30$ to $+0.40$
- Stationary or resting motion: $+0.20$
- Condition persisting $>3$ minutes: $+0.15$

#### E. `FALL_HARD_IMPACT` (Direct Safety Bypass)
If peak acceleration $\ge 3.5g$ ($3500\text{ mg}$) and directional trajectory linearity $\ge 0.70$:
$$\text{Confidence} = 0.95 \quad (\text{Direct Critical Escalation Bypass})$$

### 3.3 Stage 2: Contextual Fusing with Location Familiarity
In `src/ContextEngine.js`, the primary hypothesis score is modulated by the familiarity of the current location:

$$\text{Threat Score} = \text{Hypothesis Score} \times (1.2 - 0.4 \times \text{Familiarity})$$

- **If `EXERTION_BENIGN`**: The threat score is multiplied by $0.25$ (suppressing alarms during exercise).
- **If `wearConfidence < 40%`**: The threat score is clamped to $0.0$ (device on nightstand/desk).
- **If Threat Score $\ge 0.72$ (72%)**: The threat level becomes `CRITICAL`, triggering the emergency countdown modal and automated SMS/email alerts.

---

## 4. Location Engine & The `known_locations` Database Table

### 4.1 Why Is No Location Showing in the `known_locations` Table?
The `known_locations` table represents **permanent learned spatial nodes** (e.g., Home, Office, Gym). It intentionally does **not** insert a row on the very first GPS coordinate received.

### 4.2 The 5-Minute Dwell Centroid Learning Rule
In `src/LocationEngine.js`:
- `MIN_STAY_DURATION = 5 * 60 * 1000` (5 minutes)
- `CANDIDATE_RADIUS = 40.0` meters

```
User Arrives at New Coordinates
  │
  ▼
Candidate Dwell Initiated (firstSeen = now)
  │
  ▼
Is user within 40m radius for >= 5 continuous minutes?
  ├── NO  ──► User is in transit (walking/driving) ──► Candidate discarded (no clutter)
  │
  └── YES ──► Dwell Threshold Met!
                │
                ▼
        Compute Mathematical Centroid:
        Lat = ∑(lat) / N ,  Lon = ∑(lon) / N
                │
                ▼
        Insert Permanent Row into `known_locations`
        Create Initial Visit in `location_visits`
```

If the app registered a location on every single GPS ping, a 15-minute car or bus ride would create hundreds of junk locations in your database. The 5-minute dwell rule ensures only meaningful places where the user actually stays are registered.

### 4.3 Is the Disconnected ESP the Reason?
**No. The ESP32 is NOT the reason.**
- The ESP32 wristband contains an IMU (accelerometer/gyroscope) and PPG optical sensor. It does **not** have a GPS module.
- GPS coordinates come from the **phone itself** via `expo-location` (`Location.watchPositionAsync` in `App.js`).

### 4.4 Factors That Affect Location Registration During UI Testing
1. **Testing Duration**: If the app was opened recently to inspect the UI, the required 5 continuous minutes of stay have not yet elapsed.
2. **Phone GPS Permissions**: On first launch, the phone prompts for location access. If permissions were skipped or denied, no GPS fixes are ingested.
3. **Accuracy Gating**: `LocationEngine` discards any GPS sample with horizontal accuracy $> 30\text{ meters}$ (`MAX_ALLOWED_ACCURACY = 30.0`). Indoor Wi-Fi or cellular triangulation often reports $\pm 45\text{m} - 80\text{m}$, which is filtered out until a cleaner fix is acquired.
4. **Emulator Testing**: Android/iOS emulators have no physical GPS antenna and emit coordinates only when manually simulated via emulator controls.
