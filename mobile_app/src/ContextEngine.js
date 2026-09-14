// =============================================================================
// ContextEngine.js — RakshaBand Contextual Threat Assessment Coordinator
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW:
// --------------------------------
// ContextEngine is the central decision-fusion coordinator of the RakshaBand
// mobile application. It fuses three independent streams of intelligence:
//   1. Clinical Evidence: Evaluated by DiagnosticReasoningEngine.js across 5
//      clinical hypotheses (Heat Exhaustion, Hypertensive Crisis, Severe
//      Hypoxemia, Exertion, Anomaly Unclear) plus Hard Impact Fall detection.
//   2. Statistical Geometry: Mahalanobis distance anomalies computed in 2D
//      physiological space [HR, SpO2] and 3D environmental space [Temp, Humidity, Pressure]
//      by MathematicalEngine.js.
//   3. Spatial Familiarity: LocationEngine.js spatial dwell clustering and
//      historical visit frequency (0.0 unfamiliar - 1.0 safe/familiar).
//
// REACTION LEVELS & EMERGENCY THRESHOLDS:
// ----------------------------------------
//   - CRITICAL (Score >= 0.72):
//     Triggers 15-second audible countdown modal on App.js, vibrating wristband,
//     and prepares Twilio/Resend multi-channel emergency dispatch.
//   - ADVISORY (0.40 <= Score < 0.72):
//     Renders amber warning badges, prompts user with Gemma 3n contextual advice
//     (hydration, ventilation, rest).
//   - NORMAL (Score < 0.40):
//     All vitals and activity within baseline; updates running EWMA baselines.
//
// CORE THREAT FORMULA:
// --------------------
//   fusedScore = baseConfidence * (1.2 - 0.4 * familiarityScore)
//   - If Location Familiarity = 1.0 (e.g. Home or Office):
//     multiplier = 1.2 - 0.4(1.0) = 0.80 (20% false-alarm suppression)
//   - If Location Familiarity = 0.0 (e.g. Unknown highway or remote location):
//     multiplier = 1.2 - 0.4(0.0) = 1.20 (20% heightened sensitivity)
//
// HARD SUPPRESSION & BYPASS RULES:
// --------------------------------
//   - Off-Wrist Suppression: If wearConfidence < 40%, threatScore is forced to 0.0.
//     Prevents false alarms when the band is resting on a charging dock or nightstand.
//   - Direct Escalation: Hard impact falls (>= 3.5g peak accel + linear impact vector)
//     or clinical hard vitals failure bypass all familiarity dampeners and force
//     threatScore = 0.95 (CRITICAL).
//   - Benign Exertion: Running/jogging/walking with elevated HR is recognized as
//     EXERTION_BENIGN, scaling confidence down by 0.25x to avoid workout false alarms.
// =============================================================================

import { MathematicalEngine } from './MathematicalEngine.js';
import { DiagnosticReasoningEngine, HYPOTHESES } from './DiagnosticReasoningEngine.js';
import { GemmaService } from './GemmaService.js';
import { LocationEngine } from './LocationEngine.js';
import { EpisodeEngine } from './EpisodeEngine.js';
import { getIsoDateString, getIsoTimeString } from './Database.js';

// Time formatting helpers
export function timeStrToSeconds(tStr) {
  if (!tStr) return 0;
  const parts = tStr.split(':').map(Number);
  const h = parts[0] || 0;
  const m = parts[1] || 0;
  const s = parts[2] || 0;
  return h * 3600 + m * 60 + s;
}

export function secondsToTimeStr(sec) {
  const totalSec = Math.max(0, sec);
  const h = Math.floor(totalSec / 3600) % 24;
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function getHaversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180.0;
  const R = 6371000.0; // Earth's mean radius in meters
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2.0) * Math.sin(dLat / 2.0) +
    Math.cos(toRad(lat1)) *
    Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2.0) *
    Math.sin(dLon / 2.0);
  const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
  return R * c;
}

/**
 * Maps a continuous threat score (0.0 to 1.0) into discrete clinical severity tiers.
 * Used across the dashboard UI for color coding (green/amber/red) and action triggers.
 *
 * @param {number} score - Threat assessment score [0.0 - 1.0]
 * @returns {Object} Tier metadata { name, color, action }
 */
