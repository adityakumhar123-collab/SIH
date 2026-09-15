// =============================================================================
// hooks/useBle.js — The Core BLE Connection & Data Pipeline Hook
// =============================================================================
//
// DRY RUN / ARCHITECTURE OVERVIEW
// --------------------------------
// useBle is the central nervous system of the SafeBand app. It is a React
// custom hook that manages the entire BLE lifecycle and routes every incoming
// packet to the right destination.
//
// WHO CALLS THIS:
//   → App.js instantiates this hook once at the top level and passes its
//     return values down to all tabs and sub-hooks as props.
//
// WHAT IT DOES:
//   1. Initializes the BleManager (react-native-ble-plx) on mount
//   2. Manages the BLE state machine: DISCONNECTED → SCANNING → CONNECTING → CONNECTED
//   3. On connect: negotiates MTU (64 bytes), reads Device Info, subscribes to
//      all 4 notification characteristics (EVENT, STATUS, SENSOR, FEATURE)
//   4. On every BLE notification: decodes the packet via BleService.js, then:
//      - MOTION/VITAL/ENV → EpisodeEngine.pushSample() → EpisodeEngine.processWindow()
//      - FEATURE/EVENT → setCurrentPacket() to update React state for the dashboard
//      - SENSOR → setStreamData() to update the live IMU waveform graph
//      - STATUS → updates battery, wear confidence, uptime in React state
//      - All types → addLog() to append to the system log panel
//   5. Exposes sendBleCommand() to write a single byte to the COMMAND characteristic
//   6. Exposes toggleStreaming() to start/stop the high-rate SENSOR stream
//
// FILES USED:
//   → BleService.js      for: parseIncomingPacket, UUIDs, base64ToUint8Array,
//                              encodeSingleByteBase64
//   → EpisodeEngine.js   for: EpisodeEngine sample ingestion and window processing
//   → LocationEngine.js  for: LocationEngine.currentGps, LocationEngine.estimateFamiliarity()
//
// OUTPUT (what this hook returns to App.js):
//   → connectionState: 'DISCONNECTED' | 'SCANNING' | 'CONNECTING' | 'CONNECTED'
//   → devices: scanned SafeBand devices (shown in connection modal)
//   → currentPacket: latest FEATURE/EVENT parsed data (feeds DashboardTab.js)
//   → streamData: last 50 SENSOR frames (feeds the IMU waveform graph)
//   → wearConfidence, batteryPct, uptime: device health values
//   → startScanning, stopScanning, connectToDevice, handleDisconnect: BLE control
//   → sendBleCommand, toggleStreaming: command and streaming control
//
// TIMING:
//   - FEATURE packets arrive at 2 Hz → currentPacket updates every 500ms
//   - SENSOR packets arrive at ~25 Hz → streamData updates at most every 200ms
//     (throttled by lastGraphUpdateRef to avoid React re-render flooding)
//   - STATUS heartbeat arrives every ~30s
//   - EVENT packets are sporadic — only when anomaly is confirmed (3 windows)
//
// BUGS / NOTES:
//   ⚠ handleIncomingPacket is defined as a regular function inside the hook,
//     which means it captures the "stale" isStreaming value from its creation
//     closure. However, activeTabRef.current IS used (instead of activeTab state)
//     specifically to avoid this problem for the tab check. The isStreaming check
//     on line 151 uses the `isStreaming` state variable directly — if isStreaming
//     changes after the handler is set up (but before it fires), the old value
//     may be used. This is a minor issue since the 200ms throttle is the main guard.
//   ⚠ The EVENT packet branch (parsed.type === 'EVENT') does NOT update the
//     sequenceId in the setCurrentPacket call (unlike the FEATURE branch). This
//     means the PCA plot's sequenceId de-duplication won't work for EVENT packets.
//     EVENT packets are rare, so this is unlikely to cause visible PCA issues.
// =============================================================================

