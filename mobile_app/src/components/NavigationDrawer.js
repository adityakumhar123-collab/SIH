// =============================================================================
// NavigationDrawer.js — Tactical Slide-Out Hamburger Navigation Menu
// =============================================================================

import React from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  StyleSheet,
  ScrollView,
  Platform,
  Dimensions
} from 'react-native';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const NAV_ITEMS = [
  {
    id: 'DASHBOARD',
    icon: '🏠',
    title: 'Dashboard',
    subtitle: 'Live Signals, Spatial Radar & Clinical AI',
    color: '#3B82F6',
  },
  {
    id: 'CHAT',
    icon: '🤖',
    title: 'Gemma AI Assistant',
    subtitle: 'On-Device Health Chat & DB Tools',
    color: '#06B6D4',
  },
  {
    id: 'CONTACTS',
    icon: '👥',
    title: 'Emergency Contacts',
    subtitle: 'Priority Alert Recipients & Dispatch',
    color: '#10B981',
  },
  {
    id: 'TEMPLATES',
    icon: '📝',
    title: 'Alert Templates',
    subtitle: 'Custom SMS, WhatsApp & Email Tokens',
    color: '#8B5CF6',
  },
  {
    id: 'SETTINGS',
    icon: '⚙️',
    title: 'Settings & Security',
    subtitle: 'Medical Profile, Twilio, Resend & PIN',
    color: '#F59E0B',
  },
  {
    id: 'DATABASE',
    icon: '📁',
    title: 'Database Explorer',
    subtitle: 'SQLite Tables, Episodes & Historical Logs',
    color: '#EC4899',
  },
];

export default function NavigationDrawer({
  visible = false,
  onClose,
  activeTab = 'DASHBOARD',
  onSelectTab,
  connectionState = 'DISCONNECTED',
  batteryPct = 100,
  uptime = 0,
}) {
  const isConnected = connectionState === 'CONNECTED';

  const handleItemPress = (tabId) => {
    if (onSelectTab) onSelectTab(tabId);
    if (onClose) onClose();
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        {/* Backdrop click to dismiss */}
        <TouchableOpacity
          style={styles.backdropTouch}
          activeOpacity={1}
          onPress={onClose}
        />

        {/* Slide-out Drawer Container */}
        <View style={styles.drawerContainer}>
          {/* Drawer Header */}
          <View style={styles.drawerHeader}>
            <View style={styles.brandRow}>
              <View style={styles.brandIconCircle}>
                <Text style={{ fontSize: 22 }}>🛡️</Text>
              </View>
              <View style={{ marginLeft: 12 }}>
                <Text style={styles.brandTitle}>RakshaBand</Text>
                <Text style={styles.brandSubtitle}>OS v3.2 • Clinical AI</Text>
              </View>
            </View>
            <TouchableOpacity delayPressIn={0} onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Quick Hardware Status Card */}
          <View style={styles.statusCard}>
            <View style={styles.statusRow}>
              <View style={styles.statusLeft}>
                <View
                  style={[
                    styles.statusIndicatorDot,
                    { backgroundColor: isConnected ? '#10B981' : '#EF4444' },
                  ]}
                />
                <Text style={styles.statusLabel}>{connectionState}</Text>
              </View>
              <Text style={styles.batteryText}>⚡ {batteryPct}%</Text>
            </View>
            <Text style={styles.uptimeText}>Session Uptime: {uptime} minutes</Text>
          </View>

          {/* Navigation Items List */}
          <ScrollView style={styles.menuScroll} showsVerticalScrollIndicator={false}>
            <Text style={styles.sectionHeader}>NAVIGATION</Text>
            {NAV_ITEMS.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <TouchableOpacity
                  delayPressIn={0}
                  key={item.id}
                  style={[
                    styles.navItem,
                    isActive && styles.navItemActive,
                  ]}
                  onPress={() => handleItemPress(item.id)}
                  activeOpacity={0.7}
                >
                  {/* Left accent bar for active item */}
                  {isActive && <View style={[styles.activeAccentBar, { backgroundColor: item.color }]} />}

                  <View style={[styles.itemIconCircle, { backgroundColor: item.color + '22' }]}>
                    <Text style={{ fontSize: 18 }}>{item.icon}</Text>
                  </View>

                  <View style={styles.itemTextCol}>
                    <Text style={[styles.itemTitle, isActive && { color: '#FFFFFF', fontWeight: 'bold' }]}>
                      {item.title}
                    </Text>
                    <Text style={styles.itemSubtitle}>{item.subtitle}</Text>
                  </View>

                  {isActive && (
                    <View style={[styles.activePill, { backgroundColor: item.color + '33' }]}>
                      <Text style={[styles.activePillText, { color: item.color }]}>Active</Text>
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>

          {/* Drawer Footer */}
          <View style={styles.drawerFooter}>
            <Text style={styles.footerText}>🔒 100% Offline Multi-Engine Architecture</Text>
            <Text style={styles.footerSubtext}>Deep Learning • Mahalanobis • Spatial Geofencing</Text>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    flexDirection: 'row',
  },
  backdropTouch: {
    flex: 1,
  },
  drawerContainer: {
    width: Math.min(SCREEN_WIDTH * 0.82, 340),
    backgroundColor: '#0B1120',
    height: '100%',
    paddingTop: Platform.OS === 'ios' ? 54 : 36,
    paddingBottom: 24,
    paddingHorizontal: 20,
    borderRightWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.25)',
    shadowColor: '#000',
    shadowOffset: { width: 4, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 16,
    elevation: 24,
  },
  drawerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  brandIconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(59, 130, 246, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandTitle: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: 'bold',
    letterSpacing: 0.5,
  },
  brandSubtitle: {
    color: '#60A5FA',
    fontSize: 11,
    marginTop: 1,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtnText: {
    color: '#94A3B8',
    fontSize: 16,
    fontWeight: 'bold',
  },
  statusCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 12,
    padding: 12,
    marginTop: 16,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  statusLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  statusIndicatorDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginRight: 8,
  },
  statusLabel: {
    color: '#F8FAFC',
    fontSize: 12,
    fontWeight: 'bold',
  },
  batteryText: {
    color: '#34D399',
    fontSize: 12,
    fontWeight: 'bold',
  },
  uptimeText: {
    color: '#64748B',
    fontSize: 10,
  },
  sectionHeader: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: 'bold',
    letterSpacing: 1,
    marginBottom: 10,
    marginLeft: 4,
  },
  menuScroll: {
    flex: 1,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 8,
    position: 'relative',
    backgroundColor: 'rgba(255, 255, 255, 0.015)',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  navItemActive: {
    backgroundColor: 'rgba(59, 130, 246, 0.12)',
    borderColor: 'rgba(59, 130, 246, 0.35)',
  },
  activeAccentBar: {
    position: 'absolute',
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderRadius: 2,
  },
  itemIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  itemTextCol: {
    flex: 1,
  },
  itemTitle: {
    color: '#CBD5E1',
    fontSize: 14,
    fontWeight: '600',
  },
  itemSubtitle: {
    color: '#64748B',
    fontSize: 10,
    marginTop: 2,
  },
  activePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  activePillText: {
    fontSize: 10,
    fontWeight: 'bold',
  },
  drawerFooter: {
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.06)',
    alignItems: 'center',
  },
  footerText: {
    color: '#94A3B8',
    fontSize: 10,
    fontWeight: '600',
    textAlign: 'center',
  },
  footerSubtext: {
    color: '#64748B',
    fontSize: 9,
    marginTop: 3,
    textAlign: 'center',
  },
});
