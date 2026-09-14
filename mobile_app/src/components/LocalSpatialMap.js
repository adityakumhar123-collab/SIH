// =============================================================================
// LocalSpatialMap.js — Custom Vector Spatial Radar Map (Canvas / SVG Based)
// =============================================================================
//
// MATHEMATICAL PROJECTION & ARCHITECTURE:
// ---------------------------------------
// 1. Projection: Equirectangular Flat-Earth Local Approximation:
//    - Centered at user's current GPS position (userLat, userLon).
//    - dx = (nodeLon - userLon) * cos(userLat * PI / 180) * 111,320 meters
//    - dy = -(nodeLat - userLat) * 110,540 meters (Negative because screen Y increases downward)
//    - Screen coords: X = cx + dx * scale, Y = cy + dy * scale
//
// 2. Proximity Node Selection:
//    - Minimized mode: Dynamically sorts all registered known locations by distance
//      and selects the 5 nearest nodes.
//    - Fullscreen mode: Renders all registered known locations with pan/zoom controls.
//    - As user moves, GPS updates smoothly shift (dx, dy), causing nodes to translate
//      across the canvas; farther nodes rotate out of the top 5 and new nodes appear.
//
// 3. Geofence Entry Radius:
//    - Renders concentric entry radius circles: R_pixel = entry_radius * scale
//    - Highlights active visit node in emerald (#10B981) and other nodes in purple (#8B5CF6).
//
// 4. Interactivity:
//    - Node click: Shows historical environment, last motion state, and physiological condition.
//    - User click: Shows real-time live physiology, environment, and current motion state.
// =============================================================================

