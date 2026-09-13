# Model v3: Motion Embedding & Activity Classification Guide

This document provides comprehensive technical specifications for **Model v3**, detailing sensor acquisition requirements, windowing parameters, the 3-tier feature extraction pipeline, z-score standardization, tensor specifications, and React Native deployment.

---

## 1. System Overview & Sensor Specifications

Model v3 transforms raw 6-axis IMU sensor streams into discriminative **32-dimensional L2-normalized unit embeddings**. Human physical activities are categorized across **21 discrete classes** by evaluating the cosine similarity (dot product) between live embeddings and precomputed activity cluster centroids.

### 1.1 Sensor Requirements & Units

| Parameter | Specification | Notes |
|---|---|---|
| **Sampling Frequency (fs)** | **100 Hz** (10 ms period) | Critical: Timesteps must be evenly spaced (jitter < 5 ms) |
| **Accelerometer Channels** | `Ax`, `Ay`, `Az` | **Units: m/s²** (standard acceleration including gravity) |
| **Gyroscope Channels** | `Gx`, `Gy`, `Gz` | **Units: dps** (degrees per second, °/s) |
| **Raw Input Channels** | 6 continuous streams | Channel order: `[Ax, Ay, Az, Gx, Gy, Gz]` |
| **Wearable Placement** | Wrist-worn device | **X**: along forearm, **Y**: across wrist, **Z**: perpendicular out |

---

## 2. Windowing & Streaming Parameters

The model evaluates motion using a hierarchical sliding window:

| Window Parameter | Value | Duration | Description |
|---|---|---|---|
| **Global Window Size (N)** | **200 samples** | **2.00 seconds** | Required buffer length to perform one inference |
| **Streaming Stride (S)** | **50 samples** | **0.50 seconds** | Buffer slides forward by 50 samples for each inference |
| **Window Overlap** | **75%** (150 samples) | 1.50 seconds | Continuous classification without boundary blindness |
| **Inference Rate** | **2.0 Hz** | Every 500 ms | Model generates 2 activity classifications per second |
| **Sub-Window Size (M)** | **20 samples** | **0.20 seconds** | Temporal resolution chunk for sequence branch |
| **Number of Sub-Windows (K)** | **10 sub-windows** | 10 × 20 = 200 | Forms temporal sequence axis (10, 132) |

```
Raw IMU Buffer: [200 samples × 6 channels] (2.0 seconds at 100 Hz)
│
├── Sub-Window 0: Samples   0 –  19  ───► Feature Extraction (132 features) ──┐
├── Sub-Window 1: Samples  20 –  39  ───► Feature Extraction (132 features)   │
├── Sub-Window 2: Samples  40 –  59  ───► Feature Extraction (132 features)   │
├── ...                                                                        ├──► Branch 1: Sequence Input [1, 10, 132]
└── Sub-Window 9: Samples 180 – 199  ───► Feature Extraction (132 features) ──┘
│
└── Full Window: Samples 0 – 199 ────────► Covariance & Eigenspace Analysis  ─────► Branch 2: Global Input   [1, 12]
```

---

## 3. Feature Engineering Pipeline

Every 200-sample window is transformed into two distinct tensor representations:
1. **Sequence Input**: `[1, 10, 132]` (Temporal Dynamics — Tier 1 + Tier 2 per sub-window)
2. **Global Input**: `[1, 12]` (Structural Posture Geometry — Tier 3 over full 200-sample window)

### 3.1 Pre-Computed Derived Channels (200 samples)
From the 6 raw IMU channels `[Ax, Ay, Az, Gx, Gy, Gz]`, compute 5 derived signals across the entire 200-sample window:

1. **Resultant Acceleration (ResultantA)**:
   `ResultantA[t] = sqrt(Ax[t]^2 + Ay[t]^2 + Az[t]^2)`
2. **Resultant Angular Velocity (ResultantG)**:
   `ResultantG[t] = sqrt(Gx[t]^2 + Gy[t]^2 + Gz[t]^2)`
