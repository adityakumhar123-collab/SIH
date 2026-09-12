#ifndef CONFIG_H
#define CONFIG_H

#include <Arduino.h>

// ==========================================
// Firmware Version
// ==========================================
#define FIRMWARE_VERSION_MAJOR 1
#define FIRMWARE_VERSION_MINOR 0
#define FIRMWARE_VERSION_STR   "SafeBand-ESP32 v1.0.0"

// ==========================================
// Sensor and Windowing Settings
// ==========================================
#define SAMPLE_RATE_HZ 100
#define SAMPLE_INTERVAL_MS (1000 / SAMPLE_RATE_HZ) // 10ms
#define WINDOW_SIZE 200                             // 2.0 seconds at 100 Hz
#define STRIDE_SIZE 50                              // 0.5 second stride

// Feature Extraction Constants for Legacy/TFLite models (if enabled)
#define FFT_SIZE 256
#define NUM_CHANNELS 9    // Ax, Ay, Az, Gx, Gy, Gz, ResultantA, Jerk, SMA
#define TIER1_FEATURES 90 // 10 features x 9 channels
#define TIER2_FEATURES 42 // 7 features x 6 primary channels
#define TIER3_FEATURES 12 // 12 structural features
#define SUB_WINDOW_SIZE 20
#define NUM_SUB_WINDOWS 10
#define SEQ_FEATURES (NUM_SUB_WINDOWS * (TIER1_FEATURES + TIER2_FEATURES)) // 1320
#define TOTAL_FEATURES (SEQ_FEATURES + TIER3_FEATURES)  // 1332
#define DEFAULT_THRESHOLD 1.01309f
#define HYSTERESIS_WINDOWS 5

// ==========================================
// BLE Packet Types
// ==========================================
#define PACKET_TYPE_MOTION      0x01
#define PACKET_TYPE_STATUS      0x02
#define PACKET_TYPE_ENVIRONMENT 0x03
#define PACKET_TYPE_VITAL       0x04

// ==========================================
// BLE GATT Specification (UUIDs)
// ==========================================
#define BLE_DEVICE_NAME "SafeBand-ESP32"
#define SERVICE_UUID           "4fafc201-1fb5-459e-8fcc-c5c9c331914b"
#define CHAR_UUID_COMMAND      "c083bcf3-4c9b-44c0-9943-228ae92e8fa4" // Write (Commands)
#define CHAR_UUID_DEVICE_INFO  "d2b781e9-4e78-43e9-92c1-d2a84e92a2a0" // Read (Device Info)
#define CHAR_UUID_STATUS       "8f1f7e34-bb52-4467-b5cc-fb5a8e03e5c9" // Notify (Heartbeat Status 0x02)
#define CHAR_UUID_SENSOR       "c9298492-95b6-455f-8c3a-bb5a8e03e5ca" // Notify (100Hz Motion 0x01)
#define CHAR_UUID_FEATURE      "e2e0a294-814d-45db-9c3f-bb5a8e03e5cb" // Notify (100Hz Vitals 0x04 & 1Hz Env 0x03)

// ==========================================
// Hardware Pin Mappings
// ==========================================
#define I2C_SDA_PIN 27
#define I2C_SCL_PIN 25
#define BUZZER_PIN  26

// Battery ADC read pins
#define VBAT_CTRL_PIN -1
#define VBAT_READ_PIN -1
#define ADC_MAX_VALUE 4095
#define ADC_REFERENCE_V 3.3f
#define VBAT_DIVIDER_RATIO 2.0f

// ==========================================
// Edge Analytics & Heuristic Classification
// ==========================================
#define EWMA_ALPHA_PHYSIOLOGY   0.005f
#define EWMA_ALPHA_ENVIRONMENT  0.005f
#define EWMA_ALPHA_MOTION       0.010f

// Hard Bounds: Physiological (NEWS2 Guidance)
#define HR_MIN_HARD_BOUND       40.0f
#define HR_MAX_HARD_BOUND       180.0f
#define SPO2_MIN_HARD_BOUND     70.0f
#define SPO2_MAX_HARD_BOUND     100.0f

// Critical Anomaly Thresholds (Physiological)
#define SPO2_CRITICAL_LOW       90.0f
#define HR_CRITICAL_BRADY       45.0f
#define HR_CRITICAL_TACHY       135.0f

// Hard Bounds: Environment
#define TEMP_MIN_HARD_BOUND     -10.0f // deg C
#define TEMP_MAX_HARD_BOUND     60.0f  // deg C
#define PRESS_MIN_HARD_BOUND    700.0f // hPa
#define PRESS_MAX_HARD_BOUND    1100.0f// hPa
#define HUMID_MIN_HARD_BOUND    0.0f   // %
#define HUMID_MAX_HARD_BOUND    100.0f // %
#define DEFAULT_DUMMY_HUMIDITY  50.0f  // Fallback % RH

// Heat Index Risk Thresholds (°F)
#define HEAT_INDEX_CAUTION         80.0f
#define HEAT_INDEX_EXTREME_CAUTION 91.0f
#define HEAT_INDEX_DANGER          104.0f
#define HEAT_INDEX_EXTREME_DANGER  125.0f

// Fall Detection Parameters
#define FALL_TROUGH_G              0.65f   // Low-g free fall threshold
#define FALL_IMPACT_G              2.20f   // High-g impact peak threshold
#define FALL_IMPACT_GYRO_DPS       180.0f  // Gyro peak threshold
#define FALL_POSTURE_CHANGE_DEG    40.0f   // Tilt orientation delta
#define FALL_REST_RMS_G            0.15f   // Post-impact stillness max RMS
#define FALL_CANCEL_TIMEOUT_MS     10000   // 10s cancellation window

#endif // CONFIG_H
