// =============================================================================
// DiagnosticReasoningEngine.js — Hand-Authored Explainable Evidence Scoring
// =============================================================================
//
// Synthesizes inputs from:
// - Mathematical Engine (Mahalanobis distance & per-dimension z-scores)
// - Feature Extraction & Model v3 (21-class activity & confidence)
// - Environmental Engine (NOAA Heat Index & Hazard Tier)
// - Location Engine & User Feedback (Prior adjustments for known places)
//
// Evaluates 5 Target Clinical/Safety Hypotheses:
// 1. EXERTION_BENIGN         — Elevated HR explained by vigorous motion
// 2. HEAT_STRESS_DEHYDRATION — Elevated HR + low motion + high heat index
// 3. RESPIRATORY_CONCERN     — SpO2 desaturation + elevated HR + normal heat
// 4. CARDIOVASCULAR_CONCERN  — Unexplained high resting HR / bradycardia
// 5. ENVIRONMENTAL_HAZARD    — Extreme heat / environmental hazard tier breach
//
// Direct Bypass:
// - FALL_HARD_IMPACT or Hard Bounds (HR > 180, SpO2 < 85%) bypass reasoning
//   and escalate directly to emergency dispatch countdown.
//
// Emits the strict JSON Diagnostic Contract consumed by Gemma 3n.
// =============================================================================

import { ACTIVE_MOTION_CLASSES, RESTING_MOTION_CLASSES } from './FeatureExtraction.js';
import { getFeedbackForLocation } from './Database.js';

export const HYPOTHESES = {
  EXERTION_BENIGN: 'EXERTION_BENIGN',
  HEAT_STRESS_DEHYDRATION: 'HEAT_STRESS_DEHYDRATION',
  RESPIRATORY_CONCERN: 'RESPIRATORY_CONCERN',
  CARDIOVASCULAR_CONCERN: 'CARDIOVASCULAR_CONCERN',
  ENVIRONMENTAL_HAZARD: 'ENVIRONMENTAL_HAZARD',
  FALL_HARD_IMPACT: 'FALL_HARD_IMPACT',
  ANOMALY_UNCLEAR: 'ANOMALY_UNCLEAR'
};

class DiagnosticReasoningEngineClass {
  constructor() {
    this.CONFIDENCE_FLOOR = 0.55; // Below this, return ANOMALY_UNCLEAR
    this.persistenceTracker = new Map(); // hypothesis -> startTimestamp
  }

