#include <Arduino.h>
#include <Wire.h>
#include "Config.h"
#include "IMUSensor.h"
#include "VitalSensor.h"
#include "EnvironmentSensor.h"
#include "BuzzerManager.h"
#include "EdgeAnalytics.h"
#include "BLEManager.h"
#include "PowerManager.h"

// FreeRTOS Task Handles
TaskHandle_t samplerTaskHandle = nullptr;
TaskHandle_t environmentTaskHandle = nullptr;
TaskHandle_t buzzerTaskHandle = nullptr;

// System tracking
uint8_t systemFlags = 0;
uint8_t lastReportedBatteryPct = 100;
uint32_t lastStatusPacketTimeMs = 0;

// Shared latest readings for periodic serial diagnostics
IMUData g_latestImu = {0};
VitalData g_latestVital = {0};
EnvironmentData g_latestEnv = {0};

// Task prototypes
void SamplerTask(void* pvParameters);
void EnvironmentTask(void* pvParameters);
void BuzzerTask(void* pvParameters);

// I2C Bus Scanner
void scanI2CBus() {
    Serial.println("\n---------------- I2C Bus Scan ----------------");
    Serial.printf("Scanning I2C on SDA=GPIO%d, SCL=GPIO%d...\n", I2C_SDA_PIN, I2C_SCL_PIN);
    uint8_t count = 0;
    for (uint8_t addr = 1; addr < 127; addr++) {
        Wire.beginTransmission(addr);
        uint8_t error = Wire.endTransmission();
        if (error == 0) {
            Serial.printf(" -> Found I2C Device at 0x%02X ", addr);
            if (addr == 0x68 || addr == 0x69) Serial.print("(MPU-6050 / IMU)");
            else if (addr == 0x57) Serial.print("(MAX30102 PPG Vital)");
            else if (addr == 0x76 || addr == 0x77) Serial.print("(BMP280 / BME280 Environment)");
            Serial.println();
            count++;
        }
    }
    if (count == 0) {
        Serial.println(" -> No I2C devices found! Check SDA/SCL/VCC/GND connections.");
    } else {
        Serial.printf(" -> Scan complete: %d device(s) found.\n", count);
    }
    Serial.println("----------------------------------------------\n");
}

void setup() {
    Serial.begin(115200);
    unsigned long start_time = millis();
    while (!Serial && (millis() - start_time < 3000)) {
        delay(10);
    }

    Serial.println("\n=======================================================");
    Serial.println("     SafeBand Dual-Mode ESP32 Health Firmware          ");
    Serial.println("=======================================================");

    // 1. Initialize Power Manager
    PowerManager::getInstance().begin();
    systemFlags |= (1 << 2);

    // 2. Initialize Buzzer Subsystem
    BuzzerManager::getInstance().begin();

    // 3. Initialize I2C and Scan
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);
    Wire.setTimeOut(100);
    scanI2CBus();

    // 4. Initialize Sensors
    if (IMUSensor::getInstance().begin()) {
        systemFlags |= (1 << 0);
        Serial.println("[Setup] MPU6050 IMU initialized.");
    } else {
        Serial.println("[Setup] Warning: MPU6050 initialization failed! (Retrying in background)");
    }

    if (VitalSensor::getInstance().begin()) {
        systemFlags |= (1 << 4);
        Serial.println("[Setup] MAX30102 PPG Vital sensor initialized.");
    } else {
        Serial.println("[Setup] Warning: MAX30102 initialization failed! (Retrying in background)");
    }

    if (EnvironmentSensor::getInstance().begin()) {
        systemFlags |= (1 << 5);
        Serial.println("[Setup] BMP280/BME280 Environment sensor initialized.");
    } else {
        Serial.println("[Setup] Warning: BMP280 initialization failed! Using simulated defaults.");
    }

    // 5. Initialize Edge Analytics Engine
    EdgeAnalytics::getInstance().begin();

    // 6. Initialize BLE Stack
    BLEManager::getInstance().begin();
    systemFlags |= (1 << 1);

    lastReportedBatteryPct = PowerManager::getInstance().readBatteryPercentage();

    // 7. Spawn FreeRTOS Tasks
    Serial.printf("[Setup] Free Heap: %d bytes\n", ESP.getFreeHeap());

    // Task 1: 100 Hz Sampler Task on Core 1 (High priority)
    xTaskCreatePinnedToCore(
        SamplerTask,
        "SamplerTask",
        4096,
        nullptr,
        10,
        &samplerTaskHandle,
        1
    );

    // Task 2: 1 Hz Environment & Diagnostics Task on Core 0
    xTaskCreatePinnedToCore(
        EnvironmentTask,
        "EnvTask",
        4096,
        nullptr,
        3,
        &environmentTaskHandle,
        0
    );

    // Task 3: Buzzer & Connection Monitor Task on Core 0
    xTaskCreatePinnedToCore(
        BuzzerTask,
        "BuzzerTask",
        2048,
        nullptr,
        2,
        &buzzerTaskHandle,
        0
    );

    Serial.println("[Setup] SafeBand operating tasks started successfully.\n");
}

