// =============================================================================
// SignalsCard.js — Comprehensive Multi-Modal Sensor & Vitals Telemetry Card
// =============================================================================
//
// DATA LIFE-CYCLE & TRACE:
// ------------------------
// Renders all physiological, environmental, and atmospheric sensor channels
// in a unified dashboard card.
//
// SOURCES:
// 1. MAX30102 PPG (100 Hz):
//    - HR (BPM): Peak-to-peak interval detection with 400ms refractory blanking
//    - SpO2 (%): AC/DC ratio of Red vs IR channels (110 - 25 * R)
//    - HRV (ms): Root Mean Square of Successive RR Differences (RMSSD)
// 2. BMP280 Environmental (1 Hz):
//    - Ambient Temperature (°C / °F)
//    - Relative Humidity (%)
//    - Barometric Atmospheric Pressure (hPa)
// 3. NOAA Heat Index Regression:
//    - Rothfusz bivariate polynomial yielding perceived heat stress tier
// 4. MPU-6050 Motion / IMU (100 Hz):
//    - Peak resultant acceleration (mg)
//    - Wrist contact wear confidence (%)
// =============================================================================

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

// NOAA Heat Index Tiers (Calculated via Rothfusz polynomial regression)
const HEAT_TIERS = {
  NORMAL: { label: 'Normal', color: '#10B981', bg: 'rgba(16, 185, 129, 0.15)' },
  CAUTION: { label: 'Caution', color: '#FBBF24', bg: 'rgba(251, 191, 36, 0.15)' },
  EXTREME_CAUTION: { label: 'Extreme Caution', color: '#F59E0B', bg: 'rgba(245, 158, 11, 0.15)' },
  DANGER: { label: 'Danger', color: '#EF4444', bg: 'rgba(239, 68, 68, 0.15)' },
  EXTREME_DANGER: { label: 'Extreme Danger', color: '#B91C1C', bg: 'rgba(185, 28, 28, 0.25)' },
};

