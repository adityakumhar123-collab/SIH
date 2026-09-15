// =============================================================================
// test_engines.mjs — RakshaBand Offline Multi-Engine Integrity Test Suite
// =============================================================================
//
// Validates:
// 1. Database Schema & Tables in rakshaband.db (:memory: for testing)
// 2. FeatureExtraction (Tier 1 stats, Tier 2 DFT, Tier 3 Jacobi, PPG, NOAA Heat Index)
// 3. MathematicalEngine (NEWS2 cold-start, Mahalanobis distance, EWMA adaptation)
// 4. DiagnosticReasoningEngine (5 Hypotheses + Fall bypass + Feedback prior penalty)
// 5. LocationEngine (Dwell centroid, accuracy gating, familiarity)
// 6. ContextEngine (Threat scoring, off-wrist suppression, emergency threshold)
// 7. BackgroundServices (Retention policy & baseline recalibration)
// =============================================================================

import { createRequire } from 'module';
globalThis.require = createRequire(import.meta.url);

// Isolate test database to in-memory SQLite
process.env.SAFEBAND_TEST_DB = ':memory:';

import {
  initDatabase,
  saveEpisode,
  getActiveEpisode,
  closeActiveEpisode,
  saveKnownLocation,
  getKnownLocations,
  saveLocationVisit,
  saveBaselineState,
  getBaselineState,
  storeDiagnosticEvent,
  saveUserFeedback,
  logEscalation,
  enforceRetentionPolicy,
  executeSql,
  updateLocationName,
  getCleanLocationName,
  getLocationHistoricalData
} from './src/Database.js';

import {
  extractWindowFeatures,
  standardizeFeatures,
  classifyEmbedding,
  generateFallbackEmbedding,
  processPpgWaveform,
  computeHeatIndex
} from './src/FeatureExtraction.js';

import { MathematicalEngine } from './src/MathematicalEngine.js';
import { DiagnosticReasoningEngine, HYPOTHESES } from './src/DiagnosticReasoningEngine.js';
import { LocationEngine } from './src/LocationEngine.js';
import { ContextEngine, computeThreatScoreDetailed, getThreatLevel } from './src/ContextEngine.js';
import { GemmaService } from './src/GemmaService.js';
import { GemmaAgent } from './src/GemmaAgent.js';
import { BackgroundServices } from './src/BackgroundServices.js';
import { verifyDiagnosticEvent, getDiagnosticEvent } from './src/Database.js';

function logResult(name, passed, detail = '') {
  if (passed) {
    console.log(`\x1b[32m[PASS]\x1b[0m ${name} — ${detail}`);
  } else {
    console.log(`\x1b[31m[FAIL]\x1b[0m ${name} — ${detail}`);
    process.exitCode = 1;
  }
}

