#include "EnvironmentSensor.h"

EnvironmentSensor& EnvironmentSensor::getInstance() {
    static EnvironmentSensor instance;
    return instance;
}

EnvironmentSensor::EnvironmentSensor()
    : sensorAddr(BMP280_ADDR_PRIMARY)
    , isInitialized(false)
    , hasHumidity(false)
    , dig_T1(0), dig_T2(0), dig_T3(0)
    , dig_P1(0), dig_P2(0), dig_P3(0), dig_P4(0), dig_P5(0), dig_P6(0), dig_P7(0), dig_P8(0), dig_P9(0)
    , t_fine(0) {}

bool EnvironmentSensor::begin() {
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);

    // Try primary address 0x76, then secondary 0x77
    uint8_t chipId = 0;
    sensorAddr = BMP280_ADDR_PRIMARY;
    if (!readRegisters(0xD0, &chipId, 1) || (chipId != 0x58 && chipId != 0x60)) {
        sensorAddr = BMP280_ADDR_SECONDARY;
        if (!readRegisters(0xD0, &chipId, 1) || (chipId != 0x58 && chipId != 0x60)) {
            Serial.println("[EnvSensor] Warning: BMP280/BME280 not detected on I2C bus.");
            isInitialized = false;
            return false;
        }
    }

    if (chipId == 0x60) {
        hasHumidity = true;
        Serial.println("[EnvSensor] BME280 detected (with humidity sensor).");
    } else {
        hasHumidity = false;
        Serial.println("[EnvSensor] BMP280 detected (Temp + Pressure). Using fallback humidity.");
    }

    // Read calibration registers
    if (!readCalibration()) {
        Serial.println("[EnvSensor] Error: Failed to read calibration data.");
        isInitialized = false;
        return false;
    }

    // Reset sensor
    writeRegister(0xE0, 0xB6);
    delay(50);

    // Normal mode, temp oversampling x2, pressure oversampling x16
    writeRegister(0xF4, 0x57);
    // Standby 500ms, filter coeff 16
    writeRegister(0xF5, 0x90);

    isInitialized = true;
    Serial.printf("[EnvSensor] Initialized at I2C address 0x%02X.\n", sensorAddr);
    return true;
}

bool EnvironmentSensor::readCalibration() {
    uint8_t calib[24];
    if (!readRegisters(0x88, calib, 24)) return false;

    dig_T1 = (calib[1] << 8) | calib[0];
    dig_T2 = (int16_t)((calib[3] << 8) | calib[2]);
    dig_T3 = (int16_t)((calib[5] << 8) | calib[4]);

    dig_P1 = (calib[7] << 8) | calib[6];
    dig_P2 = (int16_t)((calib[9] << 8) | calib[8]);
    dig_P3 = (int16_t)((calib[11] << 8) | calib[10]);
    dig_P4 = (int16_t)((calib[13] << 8) | calib[12]);
    dig_P5 = (int16_t)((calib[15] << 8) | calib[14]);
    dig_P6 = (int16_t)((calib[17] << 8) | calib[16]);
    dig_P7 = (int16_t)((calib[19] << 8) | calib[18]);
    dig_P8 = (int16_t)((calib[21] << 8) | calib[20]);
    dig_P9 = (int16_t)((calib[23] << 8) | calib[22]);

    return true;
}

bool EnvironmentSensor::readSample(EnvironmentData& data) {
    if (!isInitialized) {
        // Fallback default nominal values
        data.temperature = 25.0f;
        data.pressure = 1013.25f;
        data.humidity = DEFAULT_DUMMY_HUMIDITY;
        data.heatIndexF = calculateHeatIndexF(data.temperature, data.humidity);
        data.isAvailable = false;
        return false;
    }

    uint8_t raw[6];
    if (!readRegisters(0xF7, raw, 6)) {
        data.isAvailable = false;
        return false;
    }

    int32_t adc_P = ((int32_t)raw[0] << 12) | ((int32_t)raw[1] << 4) | (raw[2] >> 4);
    int32_t adc_T = ((int32_t)raw[3] << 12) | ((int32_t)raw[4] << 4) | (raw[5] >> 4);

    // Temperature compensation
    int32_t var1 = ((((adc_T >> 3) - ((int32_t)dig_T1 << 1))) * ((int32_t)dig_T2)) >> 11;
    int32_t var2 = (((((adc_T >> 4) - ((int32_t)dig_T1)) * ((adc_T >> 4) - ((int32_t)dig_T1))) >> 12) * ((int32_t)dig_T3)) >> 14;
    t_fine = var1 + var2;
    float tempC = (t_fine * 5 + 128) >> 8;
    tempC = tempC / 100.0f;

    // Pressure compensation
    int64_t p_var1 = ((int64_t)t_fine) - 128000;
    int64_t p_var2 = p_var1 * p_var1 * (int64_t)dig_P6;
    p_var2 = p_var2 + ((p_var1 * (int64_t)dig_P5) << 17);
    p_var2 = p_var2 + (((int64_t)dig_P4) << 35);
    p_var1 = ((p_var1 * p_var1 * (int64_t)dig_P3) >> 8) + ((p_var1 * (int64_t)dig_P2) << 12);
    p_var1 = (((((int64_t)1) << 47) + p_var1)) * ((int64_t)dig_P1) >> 33;

    float pressureHpa = 1013.25f;
    if (p_var1 != 0) {
        int64_t p = 1048576 - adc_P;
        p = (((p << 31) - p_var2) * 3125) / p_var1;
        p_var1 = (((int64_t)dig_P9) * (p >> 13) * (p >> 13)) >> 25;
        p_var2 = (((int64_t)dig_P8) * p) >> 19;
        p = ((p + p_var1 + p_var2) >> 8) + (((int64_t)dig_P7) << 4);
        pressureHpa = (float)p / 25600.0f;
    }

    data.temperature = tempC;
    data.pressure = pressureHpa;
    data.humidity = DEFAULT_DUMMY_HUMIDITY; // Using fallback constant
    data.heatIndexF = calculateHeatIndexF(data.temperature, data.humidity);
    data.isAvailable = true;

    return true;
}

float EnvironmentSensor::calculateHeatIndexF(float tempC, float humidityPct) {
    // Convert temperature to Fahrenheit
    float T = (tempC * 1.8f) + 32.0f;
    float RH = humidityPct;

    // NOAA Rothfusz regression equation
    float HI = -42.379f + (2.04901523f * T) + (10.14333127f * RH)
               - (0.22475541f * T * RH) - (0.00683783f * T * T)
               - (0.05481717f * RH * RH) + (0.00122874f * T * T * RH)
               + (0.00085282f * T * RH * RH) - (0.00000199f * T * T * RH * RH);

    return HI;
}

bool EnvironmentSensor::writeRegister(uint8_t reg, uint8_t value) {
    Wire.beginTransmission(sensorAddr);
    Wire.write(reg);
    Wire.write(value);
    return (Wire.endTransmission() == 0);
}

bool EnvironmentSensor::readRegisters(uint8_t reg, uint8_t* buffer, uint8_t length) {
    Wire.beginTransmission(sensorAddr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) {
        return false;
    }

    uint8_t count = Wire.requestFrom(sensorAddr, length);
    if (count != length) {
        return false;
    }

    for (uint8_t i = 0; i < length; i++) {
        buffer[i] = Wire.read();
    }
    return true;
}