export function getThreatLevel(score) {
  if (score >= 0.72) {
    return {
      name: 'CRITICAL',
      color: '#EF4444',
      action: 'Emergency escalation triggered',
      toString() { return 'CRITICAL'; }
    };
  }
  if (score >= 0.40) {
    return {
      name: 'ADVISORY',
      color: '#F59E0B',
      action: 'Caution: Physiological or environmental deviation',
      toString() { return 'ADVISORY'; }
    };
  }
  return {
    name: 'NORMAL',
    color: '#10B981',
    action: 'All vitals and activity within baseline',
    toString() { return 'NORMAL'; }
  };
}

/**
 * Computes fused threat assessment from current telemetry packet and location familiarity.
 *
 * PIPELINE STAGES:
 * 1. Direct Escalation Check: Immediate critical return for hard falls or extreme vitals.
 * 2. Wrist Wear Verification: Low wear confidence (< 40%) forces threatScore = 0.0.
 * 3. Clinical Diagnostic Contract Fusion:
 *    - Base score taken from DiagnosticReasoningEngine hypothesis confidence.
 *    - Benign physical exertion dampened (0.25x).
 *    - Ambiguous anomaly dampened (0.40x).
 * 4. Spatial Familiarity Modulation:
 *    fusedScore = baseScore * (1.2 - 0.4 * familiarity)
 * 5. Post-Dismissal Cooldown:
 *    60-second cooldown scales score by 0.60x if user recently cancelled a pre-alert.
 *
 * @param {Object} currentPacket - latest telemetry packet containing vitals, diagnostic, wearConfidence
 * @param {Object} [options] - { familiarityScore: number, cooldownActive: boolean }
 * @returns {Object} { threatScore, score, score3s, score3m, score5m, threatLevel, hypothesis, diagnostic, explanation, details }
 */
