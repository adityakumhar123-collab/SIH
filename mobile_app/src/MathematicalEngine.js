// =============================================================================
// MathematicalEngine.js — Multi-Domain Mahalanobis Baselines & Z-Scores
// =============================================================================
//
// Implements:
// 1. Exact matrix inversion with Tikhonov/ridge regularization
// 2. Full Mahalanobis Distance: D_M(x) = sqrt((x - mu)^T * Sigma^-1 * (x - mu))
// 3. Per-dimension Z-score decomposition: z_i = (x_i - mu_i) / sigma_i
// 4. Clinical Cold-Start Seeding:
//    - Physiological: NEWS2 (UK Royal College of Physicians) [HR: 72+-10, SpO2: 98+-1.2]
//    - Environmental: NOAA standard baseline [Temp: 24+-4C, RH: 50+-10%, Press: 1013.25+-5]
//    - Motion: Per-cluster centroids matching ESP32 feature set
// 5. Progressive EWMA Adaptation with Purity Gating (D_M <= 2.5)
// 6. SQLite integration with `baseline_states` table
// =============================================================================

import { getBaselineState, saveBaselineState } from './Database.js';

// Matrix inversion with ridge regularization (eps * I)
function invertSymmetricMatrix(A, eps = 1e-4) {
  const n = A.length;
  // Copy and regularize diagonal
  const mat = A.map((row, i) =>
    Array.from(row, (val, j) => (i === j ? val + eps : val))
  );

  // Augmented matrix [A | I]
  const aug = Array.from({ length: n }, (_, i) => {
    const row = new Float64Array(2 * n);
    for (let j = 0; j < n; j++) row[j] = mat[i][j];
    row[n + i] = 1.0;
    return row;
  });

  // Gauss-Jordan elimination with partial pivoting
  for (let i = 0; i < n; i++) {
    let maxRow = i;
    for (let k = i + 1; k < n; k++) {
      if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) {
        maxRow = k;
      }
    }
    if (Math.abs(aug[maxRow][i]) < 1e-12) {
      // Fallback: diagonal inversion
      const diagInv = Array.from({ length: n }, () => new Array(n).fill(0.0));
      for (let d = 0; d < n; d++) {
        diagInv[d][d] = 1.0 / (A[d][d] + eps);
      }
      return diagInv;
    }

    if (maxRow !== i) {
      const tmp = aug[i];
      aug[i] = aug[maxRow];
      aug[maxRow] = tmp;
    }

    const pivot = aug[i][i];
    for (let j = 0; j < 2 * n; j++) aug[i][j] /= pivot;

    for (let k = 0; k < n; k++) {
      if (k !== i) {
        const factor = aug[k][i];
        for (let j = 0; j < 2 * n; j++) {
          aug[k][j] -= factor * aug[i][j];
        }
      }
    }
  }

  // Extract right half
  return aug.map(row => Array.from(row.slice(n)));
}

// Compute Mahalanobis distance D_M = sqrt(diff^T * invCov * diff)
function mahalanobisDistance(x, mu, invCov) {
  const n = x.length;
  const diff = new Float64Array(n);
  for (let i = 0; i < n; i++) diff[i] = x[i] - mu[i];

  let quad = 0.0;
  for (let i = 0; i < n; i++) {
    let rowSum = 0.0;
    for (let j = 0; j < n; j++) {
      rowSum += invCov[i][j] * diff[j];
    }
    quad += diff[i] * rowSum;
  }

  return Math.sqrt(Math.max(0.0, quad));
}

// Compute per-dimension z-scores: z_i = (x_i - mu_i) / sqrt(Cov[i][i])
function computeZScores(x, mu, cov) {
  const zScores = {};
  for (let i = 0; i < x.length; i++) {
    const std = Math.sqrt(Math.max(1e-6, cov[i][i]));
    zScores[i] = (x[i] - mu[i]) / std;
  }
  return zScores;
}

// NEWS2 & Clinical Cold-Start Baseline Definitions
export const COLD_START_BASELINES = {
  physiology: {
    domain: 'physiology',
    sub_key: 'global',
    dimension_names: ['hr', 'spo2'],
    mean_vector: [72.0, 98.0],
    covariance_matrix: [
      [144.0, -2.0],  // std(HR) = 12 bpm
      [-2.0,  4.0]    // std(SpO2) = 2.0% (healthy adult 94-100% does not falsely trigger)
    ],
    sample_count: 50,
    purity_gate_threshold: 3.0,
    source: 'COLD_START_NEWS2'
  },
  environment: {
    domain: 'environment',
    sub_key: 'global',
    dimension_names: ['temperature', 'humidity', 'pressure'],
    mean_vector: [24.0, 50.0, 1013.25],
    covariance_matrix: [
      [16.0,  0.0,   0.0],  // std(Temp) = 4.0 °C
      [0.0, 100.0,   0.0],  // std(RH) = 10.0 %
      [0.0,   0.0,  25.0]   // std(Press) = 5.0 hPa
    ],
    sample_count: 50,
    purity_gate_threshold: 3.0,
    source: 'COLD_START_NOAA'
  },
  motion: {
    domain: 'motion',
    sub_key: 'resting',
    dimension_names: ['accel_rms', 'gyro_rms', 'jerk', 'sma'],
    mean_vector: [9.8, 2.0, 0.05, 9.8],
    covariance_matrix: [
      [0.04, 0.0,  0.0,  0.0],
      [0.0,  0.25, 0.0,  0.0],
      [0.0,  0.0,  0.01, 0.0],
      [0.0,  0.0,  0.0,  0.04]
    ],
    sample_count: 50,
    purity_gate_threshold: 2.5,
    source: 'COLD_START_MOTION'
  }
};

