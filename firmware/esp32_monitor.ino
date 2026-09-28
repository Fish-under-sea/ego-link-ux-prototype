/* =====================================================================
 * ESP32 传感器上报固件 —— USB 串口版（推荐，开箱即用）
 * ---------------------------------------------------------------------
 * 功能：每 SEND_INTERVAL_MS 毫秒向串口输出一行 JSON，例如：
 *   {"temp_c":31.2,"adc0":1832,"adc0_v":1.48,"adc1":2044,"adc1_v":1.65,
 *    "hall":-12,"uptime":12,"heap":291384}
 *
 * 接线：无需外接元件即可运行（使用芯片内部传感器 + ADC 引脚）。
 *   - GPIO34 / GPIO35 可接光敏电阻、电位器、分压电路等模拟量（0~3.3V，切勿超压）
 *   - 若使用 ESP32-C3/C6，请把下方 ADC_PIN_0/1 改成 0/1（该芯片 ADC 在 GPIO0~5）
 *
 * 烧录前设置（Arduino IDE）：
 *   工具 -> USB CDC On Boot: Enabled  （仅 ESP32-S3/C3 需要）
 *   工具 -> 端口: 选择实际 COM 口
 *   串口监视器波特率: 115200
 * ===================================================================== */

#include <Arduino.h>

#define SEND_INTERVAL_MS 500   // 上报间隔（毫秒）

// ---------------------- 引脚配置 ----------------------
// 各芯片的 ADC1 可用引脚完全不同，务必按型号区分：
//   ESP32-S3 : ADC1 = GPIO1~GPIO10   （GPIO26~32 用于 Flash/PSRAM，GPIO33~37 用于八线 PSRAM，都别碰）
//   ESP32    : ADC1 = GPIO32~GPIO39  （GPIO34/35 是最常用的仅输入脚）
//   ESP32-C3/C6/H2 : ADC1 = GPIO0~GPIO4（GPIO0 是启动模式脚，不要用作模拟输入）
// 注意：ESP32-S3-EYE 等高度集成的开发板上，所有 GPIO 都已被摄像头/LCD/麦克风/
//       SD 卡/加速度计占用，没有空闲 ADC 引脚。这类板子请用芯片内部数据源
//       （temperatureRead / getFreeHeap / uptime），或把 ADC_PIN 改成原理图里确认空闲的脚。
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  #define ADC_PIN_0 4     // ADC1_CH3（普通 S3 开发板可用；S3-EYE 上被占用）
  #define ADC_PIN_1 5     // ADC1_CH4（同上）
#elif defined(CONFIG_IDF_TARGET_ESP32C3) || defined(CONFIG_IDF_TARGET_ESP32C6) || defined(CONFIG_IDF_TARGET_ESP32H2)
  #define ADC_PIN_0 3
  #define ADC_PIN_1 4
#else
  #define ADC_PIN_0 34    // ESP32 经典款：仅输入引脚
  #define ADC_PIN_1 35
#endif

// 如需接 DHT22 温湿度传感器，把下面的 0 改成 1，并安装 "DHT sensor library"
#define USE_DHT 0
#if USE_DHT
  #include <DHT.h>
  #define DHT_PIN  4
  #define DHT_TYPE DHT22
  DHT dht(DHT_PIN, DHT_TYPE);
#endif

// 如需接 BME280（I2C），把下面的 0 改成 1，并安装 "Adafruit BME280 Library"
#define USE_BME280 0
#if USE_BME280
  #include <Adafruit_BME280.h>
  Adafruit_BME280 bme;
#endif

static unsigned long lastSend = 0;

