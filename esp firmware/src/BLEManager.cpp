#include "BLEManager.h"
#include "EdgeAnalytics.h"
#include <esp_system.h>

// Connection callbacks
class BLEServerCallbacksImpl : public BLEServerCallbacks {
    void onConnect(BLEServer* pServer) override {
        Serial.println("[BLE_CB] onConnect triggered. Mode -> BLE ON.");
        BLEManager::getInstance().setConnected(true);
        BLEManager::getInstance().setStreamingEnabled(true);
    }

    void onConnect(BLEServer* pServer, esp_ble_gatts_cb_param_t *param) override {
        Serial.println("[BLE_CB] onConnect (param) triggered. Mode -> BLE ON.");
        BLEManager::getInstance().setConnected(true);
        BLEManager::getInstance().setStreamingEnabled(true);
    }

    void onDisconnect(BLEServer* pServer) override {
        Serial.println("[BLE_CB] onDisconnect triggered. Mode -> BLE OFF (Local Health Sensing).");
        BLEManager::getInstance().setConnected(false);
    }

    void onDisconnect(BLEServer* pServer, esp_ble_gatts_cb_param_t *param) override {
        Serial.println("[BLE_CB] onDisconnect (param) triggered. Mode -> BLE OFF (Local Health Sensing).");
        BLEManager::getInstance().setConnected(false);
    }
};

// Command characteristic callbacks
class BLECharacteristicCallbacksImpl : public BLECharacteristicCallbacks {
    void onWrite(BLECharacteristic* pCharacteristic) override {
        std::string value = pCharacteristic->getValue();
        if (value.length() == 0) return;
        uint8_t cmd = static_cast<uint8_t>(value[0]);
        BLEManager::getInstance().processCommand(cmd);
    }
};

BLEManager& BLEManager::getInstance() {
    static BLEManager instance;
    return instance;
}

BLEManager::BLEManager()
    : pServer(nullptr)
    , pCharCommand(nullptr)
    , pCharDeviceInfo(nullptr)
    , pCharStatus(nullptr)
    , pCharSensor(nullptr)
    , pCharFeature(nullptr)
    , deviceConnected(false)
    , oldDeviceConnected(false)
    , isStreaming(false)
    , eventAck(false)
    , calibrationRequest(false)
    , pendingCommand(0) {}

