// =============================================================================
// MotionEngine.js — (Deprecated) Legacy SafeBand Motion Engine Stub
// =============================================================================
// Note: Superseded by EpisodeEngine.js and FeatureExtraction.js in RakshaBand.
// Kept as a compatibility shim for legacy tests or external runners.
// =============================================================================

import { EpisodeEngine } from './EpisodeEngine.js';

class MotionEngineStub {
  constructor() {
    this.buffer = [];
    this.clusterCache = [];
    this.currentClusterVersion = 1;
    this.lastProcessedSequenceId = -1;
  }

  initialize() {
    EpisodeEngine.initialize();
  }

  refreshCentroids() {
    // No-op in RakshaBand: Model v3 uses fixed 21-class centroids
  }

  onBLEPacket(packet) {
    if (packet && packet.rawMg) {
      EpisodeEngine.pushMotionSample([packet.ax, packet.ay, packet.az, packet.gx, packet.gy, packet.gz]);
    }
    return null;
  }

  buildObservation() {
    return null;
  }
}

export const MotionEngine = new MotionEngineStub();
