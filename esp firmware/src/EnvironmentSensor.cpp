#include "EnvironmentSensor.h"

EnvironmentSensor& EnvironmentSensor::getInstance() {
    static EnvironmentSensor instance;
    return instance;
}

EnvironmentSensor::EnvironmentSensor()
    : dht(DHT_PIN, DHT_TYPE)
    , isInitialized(false)
    , cachedTemp(25.0f)
    , cachedHumidity(50.0f)
    , cachedHeatIndexF(77.0f)
    , lastReadTimeMs(0) {}

bool EnvironmentSensor::begin() {
    Serial.printf("[EnvSensor] Initializing DHT11 on GPIO %d...\n", DHT_PIN);
    dht.begin();

    // Give sensor time to power up (DHT11 requires ~1s after power-on)
    delay(100);

    float t = dht.readTemperature();
    float h = dht.readHumidity();

    if (!isnan(t) && !isnan(h) && t > -20.0f && t < 80.0f && h >= 0.0f && h <= 100.0f) {
        cachedTemp = t;
        cachedHumidity = h;
        cachedHeatIndexF = calculateHeatIndexF(t, h);
        isInitialized = true;
        lastReadTimeMs = millis();
        Serial.printf("[EnvSensor] DHT11 initialized successfully: Temp=%.1f°C, Hum=%.1f%%, HeatIndex=%.1f°F\n",
                      cachedTemp, cachedHumidity, cachedHeatIndexF);
        return true;
    }

    // DHT11 might take up to 1-2s to produce its first reading, so mark initialized with nominal values
    isInitialized = true;
    cachedHeatIndexF = calculateHeatIndexF(cachedTemp, cachedHumidity);
    Serial.println("[EnvSensor] DHT11 started (initial reading pending, will update on next 2s cycle).");
    return true;
}

bool EnvironmentSensor::readSample(EnvironmentData& data) {
    unsigned long now = millis();

    // DHT11 hardware spec: read at most every 2000ms
    if (now - lastReadTimeMs >= 2000 || lastReadTimeMs == 0) {
        float t = dht.readTemperature();
        float h = dht.readHumidity();

        if (!isnan(t) && !isnan(h) && t > -40.0f && t < 85.0f && h >= 0.0f && h <= 100.0f) {
            cachedTemp = t;
            cachedHumidity = h;
            cachedHeatIndexF = calculateHeatIndexF(t, h);
            lastReadTimeMs = now;
        } else {
            // Retain previous reading on occasional timing collisions
            static unsigned long lastFailLog = 0;
            if (now - lastFailLog > 10000) {
                lastFailLog = now;
                Serial.println("[EnvSensor] Note: DHT11 returned NaN, retaining previous valid reading.");
            }
        }
    }

    data.temperature = cachedTemp;
    data.pressure = 0.0f; // BMP280 removed; DHT11 does not provide barometric pressure
    data.humidity = cachedHumidity;
    data.heatIndexF = cachedHeatIndexF;
    data.isAvailable = isInitialized;

    return true;
}

float EnvironmentSensor::calculateHeatIndexF(float tempC, float humidityPct) {
    // Convert temperature to Fahrenheit
    float T = (tempC * 1.8f) + 32.0f;
    float RH = humidityPct;

    // Simple formula for low temperatures (< 80°F)
    if (T < 80.0f) {
        return 0.5f * (T + 61.0f + ((T - 68.0f) * 1.2f) + (RH * 0.094f));
    }

    // NOAA Rothfusz regression equation
    float HI = -42.379f + (2.04901523f * T) + (10.14333127f * RH)
               - (0.22475541f * T * RH) - (0.00683783f * T * T)
               - (0.05481717f * RH * RH) + (0.00122874f * T * T * RH)
               + (0.00085282f * T * RH * RH) - (0.00000199f * T * T * RH * RH);

    return HI;
}
