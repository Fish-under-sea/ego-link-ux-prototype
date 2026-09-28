/* =====================================================================
 * OV2640 摄像头采集模块（ESP32-S3-EYE）
 *
 * ★ 命名注意：所有导出函数都带 cam_stream_ 前缀。
 *   原因：esp32-camera 组件内部导出了公开符号 cam_init()/cam_deinit()，
 *   如果本模块也用这两个名字，会与之冲突 —— 实测表现为组件内部调用
 *   cam_init(config) 被链接到本模块的函数上，进而报
 *   "cam_hal: cam_init(538): config pointer is invalid"。
 *
 * 硬件依据（均来自官方，不靠猜测）：
 *   · 摄像头型号 OV2640，200 万像素，DVP 并口
 *     来源：ESP32-S3-EYE_Getting_Started_Guide.md「Camera」条目
 *   · 引脚：esp-bsp 的 bsp/esp32_s3_eye/include/bsp/esp32_s3_eye.h
 *       XCLK=15  PCLK=13  VSYNC=6  HREF=7
 *       D0..D7 = 11, 9, 8, 10, 12, 18, 17, 16
 *       ★ PWDN / RESET 在 S3-EYE 上【未连接】→ 必须填 -1
 *         （esp32-camera 自带测试文件里写的 PWDN=43/RESET=44 是别的板子；
 *           在 S3-EYE 上 GPIO43/44 是 LCD 的 DC/CS，照抄会把屏幕搞坏）
 *   · SCCB（I2C）走 GPIO4/5，与板载 QMA7981 IMU 【同一条总线】，
 *     因此复用 IMU 已建好的端口，不另建总线
 *   · 帧缓冲放 PSRAM（板载 8MB Octal），见 sdkconfig.defaults 的 CONFIG_SPIRAM*
 * ===================================================================== */
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* 初始化摄像头。imu_i2c_port 传 IMU 用的 I2C 端口号（复用其总线）。
 * 返回 true 表示摄像头已就绪。 */
bool cam_stream_init(int imu_i2c_port);

/* 反初始化（释放帧缓冲）。 */
void cam_stream_deinit(void);

/* 是否已就绪。 */
bool cam_stream_ready(void);

/* 设置分辨率与 JPEG 质量。
 * framesize: esp32-camera 的 framesize_t 数值（见 cam_stream_framesize_name）
 * quality  : 0~63，越小越清晰、文件越大 */
bool cam_stream_set_params(int framesize, int quality);

/* 抓一帧 JPEG。成功时 *buf 指向组件内部缓冲，*len 为字节数。
 * ★ 用完必须调用 cam_stream_release()，否则缓冲不会归还、很快就抓不到帧。 */
bool cam_stream_capture(uint8_t **buf, size_t *len);
void cam_stream_release(void);

/* 运行统计 */
void cam_stream_get_stats(uint32_t *frames, uint32_t *fails, uint32_t *last_len);

/* 分辨率名称（用于日志与网页显示），未知值返回 "?" */
const char *cam_stream_framesize_name(int framesize);

/* 当前分辨率（framesize_t 数值）与 JPEG 质量 */
int cam_stream_get_framesize(void);
int cam_stream_get_quality(void);