void BLEManager::begin() {
    Serial.println("[BLE] Initializing BLE stack.");

    uint8_t customMac[6] = {0x90, 0x70, 0x69, 0x11, 0x69, 0x55};
    esp_err_t macErr = esp_base_mac_addr_set(customMac);
    if (macErr != ESP_OK) {
        Serial.printf("[BLE] Warning: Failed to set base MAC address: 0x%x\n", macErr);
    }

    BLEDevice::setMTU(64);
    BLEDevice::init(BLE_DEVICE_NAME);
    BLEDevice::setPower(ESP_PWR_LVL_P9);

    pServer = BLEDevice::createServer();
    pServer->setCallbacks(new BLEServerCallbacksImpl());

    BLEService* pService = pServer->createService(BLEUUID(SERVICE_UUID), 30);

    // Command Characteristic (Write)
    pCharCommand = pService->createCharacteristic(
        CHAR_UUID_COMMAND,
        BLECharacteristic::PROPERTY_WRITE
    );
    pCharCommand->setCallbacks(new BLECharacteristicCallbacksImpl());

    // Device Info Characteristic (Read)
    pCharDeviceInfo = pService->createCharacteristic(
        CHAR_UUID_DEVICE_INFO,
        BLECharacteristic::PROPERTY_READ
    );
    pCharDeviceInfo->setValue(FIRMWARE_VERSION_STR);

    // Status Characteristic (Notify - 0x02 Status)
    pCharStatus = pService->createCharacteristic(
        CHAR_UUID_STATUS,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    pCharStatus->addDescriptor(new BLE2902());

    // Sensor Characteristic (Notify - 0x01 Motion)
    pCharSensor = pService->createCharacteristic(
        CHAR_UUID_SENSOR,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    pCharSensor->addDescriptor(new BLE2902());

    // Feature Characteristic (Notify - 0x03 Env & 0x04 Vitals)
    pCharFeature = pService->createCharacteristic(
        CHAR_UUID_FEATURE,
        BLECharacteristic::PROPERTY_NOTIFY
    );
    pCharFeature->addDescriptor(new BLE2902());

    pService->start();

    // Advertising setup
    BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
    BLEAdvertisementData oAdvertisementData;
    oAdvertisementData.setFlags(0x06);
    oAdvertisementData.setCompleteServices(BLEUUID(SERVICE_UUID));
    pAdvertising->setAdvertisementData(oAdvertisementData);

    BLEAdvertisementData oScanResponseData;
    oScanResponseData.setName(BLE_DEVICE_NAME);
    pAdvertising->setScanResponseData(oScanResponseData);
    pAdvertising->setScanResponse(true);

    pAdvertising->setMinPreferred(0x06);
    pAdvertising->setMinPreferred(0x12);

    BLEDevice::startAdvertising();
    Serial.println("[BLE] Service started. Advertising active.");
}

void BLEManager::setDeviceInfo(const char* info) {
    if (pCharDeviceInfo != nullptr && info != nullptr && strlen(info) > 0) {
        pCharDeviceInfo->setValue(info);
    }
}

// 0x01: Motion Packet (100 Hz)
// Format: [0x01 (1B) | timestamp ms (4B) | ax (2B) | ay (2B) | az (2B) | gx (2B) | gy (2B) | gz (2B) | checksum (1B)] -> 18 Bytes
void BLEManager::sendMotionPacket(uint32_t timestampMs, const IMUData& imu) {
    if (!deviceConnected || !isStreaming || pCharSensor == nullptr) return;

    uint8_t packet[18];
    packet[0] = PACKET_TYPE_MOTION; // 0x01

    // Timestamp (little endian)
    packet[1] = (uint8_t)(timestampMs & 0xFF);
    packet[2] = (uint8_t)((timestampMs >> 8) & 0xFF);
    packet[3] = (uint8_t)((timestampMs >> 16) & 0xFF);
    packet[4] = (uint8_t)((timestampMs >> 24) & 0xFF);

    // Accel in milli-g (1g = 1000 mg)
    int16_t axMg = (int16_t)(imu.ax * 1000.0f);
    int16_t ayMg = (int16_t)(imu.ay * 1000.0f);
    int16_t azMg = (int16_t)(imu.az * 1000.0f);

    packet[5] = (uint8_t)(axMg & 0xFF);
    packet[6] = (uint8_t)((axMg >> 8) & 0xFF);
    packet[7] = (uint8_t)(ayMg & 0xFF);
    packet[8] = (uint8_t)((ayMg >> 8) & 0xFF);
    packet[9] = (uint8_t)(azMg & 0xFF);
    packet[10] = (uint8_t)((azMg >> 8) & 0xFF);

    // Gyro in 0.1 dps
    int16_t gxUnits = (int16_t)(imu.gx * 10.0f);
    int16_t gyUnits = (int16_t)(imu.gy * 10.0f);
    int16_t gzUnits = (int16_t)(imu.gz * 10.0f);

    packet[11] = (uint8_t)(gxUnits & 0xFF);
    packet[12] = (uint8_t)((gxUnits >> 8) & 0xFF);
    packet[13] = (uint8_t)(gyUnits & 0xFF);
    packet[14] = (uint8_t)((gyUnits >> 8) & 0xFF);
    packet[15] = (uint8_t)(gzUnits & 0xFF);
    packet[16] = (uint8_t)((gzUnits >> 8) & 0xFF);

    packet[17] = calculateChecksum(packet, 17);

    pCharSensor->setValue(packet, 18);
    pCharSensor->notify();
}

// 0x02: Device Status Packet (transmitted on 1% battery drop or periodic 5min)
// Format: [0x02 (1B) | Battery% (1B) | FwMajor (1B) | FwMinor (1B) | UptimeSec (4B) | isBleConnected (1B) | checksum (1B)] -> 10 Bytes
void BLEManager::sendStatusPacket(uint8_t batteryPct, uint8_t fwMajor, uint8_t fwMinor, uint32_t uptimeSec, uint8_t isBleConnected) {
    if (!deviceConnected || pCharStatus == nullptr) return;

    uint8_t packet[10];
    packet[0] = PACKET_TYPE_STATUS; // 0x02
    packet[1] = batteryPct;
    packet[2] = fwMajor;
    packet[3] = fwMinor;

    packet[4] = (uint8_t)(uptimeSec & 0xFF);
    packet[5] = (uint8_t)((uptimeSec >> 8) & 0xFF);
    packet[6] = (uint8_t)((uptimeSec >> 16) & 0xFF);
    packet[7] = (uint8_t)((uptimeSec >> 24) & 0xFF);

    packet[8] = isBleConnected;
    packet[9] = calculateChecksum(packet, 9);

    pCharStatus->setValue(packet, 10);
    pCharStatus->notify();
}

// 0x03: Environment Packet (1 Hz)
// Format: [0x03 (1B) | Timestamp ms (4B) | Temp (4B float) | Pressure (4B float) | Humidity (4B float) | checksum (1B)] -> 18 Bytes
void BLEManager::sendEnvironmentPacket(uint32_t timestampMs, float tempC, float pressureHpa, float humidityPct) {
    if (!deviceConnected || pCharFeature == nullptr) return;

    uint8_t packet[18];
    packet[0] = PACKET_TYPE_ENVIRONMENT; // 0x03

    packet[1] = (uint8_t)(timestampMs & 0xFF);
    packet[2] = (uint8_t)((timestampMs >> 8) & 0xFF);
    packet[3] = (uint8_t)((timestampMs >> 16) & 0xFF);
    packet[4] = (uint8_t)((timestampMs >> 24) & 0xFF);

    memcpy(&packet[5], &tempC, 4);
    memcpy(&packet[9], &pressureHpa, 4);
    memcpy(&packet[13], &humidityPct, 4);

    packet[17] = calculateChecksum(packet, 17);

    pCharFeature->setValue(packet, 18);
    pCharFeature->notify();
}

// 0x04: Vital Packet (100 Hz)
// Format: [0x04 (1B) | Timestamp ms (4B) | RedChannel (4B) | IRChannel (4B) | SignalQuality (1B) | checksum (1B)] -> 15 Bytes
void BLEManager::sendVitalPacket(uint32_t timestampMs, uint32_t red, uint32_t ir, uint8_t signalQuality) {
    if (!deviceConnected || !isStreaming || pCharFeature == nullptr) return;

    uint8_t packet[15];
    packet[0] = PACKET_TYPE_VITAL; // 0x04

    packet[1] = (uint8_t)(timestampMs & 0xFF);
    packet[2] = (uint8_t)((timestampMs >> 8) & 0xFF);
    packet[3] = (uint8_t)((timestampMs >> 16) & 0xFF);
    packet[4] = (uint8_t)((timestampMs >> 24) & 0xFF);

    memcpy(&packet[5], &red, 4);
    memcpy(&packet[9], &ir, 4);

    packet[13] = signalQuality;
    packet[14] = calculateChecksum(packet, 14);

    pCharFeature->setValue(packet, 15);
    pCharFeature->notify();
}

void BLEManager::sendFeaturePacket(uint8_t seq, uint8_t anomalyScore, uint8_t motionState, uint8_t dominantFreqHz, uint8_t zcr, uint8_t spectralEntropy, uint16_t eigenvalueRatioScaled, uint8_t wearConfidence, uint16_t peakResultantAccelMg, uint16_t durationUnits, const int8_t* motionEmbedding, uint8_t isThreat, const float* twelveFeatures) {
    if (!deviceConnected || pCharFeature == nullptr) return;

    uint8_t packet[46];
    packet[0] = 0x04;
    packet[1] = seq;
    packet[2] = anomalyScore;
    packet[3] = motionState;
    packet[4] = dominantFreqHz;
    packet[5] = zcr;
    packet[6] = spectralEntropy;
    packet[7] = static_cast<uint8_t>(eigenvalueRatioScaled & 0xFF);
    packet[8] = static_cast<uint8_t>((eigenvalueRatioScaled >> 8) & 0xFF);
    packet[9] = wearConfidence;
    packet[10] = static_cast<uint8_t>(peakResultantAccelMg & 0xFF);
    packet[11] = static_cast<uint8_t>((peakResultantAccelMg >> 8) & 0xFF);
    packet[12] = static_cast<uint8_t>(durationUnits & 0xFF);
    packet[13] = static_cast<uint8_t>((durationUnits >> 8) & 0xFF);

    if (motionEmbedding != nullptr) {
        memcpy(&packet[14], motionEmbedding, 16);
    } else {
        memset(&packet[14], 0, 16);
    }

    packet[30] = isThreat;

    uint16_t u_std  = (twelveFeatures != nullptr) ? static_cast<uint16_t>(twelveFeatures[0] * 1000.0f) : 0;
    int16_t s_skew  = (twelveFeatures != nullptr) ? static_cast<int16_t>(twelveFeatures[2] * 1000.0f) : 0;
    int16_t s_kurt  = (twelveFeatures != nullptr) ? static_cast<int16_t>(twelveFeatures[3] * 100.0f) : 0;
    uint16_t u_peak = (twelveFeatures != nullptr) ? static_cast<uint16_t>(twelveFeatures[7] * 10000.0f) : 0;
    uint16_t u_band = (twelveFeatures != nullptr) ? static_cast<uint16_t>(twelveFeatures[8] * 10000.0f) : 0;
    uint16_t u_var  = (twelveFeatures != nullptr) ? static_cast<uint16_t>(twelveFeatures[10] / 10.0f) : 0;
    uint16_t u_coup = (twelveFeatures != nullptr) ? static_cast<uint16_t>(twelveFeatures[11] * 1000.0f) : 0;

    packet[31] = static_cast<uint8_t>(u_std & 0xFF);
    packet[32] = static_cast<uint8_t>((u_std >> 8) & 0xFF);
    packet[33] = static_cast<uint8_t>(s_skew & 0xFF);
    packet[34] = static_cast<uint8_t>((s_skew >> 8) & 0xFF);
    packet[35] = static_cast<uint8_t>(s_kurt & 0xFF);
    packet[36] = static_cast<uint8_t>((s_kurt >> 8) & 0xFF);
    packet[37] = static_cast<uint8_t>(u_peak & 0xFF);
    packet[38] = static_cast<uint8_t>((u_peak >> 8) & 0xFF);
    packet[39] = static_cast<uint8_t>(u_band & 0xFF);
    packet[40] = static_cast<uint8_t>((u_band >> 8) & 0xFF);
    packet[41] = static_cast<uint8_t>(u_var & 0xFF);
    packet[42] = static_cast<uint8_t>((u_var >> 8) & 0xFF);
    packet[43] = static_cast<uint8_t>(u_coup & 0xFF);
    packet[44] = static_cast<uint8_t>((u_coup >> 8) & 0xFF);

    packet[45] = calculateChecksum(packet, 45);

    pCharFeature->setValue(packet, 46);
    pCharFeature->notify();
}

void BLEManager::handleConnectionStatus() {
    if (deviceConnected && !oldDeviceConnected) {
        oldDeviceConnected = deviceConnected;
        Serial.println("[BLE] Phone connected. Switched to BLE ON mode.");
    }
    if (!deviceConnected && oldDeviceConnected) {
        oldDeviceConnected = deviceConnected;
        isStreaming = false;
        Serial.println("[BLE] Phone disconnected. Switched to BLE OFF mode (Autonomous Local Sensing). Restarting advertising.");
        BLEDevice::startAdvertising();
    }
}

uint8_t BLEManager::calculateChecksum(const uint8_t* buffer, size_t length) {
    uint8_t checksum = 0;
    for (size_t i = 0; i < length; i++) {
        checksum ^= buffer[i];
    }
    return checksum;
}

void BLEManager::processCommand(uint8_t command) {
    Serial.printf("[BLE] Processing command: 0x%02X\n", command);

    switch (command) {
        case 0x01: // Start streaming
            isStreaming = true;
            Serial.println("[BLE] Command: Start streaming.");
            break;
        case 0x02: // Stop streaming
            isStreaming = false;
            Serial.println("[BLE] Command: Stop streaming.");
            break;
        case 0x03: // Request immediate Status Packet
            Serial.println("[BLE] Command: Immediate status requested.");
            break;
        case 0x04: // Acknowledge event
            eventAck = true;
            Serial.println("[BLE] Command: Event acknowledged.");
            break;
        case 0x05: // Calibration request
            calibrationRequest = true;
            Serial.println("[BLE] Command: Calibration requested.");
            break;
        case 0xFF: // Emergency cancel (e.g. cancel fall countdown)
            eventAck = true;
            EdgeAnalytics::getInstance().cancelFallAlarm();
            Serial.println("[BLE] Command: Fall/Emergency alert cancelled by phone.");
            break;
        default:
            Serial.printf("[BLE] Unknown command: 0x%02X\n", command);
            break;
    }
}
