import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Platform } from 'react-native';
import styles from './styles';
import { executeSql, executeRun, getCleanLocationName } from '../Database';
import { LocationEngine } from '../LocationEngine';

const TABLE_METADATA = {
  episodes: {
    label: 'Episodes (Telemetry)',
    pk: 'episode_id',
    formatRow: (row) => `Episode #${row.episode_id} • ${row.activity_class || 'standing'} (${row.duration_seconds || 0}s) • HR: ${row.hr_mean ? Math.round(row.hr_mean) : 72} bpm • SpO2: ${row.spo2_mean ? Math.round(row.spo2_mean) : 98}%`
  },
  diagnostic_events: {
    label: 'Diagnostic Reasoning',
    pk: 'event_id',
    formatRow: (row) => `Diagnostic #${row.event_id} • ${row.primary_hypothesis} (${Math.round((row.confidence || 0) * 100)}%) [${(row.severity_tier || 'advisory').toUpperCase()}]`
  },
  known_locations: {
    label: 'Known Locations',
    pk: 'location_id',
    formatRow: (row) => `Location #${row.location_id}: ${getCleanLocationName(row)} • Dwells: ${row.dwell_count || 1} • Total Stay: ${row.total_stay_minutes || 0}m`
  },
  location_visits: {
    label: 'Location Visits',
    pk: 'visit_id',
    formatRow: (row) => `Visit #${row.visit_id} • Location #${row.location_id} • Duration: ${row.duration_minutes || 0}m`
  },
  baseline_states: {
    label: 'Physiological Baselines',
    pk: 'domain',
    formatRow: (row) => `Baseline: ${row.domain} (${row.sub_key}) • Samples: ${row.sample_count} • Source: ${row.source || 'EWMA'}`
  },
  user_feedback: {
    label: 'User Actions & Feedback',
    pk: 'feedback_id',
    formatRow: (row) => `Feedback #${row.feedback_id} • Event #${row.event_id} • Action: ${row.user_action}`
  },
  emergency_escalations: {
    label: 'Emergency Escalations',
    pk: 'escalation_id',
    formatRow: (row) => `Escalation #${row.escalation_id} • ${row.trigger_type} via ${row.channel} → ${row.dispatch_status}`
  },
  emergency_contacts: {
    label: 'Emergency Contacts',
    pk: 'id',
    formatRow: (row) => `Contact: ${row.name || 'Unnamed'} • ${row.phone || row.email || row.whatsapp || 'No contact details'}`
  },
  templates: {
    label: 'Alert Templates',
    pk: 'id',
    formatRow: (row) => `Template #${row.id}: ${row.name || 'Standard Alert'}`
  },
  settings: {
    label: 'Application Settings',
    pk: 'key',
    formatRow: (row) => `${row.key} = ${row.value !== undefined && row.value !== '' ? row.value : '(not set)'}`
  }
};

