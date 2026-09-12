#include "EdgeAnalytics.h"
#include <math.h>

EdgeAnalytics& EdgeAnalytics::getInstance() {
    static EdgeAnalytics instance;
    return instance;
}

EdgeAnalytics::EdgeAnalytics()
    : windowIndex(0)
    , sampleCounter(0)
    , fallState(FALL_IDLE)
    , fallTroughTimeMs(0)
    , fallImpactTimeMs(0)
    , fallCountdownStartTimeMs(0)
    , fallCountdownActive(false)
    , currentActivity(ACTIVITY_REST)
    , candidateActivity(ACTIVITY_REST)
    , consecutiveWindows(0) {
    
    preImpactOrientation[0] = 0.0f;
    preImpactOrientation[1] = 0.0f;
    preImpactOrientation[2] = 1.0f;

    postImpactOrientation[0] = 0.0f;
    postImpactOrientation[1] = 0.0f;
    postImpactOrientation[2] = 1.0f;
}

void EdgeAnalytics::begin() {
    // 1. Initialize Motion Centroids & Welford trackers [AccelRMS, GyroRMS, Periodicity, Cadence]
    // Running (Idx 0)
    motionCentroid[0][0] = 0.45f;  motionCentroid[0][1] = 80.0f;  motionCentroid[0][2] = 0.85f;  motionCentroid[0][3] = 2.6f;
    motionWelford[0][0].reset(0.45f, 0.04f);
    motionWelford[0][1].reset(80.0f, 400.0f);
    motionWelford[0][2].reset(0.85f, 0.02f);
    motionWelford[0][3].reset(2.6f, 0.10f);

    // Walking (Idx 1)
    motionCentroid[1][0] = 0.18f;  motionCentroid[1][1] = 25.0f;  motionCentroid[1][2] = 0.80f;  motionCentroid[1][3] = 1.8f;
    motionWelford[1][0].reset(0.18f, 0.01f);
    motionWelford[1][1].reset(25.0f, 100.0f);
    motionWelford[1][2].reset(0.80f, 0.02f);
    motionWelford[1][3].reset(1.8f, 0.05f);

    // Still / Rest (Idx 2)
    motionCentroid[2][0] = 0.02f;  motionCentroid[2][1] = 4.0f;   motionCentroid[2][2] = 0.05f;  motionCentroid[2][3] = 0.0f;
    motionWelford[2][0].reset(0.02f, 0.001f);
    motionWelford[2][1].reset(4.0f, 4.0f);
    motionWelford[2][2].reset(0.05f, 0.01f);
    motionWelford[2][3].reset(0.0f, 0.01f);

    // 2. Initialize Physiological Baseline [HR, SpO2]
    vitalCentroid[0] = 72.0f; // Baseline HR 72 BPM
    vitalCentroid[1] = 98.0f; // Baseline SpO2 98%
    vitalWelford[0].reset(72.0f, 100.0f); // sigma^2 = 100 (std = 10 bpm)
    vitalWelford[1].reset(98.0f, 4.0f);   // sigma^2 = 4 (std = 2%)

    // 3. Initialize Environment Baseline [Temp °C, Pressure hPa, Humidity %]
    envCentroid[0] = 25.0f;
    envCentroid[1] = 1013.25f;
    envCentroid[2] = 50.0f;
    envWelford[0].reset(25.0f, 16.0f);    // sigma^2 = 16 (std = 4°C)
    envWelford[1].reset(1013.25f, 100.0f);// sigma^2 = 100 (std = 10 hPa)
    envWelford[2].reset(50.0f, 100.0f);   // sigma^2 = 100 (std = 10%)

    Serial.println("[EdgeAnalytics] Initialized with seeded centroids and Welford variance baselines.");
}

float EdgeAnalytics::clamp01(float x) {
    return constrain(x, 0.0f, 1.0f);
}

float EdgeAnalytics::rise(float x, float low, float high) {
    return clamp01((x - low) / (high - low));
}

float EdgeAnalytics::fall(float x, float low, float high) {
    return 1.0f - rise(x, low, high);
}

float EdgeAnalytics::triangle(float x, float low, float peak, float high) {
    if (x <= low || x >= high) return 0.0f;
    if (x < peak) return (x - low) / (peak - low);
    return (high - x) / (high - peak);
}

