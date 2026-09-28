#pragma once
#include <Arduino.h>
#include <Wire.h>

// QMA6100P 六轴 IMU（ESP32-S3-EYE 板载，I2C 地址 0x12，SDA=GPIO4，SCL=GPIO5）
// 量程配置 ±2g / 4096 LSB/g，与板上既有固件实测一致
class ImuQma6100p {
 public:
  static constexpr uint8_t kAddr = 0x12;
  static constexpr float kLsbPerG = 4096.0f;

  bool begin(int sda, int scl) {
    Wire.begin(sda, scl, 400000);
    delay(10);
    uint8_t id = 0;
    if (!readReg(0x00, id)) return false;
    chipId_ = id;
    // 量程：±2g
    writeReg(0x0F, 0x01);
    // 带宽/ODR
    writeReg(0x10, 0x00);
    // 上电进入激活态
    writeReg(0x11, 0x84);
    delay(30);
    ok_ = true;
    return true;
  }

  uint8_t chipId() const { return chipId_; }

  // 读取加速度（单位 g）。accValid 表示底层读取是否成功。
  bool readAccelG(float& ax, float& ay, float& az) {
    uint8_t b[6];
    if (!readRegs(0x01, b, 6)) return false;
    ax = toG(b[0], b[1]);
    ay = toG(b[2], b[3]);
    az = toG(b[4], b[5]);
    return true;
  }

  // 合矢量（静止时应接近 1 g）
  float magnitude(float x, float y, float z) { return sqrtf(x * x + y * y + z * z); }

 private:
  static float toG(uint8_t lo, uint8_t hi) {
    // 12 位左对齐：低 8 位 + 高 4 位
    int16_t raw = (int16_t)((hi << 8) | lo) >> 4;
    if (raw > 2047) raw -= 4096;
    return (float)raw / kLsbPerG;
  }

  bool readReg(uint8_t reg, uint8_t& val) { return readRegs(reg, &val, 1); }

  bool readRegs(uint8_t reg, uint8_t* buf, size_t len) {
    Wire.beginTransmission(kAddr);
    Wire.write(reg);
    if (Wire.endTransmission(false) != 0) return false;
    if (Wire.requestFrom((int)kAddr, (int)len) != (int)len) return false;
    for (size_t i = 0; i < len; i++) buf[i] = Wire.read();
    return true;
  }

  bool writeReg(uint8_t reg, uint8_t val) {
    Wire.beginTransmission(kAddr);
    Wire.write(reg);
    Wire.write(val);
    return Wire.endTransmission() == 0;
  }

  uint8_t chipId_ = 0;
  bool ok_ = false;
};
