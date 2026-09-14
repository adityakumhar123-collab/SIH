// =============================================================================
// EpisodeEngine.js — Multi-Sensor Continuity Segmentation & Inference Orchestrator
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW:
// --------------------------------
// EpisodeEngine is the real-time sensor ingestion and time-series feature pipeline.
// It transforms high-rate raw sensor streams into continuous human activity episodes,
// physiological vitals, and diagnostic evidence packets.
//
// SENSOR INGESTION & BUFFER SIZING:
// ---------------------------------
// - Motion: Ingests 6-DoF IMU [ax, ay, az, gx, gy, gz] samples at 100 Hz via pushMotionSample().
// - Photoplethysmography (PPG): Ingests raw Red and Infrared optical sensor counts at 100 Hz.
// - Environmental: Ingests ambient Temperature (°C), Relative Humidity (%), and Pressure (hPa) at 1 Hz.
//
// SLIDING WINDOW & STRIDE MATH:
// -----------------------------
// - WINDOW_SIZE = 200 samples (2.0 seconds at 100 Hz)
// - STRIDE_SIZE = 50 samples (0.5 seconds at 100 Hz -> 2.0 Hz inference rate)
// - Every 500ms, the oldest 50 samples slide out, and processWindow() is invoked.
//
// MODEL V3 21-CLASS ACTIVITY RECOGNITION:
// ---------------------------------------
// 1. extractWindowFeatures(): Computes 144 features:
//    - Tier 1: 90 statistical features (Mean, Std, Min, Max, RMS, Zero-Crossings, Jerk)
//    - Tier 2: 42 spectral features (FFT dominant frequency, spectral energy, spectral entropy)
//    - Tier 3: 12 covariance eigenvalues (Linearity, Planarity, Spherical dispersion)
// 2. standardizeFeatures(): Normalizes features using z-score scalers from model_v3.json.
// 3. generateFallbackEmbedding(): Projects 144 normalized features into a 32D unit hypersphere.
// 4. classifyEmbedding(): Evaluates cosine dot-product against 21 class centroids,
//    selecting the class with maximum cosine similarity.
//
// DEBOUNCING & EPISODE PERSISTENCE:
// ---------------------------------
// - To prevent rapid flickering during transient motion, a 10-window majority rule is used.
// - An activity transition is only committed if >= 8 of the last 10 windows classify as the new class.
// - Continuous episodes are saved into SQLite (`episodes` table) with duration, aggregate means,
//   and min/max physiological markers.
// =============================================================================

import {
  saveEpisode,
  getActiveEpisode,
  storeDiagnosticEvent
} from './Database.js';
import {
  extractWindowFeatures,
  standardizeFeatures,
  classifyEmbedding,
  generateFallbackEmbedding,
  processPpgWaveform,
  computeHeatIndex
} from './FeatureExtraction.js';
import { MathematicalEngine } from './MathematicalEngine.js';
import { DiagnosticReasoningEngine } from './DiagnosticReasoningEngine.js';
import { GemmaService } from './GemmaService.js';
import { LocationEngine } from './LocationEngine.js';

class EpisodeEngineClass {
  constructor() {
    this.activeEpisode = null;
    this.imuBuffer = [];       // Array of [ax, ay, az, gx, gy, gz] samples (100 Hz)
    this.redBuffer = [];       // Raw Red channel samples (100 Hz)
    this.irBuffer = [];        // Raw IR channel samples (100 Hz)
    this.latestEnv = { tempC: 24.0, pressHpa: 1013.25, humPct: 50.0 };

    this.WINDOW_SIZE = 200;    // 2.0s window @ 100 Hz
    this.STRIDE_SIZE = 50;     // 0.5s stride @ 100 Hz = 2.0 Hz inference tick
    this.classificationHistory = []; // Rolling FIFO of last 10 classifications for debounce

    // Running physiological & environmental telemetry accumulators for open episode
    this.sampleCounts = 0;
    this.hrAccumulator = [];
    this.spo2Accumulator = [];
    this.tempAccumulator = [];
    this.heatIndexAccumulator = [];
    this.accelRmsAccumulator = [];

    // Current real-time state exposed to UI and ContextEngine
    this.currentVitals = { hr: 72, spo2: 98.0, hrv: 45.0 };
    this.currentHeatIndex = { heatIndexF: 75.0, tier: 'NORMAL', riskLevel: 0 };
    this.currentActivity = { activityClass: 'standing', confidence: 1.0 };
    this.currentDiagnostic = null;
    this.anomalyPersistenceMinutes = 0;
    this.anomalyStartTimestamp = 0;
  }

