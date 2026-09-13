// =============================================================================
// LocationEngine.js — GPS Geofencing, Centroid Learning, and Place Baselines
// =============================================================================
//
// RakshaBand Location Engine:
// 1. Accuracy & HDOP Gating: Discards GPS fixes with horizontal error > 30m
// 2. Geofence Hysteresis: Entry radius (25m) < Exit radius (50m) prevents boundary flapping
// 3. Dwell Centroid Learning: Accumulates valid GPS samples during a stay;
//    when stay duration >= 5 minutes, computes the mathematical centroid
//    and registers a new known location node
// 4. Place-Specific Baselines: Records resting HR and environmental stats per location
// 5. Familiarity Assessment: Proximity and visit-weighted familiarity (0.0 to 1.0)
// =============================================================================

import {
  initDatabase,
  getKnownLocations,
  getKnownLocation,
  saveKnownLocation,
  saveLocationVisit,
  getActiveVisit
} from './Database.js';

class LocationEngineClass {
  constructor() {
    this.currentGps = null;
    this.lastUpdateTimestamp = 0;
    this.locationStatus = 'STALE';
    this.activeVisit = null;
    this.knownNodes = [];
    this.candidateDwell = null;

    // Parameters
    this.ENTRY_RADIUS = 25.0; // meters
    this.EXIT_RADIUS = 50.0;  // meters (hysteresis)
    this.CANDIDATE_RADIUS = 40.0; // meters wander tolerance
    this.MIN_STAY_DURATION = 5 * 60 * 1000; // 5 minutes in ms
    this.MAX_ALLOWED_ACCURACY = 30.0; // meters (accuracy gating)
  }

  initialize(minStayDurationMs = null) {
    if (minStayDurationMs !== null) {
      this.MIN_STAY_DURATION = minStayDurationMs;
    }
    this.currentGps = null;
    this.lastUpdateTimestamp = 0;
    this.locationStatus = 'STALE';
    this.candidateDwell = null;

    this.refreshNodes();
    this.restoreActiveVisit();
    console.log(`[LocationEngine] Initialized. Loaded ${this.knownNodes.length} known locations.`);
  }

  refreshNodes() {
    try {
      this.knownNodes = getKnownLocations() || [];
    } catch (e) {
      console.warn('[LocationEngine] Failed to load known locations:', e);
      this.knownNodes = [];
    }
  }

  restoreActiveVisit() {
    try {
      this.activeVisit = getActiveVisit();
      if (this.activeVisit) {
        console.log(`[LocationEngine] Restored active visit ID: ${this.activeVisit.visit_id} at Location ID: ${this.activeVisit.location_id}`);
      }
    } catch (e) {
      console.warn('[LocationEngine] Failed to restore active visit:', e);
      this.activeVisit = null;
    }
  }

  /**
   * Main GPS update handler called by background geolocation task or App.js.
   *
   * @param {Object} gpsUpdate - { latitude, longitude, accuracy, timestamp }
   * @param {Object} [vitalsContext] - { tempC, humidityPct, restingHr }
   */
  onLocationUpdate(gpsUpdate, vitalsContext = null) {
    if (!gpsUpdate || gpsUpdate.latitude === undefined || gpsUpdate.longitude === undefined) return;

    // 1. Accuracy Gating
    const accuracy = gpsUpdate.accuracy || 10.0;
    if (accuracy > this.MAX_ALLOWED_ACCURACY) {
      return; // Discard noisy reading
    }

    this.currentGps = {
      latitude: gpsUpdate.latitude,
      longitude: gpsUpdate.longitude,
      accuracy,
      timestamp: Date.now()
    };
    this.lastUpdateTimestamp = Date.now();
    this.locationStatus = 'OK';

    // 2. Geofence Matching with Hysteresis
    let matchedNode = null;
    let minDistance = Infinity;

    for (const node of this.knownNodes) {
      const dist = this.getHaversineDistance(
        gpsUpdate.latitude,
        gpsUpdate.longitude,
        node.center_latitude,
        node.center_longitude
      );

      const isCurrentlyInside = this.activeVisit && this.activeVisit.location_id === node.location_id;
      const threshold = isCurrentlyInside ? (node.exit_radius || this.EXIT_RADIUS) : (node.entry_radius || this.ENTRY_RADIUS);

      if (dist <= threshold && dist < minDistance) {
        minDistance = dist;
        matchedNode = node;
      }
    }

    // 3. Visit State Machine
    if (matchedNode) {
      this.candidateDwell = null; // Inside known node: reset candidate tracking

      if (!this.activeVisit) {
        this.startVisit(matchedNode.location_id);
      } else if (this.activeVisit.location_id !== matchedNode.location_id) {
        this.closeVisit(vitalsContext);
        this.startVisit(matchedNode.location_id);
      } else {
        this.updateVisitDuration();
      }
    } else {
      if (this.activeVisit) {
        this.closeVisit(vitalsContext);
      }
      this.trackCandidateDwell(gpsUpdate.latitude, gpsUpdate.longitude, vitalsContext);
    }
  }

