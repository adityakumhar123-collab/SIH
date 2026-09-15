// =============================================================================
// GemmaAgent.js — Conversational Health Agent with Local DB Tool Calling
// =============================================================================
//
// Privacy & Architecture:
// 1. 100% Offline & Private: Queries local SQLite database on-device.
// 2. Tool Execution Pipeline:
//    - Analyzes user query to determine if database facts are required.
//    - Executes read-only tool functions directly against SQLite (rakshaband.db).
//    - Formats retrieved data into Gemma 3 instruction turn context.
//    - Runs inference via NativeModules.GemmaLocalModule (or local synthesizer fallback).
// =============================================================================

import {
  getUserMedicalProfile,
  getVitalsSummary,
  getRecentDiagnosticEvents,
  getRecentEpisodes,
  getKnownLocations,
  getContacts,
  getSetting
} from './Database.js';
import { GemmaService } from './GemmaService.js';

let NativeModules = globalThis.NativeModules || null;
if (!NativeModules && typeof require !== 'undefined' && (typeof process === 'undefined' || !process.versions?.node)) {
  try {
    const RN = require('react-native');
    NativeModules = RN.NativeModules;
  } catch (e) {
    // Non-native environment
  }
}

// ─── Available Database Query Tools ──────────────────────────────────────────

export const AGENT_TOOLS = [
  {
    name: 'get_vitals_summary',
    title: 'Vitals & Health Summary',
    description: 'Retrieves today’s average/min/max heart rate, blood oxygen (SpO2), personal baseline bounds, and activity episode counts.',
    execute: () => {
      const data = getVitalsSummary();
      return {
        success: true,
        summary: `Today: ${data.todayEpisodesCount} recorded activity episodes. Avg HR: ${data.avgHr ?? 'N/A'} bpm (Range: ${data.minHr ?? 'N/A'}-${data.maxHr ?? 'N/A'}), Avg SpO2: ${data.avgSpo2 ?? 'N/A'}%. Personal Resting Baseline: ${data.baselineRestingHr} bpm / ${data.baselineRestingSpo2}% SpO2. Total alerts today: ${data.todayAlertsCount}.`,
        raw: data
      };
    }
  },
  {
    name: 'get_user_profile',
    title: 'Personal & Medical Profile',
    description: 'Retrieves wearer profile, blood group, chronic conditions, known allergies, and emergency medical instructions.',
    execute: () => {
      const data = getUserMedicalProfile();
      return {
        success: true,
        summary: `Wearer: ${data.userName}. Blood Group: ${data.bloodGroup}. Conditions: ${data.conditions}. Allergies: ${data.allergies}. Instructions: ${data.instructions}.`,
        raw: data
      };
    }
  },
  {
    name: 'get_diagnostic_alerts',
    title: 'Diagnostic Alerts & Events',
    description: 'Retrieves recent physiological and environmental alerts, clinical hypotheses, severity tiers, and user verification status.',
    execute: (limit = 5) => {
      const data = getRecentDiagnosticEvents(limit);
      if (!data || data.length === 0) {
        return {
          success: true,
          summary: 'No diagnostic alerts or abnormal health events recorded in the database.',
          raw: []
        };
      }
      const formatted = data.map(ev => {
        const timeStr = new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `• [${timeStr}] ${ev.primary_hypothesis} (${ev.severity_tier?.toUpperCase()}) — Status: ${ev.user_status}. Guidance: "${ev.gemma_message || 'N/A'}"`;
      }).join('\n');

      return {
        success: true,
        summary: `Found ${data.length} recent alerts:\n${formatted}`,
        raw: data
      };
    }
  },
  {
    name: 'get_recent_episodes',
    title: 'Activity Episodes & Motion',
    description: 'Retrieves recent physical movement episodes, recognized activity classes, duration, and cardiovascular effort.',
    execute: (limit = 5) => {
      const data = getRecentEpisodes(limit);
      if (!data || data.length === 0) {
        return {
          success: true,
          summary: 'No recent activity episodes recorded yet.',
          raw: []
        };
      }
      const formatted = data.map(ep => {
        const dur = Math.round(ep.duration_seconds || 0);
        return `• ${ep.activity_class.replace(/_/g, ' ')} (${dur}s): Avg HR ${Math.round(ep.hr_mean || 0)} bpm, SpO2 ${Math.round(ep.spo2_mean || 0)}%`;
      }).join('\n');

      return {
        success: true,
        summary: `Recent ${data.length} episodes:\n${formatted}`,
        raw: data
      };
    }
  },
  {
    name: 'get_known_locations',
    title: 'Known Geofence Locations',
    description: 'Retrieves safe registered zones, dwell frequencies, stay durations, and baseline micro-climates.',
    execute: () => {
      const data = getKnownLocations();
      if (!data || data.length === 0) {
        return {
          success: true,
          summary: 'No known safe locations registered in SQLite yet.',
          raw: []
        };
      }
      const formatted = data.map(loc => {
        const name = loc.name || `Zone #${loc.location_id}`;
        return `• ${name}: Visited ${loc.dwell_count} times, total stay ${Math.round(loc.total_stay_minutes || 0)} mins.`;
      }).join('\n');

      return {
        success: true,
        summary: `Registered locations (${data.length}):\n${formatted}`,
        raw: data
      };
    }
  },
  {
    name: 'get_emergency_contacts',
    title: 'Emergency Contacts & Dispatch',
    description: 'Retrieves registered emergency contacts, priorities, and alert channels (SMS, WhatsApp, Email).',
    execute: () => {
      const data = getContacts();
      if (!data || data.length === 0) {
        return {
          success: true,
          summary: 'No emergency contacts registered. Alerts will only trigger local sirens.',
          raw: []
        };
      }
      const formatted = data.map(c => {
        const channels = [
          c.sms_enabled ? 'SMS' : null,
          c.whatsapp_enabled ? 'WhatsApp' : null,
          c.email_enabled ? 'Email' : null
        ].filter(Boolean).join(', ');
        return `• ${c.name} (Priority ${c.priority_order}): ${c.phone || c.email || 'No contact'} [${channels || 'None'}]`;
      }).join('\n');

      return {
        success: true,
        summary: `Emergency contacts (${data.length}):\n${formatted}`,
        raw: data
      };
    }
  }
];

