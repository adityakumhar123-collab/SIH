#ifndef VITAL_SENSOR_H
#define VITAL_SENSOR_H

#include <Arduino.h>
#include <Wire.h>
#include "Config.h"

struct VitalData {
    uint32_t red;
    uint32_t ir;
    float heartRate;       // in BPM
    float spo2;            // in %
    uint8_t signalQuality; // 0-100%
    bool fingerDetected;
};

class MAX30105;

class VitalSensor {
public:
    static VitalSensor& getInstance();

    bool begin();
    bool readSample(VitalData& data);

private:
    VitalSensor();
    ~VitalSensor();

    VitalSensor(const VitalSensor&) = delete;
    VitalSensor& operator=(const VitalSensor&) = delete;

    MAX30105* maxSensor;
    bool isInitialized;
    unsigned long lastInitAttemptMs;

    // Buffer for Maxim SpO2 algorithm (100 samples)
    static const int PPG_BUFFER_LENGTH = 100;
    uint32_t irBuffer[PPG_BUFFER_LENGTH];
    uint32_t redBuffer[PPG_BUFFER_LENGTH];

    int32_t spo2;
    int8_t  validSPO2;
    int32_t heartRate;
    int8_t  validHeartRate;

    float lastValidHr;
    float lastValidSpo2;
    uint32_t latestRed;
    uint32_t latestIr;
    unsigned long lastCalcTimeMs;
};

#endif // VITAL_SENSOR_H
