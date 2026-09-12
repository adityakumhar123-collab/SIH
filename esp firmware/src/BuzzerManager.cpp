#include "BuzzerManager.h"

BuzzerManager& BuzzerManager::getInstance() {
    static BuzzerManager instance;
    return instance;
}

BuzzerManager::BuzzerManager()
    : buzzerPin(BUZZER_PIN)
    , currentPattern(ALERT_NONE)
    , stepIndex(0)
    , stepEndTimeMs(0)
    , isPlaying(false) {}

void BuzzerManager::begin() {
    pinMode(buzzerPin, OUTPUT);
    digitalWrite(buzzerPin, LOW);
    Serial.printf("[Buzzer] Initialized on GPIO %d.\n", buzzerPin);
}

void BuzzerManager::triggerAlert(AlertPattern pattern) {
    if (pattern == ALERT_NONE) return;

    currentPattern = pattern;
    stepIndex = 0;
    isPlaying = true;
    stepEndTimeMs = millis();
    Serial.printf("[Buzzer] Triggered alert pattern: %d (%s)\n",
                  pattern,
                  pattern == ALERT_FALL ? "Fall: 1 Buzz" :
                  pattern == ALERT_PHYSIOLOGY ? "Physiology: 2 Buzzes" : "Environment: 3 Buzzes");
}

void BuzzerManager::setBuzzerState(bool on) {
    digitalWrite(buzzerPin, on ? HIGH : LOW);
}

void BuzzerManager::update() {
    if (!isPlaying) return;

    uint32_t nowMs = millis();
    if (nowMs < stepEndTimeMs) return;

    switch (currentPattern) {
        case ALERT_FALL: // 1 Buzz: 800ms ON, then OFF
            if (stepIndex == 0) {
                setBuzzerState(true);
                stepEndTimeMs = nowMs + 800;
                stepIndex++;
            } else {
                setBuzzerState(false);
                isPlaying = false;
            }
            break;

        case ALERT_PHYSIOLOGY: // 2 Buzzes: 300ms ON, 200ms OFF, 300ms ON, then OFF
            if (stepIndex == 0) {
                setBuzzerState(true);
                stepEndTimeMs = nowMs + 300;
                stepIndex++;
            } else if (stepIndex == 1) {
                setBuzzerState(false);
                stepEndTimeMs = nowMs + 200;
                stepIndex++;
            } else if (stepIndex == 2) {
                setBuzzerState(true);
                stepEndTimeMs = nowMs + 300;
                stepIndex++;
            } else {
                setBuzzerState(false);
                isPlaying = false;
            }
            break;

        case ALERT_ENVIRONMENT: // 3 Buzzes: 200ms ON, 150ms OFF, 200ms ON, 150ms OFF, 200ms ON, then OFF
            if (stepIndex == 0) {
                setBuzzerState(true);
                stepEndTimeMs = nowMs + 200;
                stepIndex++;
            } else if (stepIndex == 1) {
                setBuzzerState(false);
                stepEndTimeMs = nowMs + 150;
                stepIndex++;
            } else if (stepIndex == 2) {
                setBuzzerState(true);
                stepEndTimeMs = nowMs + 200;
                stepIndex++;
            } else if (stepIndex == 3) {
                setBuzzerState(false);
                stepEndTimeMs = nowMs + 150;
                stepIndex++;
            } else if (stepIndex == 4) {
                setBuzzerState(true);
                stepEndTimeMs = nowMs + 200;
                stepIndex++;
            } else {
                setBuzzerState(false);
                isPlaying = false;
            }
            break;

        default:
            setBuzzerState(false);
            isPlaying = false;
            break;
    }
}