const char* EdgeAnalytics::getActivityString() const {
    switch (currentActivity) {
        case ACTIVITY_REST: return "REST";
        case ACTIVITY_WALK: return "WALK";
        case ACTIVITY_RUN:  return "RUN";
        default:            return "UNKNOWN";
    }
}

uint32_t EdgeAnalytics::getFallCountdownRemainingSec() const {
    if (!fallCountdownActive) return 0;
    uint32_t elapsedMs = millis() - fallCountdownStartTimeMs;
    if (elapsedMs >= FALL_CANCEL_TIMEOUT_MS) return 0;
    return (FALL_CANCEL_TIMEOUT_MS - elapsedMs) / 1000;
}

void EdgeAnalytics::cancelFallAlarm() {
    if (fallCountdownActive) {
        fallCountdownActive = false;
        fallState = FALL_IDLE;
        Serial.println("[EdgeAnalytics] Fall alarm cancelled by user confirmation.");
    }
}

void EdgeAnalytics::processIMUSample(const IMUData& sample) {
    // 1. Fall detection evaluation per sample
    evaluateFallDetection(sample);

    // 2. Add sample to sliding window buffer (200 samples)
    windowBuffer[windowIndex] = sample;
    windowIndex = (windowIndex + 1) % WINDOW_SIZE;
    sampleCounter++;

    // Evaluate heuristic motion classification and motion anomaly every STRIDE_SIZE samples (0.5s)
    if (sampleCounter >= STRIDE_SIZE) {
        sampleCounter = 0;
        evaluateMotionWindow();
    }
}

void EdgeAnalytics::evaluateFallDetection(const IMUData& sample) {
    float aMag = sqrtf(sample.ax * sample.ax + sample.ay * sample.ay + sample.az * sample.az);
    float gMag = sqrtf(sample.gx * sample.gx + sample.gy * sample.gy + sample.gz * sample.gz);
    uint32_t nowMs = millis();

    // Check cancellation timer expiration
    if (fallCountdownActive) {
        if (nowMs - fallCountdownStartTimeMs >= FALL_CANCEL_TIMEOUT_MS) {
            fallCountdownActive = false;
            fallState = FALL_IDLE;
            Serial.println("[EdgeAnalytics] Fall confirmed (cancellation window elapsed)! Sounding buzzer!");
            BuzzerManager::getInstance().triggerAlert(ALERT_FALL); // 1 Buzz for Fall
        }
        return;
    }

    switch (fallState) {
        case FALL_IDLE:
            // Step 3: Low-acceleration trough below 0.65g
            if (aMag < FALL_TROUGH_G) {
                fallState = FALL_TROUGH_DETECTED;
                fallTroughTimeMs = nowMs;

                // Capture pre-impact orientation vector (normalized)
                if (aMag > 0.1f) {
                    preImpactOrientation[0] = sample.ax / aMag;
                    preImpactOrientation[1] = sample.ay / aMag;
                    preImpactOrientation[2] = sample.az / aMag;
                }
            }
            break;

        case FALL_TROUGH_DETECTED:
            // Step 4: Within 1 second, look for high impact peak > 2.2g or gyro > 180 dps
            if (nowMs - fallTroughTimeMs > 1000) {
                // Trough timed out without impact
                fallState = FALL_IDLE;
            } else if (aMag > FALL_IMPACT_G || gMag > FALL_IMPACT_GYRO_DPS) {
                fallState = FALL_IMPACT_DETECTED;
                fallImpactTimeMs = nowMs;

                // Capture post-impact orientation vector
                if (aMag > 0.1f) {
                    postImpactOrientation[0] = sample.ax / aMag;
                    postImpactOrientation[1] = sample.ay / aMag;
                    postImpactOrientation[2] = sample.az / aMag;
                }
            }
            break;

        case FALL_IMPACT_DETECTED:
            // Step 5: Check posture change angle
            {
                float dotProd = (preImpactOrientation[0] * postImpactOrientation[0]) +
                                (preImpactOrientation[1] * postImpactOrientation[1]) +
                                (preImpactOrientation[2] * postImpactOrientation[2]);
                dotProd = constrain(dotProd, -1.0f, 1.0f);
                float angleDeg = acosf(dotProd) * (180.0f / 3.14159265f);

                if (angleDeg >= FALL_POSTURE_CHANGE_DEG) {
                    // Posture shifted significantly, proceed to stillness check
                    fallState = FALL_MONITORING_REST;
                    fallImpactTimeMs = nowMs; // Reuse as stillness start time
                } else {
                    // Normal jump or bump without lying down
                    fallState = FALL_IDLE;
                }
            }
            break;

        case FALL_MONITORING_REST:
            // Step 6: Monitor stillness for next 1.5 - 2.5 seconds
            if (nowMs - fallImpactTimeMs < 1500) {
                // Still within settling window
                if (aMag > 1.8f || gMag > 100.0f) {
                    // Active body movement detected — user recovered
                    fallState = FALL_IDLE;
                }
            } else {
                // Step 7 & 8: Sustained stillness confirmed! Start cancellation countdown
                fallState = FALL_COUNTDOWN;
                fallCountdownStartTimeMs = nowMs;
                fallCountdownActive = true;
                Serial.println("[EdgeAnalytics] Potential fall detected! 10s cancellation countdown started.");
            }
            break;

        default:
            fallState = FALL_IDLE;
            break;
    }
}

