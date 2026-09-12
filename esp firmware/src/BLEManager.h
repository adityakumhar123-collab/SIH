#ifndef BLE_MANAGER_H
#define BLE_MANAGER_H

#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include "Config.h"
#include "IMUSensor.h"
#include "VitalSensor.h"
#include "EnvironmentSensor.h"

class BLEManagerCallbacks;

class BLEManager {
public:
    static BLEManager& getInstance();

    // Initialize BLE Server, Services, and Characteristics
    void begin();
    void setDeviceInfo(const char* info);

    // 0x01: Motion Packet (100 Hz)
    void sendMotionPacket(uint32_t timestampMs, const IMUData& imu);

    // 0x02: Device Status Packet (on 1% battery change or periodic 5min)
    void sendStatusPacket(uint8_t batteryPct, uint8_t fwMajor, uint8_t fwMinor, uint32_t uptimeSec, uint8_t isBleConnected);

    // 0x03: Environment Packet (1 Hz)
    void sendEnvironmentPacket(uint32_t timestampMs, float tempC, float pressureHpa, float humidityPct);

    // 0x04: Vital Packet (100 Hz)
    void sendVitalPacket(uint32_t timestampMs, uint32_t red, uint32_t ir, uint8_t signalQuality);

    // Legacy/Feature stream compatibility
    void sendFeaturePacket(uint8_t seq, uint8_t anomalyScore, uint8_t motionState, uint8_t dominantFreqHz, uint8_t zcr, uint8_t spectralEntropy, uint16_t eigenvalueRatioScaled, uint8_t wearConfidence, uint16_t peakResultantAccelMg, uint16_t durationUnits, const int8_t* motionEmbedding, uint8_t isThreat, const float* twelveFeatures);

    // Handle connection changes in main thread
    void handleConnectionStatus();

    // Streaming state accessor
    bool isStreamingEnabled() const { return isStreaming; }
    void setStreamingEnabled(bool enabled) { isStreaming = enabled; }

    // Check if client is connected (BLE ON vs BLE OFF mode)
    bool isConnected() const { return deviceConnected; }
    void setConnected(bool connected) {
        deviceConnected = connected;
        if (!connected) isStreaming = false;
    }

    bool isEventAcknowledged() const { return eventAck; }
    void setEventAcknowledged(bool ack) { eventAck = ack; }

    bool isCalibrationRequested() const { return calibrationRequest; }
    void clearCalibrationRequest() { calibrationRequest = false; }
    void setCalibrationRequest() { calibrationRequest = true; }

    bool hasPendingCommand() const { return pendingCommand != 0; }
    uint8_t getPendingCommand() {
        uint8_t cmd = pendingCommand;
        pendingCommand = 0;
        return cmd;
    }
    void setPendingCommand(uint8_t cmd) { pendingCommand = cmd; }
    void processCommand(uint8_t command);

private:
    BLEManager();
    ~BLEManager() = default;

    BLEManager(const BLEManager&) = delete;
    BLEManager& operator=(const BLEManager&) = delete;

    BLEServer* pServer;
    BLECharacteristic* pCharCommand;    // Write characteristic
    BLECharacteristic* pCharDeviceInfo; // Read characteristic
    BLECharacteristic* pCharStatus;     // Notify characteristic (0x02 Status)
    BLECharacteristic* pCharSensor;     // Notify characteristic (0x01 Motion)
    BLECharacteristic* pCharFeature;    // Notify characteristic (0x03 Env & 0x04 Vitals)

    bool deviceConnected;
    bool oldDeviceConnected;
    bool isStreaming;
    bool eventAck;
    bool calibrationRequest;
    volatile uint8_t pendingCommand;

    uint8_t calculateChecksum(const uint8_t* buffer, size_t length);
};

#endif // BLE_MANAGER_H
