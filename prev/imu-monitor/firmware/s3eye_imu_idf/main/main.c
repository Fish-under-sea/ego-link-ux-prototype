/* =====================================================================
 * ESP32-S3-EYE —— QMA7981 三轴加速度采集 + 上报（ESP-IDF 版）
 *
 * 双通道上报（同一份真实数据，绝不生成/模拟）：
 *   1) WiFi  → HTTP POST http://<APP_SERVER_HOST>:<APP_SERVER_PORT>/api/data
 *   2) USB   → 把同样的 JSON 打印到 USB Serial/JTAG（COM 口），供串口方式读取/调试
 *
 * 硬件依据（来自官方资料，非猜测）：
 *   - ESP32-S3-EYE 无 USB-UART 桥接芯片，板载 I2C：SDA=GPIO4 / SCL=GPIO5
 *     （esp-bsp: BSP_I2C_SDA=GPIO_NUM_4, BSP_I2C_SCL=GPIO_NUM_5）
 *   - QMA7981：地址 0x12，ID 寄存器 0x00 期望 0xE7，数据寄存器 X=0x01 Y=0x03 Z=0x05，
 *     写 0x11=0xC0 进入 active，14bit 左对齐，默认 ±2g（满量程 0x1FFF）
 *   - 单位核对：静止水平放置时 Z 轴应约 +1g ≈ +9.8 m/s²
 *   - 时间核对：板端 NTP 取 UTC 时间戳，服务端另记接收时间，两者可对照
 * ===================================================================== */

#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <math.h>
#include <time.h>
#include <sys/time.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"

#include "esp_system.h"
#include "esp_log.h"
#include "esp_err.h"
#include "esp_mac.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_http_client.h"
#include "esp_sntp.h"
#include "nvs_flash.h"

#include "driver/i2c_master.h"
#include "driver/temperature_sensor.h"
#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_vendor.h"
#include "esp_lcd_panel_ops.h"
#include "esp_adc/adc_oneshot.h"

#include "app_config.h"
#include "lcd_font.h"
#include "cam_stream.h"
#include "mbedtls/base64.h"

static const char *TAG = "S3EYE";

/* ---------------------- QMA7981 ---------------------- */
#define QMA_ADDR        0x12
#define QMA_REG_CHIPID  0x00
#define QMA_REG_PWR     0x11
#define QMA_REG_DXM     0x01
#define QMA_REG_RANGE   0x0F    /* FSR 量程寄存器 */
#define QMA_ACTIVE_CMD  0xC0
#define QMA_FULLSCALE   8191.0f   /* 0x1FFF */
#define QMA_RANGE_G     2.0f      /* 默认 ±2g */
#define QMA_CALIBRATION 0.765f    /* 本板 QMA7981 灵敏度偏高 ~31%；校准使静止 |a|≈1.0g */
#define G_TO_MS2        9.80665f

#define I2C_SDA_GPIO    4
#define I2C_SCL_GPIO    5

/* ---------------------- 按键 / LED / LCD（第 3 周：物理反馈闭环） ----------------------
 * 硬件依据（官方 ESP32-S3-EYE v2.2 用户指南 + esp-bsp，非猜测）：
 *   - 板载仅 1 颗可编程 LED（Module Power LED，绿色）接 GPIO3，
 *     ★ 必须用「开漏输出」：软件拉高会烧 LED（v2.2 已加 R83 限流，仍应遵守）
 *   - 6 个功能按键走电阻分压 → ADC1_CH0（GPIO1）；无按键时被上拉至接近满量程，
 *     按下不同键得到不同电压（esp-bsp 参考值 2410/1980/820/380，另 BOOT 键=GPIO0）
 *   - LCD 1.3" 240x240 ST7789，SPI3：PCLK=21 / MOSI=47 / DC=43 / CS=44 / 背光=48
 *     （GPIO43/44 是 UART0 的 TX/RX，但本固件控制台走 USB-Serial-JTAG，故可自由使用）
 *   - 板载【没有】扬声器/蜂鸣器，实体反馈只能用 LED + LCD
 * ------------------------------------------------------------------ */
#define LED_GPIO        3
#define BTN_ADC_CH      ADC_CHANNEL_0    /* = GPIO1 */
#define LCD_SCLK_GPIO   21
#define LCD_MOSI_GPIO   47
#define LCD_DC_GPIO     43
#define LCD_CS_GPIO     44
#define LCD_BL_GPIO     48
#define LCD_H_RES       240
#define LCD_V_RES       240

/* RGB565 常用色 */
#define RGB565(r, g, b) ((uint16_t)((((r) & 0xF8) << 8) | (((g) & 0xFC) << 3) | ((b) >> 3)))
#define C_BLACK   RGB565(0, 0, 0)
#define C_WHITE   RGB565(255, 255, 255)
#define C_RED     RGB565(220, 50, 50)
#define C_GREEN   RGB565(30, 160, 80)
#define C_GRAY    RGB565(70, 78, 90)
#define C_BLUE    RGB565(50, 110, 220)
#define C_DIM     RGB565(150, 158, 170)

static i2c_master_bus_handle_t  s_bus = NULL;
static i2c_master_dev_handle_t  s_dev = NULL;
/* IMU 实际使用的 I2C 端口（0 或 1）。摄像头 SCCB 在 GPIO4/5 上与 IMU 共用同一条
 * 总线，必须复用这个端口，不能再建一条。 */
static int s_imu_port = -1;
static bool                     s_imu_ok = false;
static bool                     s_cam_ok = false;
static uint8_t                  s_imu_id = 0;     // 读到的 WHO_AM_I 字节（诊断用）
static char                     s_imu_scan[128] = ""; // 扫描到的 I2C 地址列表

static temperature_sensor_handle_t s_tsens = NULL;
static bool                        s_tsens_ok = false;

static void temp_sensor_init(void)
{
    temperature_sensor_config_t cfg = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    if (temperature_sensor_install(&cfg, &s_tsens) == ESP_OK &&
        temperature_sensor_enable(s_tsens) == ESP_OK) {
        s_tsens_ok = true;
    }
}

static float temp_sensor_read(void)
{
    float c = NAN;
    if (s_tsens_ok) temperature_sensor_get_celsius(s_tsens, &c);
    return c;
}

/* ---------------------- WiFi ---------------------- */
static EventGroupHandle_t s_wifi_eg = NULL;
#define WIFI_CONNECTED_BIT BIT0
static char s_ip[16] = "0.0.0.0";

/* ---------------------- 统计 ---------------------- */
static uint32_t s_seq = 0, s_ok = 0, s_fail = 0;
static char     s_mac[13] = "000000000000";

/* ===================== I2C / QMA7981 ===================== */

static esp_err_t qma_read(uint8_t reg, uint8_t *buf, size_t len)
{
    return i2c_master_transmit_receive(s_dev, &reg, 1, buf, len, 1000);
}

static esp_err_t qma_write(uint8_t reg, uint8_t val)
{
    uint8_t b[2] = { reg, val };
    return i2c_master_transmit(s_dev, b, 2, 1000);
}

static void i2c_scan(void)
{
    s_imu_scan[0] = '\0';
    ESP_LOGI(TAG, "扫描 I2C 总线 (SDA=%d SCL=%d)…", I2C_SDA_GPIO, I2C_SCL_GPIO);
    for (uint8_t a = 0x08; a < 0x78; a++) {
        if (i2c_master_probe(s_bus, a, 50) == ESP_OK) {
            ESP_LOGI(TAG, "  发现 I2C 设备: 0x%02X", a);
            int len = strlen(s_imu_scan);
            snprintf(s_imu_scan + len, sizeof(s_imu_scan) - len, "%s0x%02X", len ? " " : "", a);
        }
    }
    if (!s_imu_scan[0]) snprintf(s_imu_scan, sizeof(s_imu_scan), "(无响应设备)");
}