import { useState, useEffect, useRef } from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import {
  parseIncomingPacket,     // Decodes raw bytes → typed JS packet object
  SERVICE_UUID,            // Top-level GATT service UUID
  CHAR_UUID_COMMAND,       // UUID for writing commands to device
  CHAR_UUID_DEVICE_INFO,   // UUID for reading firmware version string on connect
  CHAR_UUID_STATUS,        // UUID for heartbeat/status notifications (0x02 packets)
  CHAR_UUID_SENSOR,        // UUID for raw IMU stream notifications (0x03 packets)
  CHAR_UUID_FEATURE,       // UUID for TinyML inference result notifications (0x04 packets)
  base64ToUint8Array,      // Converts BLE characteristic value (Base64) → Uint8Array
  encodeSingleByteBase64,  // Encodes a command byte → Base64 for BLE write
} from '../BleService';
import { EpisodeEngine } from '../EpisodeEngine.js';
import { LocationEngine } from '../LocationEngine.js';

// Decodes a Base64 characteristic value into a human-readable ASCII string.
// Used to read the DEVICE_INFO characteristic as text (firmware version, etc.)
function decodeBase64ToString(base64) {
  const bytes = base64ToUint8Array(base64);
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return str;
}

// Requests Android BLE runtime permissions.
// On Android 12+ (API 31+), requires BLUETOOTH_SCAN + BLUETOOTH_CONNECT + LOCATION.
// On Android 11 and below, only ACCESS_FINE_LOCATION is required.
// On iOS, permissions are handled by the OS dialog on first scan — returns true.
async function requestBluetoothPermissions() {
  if (Platform.OS === 'ios') {
    return true; // iOS handles BLE permissions via Info.plist + OS dialog automatically
  }
  if (Platform.OS === 'android') {
    try {
      if (Platform.Version >= 31) {
        // Android 12+ requires explicit BLE permissions
        const granted = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]);
        return (
          granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN] === PermissionsAndroid.RESULTS.GRANTED &&
          granted[PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT] === PermissionsAndroid.RESULTS.GRANTED &&
          granted[PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION] === PermissionsAndroid.RESULTS.GRANTED
        );
      } else {
        // Android 11 and below only need location permission for BLE scanning
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      }
    } catch (err) {
      console.warn('[BLE] Permission request error:', err);
      return false;
    }
  }
  return false;
}