  initialize() {
    this.imuBuffer = [];
    this.redBuffer = [];
    this.irBuffer = [];
    this.classificationHistory = [];
    this.sampleCounts = 0;
    this.hrAccumulator = [];
    this.spo2Accumulator = [];
    this.tempAccumulator = [];
    this.heatIndexAccumulator = [];
    this.accelRmsAccumulator = [];

    MathematicalEngine.initialize();
    this.restoreActiveEpisode();
  }

  restoreActiveEpisode() {
    try {
      const openEpisode = getActiveEpisode();
      if (openEpisode) {
        this.activeEpisode = openEpisode;
        console.log(`[EpisodeEngine] Restored open Episode ID: ${openEpisode.episode_id} (${openEpisode.activity_class})`);
      } else {
        this.activeEpisode = null;
      }
    } catch (e) {
      console.warn('[EpisodeEngine] Failed to restore open episode:', e);
      this.activeEpisode = null;
    }
  }

  /**
   * Resets anomaly persistence timer, called when user verifies safety / cancels alert.
   */
  resetAnomalyPersistence() {
    this.anomalyStartTimestamp = 0;
    this.anomalyPersistenceMinutes = 0;
  }

  // Ingest raw 100 Hz Motion Sample [ax, ay, az, gx, gy, gz]
  pushMotionSample(sample) {
    this.imuBuffer.push(sample);
    if (this.imuBuffer.length > 300) {
      this.imuBuffer.splice(0, this.imuBuffer.length - 200);
    }
  }

  // Ingest raw 100 Hz Vital Sample (red, ir)
  pushVitalSample(red, ir) {
    this.redBuffer.push(red);
    this.irBuffer.push(ir);
    if (this.redBuffer.length > 400) {
      this.redBuffer.shift();
      this.irBuffer.shift();
    }
  }

  // Ingest 1 Hz Environment Reading (tempC, pressHpa, humPct)
  pushEnvironmentSample(tempC, pressHpa, humPct) {
    this.latestEnv = { tempC, pressHpa, humPct };
  }

