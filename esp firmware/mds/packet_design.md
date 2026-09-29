Here is the comprehensive technical architectural document detailing packet structural serialization, feature distribution, and computational timelines.
markdown
# BLE Structural Packetization & Distributed Biometric Computing Specification
**Document Version:** 2.1.0  
**Target Protocols:** Bluetooth Low Energy (BLE) Notifications & JSI Native Bridges  
**System Architecture:** Embedded Real-Time Data Ingestion Node (ESP32) ──> Client Core Analytics (React Native)

---

## 1. Core Feature Distribution & Computational Matrix

To maintain high loop stability on the ESP32 and protect the integrity of the real-time high-speed data stream, computation is divided between edge data collection and mobile app processing based on library availability and computational weight:

| Data Type / Feature | Computed Where? | Processing Library / Engine | Execution Frequency | Computational Rationale |
| :--- | :--- | :--- | :--- | :--- |
| **Raw Red & Infrared** | **ESP32 (Firmware)** | Maxim MAX30105 Low-Level Driver | Continuous Loop (~400Hz hardware ADC) | Requires raw photodiode register scraping directly over the physical I2C lines to prevent FIFO stack overflow. |
| **Heart Rate (BPM)** | **ESP32 (Firmware)** | SparkFun `spo2_algorithm.h` (Maxim) | 0.5 Hz (Every 2000ms) | Handled via built-in rolling integer peak-tracking array loops on the microcontroller. |
| **Oxygen Saturation (SpO2)** | **ESP32 (Firmware)** | SparkFun `spo2_algorithm.h` (Maxim) | 0.5 Hz (Every 2000ms) | Calculated locally using an empirical lookup calibration matrix matching Red/IR absorption ratios. |
| **Ambient Temp & Humidity** | **ESP32 (Firmware)** | Adafruit DHT Sensor Library | 0.5 Hz (Every 2000ms) | Pulled natively via 1-wire bit-timing sequences. |
| **Heat Index** | **ESP32 (Firmware)** | Adafruit DHT Library (`computeHeatIndex`) | 0.5 Hz (Every 2000ms) | Calculated locally via the built-in, optimized NOAA regression algorithm. |
| **PPG Waveform Morphology** | **Mobile App (React Native)** | Native C++ Bridge / Custom iOS-Android DSP | Continuous Stream (per incoming packet) | Requires heavy mathematical curve-fitting and 1st/2nd derivative operations impossible to run on an ESP32 without freezing loops. |
| **Heart Rate Variability (HRV)**| **Mobile App (React Native)** | Client JavaScript Core Analytics / Math Layer | Event-Driven (Per validated peak detected) | Requires precise millisecond timestamp logging and statistical distribution analysis over large data structures. |
| **Continuous Blood Pressure (cBP)**| **Mobile App (React Native)** | Client Native Layer / PTT Regression Engine | Multi-Sensor Event Fusion (IMU + PPG Cross-Match) | Requires cross-referencing high-speed IMU motion events with incoming PPG waves to calculate complex relative Pulse Transit Time (PTT). |

---

## 2. Technical Packet Serialization Blueprint (C++ Structures)

Packets are packed using byte alignment (`__attribute__((packed))`) to strip out unneeded data alignment padding, ensuring high transmission efficiency over BLE. All values are scaled to fixed-point integers to eliminate heavy float packaging overhead.

### 2.1 Packet Type: `0x01` MOTION
*   **Payload Struct Configuration:**
    ```cpp
    struct __attribute__((packed)) MotionPacket {
      uint8_t  packetId = 0x01; // Identifies the structure format
      uint32_t packetIndex;     // Incremental rollover counter for dropped packet tracking
      uint32_t timestamp;       // System millis() timestamp
      int16_t  accelX;          // Acceleration X scaled to milli-G (1G = 1000 mg)
      int16_t  accelY;          // Acceleration Y scaled to milli-G
      int16_t  accelZ;          // Acceleration Z scaled to milli-G
      int32_t  gyroX;           // Gyroscope X scaled to milli-degrees per second (mdps)
      int32_t  gyroY;           // Gyroscope Y scaled to milli-degrees per second
      int32_t  gyroZ;           // Gyroscope Z scaled to milli-degrees per second
    };
    ```