/* 在指定 I2C 端口上尝试初始化 QMA7981；返回 true 表示数据可读 */
static bool imu_init_on_port(i2c_port_num_t port)
{
    i2c_master_bus_config_t bus_cfg = {
        .i2c_port = port,
        .sda_io_num = I2C_SDA_GPIO,
        .scl_io_num = I2C_SCL_GPIO,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true,
    };
    if (i2c_new_master_bus(&bus_cfg, &s_bus) != ESP_OK) {
        ESP_LOGE(TAG, "I2C 总线 %d 创建失败", port);
        return false;
    }
    i2c_scan();

    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = QMA_ADDR,
        .scl_speed_hz = 400000,
    };
    if (i2c_master_bus_add_device(s_bus, &dev_cfg, &s_dev) != ESP_OK) {
        ESP_LOGE(TAG, "QMA7981 (0x%02X) 设备添加失败", QMA_ADDR);
        return false;
    }

    uint8_t id = 0;
    if (qma_read(QMA_REG_CHIPID, &id, 1) != ESP_OK) {
        ESP_LOGE(TAG, "读取 QMA7981 ID 失败");
        return false;
    }
    s_imu_id = id;
    ESP_LOGI(TAG, "QMA7981 WHO_AM_I = 0x%02X (本板实测 0x90，故不做 ID 强校验)", id);
    if (id != 0xE7) {
        ESP_LOGW(TAG, "QMA7981 ID 不匹配，仍尝试读取（可能是兼容型号）");
    }
    /* 显式设置量程 ±2g（寄存器 0x0F bits[1:0]=00），
     * 部分变体芯片默认量程可能不同，不设置会导致 g 值偏差。 */
    qma_write(QMA_REG_RANGE, 0x00);
    qma_write(QMA_REG_PWR, QMA_ACTIVE_CMD);   /* 进入 active */
    vTaskDelay(pdMS_TO_TICKS(60));
    s_imu_port = (int)port;                   /* 记下来给摄像头 SCCB 复用 */
    ESP_LOGI(TAG, "QMA7981 初始化完成（±2g，14bit，端口 %d）", port);
    return true;
}

static bool imu_init(void)
{
    /* 依次尝试 I2C 端口 0 / 1（不同板子可能挂在任一个上） */
    if (imu_init_on_port(I2C_NUM_0)) return true;
    if (s_bus) { i2c_del_master_bus(s_bus); s_bus = NULL; s_dev = NULL; }
    if (imu_init_on_port(I2C_NUM_1)) return true;
    s_imu_id = 0;
    ESP_LOGE(TAG, "QMA7981 在两路 I2C 上均未初始化成功");
    return false;
}

static bool imu_read(int16_t out[3])
{
    uint8_t b[6] = {0};
    if (qma_read(QMA_REG_DXM, b, 6) != ESP_OK) return false;
    int16_t x16 = (int16_t)((b[1] << 8) | b[0]);
    int16_t y16 = (int16_t)((b[3] << 8) | b[2]);
    int16_t z16 = (int16_t)((b[5] << 8) | b[4]);
    /* QMA7981 14-bit 数据为左对齐：bit[1:0] 为零，需右移 2 位获得真实值。
     * 但不同批次芯片的寄存器对齐方式可能不同。输出原始 16bit 以便诊断。 */
    out[0] = x16 >> 2;
    out[1] = y16 >> 2;
    out[2] = z16 >> 2;
    return true;
}

/* ===================== WiFi ===================== */

/* 诊断扫描期间置位：临时抑制自动重连，让 STA 停在空闲态。
 * 否则 STA 一直处于 connecting，esp_wifi_scan_start / esp_wifi_set_config
 * 都会被拒（ESP_ERR_WIFI_STATE）。 */
static volatile bool s_wifi_paused = false;

/* 把 WiFi 断线原因码翻译成人话，便于现场排查 */
static const char *wifi_reason_str(uint8_t r)
{
    switch (r) {
    case WIFI_REASON_NO_AP_FOUND:            return "找不到该 SSID（信号太弱，或只在 5GHz 广播）";
    case WIFI_REASON_AUTH_FAIL:              return "认证失败（密码不对）";
    case WIFI_REASON_ASSOC_FAIL:             return "关联被拒（AP 满/不允许该设备）";
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT: return "四次握手超时（通常是密码错误）";
    case WIFI_REASON_CONNECTION_FAIL:        return "连接失败（AP 无响应）";
    case WIFI_REASON_BEACON_TIMEOUT:         return "信标超时（AP 不可达/信号丢失）";
    case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY: return "找到 SSID 但加密方式不兼容";
    default:                                 return "其他原因";
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (!s_wifi_paused) esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_wifi_eg, WIFI_CONNECTED_BIT);
        if (s_wifi_paused) return;          /* 诊断扫描中：不要重连 */
        wifi_event_sta_disconnected_t *e = (wifi_event_sta_disconnected_t *)data;
        ESP_LOGW(TAG, "WiFi 断开（reason=%u：%s），重连中…",
                 (unsigned)e->reason, wifi_reason_str(e->reason));
        esp_wifi_connect();
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = (ip_event_got_ip_t *)data;
        snprintf(s_ip, sizeof(s_ip), IPSTR, IP2STR(&e->ip_info.ip));
        ESP_LOGI(TAG, "WiFi 已连接，IP=%s", s_ip);
        xEventGroupSetBits(s_wifi_eg, WIFI_CONNECTED_BIT);
    }
}

/* 上电扫描一遍 2.4GHz 频段并打印可见 AP。
 * 用途：排查"手机能看到 SSID，但板子连不上"这类问题 ——
 * 常见原因是该热点只在 5GHz 广播，而 ESP32-S3 只支持 2.4GHz。 */
static void wifi_scan_log(void)
{
    static wifi_ap_record_t list[24];
    wifi_scan_config_t sc = { .show_hidden = false };
    if (esp_wifi_scan_start(&sc, true) != ESP_OK) {
        ESP_LOGW(TAG, "WiFi 扫描失败（不影响连接尝试）");
        return;
    }
    uint16_t n = 0;
    esp_wifi_scan_get_ap_num(&n);
    if (n == 0) {
        ESP_LOGW(TAG, "★ 2.4GHz 频段未扫描到任何 WiFi —— 请确认路由器开了 2.4GHz");
        return;
    }
    uint16_t cap = (n > 24) ? 24 : n;
    esp_wifi_scan_get_ap_records(&cap, list);
    ESP_LOGI(TAG, "扫描到 %u 个 2.4GHz 网络（列出前 %u 个）：", n, cap);
    bool found = false;
    for (uint16_t i = 0; i < cap; i++) {
        const char *ssid = (const char *)list[i].ssid;
        if (strcmp(ssid, APP_WIFI_SSID) == 0) found = true;
        ESP_LOGI(TAG, "  [%02u] %-28s ch=%-3d rssi=%-4d %s", i + 1,
                 ssid[0] ? ssid : "(隐藏)", list[i].primary, list[i].rssi,
                 (strcmp(ssid, APP_WIFI_SSID) == 0) ? "★ 目标" : "");
    }
    if (!found) {
        ESP_LOGW(TAG, "★ 未在 2.4GHz 发现 SSID=\"%s\" —— 该热点很可能只广播 5GHz，"
                      "ESP32-S3 无法连接（只能等路由器开放 2.4GHz，或改用手机热点/随身路由）",
                 APP_WIFI_SSID);
    }
}

static void wifi_init(void)
{
    s_wifi_eg = xEventGroupCreate();
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    /* 排查"关联成功却拿不到 IP"时打开 DHCP 客户端详细日志：
     * 能看到 DISCOVER 是否发出、有没有收到 OFFER。定位完可关掉。 */
    esp_log_level_set("dhcpc", ESP_LOG_DEBUG);
    esp_log_level_set("esp_netif_lwip", ESP_LOG_DEBUG);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    wifi_config_t wc = {0};
    strncpy((char *)wc.sta.ssid, APP_WIFI_SSID, sizeof(wc.sta.ssid) - 1);
    strncpy((char *)wc.sta.password, APP_WIFI_PASS, sizeof(wc.sta.password) - 1);
    wc.sta.threshold.authmode = WIFI_AUTH_OPEN;   /* 兼容开放/各类加密 */

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));

    /* 关闭 WiFi 省电（modem sleep）。
     * 实测坑：默认省电模式下，某些 AP/路由器（尤其廉价家用路由）会丢掉
     * DHCP 响应，表现为日志里 "wifi:connected with XXX" 成功、却永远拿不到 IP。
     * 关掉后即可正常拿到地址。代价是功耗略高，本项目由 USB/电源供电，无影响。 */
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));

#if WIFI_SCAN_ON_BOOT
    /* 先抑制自动连接，让 STA 停在空闲态再做扫描 ——
     * esp_wifi_start() 会触发 STA_START 事件并立即连接，此时扫描/改配置都会被拒。 */
    s_wifi_paused = true;
    ESP_ERROR_CHECK(esp_wifi_start());
    vTaskDelay(pdMS_TO_TICKS(300));
    wifi_scan_log();
    s_wifi_paused = false;
