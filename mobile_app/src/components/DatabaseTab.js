import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Alert, ActivityIndicator, Platform } from 'react-native';
import styles from './styles';
import { executeSql, executeRun } from '../Database';

const DatabaseTab = React.memo(() => {
  const [selectedTable, setSelectedTable] = useState('episodes');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedRows, setExpandedRows] = useState({});

  const TABLES = [
    { name: 'episodes', label: '🎬 Episodes' },
    { name: 'diagnostic_events', label: '🧠 Diagnostics' },
    { name: 'known_locations', label: '📍 Locations' },
    { name: 'location_visits', label: '🚪 Visits' },
    { name: 'baseline_states', label: '📈 Baselines' },
    { name: 'user_feedback', label: '💬 Feedback' },
    { name: 'emergency_escalations', label: '🚨 Escalations' },
    { name: 'emergency_contacts', label: '👥 Contacts' },
    { name: 'templates', label: '📝 Templates' },
    { name: 'settings', label: '⚙️ Settings' }
  ];

  const fetchTableData = (tableName) => {
    setLoading(true);
    setError(null);
    setExpandedRows({});
    try {
      let pkCol = 'rowid';
      if (tableName === 'episodes') pkCol = 'episode_id';
      else if (tableName === 'diagnostic_events') pkCol = 'event_id';
      else if (tableName === 'known_locations') pkCol = 'location_id';
      else if (tableName === 'location_visits') pkCol = 'visit_id';
      else if (tableName === 'user_feedback') pkCol = 'feedback_id';
      else if (tableName === 'emergency_escalations') pkCol = 'escalation_id';
      else if (tableName === 'emergency_contacts') pkCol = 'id';
      else if (tableName === 'templates') pkCol = 'id';
      else if (tableName === 'settings') pkCol = 'key';

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
    
    // Get a brief identifier for the row summary header
    let summaryText = `Row #${index + 1}`;
    if (selectedTable === 'episodes') {
      summaryText = `Ep #${row.episode_id} | ${row.activity_class} (${row.duration_seconds || 0}s) | HR: ${row.hr_mean || 72}bpm`;
    } else if (selectedTable === 'diagnostic_events') {
      summaryText = `Event #${row.event_id} | ${row.primary_hypothesis} (${(row.confidence * 100).toFixed(0)}%) [${(row.severity_tier || '').toUpperCase()}]`;
    } else if (selectedTable === 'known_locations') {
      summaryText = `Loc #${row.location_id} | ${row.name} | Dwells: ${row.dwell_count}`;
    } else if (selectedTable === 'location_visits') {
      summaryText = `Visit #${row.visit_id} | Loc #${row.location_id} | Dur: ${row.duration_minutes || 0}m`;
    } else if (selectedTable === 'baseline_states') {
      summaryText = `Baseline: ${row.domain} (${row.sub_key}) | Samples: ${row.sample_count}`;
    } else if (selectedTable === 'user_feedback') {
      summaryText = `Feedback #${row.feedback_id} | Event #${row.event_id}: ${row.user_action}`;
    } else if (selectedTable === 'emergency_escalations') {
      summaryText = `Escalation #${row.escalation_id} | ${row.trigger_type} (${row.channel}) -> Status: ${row.dispatch_status}`;
    } else if (selectedTable === 'settings') {
      summaryText = `${row.key}: ${row.value}`;
    } else if (selectedTable === 'emergency_contacts') {
      summaryText = `${row.name} (${row.phone || row.email || row.whatsapp})`;
    } else if (selectedTable === 'templates') {
      summaryText = `Template: ${row.name}`;
    }

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
        <TouchableOpacity delayPressIn={0} onPress={() => fetchTableData(selectedTable)} style={{
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
        {TABLES.map((tab) => (
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
