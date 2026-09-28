/* =====================================================================
 * ESP32-S3-EYE —— QMA7981 三轴加速度采集 + WiFi 上传
 * 课程作业：板端（采集上传） / 服务端（接收存储） / 浏览器（查看）
 *
 * 硬件依据（来自官方资料，不靠猜测）：
 *   - ESP32-S3-EYE 无 USB-UART 桥接芯片，板载 I2C 为 SDA=GPIO4 / SCL=GPIO5
 *     （esp-bsp: BSP_I2C_SDA=GPIO_NUM_4, BSP_I2C_SCL=GPIO_NUM_5）
 *   - QMA7981：I2C 地址 0x12，ID 寄存器 0x00 期望值 0xE7，
 *     数据寄存器 X=0x01 Y=0x03 Z=0x05，写 0x11=0xC0 进入 active，
 *     14bit 左对齐，默认量程 ±2g（满量程 0x1FFF）
 *   - 注意：所有 GPIO 已被摄像头/LCD/麦克风/SD/按键占用，不外接任何传感器
 *
 * 单位核对：静止水平放置时 Z 轴应约 +1g ≈ +9.8 m/s²（X、Y 接近 0）
 * 时间核对：板端用 NTP 取 UTC 时间戳，服务端另记接收时间，两者可对照
 * ===================================================================== */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <time.h>

// ===================== 本组需要修改的部分 =====================
const char* WIFI_SSID   = "你的WiFi名称";
const char* WIFI_PASS   = "你的WiFi密码";
const char* SERVER_HOST = "192.168.1.20";    // 运行接收服务的电脑 / VPS 的 IP
const uint16_t SERVER_PORT = 8080;
const char* DEVICE_ID   = "S3EYE-GROUP01";   // 本组独立标识，各组必须不同
// ==============================================================

#define UPLOAD_INTERVAL_MS 1000
#define I2C_SDA_PIN 4
#define I2C_SCL_PIN 5

// QMA7981 寄存器
#define QMA_ADDR        0x12
#define QMA_REG_CHIPID  0x00
#define QMA_REG_PWR     0x11
#define QMA_REG_DXM     0x01
#define QMA_REG_DYM     0x03
#define QMA_REG_DZM     0x05
#define QMA_ACTIVE_CMD  0xC0
#define QMA_FULLSCALE   8191.0f   // 0x1FFF
#define QMA_RANGE_G     2.0f      // 默认 ±2g
#define G_TO_MS2        9.80665f

bool        imuOk   = false;
uint32_t    seq     = 0;
uint32_t    failCnt = 0;
uint32_t    okCnt   = 0;
String      macStr  = "";

/* ---------------------- I2C 基础 ---------------------- */
bool qmaWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(QMA_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool qmaRead(uint8_t reg, uint8_t* buf, size_t len) {
  Wire.beginTransmission(QMA_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;   // repeated start
  if (Wire.requestFrom(QMA_ADDR, (uint8_t)len) != len) return false;
  for (size_t i = 0; i < len; i++) buf[i] = Wire.read();
  return true;
}

/** 扫描 I2C 总线：先确认芯片在不在，不臆断 */
void i2cScan() {
  Serial.println("[i2c] 扫描总线 SDA=4 SCL=5 ...");
  int found = 0;
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf("      发现设备 0x%02X%s\n", a, a == QMA_ADDR ? "  <== QMA7981" : "");
      found++;
    }
  }
  if (!found) Serial.println("      未发现任何 I2C 设备（若板子无 IMU，属正常）");
}

bool imuInit() {
  uint8_t id = 0;
  if (!qmaRead(QMA_REG_CHIPID, &id, 1)) {
    Serial.println("[imu] 读取芯片 ID 失败");
    return false;
  }
  Serial.printf("[imu] WHO_AM_I = 0x%02X (期望 0xE7)\n", id);
  if (id != 0xE7) {
    Serial.println("[imu] 芯片 ID 不匹配，可能不是 QMA7981");
    return false;
  }
  if (!qmaWrite(QMA_REG_PWR, QMA_ACTIVE_CMD)) {
    Serial.println("[imu] 进入 active 模式失败");
    return false;
  }
  delay(20);
  Serial.println("[imu] QMA7981 就绪，量程 ±2g");
  return true;
}

/** 读三轴原始值（14bit 有符号，左对齐） */
bool imuRead(int16_t raw[3]) {
  const uint8_t regs[3] = { QMA_REG_DXM, QMA_REG_DYM, QMA_REG_DZM };
  uint8_t b[2];
  for (int i = 0; i < 3; i++) {
    if (!qmaRead(regs[i], b, 2)) return false;
    int16_t v16 = (int16_t)((b[1] << 8) | b[0]);
    raw[i] = v16 >> 2;                 // 算术右移保留符号，得 14bit 有符号值
  }
  return true;
}

