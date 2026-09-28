/* =====================================================================
 * OV2640 摄像头采集模块 —— 精简构建版桩件
 *
 * 说明：本文件替换原 cam_stream.c，用于「用 PlatformIO 的 ESP-IDF 6.1 框架」
 * 构建核心功能（IMU / 按键 / LED / LCD / WiFi 上报）时的临时方案。
 *
 * 为什么需要它：esp32-camera 2.0.4 依赖 IDF 的 legacy I2C 驱动
 * （driver/i2c.h，IDF 6.0 已移除），无法在本框架下编译通过。
 *
 * 摄像头功能不受影响的范围：在装有 ESP-IDF 5.x 的环境（如课程机器上的
 * C:\Espressif）用原版 cam_stream.c 正常编译与运行。
 * 原文件已存档为 cam_stream.c.idf-full，恢复方式：
 *     cp cam_stream.c.idf-full cam_stream.c
 *
 * 本桩件的行为：cam_stream_init() 返回 false → 固件把摄像头标记为不可用，
 * 不再尝试抓帧；其余功能与真实构建完全一致。绝不模拟/伪造图像数据。
 * ===================================================================== */
#include "cam_stream.h"

bool cam_stream_init(int imu_i2c_port)
{
    (void)imu_i2c_port;
    return false;   /* 本构建未包含摄像头驱动 */
}

void cam_stream_deinit(void) {}

bool cam_stream_ready(void) { return false; }

bool cam_stream_set_params(int framesize, int quality)
{
    (void)framesize; (void)quality;
    return false;
}

bool cam_stream_capture(uint8_t **buf, size_t *len)
{
    if (buf) *buf = NULL;
    if (len) *len = 0;
    return false;
}

void cam_stream_release(void) {}

void cam_stream_get_stats(uint32_t *frames, uint32_t *fails, uint32_t *last_len)
{
    if (frames) *frames = 0;
    if (fails) *fails = 0;
    if (last_len) *last_len = 0;
}

const char *cam_stream_framesize_name(int framesize)
{
    (void)framesize;
    return "unavailable";
}

int cam_stream_get_framesize(void) { return -1; }
int cam_stream_get_quality(void) { return -1; }
