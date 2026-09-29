import { parseIncomingPacket, base64ToUint8Array } from './src/BleService.js';
import { processPpgWaveform } from './src/FeatureExtraction.js';

console.log('=== Testing Packet Serialization & Translation Pipeline ===');

// 1. Test Motion Packet (0x01, 18 bytes)
// [0x01 | ts(4B) | ax(2B) | ay(2B) | az(2B) | gx(2B) | gy(2B) | gz(2B) | chk(1B)]
const motionBuffer = new Uint8Array(18);
motionBuffer[0] = 0x01; // MOTION
const nowTs = 123456;
motionBuffer[1] = nowTs & 0xFF;
motionBuffer[2] = (nowTs >> 8) & 0xFF;
motionBuffer[3] = (nowTs >> 16) & 0xFF;
motionBuffer[4] = (nowTs >> 24) & 0xFF;

// ax = 1000 mg (1.0g), ay = 0, az = 0
const axMg = 1000;
motionBuffer[5] = axMg & 0xFF;
motionBuffer[6] = (axMg >> 8) & 0xFF;

// Gyro: gx = 25.0 dps -> 250 units
const gxUnits = 250;
motionBuffer[11] = gxUnits & 0xFF;
motionBuffer[12] = (gxUnits >> 8) & 0xFF;

let chkMotion = 0;
for (let i = 0; i < 17; i++) chkMotion ^= motionBuffer[i];
motionBuffer[17] = chkMotion;

const parsedMotion = parseIncomingPacket(motionBuffer);
console.log('Parsed Motion:', parsedMotion);
if (!parsedMotion || parsedMotion.type !== 'MOTION' || parsedMotion.timestampMs !== nowTs) {
  throw new Error('Motion packet decoding failed');
}

// 2. Test Environment Packet (0x03, 18 bytes - refined: tempC, humPct, heatIndexF)
const envBuffer = new Uint8Array(18);
envBuffer[0] = 0x03; // ENVIRONMENT
envBuffer[1] = nowTs & 0xFF;
envBuffer[2] = (nowTs >> 8) & 0xFF;
envBuffer[3] = (nowTs >> 16) & 0xFF;
envBuffer[4] = (nowTs >> 24) & 0xFF;

const view = new DataView(envBuffer.buffer);
view.setFloat32(5, 27.5, true);  // tempC
view.setFloat32(9, 60.0, true);  // humPct
view.setFloat32(13, 84.5, true); // heatIndexF

let chkEnv = 0;
for (let i = 0; i < 17; i++) chkEnv ^= envBuffer[i];
envBuffer[17] = chkEnv;

const parsedEnv = parseIncomingPacket(envBuffer);
console.log('Parsed Environment:', parsedEnv);
if (!parsedEnv || parsedEnv.type !== 'ENVIRONMENT' || Math.abs(parsedEnv.tempC - 27.5) > 0.01 || Math.abs(parsedEnv.humidityPct - 60.0) > 0.01 || Math.abs(parsedEnv.heatIndexF - 84.5) > 0.01) {
  throw new Error('Environment packet decoding failed');
}

// 3. Test Vital Packet (0x04, 18 bytes: ts, red, ir, heartRate, spo2, reserved, chk)
const vitalBuffer = new Uint8Array(18);
vitalBuffer[0] = 0x04; // VITAL
vitalBuffer[1] = nowTs & 0xFF;
vitalBuffer[2] = (nowTs >> 8) & 0xFF;
vitalBuffer[3] = (nowTs >> 16) & 0xFF;
vitalBuffer[4] = (nowTs >> 24) & 0xFF;

const vitalView = new DataView(vitalBuffer.buffer);
vitalView.setUint32(5, 45000, true); // Red ADC count
vitalView.setUint32(9, 52000, true); // IR ADC count
vitalView.setInt16(13, 72, true);    // Heart Rate (BPM from Maxim)
vitalBuffer[15] = 98;               // SpO2 (% from Maxim)
vitalBuffer[16] = 0;                // Reserved

let chkVital = 0;
for (let i = 0; i < 17; i++) chkVital ^= vitalBuffer[i];
vitalBuffer[17] = chkVital;

const parsedVital = parseIncomingPacket(vitalBuffer);
console.log('Parsed Vital:', parsedVital);
if (!parsedVital || parsedVital.type !== 'VITAL' || parsedVital.red !== 45000 || parsedVital.ir !== 52000 || parsedVital.heartRate !== 72 || parsedVital.spo2 !== 98) {
  throw new Error('Vital packet decoding failed');
}

// 4. Test Red/IR Preprocessing: PPG Morphology, Arterial Stiffness, Vascular Age, and Continuous Blood Pressure
const synthRed = Array.from({ length: 200 }, (_, i) => 25000 + 400 * Math.sin(2 * Math.PI * 1.2 * (i / 100)));
const synthIr = Array.from({ length: 200 }, (_, i) => 30000 + 1000 * Math.sin(2 * Math.PI * 1.2 * (i / 100)));
const synthImu = Array.from({ length: 200 }, (_, i) => [
  0.1 * Math.sin(i / 10),
  0.1 * Math.cos(i / 10),
  9.8 + (i === 25 ? 4.5 : 0.0), // mechanical spike at i=25
  0.0, 0.0, 0.0
]);

const processedPpg = processPpgWaveform(synthRed, synthIr, synthImu);
console.log('Processed PPG Features:', processedPpg);
if (processedPpg.arterialStiffness === undefined || processedPpg.vascularAge === undefined || !processedPpg.cBP) {
  throw new Error('PPG feature preprocessing failed');
}

console.log('✅ ALL PACKET PIPELINE TESTS PASSED!');