/* ---------------------- 网络 ---------------------- */
void wifiConnect() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.printf("[wifi] 连接 %s", WIFI_SSID);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries++ < 60) { delay(500); Serial.print("."); }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED)
    Serial.printf("[wifi] 已连接 IP=%s RSSI=%d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  else
    Serial.println("[wifi] 连接失败，稍后自动重试");
}

void syncTime() {
  configTime(0, 0, "pool.ntp.org", "ntp.aliyun.com", "time.google.com");  // UTC
  Serial.print("[time] NTP 对时");
  time_t now = 0;
  int tries = 0;
  while (now < 1700000000 && tries++ < 40) { delay(500); Serial.print("."); time(&now); }
  Serial.println();
  if (now < 1700000000) Serial.println("[time] 对时失败，报文将不带板端时间戳");
  else {
    struct tm ti; gmtime_r(&now, &ti);
    char iso[32]; strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", &ti);
    Serial.printf("[time] 板端 UTC = %s\n", iso);
  }
}

/* ---------------------- 上传 ---------------------- */
void upload(const String& body) {
  HTTPClient http;
  String url = "http://" + String(SERVER_HOST) + ":" + String(SERVER_PORT) + "/api/data";
  if (!http.begin(url)) {
    failCnt++;
    Serial.println("[http] begin 失败");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(3000);
  int code = http.POST(body);
  if (code > 0) {
    okCnt++;
    if (okCnt % 10 == 1 || code != 200)
      Serial.printf("[http] %d  成功=%lu 失败=%lu\n", code, (unsigned long)okCnt, (unsigned long)failCnt);
  } else {
    failCnt++;
    Serial.printf("[http] 失败: %s  成功=%lu 失败=%lu\n",
                  http.errorToString(code).c_str(), (unsigned long)okCnt, (unsigned long)failCnt);
  }
  http.end();
}

/* ---------------------- 主程序 ---------------------- */
void setup() {
  Serial.begin(115200);
  delay(1200);                       // USB CDC 枚举需要时间

  Serial.println("=== ESP32-S3-EYE IMU 上传固件 ===");
  Serial.printf("chip=%s  device=%s\n", ESP.getChipModel(), DEVICE_ID);

  uint8_t mac[6]; WiFi.macAddress(mac);
  char mb[32]; snprintf(mb, sizeof(mb), "%02X%02X%02X%02X%02X%02X",
                        mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  macStr = String(mb);
  Serial.printf("[wifi] MAC=%s\n", macStr.c_str());

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, 400000);
  i2cScan();
  imuOk = imuInit();
  if (!imuOk) Serial.println("[imu] 不可用，将只上传芯片内部温度（仍是真实传感源）");

  wifiConnect();
  if (WiFi.status() == WL_CONNECTED) syncTime();
}

unsigned long lastUpload = 0;

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[wifi] 掉线，重连中...");
    wifiConnect();
    delay(2000);
    return;
  }

  unsigned long now = millis();
  if (now - lastUpload < UPLOAD_INTERVAL_MS) return;
  lastUpload = now;
  seq++;

  String body = "{";
  body += "\"device\":\"" + String(DEVICE_ID) + "\"";
  body += ",\"mac\":\"" + macStr + "\"";
  body += ",\"seq\":" + String(seq);
  body += ",\"src\":\"wifi\"";

  // 板端时间（NTP）
  time_t t = time(nullptr);
  if (t > 1700000000) {
    body += ",\"ts\":" + String((unsigned long long)t * 1000ULL + (millis() % 1000));
    struct tm ti; gmtime_r(&t, &ti);
    char iso[32]; strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", &ti);
    body += ",\"iso\":\"" + String(iso) + "\"";
  }

  // 三轴加速度：同时给出 raw / g / m·s⁻²，便于核对单位
  if (imuOk) {
    int16_t raw[3];
    if (imuRead(raw)) {
      const char* axis[3] = { "x", "y", "z" };
      for (int i = 0; i < 3; i++) {
        float g   = (float)raw[i] * QMA_RANGE_G / QMA_FULLSCALE;
        float ms2 = g * G_TO_MS2;
        body += ",\"acc_" + String(axis[i]) + "_raw\":"  + String(raw[i]);
        body += ",\"acc_" + String(axis[i]) + "_g\":"    + String(g, 4);
        body += ",\"acc_" + String(axis[i]) + "_ms2\":"  + String(ms2, 3);
      }
    } else {
      Serial.println("[imu] 读取失败，本帧不含加速度");
    }
  }

  // 芯片内部温度：始终上传，作为保底的真实传感源
  float tc = temperatureRead();
  if (!isnan(tc) && tc > -100) body += ",\"temp_c\":" + String(tc, 1);

  body += ",\"rssi\":" + String(WiFi.RSSI());
  body += ",\"heap\":" + String(ESP.getFreeHeap());
  body += ",\"upload_ok\":"   + String(okCnt);
  body += ",\"upload_fail\":" + String(failCnt);
  body += "}";

  upload(body);
}
