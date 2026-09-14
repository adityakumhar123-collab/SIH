#include "VitalSensor.h"

VitalSensor& VitalSensor::getInstance() {
    static VitalSensor instance;
    return instance;
}

VitalSensor::VitalSensor()
    : isInitialized(false)
    , sampleCount(0)
    , irDcEstimate(50000.0f)
    , redDcEstimate(50000.0f)
    , irAcEstimate(0.0f)
    , redAcEstimate(0.0f)
    , lastPeakTimeMs(0)
    , calculatedHr(72.0f)
    , calculatedSpo2(98.0f)
    , lastFilteredIr(0.0f)
    , peakArm(false) {}

bool VitalSensor::begin() {
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);

    // Check Part ID
    uint8_t partId = 0;
    if (!readRegisters(REG_PART_ID, &partId, 1)) {
        Serial.println("[VitalSensor] Error: Failed to communicate with MAX30102.");
        isInitialized = false;
        return false;
    }

    if (partId != 0x15) {
        Serial.printf("[VitalSensor] Warning: Unexpected Part ID: 0x%02X (Expected 0x15)\n", partId);
    }

    // Reset sensor
    writeRegister(REG_MODE_CONFIG, 0x40);
    delay(100);

    // Configure FIFO: Sample averaging = 4, FIFO roll-on-full = enabled
    writeRegister(REG_FIFO_CONFIG, 0x4F);

    // Mode: SpO2 mode (Red + IR enabled)
    writeRegister(REG_MODE_CONFIG, 0x03);

    // SpO2 Config: ADC Range = 4096nA, Sample Rate = 100 Hz, Pulse Width = 411us (18-bit)
    writeRegister(REG_SPO2_CONFIG, 0x27);

    // LED Current: ~7.2mA for Red and IR (0x24)
    writeRegister(REG_LED1_PA, 0x24);
    writeRegister(REG_LED2_PA, 0x24);

    // Clear pointers
    writeRegister(REG_FIFO_WR_PTR, 0x00);
    writeRegister(REG_OVF_COUNTER, 0x00);
    writeRegister(REG_FIFO_RD_PTR, 0x00);

    isInitialized = true;
    Serial.println("[VitalSensor] MAX30102 initialized successfully at 100 Hz.");
    return true;
}

bool VitalSensor::readSample(VitalData& data) {
    if (!isInitialized) {
        // Return dummy healthy vitals if sensor not connected
        data.red = 60000;
        data.ir = 65000;
        data.heartRate = 72.0f;
        data.spo2 = 98.0f;
        data.signalQuality = 80;
        data.fingerDetected = true;
        return false;
    }

    uint8_t rawBytes[6];
    if (!readRegisters(REG_FIFO_DATA, rawBytes, 6)) {
        return false;
    }

    // Extract 18-bit Red and IR readings from FIFO
    uint32_t rawRed = ((uint32_t)rawBytes[0] << 16) | ((uint32_t)rawBytes[1] << 8) | rawBytes[2];
    rawRed &= 0x03FFFF;

    uint32_t rawIr = ((uint32_t)rawBytes[3] << 16) | ((uint32_t)rawBytes[4] << 8) | rawBytes[5];
    rawIr &= 0x03FFFF;

    data.red = rawRed;
    data.ir = rawIr;

    // Check if finger is placed on sensor (IR baseline threshold)
    if (rawIr < 20000) {
        data.fingerDetected = false;
        data.signalQuality = 0;
        data.heartRate = 0.0f;
        data.spo2 = 0.0f;
        return true;
    }

    data.fingerDetected = true;
    sampleCount++;

    // DC baseline tracking using EWMA
    irDcEstimate = 0.95f * irDcEstimate + 0.05f * (float)rawIr;
    redDcEstimate = 0.95f * redDcEstimate + 0.05f * (float)rawRed;

    // AC signal extraction (High-pass filtered)
    float irAc = (float)rawIr - irDcEstimate;
    float redAc = (float)rawRed - redDcEstimate;

    // Running AC amplitude
    irAcEstimate = 0.98f * irAcEstimate + 0.02f * fabsf(irAc);
    redAcEstimate = 0.98f * redAcEstimate + 0.02f * fabsf(redAc);

    // Dynamic peak detection for Heart Rate (100 Hz) with dicrotic notch suppression
    uint32_t nowMs = millis();
    float dynamicThreshold = fmaxf(150.0f, 0.45f * irAcEstimate);
    if (irAc > dynamicThreshold && irAc > lastFilteredIr && !peakArm) {
        if (lastPeakTimeMs == 0 || (nowMs - lastPeakTimeMs >= 400)) { // Min 400ms refractory period = Max 150 BPM
            peakArm = true;
            if (lastPeakTimeMs > 0) {
                uint32_t deltaMs = nowMs - lastPeakTimeMs;
                if (deltaMs >= 400 && deltaMs <= 1500) { // 40 BPM to 150 BPM
                    float instantaneousHr = 60000.0f / (float)deltaMs;
                    calculatedHr = 0.85f * calculatedHr + 0.15f * instantaneousHr;
                }
            }
            lastPeakTimeMs = nowMs;
        }
    } else if (irAc < 0.0f) {
        peakArm = false;
    }
    lastFilteredIr = irAc;

    // SpO2 calculation via Ratio of Ratios: R = (AC_red / DC_red) / (AC_ir / DC_ir)
    if (irDcEstimate > 1000.0f && redDcEstimate > 1000.0f && irAcEstimate > 10.0f) {
        float r = (redAcEstimate / redDcEstimate) / (irAcEstimate / irDcEstimate);
        // Standard empirical calibration curve: SpO2 = 110 - 25 * R
        float instSpo2 = 110.0f - 25.0f * r;
        if (instSpo2 > 100.0f) instSpo2 = 100.0f;
        if (instSpo2 < 70.0f) instSpo2 = 70.0f;
        calculatedSpo2 = 0.9f * calculatedSpo2 + 0.1f * instSpo2;
    }

    data.heartRate = calculatedHr;
    data.spo2 = calculatedSpo2;

    // Signal quality estimate based on AC/DC modulation ratio
    float snrRatio = (irAcEstimate / irDcEstimate) * 100.0f;
    uint8_t sq = (uint8_t)fminf(fmaxf(snrRatio * 50.0f, 10.0f), 100.0f);
    data.signalQuality = sq;

    return true;
}

bool VitalSensor::writeRegister(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(MAX30102_ADDR);
    Wire.write(reg);
    Wire.write(value);
    return (Wire.endTransmission() == 0);
}

bool VitalSensor::readRegisters(uint8_t reg, uint8_t* buffer, uint8_t length) {
    Wire.beginTransmission(MAX30102_ADDR);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) {
        return false;
    }

    uint8_t count = Wire.requestFrom((uint8_t)MAX30102_ADDR, length);
    if (count != length) {
        return false;
    }

    for (uint8_t i = 0; i < length; i++) {
        buffer[i] = Wire.read();
    }
    return true;
}
