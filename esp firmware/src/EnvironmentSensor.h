#ifndef ENVIRONMENT_SENSOR_H
#define ENVIRONMENT_SENSOR_H

#include <Arduino.h>
#include <DHT.h>
#include "Config.h"

struct EnvironmentData {
    float temperature; // in °C
    float humidity;    // in % RH
    float heatIndexF;  // in °F (calculated via Rothfusz regression)
    bool isAvailable;
};

class EnvironmentSensor {
public:
    static EnvironmentSensor& getInstance();

    bool begin();
    bool readSample(EnvironmentData& data);


private:
    EnvironmentSensor();
    ~EnvironmentSensor() = default;

    EnvironmentSensor(const EnvironmentSensor&) = delete;
    EnvironmentSensor& operator=(const EnvironmentSensor&) = delete;

    DHT dht;
    bool isInitialized;
    float cachedTemp;
    float cachedHumidity;
    float cachedHeatIndexF;
    unsigned long lastReadTimeMs;
};

#endif // ENVIRONMENT_SENSOR_H