class MathematicalEngineClass {
  constructor() {
    this.cachedBaselines = new Map(); // key: "domain:subKey" -> baseline state
    this.cachedInverseCovs = new Map(); // key: "domain:subKey" -> inverted matrix
    this.EWMA_ALPHA = 0.015; // 1.5% learning rate for healthy baseline drift
  }

  /**
   * Initializes all domain baselines from SQLite, seeding cold-start values if empty.
   */
  initialize() {
    this.cachedBaselines.clear();
    this.cachedInverseCovs.clear();

    for (const [domain, seed] of Object.entries(COLD_START_BASELINES)) {
      let state = getBaselineState(domain, seed.sub_key);
      if (!state || (domain === 'physiology' && (state.covariance_matrix?.[1]?.[1] < 3.0 || state.source === 'COLD_START_NEWS2'))) {
        saveBaselineState(seed);
        state = seed;
      }
      this.cacheBaseline(state);
    }
    console.log('[MathematicalEngine] Initialized baselines for domains:', Array.from(this.cachedBaselines.keys()));
  }

  cacheBaseline(state) {
    const key = `${state.domain}:${state.sub_key || 'global'}`;
    this.cachedBaselines.set(key, state);
    const invCov = invertSymmetricMatrix(state.covariance_matrix);
    this.cachedInverseCovs.set(key, invCov);
  }

  getBaseline(domain, subKey = 'global') {
    const key = `${domain}:${subKey}`;
    if (!this.cachedBaselines.has(key)) {
      // Try loading from DB
      let state = getBaselineState(domain, subKey);
      if (!state) {
        // Fallback to cold-start seed or generic diagonal
        state = COLD_START_BASELINES[domain] || {
          domain,
          sub_key: subKey,
          dimension_names: ['dim1', 'dim2'],
          mean_vector: [0.0, 0.0],
          covariance_matrix: [[1.0, 0.0], [0.0, 1.0]],
          sample_count: 10,
          purity_gate_threshold: 2.5,
          source: 'DEFAULT_FALLBACK'
        };
        saveBaselineState(state);
      }
      this.cacheBaseline(state);
    }
    return this.cachedBaselines.get(key);
  }

  /**
   * Evaluates observation vector against a domain baseline.
   *
   * @param {string} domain - 'physiology' | 'environment' | 'motion'
   * @param {number[]} vector - e.g. [hr, spo2]
   * @param {string} subKey - e.g. 'global' or activity class
   * @returns {{ distance: number, zScores: Object, isOutlier: boolean }}
   */
  evaluateDomain(domain, vector, subKey = 'global') {
    const baseline = this.getBaseline(domain, subKey);
    const key = `${domain}:${subKey}`;
    const invCov = this.cachedInverseCovs.get(key);

    const distance = mahalanobisDistance(vector, baseline.mean_vector, invCov);
    const rawZ = computeZScores(vector, baseline.mean_vector, baseline.covariance_matrix);

    // Map raw numeric indices to named dimensions (e.g. zScores.hr = 2.1)
    const namedZ = {};
    baseline.dimension_names.forEach((name, idx) => {
      namedZ[name] = Number((rawZ[idx] || 0.0).toFixed(2));
    });

    const isOutlier = distance > (baseline.purity_gate_threshold || 2.5);

    return {
      domain,
      distance: Number(distance.toFixed(3)),
      zScores: namedZ,
      isOutlier
    };
  }

  /**
   * Updates baseline using progressive EWMA if purity gate is passed.
   *
   * @param {string} domain
   * @param {number[]} vector
   * @param {string} subKey
   * @param {boolean} isAcuteAlertActive - if true, purity gate fails immediately
   */
  updateBaselineEWMA(domain, vector, subKey = 'global', isAcuteAlertActive = false) {
    if (isAcuteAlertActive) return; // Never adapt to pathological/emergency states

    const baseline = this.getBaseline(domain, subKey);
    const key = `${domain}:${subKey}`;
    const invCov = this.cachedInverseCovs.get(key);

    const distance = mahalanobisDistance(vector, baseline.mean_vector, invCov);
    if (distance > baseline.purity_gate_threshold) {
      return; // Purity gate rejection: sample is too far from normal
    }

    const alpha = this.EWMA_ALPHA;
    const n = vector.length;

    // 1. EWMA mean update: mu_t = (1 - alpha)*mu_{t-1} + alpha*x_t
    const newMean = new Array(n);
    for (let i = 0; i < n; i++) {
      newMean[i] = (1.0 - alpha) * baseline.mean_vector[i] + alpha * vector[i];
    }

    // 2. EWMA covariance update: Sigma_t = (1 - alpha)*Sigma_{t-1} + alpha*(x_t - mu_t)(x_t - mu_t)^T
    const diff = new Float64Array(n);
    for (let i = 0; i < n; i++) diff[i] = vector[i] - newMean[i];

    const newCov = Array.from({ length: n }, (_, i) => {
      const row = new Array(n);
      for (let j = 0; j < n; j++) {
        const outer = diff[i] * diff[j];
        row[j] = (1.0 - alpha) * baseline.covariance_matrix[i][j] + alpha * outer;
      }
      return row;
    });

    const updatedState = {
      ...baseline,
      mean_vector: newMean,
      covariance_matrix: newCov,
      sample_count: (baseline.sample_count || 0) + 1,
      source: 'PERSONALIZED_EWMA'
    };

    this.cacheBaseline(updatedState);
    saveBaselineState(updatedState);
  }
}

export const MathematicalEngine = new MathematicalEngineClass();
