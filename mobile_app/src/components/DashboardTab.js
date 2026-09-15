// =============================================================================
// DashboardTab.js — RakshaBand Live Telemetry, Activity & Diagnostic Reasoning UI
// =============================================================================
//
// DATA FLOW & ARCHITECTURE TRACE:
// --------------------------------
// This component is the primary visual interface of RakshaBand. It renders
// real-time telemetry, machine learning classifications, and clinical AI outputs.
//
// HOW DATA REACHES THIS COMPONENT:
// 1. ESP32 Firmware (esp firmware/src/main.cpp)
//    - Reads MPU-6050 (100 Hz Motion), MAX30102 (100 Hz Vitals), BMP280 (1 Hz Env)
//    - Sends BLE Packets: 0x01 (Motion), 0x02 (Status), 0x03 (Env), 0x04 (Vitals)
// 2. BLE Service & Hook (src/BleService.js & src/hooks/useBle.js)
//    - Subscribes to GATT characteristics, decodes byte payloads, verifies XOR checksums
//    - Pushes samples into EpisodeEngine's rolling buffers
// 3. Episode Engine (src/EpisodeEngine.js)
//    - Evaluates 200-sample windows (2.0 seconds at 100 Hz, sliding by 50 samples)
//    - Runs Tier 1/2/3 Feature Extraction & Model v3 21-class cosine classifier
//    - Computes PPG pulse parameters (Heart Rate, SpO2, HRV) and NOAA Heat Index
//    - Evaluates MathematicalEngine (Mahalanobis D_M) & DiagnosticReasoningEngine
// 4. Context Engine (src/ContextEngine.js) & App.js
//    - Fuses diagnostic hypothesis confidence with Location Familiarity (GPS)
//    - Produces threatScore (0.00 to 1.00) and threatLevel ('NORMAL'|'ADVISORY'|'CRITICAL')
//    - App.js passes these as props into DashboardTab.js
//
// WHAT EACH UI CARD DISPLAYS & HOW IT IS COMPUTED:
// - Card 1 (Header): connectionState ('CONNECTED' | 'SCANNING' | 'DISCONNECTED') + batteryPct
// - Card 2 (Scanner): Discovered peripherals matching "RakshaBand" or SERVICE_UUID
// - Card 3 (Mini Stats): Uptime (minutes), Location Node ID (GPS cluster), Wear Confidence %
// - Card 4 (Vitals): Live HR (BPM), SpO2 (%), HRV (RMSSD ms), NOAA Heat Index (°F/°C)
// - Card 5 (Activity): Model v3 21-class classifier result, confidence bar, peak acceleration
// - Card 6 (Diagnostic): Fused Threat circular gauge, active primary hypothesis, Gemma 3n guidance,
//                        expandable clinical evidence drawer with Mahalanobis D_M distance
// - Card 7 (Waveform): Live IMU resultant acceleration graph (sampled at 25 Hz, throttled to 5 Hz)
// - Card 8 (Terminal): Real-time event log viewer with category filters (ALL, CONTEXT, SYSTEM)
// =============================================================================

