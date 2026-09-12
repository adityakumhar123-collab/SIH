#ifndef BUZZER_MANAGER_H
#define BUZZER_MANAGER_H

#include <Arduino.h>
#include "Config.h"

enum AlertPattern {
    ALERT_NONE = 0,
    ALERT_FALL = 1,          // 1 Buzz
    ALERT_PHYSIOLOGY = 2,    // 2 Buzzes
    ALERT_ENVIRONMENT = 3    // 3 Buzzes
};

class BuzzerManager {
public:
    static BuzzerManager& getInstance();

    void begin();
    void triggerAlert(AlertPattern pattern);
    void update(); // Called periodically in FreeRTOS task or loop

private:
    BuzzerManager();
    ~BuzzerManager() = default;

    BuzzerManager(const BuzzerManager&) = delete;
    BuzzerManager& operator=(const BuzzerManager&) = delete;

    uint8_t buzzerPin;
    AlertPattern currentPattern;
    uint8_t stepIndex;
    uint32_t stepEndTimeMs;
    bool isPlaying;

    void setBuzzerState(bool on);
};

#endif // BUZZER_MANAGER_H
