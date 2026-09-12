#ifndef EDGE_ANALYTICS_H
#define EDGE_ANALYTICS_H

#include <Arduino.h>
#include "Config.h"
#include "IMUSensor.h"
#include "VitalSensor.h"
#include "EnvironmentSensor.h"
#include "BuzzerManager.h"

enum MotionActivity {
    ACTIVITY_UNKNOWN = 0,
    ACTIVITY_REST = 1,
    ACTIVITY_WALK = 2,
    ACTIVITY_RUN = 3
};

struct MotionScores {
    float walk;
    float run;
    float rest;
};

// Online Welford accumulator for O(1) variance calculation
struct WelfordStat {
    uint32_t count;
    float mean;
    float M2;

    void reset(float initialMean, float initialVar) {
        count = 10; // Seed with pseudo-observations
        mean = initialMean;
        M2 = initialVar * (count - 1);
    }

    void update(float x) {
        count++;
        float delta = x - mean;
        mean += delta / (float)count;
        float delta2 = x - mean;
        M2 += delta * delta2;
    }

    float getVariance() const {
        return (count > 1) ? (M2 / (float)(count - 1)) : 1.0f;
    }
};

class EdgeAnalytics {
public:
    static EdgeAnalytics& getInstance();

    void begin();

    // Ingest 100 Hz IMU sample
    void processIMUSample(const IMUData& sample);

    // Ingest 100 Hz Vital sample
    void processVitalSample(const VitalData& sample);

    // Ingest 1 Hz Environment sample
    void processEnvironmentSample(const EnvironmentData& sample);

    // Getters for status & diagnostics
    MotionActivity getCurrentActivity() const { return currentActivity; }
    const char* getActivityString() const;
    bool isFallAlarmPending() const { return fallCountdownActive; }
    uint32_t getFallCountdownRemainingSec() const;
    void cancelFallAlarm();

private:
    EdgeAnalytics();
    ~EdgeAnalytics() = default;

    EdgeAnalytics(const EdgeAnalytics&) = delete;
    EdgeAnalytics& operator=(const EdgeAnalytics&) = delete;

    // Motion window buffer (2.0s = 200 samples)
    IMUData windowBuffer[WINDOW_SIZE];
    uint16_t windowIndex;
    uint16_t sampleCounter;

    // Fall detection state machine
    enum FallState {
        FALL_IDLE,
        FALL_TROUGH_DETECTED,
        FALL_IMPACT_DETECTED,
        FALL_MONITORING_REST,
        FALL_COUNTDOWN
    };

    FallState fallState;
    uint32_t fallTroughTimeMs;
    uint32_t fallImpactTimeMs;
    float preImpactOrientation[3];
    float postImpactOrientation[3];
    uint32_t fallCountdownStartTimeMs;
    bool fallCountdownActive;

    // Activity classification state
    MotionActivity currentActivity;
    MotionActivity candidateActivity;
    uint8_t consecutiveWindows;

    // N-Dimensional Motion Baselines & Welford trackers (4D: AccelRMS, GyroRMS, Periodicity, Cadence)
    // Indexes: 0 = RUN, 1 = WALK, 2 = REST
    float motionCentroid[3][4];
    WelfordStat motionWelford[3][4];

    // N-Dimensional Physiological Baseline (2D: HR, SpO2)
    float vitalCentroid[2];
    WelfordStat vitalWelford[2];

    // N-Dimensional Environment Baseline (3D: Temp, Pressure, Humidity)
    float envCentroid[3];
    WelfordStat envWelford[3];

    // Helper math functions
    static float clamp01(float x);
    static float rise(float x, float low, float high);
    static float fall(float x, float low, float high);
    static float triangle(float x, float low, float peak, float high);

    void evaluateMotionWindow();
    void evaluateFallDetection(const IMUData& sample);
    void evaluatePhysiologicalAnomaly(float hr, float spo2);
    void evaluateEnvironmentalAnomaly(float tempC, float pressureHpa, float humidityPct, float heatIndexF);
};

#endif // EDGE_ANALYTICS_H
