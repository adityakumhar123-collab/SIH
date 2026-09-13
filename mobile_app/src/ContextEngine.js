// =============================================================================
// ContextEngine.js — RakshaBand Contextual Threat Assessment Coordinator
// =============================================================================
//
// Coordinates:
// 1. MathematicalEngine (Mahalanobis distance on [HR, SpO2] and Environment)
// 2. DiagnosticReasoningEngine (Weighted evidence scoring on 5 target hypotheses + Fall)
// 3. LocationEngine (Dwell centroids, familiarity, and location prior adjustments)
// 4. GemmaService (Natural language explanation and guidance)
//
// Exposes:
// - ContextEngine singleton: coordinates real-time inference ticks
// - computeThreatScoreDetailed(): fused real-time threat score (0.0 to 1.0)
// - getThreatLevel(): 'NORMAL' | 'ADVISORY' | 'CRITICAL'
// - Distance and time utilities for backward compatibility
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
  const R = 6371000.0;
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
 * @param {Object} currentPacket - latest telemetry packet
 * @param {Object} [options] - { familiarityScore, cooldownActive }
 * @returns {Object} { threatScore, score, threatLevel, hypothesis, diagnostic, explanation, details }
 */
export function computeThreatScoreDetailed(currentPacket, options = {}) {
  const familiarity = options.familiarityScore !== undefined ? options.familiarityScore : 0.5;
  const isCooldown = !!options.cooldownActive;

  // Direct escalation check (Falls or Critical vitals)
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

  // If wear confidence is low (<40%), suppress threat score to prevent false alarm on nightstand
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

  // If Diagnostic Contract is already attached from EpisodeEngine
  if (currentPacket.diagnostic) {
    const diag = currentPacket.diagnostic;
    let baseScore = diag.confidence;

    // Dampen benign physical exertion
    if (diag.primary_hypothesis === HYPOTHESES.EXERTION_BENIGN) {
      baseScore *= 0.25; // Suppress threat score for healthy workout
    } else if (diag.primary_hypothesis === HYPOTHESES.ANOMALY_UNCLEAR) {
      baseScore *= 0.40;
    }

    // Familiarity scaling: higher familiarity at known safe locations dampens false alarms
    const familiarityDampener = 1.2 - 0.4 * familiarity;
    let fusedScore = Math.min(1.0, Math.max(0.0, baseScore * familiarityDampener));

    if (isCooldown) {
      fusedScore *= 0.60;
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

  // Fallback heuristic scoring from raw anomaly/vitals if diagnostic is not yet available
  const rawScore = currentPacket.anomalyScore || 0.05;
  const familiarityDampener = 1.3 - 0.6 * familiarity;
  let fusedScore = Math.min(1.0, Math.max(0.0, rawScore * familiarityDampener));
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

class ContextEngineClass {
  constructor() {
    this.cachedThreatScore = 0.05;
    this.cachedHypothesis = 'NORMAL';
    this.cachedDiagnostic = null;
    this.logs = [];
  }

  initialize() {
    MathematicalEngine.initialize();
    LocationEngine.initialize();
    EpisodeEngine.initialize();
    this.logs = [];
  }

  /**
   * Periodic context evaluation (runs every 3-5 seconds or per BLE window).
   *
   * @param {Object} currentPacket
   * @returns {Object} Assessment result
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