import React, { useState, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Platform,
  Alert,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import styles from './styles';
import { LocationEngine } from '../LocationEngine.js';
import SignalsCard from './SignalsCard';
import LocalSpatialMap from './LocalSpatialMap';

// 21-Class Model v3 Human Activity Metadata
// Mapped from cosine similarity against class_centroids_v3.json
const ACTIVITY_META = {
  walking: { label: '🚶 Walking', color: '#3B82F6' },
  walking_slow: { label: '🚶 Slow Walk', color: '#60A5FA' },
  walking_fast: { label: '🚶 Brisk Walk', color: '#2563EB' },
  running: { label: '🏃 Running', color: '#F59E0B' },
  running_slow: { label: '🏃 Slow Jog', color: '#FBBF24' },
  running_fast: { label: '🏃 Sprinting', color: '#D97706' },
  standing: { label: '🧍 Standing', color: '#10B981' },
  sitting: { label: '🪑 Sitting', color: '#64748B' },
  lying: { label: '🛏️ Lying Down', color: '#64748B' },
  fall: { label: '🚨 FALL / IMPACT', color: '#EF4444' },
  upstairs: { label: '🪜 Stairs (Up)', color: '#8B5CF6' },
  downstairs: { label: '🪜 Stairs (Down)', color: '#8B5CF6' },
  jumping_jacks: { label: '🤸 Jumping Jacks', color: '#EC4899' },
  squats: { label: '🏋️ Squats', color: '#EC4899' },
  pushups: { label: '💪 Pushups', color: '#EC4899' },
  bicep_curl: { label: '💪 Bicep Curls', color: '#EC4899' },
  swimming: { label: '🏊 Swimming', color: '#06B6D4' },
  typing: { label: '⌨️ Typing', color: '#94A3B8' },
  writing: { label: '✍️ Writing', color: '#94A3B8' },
  waving_hands: { label: '👋 Waving', color: '#38BDF8' },
  shaking_hands: { label: '🤝 Handshake', color: '#38BDF8' },
};

// NOAA Heat Index Tiers (Calculated via Rothfusz polynomial regression)
const HEAT_TIERS = {
  NORMAL: { label: 'Normal', color: '#10B981', bg: 'rgba(16, 185, 129, 0.15)' },
  CAUTION: { label: 'Caution', color: '#FBBF24', bg: 'rgba(251, 191, 36, 0.15)' },
  EXTREME_CAUTION: { label: 'Extreme Caution', color: '#F59E0B', bg: 'rgba(245, 158, 11, 0.15)' },
  DANGER: { label: 'Danger', color: '#EF4444', bg: 'rgba(239, 68, 68, 0.15)' },
  EXTREME_DANGER: { label: 'Extreme Danger', color: '#B91C1C', bg: 'rgba(185, 28, 28, 0.25)' },
};

// Diagnostic Hypothesis Metadata (Synthesized by DiagnosticReasoningEngine.js)
const HYPOTHESIS_META = {
  EXERTION_BENIGN: { label: 'Exertion (Healthy Workout)', color: '#10B981', icon: '🏃' },
  HEAT_STRESS_DEHYDRATION: { label: 'Heat Stress / Dehydration', color: '#F59E0B', icon: '☀️' },
  RESPIRATORY_CONCERN: { label: 'Respiratory Concern', color: '#EF4444', icon: '🫁' },
  CARDIOVASCULAR_CONCERN: { label: 'Cardiovascular Concern', color: '#DC2626', icon: '❤️' },
  ENVIRONMENTAL_HAZARD: { label: 'Environmental Hazard', color: '#F97316', icon: '⚠️' },
  FALL_HARD_IMPACT: { label: 'Fall / Hard Impact', color: '#B91C1C', icon: '🚨' },
  ANOMALY_UNCLEAR: { label: 'Physiological Deviation', color: '#A855F7', icon: '❓' },
  MONITORING: { label: 'Continuous Monitoring', color: '#64748B', icon: '🛡️' },
  NORMAL: { label: 'All Vitals Normal', color: '#10B981', icon: '✅' },
};

const DashboardTab = React.memo(({
  connectionState,
  batteryPct,
  uptime,
  wearConfidence,
  currentPacket = {},
  threatScore = 0.05,
  cooldownActive,
  cooldownTime,
  isStreaming,
  toggleStreaming,
  renderedGraph,
  bleError,
  startScanning,
  devices,
  connectToDevice,
  stopScanning,
  activeDevice,
  handleDisconnect,
  logs,
  logFilter,
  showLogs,
  setShowLogs,
  setLogs,
  handleFilterChange,
  logsHistoryRef,
  renderedLogs,
  threatLevel = { name: 'NORMAL', color: '#10B981', action: 'All systems normal' },
  threatScore3s = 0.0,
  threatScore3m = 0.0,
  threatScore5m = 0.0,
  famFinal = 1.0,
  onTestAlert,
  userCoords = null,
  allNodes = [],
  activeVisit = null,
  onRenameLocation = null,
  onVerifyGuidance = null,
  onDismissGuidance = null,
  onOpenChat = null,
}) => {
  const [showEvidence, setShowEvidence] = useState(false);

  // ─── Telemetry Extraction & Unit Mapping ──────────────────────────────────
  // Values are unpacked from currentPacket, which is updated whenever a 2.0s
  // multi-sensor window completes in EpisodeEngine.js.
  const hasVitals = currentPacket.hr > 0 && currentPacket.spo2 > 0;
  const hr = currentPacket.hr || 0;
  const spo2 = currentPacket.spo2 !== undefined ? currentPacket.spo2 : 0;
  const hrv = currentPacket.hrv || 45.0;
  const tempC = currentPacket.tempC || 24.0;
  const heatF = currentPacket.heatIndexF || 75.0;
  const heatTierKey = currentPacket.heatIndexTier || 'NORMAL';
  const heatMeta = HEAT_TIERS[heatTierKey] || HEAT_TIERS.NORMAL;

  // Activity classification from Model v3 (FeatureExtraction.js classifyEmbedding)
  const activityRaw = (currentPacket.activityClass || 'standing').toLowerCase();
  const activityInfo = ACTIVITY_META[activityRaw] || { label: `Activity: ${activityRaw}`, color: '#60A5FA' };
  const activityConf = currentPacket.activityConfidence !== undefined ? currentPacket.activityConfidence : 1.0;

  // Diagnostic Contract from DiagnosticReasoningEngine.js
  const diag = currentPacket.diagnostic;
  const rawHypo = diag ? diag.primary_hypothesis : (currentPacket.anomalyScore > 0.6 ? 'ANOMALY_UNCLEAR' : 'NORMAL');
  const hypoMeta = HYPOTHESIS_META[rawHypo] || { label: rawHypo, color: '#3B82F6', icon: '🔍' };

  // Vitals Health Status Classifications (NEWS2 Guideline Standards)
  // Cleanly handles unworn / disconnected states (<= 0) to avoid false "Critical" alarms on table
  const hrStatusColor = !hasVitals ? '#64748B' : hr > 115 ? '#EF4444' : hr > 100 ? '#F59E0B' : hr < 50 ? '#F59E0B' : '#10B981';
  const hrStatusText = !hasVitals ? 'Unworn' : hr > 100 ? 'Elevated' : hr < 50 ? 'Low' : 'Normal';

  const spo2StatusColor = !hasVitals ? '#64748B' : spo2 < 90 ? '#EF4444' : spo2 < 94 ? '#F59E0B' : '#10B981';
  const spo2StatusText = !hasVitals ? 'Unworn' : spo2 < 90 ? 'Critical' : spo2 < 94 ? 'Low' : 'Optimal';

  // Active Location Node derived from LocationEngine.js spatial dwell clustering
  const activeLocation = LocationEngine.activeVisit
    ? `Node #${LocationEngine.activeVisit.location_id || LocationEngine.activeVisit.location_node_id}`
    : 'GPS Tracking';

  return (
    <>
      {/* ─── 1. Header: Connection Panel ───────────────────────────── */}
      <View style={styles.glassHeader}>
        <View>
          <Text style={styles.subtext}>RakshaBand Status</Text>
          <View style={styles.row}>
            <View
              style={[
                styles.statusRing,
                {
                  backgroundColor:
                    connectionState === 'DISCONNECTED'
                      ? '#EF4444'
                      : connectionState === 'SCANNING' || connectionState === 'CONNECTING'
                        ? '#F59E0B'
                        : '#10B981',
                },
              ]}
            />
            <Text style={styles.titleText}>{connectionState}</Text>
          </View>
        </View>
        <View style={styles.alignRight}>
          <Text style={styles.subtext}>Battery</Text>
          <Text style={styles.batteryText}>{batteryPct}%</Text>
        </View>
      </View>

      {/* ─── 2. BLE Scanning & Peripheral Manager ──────────────────── */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Bluetooth Peripheral Scanner</Text>
        {bleError && (
          <View style={styles.errorAlert}>
            <Text style={styles.errorAlertText}>⚠️ {bleError}</Text>
          </View>
        )}

        {connectionState === 'DISCONNECTED' && (
          <TouchableOpacity delayPressIn={0} style={styles.scanActionBtn} onPress={startScanning}>
            <Text style={styles.scanActionBtnText}>🔍 Scan for RakshaBand-ESP32</Text>
          </TouchableOpacity>
        )}

        {connectionState === 'SCANNING' && (
          <View>
            <View style={[styles.row, { justifyContent: 'center', marginVertical: 12 }]}>
              <ActivityIndicator size="small" color="#3B82F6" style={{ marginRight: 8 }} />
              <Text style={styles.scanningLabel}>Scanning for active BLE peripherals...</Text>
            </View>

            {devices.length === 0 ? (
              <Text style={styles.noDevicesText}>No devices found yet. Verify device is advertising.</Text>
            ) : (
              devices.map((dev) => (
                <View key={dev.id} style={styles.bleDeviceItem}>
                  <View>
                    <Text style={styles.bleDeviceNameText}>{dev.name || 'RakshaBand-ESP32'}</Text>
                    <Text style={styles.bleDeviceIdText}>ID: {dev.id} | RSSI: {dev.rssi} dBm</Text>
                  </View>
                  <TouchableOpacity delayPressIn={0} style={styles.bleDeviceConnectBtn} onPress={() => connectToDevice(dev.id)}>
                    <Text style={styles.bleDeviceConnectText}>Connect</Text>
                  </TouchableOpacity>
                </View>
              ))
            )}

            <TouchableOpacity delayPressIn={0} style={[styles.scanActionBtn, { backgroundColor: '#EF4444', marginTop: 12 }]} onPress={stopScanning}>
              <Text style={styles.scanActionBtnText}>Stop Scan</Text>
            </TouchableOpacity>
          </View>
        )}

        {connectionState === 'CONNECTING' && (
          <View style={[styles.row, { justifyContent: 'center', paddingVertical: 16 }]}>
            <ActivityIndicator size="large" color="#3B82F6" style={{ marginRight: 12 }} />
            <Text style={styles.connectingLabel}>Pairing and subscribing to services...</Text>
          </View>
        )}

        {connectionState === 'CONNECTED' && (
          <View>
            <Text style={styles.connectedDeviceLabel}>Connected to RakshaBand BLE peripheral.</Text>
            {activeDevice && (
              <Text style={styles.connectedDeviceIdText}>MAC/ID: {activeDevice.id}</Text>
            )}
            <TouchableOpacity delayPressIn={0} style={[styles.scanActionBtn, { backgroundColor: '#EF4444', marginTop: 12 }]} onPress={handleDisconnect}>
              <Text style={styles.scanActionBtnText}>🔌 Disconnect Device</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* ─── 3. Mini Status Row ────────────────────────────────────── */}
      <View style={styles.miniStatsRow}>
        <Text style={styles.miniStat}>Uptime: {uptime}m</Text>
        <Text style={styles.miniStat}>Location: {activeLocation}</Text>
        <Text style={styles.miniStat}>
          {wearConfidence > 40 ? '✅ Wrist Worn' : '⚠️ Off-Wrist'}
        </Text>
      </View>

      {/* ─── 4. Live Multi-Modal Signals Card ──────────────────────── */}
      {/* TRACE: HR, SpO2, HRV, Ambient Temp, Humidity, Barometric Pressure, NOAA Heat Index */}
      <SignalsCard
        currentPacket={currentPacket}
        wearConfidence={wearConfidence}
        connectionState={connectionState}
      />

      {/* ─── 5. Custom Local Spatial Vector Radar Map (Canvas / SVG) ── */}
      {/* TRACE: Equirectangular projection tracking user GPS and 5 nearest nodes. */}
      {/* Tap any node to view last recorded environment, motion, & physiology. */}
      {/* Tap YOU dot to inspect live real-time conditions. Fullscreen toggle expands to all nodes. */}
      <LocalSpatialMap
        userCoords={userCoords}
        allNodes={allNodes && allNodes.length > 0 ? allNodes : LocationEngine.knownNodes}
        activeVisit={activeVisit || LocationEngine.activeVisit}
        currentPacket={currentPacket}
        wearConfidence={wearConfidence}
        onRenameLocation={onRenameLocation}
      />

      {/* ─── 5. Model v3 21-Class Activity Recognition ─────────────── */}
      {/* TRACE: Every 2.0s window (200 samples @ 100 Hz), FeatureExtraction.js extracts */}
      {/* 90 statistical features (Tier 1), 42 spectral FFT features (Tier 2), and */}
      {/* 12 covariance eigenvalues (Tier 3), projecting into a 32D unit embedding. */}
      {/* Cosine dot-product against class_centroids_v3.json selects the activityClass. */}
      {/* Debounce requires >= 8 of the last 10 windows to confirm an episode transition. */}
      <View style={styles.card}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <Text style={styles.cardTitle}>🏃 Real-Time Activity (Model v3)</Text>
          <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: activityInfo.color + '22', borderWidth: 1, borderColor: activityInfo.color }}>
            <Text style={{ color: activityInfo.color, fontSize: 11, fontWeight: '700' }}>
              {activityInfo.label}
            </Text>
          </View>
        </View>

        {/* Confidence Progress Meter */}
        <View style={{ marginTop: 4 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text style={{ color: '#94A3B8', fontSize: 11 }}>Model Confidence</Text>
            <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: 'bold' }}>
              {(activityConf * 100).toFixed(0)}%
            </Text>
          </View>
          <View style={{ height: 8, backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: 4, overflow: 'hidden' }}>
            <View style={{ height: '100%', width: `${Math.min(activityConf * 100, 100)}%`, backgroundColor: activityInfo.color, borderRadius: 4 }} />
          </View>
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 12 }}>
          <Text style={{ color: '#64748B', fontSize: 11 }}>
            Peak Accel: <Text style={{ color: '#E2E8F0', fontWeight: 'bold' }}>{currentPacket.peakAccel || 1000} mg</Text>
          </Text>
          <Text style={{ color: '#64748B', fontSize: 11 }}>
            Debounce: <Text style={{ color: '#E2E8F0', fontWeight: 'bold' }}>10-window majority rule</Text>
          </Text>
        </View>
      </View>

      {/* ─── 6. Diagnostic Reasoning & Threat Assessment ───────────── */}
      {/* TRACE: ContextEngine.js fuses DiagnosticReasoningEngine output with GPS familiarity. */}
      {/* If is_direct_escalation: threatScore = 0.95 (CRITICAL). */}
      {/* If normal: threatScore = baseScore * (1.2 - 0.4 * familiarityScore). */}
      {/* Threat Level: NORMAL (<40%), ADVISORY (40-71%), CRITICAL (>=72% -> triggers alert). */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>🧠 Diagnostic Reasoning Engine</Text>

        {/* Threat Score Circular Gauge */}
        <View style={styles.gaugeContainer}>
          <Svg height="160" width="160" viewBox="0 0 100 100">
            {/* Background Arc */}
            <Circle
              cx="50"
              cy="50"
              r="40"
              stroke="#1E293B"
              strokeWidth="10"
              fill="transparent"
              strokeDasharray="251"
              strokeDashoffset="62"
              strokeLinecap="round"
              transform="rotate(-225 50 50)"
            />
            {/* Active Arc */}
            <Circle
              cx="50"
              cy="50"
              r="40"
              stroke={threatLevel.color}
              strokeWidth="10"
              fill="transparent"
              strokeDasharray="251"
              strokeDashoffset={251 - (189 * threatScore)}
              strokeLinecap="round"
              transform="rotate(-225 50 50)"
            />
          </Svg>
          <View style={styles.gaugeCenterText}>
            <Text style={styles.gaugeScoreText}>{Math.round(threatScore * 100)}%</Text>
            <Text style={[styles.gaugeLevelText, { color: threatLevel.color }]}>
              {threatLevel.name}
            </Text>
          </View>
        </View>

        <Text style={styles.gaugeActionText}>Action: {threatLevel.action}</Text>

        {/* Active Primary Hypothesis Pill */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: hypoMeta.color + '18',
          borderWidth: 1,
          borderColor: hypoMeta.color + '55',
          borderRadius: 10,
          padding: 12,
          marginVertical: 10
        }}>
          <Text style={{ fontSize: 20, marginRight: 10 }}>{hypoMeta.icon}</Text>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#94A3B8', fontSize: 10, fontWeight: '700' }}>PRIMARY HYPOTHESIS</Text>
            <Text style={{ color: hypoMeta.color, fontSize: 14, fontWeight: 'bold' }}>{hypoMeta.label}</Text>
          </View>
          {diag && diag.severity_tier && (
            <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: hypoMeta.color + '33' }}>
              <Text style={{ color: hypoMeta.color, fontSize: 10, fontWeight: 'bold' }}>
                {diag.severity_tier.toUpperCase()}
              </Text>
            </View>
          )}
        </View>

        {/* Gemma 3n Verified Guidance & Notification Hub */}
        {(() => {
          const activeGuidance = currentPacket?.latestGuidance || (diag?.gemma_message ? {
            message: diag.gemma_message,
            recommendedAction: diag.recommended_action || 'Rest in a well-ventilated area.',
            hypothesis: diag.primary_hypothesis,
            severityTier: diag.severity_tier || 'advisory',
            timestamp: Date.now(),
            verified: false,
            eventId: diag.event_id || null,
            isNativeLLM: false
          } : null);

          const isAlert = activeGuidance && activeGuidance.hypothesis && activeGuidance.hypothesis !== 'NORMAL_BASELINE' && activeGuidance.hypothesis !== 'EXERTION_BENIGN';
          const isVerified = activeGuidance?.verified;

          return (
            <View style={{
              backgroundColor: isAlert ? (isVerified ? 'rgba(16, 185, 129, 0.08)' : 'rgba(245, 158, 11, 0.1)') : 'rgba(59, 130, 246, 0.08)',
              borderRadius: 12,
              borderWidth: 1,
              borderColor: isAlert ? (isVerified ? '#10B981' : '#F59E0B') : 'rgba(59, 130, 246, 0.25)',
              padding: 12,
              marginTop: 10
            }}>
              {/* Header row */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <Text style={{ fontSize: 14, marginRight: 6 }}>{isAlert ? (isVerified ? '✅' : '⚠️') : '🤖'}</Text>
                  <Text style={{ color: isAlert ? (isVerified ? '#10B981' : '#F59E0B') : '#60A5FA', fontSize: 12, fontWeight: 'bold' }}>
                    {isAlert ? (isVerified ? 'Verified Health Guidance' : 'Active Advisory — Please Verify') : 'Gemma 3n On-Device AI'}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {activeGuidance?.isNativeLLM && (
                    <View style={{ paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4, backgroundColor: 'rgba(6, 182, 212, 0.2)' }}>
                      <Text style={{ color: '#06B6D4', fontSize: 9, fontWeight: 'bold' }}>⚡ NPU</Text>
                    </View>
                  )}
                  <View style={{
                    paddingHorizontal: 6,
                    paddingVertical: 2,
                    borderRadius: 4,
                    backgroundColor: isVerified ? 'rgba(16, 185, 129, 0.2)' : (isAlert ? 'rgba(245, 158, 11, 0.2)' : 'rgba(16, 185, 129, 0.15)'),
                    borderWidth: 1,
                    borderColor: isVerified ? '#10B981' : (isAlert ? '#F59E0B' : 'rgba(16, 185, 129, 0.35)')
                  }}>
                    <Text style={{ color: isVerified ? '#10B981' : (isAlert ? '#F59E0B' : '#10B981'), fontSize: 9, fontWeight: '700' }}>
                      {isVerified ? '✅ VERIFIED' : (isAlert ? '⚠️ UNVERIFIED' : '🔒 100% OFFLINE')}
                    </Text>
                  </View>
                </View>
              </View>

              {/* Message text */}
              <Text style={{ color: '#F1F5F9', fontSize: 12, lineHeight: 18 }}>
                {activeGuidance?.message || (threatScore < 0.4
                  ? 'All physiological and environmental indicators are currently resting safely within normal limits.'
                  : 'Elevated deviation detected. Rest in a well-ventilated area and hydrate.')}
              </Text>

              {/* Recommended Action banner */}
              {activeGuidance?.recommendedAction && (
                <View style={{
                  backgroundColor: 'rgba(0, 0, 0, 0.25)',
                  borderRadius: 8,
                  padding: 8,
                  marginTop: 8,
                  borderLeftWidth: 3,
                  borderLeftColor: isAlert ? '#F59E0B' : '#60A5FA'
                }}>
                  <Text style={{ color: '#94A3B8', fontSize: 10, fontWeight: '700', marginBottom: 2 }}>RECOMMENDED ACTION:</Text>
                  <Text style={{ color: '#E2E8F0', fontSize: 11 }}>{activeGuidance.recommendedAction}</Text>
                </View>
              )}

              {/* Action Buttons: Verify, Discuss, Dismiss */}
              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginTop: 10, gap: 8 }}>
                {isAlert && !isVerified && onVerifyGuidance && (
                  <TouchableOpacity
                    delayPressIn={0}
                    onPress={() => onVerifyGuidance(activeGuidance.eventId)}
                    style={{
                      backgroundColor: '#10B981',
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 6
                    }}
                  >
                    <Text style={{ color: '#FFFFFF', fontSize: 11, fontWeight: 'bold' }}>✓ Verify & Confirm</Text>
                  </TouchableOpacity>
                )}

                {onOpenChat && (
                  <TouchableOpacity
                    delayPressIn={0}
                    onPress={() => onOpenChat(activeGuidance ? `Can you explain this guidance: "${activeGuidance.message}"?` : 'How are my vitals today?')}
                    style={{
                      backgroundColor: 'rgba(6, 182, 212, 0.2)',
                      borderWidth: 1,
                      borderColor: '#06B6D4',
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 6
                    }}
                  >
                    <Text style={{ color: '#06B6D4', fontSize: 11, fontWeight: 'bold' }}>💬 Ask Gemma</Text>
                  </TouchableOpacity>
                )}

                {isAlert && onDismissGuidance && (
                  <TouchableOpacity
                    delayPressIn={0}
                    onPress={onDismissGuidance}
                    style={{
                      backgroundColor: 'rgba(255, 255, 255, 0.08)',
                      paddingHorizontal: 8,
                      paddingVertical: 6,
                      borderRadius: 6
                    }}
                  >
                    <Text style={{ color: '#94A3B8', fontSize: 11, fontWeight: '600' }}>✕ Dismiss</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        })()}

        {/* Expandable Contributing Evidence Drawer */}
        <View style={{ marginTop: 12 }}>
          <TouchableOpacity
            delayPressIn={0}
            onPress={() => setShowEvidence(!showEvidence)}
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingVertical: 8,
              paddingHorizontal: 4,
            }}
          >
            <Text style={{ color: '#94A3B8', fontSize: 11, fontWeight: '700' }}>
              🔬 Clinical Evidence Breakdown {diag?.contributing_evidence?.length ? `(${diag.contributing_evidence.length})` : ''}
            </Text>
            <Text style={{ color: '#60A5FA', fontSize: 11, fontWeight: 'bold' }}>
              {showEvidence ? 'Hide ▲' : 'View ▼'}
            </Text>
          </TouchableOpacity>

          {showEvidence && (
            <View style={{ backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 8, padding: 10, marginTop: 4 }}>
              {diag?.contributing_evidence && diag.contributing_evidence.length > 0 ? (
                diag.contributing_evidence.map((ev, idx) => (
                  <View key={idx} style={{ flexDirection: 'row', alignItems: 'flex-start', marginVertical: 3 }}>
                    <Text style={{ color: '#38BDF8', marginRight: 6 }}>•</Text>
                    <Text style={{ color: '#CBD5E1', fontSize: 11, flex: 1 }}>{ev}</Text>
                  </View>
                ))
              ) : (
                <Text style={{ color: '#64748B', fontSize: 11 }}>No significant physiological outliers detected.</Text>
              )}

              {/* Mahalanobis Distances */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.05)' }}>
                <Text style={{ color: '#64748B', fontSize: 10 }}>
                  Physiology DM: <Text style={{ color: '#E2E8F0', fontWeight: 'bold' }}>{currentPacket.anomalyScore ? (currentPacket.anomalyScore * 4.0).toFixed(2) : '1.20'}</Text>
                </Text>
                <Text style={{ color: '#64748B', fontSize: 10 }}>
                  Familiarity: <Text style={{ color: '#60A5FA', fontWeight: 'bold' }}>{Math.round(famFinal * 100)}%</Text>
                </Text>
              </View>
            </View>
          )}
        </View>

        {/* Cooldown Active indicator */}
        {cooldownActive && (
          <View style={{ marginTop: 10, padding: 8, backgroundColor: 'rgba(59, 130, 246, 0.1)', borderRadius: 6 }}>
            <Text style={{ color: '#60A5FA', fontSize: 11 }}>
              ℹ️ Threat dampening active post-dismissal ({cooldownTime}s remaining)
            </Text>
          </View>
        )}

        {/* Manual Test Alert Button */}
        <TouchableOpacity
          delayPressIn={0}
          onPress={() => {
            if (onTestAlert) {
              onTestAlert();
            } else {
              Alert.alert('Test Alert', 'Emergency pre-alert triggered.');
            }
          }}
          style={{
            marginTop: 16,
            paddingVertical: 12,
            borderRadius: 10,
            backgroundColor: 'rgba(239, 68, 68, 0.12)',
            borderWidth: 1,
            borderColor: '#EF4444',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: '#EF4444', fontWeight: '700', fontSize: 13 }}>🚨 Test Emergency Alert</Text>
        </TouchableOpacity>
      </View>

      {/* ─── 7. Live Waveform Graph ────────────────────────────────── */}
      {/* TRACE: Visualizes the 50-point rolling buffer of 3-axis accelerometer data. */}
      {/* 1. ESP32 transmits 18-byte MOTION packets (0x01) at 100 Hz over BLE. */}
      {/* 2. useBle.js decodes raw ax, ay, az (mg) and resultant acceleration. */}
      {/* 3. useBle.js throttles the UI update to 5 Hz (every 200ms) to avoid lagging */}
      {/*    the React Native rendering thread. */}
      {/* 4. App.js builds an SVG Path connecting the 50 data points normalized to */}
      {/*    the screen width, with y=70 representing the 1.0g (1000 mg) resting baseline. */}
      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>Live IMU Waveform (25 Hz)</Text>
          <TouchableOpacity delayPressIn={0} onPress={toggleStreaming}>
            <Text style={styles.linkText}>{isStreaming ? 'Pause Stream' : 'Resume Stream'}</Text>
          </TouchableOpacity>
        </View>

        {/* Waveform Canvas */}
        {renderedGraph}

        <View style={styles.rowBetween}>
          <View style={styles.row}>
            <View style={[styles.graphLegendPin, { backgroundColor: '#3B82F6' }]} />
            <Text style={styles.legendText}>Resultant Accel (mg)</Text>
          </View>
          <View style={styles.row}>
            <View style={[styles.graphLegendPin, { backgroundColor: 'rgba(239, 68, 68, 0.5)' }]} />
            <Text style={styles.legendText}>1.0g Rest Baseline</Text>
          </View>
        </View>
      </View>

      {/* ─── 8. Diagnostics Terminal ───────────────────────────────── */}
      {/* TRACE: Real-time on-device audit log displaying streaming telemetry, */}
      {/* inference engine evaluations, and system events. */}
      {/* - SYSTEM: BLE connection status, battery changes, MTU negotiation */}
      {/* - CONTEXT: ContextEngine threat score calculations, hypothesis shifts, and */}
      {/*   location familiarity score changes. Only logs if threat score shifts >= 2%. */}
      {/* Logs are held in logsHistoryRef (max 250 entries) and sliced for display. */}
      <View style={styles.terminalCard}>
        <TouchableOpacity
          delayPressIn={0}
          style={styles.terminalHeader}
          onPress={() => {
            const nextShow = !showLogs;
            setShowLogs(nextShow);
            if (nextShow) {
              setLogs(
                logsHistoryRef.current
                  .filter((l) => logFilter === 'ALL' || l.category === logFilter || l.category === 'SYSTEM')
                  .slice(0, 250)
              );
            } else {
              setLogs([]);
            }
          }}
          activeOpacity={0.75}
        >
          <View style={styles.row}>
            <Text style={styles.terminalTitle}>🖥️ Diagnostics Terminal</Text>
            <View style={styles.terminalBadge}>
              <Text style={styles.terminalBadgeText}>{logs.length}</Text>
            </View>
          </View>
          <View style={styles.row}>
            {logsHistoryRef.current.length > 0 && (
              <TouchableOpacity
                delayPressIn={0}
                onPress={(e) => {
                  e.stopPropagation();
                  setLogs([]);
                  logsHistoryRef.current = [];
                }}
                style={styles.terminalClearBtn}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.terminalClearBtnText}>CLEAR</Text>
              </TouchableOpacity>
            )}
            <Text style={styles.terminalChevron}>{showLogs ? '▲' : '▼'}</Text>
          </View>
        </TouchableOpacity>

        {showLogs && (
          <View>
            {/* Filter Chips */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.terminalChipRow}
              contentContainerStyle={{ paddingRight: 8 }}
            >
              {['ALL', 'CONTEXT', 'SYSTEM'].map((f) => {
                const chipColors = {
                  ALL: '#6B7280',
                  CONTEXT: '#8B5CF6',
                  SYSTEM: '#10B981',
                };
                const active = logFilter === f;
                return (
                  <TouchableOpacity
                    delayPressIn={0}
                    key={f}
                    style={[
                      styles.terminalChip,
                      active && { backgroundColor: chipColors[f] + '33', borderColor: chipColors[f] },
                    ]}
                    onPress={() => handleFilterChange(f)}
                  >
                    <Text
                      style={[
                        styles.terminalChipText,
                        active && { color: chipColors[f] },
                      ]}
                    >
                      {f}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            {/* Rendered Log Entries */}
            <ScrollView
              style={styles.terminalScrollArea}
              nestedScrollEnabled
              showsVerticalScrollIndicator={false}
            >
              {renderedLogs}
            </ScrollView>
          </View>
        )}
      </View>
    </>
  );
});

export default DashboardTab;