const DatabaseTab = React.memo(() => {
  const [availableTables, setAvailableTables] = useState([]);
  const [selectedTable, setSelectedTable] = useState('episodes');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedRows, setExpandedRows] = useState({});

  // Query actual SQLite master table so the list is always 100% accurate
  const refreshTableList = () => {
    try {
      const dbTables = executeSql("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';") || [];
      const names = dbTables.map(t => t.name);

      const preferredOrder = [
        'episodes',
        'diagnostic_events',
        'known_locations',
        'location_visits',
        'baseline_states',
        'user_feedback',
        'emergency_escalations',
        'emergency_contacts',
        'templates',
        'settings'
      ];

      const ordered = [];
      for (const p of preferredOrder) {
        if (names.includes(p)) ordered.push(p);
      }
      for (const n of names) {
        if (!ordered.includes(n)) ordered.push(n);
      }

      const formatted = ordered.map(name => ({
        name,
        label: TABLE_METADATA[name]?.label || name
      }));

      setAvailableTables(formatted);
      if (formatted.length > 0 && !names.includes(selectedTable)) {
        setSelectedTable(formatted[0].name);
      }
    } catch (e) {
      // Fallback
      setAvailableTables(Object.keys(TABLE_METADATA).map(name => ({
        name,
        label: TABLE_METADATA[name].label
      })));
    }
  };

  useEffect(() => {
    refreshTableList();
  }, []);

  const handleRegisterCurrentLocation = async () => {
    try {
      setLoading(true);
      const newId = await LocationEngine.registerCurrentLocation('Current Registered Location');
      Alert.alert('📍 Location Registered', `Registered Known Location Node #${newId} with coordinates.`);
      fetchTableData('known_locations');
    } catch (err) {
      Alert.alert('Error', `Failed to register location: ${err.message}`);
      setLoading(false);
    }
  };

  const fetchTableData = (tableName) => {
    setLoading(true);
    setError(null);
    setExpandedRows({});
    try {
      const meta = TABLE_METADATA[tableName];
      const pkCol = meta?.pk || 'rowid';

      const sql = (tableName === 'settings' || tableName === 'baseline_states')
        ? `SELECT * FROM ${tableName} LIMIT 50;`
        : `SELECT * FROM ${tableName} ORDER BY ${pkCol} DESC LIMIT 50;`;
      
      const data = executeSql(sql);
      setRows(data || []);
    } catch (err) {
      console.error('[DB Tab] Query error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTableData(selectedTable);
  }, [selectedTable]);

  const handleClearTable = (tableName) => {
    Alert.alert(
      '⚠️ Clear Table',
      `Are you sure you want to delete all rows from table "${tableName}"? This action cannot be undone!`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear Data',
          style: 'destructive',
          onPress: () => {
            try {
              executeRun(`DELETE FROM ${tableName};`);
              Alert.alert('Success', `Table "${tableName}" cleared successfully.`);
              fetchTableData(selectedTable);
            } catch (err) {
              Alert.alert('Error', err.message);
            }
          }
        }
      ]
    );
  };

  const toggleRow = (index) => {
    setExpandedRows(prev => ({
      ...prev,
      [index]: !prev[index]
    }));
  };

  const renderRow = (row, index) => {
    const isExpanded = expandedRows[index];
    const meta = TABLE_METADATA[selectedTable];
    const summaryText = meta?.formatRow ? meta.formatRow(row) : `Row #${index + 1}`;

    return (
      <View key={index} style={{
        backgroundColor: 'rgba(255, 255, 255, 0.03)',
        borderRadius: 12,
        padding: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: 'rgba(255, 255, 255, 0.05)'
      }}>
        <TouchableOpacity delayPressIn={0} onPress={() => toggleRow(index)} style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}>
          <Text style={{ color: '#F8FAFC', fontSize: 13, fontWeight: '600', flex: 1 }}>{summaryText}</Text>
          <Text style={{ color: '#94A3B8', fontSize: 12 }}>{isExpanded ? '▲' : '▼'}</Text>
        </TouchableOpacity>

        {isExpanded && (
          <View style={{
            marginTop: 10,
            paddingTop: 10,
            borderTopWidth: 1,
            borderTopColor: 'rgba(255, 255, 255, 0.05)'
          }}>
            {Object.keys(row).map((key) => {
              let val = row[key];
              // Try to pretty-print JSON string values
              if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
                try {
                  val = JSON.stringify(JSON.parse(val), null, 2);
                } catch (e) {
                  // Keep original if not JSON
                }
              }
              return (
                <View key={key} style={{ marginBottom: 6 }}>
                  <Text style={{ color: '#38BDF8', fontSize: 11, fontWeight: '700' }}>{key}:</Text>
                  <Text style={{ color: '#E2E8F0', fontSize: 11, fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace', marginTop: 2 }}>
                    {val === null ? 'NULL' : String(val)}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.card}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Text style={styles.cardTitle}>📁 Database Viewer</Text>
        <TouchableOpacity delayPressIn={0} onPress={() => { refreshTableList(); fetchTableData(selectedTable); }} style={{
          backgroundColor: 'rgba(59, 130, 246, 0.15)',
          borderColor: '#3B82F6',
          borderWidth: 1,
          borderRadius: 8,
          paddingVertical: 6,
          paddingHorizontal: 12
        }}>
          <Text style={{ color: '#3B82F6', fontSize: 12, fontWeight: 'bold' }}>🔄 Refresh</Text>
        </TouchableOpacity>
      </View>

      {/* Table select buttons scroll list */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
        {availableTables.map((tab) => (
          <TouchableOpacity
            delayPressIn={0}
            key={tab.name}
            style={{
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: selectedTable === tab.name ? '#1E293B' : 'rgba(255,255,255,0.03)',
              borderWidth: 1,
              borderColor: selectedTable === tab.name ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.05)',
              marginRight: 8
            }}
            onPress={() => setSelectedTable(tab.name)}
          >
            <Text style={{ color: selectedTable === tab.name ? '#FFFFFF' : '#94A3B8', fontSize: 12, fontWeight: '600' }}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {selectedTable === 'known_locations' && (
        <TouchableOpacity
          delayPressIn={0}
          onPress={handleRegisterCurrentLocation}
          style={{
            backgroundColor: 'rgba(16, 185, 129, 0.15)',
            borderColor: '#10B981',
            borderWidth: 1,
            borderRadius: 10,
            paddingVertical: 10,
            paddingHorizontal: 14,
            alignItems: 'center',
            marginBottom: 14
          }}
        >
          <Text style={{ color: '#10B981', fontSize: 13, fontWeight: 'bold' }}>
            📍 + Register Current GPS as Known Location
          </Text>
        </TouchableOpacity>
      )}

      {loading ? (
        <ActivityIndicator size="large" color="#3B82F6" style={{ marginVertical: 24 }} />
      ) : error ? (
        <View style={styles.errorAlert}>
          <Text style={styles.errorAlertText}>Error loading data: {error}</Text>
        </View>
      ) : rows.length === 0 ? (
        <View>
          <Text style={{ color: '#64748B', fontSize: 13, textAlign: 'center', marginVertical: 24 }}>
            No records found in table "{selectedTable}".
          </Text>
          {/* Delete all button */}
          <TouchableOpacity delayPressIn={0} onPress={() => handleClearTable(selectedTable)} style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            borderColor: '#EF4444',
            borderWidth: 1,
            borderRadius: 12,
            paddingVertical: 12,
            alignItems: 'center',
            marginTop: 16
          }}>
            <Text style={{ color: '#EF4444', fontSize: 13, fontWeight: 'bold' }}>🗑️ Clear Table Data</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View>
          <Text style={{ color: '#94A3B8', fontSize: 11, marginBottom: 8 }}>
            Showing latest {rows.length} rows (newest first). Click a row to inspect.
          </Text>
          
          {rows.map((row, idx) => renderRow(row, idx))}

          {/* Delete all button */}
          <TouchableOpacity delayPressIn={0} onPress={() => handleClearTable(selectedTable)} style={{
            backgroundColor: 'rgba(239, 68, 68, 0.1)',
            borderColor: '#EF4444',
            borderWidth: 1,
            borderRadius: 12,
            paddingVertical: 12,
            alignItems: 'center',
            marginTop: 16
          }}>
            <Text style={{ color: '#EF4444', fontSize: 13, fontWeight: 'bold' }}>🗑️ Clear Table Data</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
});

export default DatabaseTab;