  startVisit(locationId) {
    const visit = {
      location_id: locationId,
      enter_timestamp: Date.now(),
      entry_latitude: this.currentGps.latitude,
      entry_longitude: this.currentGps.longitude,
      entry_accuracy: this.currentGps.accuracy
    };

    try {
      const visitId = saveLocationVisit(visit);
      this.activeVisit = { ...visit, visit_id: visitId };
      console.log(`[LocationEngine] Started visit ID ${visitId} at Location ID ${locationId}`);
    } catch (e) {
      console.warn('[LocationEngine] Failed to start visit:', e);
    }
  }

  updateVisitDuration() {
    if (!this.activeVisit) return;
    const elapsedMinutes = (Date.now() - this.activeVisit.enter_timestamp) / 60000.0;
    this.activeVisit.duration_minutes = Number(elapsedMinutes.toFixed(1));
  }

  closeVisit(vitalsContext = null) {
    if (!this.activeVisit) return;

    const durationMinutes = (Date.now() - this.activeVisit.enter_timestamp) / 60000.0;
    this.activeVisit.exit_timestamp = Date.now();
    this.activeVisit.duration_minutes = Number(durationMinutes.toFixed(1));
    this.activeVisit.exit_latitude = this.currentGps ? this.currentGps.latitude : null;
    this.activeVisit.exit_longitude = this.currentGps ? this.currentGps.longitude : null;
    this.activeVisit.exit_accuracy = this.currentGps ? this.currentGps.accuracy : null;

    try {
      saveLocationVisit(this.activeVisit);

      // Update known location stay statistics and baselines
      const node = getKnownLocation(this.activeVisit.location_id);
      if (node) {
        const updatedDwell = (node.dwell_count || 0) + 1;
        const updatedStay = (node.total_stay_minutes || 0.0) + durationMinutes;

        let baselineTemp = node.baseline_temp_mean;
        let baselineHum = node.baseline_humidity_mean;
        let baselineHr = node.baseline_resting_hr;

        if (vitalsContext) {
          if (vitalsContext.tempC) {
            baselineTemp = baselineTemp ? 0.9 * baselineTemp + 0.1 * vitalsContext.tempC : vitalsContext.tempC;
          }
          if (vitalsContext.humidityPct) {
            baselineHum = baselineHum ? 0.9 * baselineHum + 0.1 * vitalsContext.humidityPct : vitalsContext.humidityPct;
          }
          if (vitalsContext.restingHr) {
            baselineHr = baselineHr ? 0.9 * baselineHr + 0.1 * vitalsContext.restingHr : vitalsContext.restingHr;
          }
        }

        saveKnownLocation({
          ...node,
          dwell_count: updatedDwell,
          total_stay_minutes: Number(updatedStay.toFixed(1)),
          baseline_temp_mean: baselineTemp ? Number(baselineTemp.toFixed(1)) : null,
          baseline_humidity_mean: baselineHum ? Number(baselineHum.toFixed(1)) : null,
          baseline_resting_hr: baselineHr ? Number(baselineHr.toFixed(1)) : null
        });
      }

      console.log(`[LocationEngine] Closed visit ID ${this.activeVisit.visit_id} (Duration: ${this.activeVisit.duration_minutes} min)`);
    } catch (e) {
      console.warn('[LocationEngine] Failed to close visit:', e);
    }

    this.activeVisit = null;
    this.refreshNodes();
  }

