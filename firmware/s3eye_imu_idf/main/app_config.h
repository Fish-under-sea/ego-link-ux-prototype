/* =====================================================================
 * 本组配置
 *
 *  1) WiFi：改成与本组电脑【同一局域网】的 WiFi（注意必须是 2.4GHz）
 *  2) 服务器：运行 server.js 的电脑 IP（默认已填本机有线网 IP）
 *  3) 设备标识：各组必须不同，需与服务端 config.json 的 expectedDeviceId 一致
 *
 *  ⚠ 真实 WiFi 密码不要直接写在本文件里！
 *    本文件会提交到 Git 仓库（包括推送到 GitHub），密码会泄露。
 *    请写进 app_config.local.h（已在 .gitignore 中忽略），
 *    可参考同目录的 app_config.local.h.example。
 *
 *  注意：本组电脑只有有线网（无 WiFi 网卡）。若暂时没有可用 WiFi，
 *        固件仍会把同样格式的 JSON 打印到 USB 串口，网页可先通过 USB 看到数据；
 *        WiFi 连上后会自动改为"独立网络上传"。
 * ===================================================================== */
#pragma once

/* 本地私密配置优先：存在 app_config.local.h 时先加载它，
 * 其中的 #define 会覆盖下面的占位符（下面的默认值都用 #ifndef 保护）。 */
#if defined(__has_include)
#  if __has_include("app_config.local.h")
#    include "app_config.local.h"
#  endif
#endif

#ifndef APP_WIFI_SSID
#define APP_WIFI_SSID   "YOUR_WIFI_SSID"      /* ← 改成你的 WiFi 名称（2.4GHz） */
#endif

#ifndef APP_WIFI_PASS
#define APP_WIFI_PASS   "YOUR_WIFI_PASSWORD"  /* ← 改成你的 WiFi 密码 */
#endif

#ifndef APP_SERVER_HOST
#define APP_SERVER_HOST "10.1.41.112"         /* ← 运行 server.js 的电脑 IP */
#endif

#ifndef APP_SERVER_PORT
#define APP_SERVER_PORT 8080                  /* ← 与服务端端口一致 */
#endif

#ifndef APP_DEVICE_ID
#define APP_DEVICE_ID   "S3EYE-GROUP01"       /* ← 本组独立标识 */
#endif

/* 上报间隔（毫秒）：10Hz = 100ms，建议 50~200ms。
 * USB-CDC 115200bps 下每条 JSON ≈300 字节，20Hz 以内安全。 */
#ifndef REPORT_INTERVAL_MS
#define REPORT_INTERVAL_MS 100
#endif

/* WiFi 下行命令轮询间隔（毫秒）。
 * 板端是纯 HTTP 客户端，服务端连不上它，所以由板端定期来取命令
 * （GET /api/cmd）。串口在线时服务端只写串口，这里取到的永远是空，
 * 因此两条下行通道互不干扰。400ms 兼顾响应速度与请求频率。 */
#ifndef CMD_POLL_INTERVAL_MS
#define CMD_POLL_INTERVAL_MS 400
#endif

/* 上电是否扫描一遍 2.4GHz 并打印可见 AP（默认开）。
 * 排查"手机能连、板子连不上"时非常有用 —— 一眼看出目标 SSID 是否在 2.4GHz 广播。
 * 会拖慢开机约 2~4 秒；调试完可改为 0。 */
#ifndef WIFI_SCAN_ON_BOOT
#define WIFI_SCAN_ON_BOOT 1
#endif
