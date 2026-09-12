#ifndef ENVIRONMENT_SENSOR_H
#define ENVIRONMENT_SENSOR_H

#include <Arduino.h>
#include <Wire.h>
#include "Config.h"

struct EnvironmentData {
    float temperature; // in °C
    float pressure;    // in hPa
    float humidity;    // in % RH
    float heatIndexF;  // in °F (calculated via Rothfusz regression)
    bool isAvailable;
};

class EnvironmentSensor {
public:
    static EnvironmentSensor& getInstance();

    bool begin();
    bool readSample(EnvironmentData& data);

    // NOAA Rothfusz Heat Index regression
    static float calculateHeatIndexF(float tempC, float humidityPct);

private:
    EnvironmentSensor();
    ~EnvironmentSensor() = default;

    EnvironmentSensor(const EnvironmentSensor&) = delete;
    EnvironmentSensor& operator=(const EnvironmentSensor&) = delete;

    static const uint8_t BMP280_ADDR_PRIMARY = 0x76;
    static const uint8_t BMP280_ADDR_SECONDARY = 0x77;

    uint8_t sensorAddr;
    bool isInitialized;
    bool hasHumidity;

    // Calibration data for BMP280
    uint16_t dig_T1;
    int16_t  dig_T2;
    int16_t  dig_T3;
    uint16_t dig_P1;
    int16_t  dig_P2;
    int16_t  dig_P3;
    int16_t  dig_P4;
    int16_t  dig_P5;
    int16_t  dig_P6;
    int16_t  dig_P7;
    int16_t  dig_P8;
    int16_t  dig_P9;
    int32_t  t_fine;

    bool readCalibration();
    bool writeRegister(uint8_t reg, uint8_t value);
    bool readRegisters(uint8_t reg, uint8_t* buffer, uint8_t length);
};

#endif // ENVIRONMENT_SENSOR_H