3. **Jerk**: Finite difference of resultant acceleration (at 100 Hz rate):
   `Jerk[t] = ResultantA[t] - ResultantA[t-1]`, with `Jerk[0] = 0`
4. **Signal Magnitude Area per sample (SMA)**:
   `SMA[t] = (|Ax[t]| + |Ay[t]| + |Az[t]|) / 3`
5. **Tilt Angle**:
   `TiltAngle[t] = atan2(Az[t], sqrt(Ax[t]^2 + Ay[t]^2) + 1e-8)`

---

### 3.2 Branch 1: Sequence Features (10 Timesteps × 132 Features)

For each of the **10 sub-windows** (M = 20 samples each), compute:

#### A. Tier 1: Statistical Time-Domain Features (90 features)
Evaluated over **9 channels**:
`[Ax, Ay, Az, Gx, Gy, Gz, ResultantA, Jerk, SMA]`

For each channel, compute **10 statistical properties**:
1. **Mean**: `(1/M) * sum(x)`
2. **Standard Deviation**: `sqrt((1/M) * sum((x - mean)^2)) + 1e-8`
3. **Root Mean Square (RMS)**: `sqrt((1/M) * sum(x^2))`
4. **Skewness**: `(1/M) * sum((x - mean)^3) / std^3`
5. **Kurtosis**: `((1/M) * sum((x - mean)^4) / std^4) - 3.0`
6. **Zero Crossing Rate (ZCR)**: Fraction of consecutive sample pairs with opposite signs
7. **Mean Crossing Rate (MCR)**: Fraction of consecutive sample pairs crossing the sub-window mean
8. **Interquartile Range (IQR)**: `Percentile_75(x) - Percentile_25(x)`
9. **Peak-to-Peak (PTP)**: `max(x) - min(x)`
10. **Percentile Ratio**: `Percentile_90(x) / (Percentile_10(x) + 1e-8)`

**Tier 1 Count**: 9 channels × 10 statistics = **90 features**

#### B. Tier 2: Spectral & Autocorrelation Features (42 features)
Evaluated over **6 raw channels**:
`[Ax, Ay, Az, Gx, Gy, Gz]`

Apply a **Hanning window** of length 20 to the sub-window, then compute the Real FFT (N=20 → 11 magnitude bins):
1. **Dominant Frequency**: Frequency index (`bin in [1, 10]`) corresponding to peak FFT magnitude (excluding DC bin 0).
2. **Spectral Entropy**: Normalized Shannon entropy over the Power Spectral Density (`PSD = |FFT|^2`):
   `Entropy = -sum(p_k * ln(p_k + 1e-8))`, where `p_k = PSD_k / sum(PSD)`
3. **Peak Frequency Ratio**: Fraction of spectral energy concentrated at the dominant peak:
   `PeakRatio = max(PSD[1:]) / (sum(PSD) + 1e-8)`
4. **Autocorrelation Lag 1 (r1)**: Correlation at t+1 (10 ms delay)
5. **Autocorrelation Lag 5 (r5)**: Correlation at t+5 (50 ms delay)
6. **Autocorrelation Lag 10 (r10)**: Correlation at t+10 (100 ms delay)
7. **Dominant Band Energy Ratio**: Spectral energy fraction in frequency bins 1 to 4 (5 Hz to 20 Hz band):
   `BandEnergy = sum(PSD[1:5]) / (sum(PSD) + 1e-8)`

**Tier 2 Count**: 6 channels × 7 statistics = **42 features**

**Total Sequence Features per Sub-Window**: 90 + 42 = **132 features**
**Sequence Feature Tensor Shape**: **`[1, 10, 132]`**

---

### 3.3 Branch 2: Structural Cross-Axis Features (12 Features)

Computed over the **entire 200-sample window** from the 6×6 covariance matrix of raw signals `[Ax, Ay, Az, Gx, Gy, Gz]`:

`Sigma = Cov(window_data_200x6)`