// =============================================================================
// MAIN HOOK
// @param activeTab - current visible tab ('DASHBOARD' | 'CONTACTS' | 'SETTINGS')
// @param addLog    - function from App.js to append a message to the log panel
// =============================================================================
export default function useBle(activeTab, addLog) {
  // --- BLE Connection State ---
  // Drives which UI is shown in the connection modal and the status indicator
  const [connectionState, setConnectionState] = useState('DISCONNECTED');

  // List of discovered SafeBand devices during scanning (shown in the device list modal)
  const [devices, setDevices] = useState([]);

  // The currently connected react-native-ble-plx Device object.
  // Used to write commands and monitor characteristics.
  const [activeDevice, setActiveDevice] = useState(null);

  // Any BLE-level error message to display in the UI (e.g. "Connection failed")
  const [bleError, setBleError] = useState(null);

  // --- SafeBand Device State (updated from STATUS and FEATURE packets) ---
  const [wearConfidence, setWearConfidence] = useState(100); // % — 0 = unworn
  const [batteryPct, setBatteryPct] = useState(98);          // % battery remaining
  const [uptime, setUptime] = useState(12);                  // Minutes since last boot

  // --- Sensor Streaming State ---
  // isStreaming controls whether SENSOR (raw IMU) packets are requested from the device.
  // When true, device sends 0x03 packets at ~25 Hz for the waveform graph.
  const [isStreaming, setIsStreaming] = useState(true);

  // Ring buffer of last 50 SENSOR frames — used to draw the live IMU waveform graph.
  // Each element is a parsed SENSOR packet object (ax, ay, az, resultant, etc.)
  const [streamData, setStreamData] = useState([]);

  // --- Current TinyML Inference Packet ---
  // Holds the most recent FEATURE or EVENT packet values. React state, so any
  // component that reads this will re-render when it changes.
  // DashboardTab.js reads this to update all the gauges and the PCA plot.
  const [currentPacket, setCurrentPacket] = useState({
    activityClass: 'standing',
    activityConfidence: 1.0,
    hr: 72,
    spo2: 98.0,
    hrv: 45.0,
    tempC: 24.0,
    heatIndexF: 75.0,
    heatIndexTier: 'NORMAL',
    diagnostic: null,
    latestGuidance: EpisodeEngine.latestGuidance || null,
    anomalyScore: 0.1060,
    peakAccel: 1000,
    wearConfidence: 100,
    motionState: 1,
    motionEmbedding: new Array(32).fill(0),
  });

  // Keep latestGuidance state in sync with EpisodeEngine async generation
  useEffect(() => {
    const handleGuidance = (guidance) => {
      setCurrentPacket((prev) => ({
        ...prev,
        latestGuidance: guidance
      }));
    };
    EpisodeEngine.addGuidanceListener(handleGuidance);
    return () => {
      EpisodeEngine.removeGuidanceListener(handleGuidance);
    };
  }, []);

  // --- Refs ---
  // bleManagerRef: holds the react-native-ble-plx BleManager instance.
  // It must be a ref (not state) because we need a stable reference
  // without causing re-renders, and it must survive across useEffect cleanups.
  const bleManagerRef = useRef(null);

  // activeTabRef: mirrors the activeTab prop as a ref so that the BLE packet
  // handler (which is set up in an async closure) can always read the current tab
  // without being affected by React's closure capture of the initial value.
  const activeTabRef = useRef(activeTab);

  // lastGraphUpdateRef: timestamp of last streamData update. Used to throttle
  // the SENSOR stream to at most 5 updates/second (every 200ms) to prevent
  // too many React re-renders from the 25Hz raw IMU stream.
  const lastGraphUpdateRef = useRef(0);
  const featureLogCounterRef = useRef(0);

  // Keep activeTabRef in sync with the activeTab prop (updates on every tab switch)
  useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);

  // =============================================================================
  // BleManager Lifecycle Effect
  // Creates the BleManager instance once on mount, and destroys it on unmount
  // to cleanly release the native BLE resource.
  // =============================================================================
  useEffect(() => {
    let BleManagerClass = null;
    try {
      // Dynamic require: react-native-ble-plx is a native module that only works
      // in a custom dev build (not standard Expo Go). This try/catch prevents
      // the app from crashing in environments where the native module is missing.
      const BLE = require('react-native-ble-plx');
      BleManagerClass = BLE.BleManager;
    } catch (e) {
      console.log('[BLE] react-native-ble-plx is not available in standard Expo Go.');
    }

    if (BleManagerClass) {
      try {
        bleManagerRef.current = new BleManagerClass();
        console.log('[BLE] BleManager initialized successfully.');
      } catch (err) {
        console.warn('[BLE] BleManager constructor failed:', err);
      }
    }

    // Cleanup: destroy the BleManager when this hook unmounts (app closed/navigated away)
    return () => {
      if (bleManagerRef.current) {
        bleManagerRef.current.destroy();
        console.log('[BLE] BleManager destroyed.');
      }
    };
  }, []); // Empty deps: runs only once on mount

  // =============================================================================
  // PACKET HANDLER & PIPELINE ROUTING
  // =============================================================================
  // Invoked on every valid BLE characteristic notification. Routes incoming
  // packets based on their 1-byte header:
  //
  // 1. TYPE 0x01 (MOTION - 100 Hz):
  //    - Pushes raw 6-DoF sample [ax, ay, az, gx, gy, gz] to EpisodeEngine buffer.
  //    - Throttles UI waveform updates to 5 Hz (every 200ms) to conserve the JS thread.
  //    - Triggers EpisodeEngine.processWindow() every 50 samples (2.0 Hz inference rate).
  //    - When a 2.0s window finishes, unpacks:
  //        * Activity classification & confidence (Model v3 21-class)
  //        * Physiological vitals (HR, SpO2, HRV) from PPG
  //        * NOAA Heat Index & risk tier
  //        * Clinical Diagnostic Contract from DiagnosticReasoningEngine
  //        * Updates `currentPacket` React state, which triggers App.js Loop 2.
  //
  // 2. TYPE 0x02 (STATUS / HEARTBEAT - ~30s):
  //    - Updates `batteryPct`, `uptime`, and logs firmware version.
  //
  // 3. TYPE 0x03 (ENVIRONMENT - 1 Hz):
  //    - Pushes ambient temperature, pressure, humidity to EpisodeEngine.
  //
  // 4. TYPE 0x04 (VITALS / PPG - 100 Hz):
  //    - Pushes raw MAX30102 Red & IR photodiode counts to EpisodeEngine.
  // =============================================================================
  const handleIncomingPacket = (parsed) => {
    if (!parsed) return;

    if (parsed.type === 'MOTION') {
      // Feed raw IMU sample into the 200-sample sliding window buffer
      EpisodeEngine.pushMotionSample([parsed.ax, parsed.ay, parsed.az, parsed.gx, parsed.gy, parsed.gz]);

      // Throttle graph waveform updates to 5 Hz (every 200ms) for UI smoothness
      if (isStreaming && activeTabRef.current === 'DASHBOARD') {
        const now = Date.now();
        if (now - lastGraphUpdateRef.current > 200) {
          lastGraphUpdateRef.current = now;
          setStreamData((prevData) => {
            const frame = {
              ax: parsed.rawMg ? parsed.rawMg[0] : Math.round(parsed.ax * 101.97),
              ay: parsed.rawMg ? parsed.rawMg[1] : Math.round(parsed.ay * 101.97),
              az: parsed.rawMg ? parsed.rawMg[2] : Math.round(parsed.az * 101.97),
              resultant: Math.round(parsed.resultantMps2 * 101.97),
              anomalyScore: 0
            };
            const newData = [...prevData, frame];
            if (newData.length > 50) newData.shift();
            return newData;
          });
        }
      }

      // Process 200-sample window if accumulated (every 50 samples = 2 Hz tick)
      try {
        const windowResult = EpisodeEngine.processWindow();
        if (windowResult) {
          // Commit inferred features and clinical diagnostics to React state
          setCurrentPacket((prev) => ({
            ...prev,
            activityClass: windowResult.activityClass,
            activityConfidence: windowResult.activityConfidence,
            hr: windowResult.vitals.hr,
            spo2: windowResult.vitals.spo2,
            hrv: windowResult.vitals.hrv,
            tempC: EpisodeEngine.latestEnv.tempC,
            humidityPct: EpisodeEngine.latestEnv.humPct,
            pressureHpa: EpisodeEngine.latestEnv.pressHpa,
            heatIndexF: windowResult.heatIndex.heatIndexF,
            heatIndexTier: windowResult.heatIndex.tier,
            diagnostic: windowResult.diagnostic,
            latestGuidance: windowResult.latestGuidance || EpisodeEngine.latestGuidance,
            anomalyScore: windowResult.physEval ? Number((windowResult.physEval.distance / 4.0).toFixed(3)) : 0.1,
            peakAccel: Math.round(windowResult.peakAccelMg),
            wearConfidence: 100
          }));

          // Log diagnostic hypothesis shifts to Diagnostics Terminal
          if (windowResult.diagnostic && windowResult.diagnostic.primary_hypothesis !== 'ANOMALY_UNCLEAR') {
            addLog(
              `🧠 Diagnostic Engine: ${windowResult.diagnostic.primary_hypothesis} (${(windowResult.diagnostic.confidence * 100).toFixed(0)}%) [${windowResult.diagnostic.severity_tier.toUpperCase()}] — Evidence: ${windowResult.diagnostic.contributing_evidence.join('; ')}`,
              'CONTEXT'
            );
          }
        }
      } catch (err) {
        console.warn('[BLE] EpisodeEngine window processing failed:', err);
      }
    } else if (parsed.type === 'VITAL') {
      // Ingest raw 100 Hz photodiode counts
      EpisodeEngine.pushVitalSample(parsed.red, parsed.ir);
    } else if (parsed.type === 'ENVIRONMENT') {
      // Ingest ambient BMP280 atmospheric readings
      EpisodeEngine.pushEnvironmentSample(parsed.tempC, parsed.pressureHpa, parsed.humidityPct);
      setCurrentPacket((prev) => ({
        ...prev,
        tempC: parsed.tempC,
        pressureHpa: parsed.pressureHpa,
        humidityPct: parsed.humidityPct
      }));
    } else if (parsed.type === 'STATUS') {
      // Ingest periodic device health heartbeat
      if (parsed.batteryPct !== undefined) setBatteryPct(parsed.batteryPct);
      if (parsed.uptimeMinutes !== undefined) setUptime(parsed.uptimeMinutes);
      addLog(`Status: Battery=${parsed.batteryPct}%, Uptime=${parsed.uptimeMinutes}m, FW=${parsed.fwVersion}`, 'SYSTEM');
    } else if (parsed.type === 'LEGACY_FEATURE') {
      // Compatibility fallback
      setCurrentPacket((prev) => ({
        ...prev,
        anomalyScore: parsed.anomalyScore,
        peakAccel: parsed.peakAccel,
        wearConfidence: parsed.wearConfidence
      }));
    }
  };

  // Refs to always hold the latest version of handler callbacks,
  // preventing stale closures inside the persistent BLE notification monitor callbacks.
  const handleIncomingPacketRef = useRef(handleIncomingPacket);
  handleIncomingPacketRef.current = handleIncomingPacket;

  const addLogRef = useRef(addLog);
  addLogRef.current = addLog;

  // =============================================================================
  // BLE Scanning
  // Starts scanning for nearby BLE devices advertising the SafeBand service UUID.
  // Filters by device name ("SafeBand-ESP32" or "SafeBand-IMU") or service UUID.
  // =============================================================================
  const startScanning = async () => {
    if (!bleManagerRef.current) {
      setBleError('BLE is not supported in Expo Go. Please switch back to Simulation Mode.');
      return;
    }

    const hasPermissions = await requestBluetoothPermissions();
    if (!hasPermissions) {
      setBleError('Bluetooth & location permissions are required for scanning.');
      return;
    }

    setDevices([]);
    setBleError(null);
    setConnectionState('SCANNING');

    try {
      bleManagerRef.current.startDeviceScan(
        null,  // null = scan for all services (we filter by name/UUID in the callback)
        null,  // null = use default scan options
        (error, device) => {
          if (error) {
            console.error('[BLE] Scan error:', error);
            setBleError(error.message);
            setConnectionState('DISCONNECTED');
            return;
          }

          if (device) {
            // Filter: only show RakshaBand / SafeBand devices by name or service UUID match
            const isTargetDevice =
              device.name === 'RakshaBand-ESP32' ||
              device.name === 'SafeBand-ESP32' ||
              device.name === 'SafeBand-IMU' ||
              device.name?.startsWith('RakshaBand') ||
              device.name?.startsWith('SafeBand') ||
              (device.serviceUUIDs && device.serviceUUIDs.includes(SERVICE_UUID));

            if (isTargetDevice) {
              setDevices((prevDevices) => {
                // Avoid duplicates — check by device ID before adding
                if (prevDevices.some((d) => d.id === device.id)) {
                  return prevDevices;
                }
                return [...prevDevices, {
                  id: device.id,
                  name: device.name || 'RakshaBand-ESP32',
                  rssi: device.rssi   // Signal strength (dBm) for display
                }];
              });
            }
          }
        }
      );
    } catch (err) {
      console.error('[BLE] Start scan failed:', err);
      setBleError(err.message);
      setConnectionState('DISCONNECTED');
    }
  };

  const stopScanning = () => {
    if (bleManagerRef.current) {
      bleManagerRef.current.stopDeviceScan();
    }
    if (connectionState === 'SCANNING') {
      setConnectionState('DISCONNECTED');
    }
  };

  // =============================================================================
  // BLE Connection — The Full Connection Setup Sequence
  //
  // Step-by-step when connectToDevice() is called:
  //   1. Stop any ongoing scan
  //   2. Connect to the selected device (by ID)
  //   3. Wait 800ms for connection to stabilize (Android firmware quirk)
  //   4. Negotiate MTU = 64 bytes (prevents packet fragmentation for 34-byte packets)
  //   5. Discover all services and characteristics (builds the GATT table)
  //   6. Initialize EpisodeEngine (clears buffers, loads active episodes)
  //   7. Read DEVICE_INFO characteristic (one-time firmware version string)
  //   8. Subscribe to EVENT, STATUS, SENSOR, FEATURE characteristics
  //   9. Wait 1500ms for BLE descriptor subscriptions to stabilize
  //  10. Send START_STREAM command (0x01) to begin receiving packets from the device
  //  11. Register disconnect handler to clean up state if connection drops
  // =============================================================================
  const connectToDevice = async (deviceId) => {
    stopScanning();
    setConnectionState('CONNECTING');
    setBleError(null);

    try {
      if (!bleManagerRef.current) throw new Error('BleManager not initialized');

      console.log('[BLE] Connecting to device:', deviceId);
      const device = await bleManagerRef.current.connectToDevice(deviceId, { autoConnect: false });

      console.log('[BLE] Connected. Waiting for connection to stabilize...');
      // 800ms delay: Required on Android to let the BLE link fully establish before
      // attempting MTU negotiation. Skipping this causes intermittent failures.
      await new Promise((resolve) => setTimeout(resolve, 800));

      try {
        // MTU = Maximum Transmission Unit. Default BLE MTU is 23 bytes (too small
        // for our 34-byte EVENT packets). We request 64 bytes to fit all packets
        // in a single BLE notification without fragmentation.
        await device.requestMTU(64);
        console.log('[BLE] MTU negotiated to 64 bytes.');
        addLog('MTU negotiated: 64 bytes — packet fragmentation prevented.', 'SYSTEM');
      } catch (mtuErr) {
        // MTU negotiation failure is non-fatal — packets will still work but may
        // fragment and cause occasional checksum mismatches on large packets.
        console.warn('[BLE] MTU negotiation failed (non-fatal):', mtuErr.message);
        addLog(`MTU negotiation warning: ${mtuErr.message}`, 'SYSTEM');
      }

      console.log('[BLE] Discovering services and characteristics...');
      const discoveredDevice = await device.discoverAllServicesAndCharacteristics();

      setActiveDevice(discoveredDevice);
      setConnectionState('CONNECTED');
      try {
        EpisodeEngine.initialize();
        LocationEngine.initialize();
      } catch (err) {
        console.warn('[BLE] Failed to initialize EpisodeEngine/LocationEngine:', err);
      }
      setDevices([]); // Clear the scan list — no longer needed

      // Read the Device Info characteristic (firmware version, model info string)
      try {
        const charInfo = await discoveredDevice.readCharacteristicForService(
          SERVICE_UUID,
          CHAR_UUID_DEVICE_INFO
        );
        if (charInfo && charInfo.value) {
          const rawString = decodeBase64ToString(charInfo.value);
          console.log('[BLE] Connected Device Info:', rawString);
          addLog(`Device Info: ${rawString}`, 'SYSTEM');
        }
      } catch (err) {
        console.warn('[BLE] Read firmware version failed:', err);
      }

      // Factory function: creates a notification handler + subscription reference pair.
      // The `active` flag and the `subscription` ref allow the handler to safely
      // stop itself after a disconnection error without calling remove() too early.
      const makeNotifyHandler = (charName) => {
        let subscription = null;
        let active = true; // Becomes false on the first error to prevent re-entrancy
        const handler = (error, characteristic) => {
          if (!active) return; // Already deactivated — do nothing
          if (error) {
            active = false;
            // errorCode 2 = "Device disconnected" — expected, no need to log it
            if (error.errorCode !== 2) {
              console.error(`[BLE] ${charName} notification error:`, error.message);
              addLogRef.current(`BLE error on ${charName}: ${error.message}`, 'SYSTEM');
            }
            // Defer subscription removal to avoid calling remove() from within the callback
            setTimeout(() => {
              if (subscription) {
                try {
                  subscription.remove();
                } catch (subErr) {
                  console.warn(`[BLE] Failed to remove subscription for ${charName}:`, subErr);
                }
              }
            }, 0);
            return;
          }
          try {
            if (characteristic && characteristic.value) {
              console.log(`[BLE] Received notify on ${charName}: base64 len = ${characteristic.value.length}`);
              // Decode Base64 → raw bytes → parse as a SafeBand packet
              const bytes = base64ToUint8Array(characteristic.value);
              console.log(`[BLE] Decoded ${charName} bytes len = ${bytes.length}: [${Array.from(bytes).join(', ')}]`);
              const parsed = parseIncomingPacket(bytes);
              if (parsed) {
                console.log(`[BLE] Parsed ${charName} successfully:`, JSON.stringify(parsed));
                handleIncomingPacketRef.current(parsed); // Route to the latest handler to prevent stale closures
              } else {
                console.warn(`[BLE] Failed to parse ${charName} packet (ignored)`);
              }
            }
          } catch (handlerErr) {
            console.error(`[BLE] Error handling characteristic notification for ${charName}:`, handlerErr);
            addLogRef.current(`Error handling ${charName}: ${handlerErr.message}`, 'SYSTEM');
          }
        };
        return {
          handler,
          setSubscription: (sub) => { subscription = sub; } // Called after monitor() returns
        };
      };

      // Enumerate all characteristics in the SafeBand GATT service for direct lookup
      let discoveredChars = [];
      try {
        discoveredChars = await discoveredDevice.characteristicsForService(SERVICE_UUID);
        console.log(`[BLE] GATT: Discovered ${discoveredChars.length} characteristics in service.`);
        addLog(`GATT: Discovered ${discoveredChars.length} characteristics in service.`, 'SYSTEM');
      } catch (charErr) {
        console.warn(`[BLE] GATT enumeration failed: ${charErr.message}`);
        addLog(`GATT enumeration failed: ${charErr.message} — falling back to UUID monitor.`, 'SYSTEM');
      }

      // Build a UUID → characteristic object lookup map for O(1) access
      const charByUUID = {};
      for (const c of discoveredChars) {
        charByUUID[c.uuid.toLowerCase()] = c;
      }

      // List of characteristics to subscribe to for notifications
      const NOTIFY_TARGETS = [
        { uuid: CHAR_UUID_STATUS,  name: 'STATUS'  }, // Heartbeat (0x02)
        { uuid: CHAR_UUID_SENSOR,  name: 'SENSOR'  }, // Raw IMU stream (0x03)
        { uuid: CHAR_UUID_FEATURE, name: 'FEATURE' }, // TinyML inference results (0x04)
      ];

      let monitoredCount = 0;
      for (const { uuid, name } of NOTIFY_TARGETS) {
        const char = charByUUID[uuid.toLowerCase()];
        const helper = makeNotifyHandler(name);
        if (char) {
          // Preferred path: use the pre-discovered characteristic object directly
          const sub = char.monitor(helper.handler);
          helper.setSubscription(sub);
          monitoredCount++;
        } else {
          // Fallback path: use the service-level monitor method with UUID string
          // (works even if GATT enumeration partially failed)
          try {
            const sub = discoveredDevice.monitorCharacteristicForService(SERVICE_UUID, uuid, helper.handler);
            helper.setSubscription(sub);
            monitoredCount++;
          } catch (monErr) {
            console.warn(`[BLE] WARNING: ${name} char not found in service:`, monErr.message);
            addLog(`WARNING: ${name} char not found in service (UUID: ${uuid.slice(0,8)}...)`, 'SYSTEM');
          }
        }
      }

      console.log(`[BLE] Connected. Monitoring ${monitoredCount}/3 characteristics (STATUS, SENSOR, FEATURE).`);
      addLog(`Connected. Monitoring ${monitoredCount}/3 characteristics (STATUS, SENSOR, FEATURE).`, 'SYSTEM');

      // Do not auto-start high-rate sensor streaming on connect to prevent flooding the BLE link
      // and causing early disconnections. The user can toggle streaming manually.
      setIsStreaming(false);

      // Register disconnect handler: cleans up state if device drops connection unexpectedly
      bleManagerRef.current.onDeviceDisconnected(deviceId, (error, d) => {
        console.log('[BLE] Device disconnected on connection loss.');
        setActiveDevice(null);
        setConnectionState('DISCONNECTED');
        setIsStreaming(false);
        setWearConfidence(0);
        setCurrentPacket({
          activityClass: 'standing',
          activityConfidence: 1.0,
          hr: 72,
          spo2: 98.0,
          hrv: 45.0,
          tempC: 24.0,
          heatIndexF: 75.0,
          heatIndexTier: 'NORMAL',
          diagnostic: null,
          isDirectEscalation: false,
          anomalyScore: 0.05,
          peakAccel: 1000,
          wearConfidence: 0,
          motionState: 1,
          motionEmbedding: new Array(32).fill(0),
        });
        addLog('Device disconnected. Sensor telemetry and threat monitoring reset to IDLE.', 'SYSTEM');
      });

    } catch (err) {
      console.error('[BLE] Connection error:', err);
      setBleError(err.message || 'Connection failed.');
      setConnectionState('DISCONNECTED');
    }
  };

  // Gracefully disconnects from the active device and resets all connection state
  const handleDisconnect = async () => {
    if (activeDevice) {
      try {
        await activeDevice.cancelConnection();
      } catch (err) {
        console.log('[BLE] Connection cancellation error:', err);
      }
    }
    setActiveDevice(null);
    setConnectionState('DISCONNECTED');
    setDevices([]);
    setIsStreaming(false);
    setWearConfidence(0);
    setCurrentPacket({
      activityClass: 'standing',
      activityConfidence: 1.0,
      hr: 72,
      spo2: 98.0,
      hrv: 45.0,
      tempC: 24.0,
      heatIndexF: 75.0,
      heatIndexTier: 'NORMAL',
      diagnostic: null,
      isDirectEscalation: false,
      anomalyScore: 0.05,
      peakAccel: 1000,
      wearConfidence: 0,
      motionState: 1,
      motionEmbedding: new Array(32).fill(0),
    });
    addLog('Disconnected by user. Threat monitoring reset to IDLE.', 'SYSTEM');
  };

  // Writes a single-byte command to the COMMAND characteristic.
  // Used by: toggleStreaming(), cancelEmergency(), and direct command buttons.
  // Returns true on success, false on failure (no connection or write error).
  const sendBleCommand = async (commandByte) => {
    if (connectionState !== 'CONNECTED' || !activeDevice) {
      console.log('[BLE] Command skipped: No active connection.');
      return false;
    }

    try {
      const base64Value = encodeSingleByteBase64(commandByte); // Encode to Base64
      await activeDevice.writeCharacteristicWithResponseForService(
        SERVICE_UUID,
        CHAR_UUID_COMMAND,
        base64Value
      );
      console.log(`[BLE] Sent command 0x${commandByte.toString(16).toUpperCase()}`);
      return true;
    } catch (err) {
      console.error('[BLE] Command write error:', err);
      setBleError(`Command error: ${err.message}`);
      return false;
    }
  };

  // Toggles the IMU sensor data stream on/off.
  // Sends 0x01 = start stream, 0x02 = stop stream to the device.
  // Only sends the command if actually connected (no-op otherwise).
  const toggleStreaming = async () => {
    const nextStreamingState = !isStreaming;
    setIsStreaming(nextStreamingState);
    if (connectionState === 'CONNECTED') {
      await sendBleCommand(nextStreamingState ? 0x01 : 0x02);
    }
  };

  // =============================================================================
  // Return Value — All state and callbacks exposed to App.js (and passed as props
  // to DashboardTab, SettingsTab, and useEmergency)
  // =============================================================================
  return {
    connectionState,    // Current BLE state machine state
    devices,            // Scanned SafeBand devices (for the device list modal)
    activeDevice,       // The connected BLE device object (or null)
    bleError,           // Error message string (or null)
    wearConfidence,     // % wristband wear confidence (from STATUS/FEATURE packets)
    batteryPct,         // % battery (from STATUS/EVENT packets)
    uptime,             // Minutes since last boot (from STATUS packets)
    isStreaming,        // Whether SENSOR stream is active
    streamData,         // Last 50 SENSOR frames (for IMU waveform graph)
    currentPacket,      // Latest FEATURE/EVENT data (feeds all dashboard gauges)
    setStreamData,      // Allows manual clearing of the waveform graph
    setCurrentPacket,   // Allows useEmergency to reset packet after cancel
    setWearConfidence,  // Allows useEmergency to update wear state
    setBatteryPct,      // Exposed for potential future use
    setUptime,          // Exposed for potential future use
    startScanning,      // Start BLE scan
    stopScanning,       // Stop BLE scan
    connectToDevice,    // Connect to a specific device by ID
    handleDisconnect,   // Graceful disconnect
    sendBleCommand,     // Write a single-byte command to the device
    toggleStreaming,    // Toggle IMU stream on/off
  };
}