void loop() {
    vTaskDelete(nullptr);
}

// 1. High-Frequency Sampler Task (100 Hz - 10ms interval)
void SamplerTask(void* pvParameters) {
    TickType_t xLastWakeTime = xTaskGetTickCount();
    const TickType_t xFrequency = pdMS_TO_TICKS(SAMPLE_INTERVAL_MS); // 10ms

    IMUData imuSample;
    VitalData vitalSample;

    Serial.println("[Task] 100 Hz Sampler task active.");

    while (1) {
        vTaskDelayUntil(&xLastWakeTime, xFrequency);
        uint32_t nowMs = millis();

        // 1. Read IMU
        bool imuOk = IMUSensor::getInstance().readSample(imuSample);
        if (imuOk) {
            g_latestImu = imuSample;
            EdgeAnalytics::getInstance().processIMUSample(imuSample);

            // Mode 1 (BLE ON): Transmit 0x01 Motion Packet @ 100 Hz
            if (BLEManager::getInstance().isConnected()) {
                BLEManager::getInstance().sendMotionPacket(nowMs, imuSample);
            }
        }

        // 2. Read Vitals (MAX30102)
        bool vitalOk = VitalSensor::getInstance().readSample(vitalSample);
        if (vitalOk) {
            g_latestVital = vitalSample;
            EdgeAnalytics::getInstance().processVitalSample(vitalSample);

            // Mode 1 (BLE ON): Transmit 0x04 Vital Packet @ 100 Hz
            if (BLEManager::getInstance().isConnected() && vitalSample.fingerDetected) {
                BLEManager::getInstance().sendVitalPacket(nowMs, vitalSample.red, vitalSample.ir, vitalSample.signalQuality);
            }
        }
    }
}

