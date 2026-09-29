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
        cachedHeatIndexF = dht.computeHeatIndex(t, h, false); // Adafruit built-in NOAA Rothfusz (false = °C input → °F output)
        isInitialized = true;
        lastReadTimeMs = millis();
        Serial.printf("[EnvSensor] DHT11 initialized successfully: Temp=%.1f°C, Hum=%.1f%%, HeatIndex=%.1f°F\n",
                      cachedTemp, cachedHumidity, cachedHeatIndexF);
        return true;
    }

    // DHT11 might take up to 1-2s to produce its first reading, so mark initialized with nominal values
    isInitialized = true;
    cachedHeatIndexF = dht.computeHeatIndex(cachedTemp, cachedHumidity, false);
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
            cachedHeatIndexF = dht.computeHeatIndex(t, h, false); // Adafruit built-in NOAA Rothfusz
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
    data.humidity = cachedHumidity;
    data.heatIndexF = cachedHeatIndexF;
    data.isAvailable = isInitialized;

    return true;
}

