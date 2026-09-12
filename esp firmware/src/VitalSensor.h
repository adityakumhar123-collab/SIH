#ifndef VITAL_SENSOR_H
#define VITAL_SENSOR_H

#include <Arduino.h>
#include <Wire.h>
#include "Config.h"

struct VitalData {
    uint32_t red;
    uint32_t ir;
    float heartRate;     // in BPM
    float spo2;          // in %
    uint8_t signalQuality; // 0-100%
    bool fingerDetected;
};

class VitalSensor {
public:
    static VitalSensor& getInstance();

    bool begin();
    bool readSample(VitalData& data);

private:
    VitalSensor();
    ~VitalSensor() = default;

    VitalSensor(const VitalSensor&) = delete;
    VitalSensor& operator=(const VitalSensor&) = delete;

    static const uint8_t MAX30102_ADDR = 0x57;
    static const uint8_t REG_INTR_STATUS_1 = 0x00;
    static const uint8_t REG_INTR_STATUS_2 = 0x01;
    static const uint8_t REG_INTR_ENABLE_1 = 0x02;
    static const uint8_t REG_INTR_ENABLE_2 = 0x03;
    static const uint8_t REG_FIFO_WR_PTR = 0x04;
    static const uint8_t REG_OVF_COUNTER = 0x05;
    static const uint8_t REG_FIFO_RD_PTR = 0x06;
    static const uint8_t REG_FIFO_DATA = 0x07;
    static const uint8_t REG_FIFO_CONFIG = 0x08;
    static const uint8_t REG_MODE_CONFIG = 0x09;
    static const uint8_t REG_SPO2_CONFIG = 0x0A;
    static const uint8_t REG_LED1_PA = 0x0C; // Red
    static const uint8_t REG_LED2_PA = 0x0D; // IR
    static const uint8_t REG_PART_ID = 0xFF;

    bool isInitialized;
    
    // Rolling statistics for HR & SpO2 estimation
    uint32_t sampleCount;
    float irDcEstimate;
    float redDcEstimate;
    float irAcEstimate;
    float redAcEstimate;
    uint32_t lastPeakTimeMs;
    float calculatedHr;
    float calculatedSpo2;
    float lastFilteredIr;
    bool peakArm;

    bool writeRegister(uint8_t reg, uint8_t value);
    bool readRegisters(uint8_t reg, uint8_t* buffer, uint8_t length);
};

#endif // VITAL_SENSOR_H