// 2. Environment & Serial Diagnostics Task (1 Hz - 1000ms interval)
void EnvironmentTask(void* pvParameters) {
    TickType_t xLastWakeTime = xTaskGetTickCount();
    const TickType_t xFrequency = pdMS_TO_TICKS(1000); // 1000ms (1 Hz)

    EnvironmentData envSample;
    uint32_t diagCounter = 0;

    Serial.println("[Task] 1 Hz Environment & Diagnostics task active.");

    while (1) {
        vTaskDelayUntil(&xLastWakeTime, xFrequency);
        uint32_t nowMs = millis();

        // 1. Read Environment Sensor (BMP280 / BME280)
        EnvironmentSensor::getInstance().readSample(envSample);
        g_latestEnv = envSample;

        // Ingest into Edge Analytics Engine
        EdgeAnalytics::getInstance().processEnvironmentSample(envSample);

        // Mode 1 (BLE ON): Transmit 0x03 Environment Packet @ 1 Hz
        if (BLEManager::getInstance().isConnected()) {
            BLEManager::getInstance().sendEnvironmentPacket(
                nowMs,
                envSample.temperature,
                envSample.pressure,
                envSample.humidity
            );
        }

        // 2. Battery & Status Packet Check (0x02)
        uint8_t currentBatteryPct = PowerManager::getInstance().readBatteryPercentage();
        bool batteryChanged = (currentBatteryPct != lastReportedBatteryPct);
        bool periodicIntervalElapsed = (nowMs - lastStatusPacketTimeMs >= 300000); // 5 minutes

        if ((batteryChanged || periodicIntervalElapsed) && BLEManager::getInstance().isConnected()) {
            lastReportedBatteryPct = currentBatteryPct;
            lastStatusPacketTimeMs = nowMs;

            uint32_t uptimeSec = nowMs / 1000;
            uint8_t isBleConn = BLEManager::getInstance().isConnected() ? 1 : 0;

            BLEManager::getInstance().sendStatusPacket(
                currentBatteryPct,
                FIRMWARE_VERSION_MAJOR,
                FIRMWARE_VERSION_MINOR,
                uptimeSec,
                isBleConn
            );
        }

        // 3. Periodic Real-Time Serial Diagnostics (every 2 seconds)
        diagCounter++;
        if (diagCounter >= 2) {
            diagCounter = 0;
            const char* modeStr = BLEManager::getInstance().isConnected() ? "BLE ON (Streaming)" : "BLE OFF (Local Sensing)";
            const char* actStr = EdgeAnalytics::getInstance().getActivityString();
            bool fallPending = EdgeAnalytics::getInstance().isFallAlarmPending();
            uint32_t fallSec = EdgeAnalytics::getInstance().getFallCountdownRemainingSec();

            Serial.println("==================== [REAL-TIME SYSTEM MONITOR] ====================");
            Serial.printf("MODE: %s | Uptime: %lus | Battery: %d%%\n", modeStr, nowMs / 1000, currentBatteryPct);
            Serial.printf("[MOTION] State: %-7s | Ax: %5.2fg, Ay: %5.2fg, Az: %5.2fg | Gx: %6.1fdps, Gy: %6.1fdps, Gz: %6.1fdps\n",
                          actStr, g_latestImu.ax, g_latestImu.ay, g_latestImu.az, g_latestImu.gx, g_latestImu.gy, g_latestImu.gz);
            Serial.printf("[VITALS] Finger: %-3s | HR: %5.1f bpm | SpO2: %5.1f%% | SignalQuality: %3d%%\n",
                          g_latestVital.fingerDetected ? "YES" : "NO", g_latestVital.heartRate, g_latestVital.spo2, g_latestVital.signalQuality);
            Serial.printf("[ENV]    Temp: %5.1f°C | Press: %6.1f hPa | Humid: %4.1f%% | HeatIndex: %5.1f°F (%s)\n",
                          envSample.temperature, envSample.pressure, envSample.humidity, envSample.heatIndexF,
                          envSample.heatIndexF >= HEAT_INDEX_DANGER ? "DANGER" :
                          envSample.heatIndexF >= HEAT_INDEX_EXTREME_CAUTION ? "EXTREME CAUTION" :
                          envSample.heatIndexF >= HEAT_INDEX_CAUTION ? "CAUTION" : "NORMAL");
            Serial.printf("[ALERTS] Fall Alarm: %s%s\n",
                          fallPending ? "COUNTDOWN ACTIVE (" : "IDLE",
                          fallPending ? (String(fallSec) + "s remaining)").c_str() : "");
            Serial.println("====================================================================\n");
        }
    }
}

// 3. Buzzer & BLE Status Manager Task (Runs every 20ms)
void BuzzerTask(void* pvParameters) {
    TickType_t xLastWakeTime = xTaskGetTickCount();
    const TickType_t xFrequency = pdMS_TO_TICKS(20);

    while (1) {
        vTaskDelayUntil(&xLastWakeTime, xFrequency);

        // Non-blocking buzzer tone execution
        BuzzerManager::getInstance().update();

        // Monitor BLE connection / re-advertising
        BLEManager::getInstance().handleConnectionStatus();
    }
}