async function runAllTests() {
  console.log("================================================================");
  console.log("       RakshaBand Modernization Test & Verification Suite       ");
  console.log("================================================================\n");

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 1: Database Initialization & Tables Validation
  // ───────────────────────────────────────────────────────────────────────────
  console.log("--- 1. Database Schema & Tables Verification ---");
  const db = initDatabase();
  logResult("Database Initialization", db !== null, "In-memory SQLite created successfully.");

  const tables = executeSql("SELECT name FROM sqlite_master WHERE type='table';").map(t => t.name);
  const expectedTables = [
    'settings', 'emergency_contacts', 'templates', 'known_locations',
    'location_visits', 'episodes', 'baseline_states', 'diagnostic_events',
    'user_feedback', 'emergency_escalations'
  ];
  const missingTables = expectedTables.filter(t => !tables.includes(t));
  logResult("Table Schema Integrity", missingTables.length === 0, `Found all 10 tables: ${expectedTables.join(', ')}`);

  // Verify default settings seed
  const settingsRows = executeSql("SELECT key, value FROM settings;");
  logResult("Settings Seed", settingsRows.length >= 10, `Loaded ${settingsRows.length} default settings.`);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 2: Feature Extraction Pipeline & Mathematical Tiers
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n--- 2. Feature Extraction & Model v3 Pipeline ---");
  
  // Synthesize 200 IMU samples (2 seconds @ 100 Hz): simulated periodic walking
  const syntheticImuWindow = Array.from({ length: 200 }, (_, i) => {
    const t = i / 100.0;
    const ax = 9.80665 * 0.1 * Math.sin(2 * Math.PI * 1.8 * t);
    const ay = 9.80665 * 0.8; // Gravity on Y
    const az = 9.80665 * 0.2 * Math.cos(2 * Math.PI * 1.8 * t);
    const gx = 15.0 * Math.sin(2 * Math.PI * 1.8 * t);
    const gy = 5.0;
    const gz = 20.0 * Math.cos(2 * Math.PI * 1.8 * t);
    return [ax, ay, az, gx, gy, gz];
  });

  const { seqRaw, globRaw } = extractWindowFeatures(syntheticImuWindow);
  logResult(
    "Tier 1 & Tier 2 Sequential Features",
    seqRaw && seqRaw.length === 1320,
    `Extracted 1320 features across 10 subwindows x (90 statistical + 42 spectral).`
  );
  logResult(
    "Tier 3 Structural Covariance Features",
    globRaw && globRaw.length === 12,
    `Extracted 12 structural covariance and Jacobi eigenvalue features.`
  );

  const { seqNorm, globNorm } = standardizeFeatures(seqRaw, globRaw);
  logResult(
    "Feature Standardization",
    seqNorm.length === 1320 && globNorm.length === 12 && !seqNorm.some(isNaN),
    "Normalized 1332 features against Model v3 scaling parameters."
  );

  const embedding32D = generateFallbackEmbedding(seqNorm, globNorm);
  let mag = Math.sqrt(embedding32D.reduce((s, v) => s + v * v, 0));
  logResult(
    "32D Unit-Norm Embedding Generation",
    embedding32D.length === 32 && Math.abs(mag - 1.0) < 1e-4,
    `Generated unit-norm 32D embedding (Magnitude: ${mag.toFixed(4)}).`
  );

  const { activityClass, confidence } = classifyEmbedding(embedding32D);
  logResult(
    "21-Class Cosine Classification",
    typeof activityClass === 'string' && confidence > 0,
    `Classified activity as: '${activityClass}' (Confidence: ${(confidence * 100).toFixed(1)}%).`
  );

  // MAX30102 PPG waveform pulse test
  const syntheticRed = Array.from({ length: 200 }, (_, i) => 25000 + 500 * Math.sin(2 * Math.PI * 1.2 * (i / 100)));
  const syntheticIr = Array.from({ length: 200 }, (_, i) => 28000 + 1200 * Math.sin(2 * Math.PI * 1.2 * (i / 100)));
  const ppgResult = processPpgWaveform(syntheticRed, syntheticIr);
  logResult(
    "MAX30102 PPG Pulse Extraction",
    ppgResult.hr > 50 && ppgResult.hr < 120 && ppgResult.spo2 >= 90,
    `Computed HR: ${ppgResult.hr} BPM, SpO2: ${ppgResult.spo2.toFixed(1)}%, HRV: ${ppgResult.hrv.toFixed(1)} ms.`
  );

  // NOAA Heat Index Rothfusz test
  const heatNormal = computeHeatIndex(24.0, 50.0); // 75.2°F, 50% RH -> Normal
  const heatDanger = computeHeatIndex(35.0, 70.0); // 95°F, 70% RH -> ~123°F (Danger)
  logResult(
    "NOAA Heat Index Normal Tier",
    heatNormal.tier === 'NORMAL' && heatNormal.riskLevel === 0,
    `24°C / 50% RH -> ${heatNormal.heatIndexF.toFixed(1)}°F (${heatNormal.tier})`
  );
  logResult(
    "NOAA Heat Index Danger Tier",
    heatDanger.tier === 'DANGER' && heatDanger.riskLevel === 3,
    `35°C / 70% RH -> ${heatDanger.heatIndexF.toFixed(1)}°F (${heatDanger.tier})`
  );

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 3: Mathematical Engine (Mahalanobis Distance & NEWS2 Baseline)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n--- 3. Mathematical Engine (Mahalanobis & NEWS2 Baselines) ---");
  MathematicalEngine.initialize();

  // Test normal resting vitals
  const evalNormalVitals = MathematicalEngine.evaluateDomain('physiology', [72, 98]);
  logResult(
    "Normal Vitals Inlier Check",
    !evalNormalVitals.isOutlier && evalNormalVitals.distance < 2.5,
    `HR=72, SpO2=98 -> DM=${evalNormalVitals.distance.toFixed(3)} (Inlier)`
  );

  // Test severe deviation (HR=130, SpO2=88)
  const evalHypoxiaVitals = MathematicalEngine.evaluateDomain('physiology', [130, 88]);
  const zScoreStr = Object.entries(evalHypoxiaVitals.zScores).map(([k, v]) => `${k}:${v}`).join(', ');
  logResult(
    "Hypoxia & Tachycardia Outlier Check",
    evalHypoxiaVitals.isOutlier && evalHypoxiaVitals.distance > 3.0,
    `HR=130, SpO2=88 -> DM=${evalHypoxiaVitals.distance.toFixed(3)}, Z-scores=[${zScoreStr}] (Outlier)`
  );

  // Progressive EWMA update test
  const baseBefore = MathematicalEngine.getBaseline('physiology', 'global');
  const initialMeanHR = baseBefore.mean_vector[0];
  MathematicalEngine.updateBaselineEWMA('physiology', [75, 98], 'global', false);
  const baseAfter = MathematicalEngine.getBaseline('physiology', 'global');
  const updatedMeanHR = baseAfter.mean_vector[0];
  logResult(
    "Progressive EWMA Update",
    updatedMeanHR !== initialMeanHR && Math.abs(updatedMeanHR - initialMeanHR) < 1.0,
    `Initial mean HR: ${initialMeanHR.toFixed(2)} -> Updated mean HR: ${updatedMeanHR.toFixed(2)} (Smooth adaptation)`
  );

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 4: Diagnostic Reasoning Engine (5 Target Hypotheses & Fall Bypass)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n--- 4. Diagnostic Reasoning Engine Hypotheses ---");

  // Scenario A: Exertion Benign (High HR, running, normal SpO2, mild environment)
  const diagExertion = DiagnosticReasoningEngine.evaluate({
    physEval: { isOutlier: true, distance: 3.2, zScores: [2.8, -0.2] },
    envEval: { isOutlier: false, distance: 0.5, zScores: [0.1, 0.2, 0.0] },
    heatIndex: { tier: 'NORMAL', riskLevel: 0 },
    activityClass: 'running',
    activityConfidence: 0.95,
    hr: 145,
    spo2: 97,
    persistenceMinutes: 2
  });
  logResult(
    "Hypothesis: EXERTION_BENIGN",
    diagExertion.primary_hypothesis === HYPOTHESES.EXERTION_BENIGN && diagExertion.severity_tier === 'informational',
    `Classified as '${diagExertion.primary_hypothesis}' (Confidence: ${(diagExertion.confidence * 100).toFixed(0)}%). Suggested action: ${diagExertion.suggested_action_category}`
  );

  // Scenario B: Heat Stress / Dehydration (High heat index, elevated temp, resting)
  const diagHeatStress = DiagnosticReasoningEngine.evaluate({
    physEval: { isOutlier: true, distance: 2.9, zScores: [2.1, -0.5] },
    envEval: { isOutlier: true, distance: 3.5, zScores: [3.2, 2.8, -0.1] },
    heatIndex: { tier: 'DANGER', riskLevel: 3 },
    activityClass: 'standing',
    activityConfidence: 0.90,
    hr: 110,
    spo2: 96,
    persistenceMinutes: 10
  });
  logResult(
    "Hypothesis: HEAT_STRESS_DEHYDRATION",
    diagHeatStress.primary_hypothesis === HYPOTHESES.HEAT_STRESS_DEHYDRATION && (diagHeatStress.severity_tier === 'urgent' || diagHeatStress.severity_tier === 'advisory'),
    `Classified as '${diagHeatStress.primary_hypothesis}' (Confidence: ${(diagHeatStress.confidence * 100).toFixed(0)}%). Suggested action: ${diagHeatStress.suggested_action_category}`
  );

  // Scenario C: Respiratory Concern (Hypoxemia SpO2 <= 90%, sitting)
  const diagRespiratory = DiagnosticReasoningEngine.evaluate({
    physEval: { isOutlier: true, distance: 4.1, zScores: [1.8, -3.8] },
    envEval: { isOutlier: false, distance: 0.8, zScores: [0.2, 0.1, 0.0] },
    heatIndex: { tier: 'NORMAL', riskLevel: 0 },
    activityClass: 'sitting',
    activityConfidence: 0.92,
    hr: 95,
    spo2: 88,
    persistenceMinutes: 3
  });
  logResult(
    "Hypothesis: RESPIRATORY_CONCERN",
    diagRespiratory.primary_hypothesis === HYPOTHESES.RESPIRATORY_CONCERN && (diagRespiratory.severity_tier === 'urgent' || diagRespiratory.severity_tier === 'advisory'),
    `Classified as '${diagRespiratory.primary_hypothesis}' (Severity: ${diagRespiratory.severity_tier}). Suggested action: ${diagRespiratory.suggested_action_category}`
  );

  // Scenario D: Cardiovascular Concern (Tachycardia HR=135 resting, SpO2=96)
  const diagCardio = DiagnosticReasoningEngine.evaluate({
    physEval: { isOutlier: true, distance: 3.8, zScores: [3.4, -0.2] },
    envEval: { isOutlier: false, distance: 0.5, zScores: [0.1, 0.1, 0.0] },
    heatIndex: { tier: 'NORMAL', riskLevel: 0 },
    activityClass: 'sitting',
    activityConfidence: 0.88,
    hr: 135,
    spo2: 96,
    persistenceMinutes: 5
  });
  logResult(
    "Hypothesis: CARDIOVASCULAR_CONCERN",
    diagCardio.primary_hypothesis === HYPOTHESES.CARDIOVASCULAR_CONCERN,
    `Classified as '${diagCardio.primary_hypothesis}' (Confidence: ${(diagCardio.confidence * 100).toFixed(0)}%).`
  );

  // Scenario E: Direct Fall / Hard Impact Bypass (>3.5g peak + linear eigenvalue ratio >= 0.70)
  const diagFall = DiagnosticReasoningEngine.evaluate({
    physEval: { isOutlier: false, distance: 1.0, zScores: [0.2, 0.1] },
    envEval: { isOutlier: false, distance: 0.5, zScores: [0.0, 0.0, 0.0] },
    heatIndex: { tier: 'NORMAL', riskLevel: 0 },
    activityClass: 'fall',
    activityConfidence: 0.98,
    peakAccelMg: 4200, // 4.2g
    eigenvalueRatio: 0.78, // High directional impact
    hr: 85,
    spo2: 98,
    persistenceMinutes: 0
  });
  logResult(
    "Fall / Impact Direct Escalation Bypass",
    diagFall.primary_hypothesis === HYPOTHESES.FALL_HARD_IMPACT && diagFall.is_direct_escalation === true,
    `Triggered direct emergency escalation: '${diagFall.primary_hypothesis}' (Peak Accel: 4200 mg, Severity: ${diagFall.severity_tier})`
  );

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 5: Location Engine Dwell & Familiarity
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n--- 5. Location Engine (Centroid Dwell & Accuracy Gating) ---");
  LocationEngine.initialize();

  // Test accuracy gating (> 30m rejected)
  LocationEngine.onLocationUpdate({ latitude: 12.9716, longitude: 77.5946, accuracy: 45 });
  logResult("GPS Accuracy Gating", LocationEngine.currentGps === null, "Ignored inaccurate GPS sample (accuracy: 45m > 30m).");

  // Feed high-accuracy GPS samples
  LocationEngine.onLocationUpdate({ latitude: 12.9716, longitude: 77.5946, accuracy: 12 });
  logResult("Valid GPS Ingestion", LocationEngine.currentGps !== null, "Accepted GPS fix (lat: 12.9716, lon: 77.5946, acc: 12m).");

  // Familiarity estimation
  const familiarity = LocationEngine.estimateFamiliarity(12.9716, 77.5946);
  logResult("Location Familiarity Score", familiarity >= 0.0 && familiarity <= 1.0, `Computed familiarity score: ${(familiarity * 100).toFixed(1)}%.`);

  // Watchdog test
  LocationEngine.checkWatchdog();
  const watchdogOk = LocationEngine.locationStatus === 'OK';
  LocationEngine.lastUpdateTimestamp = Date.now() - 35000; // simulate 35s stale
  LocationEngine.checkWatchdog();
  const watchdogStale = LocationEngine.locationStatus === 'STALE';
  logResult("Location Watchdog", watchdogOk && watchdogStale, "Transitions from OK to STALE after 30s elapsed.");

  // Manual / Immediate Location Registration test
  const registeredNodeId = await LocationEngine.registerCurrentLocation("Home Test", 12.9716, 77.5946);
  logResult("Immediate Location Registration", registeredNodeId > 0 && LocationEngine.knownNodes.length === 1, `Created Known Location ID ${registeredNodeId} (Total nodes: ${LocationEngine.knownNodes.length}).`);

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 6: Context Engine Threat Scoring & Off-Wrist Safety
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n--- 6. Context Engine Threat Scoring & Emergency Thresholds ---");
  ContextEngine.initialize();

  // Off-wrist suppression test
  const offWristAssessment = computeThreatScoreDetailed({
    anomalyScore: 0.95,
    wearConfidence: 20
  });
  logResult(
    "Off-Wrist Alert Suppression",
    offWristAssessment.threatScore === 0.0 && offWristAssessment.threatLevel.name === 'NORMAL',
    "Suppressed threat score to 0.0 because watch is off-wrist (wear confidence: 20% < 40%)."
  );

  // Fall threat test
  const fallAssessment = computeThreatScoreDetailed({
    diagnostic: diagFall,
    wearConfidence: 100
  });
  logResult(
    "Fall Emergency Escalation Scoring",
    fallAssessment.threatScore >= 0.72 && fallAssessment.threatLevel.name === 'CRITICAL',
    `Fall threat score: ${fallAssessment.threatScore} -> Level: ${fallAssessment.threatLevel.name} (Threshold: >=0.72)`
  );

  // Exertion dampening test
  const exertionAssessment = computeThreatScoreDetailed({
    diagnostic: diagExertion,
    wearConfidence: 100
  }, { familiarityScore: 0.9 });
  logResult(
    "Benign Workout Threat Dampening",
    exertionAssessment.threatScore < 0.35 && exertionAssessment.threatLevel.name === 'NORMAL',
    `Healthy workout dampened threat score: ${exertionAssessment.threatScore} (Dampened from high HR during run).`
  );

  // Healthy daily vitals (HR=85, SpO2=96) non-outlier test
  const healthyVitalsEval = MathematicalEngine.evaluateDomain('physiology', [85, 96]);
  logResult(
    "Healthy Normal Vitals Tolerance (HR=85, SpO2=96%)",
    healthyVitalsEval.isOutlier === false && healthyVitalsEval.distance < 3.0,
    `Healthy vitals within tolerance: DM=${healthyVitalsEval.distance.toFixed(3)} < 3.0 (isOutlier: ${healthyVitalsEval.isOutlier})`
  );

  // Cooldown dampening test (post-dismissal suppression)
  const cooldownAssessment = computeThreatScoreDetailed({
    anomalyScore: 0.95,
    isDirectEscalation: true,
    wearConfidence: 100
  }, { cooldownActive: true });
  logResult(
    "Post-Dismissal Cooldown Suppression",
    cooldownAssessment.threatScore === 0.25 && cooldownAssessment.threatLevel.name === 'NORMAL',
    `Threat suppressed during cooldown: score=${cooldownAssessment.threatScore} (Level: ${cooldownAssessment.threatLevel.name})`
  );

  // Catastrophic hypoxemia hard boundary test
  const diagHypoxemia = DiagnosticReasoningEngine.evaluate({
    hr: 75,
    spo2: 83.0,
    activityClass: 'sitting'
  });
  const hypoxemiaAssessment = computeThreatScoreDetailed({
    diagnostic: diagHypoxemia,
    wearConfidence: 100
  });
  logResult(
    "Catastrophic Hypoxemia Direct Escalation (SpO2 <= 85%)",
    diagHypoxemia.is_direct_escalation === true && hypoxemiaAssessment.threatScore >= 0.72,
    `Severe hypoxemia escalated directly: SpO2=83% -> threatScore=${hypoxemiaAssessment.threatScore} (CRITICAL)`
  );

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 7: Local On-Device Gemma 3n AI Guidance (Privacy-First)
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n--- 7. Local Gemma 3n On-Device AI Guidance (Privacy-First) ---");

  const gemmaResHeat = await GemmaService.generateGuidance(diagHeatStress, 'Priya');
  logResult(
    "Local On-Device Generation (Heat Stress)",
    gemmaResHeat.isLocal === true && gemmaResHeat.userMessage.includes('Priya'),
    `Generated: "${gemmaResHeat.userMessage}" [Action: ${gemmaResHeat.recommendedAction}]`
  );

  const gemmaResFall = await GemmaService.generateGuidance(diagFall, 'Priya');
  logResult(
    "Local On-Device Generation (Fall Impact)",
    gemmaResFall.isLocal === true && gemmaResFall.tone === 'emergency',
    `Generated: "${gemmaResFall.userMessage}" [Tone: ${gemmaResFall.tone}]`
  );

  const gemmaPrompt = GemmaService.buildGemmaPrompt(diagHeatStress, 'Priya');
  logResult(
    "Gemma 3 Instruction Chat Template Formatting",
    gemmaPrompt.includes('<start_of_turn>user') && gemmaPrompt.includes('<end_of_turn>') && gemmaPrompt.includes('<start_of_turn>model'),
    "Adheres to official Gemma 3 conversational turn tokenization."
  );

  // GemmaAgent Tool Calling Tests
  const agentVitalsRes = await GemmaAgent.processMessage("What are my vitals today and how do they look?", { hr: 75, spo2: 98 });
  logResult(
    "GemmaAgent Tool Calling: query_vitals_summary",
    agentVitalsRes.toolUsed && agentVitalsRes.toolUsed.name === 'get_vitals_summary' && agentVitalsRes.text.length > 20,
    `Tool: ${agentVitalsRes.toolUsed?.name} -> "${agentVitalsRes.text.substring(0, 70)}..."`
  );

  const agentProfileRes = await GemmaAgent.processMessage("What is my registered blood group and allergies?");
  logResult(
    "GemmaAgent Tool Calling: query_user_profile",
    agentProfileRes.toolUsed && agentProfileRes.toolUsed.name === 'get_user_profile' && agentProfileRes.text.includes('Blood group'),
    `Tool: ${agentProfileRes.toolUsed?.name} -> "${agentProfileRes.text.substring(0, 70)}..."`
  );

  const agentAlertsRes = await GemmaAgent.processMessage("Show me my recent alerts and warnings");
  logResult(
    "GemmaAgent Tool Calling: query_diagnostic_alerts",
    agentAlertsRes.toolUsed && agentAlertsRes.toolUsed.name === 'get_diagnostic_alerts',
    `Tool: ${agentAlertsRes.toolUsed?.name} -> "${agentAlertsRes.text.substring(0, 70)}..."`
  );

  // Diagnostic Event Verification Test
  const testEventId = storeDiagnosticEvent({
    primary_hypothesis: 'HEAT_STRESS_DEHYDRATION',
    confidence: 0.95,
    severity_tier: 'advisory',
    suggested_action_category: 'seek_shade',
    contributing_evidence: ['Ambient Heat Index 102F', 'Resting Tachycardia'],
    timestamp: Date.now()
  });
  verifyDiagnosticEvent(testEventId, 'Verified safe by Priya in test suite');
  const verifiedEvent = getDiagnosticEvent(testEventId);
  logResult(
    "Diagnostic Event User Verification & Latching",
    verifiedEvent && verifiedEvent.user_status === 'VERIFIED',
    `Event #${testEventId} user_status updated to '${verifiedEvent?.user_status}'`
  );

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 8: Background Maintenance Services & Retention Policy
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n--- 8. Background Services & Retention Policy ---");

  // Save an old episode (35 days ago)
  const oldTimestamp = Date.now() - 35 * 24 * 60 * 60 * 1000;
  saveEpisode({
    start_timestamp: oldTimestamp,
    duration_seconds: 60,
    activity_class: 'sitting',
    activity_confidence: 1.0,
    hr_mean: 70
  });

  // Save a recent episode (1 hour ago)
  const recentTimestamp = Date.now() - 3600 * 1000;
  saveEpisode({
    start_timestamp: recentTimestamp,
    duration_seconds: 120,
    activity_class: 'walking',
    activity_confidence: 0.95,
    hr_mean: 85
  });

  const cleanupStats = BackgroundServices.runDatabaseCleanup(30);
  logResult(
    "Database 30-Day Retention Policy",
    cleanupStats !== null && cleanupStats.deletedEpisodes >= 1,
    `Purged ${cleanupStats.deletedEpisodes} expired episodes older than 30 days.`
  );

  // Recalibrate baselines across locations
  saveKnownLocation({
    latitude: 12.9716,
    longitude: 77.5946,
    label: 'Home',
    radius_meters: 50
  });
  const recalibReport = BackgroundServices.recalibrateBaselines();
  logResult(
    "Baseline Recalibration Service",
    recalibReport.success === true && recalibReport.locationsChecked >= 1,
    `Recalibrated baselines across ${recalibReport.locationsChecked} registered location nodes.`
  );

  // ───────────────────────────────────────────────────────────────────────────
  // TEST 9: Spatial Vector Radar, Safe Naming & Historical Telemetry
  // ───────────────────────────────────────────────────────────────────────────
  console.log("\n--- 9. Spatial Vector Radar & Location Naming Verification ---");

  // 1. getCleanLocationName sanitization
  const testNodeNull = { name: null, location_id: 4 };
  const testNodeStrNull = { name: 'null', location_id: 5 };
  const testNodeEmpty = { name: '   ', location_id: 6 };
  const testNodeCustom = { name: 'Home Office', location_id: 7 };

  const cleanNull = getCleanLocationName(testNodeNull);
  const cleanStrNull = getCleanLocationName(testNodeStrNull);
  const cleanEmpty = getCleanLocationName(testNodeEmpty);
  const cleanCustom = getCleanLocationName(testNodeCustom);

  const cleanPassed =
    cleanNull === 'Zone #4' &&
    cleanStrNull === 'Zone #5' &&
    cleanEmpty === 'Zone #6' &&
    cleanCustom === 'Home Office';

  logResult(
    "Location Name Sanitization",
    cleanPassed,
    `Cleanly transformed: null -> "${cleanNull}", 'null' -> "${cleanStrNull}", '' -> "${cleanEmpty}", custom -> "${cleanCustom}"`
  );

  // 2. updateLocationName
  const rawNodeId = saveKnownLocation({
    name: null,
    center_latitude: 12.9750,
    center_longitude: 77.5990,
    entry_radius: 25.0
  });
  updateLocationName(rawNodeId, 'Fitness Gym');
  const updatedNodes = getKnownLocations();
  const foundNode = updatedNodes.find(n => n.location_id === rawNodeId);
  logResult(
    "Location Name Mutation & SQLite Persistence",
    foundNode && foundNode.name === 'Fitness Gym',
    `Updated node #${rawNodeId} name to "${foundNode?.name}" successfully.`
  );

  // 3. getLocationHistoricalData
  saveEpisode({
    location_id: rawNodeId,
    activity_class: 'running',
    activity_confidence: 0.96,
    hr_mean: 135,
    spo2_mean: 97,
    temperature_mean: 28.5,
    humidity_mean: 62.0,
    pressure_mean: 1010.5,
    heat_index_mean: 82.0
  });

  const history = getLocationHistoricalData(rawNodeId);
  const historyPassed =
    history !== null &&
    history.node !== null &&
    history.lastEpisode !== null &&
    history.lastEpisode.activity_class === 'running' &&
    history.lastEpisode.temperature_mean === 28.5 &&
    history.lastEpisode.pressure_mean === 1010.5;

  logResult(
    "Node Historical Telemetry Retrieval",
    historyPassed,
    `Retrieved last environment (Temp: ${history?.lastEpisode?.temperature_mean}°C, Press: ${history?.lastEpisode?.pressure_mean} hPa) & motion (${history?.lastEpisode?.activity_class}).`
  );

  // 4. LocationEngine.getNearestNodes (5 Nearest Nodes Algorithm)
  LocationEngine.knownNodes = [];
  // Seed 8 nodes at various distances
  const baseLat = 12.9716;
  const baseLon = 77.5946;
  for (let i = 1; i <= 8; i++) {
    LocationEngine.knownNodes.push({
      location_id: i,
      name: i === 1 ? 'Office' : null,
      center_latitude: baseLat + i * 0.001, // ~110m per 0.001 deg
      center_longitude: baseLon + i * 0.001,
      entry_radius: 25.0,
      dwell_count: i
    });
  }

  const nearest5 = LocationEngine.getNearestNodes(5, baseLat, baseLon);
  const nearestPassed =
    nearest5.length === 5 &&
    nearest5[0].location_id === 1 &&
    nearest5[4].location_id === 5 &&
    nearest5[0].distMeters < nearest5[4].distMeters &&
    typeof nearest5[0].dx === 'number' &&
    typeof nearest5[0].dy === 'number';

  logResult(
    "5 Nearest Nodes Proximity & Projection",
    nearestPassed,
    `Filtered 8 nodes down to top 5 (Nearest: ${nearest5[0]?.distMeters}m, 5th: ${nearest5[4]?.distMeters}m).`
  );

  // 5. LocationEngine Node Event Dispatch
  let receivedEvent = null;
  LocationEngine.setNodeEventListener((evt) => {
    receivedEvent = evt;
  });

  const registeredId = await LocationEngine.registerCurrentLocation(null, baseLat, baseLon);
  const eventPassed =
    receivedEvent !== null &&
    receivedEvent.type === 'NEW_NODE_CREATED' &&
    receivedEvent.node.location_id === registeredId;

  logResult(
    "Node Registration Event Listener Dispatch",
    eventPassed,
    `Dispatched event: ${receivedEvent?.type} for Node #${receivedEvent?.node?.location_id}.`
  );

  console.log("\n================================================================");
  if (process.exitCode === 1) {
    console.log("❌ Some tests failed. Please inspect logs above.");
  } else {
    console.log("✅ ALL RAKSHABAND INTEGRITY TESTS PASSED SUCCESSFULLY!");
  }
  console.log("================================================================\n");
}

runAllTests().catch(err => {
  console.error("Test Suite Execution Failed:", err);
  process.exit(1);
});