  /**
   * Evaluates the sliding window when 200 samples have accumulated.
   * Runs feature extraction, Model v3 inference, debouncing, and reasoning.
   * Returns complete telemetry packet or null if accumulating.
   *
   * @returns {Object|null} Telemetry packet containing activity, vitals, diagnostic contract, and peak accel
   */
  processWindow() {
    if (this.imuBuffer.length < this.WINDOW_SIZE) {
      return null;
    }

    const window = this.imuBuffer.slice(0, this.WINDOW_SIZE);
    this.imuBuffer.splice(0, this.STRIDE_SIZE); // Slide by 50 samples (0.5s = 2 Hz tick)

    // 1. Feature Extraction: Tier 1 (Stats), Tier 2 (Spectral FFT), Tier 3 (Covariance Eigenvalues)
    let seqRaw, globRaw;
    try {
      const feats = extractWindowFeatures(window);
      seqRaw = feats.seqRaw;
      globRaw = feats.globRaw;
    } catch (err) {
      console.warn('[EpisodeEngine] Feature extraction failed:', err);
      return null;
    }

    // 2. Feature Standardization & 32D Unit Embedding Projection
    const { seqNorm, globNorm } = standardizeFeatures(seqRaw, globRaw);
    const embedding = generateFallbackEmbedding(seqNorm, globNorm);

    // 3. 21-Class Activity Recognition via Cosine Distance against Centroids
    const { activityClass, confidence } = classifyEmbedding(embedding);
    this.currentActivity = { activityClass, confidence };

    // 4. PPG Waveform Processing (Heart Rate, SpO2 via AC/DC ratio, HRV RMSSD)
    const ppg = processPpgWaveform(this.redBuffer, this.irBuffer);
    if (ppg.hr > 0) {
      this.currentVitals = { hr: ppg.hr, spo2: ppg.spo2, hrv: ppg.hrv };
    }

    // 5. Environmental Heat Index (NOAA Rothfusz regression equation)
    const heat = computeHeatIndex(this.latestEnv.tempC, this.latestEnv.humPct);
    this.currentHeatIndex = heat;

    // 6. Update Location Engine with latest vitals context
    if (LocationEngine.currentGps) {
      LocationEngine.onLocationUpdate(LocationEngine.currentGps, {
        tempC: this.latestEnv.tempC,
        humidityPct: this.latestEnv.humPct,
        restingHr: this.currentVitals.hr
      });
    }

    // 7. Calculate RMS & peak acceleration for this window (in mg)
    let sumAccelSq = 0.0;
    let maxAccelMg = 0.0;
    for (let i = 0; i < this.WINDOW_SIZE; i++) {
      const s = window[i];
      const mag = Math.sqrt(s[0] * s[0] + s[1] * s[1] + s[2] * s[2]);
      sumAccelSq += mag * mag;
      const magMg = (mag / 9.80665) * 1000.0;
      if (magMg > maxAccelMg) maxAccelMg = magMg;
    }
    const accelRms = Math.sqrt(sumAccelSq / this.WINDOW_SIZE);
    const eigenvalueRatio = globRaw[3]; // Linearity feature (1.0 = single axis, 0.0 = spherical)

    // 8. Mathematical Engine Mahalanobis Baselines
    const physEval = MathematicalEngine.evaluateDomain(
      'physiology',
      [this.currentVitals.hr, this.currentVitals.spo2]
    );
    const envEval = MathematicalEngine.evaluateDomain(
      'environment',
      [this.latestEnv.tempC, this.latestEnv.humPct, this.latestEnv.pressHpa]
    );

    // Track anomaly duration (persistence minutes)
    const isAnomalous = physEval.isOutlier || envEval.isOutlier || heat.riskLevel >= 2;
    if (isAnomalous) {
      if (this.anomalyStartTimestamp === 0) this.anomalyStartTimestamp = Date.now();
      this.anomalyPersistenceMinutes = Number(((Date.now() - this.anomalyStartTimestamp) / 60000.0).toFixed(1));
    } else {
      this.anomalyStartTimestamp = 0;
      this.anomalyPersistenceMinutes = 0;
      // Normal state: admit sample to update baseline EWMA
      MathematicalEngine.updateBaselineEWMA(
        'physiology',
        [this.currentVitals.hr, this.currentVitals.spo2],
        'global',
        false
      );
    }

    // 9. Diagnostic Reasoning Engine Evaluation (Clinical Contract)
    const currentLocId = LocationEngine.activeVisit ? LocationEngine.activeVisit.location_id : null;
    const diagnosticContract = DiagnosticReasoningEngine.evaluate({
      physEval,
      envEval,
      heatIndex: heat,
      activityClass,
      activityConfidence: confidence,
      peakAccelMg: maxAccelMg,
      eigenvalueRatio,
      hr: this.currentVitals.hr,
      spo2: this.currentVitals.spo2,
      locationId: currentLocId,
      persistenceMinutes: this.anomalyPersistenceMinutes
    });
    this.currentDiagnostic = diagnosticContract;

    // Asynchronously generate Gemma explanation and log if non-unclear
    if (diagnosticContract.primary_hypothesis !== 'ANOMALY_UNCLEAR') {
      GemmaService.generateGuidance(diagnosticContract).then(gemmaRes => {
        diagnosticContract.gemma_message = gemmaRes.userMessage;
        diagnosticContract.recommended_action = gemmaRes.recommendedAction;
        try {
          const eventId = storeDiagnosticEvent({
            ...diagnosticContract,
            episode_id: this.activeEpisode ? this.activeEpisode.episode_id : null,
            location_id: currentLocId
          });
          diagnosticContract.event_id = eventId;
        } catch (e) {
          // ignore duplicate log error
        }
      });
    }

    // 10. Accumulate metrics for episode continuity
    this.sampleCounts++;
    this.hrAccumulator.push(this.currentVitals.hr);
    this.spo2Accumulator.push(this.currentVitals.spo2);
    this.tempAccumulator.push(this.latestEnv.tempC);
    this.heatIndexAccumulator.push(heat.heatIndexF);
    this.accelRmsAccumulator.push(accelRms);

    // 11. 10-Window Debounce Boundary Rule
    this.classificationHistory.push(activityClass);
    if (this.classificationHistory.length > 10) {
      this.classificationHistory.shift();
    }

    // Check if >= 8 of last 10 belong to a new class
    const classTally = {};
    for (const c of this.classificationHistory) {
      classTally[c] = (classTally[c] || 0) + 1;
    }

    let dominantNewClass = null;
    for (const [c, count] of Object.entries(classTally)) {
      if (count >= 8) {
        dominantNewClass = c;
        break;
      }
    }

    if (!this.activeEpisode) {
      this.createEpisode(dominantNewClass || activityClass, confidence, currentLocId);
    } else {
      if (dominantNewClass && dominantNewClass !== this.activeEpisode.activity_class) {
        // Episode boundary transition
        this.closeEpisode();
        this.createEpisode(dominantNewClass, confidence, currentLocId);
      } else {
        this.extendEpisode();
      }
    }

    return {
      activityClass,
      activityConfidence: confidence,
      vitals: this.currentVitals,
      heatIndex: heat,
      diagnostic: diagnosticContract,
      physEval,
      envEval,
      accelRms,
      peakAccelMg: maxAccelMg,
      activeEpisode: this.activeEpisode
    };
  }