#else
    ESP_ERROR_CHECK(esp_wifi_start());
#endif

    esp_err_t e = esp_wifi_set_config(WIFI_IF_STA, &wc);
    if (e != ESP_OK) ESP_LOGW(TAG, "设置 WiFi 配置失败: %s", esp_err_to_name(e));
    ESP_LOGI(TAG, "WiFi 启动，SSID=%s", APP_WIFI_SSID);
    esp_wifi_connect();      /* 显式发起连接 */
}

static bool wifi_wait(int ms)
{
    EventBits_t bits = xEventGroupWaitBits(s_wifi_eg, WIFI_CONNECTED_BIT, pdFALSE, pdTRUE, pdMS_TO_TICKS(ms));
    return (bits & WIFI_CONNECTED_BIT) != 0;
}

/* ===================== SNTP 对时 ===================== */

static void time_sync(void)
{
    esp_sntp_setoperatingmode(ESP_SNTP_OPMODE_POLL);
    esp_sntp_setservername(0, "ntp.aliyun.com");
    esp_sntp_setservername(1, "pool.ntp.org");
    esp_sntp_init();

    time_t now = 0;
    int retry = 0;
    while (now < 1700000000 && retry++ < 30) {
        vTaskDelay(pdMS_TO_TICKS(500));
        time(&now);
    }
    if (now < 1700000000) {
        ESP_LOGW(TAG, "NTP 对时失败，报文将不带板端时间戳");
    } else {
        struct tm ti;
        gmtime_r(&now, &ti);
        char iso[32];
        strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", &ti);
        ESP_LOGI(TAG, "板端 UTC = %s", iso);
    }
}

/* ===================== HTTP 上传 ===================== */

static bool http_post(const char *path, const char *body)
{
    char url[128];
    snprintf(url, sizeof(url), "http://%s:%d%s", APP_SERVER_HOST, APP_SERVER_PORT, path);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 3000,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return false;
    esp_http_client_set_header(c, "Content-Type", "application/json");
    esp_http_client_set_post_field(c, body, strlen(body));

    esp_err_t err = esp_http_client_perform(c);
    int status = esp_http_client_get_status_code(c);
    esp_http_client_cleanup(c);
    return (err == ESP_OK && status == 200);
}

static bool http_upload(const char *body)
{
    return http_post("/api/data", body);
}

/* HTTP GET，把响应体读进 buf（带截断保护）。返回 true = HTTP 200。 */
static bool http_get(const char *path, char *buf, size_t cap)
{
    char url[128];
    snprintf(url, sizeof(url), "http://%s:%d%s", APP_SERVER_HOST, APP_SERVER_PORT, path);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = 2000,
    };
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (!c) return false;

    buf[0] = '\0';
    bool ok = false;
    if (esp_http_client_open(c, 0) == ESP_OK) {
        int len = esp_http_client_fetch_headers(c);
        int status = esp_http_client_get_status_code(c);
        if (status == 200) {
            size_t want = cap - 1;
            if (len > 0 && (size_t)len < want) want = (size_t)len;
            /* 循环读直到读满或对端关闭：单次 read 可能只返回一部分 */
            size_t got = 0;
            while (got < want) {
                int n = esp_http_client_read(c, buf + got, want - got);
                if (n <= 0) break;
                got += (size_t)n;
            }
            buf[got] = '\0';
            ok = true;
        }
        esp_http_client_close(c);
    }
    esp_http_client_cleanup(c);
    return ok;
}

/* ===================== 本地反馈（LED + LCD）与按键（第 3 周） =====================
 *
 * 闭环设计（与网页/服务端配合）：
 *   佩戴者按键
 *     ├─ 立即本地反馈（不依赖网络）：LED 快闪 + LCD「求助已发送」  ← 断开外网也必须成立
 *     └─ 再上报 help_request（USB 串口 + WiFi）→ 服务端 → 网页
 *   查看者点「已收到」→ 服务端下发 viewer_ack → 板端 LCD「对方已收到」+ LED 慢闪
 *   佩戴者再次按键 = 取消 → 本地「已取消」+ 上报 help_cancel
 *
 * 硬约束：没有收到 viewer_ack 之前，板端绝不显示「对方已收到」。
 * ================================================================= */

/* ---------------------- LED（GPIO3，开漏） ---------------------- */
typedef enum { LED_OFF = 0, LED_FAST, LED_SLOW } led_mode_t;

static void led_init(void)
{
    gpio_config_t c = {
        .pin_bit_mask = 1ULL << LED_GPIO,
        .mode = GPIO_MODE_OUTPUT_OD,          /* ★ 开漏：拉高会烧 LED */
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&c);
    gpio_set_level(LED_GPIO, 1);              /* 高阻 = 灭 */
}

static inline void led_write(bool on) { gpio_set_level(LED_GPIO, on ? 0 : 1); }

/* ---------------------- LCD（ST7789, SPI3） ---------------------- */
static esp_lcd_panel_handle_t s_lcd = NULL;
static bool s_lcd_ok = false;

static void lcd_init(void)
{
    gpio_config_t bl = {
        .pin_bit_mask = 1ULL << LCD_BL_GPIO,
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    gpio_config(&bl);
    gpio_set_level(LCD_BL_GPIO, 0);           /* 先关背光，避免上电白屏闪 */

    spi_bus_config_t buscfg = {
        .sclk_io_num = LCD_SCLK_GPIO,
        .mosi_io_num = LCD_MOSI_GPIO,
        .miso_io_num = -1,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
        .max_transfer_sz = 4096,
    };
    if (spi_bus_initialize(SPI3_HOST, &buscfg, SPI_DMA_CH_AUTO) != ESP_OK) {
        ESP_LOGW(TAG, "LCD SPI3 总线初始化失败，跳过屏幕");
        return;
    }
    esp_lcd_panel_io_handle_t io = NULL;
    esp_lcd_panel_io_spi_config_t io_cfg = {
        .dc_gpio_num = LCD_DC_GPIO,
        .cs_gpio_num = LCD_CS_GPIO,
        .pclk_hz = 40 * 1000 * 1000,
        .lcd_cmd_bits = 8,
        .lcd_param_bits = 8,
        .spi_mode = 0,
        .trans_queue_depth = 10,
    };
    if (esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)SPI3_HOST, &io_cfg, &io) != ESP_OK) {
        ESP_LOGW(TAG, "LCD IO 创建失败，跳过屏幕");
        return;
    }
    esp_lcd_panel_dev_config_t pcfg = {
        .reset_gpio_num = -1,                  /* 本板 LCD_RST 未接 GPIO，走软复位 */
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_BGR,
        .bits_per_pixel = 16,
    };
    if (esp_lcd_new_panel_st7789(io, &pcfg, &s_lcd) != ESP_OK) {
        ESP_LOGW(TAG, "ST7789 面板创建失败，跳过屏幕");
        return;
    }
    esp_lcd_panel_reset(s_lcd);
    esp_lcd_panel_init(s_lcd);
    esp_lcd_panel_invert_color(s_lcd, true);
    esp_lcd_panel_swap_xy(s_lcd, false);
    esp_lcd_panel_mirror(s_lcd, false, false);
    esp_lcd_panel_set_gap(s_lcd, 0, 0);
    esp_lcd_panel_disp_on_off(s_lcd, true);
    s_lcd_ok = true;
    gpio_set_level(LCD_BL_GPIO, 1);           /* 开背光 */
    ESP_LOGI(TAG, "LCD 初始化完成（240x240 ST7789, SPI3）");
}

static void lcd_fill(uint16_t color)
{
    if (!s_lcd_ok) return;
    static uint16_t line[LCD_H_RES];
    for (int i = 0; i < LCD_H_RES; i++) line[i] = color;
    for (int y = 0; y < LCD_V_RES; y++) {
        esp_lcd_panel_draw_bitmap(s_lcd, 0, y, LCD_H_RES, y + 1, line);
    }
}

/* 画一个 32x32 汉字（不在字库内则跳过） */
static void lcd_draw_zh(int x, int y, uint32_t cp, uint16_t fg, uint16_t bg)
{
    if (!s_lcd_ok) return;
    int idx = -1;
    for (size_t i = 0; i < LCD_ZH_COUNT; i++) {
        if (LCD_ZH_CP[i] == cp) { idx = (int)i; break; }
    }
    if (idx < 0) return;
    static uint16_t buf[LCD_ZH_W * LCD_ZH_H];
    const uint8_t *bmp = LCD_ZH_BMP[idx];
    for (int r = 0; r < LCD_ZH_H; r++) {
        for (int c = 0; c < LCD_ZH_W; c++) {
            int on = (bmp[r * (LCD_ZH_W / 8) + (c / 8)] >> (7 - (c % 8))) & 1;
            buf[r * LCD_ZH_W + c] = on ? fg : bg;
        }
    }
    esp_lcd_panel_draw_bitmap(s_lcd, x, y, x + LCD_ZH_W, y + LCD_ZH_H, buf);
}

