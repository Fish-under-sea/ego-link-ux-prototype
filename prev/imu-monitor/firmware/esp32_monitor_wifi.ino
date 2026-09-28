/* =====================================================================
 * ESP32 传感器上报固件 —— WiFi 版（可选，摆脱 USB 线）
 * ---------------------------------------------------------------------
 * 用法：
 *   1. 修改下面的 WIFI_SSID / WIFI_PASS / SERVER_HOST
 *   2. SERVER_HOST 填运行本平台的电脑的局域网 IP（如 192.168.1.20）
 *   3. 烧录后，开发板每 500ms 向 http://SERVER_HOST:8080/api/data 上报一次
 *   4. 拔掉开发板供电后，服务端 8 秒内未收到数据即判定离线并清空页面
 *
 * 传感器部分与串口版完全一致，可按同样方式接入 DHT22 / BME280。
 * ===================================================================== */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>

// ===================== 需要你修改 =====================
const char* WIFI_SSID  = "你的WiFi名称";
const char* WIFI_PASS  = "你的WiFi密码";
const char* SERVER_HOST = "192.168.1.20";   // 运行监控平台的电脑 IP
const uint16_t SERVER_PORT = 8080;
// ======================================================

#define SEND_INTERVAL_MS 500

// 各芯片 ADC1 引脚不同：S3=GPIO1~10，经典 ESP32=GPIO32~39，C3/C6/H2=GPIO0~4
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  #define ADC_PIN_0 4
  #define ADC_PIN_1 5
#elif defined(CONFIG_IDF_TARGET_ESP32C3) || defined(CONFIG_IDF_TARGET_ESP32C6) || defined(CONFIG_IDF_TARGET_ESP32H2)
  #define ADC_PIN_0 3
  #define ADC_PIN_1 4
#else
  #define ADC_PIN_0 34
  #define ADC_PIN_1 35
#endif

static unsigned long lastSend = 0;

void setup() {
  Serial.begin(115200);
  delay(500);
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("IP: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  unsigned long now = millis();
  if (now - lastSend < SEND_INTERVAL_MS) return;
  lastSend = now;

  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    return;
  }

  int   raw0 = analogRead(ADC_PIN_0);
  int   raw1 = analogRead(ADC_PIN_1);
  float v0   = analogReadMilliVolts(ADC_PIN_0) / 1000.0f;
  float v1   = analogReadMilliVolts(ADC_PIN_1) / 1000.0f;

  String body = "{";
  body += "\"uptime\":"  + String(now / 1000);
  body += ",\"adc0\":"   + String(raw0);
  body += ",\"adc1\":"   + String(raw1);
  body += ",\"adc0_v\":" + String(v0, 2);
  body += ",\"adc1_v\":" + String(v1, 2);
#if defined(CONFIG_IDF_TARGET_ESP32) || defined(CONFIG_IDF_TARGET_ESP32S2) || defined(CONFIG_IDF_TARGET_ESP32S3)
  float t = temperatureRead();
  if (!isnan(t) && t > -100) body += ",\"temp_c\":" + String(t, 1);
#endif
#if defined(CONFIG_IDF_TARGET_ESP32)
  body += ",\"hall\":" + String(hallRead());
#endif
  body += ",\"rssi\":" + String(WiFi.RSSI());
  body += ",\"heap\":" + String(ESP.getFreeHeap());
  body += "}";

  HTTPClient http;
  String url = "http://" + String(SERVER_HOST) + ":" + String(SERVER_PORT) + "/api/data";
  if (http.begin(url)) {
    http.addHeader("Content-Type", "application/json");
    int code = http.POST(body);
    Serial.printf("POST %d %s\n", code, body.c_str());
    http.end();
  }
}