void setup() {
  Serial.begin(115200);
  // USB CDC（S3 原生 USB 口）枚举需要一点时间，给足延时避免丢掉开头几帧
  delay(1200);

  analogReadResolution(12);          // 0 ~ 4095
  analogSetAttenuation(ADC_11db);    // 量程约 0 ~ 3.3V

#if USE_DHT
  dht.begin();
#endif
#if USE_BME280
  if (!bme.begin(0x76) && !bme.begin(0x77)) {
    Serial.println("[warn] BME280 not found");
  }
#endif

  // 以下不是 JSON，只会出现在网页的"原始数据"日志里，不会被当成数据。
  // 用它们确认固件确实在跑、以及当前用的是哪组引脚。
  Serial.println("ESP32 sensor monitor ready");
  // 用 Serial.print 而非 printf("%s")：getChipModel() 在不同 core 版本返回类型不一致
  Serial.print("chip="); Serial.print(ESP.getChipModel());
  Serial.printf(" rev=%d cores=%d\n", ESP.getChipRevision(), ESP.getChipCores());
  Serial.printf("adc pins: %d, %d | interval: %dms | temp/hall: %s/%s\n",
                ADC_PIN_0, ADC_PIN_1, SEND_INTERVAL_MS,
#if defined(CONFIG_IDF_TARGET_ESP32S3)
                "yes", "no"
#elif defined(CONFIG_IDF_TARGET_ESP32)
                "yes", "yes"
#else
                "n/a", "no"
#endif
               );
  // 只对带原生 USB 的芯片提示（经典 ESP32 走外挂 USB 转串口，不适用）
#if defined(CONFIG_IDF_TARGET_ESP32S3) || defined(CONFIG_IDF_TARGET_ESP32S2) || \
    defined(CONFIG_IDF_TARGET_ESP32C3) || defined(CONFIG_IDF_TARGET_ESP32C6) || defined(CONFIG_IDF_TARGET_ESP32H2)
  #if !defined(ARDUINO_USB_CDC_ON_BOOT) || ARDUINO_USB_CDC_ON_BOOT == 0
    Serial.println("[warn] USB CDC On Boot 未开启：Serial 没有走 USB 口，请在 Arduino IDE 的『工具』菜单开启后重新烧录");
  #else
    Serial.println("[ok] USB CDC On Boot 已开启，Serial 走原生 USB 口");
  #endif
#endif
}

void loop() {
  unsigned long now = millis();
  if (now - lastSend < SEND_INTERVAL_MS) return;
  lastSend = now;

  // ------------------ 采集真实数据 ------------------
  int   raw0 = analogRead(ADC_PIN_0);
  int   raw1 = analogRead(ADC_PIN_1);
  float v0   = analogReadMilliVolts(ADC_PIN_0) / 1000.0f;
  float v1   = analogReadMilliVolts(ADC_PIN_1) / 1000.0f;

  // 拼接 JSON
  String out = "{";
  out += "\"uptime\":"  + String(now / 1000);
  out += ",\"adc0\":"   + String(raw0);
  out += ",\"adc1\":"   + String(raw1);
  out += ",\"adc0_v\":" + String(v0, 2);
  out += ",\"adc1_v\":" + String(v1, 2);

  // 芯片内部温度传感器（ESP32 / S2 / S3 支持）
#if defined(CONFIG_IDF_TARGET_ESP32) || defined(CONFIG_IDF_TARGET_ESP32S2) || defined(CONFIG_IDF_TARGET_ESP32S3)
  float t = temperatureRead();
  if (!isnan(t) && t > -100) out += ",\"temp_c\":" + String(t, 1);
#endif

  // 霍尔传感器（仅 ESP32 经典款支持）
#if defined(CONFIG_IDF_TARGET_ESP32)
  out += ",\"hall\":" + String(hallRead());
#endif

  out += ",\"heap\":" + String(ESP.getFreeHeap());

#if USE_DHT
  float h = dht.readHumidity();
  float tc = dht.readTemperature();
  if (!isnan(h)) out += ",\"humidity\":" + String(h, 1);
  if (!isnan(tc)) out += ",\"temperature\":" + String(tc, 1);
#endif

#if USE_BME280
  float bmp = bme.readPressure() / 100.0f;
  if (!isnan(bmp)) {
    out += ",\"pressure\":" + String(bmp, 1);
    out += ",\"humidity\":" + String(bme.readHumidity(), 1);
    out += ",\"temperature\":" + String(bme.readTemperature(), 1);
  }
#endif

  out += "}";
  Serial.println(out);
}