  /**
   * Evaluates comprehensive multi-sensor context and returns a Diagnostic Contract.
   *
   * @param {Object} context
   * @param {Object} context.physEval - from MathematicalEngine.evaluateDomain('physiology', [hr, spo2])
   * @param {Object} context.envEval - from MathematicalEngine.evaluateDomain('environment', [temp, rh, press])
   * @param {Object} context.heatIndex - from FeatureExtraction.computeHeatIndex(temp, rh)
   * @param {string} context.activityClass - e.g. 'walking_briskly', 'running', 'standing'
   * @param {number} context.activityConfidence - cosine similarity (0.0 - 1.0)
   * @param {number} context.peakAccelMg - peak acceleration (mg)
   * @param {number} context.eigenvalueRatio - linearity ratio (0.0 - 1.0)
   * @param {number} context.hr - current Heart Rate (BPM)
   * @param {number} context.spo2 - current SpO2 (%)
   * @param {number} [context.locationId] - current known location ID
   * @param {number} [context.persistenceMinutes] - minutes anomalous state has lasted
   * @returns {Object} Diagnostic Contract JSON
   */
  evaluate(context) {
    const {
      physEval = { zScores: { hr: 0, spo2: 0 }, distance: 0 },
      envEval = { zScores: { temperature: 0, humidity: 0, pressure: 0 }, distance: 0 },
      heatIndex = { heatIndexF: 75, tier: 'NORMAL', riskLevel: 0 },
      activityClass = 'standing',
      peakAccelMg = 1000,
      eigenvalueRatio = 0.5,
      hr = 72,
      spo2 = 98.0,
      locationId = null,
      persistenceMinutes = 0
    } = context;

    const zHr = Array.isArray(physEval.zScores) ? (physEval.zScores[0] || 0.0) : (physEval.zScores?.hr || 0.0);
    const zSpo2 = Array.isArray(physEval.zScores) ? (physEval.zScores[1] || 0.0) : (physEval.zScores?.spo2 || 0.0);
    const isActiveMotion = ACTIVE_MOTION_CLASSES.has(activityClass);
    const isRestingMotion = RESTING_MOTION_CLASSES.has(activityClass);

    // ── 1. Check Hard Limits & Direct Fall Bypass ──────────────────────────────
    // Direct Fall Bypass: impact > 3.5g (3500 mg) and linear trajectory ratio > 0.70
    if (peakAccelMg >= 3500 && eigenvalueRatio >= 0.70) {
      return {
        domain: 'motion',
        primary_hypothesis: HYPOTHESES.FALL_HARD_IMPACT,
        confidence: 0.95,
        contributing_evidence: [
          `Severe impact detected: ${(peakAccelMg / 1000).toFixed(1)}g`,
          `High directional linearity (${(eigenvalueRatio * 100).toFixed(0)}%)`,
          `Motion state: ${activityClass}`
        ],
        severity_tier: 'urgent',
        suggested_action_category: 'emergency',
        decomposed_zscores: { hr: zHr, spo2: zSpo2 },
        mahalanobis_distances: { physiology: physEval.distance, environment: envEval.distance },
        is_direct_escalation: true
      };
    }

    // Critical Clinical Hard Limits (NEWS2 red flags)
    if (spo2 <= 85.0 || hr >= 180 || (hr <= 40 && hr > 0)) {
      const reason = spo2 <= 85.0
        ? `Severe Hypoxemia (SpO2: ${spo2}%)`
        : hr >= 180
        ? `Extreme Tachycardia (HR: ${hr} bpm)`
        : `Extreme Bradycardia (HR: ${hr} bpm)`;

      return {
        domain: 'physiology',
        primary_hypothesis: spo2 <= 85.0 ? HYPOTHESES.RESPIRATORY_CONCERN : HYPOTHESES.CARDIOVASCULAR_CONCERN,
        confidence: 0.98,
        contributing_evidence: [reason, `SpO2 z-score: ${zSpo2}σ`, `HR z-score: ${zHr}σ`],
        severity_tier: 'urgent',
        suggested_action_category: 'emergency',
        decomposed_zscores: { hr: zHr, spo2: zSpo2 },
        mahalanobis_distances: { physiology: physEval.distance, environment: envEval.distance },
        is_direct_escalation: true
      };
    }

    // ── 2. Query Location Feedback Prior Adjustments ───────────────────────────
    const locationDismissals = new Set();
    if (locationId) {
      try {
        const feedbackRows = getFeedbackForLocation(locationId);
        for (const row of feedbackRows) {
          if (row.user_action.startsWith('DISMISSED')) {
            locationDismissals.add(row.primary_hypothesis);
          }
        }
      } catch (e) {
        // Fallback silently if DB offline
      }
    }

    // ── 3. Evaluate Hypotheses Evidence Scores ─────────────────────────────────
    const scores = {};
    const evidenceLists = {};

    // A. EXERTION_BENIGN
    // Elevated HR explained by high physical activity while SpO2 and environment remain normal
    let scoreExertion = 0.0;
    const evidenceExertion = [];
    if (isActiveMotion) {
      scoreExertion += 0.40;
      evidenceExertion.push(`Active motion detected: ${activityClass}`);
      if (zHr >= 1.2) {
        scoreExertion += Math.min(0.40, zHr * 0.12);
        evidenceExertion.push(`HR elevated to ${hr} bpm (+${zHr}σ)`);
      }
      if (zSpo2 >= -1.0) {
        scoreExertion += 0.15;
        evidenceExertion.push(`Oxygen saturation stable (${spo2}%)`);
      }
      if (heatIndex.riskLevel <= 1) {
        scoreExertion += 0.05;
      }
    }
    scores[HYPOTHESES.EXERTION_BENIGN] = scoreExertion;
    evidenceLists[HYPOTHESES.EXERTION_BENIGN] = evidenceExertion;

    // B. HEAT_STRESS_DEHYDRATION
    // High HR while resting or low motion in hot environment with persistence
    let scoreHeat = 0.0;
    const evidenceHeat = [];
    if (zHr >= 1.5) {
      scoreHeat += Math.min(0.35, zHr * 0.10);
      evidenceHeat.push(`HR elevated to ${hr} bpm (+${zHr}σ)`);
    }
    if (heatIndex.riskLevel >= 2) { // Extreme Caution or Danger
      scoreHeat += heatIndex.riskLevel === 2 ? 0.30 : 0.40;
      evidenceHeat.push(`Heat Index: ${heatIndex.tier} (${heatIndex.heatIndexF}°F)`);
    }
    if (isRestingMotion) {
      scoreHeat += 0.20;
      evidenceHeat.push(`Wearer is relatively stationary (${activityClass})`);
    }
    if (persistenceMinutes >= 3) {
      scoreHeat += Math.min(0.15, persistenceMinutes * 0.03);
      evidenceHeat.push(`Condition persisting for ${persistenceMinutes} mins`);
    }
    if (zSpo2 >= -1.2) {
      scoreHeat += 0.05; // Rules out primary respiratory event
    }
    scores[HYPOTHESES.HEAT_STRESS_DEHYDRATION] = scoreHeat;
    evidenceLists[HYPOTHESES.HEAT_STRESS_DEHYDRATION] = evidenceHeat;

    // C. RESPIRATORY_CONCERN
    // Depressed SpO2 with elevated HR in normal environment
    let scoreResp = 0.0;
    const evidenceResp = [];
    if (zSpo2 <= -1.8 || spo2 <= 92.0) {
      scoreResp += Math.min(0.55, Math.abs(zSpo2) * 0.25);
      evidenceResp.push(`Oxygen desaturation to ${spo2}% (${zSpo2}σ)`);
    }
    if (zHr >= 1.2 || zHr <= -1.5) {
      scoreResp += 0.25;
      evidenceResp.push(`Compensatory/irregular HR: ${hr} bpm`);
    }
    if (heatIndex.riskLevel <= 1) {
      scoreResp += 0.15;
      evidenceResp.push('Normal ambient environmental conditions');
    }
    if (persistenceMinutes >= 2) {
      scoreResp += 0.10;
    }
    scores[HYPOTHESES.RESPIRATORY_CONCERN] = scoreResp;
    evidenceLists[HYPOTHESES.RESPIRATORY_CONCERN] = evidenceResp;

    // D. CARDIOVASCULAR_CONCERN
    // Persistent elevated HR while completely resting in mild environment
    let scoreCardio = 0.0;
    const evidenceCardio = [];
    if (zHr >= 2.2 && isRestingMotion) {
      scoreCardio += Math.min(0.50, zHr * 0.18);
      evidenceCardio.push(`Unexplained tachycardia at rest (${hr} bpm, +${zHr}σ)`);
    } else if (zHr <= -2.5 && isRestingMotion) {
      scoreCardio += 0.50;
      evidenceCardio.push(`Unexplained resting bradycardia (${hr} bpm, ${zHr}σ)`);
    }
    if (heatIndex.riskLevel === 0) {
      scoreCardio += 0.25;
      evidenceCardio.push('Ambient temperature and humidity strictly normal');
    }
    if (persistenceMinutes >= 5) {
      scoreCardio += 0.20;
      evidenceCardio.push(`Resting elevation sustained for ${persistenceMinutes} mins`);
    }
    scores[HYPOTHESES.CARDIOVASCULAR_CONCERN] = scoreCardio;
    evidenceLists[HYPOTHESES.CARDIOVASCULAR_CONCERN] = evidenceCardio;

    // E. ENVIRONMENTAL_HAZARD
    // Extreme environmental tier breach regardless of physiology
    let scoreEnv = 0.0;
    const evidenceEnv = [];
    if (heatIndex.riskLevel >= 3) { // Danger or Extreme Danger
      scoreEnv += heatIndex.riskLevel === 3 ? 0.70 : 0.90;
      evidenceEnv.push(`Extreme environmental heat hazard: ${heatIndex.tier} (${heatIndex.heatIndexF}°F)`);
    }
    if (envEval.distance >= 4.0) {
      scoreEnv += 0.20;
      evidenceEnv.push(`Atmospheric anomaly: Mahalanobis distance ${envEval.distance}`);
    }
    scores[HYPOTHESES.ENVIRONMENTAL_HAZARD] = scoreEnv;
    evidenceLists[HYPOTHESES.ENVIRONMENTAL_HAZARD] = evidenceEnv;

    // ── 4. Apply Location Feedback Penalty ────────────────────────────────────
    for (const hypo of Object.keys(scores)) {
      if (locationDismissals.has(hypo)) {
        // User has repeatedly dismissed this warning at this location: penalize prior
        scores[hypo] = Math.max(0.0, scores[hypo] - 0.20);
        evidenceLists[hypo].push('(Confidence adjusted based on past dismissals at this location)');
      }
    }

    // ── 5. Select Winning Hypothesis Above Confidence Floor ────────────────────
    let winningHypo = HYPOTHESES.ANOMALY_UNCLEAR;
    let maxScore = 0.0;

    for (const [hypo, sc] of Object.entries(scores)) {
      if (sc > maxScore) {
        maxScore = sc;
        winningHypo = hypo;
      }
    }

    // Fallback if below confidence floor
    if (maxScore < this.CONFIDENCE_FLOOR) {
      return {
        domain: 'composite',
        primary_hypothesis: HYPOTHESES.ANOMALY_UNCLEAR,
        confidence: Number(maxScore.toFixed(2)),
        contributing_evidence: ['No single hypothesis cleared the minimum confidence threshold.'],
        severity_tier: 'informational',
        suggested_action_category: 'rest',
        decomposed_zscores: { hr: zHr, spo2: zSpo2 },
        mahalanobis_distances: { physiology: physEval.distance, environment: envEval.distance },
        is_direct_escalation: false
      };
    }

    // Determine domain and severity tier
    let domain = 'physiology';
    let severityTier = 'informational';
    let actionCategory = 'rest';

    switch (winningHypo) {
      case HYPOTHESES.EXERTION_BENIGN:
        domain = 'motion';
        severityTier = 'informational';
        actionCategory = 'rest';
        break;
      case HYPOTHESES.HEAT_STRESS_DEHYDRATION:
        domain = 'composite';
        severityTier = maxScore >= 0.80 ? 'urgent' : 'advisory';
        actionCategory = maxScore >= 0.80 ? 'seek_shade' : 'hydration';
        break;
      case HYPOTHESES.RESPIRATORY_CONCERN:
        domain = 'physiology';
        severityTier = maxScore >= 0.75 ? 'urgent' : 'advisory';
        actionCategory = maxScore >= 0.75 ? 'emergency' : 'medical_consult';
        break;
      case HYPOTHESES.CARDIOVASCULAR_CONCERN:
        domain = 'physiology';
        severityTier = maxScore >= 0.75 ? 'urgent' : 'advisory';
        actionCategory = maxScore >= 0.75 ? 'medical_consult' : 'rest';
        break;
      case HYPOTHESES.ENVIRONMENTAL_HAZARD:
        domain = 'environment';
        severityTier = heatIndex.riskLevel >= 4 ? 'urgent' : 'advisory';
        actionCategory = 'seek_shade';
        break;
    }

    return {
      domain,
      primary_hypothesis: winningHypo,
      confidence: Number(Math.min(1.0, maxScore).toFixed(2)),
      contributing_evidence: evidenceLists[winningHypo] || [],
      severity_tier: severityTier,
      suggested_action_category: actionCategory,
      decomposed_zscores: { hr: zHr, spo2: zSpo2 },
      mahalanobis_distances: { physiology: physEval.distance, environment: envEval.distance },
      is_direct_escalation: severityTier === 'urgent'
    };
  }
}

export const DiagnosticReasoningEngine = new DiagnosticReasoningEngineClass();
