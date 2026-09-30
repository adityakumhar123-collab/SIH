# 🛡️ Raksha Band

### Offline-First Personal Health Companion for Disaster Resilience

> Smart India Hackathon 2026  
> Problem Statement ID: **SIH26181**  
> Theme: **MedTech / BioTech / HealthTech**  
> Organization: **Qualcomm Inc.**  
> Category: **Hardware**  
> Team: **AlphaZz**

---

## 📌 Overview

**Raksha Band** is an offline-first wearable and smartphone-based health and safety monitoring system designed for heatwaves, disasters, low-connectivity environments, and emergency situations.

The system combines:

- ❤️ Physiological monitoring
- 🏃 Motion sensing
- 🌡️ Environmental sensing
- 🧠 Personalized Edge-AI
- 📱 Offline smartphone processing
- 🚨 Local emergency alerts
- ☁️ Connectivity-aware caregiver notifications

Unlike systems that depend completely on cloud connectivity or fixed thresholds, Raksha Band performs its core safety functions locally.

Even when internet connectivity is unavailable, the system can continue monitoring the user, detect potentially dangerous events, provide local alerts, and store events for later synchronization.

---

## 🎯 Problem

During heatwaves, disasters, and network failures, access to immediate medical assistance can be delayed.

Falls, exhaustion, abnormal physiological conditions, or environmental stress may occur at a time when:

- Internet connectivity is unavailable
- The user cannot reach their phone
- Caregivers cannot immediately be contacted
- Cloud-based monitoring systems stop functioning
- Fixed thresholds produce unnecessary false alarms

Vulnerable users, elderly people, disaster-affected individuals, and field workers can therefore be left without reliable safety monitoring when they need it most.

---

## 💡 Our Solution

Raksha Band uses an **offline-first wearable + smartphone architecture**.

The wearable continuously collects physiological, motion, and environmental information and communicates with the mobile application through Bluetooth Low Energy.

The system follows five major stages:

### 1. SENSE

Collect:

- Heart Rate
- SpO₂
- Motion / Activity
- Temperature
- Humidity
- Environmental Context

### 2. PERSONALIZE

The system learns the user's normal activity and physiological patterns to create personalized baselines.

### 3. DETECT

Current sensor data is compared with those baselines using context-aware anomaly detection.

The system can identify:

- Falls
- Abnormal physiological patterns
- Unusual activity
- Environmental or heat-related risk

### 4. ACT OFFLINE

Critical functionality does not depend on the internet.

During a detected emergency, Raksha Band can use:

- 🔊 Buzzer alerts
- 📳 Vibration
- 💡 LED indication
- 📱 Local smartphone alerts
- 💾 Local event storage

### 5. RECONNECT

If connectivity is unavailable, emergency events are stored locally.

When connectivity returns, the application can synchronize stored events and notify configured caregivers.

---

## ✨ Key Innovations

### 🔌 Offline-First Safety

Critical detection and local alerts work without internet connectivity.

### 🧠 Personalized Baselines

Instead of depending only on fixed global thresholds, Raksha Band learns patterns specific to the user.

### 🔗 Multi-Sensor Fusion

The system combines:

- Physiological data
- Motion data
- Environmental data
- Contextual information

This gives the detection engine more context than a single-sensor wearable.

### 🛡️ Smart False-Alert Filtering

Temporary sensor abnormalities do not immediately trigger emergencies.

Persistence logic and multi-signal confirmation help filter short-lived anomalies.

### 🔐 Privacy-Focused Processing

Essential health analysis and event storage can remain on the wearable and smartphone.

Cloud services are not required for core safety monitoring.

---

## 🏗️ System Architecture

```text
┌─────────────────────────────────────┐
│          RAKSHA BAND WEARABLE       │
│                                     │
│  MAX30102 ── Heart Rate / SpO₂      │
│  MPU6050  ── Motion / Fall Data     │
│  DHT11    ── Temperature/Humidity   │
│                                     │
│              ESP32-S3               │
│        Local Fall Detection         │
└──────────────────┬──────────────────┘
                   │
                   │ Bluetooth Low Energy
                   ▼
┌─────────────────────────────────────┐
│            MOBILE APPLICATION       │
│                                     │
│   Episode / Activity Engine         │
│   Personalized Baselines            │
│   Sensor Fusion                     │
│   Anomaly Detection                 │
│   Persistence Logic                 │
│   Local SQLite Storage              │
│                                     │
└──────────────┬──────────────────────┘
               │
        Connectivity available?
               │
         ┌─────┴─────┐
         │           │
        NO          YES
         │           │
         ▼           ▼
   Store locally   Notify caregiver
   + local alert   SMS / WhatsApp /
                   Email
```