### 2.2 Packet Type: `0x02` STATUS
*   **Payload Struct Configuration:**
    ```cpp
    struct __attribute__((packed)) StatusPacket {
      uint8_t  packetId = 0x02; 
      uint32_t packetIndex;     
      uint32_t uptimeSeconds;   // System uptime tracking counter
      uint8_t  batteryPercent;  // Calculated battery level (0% - 100%)
      uint8_t  fwMajor;         // Firmware versioning tracks
      uint8_t  fwMinor;
      uint8_t  fwPatch;
    };
    ```

### 2.3 Packet Type: `0x03` ENVIRONMENT
*   **Payload Struct Configuration:**
    ```cpp
    struct __attribute__((packed)) EnvironmentPacket {
      uint8_t  packetId = 0x03; 
      uint32_t packetIndex;     
      uint32_t timestamp;       
      int16_t  temperature;     // Temperature scaled by 10 (e.g., 24.5°C = 245)
      uint16_t humidity;        // Relative Humidity scaled by 10 (e.g., 55.4% = 554)
      int16_t  heatIndex;       // Calculated Heat Index scaled by 10
    };
    ```

### 2.4 Packet Type: `0x04` VITAL
*   **Payload Struct Configuration:**
    ```cpp
    struct __attribute__((packed)) VitalPacket {
      uint8_t  packetId = 0x04; 
      uint32_t packetIndex;     
      uint32_t timestamp;       
      uint32_t rawRed;          // Raw optical photodiode register output channel
      uint32_t rawIR;           // Raw optical photodiode register output channel
      int16_t  heartRate;       // Locally evaluated Maxim BPM (-1 if calculating/invalid)
      int8_t   spo2;            // Locally evaluated Maxim SpO2 (-1 if calculating/invalid)
    };
    ```

---

## 3. Deep-Dive Computational Execution Analysis

### 3.1 Packet Type: `0x03` ENVIRONMENT

#### Feature 1: Ambient Temperature and Humidity
*   **Mathematical Processing:** Read directly from the physical sensor via custom bit-timing protocols. The values are multiplied by 10 locally on the ESP32 to transform the measurements into integer values before transmission, avoiding the data overhead of float variables.
*   **Where It Happens:** **ESP32 Firmware.**
*   **When It Happens:** Chronologically clamped to **0.5 Hz (every 2000 ms)**. The reading loop runs asynchronously on a non-blocking millis timer. This matches the physical recovery limit of the sensor's internal elements, preventing `nan` lockups.

#### Feature 2: Heat Index
*   **Mathematical Processing:** Handled via the built-in Adafruit library using the formal National Weather Service / NOAA multi-variable polynomial regression model:
    \[HI = c_1 + c_2T + c_3R + c_4TR + c_5T^2 + c_6R^2 + c_7T^2R + c_8TR^2 + c_9T^2R^2\]
*   **Where It Happens:** **ESP32 Firmware.**
*   **When It Happens:** Triggered synchronously **every 2000 ms** immediately after valid temperature (T) and relative humidity (R) values are successfully parsed from the DHT11 data line.

---

### 3.2 Packet Type: `0x04` VITAL (Microcontroller Pipeline)

#### Feature 1: Raw Red & Infrared Channels
*   **Mathematical Processing:** Direct hardware-level register reads without modification. The internal Ambient Light Cancellation (ALC) circuit on the MAX30102 chip handles preprocessing automatically to filter out interference from environmental room lighting.
*   **Where It Happens:** **ESP32 Firmware.**
*   **When It Happens:** Pulled **continuously inside the main loop loop** at a target polling rate matching the internal **400Hz** clock configuration of the sensor module. This frequent checking is vital to empty the sensor's physical 32-slot memory array before it overflows and clips data.

#### Feature 2: Heart Rate (BPM) & Oxygen Saturation (SpO2)
*   **Mathematical Processing:** Handled by the integrated Maxim algorithm (`maxim_heart_rate_and_oxygen_saturation`). The algorithm uses rolling memory arrays containing the past 100 optical raw samples. It separates the steady background tissue absorption (DC baseline) from the pulsing blood flow changes (AC component). 
    *   **BPM Calculation:** The algorithm tracks the exact time intervals between passing AC peaks to measure heart rate.
    *   **SpO2 Calculation:** It evaluates the absorption ratio (R) between the Red and IR light streams and runs the result against an empirical medical lookup matrix:
        \[R = \frac{(\text{AC}_{\text{Red}} / \text{DC}_{\text{Red}})}{(\text{AC}_{\text{IR}} / \text{DC}_{\text{IR}})}\]
