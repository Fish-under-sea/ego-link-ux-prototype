// 第 2 周：实现 Web 远程采集指令与执行结果反馈（板端部分）
//
// 与 prev/imu-monitor 平台对齐的要点：
//   1) 串口按【扁平帧】输出 JSON（device/seq/ts/iso/acc_x_g/...），而非嵌套 value{}
//      —— 平台的解析器按扁平字段抽取：JSON.parse 后取数值字段
//   2) 帧前带 [post] 之类的日志前缀也能被识别（已在 server.js 的 handleLine 中兼容）
//   3) 下行命令走「板端轮询」：GET /api/cmd?device=...（Node 服务端的通道）
//      同时兼容早期 Python 服务端 /api/commands/pending（若不可用会自动忽略）
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <time.h>
#include "imu_qma6100p.h"
#include "secrets.h"

#ifndef EYE_FW_VERSION
#define EYE_FW_VERSION "w02"
#endif

static constexpr int kPinImuSda = 4;
static constexpr int kPinImuScl = 5;
static constexpr uint32_t kSampleIntervalMs = 1000;
static constexpr int kSamplesPerObservation = 8;
static constexpr int kMaxPostAttempts = 3;
static constexpr uint32_t kCmdPollIntervalMs = 1500;
static constexpr bool kPauseReportSupported = true;

static ImuQma6100p g_imu;
static String g_deviceId = "S3EYE-GROUP01";   // 与平台 config.json 的 expectedDeviceId 一致
static String g_mac = "000000000000";
static uint32_t g_seq = 0;
static uint32_t g_okCount = 0;
static uint32_t g_failCount = 0;
static uint32_t g_cmdOk = 0;
static uint32_t g_cmdFail = 0;
static bool g_timeSynced = false;
static bool g_imuReady = false;
static bool g_reportPaused = false;            // 暂停周期上报，命令通道保持可用
static float g_lastAx = 0, g_lastAy = 0, g_lastAz = 0;
static bool g_hasLast = false;

static String macHex() {
  uint8_t mac[6] = {0};
  WiFi.macAddress(mac);
  char buf[13];
  snprintf(buf, sizeof(buf), "%02X%02X%02X%02X%02X%02X", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
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

static String baseUrl() {
  return String("http://") + EYE_SERVER_HOST + ":" + String(EYE_SERVER_PORT);
}

static bool connectWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
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
  for (int i = 0; i < 20; i++) {
    if (time(nullptr) > 1700000000) {
      g_timeSynced = true;
      Serial.printf("[time] SNTP 对时成功: %s\n", isoNow().c_str());
      return;
    }
    delay(300);
  }
  Serial.println("[time] SNTP 对时失败，本次以 uptime 记录时间");
}

static bool sampleOnce(float& ax, float& ay, float& az) {
  if (!g_imuReady) return false;
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

// 组装与平台对齐的扁平帧
static String buildFrame(float ax, float ay, float az, const String& requestId) {
  StaticJsonDocument<512> doc;
  doc["device"] = g_deviceId;
  doc["mac"] = g_mac;
  doc["seq"] = g_seq;
  // 不发送 ts：平台的 ts 视为板端时间戳（秒）并与接收时间算偏差，
  // 而我方墙钟由 iso 承载（含时区），避免平台显示巨额 skew。
  doc["uptime_ms"] = (uint32_t)millis();
  doc["iso"] = g_timeSynced ? isoNow() : String("uptime_ms=") + String(millis());
  doc["acc_x_g"] = serialized(String(ax, 4));
  doc["acc_y_g"] = serialized(String(ay, 4));
  doc["acc_z_g"] = serialized(String(az, 4));
  doc["acc_mag_g"] = serialized(String(g_imu.magnitude(ax, ay, az), 4));
  doc["rssi_dbm"] = WiFi.RSSI();
  doc["heap"] = (uint32_t)ESP.getFreeHeap();
  if (requestId.length()) doc["request_id"] = requestId;
  String body;
  serializeJson(doc, body);
  return body;
}

static bool httpPostJson(const String& path, const String& body, int& code, String& resp) {
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, baseUrl() + path)) { code = 0; return false; }
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(5000);
  http.setReuse(false);
  code = http.POST(body);
  bool ok = (code >= 200 && code < 300);
  resp = http.getString();
  http.end();
  client.stop();
  delay(20);
  return ok;
}

static bool httpGet(const String& path, int& code, String& resp) {
  WiFiClient client;
  HTTPClient http;
  if (!http.begin(client, baseUrl() + path)) { code = 0; return false; }
  http.setTimeout(5000);
  http.setReuse(false);
  code = http.GET();
  bool ok = (code >= 200 && code < 300);
  resp = http.getString();
  http.end();
  client.stop();
  delay(20);
  return ok;
}

// 上报一帧：串口输出（平台可经串口读到）+ WiFi POST /api/data
static void publish(float ax, float ay, float az, const String& requestId, bool remote) {
  String frame = buildFrame(ax, ay, az, requestId);
  // 串口：带 [post] 前缀也能被平台解析（handleLine 已兼容前缀 + JSON）
  Serial.printf("[post] %s\n", frame.c_str());

  if (!remote && g_reportPaused) return;
  if (WiFi.status() != WL_CONNECTED) return;

  int code = 0;
  String resp;
  bool ok = false;
  for (int attempt = 1; attempt <= kMaxPostAttempts && !ok; attempt++) {
    ok = httpPostJson("/api/data", frame, code, resp);
    if (!ok && attempt < kMaxPostAttempts) delay(700);
  }
  if (remote) {
    if (ok) { g_cmdOk++; Serial.printf("[cmd] request_id=%s 已回传新观测 (http=%d)\n", requestId.c_str(), code); }
    else { g_cmdFail++; Serial.printf("[cmd] request_id=%s 回传失败 http=%d（不标记本次完成）\n", requestId.c_str(), code); }
  } else {
    if (ok) g_okCount++; else g_failCount++;
  }
}