/* 画一个 8x16 ASCII 字符 */
static void lcd_draw_ascii(int x, int y, char ch, uint16_t fg, uint16_t bg)
{
    if (!s_lcd_ok) return;
    unsigned c = (unsigned char)ch;
    if (c < 0x20 || c > 0x7E) c = '?';
    static uint16_t buf[LCD_ASCII_W * LCD_ASCII_H];
    const uint8_t *bmp = LCD_ASCII_BMP[c - 0x20];
    for (int r = 0; r < LCD_ASCII_H; r++) {
        for (int col = 0; col < LCD_ASCII_W; col++) {
            int on = (bmp[r] >> (7 - col)) & 1;
            buf[r * LCD_ASCII_W + col] = on ? fg : bg;
        }
    }
    esp_lcd_panel_draw_bitmap(s_lcd, x, y, x + LCD_ASCII_W, y + LCD_ASCII_H, buf);
}

/* 解码一个 UTF-8 字符，返回消耗字节数（0 = 结束） */
static int utf8_next(const char *s, uint32_t *cp)
{
    unsigned char c = (unsigned char)s[0];
    if (!c) return 0;
    if (c < 0x80) { *cp = c; return 1; }
    if ((c & 0xE0) == 0xC0 && (s[1] & 0xC0) == 0x80) {
        *cp = ((c & 0x1F) << 6) | (s[1] & 0x3F); return 2;
    }
    if ((c & 0xF0) == 0xE0 && (s[1] & 0xC0) == 0x80 && (s[2] & 0xC0) == 0x80) {
        *cp = ((c & 0x0F) << 12) | ((s[1] & 0x3F) << 6) | (s[2] & 0x3F); return 3;
    }
    if ((c & 0xF8) == 0xF0 && (s[1] & 0xC0) == 0x80 && (s[2] & 0xC0) == 0x80 && (s[3] & 0xC0) == 0x80) {
        *cp = ((c & 0x07) << 18) | ((s[1] & 0x3F) << 12) | ((s[2] & 0x3F) << 6) | (s[3] & 0x3F); return 4;
    }
    *cp = '?'; return 1;
}

/* 居中显示一行汉字 */
static void lcd_show_zh_line(const char *utf8, int y, uint16_t fg, uint16_t bg)
{
    if (!s_lcd_ok) return;
    int n = 0;
    const char *p = utf8;
    uint32_t cp;
    while (*p) { int k = utf8_next(p, &cp); if (!k) break; n++; p += k; }
    if (!n) return;
    int x = (LCD_H_RES - n * LCD_ZH_W) / 2;
    p = utf8;
    while (*p) {
        int k = utf8_next(p, &cp);
        if (!k) break;
        lcd_draw_zh(x, y, cp, fg, bg);
        x += LCD_ZH_W;
        p += k;
    }
}

/* 居中显示一行 ASCII */
static void lcd_show_ascii_line(const char *s, int y, uint16_t fg, uint16_t bg)
{
    if (!s_lcd_ok) return;
    int n = (int)strlen(s);
    if (!n) return;
    int x = (LCD_H_RES - n * LCD_ASCII_W) / 2;
    for (int i = 0; i < n; i++) lcd_draw_ascii(x + i * LCD_ASCII_W, y, s[i], fg, bg);
}

/* ---------------------- 求助状态机（板端） ---------------------- */
typedef enum { HELP_IDLE = 0, HELP_SENT, HELP_ACKED, HELP_CANCELLED } help_state_t;

static volatile help_state_t s_help = HELP_IDLE;
static volatile int          s_scr = 0;          /* 0=空闲 1=已发送 2=已收到 3=已取消 */
static char                  s_help_id[48] = "";
static uint32_t              s_help_counter = 0;

static void new_help_id(char *out, size_t cap)
{
    s_help_counter++;
    time_t t = time(NULL);
    if (t > 1700000000) {
        struct tm ti;
        gmtime_r(&t, &ti);
        snprintf(out, cap, "help-%04d%02d%02d-%02d%02d%02d-%04lu",
                 ti.tm_year + 1900, ti.tm_mon + 1, ti.tm_mday,
                 ti.tm_hour, ti.tm_min, ti.tm_sec, (unsigned long)s_help_counter);
    } else {
        snprintf(out, cap, "help-boot-%04lu", (unsigned long)s_help_counter);
    }
}

/* 上报一次求助事件（USB 串口 + WiFi 双通道，与数据帧同样的传输方式） */
static void send_help_event(const char *event)
{
    char body[384];
    int n = 0;
    n += snprintf(body + n, sizeof(body) - n,
                  "{\"type\":\"help\",\"event\":\"%s\",\"help_id\":\"%s\","
                  "\"device\":\"%s\",\"mac\":\"%s\",\"seq\":%lu,\"src\":\"s3eye\"",
                  event, s_help_id, APP_DEVICE_ID, s_mac, (unsigned long)s_seq);
    time_t t = time(NULL);
    if (t > 1700000000) {
        struct timeval tv;
        gettimeofday(&tv, NULL);
        struct tm ti;
        gmtime_r(&t, &ti);
        char iso[32];
        strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", &ti);
        n += snprintf(body + n, sizeof(body) - n, ",\"ts\":%llu,\"iso\":\"%s\"",
                      (unsigned long long)t * 1000ULL + (unsigned long long)(tv.tv_usec / 1000), iso);
    }
    n += snprintf(body + n, sizeof(body) - n, "}");

    printf("%s\n", body);                 /* 通道 1：USB 串口 */
    if (wifi_wait(0)) {                   /* 通道 2：WiFi（失败不影响本地反馈） */
        http_post("/api/data", body);
    }
}

/* 按键事件：本地反馈【立即】执行，之后才尝试上报 —— 断开外网也照样确认 */
static void on_button_press(int raw)
{
    if (s_help == HELP_SENT) {
        s_help = HELP_CANCELLED;
        s_scr  = 3;
        ESP_LOGI(TAG, "按键：取消求助 (raw=%d) help_id=%s", raw, s_help_id);
        send_help_event("cancel");
    } else {
        new_help_id(s_help_id, sizeof(s_help_id));
        s_help = HELP_SENT;
        s_scr  = 1;
        ESP_LOGI(TAG, "按键：发起求助 (raw=%d) help_id=%s", raw, s_help_id);
        send_help_event("request");
    }
}

/* ---------------------- 按键扫描（ADC 电阻分压，GPIO1） ---------------------- */
static adc_oneshot_unit_handle_t s_adc = NULL;
static int s_btn_idle = 0;

static void btn_init(void)
{
    adc_oneshot_unit_init_cfg_t u = { .unit_id = ADC_UNIT_1 };
    if (adc_oneshot_new_unit(&u, &s_adc) != ESP_OK) {
        ESP_LOGW(TAG, "ADC 初始化失败，按键不可用");
        s_adc = NULL;
        return;
    }
    adc_oneshot_chan_cfg_t ch = {
        .atten = ADC_ATTEN_DB_12,
        .bitwidth = ADC_BITWIDTH_DEFAULT,
    };
    adc_oneshot_config_channel(s_adc, BTN_ADC_CH, &ch);
}

static void btn_task(void *arg)
{
    (void)arg;
    if (!s_adc) { vTaskDelete(NULL); return; }

    /* 上电校准：此时无人按键，取最大读数作为"空闲"基准（自适应不同板子/批次） */
    int idle = 0;
    for (int i = 0; i < 60; i++) {
        int v = 0;
        if (adc_oneshot_read(s_adc, BTN_ADC_CH, &v) == ESP_OK && v > idle) idle = v;
        vTaskDelay(pdMS_TO_TICKS(10));
    }
    s_btn_idle = idle;
    int th = idle - 500;
    if (th < 300) th = 300;                       /* 兜底：基准异常时仍能触发 */
    ESP_LOGI(TAG, "按键 ADC 校准：空闲=%d，按下判定阈值<%d（按下不同键读数更低）", idle, th);

    bool debounced = false, cand = false;
    int same = 0;
    int64_t last_dbg = 0;
    while (1) {
        int v = 0;
        if (adc_oneshot_read(s_adc, BTN_ADC_CH, &v) != ESP_OK) {
            vTaskDelay(pdMS_TO_TICKS(30));
            continue;
        }
        bool p = (v < th);
        if (p == cand) { if (same < 4) same++; }
        else { cand = p; same = 1; }

        if (same >= 3 && cand != debounced) {
            debounced = cand;
            if (debounced) on_button_press(v);
        }
        /* 每 2 秒打印一次原始读数，便于现场校准阈值 */
        int64_t now = esp_timer_get_time() / 1000;
        if (now - last_dbg > 2000) {
            last_dbg = now;
            ESP_LOGD(TAG, "按键 ADC 原始值=%d（空闲基准 %d）", v, s_btn_idle);
        }
        vTaskDelay(pdMS_TO_TICKS(25));
    }
}