void EdgeAnalytics::evaluateMotionWindow() {
    // 1. Calculate dynamic acceleration signal and RMS
    float meanAx = 0, meanAy = 0, meanAz = 0;
    for (int i = 0; i < WINDOW_SIZE; i++) {
        meanAx += windowBuffer[i].ax;
        meanAy += windowBuffer[i].ay;
        meanAz += windowBuffer[i].az;
    }
    meanAx /= WINDOW_SIZE;
    meanAy /= WINDOW_SIZE;
    meanAz /= WINDOW_SIZE;

    float dynamicAccel[WINDOW_SIZE];
    float dynamicAccelSumSq = 0.0f;
    float gyroSumSq = 0.0f;

    for (int i = 0; i < WINDOW_SIZE; i++) {
        float dAx = windowBuffer[i].ax - meanAx;
        float dAy = windowBuffer[i].ay - meanAy;
        float dAz = windowBuffer[i].az - meanAz;
        float dMag = sqrtf(dAx * dAx + dAy * dAy + dAz * dAz);
        dynamicAccel[i] = dMag;
        dynamicAccelSumSq += (dMag * dMag);

        float gMag = sqrtf(windowBuffer[i].gx * windowBuffer[i].gx +
                           windowBuffer[i].gy * windowBuffer[i].gy +
                           windowBuffer[i].gz * windowBuffer[i].gz);
        gyroSumSq += (gMag * gMag);
    }

    float accelRms = sqrtf(dynamicAccelSumSq / (float)WINDOW_SIZE);
    float gyroRms = sqrtf(gyroSumSq / (float)WINDOW_SIZE);

    // 2. Normalized Autocorrelation for Periodicity & Cadence (1–4 Hz lag window: 25 to 100 samples)
    int tauMin = SAMPLE_RATE_HZ / 4;  // 25
    int tauMax = SAMPLE_RATE_HZ / 1;  // 100

    float maxR = 0.0f;
    int bestTau = tauMin;

    for (int tau = tauMin; tau <= tauMax; tau++) {
        float sumCross = 0.0f;
        float sumX1Sq = 0.0f;
        float sumX2Sq = 0.0f;

        for (int i = 0; i < WINDOW_SIZE - tau; i++) {
            float x1 = dynamicAccel[i];
            float x2 = dynamicAccel[i + tau];
            sumCross += (x1 * x2);
            sumX1Sq += (x1 * x1);
            sumX2Sq += (x2 * x2);
        }

        float denom = sqrtf(sumX1Sq) * sqrtf(sumX2Sq);
        if (denom > 1e-5f) {
            float r = sumCross / denom;
            if (r > maxR) {
                maxR = r;
                bestTau = tau;
            }
        }
    }

    float periodicity = clamp01((maxR - 0.20f) / (0.65f - 0.20f));
    float cadenceHz = (bestTau > 0) ? ((float)SAMPLE_RATE_HZ / (float)bestTau) : 0.0f;

    // 3. Compute component scores
    float walkCadence = triangle(cadenceHz, 1.3f, 1.9f, 2.5f);
    float runCadence = rise(cadenceHz, 2.1f, 2.8f);
    float walkIntensity = triangle(accelRms, 0.04f, 0.16f, 0.40f);
    float runIntensity = rise(accelRms, 0.18f, 0.50f);
    float highGyro = rise(gyroRms, 40.0f, 120.0f);
    float lowGyro = fall(gyroRms, 3.0f, 12.0f);
    float lowAcceleration = fall(accelRms, 0.03f, 0.12f);
    float moderateGyro = triangle(gyroRms, 10.0f, 30.0f, 70.0f);

    MotionScores s;
    s.walk = 0.35f * periodicity + 0.25f * walkCadence + 0.25f * walkIntensity + 0.15f * moderateGyro - 0.20f * highGyro;
    s.run  = 0.30f * periodicity + 0.25f * runCadence + 0.25f * runIntensity + 0.20f * highGyro;
    s.rest = 0.55f * lowAcceleration + 0.35f * lowGyro - 0.30f * periodicity;

    // 4. Candidate activity selection
    MotionActivity cand = ACTIVITY_UNKNOWN;
    if (s.rest > s.walk && s.rest > s.run && s.rest > 0.55f) {
        cand = ACTIVITY_REST;
    } else if (s.walk > s.run && s.walk > s.rest && s.walk > 0.55f) {
        cand = ACTIVITY_WALK;
    } else if (s.run > s.walk && s.run > s.rest && s.run > 0.55f) {
        cand = ACTIVITY_RUN;
    }

    // 5. Temporal smoothing (require 2 consecutive windows)
    if (cand == candidateActivity) {
        consecutiveWindows++;
    } else {
        candidateActivity = cand;
        consecutiveWindows = 1;
    }

    if (consecutiveWindows >= 2 && candidateActivity != ACTIVITY_UNKNOWN) {
        currentActivity = candidateActivity;
    }

    // 6. Update Welford and EWMA for the active motion state
    int stateIdx = (currentActivity == ACTIVITY_RUN) ? 0 : ((currentActivity == ACTIVITY_WALK) ? 1 : 2);
    float xVec[4] = {accelRms, gyroRms, periodicity, cadenceHz};

    for (int d = 0; d < 4; d++) {
        motionWelford[stateIdx][d].update(xVec[d]);
        // EWMA update with weight alpha
        motionCentroid[stateIdx][d] = EWMA_ALPHA_MOTION * xVec[d] + (1.0f - EWMA_ALPHA_MOTION) * motionCentroid[stateIdx][d];
    }
}

