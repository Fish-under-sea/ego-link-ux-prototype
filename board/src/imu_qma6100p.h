#pragma once
#include <Arduino.h>
#include <Wire.h>

// QMA6100P 加速度计（ESP32-S3-EYE 板载，I2C 地址 0x12，SDA=GPIO4，SCL=GPIO5）
// 量程 ±2g，灵敏度 4096 LSB/g，WHO_AM_I = 0x90
// 原始值解析依据乐鑫官方驱动 esp-bsp/components/qma6100p：
//   raw = (int16_t)((HIGH_BYTE << 8) + LOW_BYTE) / 4
//   （数据在 16 位寄存器中左对齐，故先合并再整体右移 2 位；不可只对高 12 位做算术右移）
class ImuQma6100p {
 public:
  static constexpr uint8_t kAddr = 0x12;
  static constexpr uint8_t kWhoAmI = 0x90;
  static constexpr float kLsbPerG = 4096.0f;

  bool begin(int sda, int scl) {
    Wire.begin(sda, scl, 400000);
    delay(10);
    uint8_t id = 0;
    if (!readReg(0x00, id)) return false;
    chipId_ = id;
    writeReg(0x0F, 0x01);  // ±2g
    writeReg(0x10, 0x00);  // 带宽/ODR
    writeReg(0x11, 0x84);  // 上电进入激活态
    delay(30);
    ok_ = true;
    return true;
  }

  uint8_t chipId() const { return chipId_; }
  bool ok() const { return ok_; }

  bool readAccelRaw(int16_t& rx, int16_t& ry, int16_t& rz) {
    uint8_t b[6];
    if (!readRegs(0x01, b, 6)) return false;
    rx = decode(b[0], b[1]);
    ry = decode(b[2], b[3]);
    rz = decode(b[4], b[5]);
    return true;
  }

  bool readAccelG(float& ax, float& ay, float& az) {
    int16_t rx, ry, rz;
    if (!readAccelRaw(rx, ry, rz)) return false;
    ax = rx / kLsbPerG;
    ay = ry / kLsbPerG;
    az = rz / kLsbPerG;
    return true;
  }

  float magnitude(float x, float y, float z) { return sqrtf(x * x + y * y + z * z); }

  bool dumpRegs(uint8_t* out, size_t n) { return readRegs(0x00, out, n); }

 private:
  static int16_t decode(uint8_t lo, uint8_t hi) {
    return (int16_t)((int16_t)((hi << 8) + lo) / 4);
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
