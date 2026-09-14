// =============================================================================
// LocationNamingModal.js — Location Naming Prompt & Anti-Spam Manager
// =============================================================================
//
// UX & BEHAVIOR SPECIFICATION:
// ----------------------------
// 1. Trigger: Appears when a new location node is registered via dwell learning,
//    or when the user enters an unnamed node (name is null/empty).
// 2. Anti-Spam Throttling:
//    - Strictly one naming prompt at any time.
//    - If dismissed, a 15-minute cooldown is applied to that specific node.
// 3. Fallback Integrity:
//    - If the user enters a name, it updates SQLite via updateLocationName().
//    - If dismissed, the node name remains null in SQLite, and the UI cleanly
//      displays "Zone #ID" (NEVER literal "null" or "Location null").
//    - When the user returns in a future session after the cooldown, they will
//      be gently prompted again.
// =============================================================================

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  Modal,
  StyleSheet,
  KeyboardAvoidingView,
  Platform
} from 'react-native';
import { getCleanLocationName } from '../Database.js';

export default function LocationNamingModal({
  visible = false,
  node = null,
  onSave,
  onDismiss,
}) {
  const [nameText, setNameText] = useState('');

  useEffect(() => {
    if (node) {
      // If node has an existing custom name (and not 'null'), prefill it
      const currentName = node.name;
      if (currentName && currentName !== 'null' && currentName !== 'undefined') {
        setNameText(currentName);
      } else {
        setNameText('');
      }
    } else {
      setNameText('');
    }
  }, [node]);

  if (!node) return null;

  const zoneLabel = getCleanLocationName(node, node.location_id);

  const handleSavePress = () => {
    const trimmed = nameText.trim();
    if (onSave) {
      onSave(node.location_id, trimmed.length > 0 ? trimmed : null);
    }
  };

  const handleDismissPress = () => {
    if (onDismiss) {
      onDismiss(node.location_id);
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleDismissPress}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={styles.overlay}
      >
        <View style={styles.modalCard}>
          {/* Header */}
          <View style={styles.headerRow}>
            <View style={styles.iconCircle}>
              <Text style={{ fontSize: 20 }}>📍</Text>
            </View>
            <View style={{ flex: 1, marginLeft: 12 }}>
              <Text style={styles.tagText}>NEW GEOFENCE CLUSTER</Text>
              <Text style={styles.titleText}>Name This Location</Text>
            </View>
          </View>

          {/* Description */}
          <Text style={styles.description}>
            You have arrived at <Text style={styles.boldHighlight}>{zoneLabel}</Text>. Give it a friendly name like <Text style={styles.highlight}>"Home"</Text>, <Text style={styles.highlight}>"Office"</Text>, or <Text style={styles.highlight}>"Gym"</Text> to personalize your environmental and clinical baselines.
          </Text>

          {/* Text Input */}
          <TextInput
            style={styles.input}
            placeholder="e.g., Home, Work, Gym, Library"
            placeholderTextColor="#64748B"
            value={nameText}
            onChangeText={setNameText}
            autoFocus
            maxLength={32}
            returnKeyType="done"
            onSubmitEditing={handleSavePress}
          />

          {/* Action Buttons */}
          <View style={styles.buttonCol}>
            <TouchableOpacity
              delayPressIn={0}
              style={styles.saveButton}
              onPress={handleSavePress}
              activeOpacity={0.8}
            >
              <Text style={styles.saveButtonText}>
                {nameText.trim().length > 0 ? '💾 Save Location Name' : `✓ Keep as ${zoneLabel}`}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              delayPressIn={0}
              style={styles.dismissButton}
              onPress={handleDismissPress}
              activeOpacity={0.7}
            >
              <Text style={styles.dismissButtonText}>
                Remind Me Next Time
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalCard: {
    backgroundColor: '#0F172A',
    borderRadius: 20,
    padding: 22,
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.3)',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tagText: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  titleText: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 'bold',
    marginTop: 2,
  },
  description: {
    color: '#94A3B8',
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 16,
  },
  boldHighlight: {
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  highlight: {
    color: '#60A5FA',
    fontWeight: '600',
  },
  input: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.35)',
    borderRadius: 12,
    color: '#FFFFFF',
    fontSize: 15,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
  },
  buttonCol: {
    gap: 10,
  },
  saveButton: {
    backgroundColor: '#3B82F6',
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: 'bold',
  },
  dismissButton: {
    paddingVertical: 10,
    alignItems: 'center',
  },
  dismissButtonText: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '600',
  },
});