void EdgeAnalytics::processVitalSample(const VitalData& sample) {
    if (!sample.fingerDetected || sample.signalQuality < 20) return;

    evaluatePhysiologicalAnomaly(sample.heartRate, sample.spo2);
}

void EdgeAnalytics::evaluatePhysiologicalAnomaly(float hr, float spo2) {
    // 1. Check clinical hard boundaries immediately
    if (spo2 < SPO2_CRITICAL_LOW || hr < HR_CRITICAL_BRADY || hr > HR_CRITICAL_TACHY) {
        static uint32_t lastVitalAlertMs = 0;
        if (millis() - lastVitalAlertMs > 10000) {
            lastVitalAlertMs = millis();
            Serial.printf("[EdgeAnalytics] VITAL CRITICAL BREACH! HR=%.1f bpm, SpO2=%.1f%% -> 2 Buzzes\n", hr, spo2);
            BuzzerManager::getInstance().triggerAlert(ALERT_PHYSIOLOGY); // 2 Buzzes
        }
        return;
    }

    // 2. Bounded EWMA baseline drift update (within valid clinical limits)
    if (hr >= HR_MIN_HARD_BOUND && hr <= HR_MAX_HARD_BOUND) {
        vitalCentroid[0] = EWMA_ALPHA_PHYSIOLOGY * hr + (1.0f - EWMA_ALPHA_PHYSIOLOGY) * vitalCentroid[0];
        vitalWelford[0].update(hr);
    }
    if (spo2 >= SPO2_MIN_HARD_BOUND && spo2 <= SPO2_MAX_HARD_BOUND) {
        vitalCentroid[1] = EWMA_ALPHA_PHYSIOLOGY * spo2 + (1.0f - EWMA_ALPHA_PHYSIOLOGY) * vitalCentroid[1];
        vitalWelford[1].update(spo2);
    }

    // 3. Normalized squared distance: D^2 = sum (x_i - mu_i)^2 / sigma_i^2
    float dHr = hr - vitalCentroid[0];
    float dSpo2 = spo2 - vitalCentroid[1];
    float varHr = fmaxf(vitalWelford[0].getVariance(), 25.0f);
    float varSpo2 = fmaxf(vitalWelford[1].getVariance(), 1.0f);

    float mahalanobisSq = (dHr * dHr) / varHr + (dSpo2 * dSpo2) / varSpo2;
    if (mahalanobisSq > 9.21f) { // chi-square 2-DOF at 99% significance
        static uint32_t lastVitalDistAlertMs = 0;
        if (millis() - lastVitalDistAlertMs > 15000) {
            lastVitalDistAlertMs = millis();
            Serial.printf("[EdgeAnalytics] Physiological anomaly detected! D^2=%.2f -> 2 Buzzes\n", mahalanobisSq);
            BuzzerManager::getInstance().triggerAlert(ALERT_PHYSIOLOGY);
        }
    }
}