// 板端回执（远程采集）：平台据此把状态推进到 acked
static void sendAck(const String& requestId, const String& status) {
  StaticJsonDocument<192> doc;
  doc["type"] = "ack";
  doc["device"] = g_deviceId;
  doc["request_id"] = requestId;
  doc["seq"] = g_seq;
  doc["status"] = status;
  String body;
  serializeJson(doc, body);
  Serial.printf("[post] %s\n", body.c_str());
  int code = 0; String resp;
  httpPostJson("/api/data", body, code, resp);
}

static void runRemoteCapture(const String& requestId) {
  Serial.printf("[cmd] 收到远程采集 request_id=%s\n", requestId.c_str());
  sendAck(requestId, "received");

  g_seq++;
  float ax, ay, az;
  if (!sampleOnce(ax, ay, az)) {
    g_cmdFail++;
    Serial.printf("[cmd] request_id=%s 采集失败（不伪造数据）\n", requestId.c_str());
    return;
  }
  g_lastAx = ax; g_lastAy = ay; g_lastAz = az; g_hasLast = true;
  Serial.printf("[imu] seq=%u ax=%.3f ay=%.3f az=%.3f |a|=%.3f g\n",
                (unsigned)g_seq, ax, ay, az, g_imu.magnitude(ax, ay, az));
  publish(ax, ay, az, requestId, true);
}

// 下行命令轮询：Node 平台用 /api/cmd；Python 备用服务端用 /api/commands/pending
static void pollCommands() {
  if (WiFi.status() != WL_CONNECTED) return;
  int code = 0;
  String resp;
  if (httpGet("/api/cmd?device=" + g_deviceId, code, resp) && code == 200 && resp.length() > 2) {
    StaticJsonDocument<512> doc;
    if (!deserializeJson(doc, resp)) {
      const char* cmd = doc["cmd"] | "";
      const char* rid = doc["request_id"] | "";
      if (!strcmp(cmd, "collect_once")) {
        runRemoteCapture(String(rid));
      } else if (!strcmp(cmd, "pause")) {
        g_reportPaused = true;
        Serial.println("[cmd] 周期上报已暂停（命令通道保持）");
        if (strlen(rid)) sendAck(String(rid), "received");
      } else if (!strcmp(cmd, "resume")) {
        g_reportPaused = false;
        Serial.println("[cmd] 周期上报已恢复");
        if (strlen(rid)) sendAck(String(rid), "received");
      } else if (!strcmp(cmd, "ping")) {
        if (strlen(rid)) sendAck(String(rid), "received");
      }
    }
    return;
  }
  // 备用通道
  if (httpGet("/api/commands/pending?device_id=" + g_deviceId, code, resp) && code == 200) {
    StaticJsonDocument<1024> doc;
    if (deserializeJson(doc, resp)) return;
    JsonArray cmds = doc["commands"].as<JsonArray>();
    for (JsonObject c : cmds) {
      const char* rid = c["request_id"] | "";
      if (strlen(rid)) runRemoteCapture(String(rid));
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println();
  Serial.printf("=== Ego Link 板端固件=%s（第 2 周：远程采集闭环）===\n", EYE_FW_VERSION);

  if (connectWifi()) {
    g_mac = macHex();
    Serial.printf("[main] 设备标识 = %s, MAC = %s\n", g_deviceId.c_str(), g_mac.c_str());
    syncTime();
  } else {
    Serial.println("[main] 无网络：仍按 1Hz 采集并从串口输出真实帧（USB 仅作调试通道）");
  }

  Serial.print("[imu] 初始化 QMA6100P ... ");
  g_imuReady = g_imu.begin(kPinImuSda, kPinImuScl);
  if (g_imuReady) {
    Serial.printf("成功, WHO_AM_I=0x%02X (期望 0x90)\n", g_imu.chipId());
    int16_t rx, ry, rz;
    if (g_imu.readAccelRaw(rx, ry, rz)) {
      Serial.printf("[imu] 静止自检 |a| = %.3f g（应接近 1.000，无需校准系数）\n",
                    g_imu.magnitude(rx / 4096.0f, ry / 4096.0f, rz / 4096.0f));
    }
  } else {
    Serial.println("失败");
  }
  Serial.printf("[main] 周期采集 %u ms；命令轮询 %u ms\n",
                (unsigned)kSampleIntervalMs, (unsigned)kCmdPollIntervalMs);
}

void loop() {
  static uint32_t lastSample = 0;
  static uint32_t lastPoll = 0;

  if (millis() - lastPoll >= kCmdPollIntervalMs) {
    lastPoll = millis();
    pollCommands();
  }

  if (millis() - lastSample < kSampleIntervalMs) {
    delay(10);
    return;
  }
  lastSample = millis();

  float ax, ay, az;
  g_seq++;
  if (!sampleOnce(ax, ay, az)) {
    Serial.printf("[imu] seq=%u 采集失败，不上报（不伪造数据）\n", (unsigned)g_seq);
    return;
  }
  g_lastAx = ax; g_lastAy = ay; g_lastAz = az; g_hasLast = true;
  if (!g_reportPaused) {
    Serial.printf("[imu] seq=%u ax=%.3f ay=%.3f az=%.3f |a|=%.3f g\n",
                  (unsigned)g_seq, ax, ay, az, g_imu.magnitude(ax, ay, az));
  }
  publish(ax, ay, az, "", false);
}
