// =============================================================================
// Database.js — RakshaBand SQLite Data Layer
// =============================================================================
//
// Dual-environment SQLite storage:
// - In Expo/React Native: uses expo-sqlite openDatabaseSync('rakshaband.db')
// - In Node.js CLI/tests: uses node:sqlite DatabaseSync(':memory:' or custom)
//
// Normalized 10-Table Schema:
// 1. settings              — Configuration, credentials, clinical thresholds
// 2. emergency_contacts    — Priority contacts, SMS/WhatsApp/Email preferences
// 3. templates             — Notification message templates with {tokens}
// 4. known_locations       — Learned spatial nodes with location-specific baselines
// 5. location_visits       — Entry/exit tracking with accuracy gating
// 6. episodes              — Segmented behavioral & multi-sensor continuity
// 7. baseline_states       — Multi-domain Gaussian baselines (mean + covariance)
// 8. diagnostic_events     — Diagnostic Reasoning Engine outputs & explanations
// 9. user_feedback         — Confirm/dismiss audit log for location prior tuning
// 10. emergency_escalations— Multi-channel dispatch audit log with duress tracking
// =============================================================================

let db = null;
let isDbInitialized = false;

// Dynamic environment loader: Expo SQLite or Node.js sqlite
export function getDb() {
  if (db) return db;

  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

  if (isNode) {
    const requireFunc = Function('return require')();
    const { DatabaseSync } = requireFunc('node:sqlite');
    const dbName = process.env.RAKSHABAND_TEST_DB || process.env.SAFEBAND_TEST_DB || 'rakshaband.db';
    const nodeDb = new DatabaseSync(dbName);

    db = {
      execSync: (sql) => nodeDb.exec(sql),
      runSync: (sql, params = []) => {
        const stmt = nodeDb.prepare(sql);
        const res = stmt.run(...params);
        return {
          changes: res.changes,
          lastInsertRowId: res.lastInsertRowid
        };
      },
      getFirstSync: (sql, params = []) => {
        const stmt = nodeDb.prepare(sql);
        return stmt.get(...params);
      },
      getAllSync: (sql, params = []) => {
        const stmt = nodeDb.prepare(sql);
        return stmt.all(...params);
      },
      runAsync: async (sql, params = []) => {
        const stmt = nodeDb.prepare(sql);
        const res = stmt.run(...params);
        return {
          changes: res.changes,
          lastInsertRowId: res.lastInsertRowid
        };
      }
    };
  } else {
    const SQLite = require('expo-sqlite');
    db = SQLite.openDatabaseSync('rakshaband.db');
  }
  return db;
}