void EdgeAnalytics::processEnvironmentSample(const EnvironmentData& sample) {
    evaluateEnvironmentalAnomaly(sample.temperature, sample.pressure, sample.humidity, sample.heatIndexF);
}

void EdgeAnalytics::evaluateEnvironmentalAnomaly(float tempC, float pressureHpa, float humidityPct, float heatIndexF) {
    // 1. NOAA Heat Index Hazard Check
    if (heatIndexF >= HEAT_INDEX_DANGER) { // >= 104°F Danger or Extreme Danger
        static uint32_t lastHeatAlertMs = 0;
        if (millis() - lastHeatAlertMs > 15000) {
            lastHeatAlertMs = millis();
            Serial.printf("[EdgeAnalytics] HEAT DANGER ANOMALY! Heat Index = %.1f°F -> 3 Buzzes\n", heatIndexF);
            BuzzerManager::getInstance().triggerAlert(ALERT_ENVIRONMENT); // 3 Buzzes
        }
        return;
    }

    // 2. Bounded EWMA baseline drift update
    if (tempC >= TEMP_MIN_HARD_BOUND && tempC <= TEMP_MAX_HARD_BOUND) {
        envCentroid[0] = EWMA_ALPHA_ENVIRONMENT * tempC + (1.0f - EWMA_ALPHA_ENVIRONMENT) * envCentroid[0];
        envWelford[0].update(tempC);
    }
    if (pressureHpa >= PRESS_MIN_HARD_BOUND && pressureHpa <= PRESS_MAX_HARD_BOUND) {
        envCentroid[1] = EWMA_ALPHA_ENVIRONMENT * pressureHpa + (1.0f - EWMA_ALPHA_ENVIRONMENT) * envCentroid[1];
        envWelford[1].update(pressureHpa);
    }
    if (humidityPct >= HUMID_MIN_HARD_BOUND && humidityPct <= HUMID_MAX_HARD_BOUND) {
        envCentroid[2] = EWMA_ALPHA_ENVIRONMENT * humidityPct + (1.0f - EWMA_ALPHA_ENVIRONMENT) * envCentroid[2];
        envWelford[2].update(humidityPct);
    }

    // 3. Normalized Distance for Environment
    float dT = tempC - envCentroid[0];
    float dP = pressureHpa - envCentroid[1];
    float dH = humidityPct - envCentroid[2];
    float varT = fmaxf(envWelford[0].getVariance(), 4.0f);
    float varP = fmaxf(envWelford[1].getVariance(), 25.0f);
    float varH = fmaxf(envWelford[2].getVariance(), 25.0f);

    float envDistSq = (dT * dT) / varT + (dP * dP) / varP + (dH * dH) / varH;
    if (envDistSq > 11.34f) { // chi-square 3-DOF at 99% significance
        static uint32_t lastEnvDistAlertMs = 0;
        if (millis() - lastEnvDistAlertMs > 20000) {
            lastEnvDistAlertMs = millis();
            Serial.printf("[EdgeAnalytics] Environmental anomaly detected! D^2=%.2f -> 3 Buzzes\n", envDistSq);
            BuzzerManager::getInstance().triggerAlert(ALERT_ENVIRONMENT);
        }
    }
}