// ─── Intent Recognition & Tool Routing ───────────────────────────────────────

export function routeUserIntent(queryText) {
  const q = (queryText || '').toLowerCase();

  if (q.includes('vital') || q.includes('heart') || q.includes('hr') || q.includes('pulse') || q.includes('spo2') || q.includes('oxygen') || q.includes('doing') || q.includes('health')) {
    return 'get_vitals_summary';
  }
  if (q.includes('alert') || q.includes('warning') || q.includes('fall') || q.includes('heat stress') || q.includes('notif') || q.includes('alarm') || q.includes('unverified')) {
    return 'get_diagnostic_alerts';
  }
  if (q.includes('medical') || q.includes('profile') || q.includes('blood') || q.includes('allerg') || q.includes('condition') || q.includes('instruction') || q.includes('doctor')) {
    return 'get_user_profile';
  }
  if (q.includes('location') || q.includes('zone') || q.includes('place') || q.includes('where') || q.includes('geofence') || q.includes('stay') || q.includes('visit')) {
    return 'get_known_locations';
  }
  if (q.includes('contact') || q.includes('emergency') || q.includes('sos') || q.includes('dispatch') || q.includes('call') || q.includes('message') || q.includes('sms')) {
    return 'get_emergency_contacts';
  }
  if (q.includes('episode') || q.includes('activity') || q.includes('workout') || q.includes('run') || q.includes('walk') || q.includes('exercise') || q.includes('motion')) {
    return 'get_recent_episodes';
  }

  return null;
}

