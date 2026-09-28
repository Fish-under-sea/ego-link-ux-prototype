// 第 1 周：构建开发板传感数据采集与 Web 展示系统（板端部分）
// 链路：板端读取 IMU -> Wi-Fi 上传 -> 服务端接收/存储 -> Web 读取并显示
// 观测记录最小字段：设备标识、传感源、记录标识、采集状态、数据与单位、
//                   采集时间/时间质量（服务端接收时间由服务端补）
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "imu_qma6100p.h"
#include "secrets.h"

#ifndef EYE_FW_VERSION
#define EYE_FW_VERSION "w01"
#endif

static constexpr int kPinImuSda = 4;
static constexpr int kPinImuScl = 5;
static constexpr uint32_t kSampleIntervalMs = 1000;
static constexpr int kSamplesPerObservation = 8;
static constexpr int kMaxPostAttempts = 3;

static ImuQma6100p g_imu;
static String g_deviceId;
static uint32_t g_seq = 0;
static uint32_t g_uploadFailCount = 0;
static uint32_t g_uploadOkCount = 0;
static bool g_timeSynced = false;

static String macSuffix() {
  uint8_t mac[6] = {0};
  WiFi.macAddress(mac);
  char buf[8];
  snprintf(buf, sizeof(buf), "%02X%02X%02X", mac[3], mac[4], mac[5]);
  return String(buf);
}

static String isoNow() {
  time_t now = time(nullptr);
  struct tm tmv;
  localtime_r(&now, &tmv);
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%S%z", &tmv);
  return String(buf);
}

static bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(EYE_WIFI_SSID, EYE_WIFI_PASS);
  Serial.printf("[net] 连接 Wi-Fi SSID=\"%s\" ...\n", EYE_WIFI_SSID);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 30000) {
    delay(300);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[net] Wi-Fi 连接失败");
    return false;
  }
  Serial.printf("[net] 已连接, IP=%s RSSI=%d dBm\n",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  return true;
}

static void syncTime() {
  configTzTime("CST-8", "ntp.aliyun.com", "cn.pool.ntp.org");
  Serial.print("[time] SNTP 对时");
  for (int i = 0; i < 20; i++) {
    if (time(nullptr) > 1700000000) {
      g_timeSynced = true;
      Serial.printf(" 成功: %s\n", isoNow().c_str());
      return;
    }
    delay(300);
    Serial.print(".");
  }
  g_timeSynced = false;
  Serial.println(" 失败，采集时间将标注为未校准");
}

static bool sampleOnce(float& ax, float& ay, float& az) {
  double sx = 0, sy = 0, sz = 0;
  int valid = 0;
  for (int i = 0; i < kSamplesPerObservation; i++) {
    float x, y, z;
    if (g_imu.readAccelG(x, y, z)) {
      sx += x; sy += y; sz += z; valid++;
    }
    delay(10);
  }
  if (valid == 0) return false;
  ax = sx / valid; ay = sy / valid; az = sz / valid;
  return true;
}