  createEpisode(activityClass, confidence, locationId) {
    this.sampleCounts = 1;
    this.hrAccumulator = [this.currentVitals.hr];
    this.spo2Accumulator = [this.currentVitals.spo2];
    this.tempAccumulator = [this.latestEnv.tempC];
    this.heatIndexAccumulator = [this.currentHeatIndex.heatIndexF];
    this.accelRmsAccumulator = [9.8];

    const ep = {
      start_timestamp: Date.now(),
      end_timestamp: null,
      duration_seconds: 0.5,
      activity_class: activityClass,
      activity_confidence: confidence,
      location_id: locationId,
      hr_mean: this.currentVitals.hr,
      hr_min: this.currentVitals.hr,
      hr_max: this.currentVitals.hr,
      hr_variance: 0.0,
      hrv_rmssd: this.currentVitals.hrv,
      spo2_mean: this.currentVitals.spo2,
      spo2_min: this.currentVitals.spo2,
      spo2_max: this.currentVitals.spo2,
      spo2_variance: 0.0,
      temperature_mean: this.latestEnv.tempC,
      humidity_mean: this.latestEnv.humPct,
      pressure_mean: this.latestEnv.pressHpa,
      heat_index_mean: this.currentHeatIndex.heatIndexF,
      heat_index_max: this.currentHeatIndex.heatIndexF,
      accel_rms_mean: 9.8,
      gyro_rms_mean: 0.0,
      jerk_mean: 0.0,
      sma_mean: 9.8
    };

    try {
      const episodeId = saveEpisode(ep);
      this.activeEpisode = { ...ep, episode_id: episodeId };
      console.log(`[EpisodeEngine] Opened Episode ID ${episodeId} for activity: ${activityClass}`);
    } catch (e) {
      console.warn('[EpisodeEngine] Failed to create episode:', e);
    }
  }

  extendEpisode() {
    if (!this.activeEpisode) return;
    const duration = (Date.now() - this.activeEpisode.start_timestamp) / 1000.0;
    this.activeEpisode.duration_seconds = Number(duration.toFixed(1));

    // Running means
    if (this.hrAccumulator.length > 0) {
      const hrSum = this.hrAccumulator.reduce((a, b) => a + b, 0);
      this.activeEpisode.hr_mean = Number((hrSum / this.hrAccumulator.length).toFixed(1));
      this.activeEpisode.hr_min = Math.min(...this.hrAccumulator);
      this.activeEpisode.hr_max = Math.max(...this.hrAccumulator);
    }
    if (this.spo2Accumulator.length > 0) {
      const spo2Sum = this.spo2Accumulator.reduce((a, b) => a + b, 0);
      this.activeEpisode.spo2_mean = Number((spo2Sum / this.spo2Accumulator.length).toFixed(1));
      this.activeEpisode.spo2_min = Math.min(...this.spo2Accumulator);
      this.activeEpisode.spo2_max = Math.max(...this.spo2Accumulator);
    }
    if (this.heatIndexAccumulator.length > 0) {
      this.activeEpisode.heat_index_max = Math.max(...this.heatIndexAccumulator);
    }
  }

  closeEpisode() {
    if (!this.activeEpisode) return;
    this.activeEpisode.end_timestamp = Date.now();
    this.extendEpisode();

    try {
      saveEpisode(this.activeEpisode);
      console.log(`[EpisodeEngine] Closed Episode ID ${this.activeEpisode.episode_id} (${this.activeEpisode.activity_class}, Duration: ${this.activeEpisode.duration_seconds}s)`);
    } catch (e) {
      console.warn('[EpisodeEngine] Failed to close episode:', e);
    }
    this.activeEpisode = null;
  }
}

export const EpisodeEngine = new EpisodeEngineClass();
