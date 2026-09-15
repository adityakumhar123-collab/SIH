// =============================================================================
// ChatTab.js — Local On-Device Gemma 3n Assistant with Database Query Tools
// =============================================================================

import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform
} from 'react-native';
import { GemmaAgent, AGENT_TOOLS } from '../GemmaAgent.js';

const QUICK_PROMPTS = [
  { label: '📊 Today’s Vitals', query: 'What are my vitals today and how do they compare to baseline?' },
  { label: '🚨 Recent Alerts', query: 'Did I have any recent alerts or unverified warnings?' },
  { label: '🩺 Medical Profile', query: 'Show my registered medical profile, blood group, and allergies.' },
  { label: '📍 Known Locations', query: 'What locations and safe geofence zones have I visited?' },
  { label: '🏃 Activity Log', query: 'Summarize my recent activity episodes and workouts.' },
  { label: '👥 Emergency Contacts', query: 'Who are my saved emergency contacts?' }
];

export default function ChatTab({
  currentPacket = {},
  initialPrompt = null,
  onClearInitialPrompt = null
}) {
  const [messages, setMessages] = useState([
    {
      id: 'welcome_1',
      sender: 'model',
      text: "Hello! I'm your on-device Gemma safety companion. All our conversations and health data remain 100% private on this phone. Ask me anything about your vitals, recent alerts, or medical profile.",
      toolUsed: null,
      isNativeLLM: true,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }
  ]);

  const [inputQuery, setInputQuery] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [expandedToolMsgId, setExpandedToolMsgId] = useState(null);
  const scrollViewRef = useRef(null);

  // Handle incoming preloaded prompt from Verified Notification Card
  useEffect(() => {
    if (initialPrompt && initialPrompt.trim()) {
      handleSendMessage(initialPrompt.trim());
      if (onClearInitialPrompt) onClearInitialPrompt();
    }
  }, [initialPrompt]);

  const handleSendMessage = async (textToSend) => {
    const query = (textToSend || inputQuery).trim();
    if (!query || isGenerating) return;

    const userMsg = {
      id: 'user_' + Date.now(),
      sender: 'user',
      text: query,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    setMessages(prev => [...prev, userMsg]);
    setInputQuery('');
    setIsGenerating(true);

    setTimeout(() => {
      scrollViewRef.current?.scrollToEnd({ animated: true });
    }, 100);

    try {
      const response = await GemmaAgent.processMessage(query, {
        hr: currentPacket.hr || 72,
        spo2: currentPacket.spo2 || 98.0,
        heatIndexF: currentPacket.heatIndexF || 75.0,
        heatIndexTier: currentPacket.heatIndexTier || 'NORMAL',
        activityClass: currentPacket.activityClass || 'resting'
      });

      setMessages(prev => [...prev, response]);
    } catch (err) {
      setMessages(prev => [
        ...prev,
        {
          id: 'err_' + Date.now(),
          sender: 'model',
          text: 'I ran into an issue processing that query locally. Please try asking again.',
          toolUsed: null,
          isNativeLLM: false,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        }
      ]);
    } finally {
      setIsGenerating(false);
      setTimeout(() => {
        scrollViewRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  };

  const handleClearChat = () => {
    setMessages([
      {
        id: 'welcome_' + Date.now(),
        sender: 'model',
        text: 'Chat history cleared. How can I help you with your health telemetry today?',
        toolUsed: null,
        isNativeLLM: true,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      }
    ]);
  };

  return (
    <KeyboardAvoidingView
      style={chatStyles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {/* Top AI Status Banner */}
      <View style={chatStyles.topBanner}>
        <View style={chatStyles.brandRow}>
          <View style={chatStyles.avatarCircle}>
            <Text style={{ fontSize: 18 }}>🤖</Text>
          </View>
          <View style={{ marginLeft: 10 }}>
            <Text style={chatStyles.bannerTitle}>Gemma 3n Health Assistant</Text>
            <Text style={chatStyles.bannerSubtitle}>MediaPipe GenAI • Local SQLite Tools • 100% Offline</Text>
          </View>
        </View>

        <TouchableOpacity
          delayPressIn={0}
          onPress={handleClearChat}
          style={chatStyles.clearBtn}
        >
          <Text style={chatStyles.clearBtnText}>Clear</Text>
        </TouchableOpacity>
      </View>

      {/* Quick Suggestion Chips */}
      <View style={chatStyles.chipsContainer}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}
        >
          {QUICK_PROMPTS.map((chip, idx) => (
            <TouchableOpacity
              key={idx}
              delayPressIn={0}
              style={chatStyles.chip}
              onPress={() => handleSendMessage(chip.query)}
              disabled={isGenerating}
            >
              <Text style={chatStyles.chipText}>{chip.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* Chat Messages Stream */}
      <ScrollView
        ref={scrollViewRef}
        style={chatStyles.messagesList}
        contentContainerStyle={{ padding: 14, paddingBottom: 24 }}
        showsVerticalScrollIndicator={false}
      >
        {messages.map((msg) => {
          const isUser = msg.sender === 'user';
          const isToolExpanded = expandedToolMsgId === msg.id;

          return (
            <View
              key={msg.id}
              style={[
                chatStyles.messageRow,
                isUser ? chatStyles.userMessageRow : chatStyles.modelMessageRow
              ]}
            >
              {!isUser && (
                <View style={chatStyles.botAvatarSmall}>
                  <Text style={{ fontSize: 14 }}>🤖</Text>
                </View>
              )}

              <View
                style={[
                  chatStyles.bubble,
                  isUser ? chatStyles.userBubble : chatStyles.modelBubble
                ]}
              >
                {/* Tool Calling Execution Chip */}
                {!isUser && msg.toolUsed && (
                  <View style={chatStyles.toolChipWrapper}>
                    <TouchableOpacity
                      delayPressIn={0}
                      onPress={() => setExpandedToolMsgId(isToolExpanded ? null : msg.id)}
                      style={chatStyles.toolExecutionBadge}
                      activeOpacity={0.7}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={{ fontSize: 11, marginRight: 4 }}>🔧</Text>
                        <Text style={chatStyles.toolBadgeTitle}>
                          Queried: {msg.toolUsed.title}
                        </Text>
                      </View>
                      <Text style={chatStyles.toolBadgeToggle}>
                        {isToolExpanded ? 'Hide ▲' : 'Inspect ▼'}
                      </Text>
                    </TouchableOpacity>

                    {/* Collapsible SQLite Fact Drawer */}
                    {isToolExpanded && (
                      <View style={chatStyles.toolFactDrawer}>
                        <Text style={chatStyles.toolFactHeading}>📁 SQLite Retrieved Data:</Text>
                        <Text style={chatStyles.toolFactText}>{msg.toolUsed.summary}</Text>
                      </View>
                    )}
                  </View>
                )}

                {/* Message Body Text */}
                <Text style={isUser ? chatStyles.userText : chatStyles.modelText}>
                  {msg.text}
                </Text>

                {/* Bubble Footer / Meta */}
                <View style={chatStyles.bubbleFooter}>
                  {!isUser && (
                    <View style={chatStyles.llmModeBadge}>
                      <Text style={chatStyles.llmModeText}>
                        {msg.isNativeLLM ? '⚡ On-Device Weights' : '🛡️ Local Synthesizer'}
                      </Text>
                    </View>
                  )}
                  <Text style={chatStyles.timestampText}>{msg.timestamp}</Text>
                </View>
              </View>
            </View>
          );
        })}

        {/* Thinking / Generating Indicator */}
        {isGenerating && (
          <View style={[chatStyles.messageRow, chatStyles.modelMessageRow]}>
            <View style={chatStyles.botAvatarSmall}>
              <Text style={{ fontSize: 14 }}>🤖</Text>
            </View>
            <View style={[chatStyles.bubble, chatStyles.modelBubble, { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 }]}>
              <ActivityIndicator size="small" color="#06B6D4" style={{ marginRight: 8 }} />
              <Text style={{ color: '#94A3B8', fontSize: 12 }}>Consulting local SQLite database & Gemma model...</Text>
            </View>
          </View>
        )}
      </ScrollView>

      {/* Input Bar */}
      <View style={chatStyles.inputContainer}>
        <TextInput
          style={chatStyles.textInput}
          placeholder="Ask Gemma about your vitals, alerts, baseline..."
          placeholderTextColor="#64748B"
          value={inputQuery}
          onChangeText={setInputQuery}
          onSubmitEditing={() => handleSendMessage()}
          returnKeyType="send"
          editable={!isGenerating}
        />
        <TouchableOpacity
          delayPressIn={0}
          onPress={() => handleSendMessage()}
          style={[
            chatStyles.sendButton,
            (!inputQuery.trim() || isGenerating) && chatStyles.sendButtonDisabled
          ]}
          disabled={!inputQuery.trim() || isGenerating}
        >
          <Text style={chatStyles.sendButtonText}>➤</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const chatStyles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0F172A',
  },
  topBanner: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: 'rgba(15, 23, 42, 0.95)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  avatarCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerTitle: {
    color: '#F8FAFC',
    fontSize: 14,
    fontWeight: 'bold',
  },
  bannerSubtitle: {
    color: '#06B6D4',
    fontSize: 10,
    marginTop: 1,
  },
  clearBtn: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  clearBtnText: {
    color: '#94A3B8',
    fontSize: 11,
    fontWeight: '600',
  },
  chipsContainer: {
    paddingVertical: 8,
    backgroundColor: 'rgba(15, 23, 42, 0.6)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.04)',
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: 'rgba(30, 41, 59, 0.9)',
    borderWidth: 1,
    borderColor: 'rgba(59, 130, 246, 0.25)',
  },
  chipText: {
    color: '#E2E8F0',
    fontSize: 11,
    fontWeight: '600',
  },
  messagesList: {
    flex: 1,
  },
  messageRow: {
    flexDirection: 'row',
    marginBottom: 14,
    alignItems: 'flex-end',
  },
  userMessageRow: {
    justifyContent: 'flex-end',
  },
  modelMessageRow: {
    justifyContent: 'flex-start',
  },
  botAvatarSmall: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(6, 182, 212, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    marginBottom: 4,
  },
  bubble: {
    maxWidth: '82%',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  userBubble: {
    backgroundColor: '#2563EB',
    borderBottomRightRadius: 4,
  },
  modelBubble: {
    backgroundColor: '#1E293B',
    borderBottomLeftRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.25)',
  },
  userText: {
    color: '#FFFFFF',
    fontSize: 13,
    lineHeight: 19,
  },
  modelText: {
    color: '#F1F5F9',
    fontSize: 13,
    lineHeight: 20,
  },
  bubbleFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
    gap: 8,
  },
  llmModeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: 'rgba(6, 182, 212, 0.1)',
  },
  llmModeText: {
    color: '#06B6D4',
    fontSize: 9,
    fontWeight: '700',
  },
  timestampText: {
    color: '#64748B',
    fontSize: 9,
    marginLeft: 'auto',
  },
  toolChipWrapper: {
    marginBottom: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(6, 182, 212, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(6, 182, 212, 0.2)',
    overflow: 'hidden',
  },
  toolExecutionBadge: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  toolBadgeTitle: {
    color: '#06B6D4',
    fontSize: 10,
    fontWeight: 'bold',
  },
  toolBadgeToggle: {
    color: '#94A3B8',
    fontSize: 9,
    fontWeight: '600',
  },
  toolFactDrawer: {
    padding: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(6, 182, 212, 0.15)',
    backgroundColor: 'rgba(0, 0, 0, 0.2)',
  },
  toolFactHeading: {
    color: '#38BDF8',
    fontSize: 10,
    fontWeight: '700',
    marginBottom: 3,
  },
  toolFactText: {
    color: '#CBD5E1',
    fontSize: 10,
    lineHeight: 14,
  },
  inputContainer: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: '#0B1120',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
  },
  textInput: {
    flex: 1,
    backgroundColor: '#1E293B',
    color: '#FFFFFF',
    fontSize: 13,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#06B6D4',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },
  sendButtonDisabled: {
    backgroundColor: '#334155',
  },
  sendButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: 'bold',
  },
});