/* ---------------------- UI 任务：按状态刷新 LED 与 LCD ---------------------- */
static void ui_task(void *arg)
{
    (void)arg;
    int last_scr = -1;
    led_mode_t led = LED_OFF;
    int64_t last_toggle = 0;
    bool led_on = false;

    while (1) {
        int cur = s_scr;
        if (cur != last_scr) {
            last_scr = cur;
            switch (cur) {
            case 1:  /* 已发送（本地确认，不依赖网络） */
                lcd_fill(C_RED);
                lcd_show_zh_line("求助已发送", 76, C_WHITE, C_RED);
                lcd_show_zh_line("等待回应", 124, C_WHITE, C_RED);
                lcd_show_ascii_line(APP_DEVICE_ID, 205, C_WHITE, C_RED);
                led = LED_FAST;
                break;
            case 2:  /* 已收到回应（仅当收到 viewer_ack 才进入） */
                lcd_fill(C_GREEN);
                lcd_show_zh_line("对方已收到", 90, C_WHITE, C_GREEN);
                lcd_show_ascii_line(APP_DEVICE_ID, 205, C_WHITE, C_GREEN);
                led = LED_SLOW;
                break;
            case 3:  /* 已取消 */
                lcd_fill(C_GRAY);
                lcd_show_zh_line("已取消", 90, C_WHITE, C_GRAY);
                lcd_show_ascii_line(APP_DEVICE_ID, 205, C_WHITE, C_GRAY);
                led = LED_OFF;
                break;
            default: /* 空闲 */
                lcd_fill(C_BLACK);
                lcd_show_zh_line("空闲", 90, C_WHITE, C_BLACK);
                lcd_show_ascii_line(APP_DEVICE_ID, 205, C_DIM, C_BLACK);
                led = LED_OFF;
                break;
            }
        }

        /* LED：快闪=求助中；慢闪=对方已收到；灭=空闲/已取消 */
        int64_t now = esp_timer_get_time() / 1000;
        int half = led == LED_FAST ? 100 : led == LED_SLOW ? 450 : 0;
        if (half == 0) {
            led_write(false);
            led_on = false;
        } else if (now - last_toggle >= half) {
            last_toggle = now;
            led_on = !led_on;
            led_write(led_on);
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

/* ===================== 主程序 ===================== */

/* ---------------------- 上报帧构建与发送 ---------------------- */

/* 构建一帧 JSON（含真实传感数据）。request_id 非空时写入帧内，
 * 供服务端把这次观测与「远程采集请求」关联起来。返回写入长度。 */
static int build_frame(char *body, size_t cap, const char *request_id)
{
    int n = 0;
    n += snprintf(body + n, cap - n,
                  "{\"device\":\"%s\",\"mac\":\"%s\",\"seq\":%lu,\"src\":\"s3eye\"",
                  APP_DEVICE_ID, s_mac, (unsigned long)s_seq);
    if (request_id && request_id[0]) {
        n += snprintf(body + n, cap - n, ",\"request_id\":\"%s\"", request_id);
    }

    /* 板端时间（NTP，UTC 毫秒） */
    time_t t = time(NULL);
    if (t > 1700000000) {
        struct timeval tv;
        gettimeofday(&tv, NULL);
        struct tm ti;
        gmtime_r(&t, &ti);
        char iso[32];
        strftime(iso, sizeof(iso), "%Y-%m-%dT%H:%M:%SZ", &ti);
        n += snprintf(body + n, cap - n,
                      ",\"ts\":%llu,\"iso\":\"%s\"",
                      (unsigned long long)t * 1000ULL + (unsigned long long)(tv.tv_usec / 1000), iso);
    }

    /* 三轴加速度：raw / g / m·s⁻² 三种形式，便于核对单位 */
    if (s_imu_ok) {
        int16_t raw[3];
        if (imu_read(raw)) {
            const char *axis[3] = { "x", "y", "z" };
            for (int i = 0; i < 3; i++) {
                float g   = (float)raw[i] * QMA_RANGE_G / QMA_FULLSCALE * QMA_CALIBRATION;
                float ms2 = g * G_TO_MS2;
                n += snprintf(body + n, cap - n,
                              ",\"acc_%s_raw\":%d,\"acc_%s_g\":%.4f,\"acc_%s_ms2\":%.3f",
                              axis[i], raw[i], axis[i], g, axis[i], ms2);
            }
        }
    }

    /* 保底真实数据源：芯片内部温度 */
    {
        float tc = temp_sensor_read();
        if (!isnan(tc) && tc > -100.0f) {
            n += snprintf(body + n, cap - n, ",\"temp_c\":%.1f", tc);
        }
    }

    /* IMU 诊断信息（便于确认板载传感器型号/地址，不用于展示） */
    n += snprintf(body + n, cap - n,
                  ",\"imu_ok\":%d,\"imu_id\":%d,\"imu_scan\":\"%s\"",
                  s_imu_ok ? 1 : 0, s_imu_id, s_imu_scan);

    int rssi = 0;
    wifi_ap_record_t ap;
    if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) rssi = ap.rssi;
    n += snprintf(body + n, cap - n,
                  ",\"rssi\":%d,\"heap\":%lu,\"upload_ok\":%lu,\"upload_fail\":%lu}",
                  rssi, (unsigned long)esp_get_free_heap_size(),
                  (unsigned long)s_ok, (unsigned long)s_fail);
    return n;
}

/* WiFi 上传失败退避：
 * 当"连上了 WiFi 但到不了服务器"时（典型场景：访客网/跨网段隔离、服务器没开），
 * 不要每帧都去撞 HTTP —— 既费电，也把串口日志刷爆、拖慢上报循环。
 * 连续失败到阈值后进入退避，改为低频重试；一旦成功立即恢复全速。
 * 注意：USB 串口输出不受影响，仍然每帧照常打印（保底通道）。 */
static uint32_t s_consec_fail = 0;
static int64_t  s_next_try_us  = 0;

#define UPLOAD_FAIL_BACKOFF_AFTER 5       /* 连续失败几次后进入退避 */
#define UPLOAD_BACKOFF_MS         10000   /* 退避期间每 10 秒重试一次 */

/* 构建并双通道发送一帧（USB 串口 + WiFi） */
static void send_frame(const char *request_id)
{
    char body[768];
    int n = build_frame(body, sizeof(body), request_id);
    if (n <= 0 || n >= (int)sizeof(body)) {
        ESP_LOGW(TAG, "组帧溢出(%d)，跳过本帧", n);
        return;
    }
    printf("%s\n", body);                 /* 通道 1：USB 串口（始终输出） */
    if (!wifi_wait(0)) return;            /* 通道 2：WiFi 未连接则跳过 */

    int64_t now = esp_timer_get_time();
    if (now < s_next_try_us) return;      /* 退避中，本帧不尝试 WiFi */

    if (http_upload(body)) {
        s_ok++;
        if (s_consec_fail >= UPLOAD_FAIL_BACKOFF_AFTER) {
            ESP_LOGI(TAG, "WiFi 上传已恢复（此前连续失败 %u 次）", (unsigned)s_consec_fail);
        }
        s_consec_fail = 0;
        s_next_try_us = 0;
        if (s_ok % 10 == 1) ESP_LOGI(TAG, "上传成功 成功=%lu 失败=%lu", (unsigned long)s_ok, (unsigned long)s_fail);
    } else {
        s_fail++;
        s_consec_fail++;
        if (s_consec_fail == UPLOAD_FAIL_BACKOFF_AFTER) {
            s_next_try_us = now + (int64_t)UPLOAD_BACKOFF_MS * 1000;
            ESP_LOGW(TAG, "★ WiFi 上传连续失败 %u 次，进入退避：每 %d 秒重试一次。"
                          "请检查 APP_SERVER_HOST=%s:%d 是否可达、电脑防火墙是否放行。"
                          "（USB 串口输出不受影响）",
                     (unsigned)s_consec_fail, UPLOAD_BACKOFF_MS / 1000,
                     APP_SERVER_HOST, APP_SERVER_PORT);
        } else if (s_consec_fail < UPLOAD_FAIL_BACKOFF_AFTER) {
            ESP_LOGW(TAG, "上传失败 成功=%lu 失败=%lu", (unsigned long)s_ok, (unsigned long)s_fail);
        }
    }
}

/* ---------------------- 远程命令（下行通道） ----------------------
 * 命令由服务端经同一 USB 串口写入，每行一条 JSON：
 *   {"cmd":"collect_once","request_id":"req-..."}  立即采集一次并回传（带 request_id）
 *   {"cmd":"pause"}                                暂停周期上报（命令通道保持）
 *   {"cmd":"resume"}                               恢复周期上报
 *   {"cmd":"ping","request_id":"..."}              连通性探测
 * 板端回执：
 *   {"type":"ack","request_id":"...","seq":N,"status":"received"}
 * 采集观测 = 普通数据帧 + request_id 字段（复用同一条解析链路）。
 * ------------------------------------------------------------------ */
static volatile bool s_report_paused = false;

/* 极简 JSON 取值：找 "key":"value"（仅支持字符串值，够用且无额外依赖） */
static bool json_str(const char *json, const char *key, char *out, size_t cap)
{
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p) return false;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    if (*p != '"') return false;
    p++;
    size_t i = 0;
    while (*p && *p != '"' && i + 1 < cap) out[i++] = *p++;
    out[i] = '\0';
    return true;
}

/* 极简 JSON 取整数："key":123 */
static bool json_int(const char *json, const char *key, int *out)
{
    char pat[64];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char *p = strstr(json, pat);
    if (!p) return false;
    p += strlen(pat);
    while (*p == ' ' || *p == '\t' || *p == ':') p++;
    if (*p != '-' && (*p < '0' || *p > '9')) return false;
    *out = atoi(p);
    return true;
}

static void cmd_ack(const char *request_id, const char *status)
{
    char buf[192];
    snprintf(buf, sizeof(buf),
             "{\"type\":\"ack\",\"device\":\"%s\",\"request_id\":\"%s\",\"seq\":%lu,\"status\":\"%s\"}",
             APP_DEVICE_ID, request_id, (unsigned long)s_seq, status);
    printf("%s\n", buf);
}

/* 立即采集一次：先回执证明收到，再做全新一次采集并回传 */
static void cmd_collect_once(const char *request_id)
{
    cmd_ack(request_id, "received");
    s_seq++;                        /* 新序号 —— 服务端据此确认是「新采集」 */
    send_frame(request_id);
    ESP_LOGI(TAG, "远程采集完成 request_id=%s seq=%lu", request_id, (unsigned long)s_seq);
}

/* ---------------------- 摄像头推流（OV2640） ----------------------
 * 帧格式：一行 JSON，JPEG 用 base64 内联，复用既有上行链路（USB 串口 + WiFi）：
 *   {"type":"frame","device":"...","seq":N,"size":"320x240","len":12345,"jpeg":"<base64>"}
 * 选 base64 而不是二进制协议，是为了不改动现有「一行一条 JSON」的传输层 ——
 * 服务端与网页都能直接复用，代价是 33% 体积开销。
 * ------------------------------------------------------------------ */
static volatile bool s_cam_on  = false;
static int           s_cam_fps = 5;      /* 目标帧率，实际受链路带宽限制 */
static uint32_t      s_cam_seq = 0;
static uint32_t      s_cam_sent = 0, s_cam_drop = 0;

/* 摄像头互斥锁。
 * 推流任务（cam_task）与「抓拍」命令（handle_command → cam_take_snapshot）
 * 会并发访问摄像头，而帧缓冲在 cam_stream.c 里是单份全局状态：
 *   - cam_stream_capture() 开头会先 cam_stream_release()
 *     → 一方抓帧时会把另一方正在使用的帧缓冲提前归还掉
 *   - 两个任务同时调 esp_camera_fb_get() 会打乱驱动内部的帧队列
 * 实测症状：第一次抓拍正常，之后每次抓拍都拿不到新帧
 * （服务端 snapshotAt 不再变化），但推流与 IMU 上报都还正常。
 * 因此所有摄像头访问都必须串行化。 */
static SemaphoreHandle_t s_cam_mtx = NULL;

#define CAM_LOCK()   do { if (s_cam_mtx) xSemaphoreTake(s_cam_mtx, portMAX_DELAY); } while (0)
#define CAM_UNLOCK() do { if (s_cam_mtx) xSemaphoreGive(s_cam_mtx); } while (0)

/* 发送一帧（内部版本）。is_shot=true 表示"手动抓拍"（会在 JSON 里带 shot:1，
 * 服务端据此把它单独存为快照，与直播流区分开）。
 * ★ 调用方必须已持有 s_cam_mtx —— 摄像头访问必须串行化，见其定义处注释。
 * 返回耗时毫秒（0 表示失败） */
static int cam_send_frame_locked(bool is_shot)
{
    if (!s_cam_ok) {
        if (is_shot) ESP_LOGW(TAG, "抓帧失败：摄像头未就绪");
        return 0;
    }

    int64_t t0 = esp_timer_get_time();
    uint8_t *jpg = NULL; size_t jlen = 0;
    if (!cam_stream_capture(&jpg, &jlen) || !jpg || jlen == 0) {
        s_cam_drop++;
        ESP_LOGW(TAG, "抓帧失败（累计 %lu 次）", (unsigned long)s_cam_drop);
        return 0;
    }

    /* base64 输出长度 = 4*ceil(n/3)，再加 JSON 头尾余量 */
    size_t b64_cap = ((jlen + 2) / 3) * 4 + 4;
    size_t cap     = b64_cap + 256;
    /* ★ 优先分配到 PSRAM。VGA(640x480) 帧约 15KB，base64 后缓冲需约 20KB；
     * 实测普通 malloc 在这个量级会失败，且失败是静默的（只表现为"抓拍无回传"）：
     *   QVGA(7.5KB) 3/3 成功、CIF(10.6KB) 3/3 成功、VGA(14.9KB) 1/3、SVGA 0/3。
     * 帧缓冲本身就在 PSRAM（cam_stream_init 里 fb_location=CAMERA_FB_IN_PSRAM），
     * 这里保持一致；PSRAM 分配不到时回退内部 RAM。free() 对两者都适用。 */
    char *out = heap_caps_malloc(cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!out) out = malloc(cap);
    if (!out) {
        cam_stream_release(); s_cam_drop++;
        ESP_LOGE(TAG, "抓帧失败：分配 %u 字节缓冲失败（PSRAM 与内部 RAM 均不足）",
                 (unsigned)cap);
        return 0;
    }

    int hdr = snprintf(out, cap,
        "{\"type\":\"frame\",\"device\":\"%s\",\"seq\":%u,\"size\":\"%s\","
        "\"len\":%u%s,\"jpeg\":\"",
        APP_DEVICE_ID, (unsigned)++s_cam_seq,
        cam_stream_framesize_name(cam_stream_get_framesize()), (unsigned)jlen,
        is_shot ? ",\"shot\":1" : "");
    if (hdr < 0 || (size_t)hdr >= cap) {
        free(out); cam_stream_release(); s_cam_drop++;
        ESP_LOGE(TAG, "抓帧失败：JSON 头 %d 字节超出缓冲 %u", hdr, (unsigned)cap);
        return 0;
    }

    size_t olen = 0;
    int b64err = mbedtls_base64_encode((unsigned char *)out + hdr, b64_cap, &olen, jpg, jlen);
    if (b64err != 0) {
        free(out); cam_stream_release(); s_cam_drop++;
        ESP_LOGE(TAG, "抓帧失败：base64 编码错误 -0x%04x（jlen=%u dlen=%u）",
                 (unsigned)-b64err, (unsigned)jlen, (unsigned)b64_cap);
        return 0;
    }
    cam_stream_release();                       /* 尽早归还帧缓冲 */

    out[hdr + olen]     = '"';
    out[hdr + olen + 1] = '}';
    out[hdr + olen + 2] = '\n';
    out[hdr + olen + 3] = '\0';

    printf("%s", out);                          /* 通道 1：USB 串口 */
    if (wifi_wait(0)) {                         /* 通道 2：WiFi（连上才发） */
        http_post("/api/data", out);
    }
    free(out);

    int ms = (int)((esp_timer_get_time() - t0) / 1000);
    s_cam_sent++;
    if (is_shot || s_cam_sent % 10 == 1) {
        ESP_LOGI(TAG, "摄像头：%s %u 字节 %s，耗时 %d ms",
                 is_shot ? "抓拍一帧" : "推流帧", (unsigned)jlen,
                 cam_stream_framesize_name(cam_stream_get_framesize()), ms);
    }
    return ms;
}

/* 发送一帧（加锁版本，供推流任务使用） */
static int cam_send_frame(bool is_shot)
{
    CAM_LOCK();
    int ms = cam_send_frame_locked(is_shot);
    CAM_UNLOCK();
    return ms;
}

/* 手动抓拍：可临时切到高分辨率/高画质拍一张，拍完恢复推流参数。
 * 用途：直播用低分辨率省带宽，需要看清细节时抓一张高清单张。
 * ★ 整个过程（切换 → 等生效 → 抓帧 → 恢复）独占摄像头：
 *   否则推流任务会在分辨率切换中途抓帧，既可能拍到半帧，
 *   也会因帧缓冲竞争导致后续抓拍彻底失效。 */
static int cam_take_snapshot(int framesize, int quality)
{
    if (!s_cam_ok) { ESP_LOGW(TAG, "抓拍失败：摄像头未就绪"); return 0; }

    CAM_LOCK();
    int prev_fs = cam_stream_get_framesize();
    int prev_q  = cam_stream_get_quality();
    bool changed = false;

    if ((framesize >= 0 && framesize != prev_fs) || (quality >= 0 && quality != prev_q)) {
        cam_stream_set_params(framesize >= 0 ? framesize : prev_fs,
                              quality   >= 0 ? quality   : prev_q);
        changed = true;
        vTaskDelay(pdMS_TO_TICKS(400));   /* 等传感器参数生效，否则拍到的还是旧尺寸 */
    }

    /* ★ 抓拍必须重试：刚切完分辨率时传感器还没稳定，头几帧可能拿不到。
     * 只试一次就放弃的话，板端不会回传任何帧，前端只能干等到 15 秒超时
     * （用户看到的就是"一直显示 等板端回传…"）。失败就丢弃一帧再试，最多 3 次。 */
    int ms = 0;
    for (int attempt = 1; attempt <= 3; attempt++) {
        ms = cam_send_frame_locked(true);
        if (ms > 0) break;
        ESP_LOGW(TAG, "抓拍第 %d 次未成功，丢弃一帧后重试", attempt);
        cam_stream_release();
        vTaskDelay(pdMS_TO_TICKS(150));
    }
    if (ms <= 0) ESP_LOGE(TAG, "抓拍最终失败（已重试 3 次），本次无快照回传");

    if (changed) {
        cam_stream_set_params(prev_fs, prev_q);   /* 恢复推流参数 */
        vTaskDelay(pdMS_TO_TICKS(300));
    }
    CAM_UNLOCK();
    return ms;
}

/* 推流任务：按目标帧率抓帧发送。链路慢时自动降速（以实际耗时为准）。 */
static void cam_task(void *arg)
{
    (void)arg;
    while (1) {
        if (!s_cam_on || !s_cam_ok) { vTaskDelay(pdMS_TO_TICKS(200)); continue; }
        int ms = cam_send_frame(false);
        int period = 1000 / (s_cam_fps > 0 ? s_cam_fps : 1);
        int wait = period - ms;
        vTaskDelay(pdMS_TO_TICKS(wait > 10 ? wait : 10));
    }
}

static void handle_command(const char *line)
{
    char cmd[32] = {0};
    if (!json_str(line, "cmd", cmd, sizeof(cmd))) return;
    char rid[64] = {0};
    json_str(line, "request_id", rid, sizeof(rid));

    if (strcmp(cmd, "collect_once") == 0) {
        cmd_collect_once(rid);
    } else if (strcmp(cmd, "pause") == 0) {
        s_report_paused = true;
        cmd_ack(rid, "paused");
        ESP_LOGI(TAG, "周期上报已暂停（命令通道保持）");
    } else if (strcmp(cmd, "resume") == 0) {
        s_report_paused = false;
        cmd_ack(rid, "resumed");
        ESP_LOGI(TAG, "周期上报已恢复");
    } else if (strcmp(cmd, "ping") == 0) {
        cmd_ack(rid, "pong");
    } else if (strcmp(cmd, "viewer_ack") == 0) {
        /* 查看者已回应 —— 只有收到这条命令，板端才允许显示「对方已收到」 */
        if (s_help == HELP_SENT) {
            s_help = HELP_ACKED;
            s_scr  = 2;
            cmd_ack(rid, "ack_shown");
            ESP_LOGI(TAG, "收到查看者回应：板端显示「对方已收到」");
        } else {
            cmd_ack(rid, "no_active_help");
        }
    } else if (strcmp(cmd, "help_cancel") == 0) {
        s_help = HELP_CANCELLED;
        s_scr  = 3;
        cmd_ack(rid, "cancelled");
        ESP_LOGI(TAG, "收到远端取消：板端显示「已取消」");
    } else if (strcmp(cmd, "help_reset") == 0) {
        s_help = HELP_IDLE;
        s_scr  = 0;
        cmd_ack(rid, "idle");
    } else if (strcmp(cmd, "cam_on") == 0) {
        /* 开始推流 */
        if (!s_cam_ok) { cmd_ack(rid, "no_camera"); }
        else { s_cam_on = true; cmd_ack(rid, "cam_on"); ESP_LOGI(TAG, "摄像头推流已开启"); }
    } else if (strcmp(cmd, "cam_off") == 0) {
        s_cam_on = false;
        cmd_ack(rid, "cam_off");
        ESP_LOGI(TAG, "摄像头推流已停止（累计发送 %lu 帧）", (unsigned long)s_cam_sent);
    } else if (strcmp(cmd, "cam_shot") == 0) {
        /* 抓拍一帧（单张快照）。可带 framesize/quality 临时切到高分辨率，
         * 拍完自动恢复推流参数 —— 直播用低分辨率省带宽，抓拍用高分辨率看细节。 */
        if (!s_cam_ok) { cmd_ack(rid, "no_camera"); }
        else {
            int fs = -1, q = -1;
            json_int(line, "framesize", &fs);
            json_int(line, "quality",   &q);
            cmd_ack(rid, "shot");     /* 语义不变：只表示"命令已收到" */
            int ms = cam_take_snapshot(fs, q);
            /* 抓拍结果单独记一条日志 —— 失败必须可见，不能静默 */
            ESP_LOGI(TAG, "抓拍命令执行完毕：%s（耗时 %d ms）",
                     ms > 0 ? "成功" : "失败", ms);
        }
    } else if (strcmp(cmd, "cam_set") == 0) {
        int fs = -1, q = -1, fps = -1;
        json_int(line, "framesize", &fs);
        json_int(line, "quality",   &q);
        json_int(line, "fps",       &fps);
        if (fps > 0) s_cam_fps = fps > 20 ? 20 : fps;
        bool ok = cam_stream_set_params(fs, q);
        char st[64];
        snprintf(st, sizeof(st), "%s q%d fps%d",
                 cam_stream_framesize_name(cam_stream_get_framesize()),
                 cam_stream_get_quality(), s_cam_fps);
        cmd_ack(rid, ok ? st : "no_camera");
    } else if (strcmp(cmd, "cam_status") == 0) {
        uint32_t f = 0, fl = 0, last = 0;
        cam_stream_get_stats(&f, &fl, &last);
        char st[96];
        snprintf(st, sizeof(st), "ready=%d on=%d %s q%d sent=%lu drop=%lu lastlen=%lu",
                 s_cam_ok ? 1 : 0, s_cam_on ? 1 : 0,
                 cam_stream_framesize_name(cam_stream_get_framesize()),
                 cam_stream_get_quality(), (unsigned long)f, (unsigned long)fl,
                 (unsigned long)last);
        cmd_ack(rid, st);
    } else if (strcmp(cmd, "wifi_status") == 0) {
        /* 现场诊断：一条命令问清 WiFi 当前到底什么状态，不用重烧固件 */
        wifi_ap_record_t ap;
        bool linked = (esp_wifi_sta_get_ap_info(&ap) == ESP_OK);
        bool has_ip = wifi_wait(0);
        char st[96];
        snprintf(st, sizeof(st), "linked=%d ip=%s rssi=%d up=%lu fail=%lu",
                 linked ? 1 : 0, has_ip ? s_ip : "-", linked ? ap.rssi : 0,
                 (unsigned long)s_ok, (unsigned long)s_fail);
        cmd_ack(rid, st);
        if (linked) {
            ESP_LOGI(TAG, "WiFi 状态：已关联 rssi=%d ch=%d；IP=%s；上传 成功=%lu 失败=%lu",
                     ap.rssi, ap.primary, has_ip ? s_ip : "（未取得 IP！）",
                     (unsigned long)s_ok, (unsigned long)s_fail);
            if (!has_ip) {
                ESP_LOGW(TAG, "★ 已关联但无 IP：该 AP 未下发 DHCP 租约（AP/网络侧限制），"
                              "与 SSID/密码无关");
            }
        } else {
            ESP_LOGW(TAG, "WiFi 状态：未关联；IP=%s；上传 成功=%lu 失败=%lu",
                     has_ip ? s_ip : "（无）", (unsigned long)s_ok, (unsigned long)s_fail);
        }
    } else if (strcmp(cmd, "wifi_scan") == 0) {
        /* 现场诊断：重扫一遍 2.4GHz 并打印（会短暂断开再自动重连） */
        cmd_ack(rid, "scanning");
        s_wifi_paused = true;
        esp_wifi_disconnect();
        vTaskDelay(pdMS_TO_TICKS(500));
        wifi_scan_log();
        s_wifi_paused = false;
        esp_wifi_connect();
    } else {
        cmd_ack(rid, "unknown_cmd");
    }
}

/* 命令接收任务：阻塞读串口行（控制台即 USB-Serial-JTAG，与 printf 同一通道） */
static void cmd_task(void *arg)
{
    (void)arg;
    char line[256];
    while (1) {
        if (fgets(line, sizeof(line), stdin) == NULL) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        size_t L = strlen(line);
        while (L && (line[L - 1] == '\n' || line[L - 1] == '\r')) line[--L] = '\0';
        if (L < 3 || line[0] != '{') continue;   /* 忽略空行与日志回显 */
        handle_command(line);
    }
}

/* ---------------------- WiFi 下行：命令轮询（第 3 周补充） ----------------------
 * 板端是纯 HTTP 客户端，服务端无法主动连它。因此由板端定期来取：
 *   GET /api/cmd?device=<APP_DEVICE_ID>  →  有命令则返回该命令，没有则返回 {}
 * 取到后走与串口命令【完全相同】的 handle_command()，回执照旧经上行回传。
 *
 * 为什么不会重复执行：串口在线时服务端只写串口、队列为空，
 * 这里取到的永远是 {}，因此两条通道互不干扰。
 * ------------------------------------------------------------------ */
static void poll_task(void *arg)
{
    (void)arg;
    char path[128];
    snprintf(path, sizeof(path), "/api/cmd?device=%s", APP_DEVICE_ID);

    static char resp[512];
    int fail_streak = 0;
    int64_t last_dbg = 0;
    uint32_t got_cmds = 0;

    while (1) {
        if (!wifi_wait(0)) {                  /* WiFi 没连上就不轮询 */
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        if (http_get(path, resp, sizeof(resp))) {
            if (fail_streak >= 5) {
                ESP_LOGI(TAG, "WiFi 下行已恢复（此前连续失败 %d 次）", fail_streak);
            }
            fail_streak = 0;
            if (strstr(resp, "\"cmd\"")) {    /* 有命令才处理 */
                got_cmds++;
                ESP_LOGI(TAG, "WiFi 取到命令: %s", resp);
                handle_command(resp);
            }
        } else if (++fail_streak == 5) {
            /* 只报一次，避免刷屏；但把排查线索给全 */
            ESP_LOGW(TAG, "WiFi 取命令连续失败 %d 次 —— 检查 APP_SERVER_HOST=%s:%d 是否可达、"
                          "电脑防火墙是否放行该端口", fail_streak, APP_SERVER_HOST, APP_SERVER_PORT);
        }
        int64_t now = esp_timer_get_time() / 1000;
        if (now - last_dbg > 60000) {         /* 每分钟一条心跳，便于确认通道活着 */
            last_dbg = now;
            ESP_LOGD(TAG, "WiFi 下行轮询中：累计取到命令 %lu 条", (unsigned long)got_cmds);
        }
        /* 服务器不可达时降频：没必要每 400ms 撞一次 */
        vTaskDelay(pdMS_TO_TICKS(fail_streak >= 5 ? 5000 : CMD_POLL_INTERVAL_MS));
    }
}

void app_main(void)
{
    /* NVS（WiFi 需要） */
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    vTaskDelay(pdMS_TO_TICKS(1200));   /* 等 USB CDC 枚举 */

    uint8_t mac[6] = {0};
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_mac, sizeof(s_mac), "%02X%02X%02X%02X%02X%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);

    printf("\n=== ESP32-S3-EYE IMU 上报固件 (ESP-IDF) ===\n");
    printf("chip=%s  device=%s  mac=%s\n", "ESP32-S3", APP_DEVICE_ID, s_mac);

    temp_sensor_init();
    s_imu_ok = imu_init();
    if (!s_imu_ok) {
        ESP_LOGW(TAG, "IMU 不可用，将只上报芯片内部温度（仍是真实传感源）");
    }

    /* 摄像头（OV2640）：SCCB 在 GPIO4/5，与 IMU 同一条总线，
     * 因此必须复用 IMU 已建好的 I2C 端口，不能另建一条。 */
    s_cam_mtx = xSemaphoreCreateMutex();   /* 串行化摄像头访问（推流 vs 抓拍） */
    if (s_imu_port >= 0) {
        s_cam_ok = cam_stream_init(s_imu_port);
        if (!s_cam_ok) {
            ESP_LOGW(TAG, "摄像头初始化失败，IMU 上报与按键闭环不受影响");
        }
    } else {
        ESP_LOGW(TAG, "IMU 未初始化 → 摄像头 SCCB 无总线可复用，跳过摄像头");
    }

    /* 第 3 周：本地实体反馈（LED + LCD）与按键 —— 放在联网之前，
     * 保证「断开外网也能本地确认按键已触发」这条硬指标成立。 */
    led_init();
    lcd_init();
    btn_init();
    xTaskCreate(ui_task,  "ui",  4096, NULL, 4, NULL);
    xTaskCreate(btn_task, "btn", 3072, NULL, 4, NULL);

    wifi_init();
    if (wifi_wait(15000)) {
        time_sync();
    } else {
        /* 区分两种失败，排查方向完全不同：
         *   A) 根本没关联上 → SSID/密码/频段（2.4G？）问题
         *   B) 关联成功但没拿到 IP → DHCP 无响应（AP 限制、省电丢包等） */
        wifi_ap_record_t ap;
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
            ESP_LOGW(TAG, "★ 已关联到 \"%s\"（rssi=%d）但未取得 IP —— 属于 DHCP 无响应。"
                          "常见原因：AP 做了 MAC/客户端限制，或省电模式丢包。"
                          "仍会通过 USB 串口输出 JSON。", APP_WIFI_SSID, ap.rssi);
        } else {
            ESP_LOGW(TAG, "WiFi 未连上（请检查 app_config.h 的 SSID/密码，"
                          "并确认该热点在 2.4GHz 广播）。仍会通过 USB 串口输出 JSON。");
        }
    }

    /* 启动远程命令接收任务（下行通道，与上报共用同一 USB 串口） */
    xTaskCreate(cmd_task, "cmd", 4096, NULL, 5, NULL);
    /* 启动 WiFi 命令轮询任务（串口不在线时的下行兜底通道） */
    xTaskCreate(poll_task, "poll", 4096, NULL, 4, NULL);
    /* 启动摄像头推流任务（默认不推流，收到 cam_on 才开始） */
    xTaskCreate(cam_task, "cam", 5120, NULL, 4, NULL);

    int64_t last = 0;
    while (1) {
        vTaskDelay(pdMS_TO_TICKS(10));
        if (s_report_paused) continue;          /* 已被远程命令暂停周期上报 */
        int64_t now_ms = esp_timer_get_time() / 1000;
        if (now_ms - last < REPORT_INTERVAL_MS) continue;
        last = now_ms;
        s_seq++;
        send_frame(NULL);                       /* 周期帧：不带 request_id */
    }
}
