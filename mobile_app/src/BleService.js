// =============================================================================
// BleService.js — RakshaBand BLE Packet Ingestion & Protocol Decoder
// =============================================================================
//
// Matches ESP32 Firmware (esp firmware/src/BLEManager.cpp):
// 1. Motion Packet (Type 0x01, 18 Bytes, 100 Hz):
//    [0x01 | ts(4B) | ax(2B) | ay(2B) | az(2B) | gx(2B) | gy(2B) | gz(2B) | xor(1B)]
// 2. Status Packet (Type 0x02, 10 Bytes, heartbeat):
//    [0x02 | battery(1B) | fwMajor(1B) | fwMinor(1B) | uptime(4B) | isConn(1B) | xor(1B)]
// 3. Environment Packet (Type 0x03, 18 Bytes, 1 Hz):
//    [0x03 | ts(4B) | temp(4B float) | press(4B float) | hum(4B float) | xor(1B)]
// 4. Vital Packet (Type 0x04, 15 Bytes, 100 Hz):
//    [0x04 | ts(4B) | red(4B) | ir(4B) | signalQuality(1B) | xor(1B)]
// =============================================================================

export const SERVICE_UUID          = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
export const CHAR_UUID_COMMAND     = "c083bcf3-4c9b-44c0-9943-228ae92e8fa4"; // Write
export const CHAR_UUID_DEVICE_INFO = "d2b781e9-4e78-43e9-92c1-d2a84e92a2a0"; // Read
export const CHAR_UUID_STATUS      = "8f1f7e34-bb52-4467-b5cc-fb5a8e03e5c9"; // Notify (0x02)
export const CHAR_UUID_SENSOR      = "c9298492-95b6-455f-8c3a-bb5a8e03e5ca"; // Notify (0x01 Motion)
export const CHAR_UUID_FEATURE     = "e2e0a294-814d-45db-9c3f-bb5a8e03e5cb"; // Notify (0x03 Env & 0x04 Vital)

// Commands to ESP32
export const CMD_START_STREAMING   = 0x01;
export const CMD_STOP_STREAMING    = 0x02;
export const CMD_REQUEST_STATUS    = 0x03;
export const CMD_ACKNOWLEDGE_EVENT = 0x04;
export const CMD_CALIBRATION_REQ   = 0x05;
export const CMD_EMERGENCY_CANCEL  = 0xFF;

// Base64 helper lookup
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

export function base64ToUint8Array(base64) {
  if (!base64) return new Uint8Array(0);
  let bufferLength = base64.length * 0.75;
  if (base64[base64.length - 1] === '=') {
    bufferLength--;
    if (base64[base64.length - 2] === '=') bufferLength--;
  }

  const bytes = new Uint8Array(bufferLength);
  let p = 0;
  for (let i = 0; i < base64.length; i += 4) {
    const enc1 = B64_LOOKUP[base64.charCodeAt(i)];
    const enc2 = B64_LOOKUP[base64.charCodeAt(i + 1)];
    const enc3 = B64_LOOKUP[base64.charCodeAt(i + 2)];
    const enc4 = B64_LOOKUP[base64.charCodeAt(i + 3)];

    bytes[p++] = (enc1 << 2) | (enc2 >> 4);
    if (p < bufferLength) bytes[p++] = ((enc2 & 15) << 4) | (enc3 >> 2);
    if (p < bufferLength) bytes[p++] = ((enc3 & 3) << 6) | (enc4 & 63);
  }
  return bytes;
}

export function encodeSingleByteBase64(byte) {
  const b = byte & 0xFF;
  const c1 = b >> 2;
  const c2 = (b & 3) << 4;
  return B64_CHARS[c1] + B64_CHARS[c2] + '==';
}

// Helpers for little-endian decoding
function readUint32LE(bytes, offset) {
  return (
    (bytes[offset]) |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    ((bytes[offset + 3] << 24) >>> 0)
  );
}

function readInt16LE(bytes, offset) {
  const val = bytes[offset] | (bytes[offset + 1] << 8);
  return val > 32767 ? val - 65536 : val;
}

function readFloat32LE(bytes, offset) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getFloat32(0, true);
}

/**
 * Main packet entry point. Validates XOR checksum and parses into typed object.
 *
 * @param {Uint8Array} bytes
 * @returns {Object|null} Parsed packet or null
 */