---

## ⚙️ Hardware

| Component | Purpose |
|---|---|
| **ESP32-S3** | Main wearable controller + BLE |
| **MPU6050** | 6-axis accelerometer and gyroscope |
| **MAX30102** | Heart-rate and SpO₂ sensing |
| **DHT11** | Temperature and humidity sensing |
| **Buzzer / Vibration / LED** | Local emergency alerts |

---

## 📱 Mobile Application

The companion application is responsible for personalized analysis, event storage, visualization, and emergency communication.

### Technologies

- React Native
- Expo
- TypeScript
- SQLite (`expo-sqlite`)
- `react-native-ble-plx`
- `expo-notifications`

---

## 🧠 AI / ML Pipeline

Raksha Band combines multiple lightweight AI and statistical techniques rather than depending on a single fixed threshold.

### Activity / Regime Detection

**Gaussian Mixture Models (GMM)** are used for activity and regime detection.

### Personalized Anomaly Detection

**Mahalanobis Distance** measures how far current sensor behaviour deviates from the user's learned baseline.

### Persistence Filtering

**CUSUM-based persistence logic** helps determine whether an abnormal condition is temporary or sustained.

This helps prevent isolated sensor spikes from immediately becoming emergency alerts.

### Edge Inference

**TensorFlow Lite** is used for efficient on-device/mobile inference.

---

## 🌡️ Disaster & Heatwave Resilience

Raksha Band is designed for situations where infrastructure and connectivity may not be reliable.

Environmental conditions are evaluated together with physiological and motion information.

Example:

```text
High Temperature
       +
Elevated Heart Rate
       +
Reduced Activity / Abnormal Motion
       +
Deviation from Personal Baseline
       ↓
Higher Risk Context
       ↓
Local Warning / Emergency Evaluation
```

This provides more useful context than evaluating one sensor independently.

---

## 🚨 Emergency Workflow

```text
Sensor Data
     ↓
Local Pre-processing
     ↓
Personalized Baseline Comparison
     ↓
Anomaly Detected
     ↓
Persistence + Multi-Signal Confirmation
     ↓
Potential Risk Event
     ↓
Immediate Offline Local Alert
     ↓
Event Stored Locally
     ↓
Internet Available?
      ↙       ↘
    NO         YES
    ↓           ↓
Continue     Caregiver
Offline      Notification
Monitoring
```

---

## 📡 Communication

### Wearable ↔ Smartphone

Communication between the wearable and smartphone uses:

**Bluetooth Low Energy (BLE)**

This allows the system to work locally without requiring internet connectivity.

### Caregiver Communication

When network connectivity is available:

- 📩 SMS — Twilio
- 💬 WhatsApp — Twilio
- 📧 Email — Resend

Cloud-based recommendations are optional and are not required for core emergency detection.

---

## 💾 Offline Data Storage

The mobile application uses **SQLite** for local persistence.

It can store:

- Sensor episodes
- User baselines
- Detected anomalies
- Emergency events
- Activity information
- Feedback
- Pending synchronization events

This allows Raksha Band to continue functioning during temporary network failure.

---

## 🔐 Privacy by Design

Raksha Band follows an offline-first architecture.

Critical processing can remain locally on the wearable and smartphone.

This reduces unnecessary transmission of sensitive health information and ensures that losing internet access does not disable core safety monitoring.

---

## 🧩 Technology Stack

| Layer | Technologies |
|---|---|
| Hardware | ESP32-S3, MPU6050, MAX30102, DHT11 |
| Firmware | ESP-IDF |
| Development | PlatformIO |
| BLE | NimBLE / React Native BLE |
| Mobile | React Native + Expo |
| Language | TypeScript |
| Database | SQLite |
| ML | TensorFlow Lite |
| Activity Detection | GMM |
| Anomaly Detection | Mahalanobis Distance |
| Persistence Logic | CUSUM |
| Notifications | Twilio + Resend |
| Updates | OTA Firmware Updates |

---

## 🧪 Current Prototype Status

### 🚧 Prototype Under Active Development

The project currently includes a working hardware/software prototype.

Current development includes:

- ✅ ESP32-S3 wearable controller
- ✅ MPU6050 motion sensing
- ✅ MAX30102 HR / SpO₂ sensing
- ✅ DHT11 environmental sensing
- ✅ BLE communication
- ✅ Mobile application
- ✅ Local SQLite storage
- ✅ Fall detection
- ✅ Personalized baseline engine
- ✅ Environmental monitoring
- ✅ Emergency alert workflow
- 🔄 AI / ML pipeline integration and tuning
- 🔄 Physical wearable integration
- 🔄 Field testing and calibration

> The current SIH prototype is approximately **70% complete**.

---

## ⚠️ Challenges & Mitigation

| Challenge | Mitigation |
|---|---|
| Sensor Noise | Filtering + signal-quality checks |
| False Alerts | CUSUM persistence + multi-signal confirmation |
| Connectivity Loss | Offline detection + local alerts + event storage |
| Baseline Drift | Adaptive baseline updates |

---

## 💰 Commercial Viability

### Estimated BOM at Scale

**₹1,200 – ₹1,500 per unit**

### Target Retail Range

**₹2,500 – ₹3,500**

The design uses commonly available components and a modular hardware/software architecture.

This supports future:

- PCB integration
- Simplified assembly
- Larger-scale manufacturing
- Cost optimization

> These are preliminary estimates and may change depending on suppliers, manufacturing scale, enclosure design, and production optimization.

---

## 👥 Target Users

Raksha Band is designed to support:

- 👴 Elderly and vulnerable individuals
- 🌪️ Disaster-affected populations
- 👨‍🚒 Field and emergency workers
- ☀️ People exposed to extreme heat
- 🏡 People living in low-connectivity areas
- 👨‍👩‍👧 Caregivers and families

---

## 🌍 Expected Impact

### Earlier Risk Awareness

Detect unusual patterns before conditions escalate.

### Personalized Protection

Use user-specific baselines instead of only fixed thresholds.

### Disaster Resilience

Maintain essential safety monitoring even during connectivity failures.

### Privacy Preservation

Keep essential processing and storage local whenever possible.

### Better Emergency Context

Combine physiological, motion, and environmental information instead of generating alerts from only one abnormal reading.

---

## 📂 Repository Structure

```text
SIH/
│
├── esp firmware/
│
├── mobile_app/
│
├── README.md
├── PROGRESS.md
└── current_status.md
```

---

## 🚀 Running the Project

### ESP32 Firmware

Install PlatformIO.

Navigate to the firmware folder:

```bash
cd "esp firmware"
```

Build:

```bash
pio run
```

Upload:

```bash
pio run --target upload
```

Monitor serial output:

```bash
pio device monitor
```

---

### Mobile Application

Navigate to the mobile application:

```bash
cd mobile_app
```

Install dependencies:

```bash
npm install
```

Start Expo:

```bash
npx expo start
```

Connect the Raksha Band hardware using Bluetooth Low Energy.

---

## 📚 Research Foundation

The project is informed by research and public-health guidance related to:

- Heat-stress physiology
- Wearable heat-strain monitoring
- Wearable fall detection
- PPG and pulse-oximetry limitations
- Edge computing for wearable devices
- NDMA Heat Wave Guidelines
- IMD heatwave research
- Heat Action Plans
- MoHFW heat-related illness guidance

These references support the project's focus on disaster resilience, physiological monitoring, fall detection, heat risk, and offline edge processing.

---

## 🎥 Prototype Demo

**Demo Video:**  
`ADD_VIDEO_LINK_HERE`

---

## 💻 Source Code

**GitHub Repository:**  
https://github.com/adityakumhar123-collab/SIH

---

## 🏆 Smart India Hackathon 2026

**Problem Statement ID:** SIH26181  
**Problem Statement:** AI-Powered Personal Health Companion for Disaster Resilience  
**Organization:** Qualcomm Inc.  
**Theme:** MedTech / BioTech / HealthTech  
**Category:** Hardware  
**Team ID:** 177342  
**Team Name:** AlphaZz  

---

## 👨‍💻 Team AlphaZz

Built for **Smart India Hackathon 2026**.

> ### 🛡️ Raksha Band — Safety that continues when connectivity doesn't.

---

## ⚕️ Disclaimer

Raksha Band is currently a prototype developed for research, innovation, and hackathon demonstration purposes.

It is **not a certified medical device** and should not be used as a replacement for professional medical diagnosis, treatment, or emergency services.