export default function SignalsCard({
  currentPacket = {},
  wearConfidence = 100,
  connectionState = 'CONNECTED'
}) {
  const isConnected = connectionState === 'CONNECTED';
  const hasVitals = isConnected && wearConfidence > 40 && currentPacket.hr > 0 && currentPacket.spo2 > 0;

  // 1. Physiological Vitals
  const hr = currentPacket.hr || 0;
  const spo2 = currentPacket.spo2 !== undefined ? currentPacket.spo2 : 0;
  const hrv = currentPacket.hrv !== undefined ? currentPacket.hrv : 45.0;

  // 2. Environmental & Atmospheric Metrics
  const tempC = currentPacket.tempC !== undefined ? currentPacket.tempC : 24.0;
  const tempF = (tempC * 9) / 5 + 32;
  const humPct = currentPacket.humidityPct !== undefined ? currentPacket.humidityPct : 50.0;
  const pressHpa = currentPacket.pressureHpa !== undefined ? currentPacket.pressureHpa : 1013.2;

  // 3. NOAA Heat Index
  const heatF = currentPacket.heatIndexF !== undefined ? currentPacket.heatIndexF : tempF;
  const heatC = ((heatF - 32) * 5) / 9;
  const heatTierKey = currentPacket.heatIndexTier || 'NORMAL';
  const heatMeta = HEAT_TIERS[heatTierKey] || HEAT_TIERS.NORMAL;

  // 4. Motion & Wear Indicators
  const peakAccel = currentPacket.peakAccel || 1000;
  const isWorn = wearConfidence > 40;

  // Clinical Vitals Classifications (NEWS2 standards)
  const hrStatusColor = !hasVitals ? '#64748B' : hr > 115 ? '#EF4444' : hr > 100 ? '#F59E0B' : hr < 50 ? '#F59E0B' : '#10B981';
  const hrStatusText = !hasVitals ? (isConnected ? 'Unworn' : 'Offline') : hr > 100 ? 'Elevated' : hr < 50 ? 'Low' : 'Normal';

  const spo2StatusColor = !hasVitals ? '#64748B' : spo2 < 90 ? '#EF4444' : spo2 < 94 ? '#F59E0B' : '#10B981';
  const spo2StatusText = !hasVitals ? (isConnected ? 'Unworn' : 'Offline') : spo2 < 90 ? 'Critical' : spo2 < 94 ? 'Low' : 'Optimal';

  const humStatusText = humPct < 30 ? 'Dry' : humPct > 70 ? 'Humid' : 'Optimal';
  const humStatusColor = humPct < 30 ? '#F59E0B' : humPct > 70 ? '#38BDF8' : '#10B981';

  return (
    <View style={cardStyles.container}>
      {/* Header with live signal pulse */}
      <View style={cardStyles.headerRow}>
        <View style={cardStyles.rowCenter}>
          <View style={[cardStyles.liveDot, { backgroundColor: isConnected ? '#10B981' : '#EF4444' }]} />
          <Text style={cardStyles.cardTitle}>Live Multi-Modal Signals</Text>
        </View>
        <View style={cardStyles.wearBadge}>
          <Text style={[cardStyles.wearBadgeText, { color: isWorn ? '#10B981' : '#F59E0B' }]}>
            {isWorn ? '✓ Wrist Worn' : '⚠️ Off-Wrist'}
          </Text>
        </View>
      </View>

      {/* Grid of Sensor Signals */}
      <View style={cardStyles.grid}>
        {/* Tile 1: Heart Rate */}
        <View style={cardStyles.tile}>
          <View style={cardStyles.tileHeader}>
            <Text style={cardStyles.tileCategory}>❤️ HEART RATE</Text>
            <View style={[cardStyles.badge, { backgroundColor: hrStatusColor + '22' }]}>
              <Text style={[cardStyles.badgeText, { color: hrStatusColor }]}>{hrStatusText}</Text>
            </View>
          </View>
          <Text style={cardStyles.tileValue}>
            {hasVitals ? hr : '--'}{' '}
            <Text style={cardStyles.tileUnit}>BPM</Text>
          </Text>
          <Text style={cardStyles.tileSubtext}>Resting range: 60-100</Text>
        </View>

        {/* Tile 2: SpO2 */}
        <View style={cardStyles.tile}>
          <View style={cardStyles.tileHeader}>
            <Text style={cardStyles.tileCategory}>🫁 OXYGEN (SpO2)</Text>
            <View style={[cardStyles.badge, { backgroundColor: spo2StatusColor + '22' }]}>
              <Text style={[cardStyles.badgeText, { color: spo2StatusColor }]}>{spo2StatusText}</Text>
            </View>
          </View>
          <Text style={cardStyles.tileValue}>
            {hasVitals ? spo2.toFixed(0) : '--'}{' '}
            <Text style={cardStyles.tileUnit}>%</Text>
          </Text>
          <Text style={cardStyles.tileSubtext}>Clinical target: ≥ 95%</Text>
        </View>

        {/* Tile 3: HRV */}
        <View style={cardStyles.tile}>
          <View style={cardStyles.tileHeader}>
            <Text style={cardStyles.tileCategory}>💓 HRV (RMSSD)</Text>
            <View style={[cardStyles.badge, { backgroundColor: 'rgba(139, 92, 246, 0.15)' }]}>
              <Text style={[cardStyles.badgeText, { color: '#A78BFA' }]}>Vagal</Text>
            </View>
          </View>
          <Text style={cardStyles.tileValue}>
            {hasVitals ? hrv.toFixed(0) : '--'}{' '}
            <Text style={cardStyles.tileUnit}>ms</Text>
          </Text>
          <Text style={cardStyles.tileSubtext}>Autonomic resilience</Text>
        </View>

        {/* Tile 4: NOAA Heat Index */}
        <View style={cardStyles.tile}>
          <View style={cardStyles.tileHeader}>
            <Text style={cardStyles.tileCategory}>☀️ HEAT INDEX</Text>
            <View style={[cardStyles.badge, { backgroundColor: heatMeta.bg, borderColor: heatMeta.color, borderWidth: 1 }]}>
              <Text style={[cardStyles.badgeText, { color: heatMeta.color }]}>{heatMeta.label}</Text>
            </View>
          </View>
          <Text style={cardStyles.tileValue}>
            {heatF.toFixed(0)}°F{' '}
            <Text style={cardStyles.tileUnit}>({heatC.toFixed(0)}°C)</Text>
          </Text>
          <Text style={cardStyles.tileSubtext}>NOAA Rothfusz formula</Text>
        </View>

        {/* Tile 5: Ambient Temperature */}
        <View style={cardStyles.tile}>
          <View style={cardStyles.tileHeader}>
            <Text style={cardStyles.tileCategory}>🌡️ AMBIENT TEMP</Text>
            <View style={[cardStyles.badge, { backgroundColor: 'rgba(59, 130, 246, 0.15)' }]}>
              <Text style={[cardStyles.badgeText, { color: '#60A5FA' }]}>BMP280</Text>
            </View>
          </View>
          <Text style={cardStyles.tileValue}>
            {tempC.toFixed(1)}°C{' '}
            <Text style={cardStyles.tileUnit}>({tempF.toFixed(1)}°F)</Text>
          </Text>
          <Text style={cardStyles.tileSubtext}>Ambient environment</Text>
        </View>

        {/* Tile 6: Relative Humidity */}
        <View style={cardStyles.tile}>
          <View style={cardStyles.tileHeader}>
            <Text style={cardStyles.tileCategory}>💧 HUMIDITY</Text>
            <View style={[cardStyles.badge, { backgroundColor: humStatusColor + '22' }]}>
              <Text style={[cardStyles.badgeText, { color: humStatusColor }]}>{humStatusText}</Text>
            </View>
          </View>
          <Text style={cardStyles.tileValue}>
            {humPct.toFixed(0)}{' '}
            <Text style={cardStyles.tileUnit}>%</Text>
          </Text>
          <Text style={cardStyles.tileSubtext}>Comfort zone: 30 - 60%</Text>
        </View>

        {/* Tile 7: Barometric Pressure */}
        <View style={cardStyles.tile}>
          <View style={cardStyles.tileHeader}>
            <Text style={cardStyles.tileCategory}>🧭 BAROMETRIC</Text>
            <View style={[cardStyles.badge, { backgroundColor: 'rgba(16, 185, 129, 0.15)' }]}>
              <Text style={[cardStyles.badgeText, { color: '#34D399' }]}>Sea-level</Text>
            </View>
          </View>
          <Text style={cardStyles.tileValue}>
            {pressHpa.toFixed(1)}{' '}
            <Text style={cardStyles.tileUnit}>hPa</Text>
          </Text>
          <Text style={cardStyles.tileSubtext}>Ref: 1013.2 hPa (1 atm)</Text>
        </View>

        {/* Tile 8: Motion Peak Acceleration */}
        <View style={cardStyles.tile}>
          <View style={cardStyles.tileHeader}>
            <Text style={cardStyles.tileCategory}>⚡ DYNAMIC ACCEL</Text>
            <View style={[cardStyles.badge, { backgroundColor: 'rgba(245, 158, 11, 0.15)' }]}>
              <Text style={[cardStyles.badgeText, { color: '#FBBF24' }]}>MPU-6050</Text>
            </View>
          </View>
          <Text style={cardStyles.tileValue}>
            {peakAccel}{' '}
            <Text style={cardStyles.tileUnit}>mg</Text>
          </Text>
          <Text style={cardStyles.tileSubtext}>1.0g gravity = 1000 mg</Text>
        </View>
      </View>
    </View>
  );
}

const cardStyles = StyleSheet.create({
  container: {
    backgroundColor: '#0F172A',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.2)',
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  rowCenter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#F8FAFC',
    letterSpacing: 0.3,
  },
  wearBadge: {
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  wearBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  tile: {
    flex: 1,
    minWidth: '46%',
    backgroundColor: 'rgba(255, 255, 255, 0.025)',
    borderRadius: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  tileHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  tileCategory: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.4,
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '700',
  },
  tileValue: {
    color: '#FFFFFF',
    fontSize: 22,
    fontWeight: 'bold',
    marginVertical: 3,
  },
  tileUnit: {
    fontSize: 12,
    color: '#64748B',
    fontWeight: 'normal',
  },
  tileSubtext: {
    color: '#64748B',
    fontSize: 10,
    marginTop: 2,
  },
});