export function parseIncomingPacket(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const type = bytes[0];

  let expectedLen = 0;
  if (type === 0x01) expectedLen = 18;       // Motion
  else if (type === 0x02) expectedLen = 10;  // Status
  else if (type === 0x03) expectedLen = 18;  // Environment
  else if (type === 0x04) {
    if (bytes.length === 15) expectedLen = 15;      // Vital
    else if (bytes.length >= 46) expectedLen = 46;  // Legacy feature
  }

  if (expectedLen === 0 || bytes.length < expectedLen) {
    return null;
  }

  // XOR Checksum verification
  const receivedChecksum = bytes[expectedLen - 1];
  let calculatedChecksum = 0;
  for (let i = 0; i < expectedLen - 1; i++) {
    calculatedChecksum ^= bytes[i];
  }

  if (calculatedChecksum !== receivedChecksum) {
    console.warn(`[BLE] Checksum mismatch for type 0x${type.toString(16)}`);
    return null;
  }

  switch (type) {
    case 0x01:
      return parseMotionPacket(bytes);
    case 0x02:
      return parseStatusPacket(bytes);
    case 0x03:
      return parseEnvironmentPacket(bytes);
    case 0x04:
      return bytes.length === 15 ? parseVitalPacket(bytes) : parseLegacyFeaturePacket(bytes);
    default:
      return null;
  }
}

// 0x01 Motion Packet (18 Bytes)
function parseMotionPacket(bytes) {
  const timestampMs = readUint32LE(bytes, 1);
  const axMg = readInt16LE(bytes, 5);
  const ayMg = readInt16LE(bytes, 7);
  const azMg = readInt16LE(bytes, 9);
  const gxUnits = readInt16LE(bytes, 11);
  const gyUnits = readInt16LE(bytes, 13);
  const gzUnits = readInt16LE(bytes, 15);

  // Physical units:
  // Accel in m/s^2 (1000 mg = 9.80665 m/s^2)
  const ax = (axMg / 1000.0) * 9.80665;
  const ay = (ayMg / 1000.0) * 9.80665;
  const az = (azMg / 1000.0) * 9.80665;
  // Gyro in dps (0.1 dps units)
  const gx = gxUnits / 10.0;
  const gy = gyUnits / 10.0;
  const gz = gzUnits / 10.0;

  const resultantMps2 = Math.sqrt(ax * ax + ay * ay + az * az);

  return {
    type: 'MOTION',
    timestampMs,
    ax: Number(ax.toFixed(4)),
    ay: Number(ay.toFixed(4)),
    az: Number(az.toFixed(4)),
    gx: Number(gx.toFixed(2)),
    gy: Number(gy.toFixed(2)),
    gz: Number(gz.toFixed(2)),
    resultantMps2: Number(resultantMps2.toFixed(4)),
    rawMg: [axMg, ayMg, azMg]
  };
}

// 0x02 Status Packet (10 Bytes)
function parseStatusPacket(bytes) {
  const batteryPct = bytes[1];
  const fwMajor = bytes[2];
  const fwMinor = bytes[3];
  const uptimeSec = readUint32LE(bytes, 4);
  const isBleConnected = bytes[8] === 1;

  return {
    type: 'STATUS',
    batteryPct,
    fwVersion: `v${fwMajor}.${fwMinor}`,
    uptimeMinutes: Math.round(uptimeSec / 60),
    isBleConnected
  };
}

// 0x03 Environment Packet (18 Bytes)
function parseEnvironmentPacket(bytes) {
  const timestampMs = readUint32LE(bytes, 1);
  const tempC = readFloat32LE(bytes, 5);
  const pressureHpa = readFloat32LE(bytes, 9);
  const humidityPct = readFloat32LE(bytes, 13);

  return {
    type: 'ENVIRONMENT',
    timestampMs,
    tempC: Number(tempC.toFixed(2)),
    pressureHpa: Number(pressureHpa.toFixed(1)),
    humidityPct: Number(humidityPct.toFixed(1))
  };
}

// 0x04 Vital Packet (15 Bytes)
function parseVitalPacket(bytes) {
  const timestampMs = readUint32LE(bytes, 1);
  const red = readUint32LE(bytes, 5);
  const ir = readUint32LE(bytes, 9);
  const signalQuality = bytes[13];

  return {
    type: 'VITAL',
    timestampMs,
    red,
    ir,
    signalQuality
  };
}

// Legacy 46-byte Feature Packet (backward compatibility)
function parseLegacyFeaturePacket(bytes) {
  return {
    type: 'LEGACY_FEATURE',
    seq: bytes[1],
    anomalyScore: bytes[2] * 0.00441764,
    motionState: bytes[3],
    dominantFreq: bytes[4] * 0.5,
    wearConfidence: bytes[9],
    peakAccel: bytes[10] | (bytes[11] << 8),
    isThreat: bytes[30] === 1
  };
}
