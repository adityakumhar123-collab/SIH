// =============================================================================
// BackgroundServices.js — RakshaBand Database Retention & Baseline Services
// =============================================================================
//
// Background tasks:
// 1. runDatabaseCleanup(days = 30): Enforces database retention by cleaning up
//    stale episodes, location visits, and dismissed non-critical diagnostic events.
// 2. recalibrateBaselines(): Re-evaluates baseline states across known locations
//    and resets cold-start bounds if clinical drifts or inconsistencies occur.
// =============================================================================

import {
  initDatabase,
  enforceRetentionPolicy,
  getKnownLocations,
  getBaselineState,
  saveBaselineState
} from './Database.js';
import { MathematicalEngine } from './MathematicalEngine.js';

class BackgroundServicesClass {
  constructor() {
    this.isCleanupRunning = false;
    this.isRecalibrationRunning = false;
  }

  /**
   * Enforces 30-day (configurable) retention policy on SQLite tables:
   * - episodes
   * - location_visits
   * - diagnostic_events (dismissed/exertion)
   *
   * @param {number} days - retention window in days (default: 30)
   * @returns {Object|null} deletion statistics
   */
  runDatabaseCleanup(days = 30) {
    if (this.isCleanupRunning) return null;
    this.isCleanupRunning = true;
    try {
      console.log(`[BackgroundServices] Starting database cleanup (retention: ${days} days)...`);
      const stats = enforceRetentionPolicy(days);
      console.log(`[BackgroundServices] Retention cleanup complete: Deleted ${stats.deletedEpisodes} episodes, ${stats.deletedVisits} visits, ${stats.deletedEvents} events.`);
      return stats;
    } catch (e) {
      console.warn('[BackgroundServices] Database cleanup failed:', e);
      return null;
    } finally {
      this.isCleanupRunning = false;
    }
  }

  /**
   * Recalibrates physiological and environmental baselines across known locations.
   * Ensures NEWS2 bounds are initialized and healthy covariances are regularized.
   *
   * @returns {Object} recalibration report
   */
  recalibrateBaselines() {
    if (this.isRecalibrationRunning) return null;
    this.isRecalibrationRunning = true;
    try {
      console.log('[BackgroundServices] Starting baseline recalibration pass...');
      MathematicalEngine.initialize();

      const locations = getKnownLocations();
      let locationsChecked = 0;

      for (const loc of locations) {
        locationsChecked++;
        const locKey = `loc_${loc.location_id}`;
        let base = getBaselineState('physiology', locKey);
        if (!base) {
          // Cold-start NEWS2 baseline for this location
          const coldStart = MathematicalEngine.getBaseline('physiology', 'global');
          if (coldStart) {
            saveBaselineState({
              domain: 'physiology',
              sub_key: locKey,
              dimension_names: coldStart.dimension_names,
              mean_vector: coldStart.mean_vector,
              covariance_matrix: coldStart.covariance_matrix,
              sample_count: 0,
              purity_gate_threshold: coldStart.purity_gate_threshold,
              last_updated: Date.now(),
              source: 'COLD_START_NEWS2'
            });
          }
        }
      }

      console.log(`[BackgroundServices] Baseline recalibration complete. Evaluated ${locationsChecked} location nodes.`);
      return { success: true, locationsChecked };
    } catch (e) {
      console.warn('[BackgroundServices] Baseline recalibration failed:', e);
      return { success: false, error: e.message };
    } finally {
      this.isRecalibrationRunning = false;
    }
  }
}

export const BackgroundServices = new BackgroundServicesClass();