// 返回 true 表示服务端已确认接收（HTTP 2xx）
static bool postObservation(float ax, float ay, float az, const String& observedAt,
                           const String& timeQuality, int& outCode, String& outErr) {
  StaticJsonDocument<768> doc;
  doc["device_id"] = g_deviceId;
  doc["sensor"] = "imu_accel";
  doc["record_id"] = g_deviceId + "-" + String(g_seq);
  doc["seq"] = g_seq;
  doc["status"] = "ok";
  doc["unit"] = "g";
  doc["observed_at"] = observedAt;
  doc["time_quality"] = timeQuality;
  doc["fw_version"] = EYE_FW_VERSION;
  JsonObject v = doc.createNestedObject("value");
  v["ax"] = serialized(String(ax, 4));
  v["ay"] = serialized(String(ay, 4));
  v["az"] = serialized(String(az, 4));
  v["magnitude"] = serialized(String(g_imu.magnitude(ax, ay, az), 4));
  doc["rssi_dbm"] = WiFi.RSSI();

  String body;
  serializeJson(doc, body);

  WiFiClient client;
  HTTPClient http;
  String url = String("http://") + EYE_SERVER_HOST + ":" + String(EYE_SERVER_PORT) + "/api/observations";
  if (!http.begin(client, url)) {
    outCode = 0;
    outErr = "http.begin 失败";
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);
  http.setReuse(false);

  int code = http.POST(body);
  outCode = code;
  bool ok = (code >= 200 && code < 300);
  if (ok) {
    // 显式取回并丢弃响应体，保证读完整包再收连接
    String resp = http.getString();
    (void)resp;
  } else {
    outErr = http.errorToString(code);
  }
  http.end();
  client.stop();
  delay(30);
  return ok;
}

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println();
  Serial.printf("=== Ego Link 第 1 周板端 固件=%s ===\n", EYE_FW_VERSION);

  if (!connectWifi()) {
    Serial.println("[main] 无网络，串口仍可读取 IMU 数值（板端本地采集不受影响）");
  } else {
    g_deviceId = "esp32s3eye-" + macSuffix();
    Serial.printf("[main] 设备标识 = %s\n", g_deviceId.c_str());
    syncTime();
  }
  if (g_deviceId.isEmpty()) g_deviceId = "esp32s3eye-unknown";

  Serial.print("[imu] 初始化 QMA6100P ... ");
  if (g_imu.begin(kPinImuSda, kPinImuScl)) {
    Serial.printf("成功, CHIP_ID=0x%02X (期望 0x90)\n", g_imu.chipId());
    int16_t rx, ry, rz;
    if (g_imu.readAccelRaw(rx, ry, rz)) {
      Serial.printf("[imu] 原始值 %d %d %d -> |a| = %.3f g（静止应接近 1.000）\n",
                    rx, ry, rz,
                    g_imu.magnitude(rx / 4096.0f, ry / 4096.0f, rz / 4096.0f));
    }
  } else {
    Serial.println("失败");
  }
  Serial.printf("[main] 开始周期采集: 每 %u ms 一条, 每次 %d 次采样取平均\n",
                (unsigned)kSampleIntervalMs, kSamplesPerObservation);
}

void loop() {
  static uint32_t last = 0;
  if (millis() - last < kSampleIntervalMs) {
    delay(20);
    return;
  }
  last = millis();

  float ax, ay, az;
  g_seq++;

  if (!sampleOnce(ax, ay, az)) {
    Serial.printf("[imu] seq=%u 采集失败, 本次不上传（不伪造数据）\n", (unsigned)g_seq);
    return;
  }

  String observedAt = g_timeSynced ? isoNow() : String("uptime_ms=") + String(millis());
  String timeQuality = g_timeSynced ? "sntp" : "uncalibrated";
  Serial.printf("[imu] seq=%u ax=%.3f ay=%.3f az=%.3f |a|=%.3f g\n",
                (unsigned)g_seq, ax, ay, az, g_imu.magnitude(ax, ay, az));

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[post] 跳过: Wi-Fi 未连接");
    connectWifi();
    return;
  }

  bool ok = false;
  int code = 0;
  String err;
  for (int attempt = 1; attempt <= kMaxPostAttempts && !ok; attempt++) {
    ok = postObservation(ax, ay, az, observedAt, timeQuality, code, err);
    if (!ok && attempt < kMaxPostAttempts) {
      Serial.printf("[post] seq=%u 第 %d 次失败 http=%d (%s), 1s 后重试\n",
                    (unsigned)g_seq, attempt, code, err.c_str());
      delay(1000);
    }
  }
  if (ok) {
    g_uploadOkCount++;
    Serial.printf("[post] seq=%u 上传成功 (http=%d, 累计成功 %u)\n",
                  (unsigned)g_seq, code, (unsigned)g_uploadOkCount);
  } else {
    g_uploadFailCount++;
    Serial.printf("[post] seq=%u 上传失败 http=%d (%s) 累计失败 %u 次, 本次数据丢弃（不做假补发）\n",
                  (unsigned)g_seq, code, err.c_str(), (unsigned)g_uploadFailCount);
  }
}