  /**
   * Tracks dwelling at an unknown location. Accumulates valid GPS readings
   * to calculate an exact centroid once the stay threshold is reached.
   */
  trackCandidateDwell(latitude, longitude, vitalsContext = null) {
    const now = Date.now();

    if (!this.candidateDwell) {
      this.candidateDwell = {
        firstSeen: now,
        lastSeen: now,
        samples: [{ lat: latitude, lon: longitude }]
      };
      return;
    }

    // Distance from the initial candidate position
    const distFromStart = this.getHaversineDistance(
      latitude,
      longitude,
      this.candidateDwell.samples[0].lat,
      this.candidateDwell.samples[0].lon
    );

    if (distFromStart > this.CANDIDATE_RADIUS) {
      // User moved outside candidate wander radius: reset candidate
      this.candidateDwell = {
        firstSeen: now,
        lastSeen: now,
        samples: [{ lat: latitude, lon: longitude }]
      };
      return;
    }

    // Still in candidate area: accumulate sample
    this.candidateDwell.samples.push({ lat: latitude, lon: longitude });
    this.candidateDwell.lastSeen = now;

    const elapsed = now - this.candidateDwell.firstSeen;
    if (elapsed >= this.MIN_STAY_DURATION) {
      // Dwell threshold reached: compute centroid of all collected samples
      const samples = this.candidateDwell.samples;
      let sumLat = 0.0;
      let sumLon = 0.0;
      for (const s of samples) {
        sumLat += s.lat;
        sumLon += s.lon;
      }
      const centroidLat = sumLat / samples.length;
      const centroidLon = sumLon / samples.length;

      const nodeCount = this.knownNodes.length + 1;
      const newNode = {
        name: `Location #${nodeCount}`,
        center_latitude: centroidLat,
        center_longitude: centroidLon,
        entry_radius: this.ENTRY_RADIUS,
        exit_radius: this.EXIT_RADIUS,
        dwell_count: 1,
        total_stay_minutes: Number((elapsed / 60000.0).toFixed(1)),
        baseline_temp_mean: vitalsContext?.tempC ?? null,
        baseline_humidity_mean: vitalsContext?.humidityPct ?? null,
        baseline_resting_hr: vitalsContext?.restingHr ?? null
      };

      try {
        const newId = saveKnownLocation(newNode);
        console.log(`[LocationEngine] Registered new Known Location ID ${newId} at (${centroidLat.toFixed(5)}, ${centroidLon.toFixed(5)})`);
        this.candidateDwell = null;
        this.refreshNodes();
        this.startVisit(newId);
      } catch (e) {
        console.warn('[LocationEngine] Failed to save candidate as new node:', e);
      }
    }
  }

  /**
   * Estimates location familiarity score (0.0 to 1.0).
   * Returns 1.0 if inside a well-visited node; scales with proximity and visit frequency.
   */
  estimateFamiliarity(latitude, longitude) {
    if (!latitude || !longitude || this.knownNodes.length === 0) {
      return 0.5; // Neutral default
    }

    let maxFamiliarity = 0.0;
    for (const node of this.knownNodes) {
      const dist = this.getHaversineDistance(
        latitude,
        longitude,
        node.center_latitude,
        node.center_longitude
      );

      const visits = Math.min(20, node.dwell_count || 1);
      const visitWeight = visits / 20.0; // Scales up to 1.0 at 20 visits

      if (dist <= (node.entry_radius || this.ENTRY_RADIUS)) {
        return Math.min(1.0, 0.8 + 0.2 * visitWeight);
      } else if (dist <= (node.exit_radius || this.EXIT_RADIUS) * 3.0) {
        // Linear decay with distance outside node
        const maxDist = (node.exit_radius || this.EXIT_RADIUS) * 3.0;
        const decay = 1.0 - (dist / maxDist);
        const nodeFam = decay * visitWeight;
        if (nodeFam > maxFamiliarity) maxFamiliarity = nodeFam;
      }
    }

    return Number(maxFamiliarity.toFixed(3));
  }

  getHaversineDistance(lat1, lon1, lat2, lon2) {
    const toRad = (x) => (x * Math.PI) / 180.0;
    const R = 6371000.0; // Earth radius in meters
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2.0) * Math.sin(dLat / 2.0) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2.0) * Math.sin(dLon / 2.0);
    const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
    return R * c;
  }
}

export const LocationEngine = new LocationEngineClass();
