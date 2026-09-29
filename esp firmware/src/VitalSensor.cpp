#include "VitalSensor.h"
#include "MAX30105.h"
#include "spo2_algorithm.h"

VitalSensor& VitalSensor::getInstance() {
    static VitalSensor instance;
    return instance;
}

VitalSensor::VitalSensor()
    : maxSensor(new MAX30105())
    , isInitialized(false)
    , lastInitAttemptMs(0)
    , spo2(-999)
    , validSPO2(0)
    , heartRate(-999)
    , validHeartRate(0)
    , lastValidHr(72.0f)
    , lastValidSpo2(98.0f)
    , latestRed(0)
    , latestIr(0)
    , lastCalcTimeMs(0) {
    for (int i = 0; i < PPG_BUFFER_LENGTH; i++) {
        redBuffer[i] = 50000;
        irBuffer[i] = 50000;
    }
}

VitalSensor::~VitalSensor() {
    if (maxSensor) {
        delete maxSensor;
        maxSensor = nullptr;
    }
}

bool VitalSensor::begin() {
    Serial.println("[VitalSensor] Initializing MAX30102 via SparkFun driver...");

    // Try fast I2C mode (400kHz), fallback to standard (100kHz)
    if (!maxSensor->begin(Wire, I2C_SPEED_FAST)) {
        if (!maxSensor->begin(Wire, I2C_SPEED_STANDARD)) {
            Serial.println("[VitalSensor] Warning: MAX30102 not detected on I2C bus.");
            isInitialized = false;
            return false;
        }
    }

    // Configure MAX30102:
    // powerLevel=0x1F, sampleAverage=4, ledMode=2 (Red+IR), sampleRate=400 (100 Hz output), pulseWidth=411, adcRange=4096
    maxSensor->setup(0x1F, 4, 2, 400, 411, 4096);
    maxSensor->clearFIFO();

    // Pre-seed buffer with initial samples (timeout 1500ms)
    unsigned long startPreseed = millis();
    int count = 0;
    while (count < PPG_BUFFER_LENGTH && (millis() - startPreseed < 1500)) {
        maxSensor->check();
        while (maxSensor->available() && count < PPG_BUFFER_LENGTH) {
            redBuffer[count] = maxSensor->getRed();
            irBuffer[count] = maxSensor->getIR();
            maxSensor->nextSample();
            count++;
        }
        delay(5);
    }

    if (count > 0) {
        latestRed = redBuffer[count - 1];
        latestIr = irBuffer[count - 1];
        for (int i = count; i < PPG_BUFFER_LENGTH; i++) {
            redBuffer[i] = latestRed;
            irBuffer[i] = latestIr;
        }
    }

    isInitialized = true;
    lastCalcTimeMs = millis();
    Serial.println("[VitalSensor] MAX30102 initialized successfully at 100 Hz.");
    return true;
}

bool VitalSensor::readSample(VitalData& data) {
    unsigned long now = millis();

    if (!isInitialized) {
        // Attempt background re-initialization every 2 seconds
        if (now - lastInitAttemptMs >= 2000) {
            lastInitAttemptMs = now;
            if (begin()) {
                isInitialized = true;
            }
        }
        if (!isInitialized) {
            data.red = 0;
            data.ir = 0;
            data.heartRate = 0.0f;
            data.spo2 = 0.0f;
            data.signalQuality = 0;
            data.fingerDetected = false;
            return false;
        }
    }

    // Check FIFO for new samples
    maxSensor->check();

    while (maxSensor->available()) {
        latestRed = maxSensor->getRed();
        latestIr = maxSensor->getIR();
        maxSensor->nextSample();

        // Shift rolling buffer
        for (int i = 1; i < PPG_BUFFER_LENGTH; i++) {
            redBuffer[i - 1] = redBuffer[i];
            irBuffer[i - 1] = irBuffer[i];
        }
        redBuffer[PPG_BUFFER_LENGTH - 1] = latestRed;
        irBuffer[PPG_BUFFER_LENGTH - 1] = latestIr;
    }

    // Finger detection is informational only — does NOT gate the algorithm (per packet_design.md §3.2)
    bool finger = (latestIr >= 20000);

    // Run Maxim built-in algorithm unconditionally every 2 seconds
    // Algorithm self-signals invalid via validHeartRate/validSPO2 = 0 → we pass -1 to mobile
    if (now - lastCalcTimeMs >= 2000) {
        lastCalcTimeMs = now;
        maxim_heart_rate_and_oxygen_saturation(
            irBuffer, PPG_BUFFER_LENGTH, redBuffer,
            &spo2, &validSPO2, &heartRate, &validHeartRate
        );
        Serial.printf("[VitalSensor] Maxim: HR=%d (valid=%d) | SpO2=%d (valid=%d) | Finger=%s | IR=%lu\n",
                      heartRate, validHeartRate, spo2, validSPO2,
                      finger ? "YES" : "NO", latestIr);
    }

    // Pass raw Maxim output always — -1 = algorithm is still accumulating / no valid reading
    data.fingerDetected = finger;
    data.red            = latestRed;
    data.ir             = latestIr;
    data.heartRate      = (validHeartRate == 1) ? (float)heartRate : -1.0f;
    data.spo2           = (validSPO2     == 1) ? (float)spo2      : -1.0f;
    data.signalQuality  = (validHeartRate == 1 || validSPO2 == 1) ? 95 : (finger ? 50 : 0);

    return true;
}
