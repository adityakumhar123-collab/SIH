#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <DHT.h>
#include "MAX30105.h"
#include "spo2_algorithm.h"

// Hardware Interface Pins
#define I2C_SDA 27
#define I2C_SCL 25
#define DHTPIN  33
#define DHTTYPE DHT11

// System Execution Frequencies
const unsigned long IMU_INTERVAL  = 10;   // 100Hz IMU Extraction Loop
const unsigned long DATA_INTERVAL = 100;  // 10Hz Machine Serialization Loop
const unsigned long DHT_INTERVAL  = 2000; // 0.5Hz Environment Read (DHT11 Spec Limit)

unsigned long lastIMUTime  = 0;
unsigned long lastDataTime = 0;
unsigned long lastDHTTime  = 0;

// Device Drivers
Adafruit_MPU6050 mpu;
DHT dht(DHTPIN, DHTTYPE);
MAX30105 maxSensor;

// MAX30102 Storage Registers (Required for the SparkFun Maxim Algorithm)
#define BUFFER_SIZE 100
uint32_t irBuffer[BUFFER_SIZE];
uint32_t redBuffer[BUFFER_SIZE];
int32_t bufferLength = BUFFER_SIZE;

// Evaluated Processing Results
int32_t heartRate = -999;
int8_t  validHeartRate = 0;
int32_t spo2 = -999;
int8_t  validSPO2 = 0;

// Global Structural Variables
sensors_event_t a, g, temp_mpu;
float dht_temp = 25.0;
float dht_humidity = 50.0;
float heat_index = 25.0;
uint32_t raw_red = 0;
uint32_t raw_ir = 0;

void setup() {
  // Fast serialization pipeline
  Serial.begin(115200);
  
  // Crank standard I2C speed to 400kHz Fast Mode
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);

  // Hard init sensors
  mpu.begin(0x68, &Wire, 0);
  dht.begin();
  
  if (maxSensor.begin(Wire, I2C_SPEED_FAST)) {
    // Machine Setup: LedMode=2 (Red+IR), SampleRate=400 (400Hz ADC), PulseWidth=411, AdcRange=4096
    maxSensor.setup(0x1F, 4, 2, 400, 411, 4096); 
  }

  // Pre-seed the MAX30102 buffer array so the calculation window isn't empty at boot
  for (int i = 0; i < BUFFER_SIZE; i++) {
    while (!maxSensor.available()) maxSensor.check();
    redBuffer[i] = maxSensor.getRed();
    irBuffer[i] = maxSensor.getIR();
    maxSensor.nextSample();
  }
  
  // First mathematical calculation pass
  maxim_heart_rate_and_oxygen_saturation(irBuffer, bufferLength, redBuffer, &spo2, &validSPO2, &heartRate, &validHeartRate);
}

void loop() {
  unsigned long currentMillis = millis();

  // --- TASK 1: REAL-TIME CONTINUOUS OPTICAL DATA EXTRACTION ---
  // We stream raw data point updates continuously into our rolling computation buffer
  maxSensor.check();
  if (maxSensor.available()) {
    raw_red = maxSensor.getRed();
    raw_ir = maxSensor.getIR();
    
    // Shift values back by 1 element to maintain rolling 100-sample tracking
    for (int i = 1; i < BUFFER_SIZE; i++) {
      redBuffer[i - 1] = redBuffer[i];
      irBuffer[i - 1] = irBuffer[i];
    }
    redBuffer[BUFFER_SIZE - 1] = raw_red;
    irBuffer[BUFFER_SIZE - 1] = raw_ir;
    
    maxSensor.nextSample();
  }

  // --- TASK 2: HIGH FREQUENCY IMU STREAM (100Hz) ---
  if (currentMillis - lastIMUTime >= IMU_INTERVAL) {
    lastIMUTime = currentMillis;
    mpu.getEvent(&a, &g, &temp_mpu);
  }

  // --- TASK 3: LOW FREQUENCY CLIMATE STREAM (0.5Hz) ---
  if (currentMillis - lastDHTTime >= DHT_INTERVAL) {
    lastDHTTime = currentMillis;
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t) && !isnan(h)) {
      dht_temp = t;
      dht_humidity = h;
      heat_index = dht.computeHeatIndex(dht_temp, dht_humidity, false);
    }
    
    // Process rolling SpO2 & Heart Rate window concurrently when climate updates
    // Keeping calculation execution at a 2-second rate prevents I2C bus lockup
    maxim_heart_rate_and_oxygen_saturation(irBuffer, bufferLength, redBuffer, &spo2, &validSPO2, &heartRate, &validHeartRate);
  }

  // --- TASK 4: MACHINE SERIALIZATION PACKET PIPELINE (10Hz) ---
  if (currentMillis - lastDataTime >= DATA_INTERVAL) {
    lastDataTime = currentMillis;

    // Fast-parsed structural protocol for direct ingestion scripts
    Serial.print("AX:");  Serial.print(a.acceleration.x, 3); Serial.print(" ");
    Serial.print("AY:");  Serial.print(a.acceleration.y, 3); Serial.print(" ");
    Serial.print("AZ:");  Serial.print(a.acceleration.z, 3); Serial.print(" ");
    Serial.print("GX:");  Serial.print(g.gyro.x, 3);         Serial.print(" ");
    Serial.print("GY:");  Serial.print(g.gyro.y, 3);         Serial.print(" ");
    Serial.print("GZ:");  Serial.print(g.gyro.z, 3);         Serial.print(" ");
    Serial.print("TMP:"); Serial.print(dht_temp, 1);         Serial.print(" ");
    Serial.print("HUM:"); Serial.print(dht_humidity, 1);     Serial.print(" ");
    Serial.print("HI:");  Serial.print(heat_index, 1);       Serial.print(" ");
    Serial.print("RED:"); Serial.print(raw_red);             Serial.print(" ");
    Serial.print("IR:");  Serial.print(raw_ir);              Serial.print(" ");
    
    // Output biometric results conditionally based on validation flags
    Serial.print("BPM:");  Serial.print((validHeartRate == 1 && heartRate > 0) ? heartRate : -1); Serial.print(" ");
    Serial.print("SPO2:"); Serial.print((validSPO2 == 1 && spo2 > 0) ? spo2 : -1);

    Serial.println();
  }
}