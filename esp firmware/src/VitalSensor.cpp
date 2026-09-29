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
    , smoothedHr(-1.0f)
    , smoothedSpo2(-1.0f)
    , consecutiveOutliers(0)
    , hasInitialBaseline(false)
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

        // Fast buffer shift via memmove
        memmove(&redBuffer[0], &redBuffer[1], (PPG_BUFFER_LENGTH - 1) * sizeof(uint32_t));
        memmove(&irBuffer[0], &irBuffer[1], (PPG_BUFFER_LENGTH - 1) * sizeof(uint32_t));
        redBuffer[PPG_BUFFER_LENGTH - 1] = latestRed;
        irBuffer[PPG_BUFFER_LENGTH - 1] = latestIr;
    }

    // Finger detection is informational only — does NOT gate the algorithm (per packet_design.md §3.2)
    bool finger = (latestIr >= 20000);

    // Pass filtered Maxim output (smoothed & artifact-rejected @ 0.5 Hz on Core 0)
    data.fingerDetected = finger;
    data.red            = latestRed;
    data.ir             = latestIr;
    data.heartRate      = (hasInitialBaseline && smoothedHr >= 40.0f && smoothedHr <= 180.0f) ? smoothedHr : -1.0f;
    data.spo2           = (smoothedSpo2 >= 70.0f && smoothedSpo2 <= 100.0f) ? smoothedSpo2 : -1.0f;
    data.signalQuality  = (hasInitialBaseline) ? 95 : (finger ? 50 : 0);

    return true;
}

// 0.5 Hz Background execution on Core 0 (EnvironmentTask)
// Runs Maxim algorithm + Physiological Artifact & Slew-Rate Filter + EWMA Temporal Smoothing
void VitalSensor::updateVitalsCalculation() {
    if (!isInitialized) return;

    // 1. Finger Contact Gating
    bool fingerPresent = (latestIr >= 20000);
    if (!fingerPresent) {
        // Finger removed -> reset baseline so it recalibrates cleanly upon contact
        hasInitialBaseline = false;
        smoothedHr = -1.0f;
        smoothedSpo2 = -1.0f;
        validHeartRate = 0;
        validSPO2 = 0;
        consecutiveOutliers = 0;
        return;
    }

    // 2. Snapshot buffer to run calculation
    uint32_t localRed[PPG_BUFFER_LENGTH];
    uint32_t localIr[PPG_BUFFER_LENGTH];
    memcpy(localRed, (const void*)redBuffer, sizeof(redBuffer));
    memcpy(localIr, (const void*)irBuffer, sizeof(irBuffer));

    maxim_heart_rate_and_oxygen_saturation(
        localIr, PPG_BUFFER_LENGTH, localRed,
        &spo2, &validSPO2, &heartRate, &validHeartRate
    );

    // 3. Heart Rate Preprocessing & Artifact Filter
    if (validHeartRate == 1 && heartRate >= 40 && heartRate <= 200) {
        float rawHr = (float)heartRate;

        if (!hasInitialBaseline) {
            // First valid calculation: seed the baseline
            smoothedHr = rawHr;
            hasInitialBaseline = true;
            consecutiveOutliers = 0;
        } else {
            // A. Harmonic / Sub-harmonic Peak Correction
            // Dicrotic notch double-counting error (e.g. ~150 BPM when actual is 76 BPM)
            if (rawHr >= smoothedHr * 1.75f && rawHr <= smoothedHr * 2.25f) {
                rawHr = rawHr / 2.0f;
            }
            // Missed systolic peak half-counting error (e.g. ~38 BPM when actual is 76 BPM)
            else if (rawHr >= smoothedHr * 0.40f && rawHr <= smoothedHr * 0.60f) {
                rawHr = rawHr * 2.0f;
            }

            // B. Slew-Rate Limiter (Physiological Jump Gating)
            // Human heart rate cannot physically jump > 18 BPM in 2 seconds during steady wear
            float delta = rawHr - smoothedHr;
            if (fabsf(delta) > 18.0f) {
                consecutiveOutliers++;
                if (consecutiveOutliers < 3) {
                    // Reject transient motion/contact spike, allow at most ±4 BPM step
                    rawHr = (delta > 0) ? (smoothedHr + 4.0f) : (smoothedHr - 4.0f);
                } else {
                    // Sustained real shift (e.g. sudden workout) -> accept new trend
                    consecutiveOutliers = 0;
                }
            } else {
                consecutiveOutliers = 0;
            }

            // C. Clinical EWMA Temporal Smoothing (Alpha = 0.30)
            smoothedHr = 0.30f * rawHr + 0.70f * smoothedHr;
        }
    }

    // 4. SpO2 Temporal Smoothing
    if (validSPO2 == 1 && spo2 >= 70 && spo2 <= 100) {
        float rawSpo2 = (float)spo2;
        if (smoothedSpo2 < 0) {
            smoothedSpo2 = rawSpo2;
        } else {
            // Arterial blood oxygen changes slowly -> EWMA Alpha = 0.20
            smoothedSpo2 = 0.20f * rawSpo2 + 0.80f * smoothedSpo2;
        }
    }
}