*   **Where It Happens:** **ESP32 Firmware.**
*   **When It Happens:** Calculated at an optimization rate of **0.5 Hz (every 2000 ms)**, running within the background environmental check step. Restricting this analysis to 2-second intervals protects the ESP32's processing time, preventing heavy loop lag while keeping the real-time data flow moving smoothly.

---

### 3.3 Mobile-Side Analytics Engine (React Native Processing Layer)

The mobile application pulls the incoming binary BLE characteristics off the communication thread and passes the raw metrics down to its processing layer to compute advanced analytics:

Use code with caution.
[Incoming BLE Stream]
│
▼
[React Native Native Layer Module Bridge]
│
├──> Loop Path A ──> Bandpass Filter (0.5Hz - 8Hz) ──> 1st/2nd Derivatives ──> PPG Morphology (Arterial Age & Stiffness)
│
├──> Loop Path B ──> Systolic Peak Timestamp Logging ──> Inter-Beat Intervals ──> HRV Analysis (RMSSD Engine)
│
└──> Loop Path C ──> Cross-Match with Motion Packet ──> Pulse Transit Time (PTT) ──> Continuous Blood Pressure (cBP)

#### Feature 1: PPG Waveform Morphology (Arterial Stiffness & Vascular Age)
*   **Mathematical Processing:** 
    1.  The incoming raw `IR` telemetry stream is passed through a digital **4th-order Butterworth Bandpass Filter (0.5 Hz to 8.0 Hz)** to eliminate high-frequency noise and sudden baseline movement shifts.
    2.  The application computes the mathematical **First Derivative (\(v(t) = \frac{x_k - x_{k-1}}{\Delta t}\))** to capture blood flow velocity profiles, followed by the **Second Derivative (\(a(t) = \frac{v_k - v_{k-1}}{\Delta t}\))** to determine acceleration trends.
    3.  The algorithm scans the resulting acceleration curve to isolate four key structural markers: the a, b, c, and d waves. The mathematical relationship between these points (\(\frac{-b}{a}\)) reveals arterial elasticity and vascular age trends.
*   **Where It Happens:** **Mobile App Client Layer** (via high-performance native iOS/Android C++ modules).
*   **When It Happens:** **Real-time processing** executed as new `VitalPacket` data arrays arrive over the BLE connection.

#### Feature 2: Heart Rate Variability (HRV)
*   **Mathematical Processing:** The application tracks the precise time intervals between sequential systolic peaks to generate an exact **Inter-Beat Interval (IBI)** log in milliseconds. It monitors these variations over time using a rolling calculation to find the Root Mean Square of Successive Differences (RMSSD):
    \[\text{RMSSD} = \sqrt{\frac{1}{N-1} \sum_{i=1}^{N-1} (\text{IBI}_{i+1} - \text{IBI}_i)^2}\]
    This index provides a clear window into stress levels and nervous system activity.
*   **Where It Happens:** **Mobile App Client Layer** (processed via the React Native background execution thread).
*   **When It Happens:** **Event-driven execution** that recalculates automatically each time a clean heartbeat peak is confirmed by the processing logic.

#### Feature 3: Continuous Blood Pressure (cBP)
*   **Mathematical Processing:** This feature relies on a **Pulse Transit Time (PTT)** model. The algorithm tracks the exact millisecond delay between a physical heart movement (isolated by sudden spikes in the `MotionPacket` 6-DoF accelerometer array) and the corresponding blood wave peak arriving at the finger sensor (`VitalPacket` IR wave). 
    *   The measured PTT delay is passed through a personalized linear regression formula to track blood pressure changes dynamically without needing an inflating arm cuff:
        \[\text{cBP} = \alpha \cdot \ln(\text{PTT}) + \beta\]
*   **Where It Happens:** **Mobile App Client Layer** (via a specialized native data fusion module).
*   **When It Happens:** **Continuous background processing** that dynamically correlates data across the motion and biometric streams at a calculation rate of **10 Hz**.