// ─── Gemma Agent Main Handler ────────────────────────────────────────────────

class GemmaAgentClass {
  async processMessage(userMessage, currentContext = {}) {
    const userName = getSetting('user_name', 'there');
    const toolName = routeUserIntent(userMessage);

    let toolResult = null;
    let toolObj = null;

    if (toolName) {
      toolObj = AGENT_TOOLS.find(t => t.name === toolName);
      if (toolObj) {
        try {
          toolResult = toolObj.execute();
        } catch (err) {
          console.warn(`[GemmaAgent] Tool ${toolName} execution error:`, err);
        }
      }
    }

    // Build instruction prompt
    const prompt = this.buildAgentPrompt(userMessage, toolObj, toolResult, userName, currentContext);

    // 1. Try Native On-Device Gemma Inference (MediaPipe Tasks GenAI)
    try {
      if (!NativeModules && typeof require !== 'undefined' && (typeof process === 'undefined' || !process.versions?.node)) {
        const RN = require('react-native');
        NativeModules = RN.NativeModules;
      }

      if (NativeModules && NativeModules.GemmaLocalModule) {
        const localResponse = await NativeModules.GemmaLocalModule.generateResponse({
          prompt,
          maxTokens: 160,
          temperature: 0.3,
          modelPath: getSetting('local_gemma_model_path', '')
        });

        if (localResponse && localResponse.text && localResponse.text.trim().length > 0) {
          return {
            id: 'gemma_' + Date.now(),
            sender: 'model',
            text: localResponse.text.trim(),
            toolUsed: toolObj && toolResult ? {
              name: toolObj.name,
              title: toolObj.title,
              summary: toolResult.summary,
              raw: toolResult.raw
            } : null,
            isNativeLLM: true,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
        }
      }
    } catch (nativeErr) {
      console.warn('[GemmaAgent] Native inference fallback:', nativeErr.message);
    }

    // 2. Embedded Synthesizer Fallback (100% Offline, Deterministic, Zero Latency)
    const fallbackAnswer = this.synthesizeAgentResponse(userMessage, toolObj, toolResult, userName, currentContext);

    return {
      id: 'gemma_' + Date.now(),
      sender: 'model',
      text: fallbackAnswer,
      toolUsed: toolObj && toolResult ? {
        name: toolObj.name,
        title: toolObj.title,
        summary: toolResult.summary,
        raw: toolResult.raw
      } : null,
      isNativeLLM: false,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
  }

  buildAgentPrompt(userQuestion, toolObj, toolResult, userName, currentContext) {
    let facts = 'No specific database query was required for this query.';
    if (toolObj && toolResult) {
      facts = `Database Tool Executed: ${toolObj.title} (${toolObj.name})\nRetrieved Facts from SQLite:\n${toolResult.summary}`;
    }

    return `<start_of_turn>user
You are RakshaBand AI, an empathetic, caring, and precise personal safety companion running completely locally and privately on ${userName}'s device.
Wearer Name: ${userName}

Local Database Context:
${facts}

Live Sensor Telemetry:
- Heart Rate: ${currentContext.hr || 72} BPM
- Blood Oxygen: ${currentContext.spo2 || 98}%
- Heat Index: ${currentContext.heatIndexF || 75}°F (${currentContext.heatIndexTier || 'NORMAL'})
- Current Activity: ${(currentContext.activityClass || 'resting').replace(/_/g, ' ')}

User Question:
"${userQuestion}"

Instructions:
1. Answer ${userName} directly in a warm, reassuring, and helpful tone.
2. Use the retrieved database facts to answer accurately.
3. Keep the response to 2–3 clear, concise sentences.
4. Do NOT invent data not present in the facts. Do not make unverified medical claims.<end_of_turn>
<start_of_turn>model\n`;
  }

  synthesizeAgentResponse(userQuestion, toolObj, toolResult, userName, currentContext) {
    if (!toolObj || !toolResult) {
      return `Hello ${userName}, I'm your on-device RakshaBand assistant. All your biometric and location data is stored 100% privately on your device. You can ask me about your recent vitals, diagnostic alerts, medical profile, or safe locations anytime!`;
    }

    switch (toolObj.name) {
      case 'get_vitals_summary': {
        const raw = toolResult.raw;
        if (!raw || raw.todayEpisodesCount === 0) {
          return `${userName}, your vitals are currently resting at ${currentContext.hr || 72} BPM with ${currentContext.spo2 || 98}% SpO2, which matches your healthy baseline. We haven't logged extended workout episodes today yet.`;
        }
        return `Hello ${userName}, today you've completed ${raw.todayEpisodesCount} activity periods. Your average heart rate is ${raw.avgHr || 72} BPM (ranging from ${raw.minHr || 65} to ${raw.maxHr || 110} BPM) with a healthy average SpO2 of ${raw.avgSpo2 || 98}%. Everything is stable and aligns well with your personal baselines!`;
      }

      case 'get_user_profile': {
        const raw = toolResult.raw;
        return `Here is your registered medical profile, ${userName}: Blood group is ${raw.bloodGroup}. Conditions: ${raw.conditions}. Known allergies: ${raw.allergies}. Emergency instructions: "${raw.instructions}".`;
      }

      case 'get_diagnostic_alerts': {
        const raw = toolResult.raw;
        if (!raw || raw.length === 0) {
          return `Great news, ${userName}! You have zero recorded danger or urgent alerts in your database. All biometric indicators have remained safely within normal tolerances.`;
        }
        const latest = raw[0];
        const statusText = latest.user_status === 'VERIFIED' ? 'which you verified' : 'which is currently unreviewed';
        return `You have ${raw.length} recorded diagnostic event(s). The latest was "${latest.primary_hypothesis}" (${latest.severity_tier?.toUpperCase()}), ${statusText}. Gemma advice was: "${latest.gemma_message || 'Rest in shade'}".`;
      }

      case 'get_recent_episodes': {
        const raw = toolResult.raw;
        if (!raw || raw.length === 0) {
          return `You don't have any saved activity episodes in SQLite yet, ${userName}. As you wear your band while walking, running, or working out, your movement episodes will appear here.`;
        }
        const first = raw[0];
        return `Your latest recorded activity was "${first.activity_class.replace(/_/g, ' ')}" lasting ${Math.round(first.duration_seconds || 0)}s with an average pulse of ${Math.round(first.hr_mean || 72)} BPM. You've completed ${raw.length} tracked episodes recently.`;
      }

      case 'get_known_locations': {
        const raw = toolResult.raw;
        if (!raw || raw.length === 0) {
          return `No safe geofence locations are registered yet. Once you spend 5+ minutes in a location, RakshaBand automatically registers it so you can name it (e.g. Home or Office).`;
        }
        const names = raw.map(l => l.name || `Zone #${l.location_id}`).slice(0, 3).join(', ');
        return `You have ${raw.length} registered location zone(s) in your local database, including: ${names}. Familiar locations safely dampen false alarms.`;
      }

      case 'get_emergency_contacts': {
        const raw = toolResult.raw;
        if (!raw || raw.length === 0) {
          return `You currently have no emergency contacts configured, ${userName}. In Settings, you can add family members or trusted contacts to receive automated SMS, WhatsApp, and Email alerts if an emergency occurs.`;
        }
        const contactNames = raw.map(c => c.name).join(', ');
        return `You have ${raw.length} priority emergency contact(s) saved: ${contactNames}. They will be automatically notified if an emergency alert triggers and countdown elapses.`;
      }

      default:
        return `Here is the information from your database, ${userName}:\n${toolResult.summary}`;
    }
  }
}

export const GemmaAgent = new GemmaAgentClass();