export function initDatabase() {
  const database = getDb();
  if (isDbInitialized) return database;

  try {
    // Purge obsolete SafeBand tables if migrating from previous builds
    database.execSync(`
      DROP TABLE IF EXISTS observations;
      DROP TABLE IF EXISTS motion_clusters;
      DROP TABLE IF EXISTS episode_motion_timelines;
      DROP TABLE IF EXISTS inference_logs;
      DROP TABLE IF EXISTS location_nodes;
    `);

    // 1. settings
    database.execSync(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. emergency_contacts
    database.execSync(`
      CREATE TABLE IF NOT EXISTS emergency_contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        whatsapp TEXT,
        priority_order INTEGER DEFAULT 1,
        sms_enabled INTEGER DEFAULT 1,
        whatsapp_enabled INTEGER DEFAULT 1,
        whatsapp_method TEXT DEFAULT 'TWILIO',
        callmebot_key TEXT,
        email_enabled INTEGER DEFAULT 1,
        template_id INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 3. templates
    database.execSync(`
      CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 4. known_locations
    database.execSync(`
      CREATE TABLE IF NOT EXISTS known_locations (
        location_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        center_latitude REAL NOT NULL,
        center_longitude REAL NOT NULL,
        entry_radius REAL DEFAULT 25.0,
        exit_radius REAL DEFAULT 50.0,
        dwell_count INTEGER DEFAULT 1,
        total_stay_minutes REAL DEFAULT 0.0,
        first_visited_at TIMESTAMP NOT NULL,
        last_visited_at TIMESTAMP NOT NULL,
        baseline_temp_mean REAL,
        baseline_humidity_mean REAL,
        baseline_heat_index_mean REAL,
        baseline_resting_hr REAL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_known_locs_coords ON known_locations(center_latitude, center_longitude);
    `);

    // 5. location_visits
    database.execSync(`
      CREATE TABLE IF NOT EXISTS location_visits (
        visit_id INTEGER PRIMARY KEY AUTOINCREMENT,
        location_id INTEGER NOT NULL,
        enter_timestamp INTEGER NOT NULL,
        exit_timestamp INTEGER,
        duration_minutes REAL,
        entry_latitude REAL NOT NULL,
        entry_longitude REAL NOT NULL,
        entry_accuracy REAL,
        exit_latitude REAL,
        exit_longitude REAL,
        exit_accuracy REAL,
        FOREIGN KEY(location_id) REFERENCES known_locations(location_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_loc_visits_active ON location_visits(location_id, exit_timestamp);
    `);

    // 6. episodes
    database.execSync(`
      CREATE TABLE IF NOT EXISTS episodes (
        episode_id INTEGER PRIMARY KEY AUTOINCREMENT,
        start_timestamp INTEGER NOT NULL,
        end_timestamp INTEGER,
        duration_seconds REAL DEFAULT 0.0,
        activity_class TEXT NOT NULL,
        activity_confidence REAL DEFAULT 1.0,
        location_id INTEGER,
        hr_mean REAL,
        hr_min REAL,
        hr_max REAL,
        hr_variance REAL,
        hrv_rmssd REAL,
        spo2_mean REAL,
        spo2_min REAL,
        spo2_max REAL,
        spo2_variance REAL,
        temperature_mean REAL,
        humidity_mean REAL,
        pressure_mean REAL,
        heat_index_mean REAL,
        heat_index_max REAL,
        accel_rms_mean REAL,
        gyro_rms_mean REAL,
        jerk_mean REAL,
        sma_mean REAL,
        FOREIGN KEY(location_id) REFERENCES known_locations(location_id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_episodes_time ON episodes(start_timestamp, end_timestamp);
      CREATE INDEX IF NOT EXISTS idx_episodes_activity ON episodes(activity_class);
    `);

    // 7. baseline_states
    database.execSync(`
      CREATE TABLE IF NOT EXISTS baseline_states (
        domain TEXT NOT NULL,
        sub_key TEXT NOT NULL DEFAULT 'global',
        dimension_names TEXT NOT NULL,
        mean_vector TEXT NOT NULL,
        covariance_matrix TEXT NOT NULL,
        sample_count INTEGER DEFAULT 0,
        purity_gate_threshold REAL DEFAULT 2.5,
        last_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        source TEXT DEFAULT 'COLD_START_NEWS2',
        PRIMARY KEY (domain, sub_key)
      );
    `);

    // 8. diagnostic_events
    database.execSync(`
      CREATE TABLE IF NOT EXISTS diagnostic_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        episode_id INTEGER,
        location_id INTEGER,
        domain TEXT NOT NULL,
        primary_hypothesis TEXT NOT NULL,
        confidence REAL NOT NULL,
        severity_tier TEXT NOT NULL,
        suggested_action_category TEXT NOT NULL,
        contributing_evidence TEXT NOT NULL,
        decomposed_zscores TEXT NOT NULL,
        mahalanobis_distances TEXT NOT NULL,
        gemma_message TEXT,
        user_status TEXT DEFAULT 'UNREVIEWED',
        escalation_status TEXT DEFAULT 'NONE',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(episode_id) REFERENCES episodes(episode_id) ON DELETE SET NULL,
        FOREIGN KEY(location_id) REFERENCES known_locations(location_id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_diag_events_time ON diagnostic_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_diag_events_hypo ON diagnostic_events(primary_hypothesis);
    `);

    // 9. user_feedback
    database.execSync(`
      CREATE TABLE IF NOT EXISTS user_feedback (
        feedback_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL,
        location_id INTEGER,
        user_action TEXT NOT NULL,
        notes TEXT,
        prior_adjustment_applied INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(event_id) REFERENCES diagnostic_events(event_id) ON DELETE CASCADE,
        FOREIGN KEY(location_id) REFERENCES known_locations(location_id) ON DELETE SET NULL
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_loc_event ON user_feedback(location_id, event_id);
    `);

    // 10. emergency_escalations
    database.execSync(`
      CREATE TABLE IF NOT EXISTS emergency_escalations (
        escalation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER,
        trigger_type TEXT NOT NULL,
        contact_id INTEGER NOT NULL,
        channel TEXT NOT NULL,
        message_body TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        address TEXT,
        dispatch_status TEXT NOT NULL,
        is_duress INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(event_id) REFERENCES diagnostic_events(event_id) ON DELETE SET NULL,
        FOREIGN KEY(contact_id) REFERENCES emergency_contacts(id) ON DELETE CASCADE
      );
    `);

    // Default Settings Seeds
    const defaultSettings = [
      { key: 'user_name', value: 'Raksha User' },
      { key: 'user_age', value: '30' },
      { key: 'medical_blood_group', value: 'O+' },
      { key: 'medical_conditions', value: 'None' },
      { key: 'medical_allergies', value: 'None' },
      { key: 'medical_instructions', value: 'Contact family immediately upon alert' },
      { key: 'emergency_delay_sec', value: '15' },
      { key: 'real_pin', value: '1234' },
      { key: 'fake_pin', value: '9999' },
      { key: 'twilio_sid', value: '' },
      { key: 'twilio_token', value: '' },
      { key: 'twilio_from_phone', value: '' },
      { key: 'twilio_whatsapp_from', value: '' },
      { key: 'resend_api_key', value: '' },
      { key: 'resend_from_email', value: '' },
      { key: 'local_ai_enabled', value: '1' },
      { key: 'local_gemma_model_path', value: 'assets/models/gemma_3n_int4.bin' },
      { key: 'silent_beacon', value: '0' }
    ];

    for (const s of defaultSettings) {
      database.runSync(
        'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?);',
        [s.key, s.value]
      );
    }

    // Default Template Seed
    const defaultTemplate = database.getFirstSync('SELECT id FROM templates LIMIT 1;');
    if (!defaultTemplate) {
      database.runSync(
        `INSERT INTO templates (name, content) VALUES (?, ?);`,
        [
          'Default Raksha Alert',
          '{duress_flag}EMERGENCY ALERT: {name} may require assistance.\nCondition: {hypothesis} ({severity})\nEvidence: {evidence}\nVitals: {vitals_summary}\nLocation: {location_name}\nGPS: {gps}\nMaps: {maps_link}\nAddress: {address}\nMedical Info: {medical_info}'
        ]
      );
    }

    isDbInitialized = true;
    console.log('[DB] RakshaBand SQLite database initialized successfully.');
  } catch (err) {
    console.error('[DB] Database initialization failed:', err);
    throw err;
  }
  return database;
}

// ─── Settings API ────────────────────────────────────────────────────────────

export function getSettings() {
  const database = initDatabase();
  const rows = database.getAllSync('SELECT key, value FROM settings;');
  const settingsObj = {};
  for (const row of rows) {
    settingsObj[row.key] = row.value;
  }
  return settingsObj;
}

export function getSetting(key, defaultValue = null) {
  const database = initDatabase();
  const row = database.getFirstSync('SELECT value FROM settings WHERE key = ?;', [key]);
  return row ? row.value : defaultValue;
}

export function saveSetting(key, value) {
  const database = initDatabase();
  database.runSync(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP;',
    [key, String(value)]
  );
}

// ─── Emergency Contacts API ──────────────────────────────────────────────────

export function getContacts() {
  const database = initDatabase();
  return database.getAllSync('SELECT * FROM emergency_contacts ORDER BY priority_order ASC, id ASC;');
}

export function saveContact(contact) {
  const database = initDatabase();
  if (contact.id) {
    database.runSync(
      `UPDATE emergency_contacts SET
        name = ?, phone = ?, email = ?, whatsapp = ?, priority_order = ?,
        sms_enabled = ?, whatsapp_enabled = ?, whatsapp_method = ?, callmebot_key = ?,
        email_enabled = ?, template_id = ?
       WHERE id = ?;`,
      [
        contact.name,
        contact.phone || '',
        contact.email || '',
        contact.whatsapp || '',
        contact.priority_order || 1,
        contact.sms_enabled ? 1 : 0,
        contact.whatsapp_enabled ? 1 : 0,
        contact.whatsapp_method || 'TWILIO',
        contact.callmebot_key || '',
        contact.email_enabled ? 1 : 0,
        contact.template_id || 0,
        contact.id
      ]
    );
    return contact.id;
  } else {
    const res = database.runSync(
      `INSERT INTO emergency_contacts (
        name, phone, email, whatsapp, priority_order,
        sms_enabled, whatsapp_enabled, whatsapp_method, callmebot_key,
        email_enabled, template_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        contact.name,
        contact.phone || '',
        contact.email || '',
        contact.whatsapp || '',
        contact.priority_order || 1,
        contact.sms_enabled ? 1 : 0,
        contact.whatsapp_enabled ? 1 : 0,
        contact.whatsapp_method || 'TWILIO',
        contact.callmebot_key || '',
        contact.email_enabled ? 1 : 0,
        contact.template_id || 0
      ]
    );
    return res.lastInsertRowId;
  }
}

export function deleteContact(id) {
  const database = initDatabase();
  database.runSync('DELETE FROM emergency_contacts WHERE id = ?;', [id]);
}

// ─── Templates API ───────────────────────────────────────────────────────────

export function getTemplates() {
  const database = initDatabase();
  return database.getAllSync('SELECT * FROM templates ORDER BY id ASC;');
}

export function saveTemplate(template) {
  const database = initDatabase();
  if (template.id) {
    database.runSync(
      'UPDATE templates SET name = ?, content = ? WHERE id = ?;',
      [template.name, template.content, template.id]
    );
    return template.id;
  } else {
    const res = database.runSync(
      'INSERT INTO templates (name, content) VALUES (?, ?);',
      [template.name, template.content]
    );
    return res.lastInsertRowId;
  }
}

export function deleteTemplate(id) {
  const database = initDatabase();
  database.runSync('DELETE FROM templates WHERE id = ?;', [id]);
}

// ─── Known Locations & Visits API ────────────────────────────────────────────

export function getKnownLocations() {
  const database = initDatabase();
  return database.getAllSync('SELECT * FROM known_locations ORDER BY dwell_count DESC, location_id DESC;');
}

export function getKnownLocation(id) {
  const database = initDatabase();
  return database.getFirstSync('SELECT * FROM known_locations WHERE location_id = ?;', [id]);
}

export function saveKnownLocation(node) {
  const database = initDatabase();
  // Cleanly store null if name is unset, 'null', or whitespace
  const rawName = node.name !== undefined ? node.name : node.label;
  const name = (rawName && rawName !== 'null' && rawName !== 'undefined' && String(rawName).trim() !== '')
    ? String(rawName).trim()
    : null;
  const lat = node.center_latitude !== undefined ? node.center_latitude : node.latitude;
  const lon = node.center_longitude !== undefined ? node.center_longitude : node.longitude;
  const entryRadius = node.entry_radius || node.radius_meters || 25.0;
  const exitRadius = node.exit_radius || (node.radius_meters ? node.radius_meters * 1.5 : 50.0);

  if (node.location_id) {
    database.runSync(
      `UPDATE known_locations SET
        name = ?, center_latitude = ?, center_longitude = ?, entry_radius = ?, exit_radius = ?,
        dwell_count = ?, total_stay_minutes = ?, last_visited_at = CURRENT_TIMESTAMP,
        baseline_temp_mean = ?, baseline_humidity_mean = ?, baseline_heat_index_mean = ?, baseline_resting_hr = ?
       WHERE location_id = ?;`,
      [
        name,
        lat,
        lon,
        entryRadius,
        exitRadius,
        node.dwell_count || 1,
        node.total_stay_minutes || 0.0,
        node.baseline_temp_mean ?? null,
        node.baseline_humidity_mean ?? null,
        node.baseline_heat_index_mean ?? null,
        node.baseline_resting_hr ?? null,
        node.location_id
      ]
    );
    return node.location_id;
  } else {
    const res = database.runSync(
      `INSERT INTO known_locations (
        name, center_latitude, center_longitude, entry_radius, exit_radius,
        dwell_count, total_stay_minutes, first_visited_at, last_visited_at,
        baseline_temp_mean, baseline_humidity_mean, baseline_heat_index_mean, baseline_resting_hr
      ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?, ?, ?);`,
      [
        name,
        lat,
        lon,
        entryRadius,
        exitRadius,
        node.dwell_count || 1,
        node.total_stay_minutes || 0.0,
        node.baseline_temp_mean ?? null,
        node.baseline_humidity_mean ?? null,
        node.baseline_heat_index_mean ?? null,
        node.baseline_resting_hr ?? null
      ]
    );
    return res.lastInsertRowId;
  }
}

export function updateLocationName(locationId, name) {
  const database = initDatabase();
  const cleanName = (name && name !== 'null' && name !== 'undefined' && String(name).trim() !== '')
    ? String(name).trim()
    : null;
  database.runSync('UPDATE known_locations SET name = ? WHERE location_id = ?;', [cleanName, locationId]);
}

/**
 * Returns a user-friendly display name for a location node, guaranteeing
 * that literal 'null', 'Location null', or blank names are never shown.
 *
 * @param {Object|string} nodeOrName
 * @param {number|string} [fallbackId]
 * @returns {string} Clean label, e.g. "Home", "Office", or "Zone #2"
 */
export function getCleanLocationName(nodeOrName, fallbackId = null) {
  if (!nodeOrName) {
    return fallbackId ? `Zone #${fallbackId}` : 'Zone';
  }
  if (typeof nodeOrName === 'object') {
    const raw = nodeOrName.name;
    const id = nodeOrName.location_id || nodeOrName.id || fallbackId;
    if (raw && raw !== 'null' && raw !== 'undefined' && String(raw).trim() !== '') {
      return String(raw).trim();
    }
    return id ? `Zone #${id}` : 'Zone';
  }
  const str = String(nodeOrName).trim();
  if (str === 'null' || str === 'undefined' || str === '') {
    return fallbackId ? `Zone #${fallbackId}` : 'Zone';
  }
  return str;
}

/**
 * Queries the last stored historical telemetry recorded at a specific location node:
 * - Environment (temperature, humidity, pressure, heat index)
 * - Motion state / activity classification
 * - Physiological condition (resting HR, SpO2, HRV)
 *
 * @param {number} locationId
 * @returns {Object|null} { node, lastEpisode, lastVisit }
 */
export function getLocationHistoricalData(locationId) {
  const database = initDatabase();
  const node = database.getFirstSync('SELECT * FROM known_locations WHERE location_id = ?;', [locationId]);
  if (!node) return null;

  const lastEpisode = database.getFirstSync(
    'SELECT * FROM episodes WHERE location_id = ? ORDER BY start_timestamp DESC LIMIT 1;',
    [locationId]
  );

  const lastVisit = database.getFirstSync(
    'SELECT * FROM location_visits WHERE location_id = ? ORDER BY enter_timestamp DESC LIMIT 1;',
    [locationId]
  );

  return {
    node,
    lastEpisode: lastEpisode || null,
    lastVisit: lastVisit || null
  };
}

export function saveLocationVisit(visit) {
  const database = initDatabase();
  if (visit.visit_id) {
    database.runSync(
      `UPDATE location_visits SET
        exit_timestamp = ?, duration_minutes = ?, exit_latitude = ?, exit_longitude = ?, exit_accuracy = ?
       WHERE visit_id = ?;`,
      [
        visit.exit_timestamp,
        visit.duration_minutes,
        visit.exit_latitude,
        visit.exit_longitude,
        visit.exit_accuracy,
        visit.visit_id
      ]
    );
    return visit.visit_id;
  } else {
    const res = database.runSync(
      `INSERT INTO location_visits (
        location_id, enter_timestamp, exit_timestamp, duration_minutes,
        entry_latitude, entry_longitude, entry_accuracy
      ) VALUES (?, ?, NULL, 0, ?, ?, ?);`,
      [
        visit.location_id,
        visit.enter_timestamp || Date.now(),
        visit.entry_latitude,
        visit.entry_longitude,
        visit.entry_accuracy || null
      ]
    );
    return res.lastInsertRowId;
  }
}

export function getActiveVisit() {
  const database = initDatabase();
  return database.getFirstSync('SELECT * FROM location_visits WHERE exit_timestamp IS NULL ORDER BY visit_id DESC LIMIT 1;');
}

export function getRecentVisits(limit = 20) {
  const database = initDatabase();
  return database.getAllSync(
    `SELECT v.*, l.name as location_name
     FROM location_visits v
     JOIN known_locations l ON v.location_id = l.location_id
     ORDER BY v.enter_timestamp DESC LIMIT ?;`,
    [limit]
  );
}

// ─── Episodes API ────────────────────────────────────────────────────────────

export function saveEpisode(ep) {
  const database = initDatabase();
  if (ep.episode_id) {
    database.runSync(
      `UPDATE episodes SET
        end_timestamp = ?, duration_seconds = ?, activity_class = ?, activity_confidence = ?, location_id = ?,
        hr_mean = ?, hr_min = ?, hr_max = ?, hr_variance = ?, hrv_rmssd = ?,
        spo2_mean = ?, spo2_min = ?, spo2_max = ?, spo2_variance = ?,
        temperature_mean = ?, humidity_mean = ?, pressure_mean = ?, heat_index_mean = ?, heat_index_max = ?,
        accel_rms_mean = ?, gyro_rms_mean = ?, jerk_mean = ?, sma_mean = ?
       WHERE episode_id = ?;`,
      [
        ep.end_timestamp ?? null,
        ep.duration_seconds || 0.0,
        ep.activity_class,
        ep.activity_confidence ?? 1.0,
        ep.location_id ?? null,
        ep.hr_mean ?? null,
        ep.hr_min ?? null,
        ep.hr_max ?? null,
        ep.hr_variance ?? null,
        ep.hrv_rmssd ?? null,
        ep.spo2_mean ?? null,
        ep.spo2_min ?? null,
        ep.spo2_max ?? null,
        ep.spo2_variance ?? null,
        ep.temperature_mean ?? null,
        ep.humidity_mean ?? null,
        ep.pressure_mean ?? null,
        ep.heat_index_mean ?? null,
        ep.heat_index_max ?? null,
        ep.accel_rms_mean ?? null,
        ep.gyro_rms_mean ?? null,
        ep.jerk_mean ?? null,
        ep.sma_mean ?? null,
        ep.episode_id
      ]
    );
    return ep.episode_id;
  } else {
    const res = database.runSync(
      `INSERT INTO episodes (
        start_timestamp, end_timestamp, duration_seconds, activity_class, activity_confidence, location_id,
        hr_mean, hr_min, hr_max, hr_variance, hrv_rmssd,
        spo2_mean, spo2_min, spo2_max, spo2_variance,
        temperature_mean, humidity_mean, pressure_mean, heat_index_mean, heat_index_max,
        accel_rms_mean, gyro_rms_mean, jerk_mean, sma_mean
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        ep.start_timestamp || Date.now(),
        ep.end_timestamp ?? null,
        ep.duration_seconds || 0.0,
        ep.activity_class,
        ep.activity_confidence ?? 1.0,
        ep.location_id ?? null,
        ep.hr_mean ?? null,
        ep.hr_min ?? null,
        ep.hr_max ?? null,
        ep.hr_variance ?? null,
        ep.hrv_rmssd ?? null,
        ep.spo2_mean ?? null,
        ep.spo2_min ?? null,
        ep.spo2_max ?? null,
        ep.spo2_variance ?? null,
        ep.temperature_mean ?? null,
        ep.humidity_mean ?? null,
        ep.pressure_mean ?? null,
        ep.heat_index_mean ?? null,
        ep.heat_index_max ?? null,
        ep.accel_rms_mean ?? null,
        ep.gyro_rms_mean ?? null,
        ep.jerk_mean ?? null,
        ep.sma_mean ?? null
      ]
    );
    return res.lastInsertRowId;
  }
}

export function getEpisode(id) {
  const database = initDatabase();
  return database.getFirstSync('SELECT * FROM episodes WHERE episode_id = ?;', [id]);
}

export function getActiveEpisode() {
  const database = initDatabase();
  return database.getFirstSync('SELECT * FROM episodes WHERE end_timestamp IS NULL ORDER BY episode_id DESC LIMIT 1;');
}

export function closeActiveEpisode(endTimestamp = Date.now()) {
  const database = initDatabase();
  const openEp = getActiveEpisode();
  if (openEp) {
    const duration = Math.max(0, (endTimestamp - openEp.start_timestamp) / 1000.0);
    database.runSync(
      'UPDATE episodes SET end_timestamp = ?, duration_seconds = ? WHERE episode_id = ?;',
      [endTimestamp, duration, openEp.episode_id]
    );
    return openEp.episode_id;
  }
  return null;
}

export function getRecentEpisodes(limit = 20) {
  const database = initDatabase();
  return database.getAllSync('SELECT * FROM episodes ORDER BY start_timestamp DESC LIMIT ?;', [limit]);
}

// ─── Baseline States API ─────────────────────────────────────────────────────

export function getBaselineState(domain, subKey = 'global') {
  const database = initDatabase();
  const row = database.getFirstSync(
    'SELECT * FROM baseline_states WHERE domain = ? AND sub_key = ?;',
    [domain, subKey]
  );
  if (!row) return null;
  return {
    ...row,
    dimension_names: JSON.parse(row.dimension_names || '[]'),
    mean_vector: JSON.parse(row.mean_vector || '[]'),
    covariance_matrix: JSON.parse(row.covariance_matrix || '[]')
  };
}

export function saveBaselineState(baseline) {
  const database = initDatabase();
  database.runSync(
    `INSERT INTO baseline_states (
      domain, sub_key, dimension_names, mean_vector, covariance_matrix,
      sample_count, purity_gate_threshold, last_updated_at, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(domain, sub_key) DO UPDATE SET
      dimension_names = excluded.dimension_names,
      mean_vector = excluded.mean_vector,
      covariance_matrix = excluded.covariance_matrix,
      sample_count = excluded.sample_count,
      purity_gate_threshold = excluded.purity_gate_threshold,
      last_updated_at = CURRENT_TIMESTAMP,
      source = excluded.source;`,
    [
      baseline.domain,
      baseline.sub_key || 'global',
      JSON.stringify(baseline.dimension_names || []),
      JSON.stringify(baseline.mean_vector || []),
      JSON.stringify(baseline.covariance_matrix || []),
      baseline.sample_count || 0,
      baseline.purity_gate_threshold || 2.5,
      baseline.source || 'PERSONALIZED_EWMA'
    ]
  );
}

// ─── Diagnostic Events API ───────────────────────────────────────────────────

export function storeDiagnosticEvent(event) {
  const database = initDatabase();
  const res = database.runSync(
    `INSERT INTO diagnostic_events (
      timestamp, episode_id, location_id, domain, primary_hypothesis, confidence,
      severity_tier, suggested_action_category, contributing_evidence, decomposed_zscores,
      mahalanobis_distances, gemma_message, user_status, escalation_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      event.timestamp || Date.now(),
      event.episode_id ?? null,
      event.location_id ?? null,
      event.domain || 'composite',
      event.primary_hypothesis,
      event.confidence,
      event.severity_tier || 'informational',
      event.suggested_action_category || 'rest',
      JSON.stringify(event.contributing_evidence || []),
      JSON.stringify(event.decomposed_zscores || {}),
      JSON.stringify(event.mahalanobis_distances || {}),
      event.gemma_message || '',
      event.user_status || 'UNREVIEWED',
      event.escalation_status || 'NONE'
    ]
  );
  return res.lastInsertRowId;
}

export function getDiagnosticEvent(id) {
  const database = initDatabase();
  const row = database.getFirstSync('SELECT * FROM diagnostic_events WHERE event_id = ?;', [id]);
  if (!row) return null;
  return {
    ...row,
    contributing_evidence: JSON.parse(row.contributing_evidence || '[]'),
    decomposed_zscores: JSON.parse(row.decomposed_zscores || '{}'),
    mahalanobis_distances: JSON.parse(row.mahalanobis_distances || '{}')
  };
}

export function getRecentDiagnosticEvents(limit = 20) {
  const database = initDatabase();
  const rows = database.getAllSync('SELECT * FROM diagnostic_events ORDER BY timestamp DESC LIMIT ?;', [limit]);
  return rows.map(r => ({
    ...r,
    contributing_evidence: JSON.parse(r.contributing_evidence || '[]'),
    decomposed_zscores: JSON.parse(r.decomposed_zscores || '{}'),
    mahalanobis_distances: JSON.parse(r.mahalanobis_distances || '{}')
  }));
}

export function updateDiagnosticEventStatus(eventId, userStatus, escalationStatus = null) {
  const database = initDatabase();
  if (escalationStatus) {
    database.runSync(
      'UPDATE diagnostic_events SET user_status = ?, escalation_status = ? WHERE event_id = ?;',
      [userStatus, escalationStatus, eventId]
    );
  } else {
    database.runSync(
      'UPDATE diagnostic_events SET user_status = ? WHERE event_id = ?;',
      [userStatus, eventId]
    );
  }
}

// ─── User Feedback API ───────────────────────────────────────────────────────

export function saveUserFeedback(feedback) {
  const database = initDatabase();
  const res = database.runSync(
    `INSERT INTO user_feedback (
      event_id, location_id, user_action, notes, prior_adjustment_applied
    ) VALUES (?, ?, ?, ?, ?);`,
    [
      feedback.event_id,
      feedback.location_id ?? null,
      feedback.user_action,
      feedback.notes || '',
      feedback.prior_adjustment_applied ? 1 : 0
    ]
  );
  // Also update diagnostic_events table status
  updateDiagnosticEventStatus(feedback.event_id, feedback.user_action);
  return res.lastInsertRowId;
}

export function getFeedbackForLocation(locationId) {
  const database = initDatabase();
  return database.getAllSync(
    `SELECT uf.*, de.primary_hypothesis
     FROM user_feedback uf
     JOIN diagnostic_events de ON uf.event_id = de.event_id
     WHERE uf.location_id = ? ORDER BY uf.feedback_id DESC;`,
    [locationId]
  );
}

// ─── Emergency Escalations API ───────────────────────────────────────────────

export function logEscalation(esc) {
  const database = initDatabase();
  const res = database.runSync(
    `INSERT INTO emergency_escalations (
      event_id, trigger_type, contact_id, channel, message_body,
      latitude, longitude, address, dispatch_status, is_duress
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [
      esc.event_id ?? null,
      esc.trigger_type,
      esc.contact_id,
      esc.channel,
      esc.message_body,
      esc.latitude ?? null,
      esc.longitude ?? null,
      esc.address || '',
      esc.dispatch_status || 'SENT',
      esc.is_duress ? 1 : 0
    ]
  );
  return res.lastInsertRowId;
}

export function getRecentEscalations(limit = 20) {
  const database = initDatabase();
  return database.getAllSync(
    `SELECT ee.*, ec.name as contact_name
     FROM emergency_escalations ee
     JOIN emergency_contacts ec ON ee.contact_id = ec.id
     ORDER BY ee.escalation_id DESC LIMIT ?;`,
    [limit]
  );
}

// ─── Generic DB Query Helpers (for DatabaseTab inspection) ───────────────────

export function executeSql(query, params = []) {
  const database = initDatabase();
  return database.getAllSync(query, params);
}

export function executeRun(query, params = []) {
  const database = initDatabase();
  return database.runSync(query, params);
}

// ─── Database Retention Policy API ──────────────────────────────────────────

export function enforceRetentionPolicy(days = 30) {
  const database = initDatabase();
  const cutoffTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;

  // 1. Delete expired episodes
  const resEpisodes = database.runSync(
    'DELETE FROM episodes WHERE start_timestamp < ?;',
    [cutoffTimestamp]
  );

  // 2. Delete expired location visits
  const resVisits = database.runSync(
    'DELETE FROM location_visits WHERE enter_timestamp < ?;',
    [cutoffTimestamp]
  );

  // 3. Delete expired diagnostic events (keep unreviewed or critical)
  const resEvents = database.runSync(
    `DELETE FROM diagnostic_events 
     WHERE timestamp < ? AND (user_status IN ('DISMISSED', 'FALSE_ALARM') OR primary_hypothesis = 'EXERTION_BENIGN');`,
    [cutoffTimestamp]
  );

  return {
    deletedEpisodes: resEpisodes.changes || 0,
    deletedVisits: resVisits.changes || 0,
    deletedEvents: resEvents.changes || 0
  };
}

// ─── Date & Time Formatting Utilities ────────────────────────────────────────

export function getIsoDateString(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getIsoTimeString(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}