import React, { useState, useMemo, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Dimensions,
  StyleSheet,
  ScrollView,
  Platform,
  Animated
} from 'react-native';
import Svg, {
  Circle,
  Line,
  Text as SvgText,
  G,
  Rect,
  Path
} from 'react-native-svg';
import { getCleanLocationName, getLocationHistoricalData } from '../Database.js';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function LocalSpatialMap({
  userCoords,
  allNodes = [],
  activeVisit = null,
  currentPacket = {},
  wearConfidence = 100,
  onRenameLocation = null,
}) {
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomMultiplier, setZoomMultiplier] = useState(1.0);
  const [selectedNode, setSelectedNode] = useState(null);
  const [nodeHistoryData, setNodeHistoryData] = useState(null);
  const [showUserModal, setShowUserModal] = useState(false);

  // Radar sweep animation for the user marker
  const pulseAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, [pulseAnim]);

  // Dimensions of canvas
  const canvasWidth = isFullscreen ? SCREEN_WIDTH - 32 : SCREEN_WIDTH - 48;
  const canvasHeight = isFullscreen ? SCREEN_HEIGHT * 0.65 : 290;
  const cx = canvasWidth / 2;
  const cy = canvasHeight / 2;

  // Resolve user coordinates (fallback to Bangalore baseline if GPS fix is pending)
  const hasGps = userCoords && typeof userCoords.latitude === 'number' && typeof userCoords.longitude === 'number';
  const uLat = hasGps ? userCoords.latitude : 12.9716;
  const uLon = hasGps ? userCoords.longitude : 77.5946;
  const uAcc = Math.round(userCoords?.accuracy || 15);

  // ─── Mathematical Equirectangular Projection ──────────────────────────────
  const { displayNodes, maxDistMeters, scale } = useMemo(() => {
    const toRad = (x) => (x * Math.PI) / 180.0;
    const cosLat = Math.cos(toRad(uLat));

    // Augment each node with local planar meters offset from user
    const augmented = allNodes.map((node) => {
      const nLat = node.center_latitude !== undefined ? node.center_latitude : (node.latitude || uLat);
      const nLon = node.center_longitude !== undefined ? node.center_longitude : (node.longitude || uLon);

      const dx = (nLon - uLon) * cosLat * 111320.0; // East in meters
      const dy = -(nLat - uLat) * 110540.0;          // South in meters
      const dist = Math.sqrt(dx * dx + dy * dy);

      return {
        ...node,
        dx,
        dy,
        distMeters: Math.round(dist * 10) / 10,
        entryRadiusMeters: node.entry_radius || 25.0,
      };
    });

    // Sort ascending by distance from user
    augmented.sort((a, b) => a.distMeters - b.distMeters);

    // Minimized mode: strictly cap to 5 nearest nodes
    // Fullscreen mode: show all known location nodes
    const selected = isFullscreen ? augmented : augmented.slice(0, 5);

    // Compute maximum distance to fit comfortably inside the canvas viewport
    let maxDist = 60.0; // minimum radius in meters
    for (const node of selected) {
      const edgeDist = node.distMeters + node.entryRadiusMeters;
      if (edgeDist > maxDist) maxDist = edgeDist;
    }

    // Viewport radius in screen pixels (leaving 35px padding for labels)
    const viewportRadiusPx = Math.min(canvasWidth, canvasHeight) / 2 - 35;
    const computedScale = (viewportRadiusPx / maxDist) * zoomMultiplier;

    return {
      displayNodes: selected,
      maxDistMeters: maxDist,
      scale: Math.max(computedScale, 0.05),
    };
  }, [allNodes, uLat, uLon, isFullscreen, zoomMultiplier, canvasWidth, canvasHeight]);

  // Handle node press: query historical details from SQLite
  const handleNodePress = (node) => {
    const history = getLocationHistoricalData(node.location_id);
    setSelectedNode(node);
    setNodeHistoryData(history);
  };

  // Zoom controls
  const handleZoomIn = () => setZoomMultiplier((prev) => Math.min(prev * 1.3, 3.5));
  const handleZoomOut = () => setZoomMultiplier((prev) => Math.max(prev / 1.3, 0.4));
  const handleRecenter = () => setZoomMultiplier(1.0);

  // Concentric radar reference range rings
  const ringSteps = [0.25, 0.5, 0.75, 1.0];

  return (
    <View style={mapStyles.cardContainer}>
      {/* Map Header */}
      <View style={mapStyles.headerRow}>
        <View>
          <View style={mapStyles.rowCenter}>
            <Text style={mapStyles.radarIcon}>🎯</Text>
            <Text style={mapStyles.cardTitle}>Local Spatial Vector Radar</Text>
          </View>
          <Text style={mapStyles.cardSubtitle}>
            {isFullscreen
              ? `Displaying all ${displayNodes.length} registered nodes`
              : `Tracking 5 nearest nodes • Canvas projection`}
          </Text>
        </View>

        {/* Expand / Minimize Toggle */}
        <TouchableOpacity
          delayPressIn={0}
          onPress={() => {
            setIsFullscreen(!isFullscreen);
            setZoomMultiplier(1.0);
          }}
          style={mapStyles.fullscreenBtn}
          activeOpacity={0.8}
        >
          <Text style={mapStyles.fullscreenBtnText}>
            {isFullscreen ? '🗗 Minimize' : '⛶ Fullscreen'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* GPS Status Banner */}
      {!hasGps && (
        <View style={mapStyles.gpsBanner}>
          <Text style={mapStyles.gpsBannerText}>
            📍 Acquiring GPS fix... Displaying baseline reference coordinates.
          </Text>
        </View>
      )}

      {/* SVG Vector Map Canvas */}
      <View style={[mapStyles.canvasWrapper, { width: canvasWidth, height: canvasHeight }]}>
        <Svg width={canvasWidth} height={canvasHeight}>
          {/* 1. Tactical Radar Background & Border */}
          <Rect
            x="0"
            y="0"
            width={canvasWidth}
            height={canvasHeight}
            fill="#090E17"
            rx="14"
          />

          {/* 2. Concentric Radar Distance Rings */}
          {ringSteps.map((fraction, idx) => {
            const ringDistMeters = Math.round(maxDistMeters * fraction);
            const ringRadiusPx = ringDistMeters * scale;
            if (ringRadiusPx > Math.min(canvasWidth, canvasHeight) / 2) return null;

            return (
              <G key={`ring-${idx}`}>
                <Circle
                  cx={cx}
                  cy={cy}
                  r={ringRadiusPx}
                  stroke="rgba(59, 130, 246, 0.15)"
                  strokeWidth="1"
                  strokeDasharray="4, 4"
                  fill="none"
                />
                <SvgText
                  x={cx + 4}
                  y={cy - ringRadiusPx + 12}
                  fill="rgba(148, 163, 184, 0.45)"
                  fontSize="9"
                  fontFamily={Platform.OS === 'ios' ? 'Courier' : 'monospace'}
                >
                  {ringDistMeters}m
                </SvgText>
              </G>
            );
          })}

          {/* 3. Crosshair Grid Lines */}
          <Line
            x1={cx}
            y1={12}
            x2={cx}
            y2={canvasHeight - 12}
            stroke="rgba(59, 130, 246, 0.1)"
            strokeWidth="1"
          />
          <Line
            x1={12}
            y1={cy}
            x2={canvasWidth - 12}
            y2={cy}
            stroke="rgba(59, 130, 246, 0.1)"
            strokeWidth="1"
          />

          {/* 4. Cardinal Compass Points */}
          <SvgText x={cx} y={16} fill="#38BDF8" fontSize="10" fontWeight="bold" textAnchor="middle">
            N
          </SvgText>
          <SvgText x={cx} y={canvasHeight - 6} fill="#64748B" fontSize="9" textAnchor="middle">
            S
          </SvgText>
          <SvgText x={canvasWidth - 10} y={cy + 3} fill="#64748B" fontSize="9" textAnchor="middle">
            E
          </SvgText>
          <SvgText x={10} y={cy + 3} fill="#64748B" fontSize="9" textAnchor="middle">
            W
          </SvgText>

          {/* 5. Lines connecting User to Nearest Nodes */}
          {displayNodes.map((node) => {
            const nx = cx + node.dx * scale;
            const ny = cy + node.dy * scale;
            const isInside = activeVisit && activeVisit.location_id === node.location_id;
            const lineColor = isInside ? 'rgba(16, 185, 129, 0.35)' : 'rgba(139, 92, 246, 0.25)';

            return (
              <Line
                key={`line-${node.location_id}`}
                x1={cx}
                y1={cy}
                x2={nx}
                y2={ny}
                stroke={lineColor}
                strokeWidth="1.2"
                strokeDasharray="2, 4"
              />
            );
          })}

          {/* 6. Render Known Location Nodes & Entry Radius Circles */}
          {displayNodes.map((node) => {
            const nx = cx + node.dx * scale;
            const ny = cy + node.dy * scale;
            const rPx = Math.max(12, node.entryRadiusMeters * scale);
            const isInside = activeVisit && activeVisit.location_id === node.location_id;

            const strokeColor = isInside ? '#10B981' : '#8B5CF6';
            const fillColor = isInside ? 'rgba(16, 185, 129, 0.15)' : 'rgba(139, 92, 246, 0.1)';
            const cleanName = getCleanLocationName(node);

            return (
              <G key={`node-${node.location_id}`} onPress={() => handleNodePress(node)}>
                {/* Entry Radius Circle */}
                <Circle
                  cx={nx}
                  cy={ny}
                  r={rPx}
                  stroke={strokeColor}
                  strokeWidth="1.5"
                  strokeDasharray="4, 4"
                  fill={fillColor}
                />

                {/* Node Center Pin Core */}
                <Circle
                  cx={nx}
                  cy={ny}
                  r="6"
                  fill={strokeColor}
                  stroke="#FFFFFF"
                  strokeWidth="1.5"
                />

                {/* Node Label Pill Background */}
                <Rect
                  x={nx - 36}
                  y={ny + 8}
                  width="72"
                  height="16"
                  rx="4"
                  fill="rgba(15, 23, 42, 0.85)"
                  stroke={strokeColor}
                  strokeWidth="0.8"
                />

                {/* Node Name */}
                <SvgText
                  x={nx}
                  y={ny + 19}
                  fill="#F8FAFC"
                  fontSize="9"
                  fontWeight="bold"
                  textAnchor="middle"
                >
                  {cleanName.length > 10 ? cleanName.substring(0, 9) + '…' : cleanName}
                </SvgText>

                {/* Distance Badge */}
                <SvgText
                  x={nx}
                  y={ny - rPx - 4}
                  fill={strokeColor}
                  fontSize="8"
                  fontWeight="bold"
                  textAnchor="middle"
                >
                  {Math.round(node.distMeters)}m
                </SvgText>
              </G>
            );
          })}

          {/* 7. User Current Location Pulse & Dot (Clickable) */}
          <G onPress={() => setShowUserModal(true)}>
            {/* Pulsing Radar Aura */}
            <Circle
              cx={cx}
              cy={cy}
              r="22"
              fill="rgba(59, 130, 246, 0.15)"
              stroke="rgba(59, 130, 246, 0.4)"
              strokeWidth="1"
              strokeDasharray="3, 3"
            />
            {/* Outer Blue Ring */}
            <Circle
              cx={cx}
              cy={cy}
              r="12"
              fill="rgba(59, 130, 246, 0.3)"
              stroke="#3B82F6"
              strokeWidth="1.5"
            />
            {/* Inner Glowing Core */}
            <Circle
              cx={cx}
              cy={cy}
              r="6"
              fill="#3B82F6"
              stroke="#FFFFFF"
              strokeWidth="1.5"
            />
            {/* Center White Pin */}
            <Circle
              cx={cx}
              cy={cy}
              r="2"
              fill="#FFFFFF"
            />
            {/* User Label */}
            <Rect
              x={cx - 18}
              y={cy + 14}
              width="36"
              height="14"
              rx="3"
              fill="#3B82F6"
            />
            <SvgText
              x={cx}
              y={cy + 24}
              fill="#FFFFFF"
              fontSize="8"
              fontWeight="bold"
              textAnchor="middle"
            >
              YOU
            </SvgText>
          </G>
        </Svg>

        {/* Canvas HUD Overlays */}
        {/* Top-Left: Active Zone / Distance indicator */}
        <View style={mapStyles.hudTopLeft}>
          <Text style={mapStyles.hudText}>
            {activeVisit ? `🟢 Inside Zone #${activeVisit.location_id}` : '🔵 En Route'}
          </Text>
        </View>

        {/* Top-Right: Accuracy HUD */}
        <View style={mapStyles.hudTopRight}>
          <Text style={mapStyles.hudText}>GPS ±{uAcc}m</Text>
        </View>

        {/* Bottom-Right: Zoom Controls (In fullscreen or minimized) */}
        {isFullscreen && (
          <View style={mapStyles.zoomControlsRow}>
            <TouchableOpacity delayPressIn={0} onPress={handleZoomIn} style={mapStyles.zoomBtn}>
              <Text style={mapStyles.zoomBtnText}>+</Text>
            </TouchableOpacity>
            <TouchableOpacity delayPressIn={0} onPress={handleZoomOut} style={mapStyles.zoomBtn}>
              <Text style={mapStyles.zoomBtnText}>−</Text>
            </TouchableOpacity>
            <TouchableOpacity delayPressIn={0} onPress={handleRecenter} style={mapStyles.zoomBtn}>
              <Text style={[mapStyles.zoomBtnText, { fontSize: 11 }]}>⟲</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Bottom-Left: Interactive Hint */}
        <View style={mapStyles.hudBottomLeft}>
          <Text style={mapStyles.hudSubtext}>Tap node or YOU for telemetry</Text>
        </View>
      </View>

      {/* ─── NODE DETAIL MODAL / POPOVER ────────────────────────────── */}
      {/* Displays last stored environment, kind of motion, and physiological condition */}
      <Modal
        visible={selectedNode !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedNode(null)}
      >
        <View style={mapStyles.modalOverlay}>
          <View style={mapStyles.modalCard}>
            {selectedNode && (
              <ScrollView showsVerticalScrollIndicator={false}>
                {/* Modal Title Bar */}
                <View style={mapStyles.modalHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={mapStyles.modalNodeTag}>📍 LOCATION NODE #{selectedNode.location_id}</Text>
                    <Text style={mapStyles.modalNodeTitle}>{getCleanLocationName(selectedNode)}</Text>
                  </View>
                  <TouchableOpacity delayPressIn={0} onPress={() => setSelectedNode(null)} style={mapStyles.closeBtn}>
                    <Text style={mapStyles.closeBtnText}>✕</Text>
                  </TouchableOpacity>
                </View>

                {/* Subtitle / Distance */}
                <Text style={mapStyles.modalDistanceText}>
                  {selectedNode.distMeters}m from current position • Entry radius: {selectedNode.entryRadiusMeters}m
                </Text>

                {/* Rename Action Button */}
                {onRenameLocation && (
                  <TouchableOpacity
                    delayPressIn={0}
                    onPress={() => {
                      const nodeToRename = selectedNode;
                      setSelectedNode(null);
                      onRenameLocation(nodeToRename);
                    }}
                    style={mapStyles.renameBtn}
                  >
                    <Text style={mapStyles.renameBtnText}>✏️ Rename Location</Text>
                  </TouchableOpacity>
                )}

                {/* Section 1: Last Stored Environmental Details */}
                <View style={mapStyles.sectionBox}>
                  <Text style={mapStyles.sectionTitle}>🌤️ Last Stored Environment</Text>
                  <View style={mapStyles.metricRow}>
                    <View style={mapStyles.metricCol}>
                      <Text style={mapStyles.metricLabel}>AMBIENT TEMP</Text>
                      <Text style={mapStyles.metricValue}>
                        {(nodeHistoryData?.lastEpisode?.temperature_mean || selectedNode.baseline_temp_mean || 24.0).toFixed(1)}°C
                      </Text>
                    </View>
                    <View style={mapStyles.metricCol}>
                      <Text style={mapStyles.metricLabel}>HUMIDITY</Text>
                      <Text style={mapStyles.metricValue}>
                        {(nodeHistoryData?.lastEpisode?.humidity_mean || selectedNode.baseline_humidity_mean || 50.0).toFixed(0)}%
                      </Text>
                    </View>
                    <View style={mapStyles.metricCol}>
                      <Text style={mapStyles.metricLabel}>PRESSURE</Text>
                      <Text style={mapStyles.metricValue}>
                        {(nodeHistoryData?.lastEpisode?.pressure_mean || 1013.2).toFixed(1)} hPa
                      </Text>
                    </View>
                    <View style={mapStyles.metricCol}>
                      <Text style={mapStyles.metricLabel}>HEAT INDEX</Text>
                      <Text style={mapStyles.metricValue}>
                        {(nodeHistoryData?.lastEpisode?.heat_index_mean || selectedNode.baseline_heat_index_mean || 75.0).toFixed(0)}°F
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Section 2: Last Recorded Motion / Activity */}
                <View style={mapStyles.sectionBox}>
                  <Text style={mapStyles.sectionTitle}>🏃 Last Motion & Activity</Text>
                  <View style={mapStyles.activityRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={mapStyles.activityLabel}>
                        {nodeHistoryData?.lastEpisode?.activity_class
                          ? nodeHistoryData.lastEpisode.activity_class.toUpperCase().replace(/_/g, ' ')
                          : 'RESTING / SITTING'}
                      </Text>
                      <Text style={mapStyles.activityMeta}>
                        Confidence:{' '}
                        {Math.round((nodeHistoryData?.lastEpisode?.activity_confidence || 0.95) * 100)}%
                        {nodeHistoryData?.lastEpisode?.duration_seconds
                          ? ` • Duration: ${nodeHistoryData.lastEpisode.duration_seconds}s`
                          : ''}
                      </Text>
                    </View>
                    <View style={mapStyles.activityPill}>
                      <Text style={mapStyles.activityPillText}>Model v3</Text>
                    </View>
                  </View>
                </View>

                {/* Section 3: Last Physiological Condition */}
                <View style={mapStyles.sectionBox}>
                  <Text style={mapStyles.sectionTitle}>🫀 Physiological Condition (Last Visit)</Text>
                  <View style={mapStyles.metricRow}>
                    <View style={mapStyles.metricCol}>
                      <Text style={mapStyles.metricLabel}>RESTING HR</Text>
                      <Text style={mapStyles.metricValue}>
                        {nodeHistoryData?.lastEpisode?.hr_mean
                          ? Math.round(nodeHistoryData.lastEpisode.hr_mean)
                          : (selectedNode.baseline_resting_hr || 72)}{' '}
                        <Text style={mapStyles.unitText}>BPM</Text>
                      </Text>
                    </View>
                    <View style={mapStyles.metricCol}>
                      <Text style={mapStyles.metricLabel}>SPO2</Text>
                      <Text style={mapStyles.metricValue}>
                        {(nodeHistoryData?.lastEpisode?.spo2_mean || 98).toFixed(0)}{' '}
                        <Text style={mapStyles.unitText}>%</Text>
                      </Text>
                    </View>
                    <View style={mapStyles.metricCol}>
                      <Text style={mapStyles.metricLabel}>HRV RMSSD</Text>
                      <Text style={mapStyles.metricValue}>
                        {(nodeHistoryData?.lastEpisode?.hrv_rmssd || 45).toFixed(0)}{' '}
                        <Text style={mapStyles.unitText}>ms</Text>
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Section 4: Visit Statistics */}
                <View style={mapStyles.statsRow}>
                  <Text style={mapStyles.statsText}>
                    Visits: <Text style={{ color: '#F8FAFC', fontWeight: 'bold' }}>{selectedNode.dwell_count || 1}</Text>
                  </Text>
                  <Text style={mapStyles.statsText}>
                    Total Stay: <Text style={{ color: '#F8FAFC', fontWeight: 'bold' }}>{selectedNode.total_stay_minutes || 0}m</Text>
                  </Text>
                  <Text style={mapStyles.statsText}>
                    Last seen: <Text style={{ color: '#F8FAFC', fontWeight: 'bold' }}>
                      {selectedNode.last_visited_at ? new Date(selectedNode.last_visited_at).toLocaleDateString() : 'Recent'}
                    </Text>
                  </Text>
                </View>

                {/* Close Button */}
                <TouchableOpacity
                  delayPressIn={0}
                  onPress={() => setSelectedNode(null)}
                  style={mapStyles.doneBtn}
                >
                  <Text style={mapStyles.doneBtnText}>Close Details</Text>
                </TouchableOpacity>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* ─── REAL-TIME USER TELEMETRY MODAL / POPOVER ──────────────── */}
      {/* Displays current real-time physiology, environment, and motion state */}
      <Modal
        visible={showUserModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowUserModal(false)}
      >
        <View style={mapStyles.modalOverlay}>
          <View style={mapStyles.modalCard}>
            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Header */}
              <View style={mapStyles.modalHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={[mapStyles.modalNodeTag, { color: '#38BDF8' }]}>🔵 LIVE USER TELEMETRY</Text>
                  <Text style={mapStyles.modalNodeTitle}>Current Real-Time State</Text>
                </View>
                <TouchableOpacity delayPressIn={0} onPress={() => setShowUserModal(false)} style={mapStyles.closeBtn}>
                  <Text style={mapStyles.closeBtnText}>✕</Text>
                </TouchableOpacity>
              </View>

              {/* Coordinates & Accuracy */}
              <Text style={mapStyles.modalDistanceText}>
                Lat: {uLat.toFixed(5)}, Lon: {uLon.toFixed(5)} • Accuracy: ±{uAcc}m
              </Text>

              {/* Real-time Physiology */}
              <View style={mapStyles.sectionBox}>
                <Text style={mapStyles.sectionTitle}>🫀 Live Physiological Condition</Text>
                <View style={mapStyles.metricRow}>
                  <View style={mapStyles.metricCol}>
                    <Text style={mapStyles.metricLabel}>HEART RATE</Text>
                    <Text style={mapStyles.metricValue}>
                      {currentPacket.hr || '--'}{' '}
                      <Text style={mapStyles.unitText}>BPM</Text>
                    </Text>
                  </View>
                  <View style={mapStyles.metricCol}>
                    <Text style={mapStyles.metricLabel}>SPO2</Text>
                    <Text style={mapStyles.metricValue}>
                      {currentPacket.spo2 !== undefined ? `${currentPacket.spo2.toFixed(0)}%` : '--'}
                    </Text>
                  </View>
                  <View style={mapStyles.metricCol}>
                    <Text style={mapStyles.metricLabel}>HRV RMSSD</Text>
                    <Text style={mapStyles.metricValue}>
                      {(currentPacket.hrv || 45).toFixed(0)}{' '}
                      <Text style={mapStyles.unitText}>ms</Text>
                    </Text>
                  </View>
                </View>
              </View>

              {/* Real-time Environment */}
              <View style={mapStyles.sectionBox}>
                <Text style={mapStyles.sectionTitle}>🌤️ Live Environmental State</Text>
                <View style={mapStyles.metricRow}>
                  <View style={mapStyles.metricCol}>
                    <Text style={mapStyles.metricLabel}>TEMPERATURE</Text>
                    <Text style={mapStyles.metricValue}>
                      {(currentPacket.tempC || 24.0).toFixed(1)}°C
                    </Text>
                  </View>
                  <View style={mapStyles.metricCol}>
                    <Text style={mapStyles.metricLabel}>HUMIDITY</Text>
                    <Text style={mapStyles.metricValue}>
                      {(currentPacket.humidityPct || 50).toFixed(0)}%
                    </Text>
                  </View>
                  <View style={mapStyles.metricCol}>
                    <Text style={mapStyles.metricLabel}>PRESSURE</Text>
                    <Text style={mapStyles.metricValue}>
                      {(currentPacket.pressureHpa || 1013.2).toFixed(1)} hPa
                    </Text>
                  </View>
                  <View style={mapStyles.metricCol}>
                    <Text style={mapStyles.metricLabel}>HEAT INDEX</Text>
                    <Text style={mapStyles.metricValue}>
                      {(currentPacket.heatIndexF || 75).toFixed(0)}°F
                    </Text>
                  </View>
                </View>
              </View>

              {/* Real-time Motion & Activity */}
              <View style={mapStyles.sectionBox}>
                <Text style={mapStyles.sectionTitle}>🏃 Current Motion & Kinetic State</Text>
                <View style={mapStyles.activityRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={mapStyles.activityLabel}>
                      {(currentPacket.activityClass || 'standing').toUpperCase().replace(/_/g, ' ')}
                    </Text>
                    <Text style={mapStyles.activityMeta}>
                      Confidence: {Math.round((currentPacket.activityConfidence || 1.0) * 100)}% • Peak:{' '}
                      {currentPacket.peakAccel || 1000} mg
                    </Text>
                  </View>
                  <View style={[mapStyles.activityPill, { backgroundColor: 'rgba(59, 130, 246, 0.2)' }]}>
                    <Text style={[mapStyles.activityPillText, { color: '#60A5FA' }]}>
                      {wearConfidence > 40 ? 'Wrist Worn' : 'Off-Wrist'}
                    </Text>
                  </View>
                </View>
              </View>

              {/* Close Button */}
              <TouchableOpacity
                delayPressIn={0}
                onPress={() => setShowUserModal(false)}
                style={mapStyles.doneBtn}
              >
                <Text style={mapStyles.doneBtnText}>Close Telemetry</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const mapStyles = StyleSheet.create({
  cardContainer: {
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
    marginBottom: 12,
  },
  rowCenter: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  radarIcon: {
    fontSize: 16,
    marginRight: 6,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: 'bold',
    color: '#F8FAFC',
    letterSpacing: 0.3,
  },
  cardSubtitle: {
    fontSize: 11,
    color: '#94A3B8',
    marginTop: 2,
  },
  fullscreenBtn: {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    borderWidth: 1,
    borderColor: '#3B82F6',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  fullscreenBtnText: {
    color: '#60A5FA',
    fontSize: 11,
    fontWeight: 'bold',
  },
  gpsBanner: {
    backgroundColor: 'rgba(245, 158, 11, 0.15)',
    borderRadius: 8,
    padding: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(245, 158, 11, 0.3)',
  },
  gpsBannerText: {
    color: '#FBBF24',
    fontSize: 11,
    textAlign: 'center',
  },
  canvasWrapper: {
    borderRadius: 14,
    overflow: 'hidden',
    position: 'relative',
    alignSelf: 'center',
  },
  hudTopLeft: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.8)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  hudTopRight: {
    position: 'absolute',
    top: 8,
    right: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.8)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  hudBottomLeft: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.75)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  hudText: {
    color: '#CBD5E1',
    fontSize: 10,
    fontWeight: '700',
  },
  hudSubtext: {
    color: '#64748B',
    fontSize: 9,
  },
  zoomControlsRow: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    flexDirection: 'row',
    gap: 6,
  },
  zoomBtn: {
    width: 28,
    height: 28,
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#3B82F6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: '#0F172A',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.3)',
    width: '100%',
    maxHeight: '85%',
    padding: 20,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  modalNodeTag: {
    color: '#A78BFA',
    fontSize: 10,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  modalNodeTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: 'bold',
    marginTop: 2,
  },
  modalDistanceText: {
    color: '#94A3B8',
    fontSize: 12,
    marginTop: 4,
    marginBottom: 14,
  },
  closeBtn: {
    padding: 6,
  },
  closeBtnText: {
    color: '#94A3B8',
    fontSize: 18,
    fontWeight: 'bold',
  },
  renameBtn: {
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    borderWidth: 1,
    borderColor: '#3B82F6',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    marginBottom: 14,
  },
  renameBtnText: {
    color: '#60A5FA',
    fontSize: 12,
    fontWeight: 'bold',
  },
  sectionBox: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)',
  },
  sectionTitle: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: 'bold',
    marginBottom: 8,
    letterSpacing: 0.3,
  },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  metricCol: {
    flex: 1,
  },
  metricLabel: {
    color: '#64748B',
    fontSize: 9,
    fontWeight: 'bold',
  },
  metricValue: {
    color: '#F8FAFC',
    fontSize: 15,
    fontWeight: 'bold',
    marginTop: 2,
  },
  unitText: {
    fontSize: 10,
    color: '#64748B',
    fontWeight: 'normal',
  },
  activityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  activityLabel: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: 'bold',
  },
  activityMeta: {
    color: '#64748B',
    fontSize: 10,
    marginTop: 2,
  },
  activityPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(16, 185, 129, 0.15)',
  },
  activityPillText: {
    color: '#10B981',
    fontSize: 10,
    fontWeight: 'bold',
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.05)',
    marginBottom: 14,
  },
  statsText: {
    color: '#64748B',
    fontSize: 10,
  },
  doneBtn: {
    backgroundColor: '#3B82F6',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  doneBtnText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 'bold',
  },
});