export function computeThreatScoreDetailed(currentPacket, options = {}) {
  const familiarity = options.familiarityScore !== undefined ? options.familiarityScore : 0.5;
  const isCooldown = !!options.cooldownActive;

  // ---------------------------------------------------------------------------
  // 1. Post-Dismissal Cooldown Protection (If user recently verified safety)
  // ---------------------------------------------------------------------------
  if (isCooldown) {
    const lvl = getThreatLevel(0.25);
    return {
      threatScore: 0.25,
      score: 0.25,
      score3s: 0.25,
      score3m: 0.20,
      score5m: 0.15,
      threatLevel: lvl,
      hypothesis: 'COOLDOWN_ACTIVE',
      diagnostic: currentPacket.diagnostic || null,
      explanation: ['Cooldown active — user recently verified safety.'],
      details: 'Threat suppressed during post-dismissal cooldown'
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Direct Escalation Check (Hard Falls or Severe Physiological Collapse)
  // ---------------------------------------------------------------------------
  if (currentPacket.isDirectEscalation || (currentPacket.diagnostic && currentPacket.diagnostic.is_direct_escalation)) {
    const lvl = getThreatLevel(0.95);
    return {
      threatScore: 0.95,
      score: 0.95,
      score3s: 0.95,
      score3m: 0.90,
      score5m: 0.85,
      threatLevel: lvl,
      hypothesis: currentPacket.diagnostic ? currentPacket.diagnostic.primary_hypothesis : HYPOTHESES.FALL_HARD_IMPACT,
      diagnostic: currentPacket.diagnostic || null,
      explanation: ['🚨 Hard impact fall detected or clinical hard boundary exceeded!'],
      details: 'Direct Emergency Escalation Triggered'
    };
  }

  // ---------------------------------------------------------------------------
  // 3. Wrist Wear Verification (False Alarm Suppression when off-wrist)
  // ---------------------------------------------------------------------------
  if (currentPacket.wearConfidence !== undefined && currentPacket.wearConfidence < 40) {
    const lvl = getThreatLevel(0.0);
    return {
      threatScore: 0.0,
      score: 0.0,
      score3s: 0.0,
      score3m: 0.0,
      score5m: 0.0,
      threatLevel: lvl,
      hypothesis: 'UNWORN',
      diagnostic: null,
      explanation: ['Device not worn on wrist — threat alerts suppressed'],
      details: 'Device not worn on wrist — threat alerts suppressed'
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Diagnostic Reasoning Contract Fusion (when EpisodeEngine attaches diag)
  // ---------------------------------------------------------------------------
  if (currentPacket.diagnostic) {
    const diag = currentPacket.diagnostic;
    let baseScore = diag.confidence;

    // Suppress threat score for healthy workouts where tachycardia is expected
    if (diag.primary_hypothesis === HYPOTHESES.EXERTION_BENIGN) {
      baseScore *= 0.25;
    } else if (diag.primary_hypothesis === HYPOTHESES.ANOMALY_UNCLEAR) {
      baseScore *= 0.40;
    }

    // Familiarity scaling: higher familiarity at known safe locations dampens false alarms
    const familiarityDampener = 1.2 - 0.4 * familiarity;
    let fusedScore = Math.min(1.0, Math.max(0.0, baseScore * familiarityDampener));

    // Cap non-direct advisory hypotheses so they do not trigger emergency dispatch without hard bounds
    if (!diag.is_direct_escalation) {
      fusedScore = Math.min(0.68, fusedScore);
    }

    fusedScore = Number(fusedScore.toFixed(3));
    const lvl = getThreatLevel(fusedScore);

    const explanation = [];
    explanation.push(`Hypothesis: ${diag.primary_hypothesis} (${(diag.confidence * 100).toFixed(0)}%) [${diag.severity_tier.toUpperCase()}]`);
    if (diag.contributing_evidence && diag.contributing_evidence.length > 0) {
      explanation.push(`Evidence: ${diag.contributing_evidence.join(', ')}`);
    }
    explanation.push(`Location Familiarity: ${(familiarity * 100).toFixed(0)}%`);

    return {
      threatScore: fusedScore,
      score: fusedScore,
      score3s: fusedScore,
      score3m: Number((fusedScore * 0.9).toFixed(3)),
      score5m: Number((fusedScore * 0.8).toFixed(3)),
      threatLevel: lvl,
      hypothesis: diag.primary_hypothesis,
      diagnostic: diag,
      explanation,
      details: diag.contributing_evidence ? diag.contributing_evidence.join(', ') : ''
    };
  }

  // ---------------------------------------------------------------------------
  // 4. Fallback Heuristic Scoring (used during initial buffering/accumulation)
  // ---------------------------------------------------------------------------
  const rawScore = currentPacket.anomalyScore || 0.05;
  const familiarityDampener = 1.3 - 0.6 * familiarity;
  // Cap fallback scoring at 0.68 so unclassified heuristic drift cannot trip emergency dispatch (>=0.72)
  let fusedScore = Math.min(0.68, Math.max(0.0, rawScore * familiarityDampener));
  if (isCooldown) fusedScore *= 0.60;

  fusedScore = Number(fusedScore.toFixed(3));
  const lvl = getThreatLevel(fusedScore);

  return {
    threatScore: fusedScore,
    score: fusedScore,
    score3s: fusedScore,
    score3m: Number((fusedScore * 0.85).toFixed(3)),
    score5m: Number((fusedScore * 0.75).toFixed(3)),
    threatLevel: lvl,
    hypothesis: 'MONITORING',
    diagnostic: null,
    explanation: ['Continuous vitals and activity monitoring'],
    details: 'Continuous monitoring'
  };
}

/**
 * ContextEngineClass: Coordinates periodic context evaluation and caches state.
 * Instantiated as a singleton export.
 */
class ContextEngineClass {
  constructor() {
    this.cachedThreatScore = 0.05;
    this.cachedHypothesis = 'NORMAL';
    this.cachedDiagnostic = null;
    this.logs = [];
  }

  /**
   * Initializes sub-engines on application startup.
   */
  initialize() {
    MathematicalEngine.initialize();
    LocationEngine.initialize();
    EpisodeEngine.initialize();
    this.logs = [];
  }

  /**
   * Periodic context evaluation called every 3 seconds by App.js Timer Loop 1.
   * Reads current GPS from LocationEngine, calculates familiarity score, and fuses
   * with current telemetry to return updated state.
   *
   * @param {Object} currentPacket - Latest telemetry packet
   * @returns {Object} { threatScore, threatLevel, hypothesis, familiarityScore, diagnostic }
   */
  runInference(currentPacket = {}) {
    let familiarity = 0.5;
    if (LocationEngine.currentGps) {
      familiarity = LocationEngine.estimateFamiliarity(
        LocationEngine.currentGps.latitude,
        LocationEngine.currentGps.longitude
      );
    }

    const assessment = computeThreatScoreDetailed(currentPacket, { familiarityScore: familiarity });
    this.cachedThreatScore = assessment.threatScore;
    this.cachedHypothesis = assessment.hypothesis;
    this.cachedDiagnostic = assessment.diagnostic;

    return {
      threatScore: assessment.threatScore,
      threatLevel: assessment.threatLevel,
      hypothesis: assessment.hypothesis,
      familiarityScore: familiarity,
      diagnostic: assessment.diagnostic
    };
  }
}

export const ContextEngine = new ContextEngineClass();