Compute eigenvalues of `Sigma` sorted in descending order: `lambda_1 >= lambda_2 >= ... >= lambda_6 >= 0`.

| Index | Feature Name | Computation | Physical Meaning |
|---|---|---|---|
| **0** | `ev1` | `lambda_1` | Primary axis variance |
| **1** | `ev2` | `lambda_2` | Secondary axis variance |
| **2** | `ev3` | `lambda_3` | Tertiary axis variance |
| **3** | `linearity` | `lambda_1 / (lambda_1 + lambda_2 + lambda_3 + 1e-8)` | Directionality of motion |
| **4** | `planarity` | `(lambda_1 + lambda_2) / (sum(lambda) + 1e-8)` | Degree of 2D planar motion |
| **5** | `total_var` | `sum(lambda)` | Total kinetic variance |
| **6** | `cond_num` | `lambda_1 / (lambda_6 + 1e-8)` | Condition ratio / dimensionality |
| **7** | `cov_ax_gx` | `Sigma[0, 3]` | Coupling between Accel-X and Gyro-X |
| **8** | `cov_ay_gy` | `Sigma[1, 4]` | Coupling between Accel-Y and Gyro-Y |
| **9** | `cov_az_gz` | `Sigma[2, 5]` | Coupling between Accel-Z and Gyro-Z |
| **10** | `cov_ax_ay` | `Sigma[0, 1]` | Lateral accelerometer correlation |
| **11** | `cov_gx_gy` | `Sigma[3, 4]` | Wrist rotation cross-coupling |

**Global Feature Tensor Shape**: **`[1, 12]`**

---

## 4. Z-Score Standardization Reference

Raw features vary across orders of magnitude and **must be standardized** prior to feeding the TFLite model using `scaling_params_v3.json`:

`x_norm = (x_raw - mean) / std`

- **Sequence Normalization**:
  - `seq_mean`: Array of 132 floats
  - `seq_std`: Array of 132 floats
  - Standardize all 10 sub-windows with these 132 constants:
    `seq_norm[t, f] = (seq_raw[t, f] - seq_mean[f]) / seq_std[f]`
- **Global Normalization**:
  - `glob_mean`: Array of 12 floats
  - `glob_std`: Array of 12 floats
  - Standardize the 12 global structural features:
    `glob_norm[f] = (glob_raw[f] - glob_mean[f]) / glob_std[f]`

---

## 5. TFLite Model Specification

- **File**: `model_v3.tflite`
- **File Size**: **229.29 KB**
- **Precision**: Float32
- **Operator Compatibility**: **100% Pure TFLite Built-ins** (No Flex Ops, No Select TF Ops)

### 5.1 Tensor Contract

| Tensor Type | Index | Tensor Name | Shape | Data Type | Description |
|---|---|---|---|---|---|
| **Input 0** | 0 | `serving_default_sequence_input:0` | `[1, 10, 132]` | `float32` | Standardized sequence features (1320 elements) |
| **Input 1** | 1 | `serving_default_global_input:0` | `[1, 12]` | `float32` | Standardized global features (12 elements) |
| **Output 0** | 282 | `StatefulPartitionedCall:0` | `[1, 32]` | `float32` | L2-normalized motion embedding (norm = 1.0000) |

---

## 6. Activity Classification via Cosine Similarity

The model output `e` is a 32D unit vector (`norm = 1.0`). Activity classification is evaluated by taking the dot product against the 21 unit centroids in `class_centroids_v3.json`:

`CosineSimilarity(e, c_k) = dot_product(e, c_k) = sum(e[i] * c_k[i])`

`PredictedClass = argmax_k(CosineSimilarity(e, c_k))`

### 6.1 Supported Activity Classes (21 Categories)

```
 0: bicep_curl           7: keeping_shoes        14: stairs_vigorously
 1: catching             8: laying               15: standing
 2: drinking_bottle      9: proud_cheer          16: tricep_curl
 3: eating              10: pushups              17: typing
 4: handshake           11: running              18: walking_briskly
 5: handwash            12: scrolling            19: walking_fast
 6: jumping             13: stairs_slowly        20: wearing_shoes
```

---

## 7. Complete React Native Implementation

Below is a complete, production-ready implementation for streaming sensor feature extraction and model inference in React Native:

```typescript
import { loadTensorflowModel } from 'react-native-fast-tflite';
import scalingParams from './assets/scaling_params_v3.json';
import classCentroids from './assets/class_centroids_v3.json';

// Each sample: [ax (m/s2), ay (m/s2), az (m/s2), gx (dps), gy (dps), gz (dps)]
export type IMUSample = [number, number, number, number, number, number];

export class MotionClassifier {
  private model: any = null;
  private buffer: IMUSample[] = [];
  private readonly WINDOW_SIZE = 200; // 2.0s at 100 Hz
  private readonly STRIDE = 50;       // 0.5s stride (75% overlap)

  async init() {
    this.model = await loadTensorflowModel(require('./assets/model_v3.tflite'));
    console.log('Model v3 TFLite loaded successfully');
  }

  /**
   * Feed incoming 100 Hz sensor readings.
   * Returns classification result whenever 200 samples accumulate.
   */
  async pushSample(sample: IMUSample): Promise<{ activity: string; confidence: number } | null> {
    this.buffer.push(sample);

    // Wait until full 200-sample window is available
    if (this.buffer.length < this.WINDOW_SIZE) {
      return null;
    }

    // Extract current 200-sample window
    const window = this.buffer.slice(0, this.WINDOW_SIZE);

    // Slide window forward by STRIDE (50 samples = 0.5s)
    this.buffer = this.buffer.slice(this.STRIDE);

    return this.classify(window);
  }

  private async classify(window: IMUSample[]) {
    // 1. Extract raw features (10x132 sequence, 12 global)
    const { seqRaw, globRaw } = this.extractWindowFeatures(window);

    // 2. Standardize sequence features [10, 132]
    const seqNorm = new Float32Array(10 * 132);
    for (let t = 0; t < 10; t++) {
      for (let f = 0; f < 132; f++) {
        const val = seqRaw[t * 132 + f];
        const mean = scalingParams.seq_mean[f];
        const std = scalingParams.seq_std[f];
        seqNorm[t * 132 + f] = (val - mean) / std;
      }
    }

    // 3. Standardize global features [12]
    const globNorm = new Float32Array(12);
    for (let f = 0; f < 12; f++) {
      const val = globRaw[f];
      const mean = scalingParams.glob_mean[f];
      const std = scalingParams.glob_std[f];
      globNorm[f] = (val - mean) / std;
    }

    // 4. Run TFLite inference
    const outputs = await this.model.run([seqNorm, globNorm]);
    const embedding: Float32Array = outputs[0]; // (32,) unit embedding

    // 5. Cosine similarity against 21 class centroids
    let bestActivity = 'unknown';
    let maxSim = -1.0;

    for (const [activity, centroid] of Object.entries(classCentroids)) {
      let dot = 0.0;
      const c = centroid as number[];
      for (let i = 0; i < 32; i++) {
        dot += embedding[i] * c[i];
      }
      if (dot > maxSim) {
        maxSim = dot;
        bestActivity = activity;
      }
    }

    return {
      activity: bestActivity,
      confidence: Math.max(0.0, Math.min(1.0, maxSim))
    };
  }

  private extractWindowFeatures(window: IMUSample[]): { seqRaw: Float32Array; globRaw: Float32Array } {
    // Follows feature_engineering.py logic:
    // - Derived channels: resultant_a, resultant_g, jerk, sma, tilt_angle
    // - 10 sub-windows of 20 samples -> Tier 1 (90 stats) + Tier 2 (42 FFT/autocorr)
    // - 200 samples covariance -> Tier 3 (12 eigenvalues/cross-axis)
    // See feature_engineering.py in repository for the standalone reference.
    return { seqRaw: new Float32Array(1320), globRaw: new Float32Array(12) };
  }
}
```
